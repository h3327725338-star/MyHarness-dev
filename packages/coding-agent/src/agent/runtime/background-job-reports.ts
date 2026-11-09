/**
 * The background shell jobs of one chat report back when they end.
 *
 * A job the bash or pwsh tool started with run_in_background (tools/shell/job-manager.ts) keeps running after the
 * reply that started it. When it ends, the chat gets a message saying how it ended, with the last lines of its output,
 * and a new turn starts on that message, so the agent reads the result and tells the user. This is the shell-job
 * counterpart of a background sub-agent dispatch reporting back (agent/delegation/background-work.ts).
 *
 * Rules:
 * - Every job of the chat reports when it ends, except a job MyHarness stopped itself (job_kill, the Background panel's
 *   stop, shutdown: `stopRequested`) and a job whose end the chat already read with job_output (the final status with
 *   nothing left to read: `endRead`).
 * - A report never goes into a turn that is already running: while a run is active, a message is being sent or the host
 *   is still finishing a run, reports wait (`canStartTurn`), and everything that ended meanwhile goes into the one turn
 *   that follows. Jobs that end within BACKGROUND_JOB_MERGE_WINDOW_MS of each other also share a turn.
 * - When the user stops the task (`holdPending`), the reports waiting at that moment start no turn: they are added to
 *   the chat and reach the model with the user's next message.
 * - There is no limit on how many turns reports start.
 *
 * Jobs live in the process (job-manager.ts), so a report needs this chat's session to be open in the same process when
 * the job ends; nothing is reported for a chat that was closed by then.
 */

import type {
	BackgroundJobInfo,
	BackgroundJobManager,
	BackgroundJobStatus,
	BackgroundJobToolName,
} from "../../tools/shell/job-manager.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { CustomMessage } from "./messages.ts";

/** The custom message type of a report. The Web UI starts a round of its own with it (web/js/turns.js). */
export const BACKGROUND_JOB_REPORT_TYPE = "background-job-complete";
/** Jobs that end within this long of each other report in one turn. */
export const BACKGROUND_JOB_MERGE_WINDOW_MS = 1_000;
/** At most this much of the end of a job's output goes into its report... */
export const BACKGROUND_JOB_REPORT_TAIL_BYTES = 8 * 1024;
/** ...and at most this many lines of it. */
export const BACKGROUND_JOB_REPORT_TAIL_LINES = 50;
/** How often waiting reports look again whether a turn may start, in case no state change pokes them. */
const RECHECK_MS = 2_000;
/** Environment switch used by tests: another merge window, in milliseconds. */
const MERGE_WINDOW_OVERRIDE_ENV = "MYHARNESS_INTERNAL_BACKGROUND_JOB_REPORT_MERGE_MS";

function resolveMergeWindowMs(): number {
	const raw = process.env[MERGE_WINDOW_OVERRIDE_ENV];
	if (!raw) return BACKGROUND_JOB_MERGE_WINDOW_MS;
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value >= 0 ? value : BACKGROUND_JOB_MERGE_WINDOW_MS;
}
/** A very long command (a heredoc) is cut in the report; the whole one is in the job's start message. */
const MAX_REPORT_COMMAND_CHARS = 2_000;

/** One ended job as its report carries it (the field names of the Web UI's job rows, wire.ts `WireBackgroundJob`). */
export interface BackgroundJobReportJob {
	id: string;
	tool: BackgroundJobToolName;
	command: string;
	cwd: string;
	status: Exclude<BackgroundJobStatus, "running">;
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	/** The whole log on disk (deleted when the job leaves the store or MyHarness exits). */
	logPath: string;
	/** The job wrote more than a background job may log; later output was dropped. */
	logTruncated?: boolean;
	/** The last lines of the output, as written (ANSI colours kept). */
	tail: string;
	/** Output before `tail` was left out. */
	tailCut?: boolean;
}

export interface BackgroundJobReportDetails {
	jobs: BackgroundJobReportJob[];
	/** No turn was started for this report (the user had stopped the task): it reaches the model with the next message. */
	held?: boolean;
}

export type BackgroundJobReportMessage = Pick<
	CustomMessage<BackgroundJobReportDetails>,
	"customType" | "content" | "display" | "details"
>;

