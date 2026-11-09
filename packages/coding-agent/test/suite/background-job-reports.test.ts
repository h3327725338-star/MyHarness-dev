import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import type { FauxResponseStep } from "@myharness/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BACKGROUND_JOB_REPORT_TYPE,
	type BackgroundJobReportDetails,
} from "../../src/agent/runtime/background-job-reports.ts";
import type { CustomMessage } from "../../src/agent/runtime/messages.ts";
import { backgroundJobManager } from "../../src/tools/shell/job-manager.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

const MERGE_ENV = "MYHARNESS_INTERNAL_BACKGROUND_JOB_REPORT_MERGE_MS";
const REPORT_LEAD = "a background command you started has ended";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await pause(20);
	}
}

/** A background job of the harness's chat whose process the test plays: it writes output and exits when told to. */
function startFakeJob(harness: Harness, command = "npm test", sessionKey?: string) {
	let finish: (exitCode: number | null) => void = () => {};
	let write: (text: string) => void = () => {};
	const job = backgroundJobManager.start({
		sessionKey: sessionKey ?? `session:${harness.sessionManager.getSessionId()}`,
		toolName: "bash",
		command,
		cwd: harness.tempDir,
		run: ({ onData, signal }) =>
			new Promise((resolve) => {
				write = (text) => onData(Buffer.from(text));
				finish = (exitCode) => resolve({ exitCode });
				signal.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
			}),
	});
	return {
		taskId: job.taskId,
		write: (text: string) => write(text),
		/** End the process with this exit code (null: killed from outside) and wait until its log is complete. */
		end: async (exitCode: number | null) => {
			finish(exitCode);
			await backgroundJobManager.waitUntilSettled(job.taskId);
		},
	};
}

function reports(harness: Harness): CustomMessage<BackgroundJobReportDetails>[] {
	return harness.session.messages.filter(
		(message): message is CustomMessage<BackgroundJobReportDetails> =>
			message.role === "custom" && message.customType === BACKGROUND_JOB_REPORT_TYPE,
	);
}

