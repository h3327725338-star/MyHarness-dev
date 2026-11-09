/**
 * job_list / job_output / job_kill: query and terminate background shell jobs
 * started by the bash/pwsh tools with `run_in_background: true`.
 *
 * All three tools use the shared BackgroundJobManager store. job_list and
 * job_kill only cover the jobs of the calling session (its Session id, or the
 * tool's creation cwd when that is not reachable). job_output reads any job of
 * this process by its taskId, from a read position of the calling session's own,
 * so a chat started later (a scheduled task) can check a job that another chat
 * started without hiding that output from the other chat.
 */

import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import {
	BACKGROUND_JOB_MAX_LOG_BYTES,
	type BackgroundJobInfo,
	backgroundJobManager,
	JOB_OUTPUT_MAX_BYTES_PER_READ,
	MAX_RETAINED_JOBS,
} from "./job-manager.ts";
import { resolveSessionScope } from "./session-scope.ts";

const jobListSchema = Type.Object({});
const jobOutputSchema = Type.Object({
	taskId: Type.String({ description: "The taskId returned by a run_in_background shell call" }),
});
const jobKillSchema = Type.Object({
	taskId: Type.String({ description: "The taskId of the background job to terminate" }),
});

export type JobListToolInput = Static<typeof jobListSchema>;
export type JobOutputToolInput = Static<typeof jobOutputSchema>;
export type JobKillToolInput = Static<typeof jobKillSchema>;

export interface JobToolDetails {
	jobs?: BackgroundJobInfo[];
	taskId?: string;
	status?: BackgroundJobInfo["status"];
	exitCode?: number | null;
	logPath?: string;
	confirmed?: boolean;
	logTruncated?: boolean;
}

const STATUS_LABELS: Record<BackgroundJobInfo["status"], string> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	killed: "killed",
	timed_out: "timed_out",
};

/** No job has this taskId in this process: a wrong id, or the job is gone or lives elsewhere. */
function unknownJobMessage(taskId: string): string {
	return (
		`Unknown background job: ${taskId}. Use job_list to see this session's jobs. ` +
		`A background job exists only in the MyHarness process that started it, on that computer: it ends and its log is deleted when MyHarness exits, ` +
		`and only the latest ${MAX_RETAINED_JOBS} finished jobs are kept.`
	);
}

function formatJobLine(job: BackgroundJobInfo): string {
	const exit = job.status === "running" ? "" : ` exit=${job.exitCode ?? "null"}`;
	const command = job.command.length > 120 ? `${job.command.slice(0, 117)}...` : job.command;
	return `${job.taskId} [${STATUS_LABELS[job.status]}]${exit} ${job.toolName} cwd=${job.cwd} :: ${command}`;
}

export function createJobListToolDefinition(
	cwd: string,
): BusinessToolDefinition<typeof jobListSchema, JobToolDetails | undefined> {
	return {
		name: "job_list",
		label: "job_list",
		executionMode: "parallel" as const,
		description: `Lists background shell jobs started by the bash/pwsh tools with run_in_background, including taskId, status, exit code and command. Finished jobs stay listed so their status and output remain queryable; use job_output for incremental output and job_kill to terminate a job.`,
		promptSnippet: loadSystemPrompt("tools/job-list/snippet.md"),
		parameters: jobListSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionKey = resolveSessionScope(ctx, cwd);
			const jobs = backgroundJobManager.list(sessionKey);
			const text =
				jobs.length === 0
					? "No background jobs for this session. A job another session started is not listed here; read it with job_output if you have its taskId."
					: jobs.map(formatJobLine).join("\n");
			return { content: [{ type: "text", text }], details: { jobs } };
		},
	};
}