export interface BackgroundJobReportsHost {
	/** The key the shell tools file this chat's jobs under (`session:<id>`, tools/shell/session-scope.ts). */
	sessionKey(): string;
	/** Whether a turn may start now: no run is active, nothing is being sent, nothing else holds the chat. */
	canStartTurn(): boolean;
	/**
	 * Start a turn on the report (`startTurn`), or only add it to the chat so it goes to the model with the next message.
	 * Called only right after canStartTurn() returned true, in the same synchronous step.
	 */
	deliver(message: BackgroundJobReportMessage, options: { startTurn: boolean }): void;
}

/** What the reports need of the job store. */
export type BackgroundJobSource = Pick<BackgroundJobManager, "subscribe" | "get" | "readTail">;

interface PendingReport {
	job: BackgroundJobInfo;
	/** The user stopped the task while this report waited: it starts no turn. */
	held: boolean;
}

/** "45 s", "2 min 13 s", "1 h 5 min". */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How a job ended, in words for the model. */
function endingOf(job: BackgroundJobReportJob): string {
	const ran = job.endedAt ? ` after ${formatDuration(job.endedAt - job.startedAt)}` : "";
	switch (job.status) {
		case "completed":
			return `finished with exit code 0${ran}`;
		case "failed":
			return job.exitCode !== null
				? `failed with exit code ${job.exitCode}${ran}`
				: `failed${ran} (its output could not be logged)`;
		case "timed_out":
			return `was stopped by the time limit for background jobs${ran}`;
		default:
			return `was killed from outside MyHarness${ran} (no exit code)`;
	}
}

/** The text the model reads. The Web UI draws the report from `details` instead. */
export function backgroundJobReportText(jobs: BackgroundJobReportJob[], held: boolean): string {
	const lead =
		jobs.length === 1
			? "This message is from MyHarness, not from the user: a background command you started has ended."
			: `This message is from MyHarness, not from the user: ${jobs.length} background commands you started have ended.`;
	const parts = [lead];
	for (const job of jobs) {
		const command =
			job.command.length > MAX_REPORT_COMMAND_CHARS
				? `${job.command.slice(0, MAX_REPORT_COMMAND_CHARS)}…`
				: job.command;
		const output = stripAnsi(job.tail).trimEnd();
		const lines = [`${job.id} (${job.tool}, cwd ${job.cwd}) ${endingOf(job)}.`, `Command: ${command}`];
		if (output) {
			lines.push(
				`${job.tailCut ? "The end of its output" : "Its output"} (the whole log: ${job.logPath}):`,
				"```",
				output,
				"```",
			);
		} else lines.push(`It wrote no output. Log: ${job.logPath}`);
		if (job.logTruncated)
			lines.push("It wrote more than a background job may log; the rest of its output was not kept.");
		parts.push(lines.join("\n"));
	}
	parts.push(
		held
			? "The user had stopped the task when this happened, so no turn was started for it. Take it into account when you answer the user's next message."
			: 'Tell the user how it went, and carry on with the user\'s request only if it still needs this result. job_output {"taskId": "…"} reads the output from where you last read it.',
	);
	return parts.join("\n\n");
}

/** The last lines of `text` within the line limit, and whether anything was left out. */
function lastLines(text: string, cut: boolean): { tail: string; cut: boolean } {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = body.split("\n");
	if (lines.length <= BACKGROUND_JOB_REPORT_TAIL_LINES) return { tail: body, cut };
	return { tail: lines.slice(-BACKGROUND_JOB_REPORT_TAIL_LINES).join("\n"), cut: true };
}

export class BackgroundJobReports {
	private readonly _host: BackgroundJobReportsHost;
	private readonly _jobs: BackgroundJobSource;
	private readonly _unsubscribe: () => void;
	/** Ended jobs whose report has not gone out yet, in the order they ended. */
	private readonly _pending = new Map<string, PendingReport>();
	/** No report goes out before this time: the merge window after the latest end. */
	private _notBefore = 0;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _timerAt = 0;
	private _flushing = false;
	private _disposed = false;

	constructor(host: BackgroundJobReportsHost, jobs: BackgroundJobSource) {
		this._host = host;
		this._jobs = jobs;
		this._unsubscribe = jobs.subscribe((job) => this._onJob(job));
	}

	/** Ended jobs whose report still waits. */
	get pendingCount(): number {
		return this._pending.size;
	}