/** A faux model reply that records what the request carried. */
function recorder() {
	const requests: string[] = [];
	const answer =
		(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
		(context: { messages: unknown[] }) => {
			requests.push(JSON.stringify(context.messages));
			return message;
		};
	return { requests, answer };
}

describe("a chat's background commands report back when they end", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		process.env[MERGE_ENV] = "50";
	});

	afterEach(async () => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		await backgroundJobManager.cancelAll();
		backgroundJobManager.clearRecords();
		delete process.env[MERGE_ENV];
	});

	it("starts a new turn in an idle chat with the command's status and the end of its output", async () => {
		const { requests, answer } = recorder();
		const harness = await createHarness({ responses: [answer(fauxAssistantMessage("测试有 1 个失败"))] });
		harnesses.push(harness);
		const job = startFakeJob(harness);
		job.write("PASS a.test.ts\nFAIL b.test.ts\n");
		await job.end(1);

		await waitUntil(() => getAssistantTexts(harness).length === 1 && harness.session.isIdle);
		expect(requests).toHaveLength(1);
		const [report] = reports(harness);
		expect(report.display).toBe(true);
		const text = getMessageText(report);
		expect(text).toContain("This message is from MyHarness, not from the user");
		expect(text).toContain(REPORT_LEAD);
		expect(text).toContain(`${job.taskId} (bash`);
		expect(text).toContain("failed with exit code 1");
		expect(text).toContain("Command: npm test");
		expect(text).toContain("FAIL b.test.ts");
		expect(report.details?.held).toBeUndefined();
		expect(report.details?.jobs).toMatchObject([
			{
				id: job.taskId,
				tool: "bash",
				command: "npm test",
				status: "failed",
				exitCode: 1,
				tail: "PASS a.test.ts\nFAIL b.test.ts",
			},
		]);
		expect(requests[0]).toContain("FAIL b.test.ts");
		expect(getAssistantTexts(harness)).toEqual(["测试有 1 个失败"]);
	});

	it("waits for the turn that is running instead of going into it, then starts its own", async () => {
		const { requests, answer } = recorder();
		let job: ReturnType<typeof startFakeJob> | undefined;
		const workTool: AgentTool = {
			name: "work",
			label: "Work",
			description: "One step of ordinary work",
			parameters: Type.Object({}),
			execute: async () => {
				// The command ends while the main agent is in the middle of this tool call.
				job?.write("built in 3s\n");
				await job?.end(0);
				await pause(150);
				return { content: [{ type: "text", text: "step done" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [workTool],
			responses: [
				answer(fauxAssistantMessage(fauxToolCall("work", {}))),
				answer(fauxAssistantMessage("这一轮做完了")),
				answer(fauxAssistantMessage("构建成功了")),
			],
		});
		harnesses.push(harness);
		job = startFakeJob(harness, "npm run build");

		await harness.session.prompt("go");
		await waitUntil(() => getAssistantTexts(harness).length === 3 && harness.session.isIdle);

		expect(requests).toHaveLength(3);
		// The run that was going on when the command ended never got the report.
		expect(requests[1]).not.toContain(REPORT_LEAD);
		expect(requests[2]).toContain("finished with exit code 0");
		const order = harness.session.messages.map((message) =>
			message.role === "custom" ? message.customType : message.role,
		);
		expect(order.slice(-3)).toEqual(["assistant", BACKGROUND_JOB_REPORT_TYPE, "assistant"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("构建成功了");
	});

	it("does not report a command whose end the chat already read with job_output", async () => {
		const { requests, answer } = recorder();
		let job: ReturnType<typeof startFakeJob> | undefined;
		let key = "";
		const checkTool: AgentTool = {
			name: "check",
			label: "Check",
			description: "Wait for the job and read it",
			parameters: Type.Object({}),
			execute: async () => {
				job?.write("2 failed\n");
				await job?.end(2);
				// What job_output does (it reads as the calling chat), here for the chat that started the job.
				const read = await backgroundJobManager.readOutputAs(key, job?.taskId ?? "");
				return { content: [{ type: "text", text: `${read?.status}: ${read?.increment}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [checkTool],
			responses: [
				answer(fauxAssistantMessage(fauxToolCall("check", {}))),
				answer(fauxAssistantMessage("读到了：2 个失败")),
				answer(fauxAssistantMessage("这一轮不该出现")),
			],
		});
		harnesses.push(harness);
		key = `session:${harness.sessionManager.getSessionId()}`;
		job = startFakeJob(harness);

		await harness.session.prompt("go");
		await pause(400);

		expect(backgroundJobManager.get(job.taskId)?.endRead).toBe(true);
		expect(reports(harness)).toHaveLength(0);
		expect(requests).toHaveLength(2);
	});

	it("does not report a command MyHarness stopped, but does report one killed from outside", async () => {
		const { requests, answer } = recorder();
		const harness = await createHarness({ responses: [answer(fauxAssistantMessage("它被系统终止了"))] });
		harnesses.push(harness);

		const stopped = startFakeJob(harness, "npm run dev");
		await backgroundJobManager.kill(stopped.taskId);
		await pause(300);
		expect(backgroundJobManager.get(stopped.taskId)).toMatchObject({ status: "killed", stopRequested: true });
		expect(reports(harness)).toHaveLength(0);
		expect(requests).toHaveLength(0);

		const killed = startFakeJob(harness, "node server.js");
		await killed.end(null);
		await waitUntil(() => getAssistantTexts(harness).length === 1 && harness.session.isIdle);
		const [report] = reports(harness);
		expect(report.details?.jobs).toMatchObject([{ id: killed.taskId, status: "killed", exitCode: null }]);
		expect(getMessageText(report)).toContain("was killed from outside MyHarness");
		expect(getMessageText(report)).toContain("It wrote no output.");
	});

	it("puts commands that end together into one turn", async () => {
		const { requests, answer } = recorder();
		const harness = await createHarness({
			responses: [answer(fauxAssistantMessage("两个都结束了")), answer(fauxAssistantMessage("这一轮不该出现"))],
		});
		harnesses.push(harness);
		const lint = startFakeJob(harness, "npm run lint");
		const types = startFakeJob(harness, "npm run typecheck");
		lint.write("clean\n");
		types.write("3 errors\n");
		await Promise.all([lint.end(0), types.end(2)]);

		await waitUntil(() => getAssistantTexts(harness).length === 1 && harness.session.isIdle);
		await pause(200);
		expect(requests).toHaveLength(1);
		const [report] = reports(harness);
		expect(report.details?.jobs.map((item) => item.id).sort()).toEqual([lint.taskId, types.taskId].sort());
		expect(getMessageText(report)).toContain("2 background commands you started have ended");
		expect(getMessageText(report)).toContain("3 errors");
	});

	it("adds a report that waited when the user stopped the task, without starting a turn", async () => {
		const { requests, answer } = recorder();
		let job: ReturnType<typeof startFakeJob> | undefined;
		let toolRunning: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			toolRunning = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Waits until stopped",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				job?.write("1 failed\n");
				await job?.end(1);
				toolRunning();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "stopped" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			responses: [
				answer(fauxAssistantMessage(fauxToolCall("wait", {}))),
				// The stopped run still asks once after the tool returns; that request is cut off at once.
				answer(fauxAssistantMessage("（被停止）")),
				answer(fauxAssistantMessage("回答下一条消息")),
			],
		});
		harnesses.push(harness);
		job = startFakeJob(harness);

		const run = harness.session.prompt("go").catch(() => undefined);
		await running;
		// The merge window passes while the run is still going: the report waits for it.
		await pause(150);
		await harness.session.abort();
		await run;
		await waitUntil(() => reports(harness).length === 1);
		await pause(200);

		const [held] = reports(harness);
		expect(held.details?.held).toBe(true);
		expect(getMessageText(held)).toContain("The user had stopped the task");
		// No turn was started for it: nothing came after it, and no request carried it.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: BACKGROUND_JOB_REPORT_TYPE,
			details: { held: true },
		});
		expect(requests.some((request) => request.includes("The user had stopped the task"))).toBe(false);
		expect(harness.session.isIdle).toBe(true);

		// It reaches the model with the user's next message.
		const before = requests.length;
		await harness.session.prompt("下一条");
		expect(requests).toHaveLength(before + 1);
		expect(requests.at(-1)).toContain("The user had stopped the task");
		expect(requests.at(-1)).toContain("1 failed");
		expect(getAssistantTexts(harness).at(-1)).toBe("回答下一条消息");
	});

	it("waits while the host holds the chat and goes once the host lets it", async () => {
		const { requests, answer } = recorder();
		const harness = await createHarness({ responses: [answer(fauxAssistantMessage("好了"))] });
		harnesses.push(harness);
		let open = false;
		harness.session.setBackgroundJobReportGate(() => open);
		const job = startFakeJob(harness);
		await job.end(0);
		await pause(300);
		expect(requests).toHaveLength(0);
		expect(harness.session.pendingBackgroundJobReports).toBe(1);

		open = true;
		harness.session.pokeBackgroundJobReports();
		await waitUntil(() => getAssistantTexts(harness).length === 1 && harness.session.isIdle);
		expect(requests).toHaveLength(1);
		expect(harness.session.pendingBackgroundJobReports).toBe(0);
	});

	it("does not take the run of a message the user is sending", async () => {
		const { requests, answer } = recorder();
		let releaseInput: () => void = () => {};
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let inputSeen: () => void = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			inputSeen = resolve;
		});
		const harness = await createHarness({
			responses: [answer(fauxAssistantMessage("你好呀")), answer(fauxAssistantMessage("命令结束了"))],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputSeen();
						await inputGate;
					});
				},
			],
		});
		harnesses.push(harness);
		const job = startFakeJob(harness);

		const sending = harness.session.prompt("你好");
		await inputStarted;
		// The command ends and its merge window passes while the message is still being prepared.
		await job.end(0);
		await pause(200);
		expect(requests).toHaveLength(0);
		releaseInput();
		await sending;

		await waitUntil(() => getAssistantTexts(harness).length === 2 && harness.session.isIdle);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toContain("你好");
		expect(requests[0]).not.toContain(REPORT_LEAD);
		expect(requests[1]).toContain("finished with exit code 0");
	});

	it("ignores the jobs of other chats", async () => {
		const { requests, answer } = recorder();
		const harness = await createHarness({ responses: [answer(fauxAssistantMessage("这一轮不该出现"))] });
		harnesses.push(harness);
		const other = startFakeJob(harness, "npm test", "session:someone-else");
		await other.end(0);
		await pause(300);
		expect(requests).toHaveLength(0);
		expect(reports(harness)).toHaveLength(0);
	});
});

describe("background job records for reporting", () => {
	afterEach(async () => {
		await backgroundJobManager.cancelAll();
		backgroundJobManager.clearRecords();
	});

	function start(sessionKey: string) {
		let finish: (exitCode: number) => void = () => {};
		let write: (text: string) => void = () => {};
		const job = backgroundJobManager.start({
			sessionKey,
			toolName: "pwsh",
			command: "Get-Date",
			cwd: process.cwd(),
			run: ({ onData, signal }) =>
				new Promise((resolve) => {
					write = (text) => onData(Buffer.from(text));
					finish = (exitCode) => resolve({ exitCode });
					signal.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
				}),
		});
		return { id: job.taskId, write: (text: string) => write(text), finish: (code: number) => finish(code) };
	}

	it("marks a stop MyHarness made, and nothing else", async () => {
		const ended = start("session:a");
		ended.finish(0);
		expect(await backgroundJobManager.waitUntilSettled(ended.id)).toMatchObject({ status: "completed" });
		expect(backgroundJobManager.get(ended.id)?.stopRequested).toBeUndefined();

		const stopped = start("session:a");
		await backgroundJobManager.kill(stopped.id, "session:a");
		expect(backgroundJobManager.get(stopped.id)).toMatchObject({ status: "killed", stopRequested: true });
	});

	it("marks the end as read only for the owner, once it has ended and nothing is left to read", async () => {
		const job = start("session:owner");
		job.write("a\n");
		await pause(50);
		// Read while it runs: not the end.
		await backgroundJobManager.readOutput(job.id, undefined, "session:owner");
		expect(backgroundJobManager.get(job.id)?.endRead).toBeUndefined();

		job.write("bc\n");
		job.finish(0);
		await backgroundJobManager.waitUntilSettled(job.id);
		// Another chat reading it (a scheduled task) does not count for the owner.
		await backgroundJobManager.readOutputAs("session:other", job.id);
		expect(backgroundJobManager.get(job.id)?.endRead).toBeUndefined();
		// The owner read part of what is left: more remains.
		const part = await backgroundJobManager.readOutput(job.id, 1, "session:owner");
		expect(part?.hasMore).toBe(true);
		expect(backgroundJobManager.get(job.id)?.endRead).toBeUndefined();
		// job_output's way in (readOutputAs with the caller's key) counts the same when the caller is the owner.
		const rest = await backgroundJobManager.readOutputAs("session:owner", job.id);
		expect(rest?.hasMore).toBe(false);
		expect(backgroundJobManager.get(job.id)?.endRead).toBe(true);
	});
});