export function createJobOutputToolDefinition(
	cwd: string,
): BusinessToolDefinition<typeof jobOutputSchema, JobToolDetails | undefined> {
	return {
		name: "job_output",
		label: "job_output",
		executionMode: "parallel" as const,
		description: `Returns the shell output a background job produced since this session's previous job_output call for the same taskId (incremental read), plus its current status and exit code once finished. Each call consumes at most ${Math.floor(JOB_OUTPUT_MAX_BYTES_PER_READ / 1024)}KB of new output; call again for more; the full log path is included. It also reads a job that another session started (for example the chat that scheduled this task) when you have its taskId; each session keeps its own read position. A job exists only while MyHarness keeps running on the computer that started it.`,
		promptSnippet: loadSystemPrompt("tools/job-output/snippet.md"),
		parameters: jobOutputSchema,
		async execute(_toolCallId, { taskId }: { taskId: string }, _signal, _onUpdate, ctx) {
			const sessionKey = resolveSessionScope(ctx, cwd);
			const read = await backgroundJobManager.readOutputAs(sessionKey, taskId);
			if (!read) throw new Error(unknownJobMessage(taskId));
			const statusLine =
				read.status === "running"
					? `Status: running`
					: `Status: ${STATUS_LABELS[read.status]} exit=${read.exitCode ?? "null"}`;
			const owner = read.sessionKey === sessionKey ? "" : " (started by another session; read-only here)";
			const parts = [`Job ${taskId}${owner} — ${statusLine}`, read.increment || "(no new output)"];
			if (read.hasMore) parts.push("[More output available; call job_output again for the next chunk.]");
			if (read.logTruncated) {
				parts.push(
					`[Log truncated: output exceeded the maximum log size (${Math.floor(BACKGROUND_JOB_MAX_LOG_BYTES / (1024 * 1024))}MB). Subsequent output was dropped.]`,
				);
			}
			parts.push(`Full log: ${read.logPath}`);
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					taskId,
					status: read.status,
					exitCode: read.exitCode,
					logPath: read.logPath,
					logTruncated: read.logTruncated,
				},
			};
		},
	};
}

export function createJobKillToolDefinition(
	cwd: string,
): BusinessToolDefinition<typeof jobKillSchema, JobToolDetails | undefined> {
	return {
		name: "job_kill",
		label: "job_kill",
		executionMode: "sequential" as const,
		description: `Terminates a running background shell job (killed via the shared process-tree kill and confirmed dead), then reports its final status. Already-finished jobs return their final status unchanged.`,
		promptSnippet: loadSystemPrompt("tools/job-kill/snippet.md"),
		parameters: jobKillSchema,
		async execute(_toolCallId, { taskId }: { taskId: string }, _signal, _onUpdate, ctx) {
			const sessionKey = resolveSessionScope(ctx, cwd);
			const job = backgroundJobManager.get(taskId, sessionKey);
			if (!job) {
				if (backgroundJobManager.get(taskId))
					throw new Error(
						`Background job ${taskId} was started by another session: job_output can read it here, but only that session can stop it (the user can also stop it in that chat's Background panel).`,
					);
				throw new Error(unknownJobMessage(taskId));
			}
			const { confirmed } = await backgroundJobManager.kill(taskId, sessionKey);
			const final = backgroundJobManager.get(taskId, sessionKey);
			if (!final) throw new Error(`Job ${taskId} disappeared before it could be terminated.`);
			const text =
				final.status === "running"
					? `Job ${taskId} could not be confirmed dead within the cancellation deadline.`
					: `Job ${taskId} ${final.status === "killed" ? "killed" : `already finished (${STATUS_LABELS[final.status]})`}.${confirmed ? " Process tree confirmed gone." : ""}`;
			return {
				content: [{ type: "text", text }],
				details: { taskId, status: final.status, exitCode: final.exitCode, confirmed },
			};
		},
	};
}

export function createJobListTool(cwd: string): AgentTool<typeof jobListSchema> {
	return wrapToolDefinition(createJobListToolDefinition(cwd));
}

export function createJobOutputTool(cwd: string): AgentTool<typeof jobOutputSchema> {
	return wrapToolDefinition(createJobOutputToolDefinition(cwd));
}

export function createJobKillTool(cwd: string): AgentTool<typeof jobKillSchema> {
	return wrapToolDefinition(createJobKillToolDefinition(cwd));
}