	/** The chat's state changed (a run ended, a message was sent, the host finished a run): look again soon. */
	poke(): void {
		if (this._disposed || this._pending.size === 0) return;
		this._schedule(Math.max(0, this._notBefore - Date.now()));
	}

	/** The user stopped the task: the reports waiting now are added to the chat without starting a turn. */
	holdPending(): void {
		for (const report of this._pending.values()) report.held = true;
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._unsubscribe();
		if (this._timer) clearTimeout(this._timer);
		this._timer = undefined;
		this._pending.clear();
	}

	private _onJob(job: BackgroundJobInfo): void {
		if (this._disposed || job.status === "running" || job.stopRequested || job.endRead) return;
		let key: string;
		try {
			key = this._host.sessionKey();
		} catch {
			return;
		}
		if (job.sessionKey !== key) return;
		this._pending.set(job.taskId, { job, held: false });
		const window = resolveMergeWindowMs();
		this._notBefore = Date.now() + window;
		this._schedule(window);
	}

	/** Look again after `delayMs`, keeping an earlier check that is already planned. */
	private _schedule(delayMs: number): void {
		if (this._disposed) return;
		const at = Date.now() + delayMs;
		if (this._timer && this._timerAt <= at) return;
		if (this._timer) clearTimeout(this._timer);
		this._timerAt = at;
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this._flush();
		}, delayMs);
		this._timer.unref?.();
	}

	private _canStart(): boolean {
		try {
			return this._host.canStartTurn();
		} catch {
			return false;
		}
	}

	/** Forget reports that must not go out any more, and take the newest copy of the others. */
	private _dropSettled(): void {
		for (const [taskId, report] of this._pending) {
			const current = this._jobs.get(taskId, report.job.sessionKey);
			// A record that left the store (more than the store keeps) still reports, from the copy kept here.
			if (!current) continue;
			if (current.stopRequested || current.endRead) this._pending.delete(taskId);
			else report.job = current;
		}
	}

	private async _describe(job: BackgroundJobInfo): Promise<BackgroundJobReportJob> {
		const tail = await this._jobs
			.readTail(job.taskId, BACKGROUND_JOB_REPORT_TAIL_BYTES, job.sessionKey)
			.catch(() => undefined);
		const { tail: text, cut } = lastLines(tail?.text ?? "", (tail?.skipped ?? 0) > 0);
		return {
			id: job.taskId,
			tool: job.toolName,
			command: job.command,
			cwd: job.cwd,
			status: job.status === "running" ? "killed" : job.status,
			exitCode: job.exitCode ?? null,
			startedAt: job.startedAt,
			...(job.endedAt ? { endedAt: job.endedAt } : {}),
			logPath: job.logPath,
			...(job.logTruncated || tail?.logTruncated ? { logTruncated: true } : {}),
			tail: text,
			...(cut ? { tailCut: true } : {}),
		};
	}

	private _message(jobs: BackgroundJobReportJob[], held: boolean): BackgroundJobReportMessage {
		return {
			customType: BACKGROUND_JOB_REPORT_TYPE,
			content: [{ type: "text", text: backgroundJobReportText(jobs, held) }],
			display: true,
			details: held ? { jobs, held: true } : { jobs },
		};
	}

	private async _flush(): Promise<void> {
		if (this._disposed || this._flushing) return;
		this._dropSettled();
		if (this._pending.size === 0) return;
		const wait = this._notBefore - Date.now();
		if (wait > 0) {
			this._schedule(wait);
			return;
		}
		if (!this._canStart()) {
			this._schedule(RECHECK_MS);
			return;
		}
		this._flushing = true;
		try {
			const reports = [...this._pending.values()];
			const jobs = await Promise.all(reports.map((report) => this._describe(report.job)));
			if (this._disposed) return;
			// Reading the logs took a moment: a run may have started meanwhile. Then everything waits for the next chance.
			if (!this._canStart()) {
				this._schedule(RECHECK_MS);
				return;
			}
			for (const report of reports) this._pending.delete(report.job.taskId);
			const held = jobs.filter((_, index) => reports[index].held);
			const fresh = jobs.filter((_, index) => !reports[index].held);
			if (held.length > 0) this._host.deliver(this._message(held, true), { startTurn: false });
			if (fresh.length > 0) this._host.deliver(this._message(fresh, false), { startTurn: true });
		} finally {
			this._flushing = false;
		}
		// Jobs that ended while this report was being written get the next turn.
		this.poke();
	}
}
