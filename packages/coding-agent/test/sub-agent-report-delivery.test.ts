import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeTrace, RuntimeTraceScope } from "../src/observability/runtime-trace.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import {
	collectFinalReasoning,
	createSubAgentTool,
	createSubAgentToolDefinition,
	evaluateSubmittedReport,
	findSubmittedReport,
	getFinalAssistantText,
	pickReportCandidate,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	type SubAgentToolDetails,
	truncateHeadKeepingContent,
	truncateSubAgentOutput,
} from "../src/tools/sub-agent.ts";
import { FULL_TEXT_OUTPUT, wrapToolWithResultPersistence } from "../src/tools/tool-result-persistence.ts";

/**
 * Every case here pins one path through which an Explore report could reach the Main Agent empty, blank or replaced
 * by a remark: P1 trailing text-free turn, P2 trailing acknowledgement / sign-off, P3 first line over the cap,
 * P4 stream that breaks before `agent_end`, P5 truncated preview without a pointer to the full text, P6 no report
 * body at all. C1-C3 pin the advertised task cap against the runtime cap.
 */

const REMARK = "先查一下 broadcast 的调用点。";
const REPORT_BODY =
	"调查报告：结论如下，逐条给出证据与文件路径，包含行号、已覆盖范围、冲突事项与未解决事项，并附建议后续补查项。";
/** A real report shape: body plus the `## Completion checklist` tail the Explore prompt demands. */
const CHECKLIST_REPORT = `# 调查报告\n${"这是一段很长的中文调查结论，含文件路径与行号。".repeat(12)}\n## Completion checklist\n- answered: 1\n- unanswered: none`;
/** One Chinese sentence without a single line break: 14.4KB, over the 6KB display cap, under the 20KB task cap. */
const SINGLE_LINE_REPORT = "无换行的超长中文正文段落，逐字给出证据。".repeat(200);
/** Enough lines to pass the display caps so the Main Agent is handed a preview, not the whole report. */
const LONG_TAIL = Array.from({ length: 3_000 }, (_value, index) => `第 ${index} 行结论证据。`).join("\n");
const LONG_MULTILINE_REPORT = `${REPORT_BODY}\n${LONG_TAIL}`;
/** First line over the 6KB per-task display cap *and* long enough to need the batch preview: the two caps stacked. */
const OVERCAP_FIRST_LINE_REPORT = `${SINGLE_LINE_REPORT}\n${LONG_TAIL}`;

const remarkWithToolCall = assistant(1, [
	{ type: "text", text: REMARK },
	{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
]);
const toolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 2,
} as unknown as Message;
const checklistReportMessage = assistant(3, [{ type: "text", text: CHECKLIST_REPORT }]);

function assistant(timestamp: number, content: unknown[]): Message {
	return { role: "assistant", content, timestamp } as unknown as Message;
}

/** A thinking-only turn: no text part at all, which is what a convergence reminder can leave behind. */
function thinkingOnlyTurn(timestamp: number): string {
	return `{ role: "assistant", timestamp: ${timestamp}, content: [{ type: "thinking", thinking: "报告已经输出过了。" }] }`;
}

/** An acknowledgement turn: text is present but says nothing but "ok, got it". */
function acknowledgementTurn(timestamp: number, text = "好的，收到。"): string {
	return `{ role: "assistant", timestamp: ${timestamp}, content: [{ type: "text", text: ${JSON.stringify(text)} }] }`;
}

/** NDJSON source of a fake delegated worker: one tool call plus the given final assistant turns. */
function workerSource(reportText: string, trailingTurns: string, withAgentEnd = true): string {
	const lines = [
		`const remark = ${JSON.stringify(remarkWithToolCall)};`,
		`const toolResult = ${JSON.stringify(toolResultMessage)};`,
		`const report = { role: "assistant", timestamp: 3, content: [{ type: "text", text: ${JSON.stringify(reportText)} }] };`,
		`const trailing = [${trailingTurns}];`,
		`const line = (event) => JSON.stringify(event) + "\\n";`,
		`process.stdout.write(line({ type: "message_end", message: remark }));`,
		`process.stdout.write(line({ type: "tool_result_end", message: toolResult }));`,
		`process.stdout.write(line({ type: "message_end", message: report }));`,
		"for (const message of trailing) process.stdout.write(line({ type: 'message_end', message }));",
	];
	if (withAgentEnd) {
		lines.push(
			`process.stdout.write(line({ type: "agent_end", messages: [remark, toolResult, report, ...trailing] }));`,
		);
	}
	return lines.join("\n");
}

/**
 * NDJSON source of a fake delegated worker whose last act is an accepted `submit_report` round trip: an investigation
 * remark with a read call, optionally a truncated head reply, then the reply that hands the report in (with optional
 * reply text) and its accepted tool result. An optional exit code lets the process die after the hand-in (V3).
 */
function submitReportWorkerSource(options: {
	tailText?: string;
	report?: string;
	headText?: string;
	questions?: Array<{ question: string; status: string }>;
	exitCode?: number;
}): string {
	const remark = remarkWithToolCall;
	const readResult = toolResultMessage;
	const head =
		options.headText === undefined
			? undefined
			: {
					role: "assistant",
					timestamp: 3,
					content: [{ type: "text", text: options.headText }],
					stopReason: "length",
				};
	const tailTimestamp = head ? 4 : 3;
	const tail = {
		role: "assistant",
		timestamp: tailTimestamp,
		content: [
			...(options.tailText ? [{ type: "text", text: options.tailText }] : []),
			{
				type: "toolCall",
				id: "submit-1",
				name: "submit_report",
				arguments: { report: options.report ?? "", questions: options.questions ?? [] },
			},
		],
		stopReason: "stop",
	};
	const submitResult = {
		role: "toolResult",
		toolCallId: "submit-1",
		toolName: "submit_report",
		content: [{ type: "text", text: "Report received." }],
		isError: false,
		timestamp: tailTimestamp + 1,
	};
	const messages = [remark, readResult, ...(head ? [head] : []), tail, submitResult];
	const events = [
		{ type: "message_end", message: remark },
		{ type: "tool_result_end", message: readResult },
		...(head ? [{ type: "message_end", message: head }] : []),
		{ type: "message_end", message: tail },
		{ type: "tool_result_end", message: submitResult },
		{ type: "agent_end", messages },
	];
	return [
		...events.map((event) => `process.stdout.write(JSON.stringify(${JSON.stringify(event)}) + "\\n");`),
		...(options.exitCode ? [`process.exitCode = ${options.exitCode};`] : []),
	].join("\n");
}

const directories: string[] = [];
let previousEntry: string | undefined;

async function useWorker(name: string, source: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `myharness-report-delivery-${name}-`));
	directories.push(directory);
	const entryPath = join(directory, "worker.mjs");
	await writeFile(entryPath, source, "utf8");
	process.env.MYHARNESS_CLI_ENTRY = entryPath;
	return directory;
}

function batchSettings() {
	return resolveSubAgentRuntimeSettings({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" });
}

/** Run one Explore task against the fake worker and hand back the batch plus its single task result. */
async function runOneTask(
	name: string,
	source: string,
	task: { description?: string; prompt?: string; questions?: string[] } = {},
	batch: {
		trace?: RuntimeTrace;
		parentTraceScope?: RuntimeTraceScope;
		onProgress?: (details: SubAgentToolDetails) => void;
	} = {},
) {
	const directory = await useWorker(name, source);
	const result = await runExploreBatch({
		cwd: directory,
		tasks: [
			{
				description: task.description ?? name,
				prompt: task.prompt ?? "Investigate.",
				questions: task.questions,
			},
		],
		settings: batchSettings(),
		...(batch.trace ? { trace: batch.trace, parentTraceScope: batch.parentTraceScope } : {}),
		...(batch.onProgress ? { onProgress: batch.onProgress } : {}),
	});
	return { directory, result, taskResult: result.details.results[0] };
}

/** The tool, dispatching in `cwd`: the fake worker's own temporary folder, never the repository under test. */
function enabledTool(cwd: string) {
	return createSubAgentTool(cwd, {
		getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off" }),
	});
}

const oneTaskArgs = { tasks: [{ description: "Preview", prompt: "Investigate." }] };

beforeEach(() => {
	previousEntry = process.env.MYHARNESS_CLI_ENTRY;
});

afterEach(async () => {
	if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
	else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

describe("P1: a trailing tool-call-free turn without text must not erase the report", () => {
	it("getFinalAssistantText skips a thinking-only final turn and keeps the real report", () => {
		expect(
			getFinalAssistantText([remarkWithToolCall, toolResultMessage, checklistReportMessage, assistant(4, [])]),
		).toBe(CHECKLIST_REPORT);
		expect(
			getFinalAssistantText([
				remarkWithToolCall,
				toolResultMessage,
				checklistReportMessage,
				assistant(4, [{ type: "thinking", thinking: "已经输出过报告" }]),
			]),
		).toBe(CHECKLIST_REPORT);
	});

	it("delivers the report when the worker ends with an empty assistant turn", async () => {
		const { taskResult, result } = await runOneTask("P1 e2e", workerSource(REPORT_BODY, thinkingOnlyTurn(4)));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(result.text).toContain("报告：");
	}, 30_000);
});

describe("P2: a confirmation or sign-off after the report must not replace the report", () => {
	it("pickReportCandidate keeps the earlier report when the last turn only acknowledges the reminder", () => {
		expect(pickReportCandidate([CHECKLIST_REPORT, "好的，收到。"])).toBe(CHECKLIST_REPORT);
		expect(pickReportCandidate(["调查完毕，证据如下，未解决项已列出，建议后续补查一次。", "OK"])).toBe(
			"调查完毕，证据如下，未解决项已列出，建议后续补查一次。",
		);
	});

	it("pickReportCandidate never blanks the report and keeps a lone acknowledgement", () => {
		expect(pickReportCandidate([])).toBe("");
		expect(pickReportCandidate(["好的，收到。"])).toBe("好的，收到。");
		// A trailing turn that itself looks like the report still wins: selection never invents an older answer.
		expect(pickReportCandidate([CHECKLIST_REPORT, `${REPORT_BODY}（修订版）`])).toBe(`${REPORT_BODY}（修订版）`);
	});

	it("getFinalAssistantText handles multiple assistant turns in chronological order", () => {
		const earlyRemark = assistant(1, [{ type: "text", text: "好的，我开始检查。" }]);
		const olderReport = assistant(2, [{ type: "text", text: `${CHECKLIST_REPORT}\n- 第一版` }]);
		const revisedReport = assistant(3, [{ type: "text", text: `${CHECKLIST_REPORT}\n- 第二版` }]);
		const ack = assistant(4, [{ type: "text", text: "好的，收到。" }]);

		// ACK at the end does not replace the newest revised report
		expect(getFinalAssistantText([earlyRemark, olderReport, revisedReport, ack])).toBe(
			`${CHECKLIST_REPORT}\n- 第二版`,
		);

		// Without ACK, the newest revised report wins over the older report
		expect(getFinalAssistantText([earlyRemark, olderReport, revisedReport])).toBe(`${CHECKLIST_REPORT}\n- 第二版`);
	});

	it("hands the main Agent the report when the worker closes with 好的，收到", async () => {
		const { taskResult } = await runOneTask("P2 e2e", workerSource(REPORT_BODY, acknowledgementTurn(4)));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(taskResult.output).not.toBe("好的，收到。");
	}, 30_000);

	it("does not downgrade a Questions task to partial just because the final turn dropped the checklist", async () => {
		// Reading the acknowledgement as the report used to look like an incomplete answer and hide the body.
		const { taskResult } = await runOneTask("P2 checklist", workerSource(CHECKLIST_REPORT, acknowledgementTurn(4)), {
			description: "P2 checklist",
			questions: ["守卫是否允许管道？"],
		});
		expect(taskResult.status).toBe("completed");
		expect(taskResult.stopReason).toBe("completed");
		expect(taskResult.output).toBe(CHECKLIST_REPORT);
	}, 30_000);

	it("keeps the checklist verdict when the report above the sign-off has no checklist", async () => {
		// Choosing the report must not weaken the completeness check: a report that was neither handed in with
		// submit_report nor carries a checklist is still partial, recorded as not handed in properly.
		const { taskResult } = await runOneTask(
			"P2 missing checklist",
			workerSource(REPORT_BODY, acknowledgementTurn(4)),
			{
				questions: ["守卫是否允许管道？"],
			},
		);
		expect(taskResult.status).toBe("partial");
		expect(taskResult.stopReason).toBe("report_not_submitted");
		expect(taskResult.reportSubmission).toBe("text");
		expect(taskResult.output).toContain("Completion checklist");
		expect(taskResult.output).toContain(REPORT_BODY);
	}, 30_000);
});

describe("P3: a report whose first line is over the display cap must not be blanked out", () => {
	it("truncateHeadKeepingContent keeps a byte-safe head plus a marker when the first line exceeds maxBytes", () => {
		const capped = truncateHeadKeepingContent(SINGLE_LINE_REPORT, { maxBytes: 6 * 1024, maxLines: 160 });
		expect(capped).not.toBe("");
		expect(capped).toContain("已按字节截断");
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(6 * 1024);
		expect(capped).not.toContain("\uFFFD");
		// Byte safe, and still a prefix of the original report.
		expect(SINGLE_LINE_REPORT.startsWith(capped.slice(0, 300))).toBe(true);
	});

	it("keeps the per-task cap while never blanking a single-line CJK report", () => {
		const capped = truncateSubAgentOutput("超长中文正文段落，逐字给出证据。".repeat(3_000));
		expect(capped).not.toBe("");
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(20 * 1024);
		expect(capped).not.toContain("\uFFFD");
		// A pure-ASCII overlong line takes the same byte-safe head + marker path, still inside the cap.
		const asciiCapped = truncateSubAgentOutput("x".repeat(30 * 1024));
		expect(asciiCapped).not.toBe("");
		expect(Buffer.byteLength(asciiCapped, "utf8")).toBeLessThanOrEqual(20 * 1024);
		expect("x".repeat(30 * 1024).startsWith(asciiCapped.slice(0, 1_000))).toBe(true);
	});

	it("passes a single huge line report to the main Agent instead of dropping the report section", async () => {
		const { taskResult, result } = await runOneTask("P3 e2e", workerSource(SINGLE_LINE_REPORT, ""));
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(SINGLE_LINE_REPORT);
		// The 6KB per-task display cap used to make truncateHead return "" and delete the whole body silently.
		expect(result.text).toContain("报告：");
		expect(result.text).toContain("已按字节截断");
		expect(result.text).toContain(SINGLE_LINE_REPORT.slice(0, 30));
		expect(result.fullText).toContain(SINGLE_LINE_REPORT);
	}, 30_000);
});

describe("P4: a stream that breaks before agent_end must still deliver the report", () => {
	it("collects the report from scattered message_end events with no agent_end snapshot", async () => {
		const { taskResult, result } = await runOneTask(
			"P4 no agent_end",
			workerSource(REPORT_BODY, thinkingOnlyTurn(4), false),
		);
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(result.text).toContain("报告：");
	}, 30_000);

	it("names the diagnosis when a broken stream carries no report text at all", async () => {
		const { taskResult, result } = await runOneTask("P4 empty stream", workerSource("", thinkingOnlyTurn(4), false));
		expect(taskResult.status).toBe("failed");
		expect(taskResult.output.trim()).not.toBe("");
		expect(result.text).toContain("没有写出报告正文");
		// The reasoning the model produced instead of a report is attached.
		expect(result.text).toContain("报告已经输出过了。");
	}, 30_000);
});

describe("P5: a truncated preview must name the file that holds the full report", () => {
	it("attaches the original full text whenever the main Agent only sees a preview", async () => {
		const workerDirectory = await useWorker("P5 symbol", workerSource(LONG_MULTILINE_REPORT, ""));
		const tool = enabledTool(workerDirectory);
		const raw = (await tool.execute("call-preview", oneTaskArgs, undefined, undefined)) as unknown as Record<
			string | symbol,
			unknown
		>;
		const content = raw.content as Array<{ type: string; text?: string }>;
		const preview = content.find((part) => part.type === "text")?.text ?? "";
		expect(preview.trim()).not.toBe("");
		expect(preview).toContain("报告：");
		const fullText = raw[FULL_TEXT_OUTPUT];
		expect(typeof fullText).toBe("string");
		expect(Buffer.byteLength(String(fullText), "utf8")).toBeGreaterThan(Buffer.byteLength(preview, "utf8"));
		expect(String(fullText)).toContain("第 2999 行结论证据。");
		expect(String(fullText)).toContain(LONG_MULTILINE_REPORT.slice(-24));
	}, 30_000);

	it("still points at the saved file when the preview itself is a byte-truncated first line", async () => {
		const workerDirectory = await useWorker("P5 overcap sidecar", workerSource(OVERCAP_FIRST_LINE_REPORT, ""));
		const sessionRoot = await mkdtemp(join(tmpdir(), "myharness-report-delivery-overcap-"));
		directories.push(sessionRoot);
		const sessionsDir = join(sessionRoot, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionManager = SessionManager.create(workerDirectory, sessionsDir);
		const result = await wrapToolWithResultPersistence(enabledTool(workerDirectory), sessionManager).execute(
			"call-overcap",
			oneTaskArgs,
			undefined,
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text");
		const text = visible?.type === "text" ? visible.text : "";
		expect(text.trim()).not.toBe("");
		expect(text).toContain("报告：");
		expect(text).toContain("已按字节截断");
		expect(text).toContain("[完整输出已保存：");
		const persisted = await readFile((result.details as { fullOutputPath?: string }).fullOutputPath ?? "", "utf8");
		expect(persisted).toContain(OVERCAP_FIRST_LINE_REPORT);
	}, 60_000);

	it("gives the main Agent a saved-file pointer instead of a bare preview", async () => {
		const workerDirectory = await useWorker("P5 sidecar", workerSource(LONG_MULTILINE_REPORT, ""));
		const sessionRoot = await mkdtemp(join(tmpdir(), "myharness-report-delivery-session-"));
		directories.push(sessionRoot);
		const sessionsDir = join(sessionRoot, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionManager = SessionManager.create(workerDirectory, sessionsDir);
		const result = await wrapToolWithResultPersistence(enabledTool(workerDirectory), sessionManager).execute(
			"call-sidecar",
			oneTaskArgs,
			undefined,
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text");
		const text = visible?.type === "text" ? visible.text : "";
		expect(text.trim()).not.toBe("");
		expect(text).toContain("报告：");
		expect(text).toContain("[完整输出已保存：");
		const fullPath = (result.details as { fullOutputPath?: string }).fullOutputPath;
		expect(typeof fullPath).toBe("string");
		expect(existsSync(fullPath ?? "")).toBe(true);
		const persisted = await readFile(fullPath ?? "", "utf8");
		expect(persisted).toContain("第 2999 行结论证据。");
		expect(persisted.length).toBeGreaterThan(text.length);
	}, 60_000);
});

describe("P6: no report body must come back as an explicit diagnosis, never blank", () => {
	it("reports why a normally finished child produced no report body and keeps the tool evidence", async () => {
		// No report text at all is a failure (the user's rule), never a silent partial; the reason and the model's own
		// reasoning come back instead of a blank.
		const { taskResult, result } = await runOneTask("P6 no body", workerSource("", thinkingOnlyTurn(4)));
		expect(taskResult.status).toBe("failed");
		expect(taskResult.stopReason).toBe("no_report");
		expect(taskResult.output.trim()).not.toBe("");
		expect(taskResult.error).toContain("没有写出报告正文");
		expect(result.text).toContain("没有写出报告正文");
		expect(result.text).toContain("报告已经输出过了。");
		expect(result.text.trim()).not.toBe("");
		expect(taskResult.evidence).toContain("Read(a.txt)：已读取 1 行");
	}, 30_000);

	it("never marks a task completed while its report body is empty", async () => {
		const { taskResult } = await runOneTask("P6 not blank", workerSource(REPORT_BODY, acknowledgementTurn(4)));
		// Either the real body arrives, or the status is not "completed": completed-with-empty-body is the bug.
		expect(taskResult.status === "completed" ? taskResult.output.trim() !== "" : true).toBe(true);
		expect(taskResult.output).toBe(REPORT_BODY);
	}, 30_000);
});

describe("V2: same-count submissions line up by question key, not blindly by position", () => {
	it("aligns by normalized key when the worker listed the questions in another order", () => {
		const verdict = evaluateSubmittedReport(
			["Q1 守卫在哪？", "Q2 测试在哪？"],
			[
				{ question: "q2 测试在哪？", status: "unavailable", note: "登录墙挡住了" },
				{ question: "q1 守卫在哪？", status: "answered" },
			],
		);
		expect(verdict.statuses.map((entry) => entry.question)).toEqual(["Q1 守卫在哪？", "Q2 测试在哪？"]);
		expect(verdict.statuses[0]).toMatchObject({ status: "answered" });
		expect(verdict.statuses[1]).toMatchObject({ status: "unavailable", note: "登录墙挡住了" });
		expect(verdict.outcome).toBe("data_gaps");
		expect(verdict.dataGaps).toEqual(["Q2 测试在哪？：登录墙挡住了"]);
	});

	it("keeps the positional alignment when the keys do not match the task questions", () => {
		const verdict = evaluateSubmittedReport(
			["守卫在哪？", "测试在哪？"],
			[
				{ question: "第一项的意思？", status: "answered" },
				{ question: "第二项的意思？", status: "answered" },
			],
		);
		expect(verdict.statuses.map((entry) => [entry.question, entry.status])).toEqual([
			["守卫在哪？", "answered"],
			["测试在哪？", "answered"],
		]);
	});

	it("keeps the positional alignment when two entries collapse to the same key", () => {
		const verdict = evaluateSubmittedReport(
			["A", "B"],
			[
				{ question: "a", status: "partial", note: "x" },
				{ question: "A", status: "answered" },
			],
		);
		expect(verdict.statuses.map((entry) => [entry.question, entry.status])).toEqual([
			["A", "partial"],
			["B", "answered"],
		]);
	});
});

describe("V2b: required questions that share a key", () => {
	it("keeps the positional alignment when two required questions normalize to the same key", () => {
		const verdict = evaluateSubmittedReport(
			["Is X covered?", "Is  X  covered!"],
			[
				{ question: "Is X covered?", status: "answered" },
				{ question: "Something else", status: "not_done", note: "no time" },
			],
		);
		expect(verdict.statuses.map((entry) => entry.status)).toEqual(["answered", "not_done"]);
		expect(verdict.outcome).toBe("incomplete");
	});
});

describe("V5b: every cut-off piece of the report travels with an empty hand-in", () => {
	const assistant = (text: string, stopReason: string, toolCall?: Record<string, unknown>) =>
		({
			role: "assistant",
			content: [...(text ? [{ type: "text", text }] : []), ...(toolCall ? [toolCall] : [])],
			stopReason,
		}) as unknown as Message;
	const user = (text: string) => ({ role: "user", content: text }) as unknown as Message;
	const submit = { type: "toolCall", id: "s1", name: "submit_report", arguments: { report: "" } };
	const accepted = {
		role: "toolResult",
		toolName: "submit_report",
		toolCallId: "s1",
		isError: false,
		content: [{ type: "text", text: "Report received." }],
	} as unknown as Message;

	it("keeps both pieces of a report cut twice", () => {
		const found = findSubmittedReport([
			user("task"),
			assistant("done with the checks", "stop"),
			assistant("HEAD X", "length"),
			user("continue"),
			assistant("MIDDLE Y", "length"),
			user("write the final report"),
			assistant("TAIL Z", "toolUse", submit),
			accepted,
		]);
		expect(found?.continuedText).toBe("HEAD X\nMIDDLE Y");
		expect(found?.messageText).toBe("TAIL Z");
	});

	it("keeps the head when a tool call came between the cut and the hand-in", () => {
		const found = findSubmittedReport([
			user("task"),
			assistant("HEAD X", "length"),
			user("continue"),
			assistant("", "toolUse", { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }),
			{ role: "toolResult", toolName: "read", toolCallId: "r1", isError: false, content: [] } as unknown as Message,
			assistant("TAIL Z", "toolUse", submit),
			accepted,
		]);
		expect(found?.continuedText).toBe("HEAD X");
	});

	it("carries no earlier text when nothing was cut off", () => {
		const found = findSubmittedReport([
			user("task"),
			assistant("an earlier complete reply", "stop"),
			assistant("THE REPORT", "toolUse", submit),
			accepted,
		]);
		expect(found?.continuedText).toBeUndefined();
	});
});

describe("V5: after continue_truncated the handed-in report is the merged head and tail", () => {
	it("hands the Main Agent the merged head and tail instead of only the tail", async () => {
		const head = "# 调查报告\n第一段结论与证据路径。\n第二段展开说明，写到一半被输出上限截断";
		const tail = "，这里接着写完。\n第三段结论与建议后续补查。";
		const { taskResult } = await runOneTask(
			"V5 merged",
			submitReportWorkerSource({
				headText: head,
				tailText: tail,
				questions: [{ question: "问题一", status: "answered" }],
			}),
			{ questions: ["问题一"] },
		);
		expect(taskResult.status).toBe("completed");
		expect(taskResult.stopReason).toBe("completed");
		expect(taskResult.reportSubmission).toBe("tool");
		expect(taskResult.output).toBe(`${head}\n${tail}`);
	}, 30_000);

	it("keeps the plain hand-in behavior when the reply was not a continuation", async () => {
		const { taskResult } = await runOneTask(
			"V5 plain",
			submitReportWorkerSource({
				tailText: "",
				report: REPORT_BODY,
				questions: [{ question: "问题一", status: "answered" }],
			}),
			{ questions: ["问题一"] },
		);
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
	}, 30_000);
});

describe("V3: a nonzero worker exit after an accepted report keeps the report's verdict", () => {
	it("completes the task from the accepted report and keeps the exit as a note", async () => {
		const { taskResult } = await runOneTask(
			"V3 exit after report",
			submitReportWorkerSource({
				report: REPORT_BODY,
				questions: [{ question: "问题一", status: "answered" }],
				exitCode: 3,
			}),
			{ questions: ["问题一"] },
		);
		expect(taskResult.status).toBe("completed");
		expect(taskResult.stopReason).toBe("completed");
		expect(taskResult.reportSubmission).toBe("tool");
		expect(taskResult.output).toBe(REPORT_BODY);
		expect(taskResult.unresolved?.join("\n")).toContain("退出码 3");
	}, 30_000);

	it("still fails when the process dies with no report body at all", async () => {
		const { taskResult } = await runOneTask(
			"V3 no body",
			submitReportWorkerSource({
				report: "",
				tailText: "",
				questions: [{ question: "问题一", status: "answered" }],
				exitCode: 3,
			}),
			{ questions: ["问题一"] },
		);
		expect(taskResult.status === "completed").toBe(false);
	}, 30_000);
});

describe("V4/V6: a trace or progress failure must not rewrite the finished verdict or drop the report", () => {
	it("keeps the completed verdict when the task-finished trace record rejects", async () => {
		const calls: string[] = [];
		const trace = {
			createId: (prefix: string) => `${prefix}-1`,
			createChildContext: () => ({
				runId: "run-child",
				sessionId: "sess",
				agentId: "agent-child",
				role: "delegated" as const,
				traceDir: "trace-dir",
			}),
			record: async (_scope: unknown, type: string) => {
				calls.push(type);
				if (type === "task-finished") throw new Error("trace sink down");
			},
		} as unknown as RuntimeTrace;
		const parentScope = {
			runId: "run-parent",
			sessionId: "sess",
			agentId: "agent-parent",
			role: "main",
		} as RuntimeTraceScope;
		const { taskResult } = await runOneTask(
			"V4 trace down",
			submitReportWorkerSource({ report: REPORT_BODY, questions: [{ question: "问题一", status: "answered" }] }),
			{ questions: ["问题一"] },
			{ trace, parentTraceScope: parentScope },
		);
		expect(calls).toContain("task-finished");
		expect(taskResult.status).toBe("completed");
		expect(taskResult.output).toBe(REPORT_BODY);
	}, 30_000);

	it("keeps the untruncated report when the progress consumer crashes after the task finished", async () => {
		// LONG report over the 20KB per-task cap so the fullOutput and the truncated output differ.
		const longReport = `${REPORT_BODY}\n${Array.from({ length: 3_000 }, (_v, i) => `第 ${i} 行结论证据。`).join("\n")}`;
		let completedSeen = 0;
		const { result, taskResult } = await runOneTask(
			"V6 progress crash",
			submitReportWorkerSource({ report: longReport, questions: [{ question: "问题一", status: "answered" }] }),
			{ questions: ["问题一"] },
			{
				onProgress: (details) => {
					if (details.results[0]?.status !== "completed") return;
					completedSeen += 1;
					// The first sighting is inside the task's own progress; the second comes after the finished
					// result was recorded — throwing there used to drop the non-enumerable fullOutput.
					if (completedSeen === 2) throw new Error("progress consumer crashed");
				},
			},
		);
		expect(completedSeen).toBeGreaterThanOrEqual(2);
		// The settlement catch reports the crash as a failed task, but the report it handed in survives.
		expect(taskResult.status).toBe("failed");
		expect(taskResult.output).toContain(REPORT_BODY);
		expect(taskResult.output.length).toBeLessThan(longReport.length);
		expect(result.text).not.toContain("第 2999 行结论证据。");
		expect(result.fullText).toContain("第 2999 行结论证据。");
	}, 30_000);
});

describe("collectFinalReasoning: reasoning written before the trailing submit_report result", () => {
	it("attaches the reasoning that was written just before an accepted submit_report", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "thinking", thinking: "证据已经汇总，正在写结论。" },
					{ type: "toolCall", id: "submit-1", name: "submit_report", arguments: {} },
				],
				stopReason: "stop",
			},
			{
				role: "toolResult",
				toolCallId: "submit-1",
				toolName: "submit_report",
				content: [{ type: "text", text: "Report received." }],
				isError: false,
				timestamp: 2,
			},
		] as unknown as Message[];
		expect(collectFinalReasoning(messages)).toBe("证据已经汇总，正在写结论。");
	});

	it("still stops at the first non-submit_report tool result", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "更早的推理。" }],
				stopReason: "stop",
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				timestamp: 3,
				content: [{ type: "thinking", thinking: "报告前的推理。" }],
				stopReason: "stop",
			},
		] as unknown as Message[];
		expect(collectFinalReasoning(messages)).toBe("报告前的推理。");
	});
});

describe("C1-C3: the advertised task cap matches the runtime cap", () => {
	it("names the live cap in the tasks description with a dynamic schema cap", () => {
		const tasksSchemaOf = (maxTasks?: number) => {
			const definition = createSubAgentToolDefinition(process.cwd(), {
				getSettings: () => ({ enabled: true, provider: "p", model: "m", thinkingLevel: "off", maxTasks }),
			});
			return definition.parameters.properties.tasks as unknown as {
				maxItems: number;
				minItems: number;
				description: string;
			};
		};
		const defaulted = tasksSchemaOf();
		expect(defaulted.maxItems).toBe(3);
		expect(defaulted.minItems).toBe(1);
		// maxItems follows the live subAgent.maxTasks value; the model must read the cap this call enforces.
		expect(defaulted.description).toContain("at most 3");
		const capped = tasksSchemaOf(7);
		expect(capped.maxItems).toBe(7);
		expect(capped.description).toContain("at most 7");
		expect(capped.description).toContain("separate agent calls");
	});

	it("tells the model how to split when it sends more tasks than the live cap", async () => {
		// Refused before anything is copied or started, so the folder does not matter.
		const tool = enabledTool(process.cwd());
		const tooMany = {
			tasks: Array.from({ length: 4 }, (_value, index) => ({
				description: `Task ${index + 1}`,
				prompt: "Inspect one independent area.",
			})),
		};
		const result = await tool.execute("call-too-many", tooMany, undefined, undefined);
		const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(text).toContain("当前单次最多派发 3");
		expect(text).toContain("收到 4");
		expect(text).toContain("分批");
		expect(text).toContain("不超过 3");
		expect(result.details).toMatchObject({ completed: 0, total: 4 });
	});

	it("changes only description strings and the optional per-task access between modes and keeps every schema constraint", () => {
		const settings = { enabled: true, provider: "p", model: "m", thinkingLevel: "off", maxTasks: 5 } as const;
		const readOnly = JSON.stringify(
			createSubAgentToolDefinition(process.cwd(), { getSettings: () => settings }).parameters,
		);
		const readWrite = JSON.stringify(
			createSubAgentToolDefinition(process.cwd(), {
				getSettings: () => ({ ...settings, mode: "read-write" as const }),
			}).parameters,
		);
		const stripDescriptions = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stripDescriptions);
			if (value && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "description")
						.map(([key, inner]) => [key, stripDescriptions(inner)]),
				);
			}
			return value;
		};
		const parsedReadOnly = JSON.parse(readOnly);
		const parsedReadWrite = JSON.parse(readWrite);
		// maxItems follows the live cap in both modes, so it must match after stripping descriptions.
		expect(parsedReadOnly.properties.tasks.maxItems).toBe(5);
		expect(parsedReadWrite.properties.tasks.maxItems).toBe(5);
		// Read-write tasks may say whether they only read (`access`); it is optional and read-only mode has no such field.
		expect(parsedReadWrite.properties.tasks.items.properties.access).toBeDefined();
		expect(parsedReadWrite.properties.tasks.items.required).not.toContain("access");
		expect(parsedReadOnly.properties.tasks.items.properties.access).toBeUndefined();
		delete parsedReadWrite.properties.tasks.items.properties.access;
		expect(stripDescriptions(parsedReadWrite)).toEqual(stripDescriptions(parsedReadOnly));
		expect(readWrite).not.toBe(readOnly);
		expect(readOnly).toContain("at most 5");
		expect(readOnly).toContain('"maxItems":5');
	}, 30_000);
});

describe("T04b: linear-time acknowledgement detection without catastrophic backtracking", () => {
	it("treats repeated acknowledgement plus noise as non-acknowledgement in linear time without ReDoS", () => {
		const input = `${"好的，".repeat(200)}x`;
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats repeated acknowledgement plus noise below length protection as non-acknowledgement in linear time", () => {
		const input = `${"好的，".repeat(26)}x`;
		expect(input.length).toBeLessThan(200);
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats near-threshold mixed acknowledgement phrase plus noise as non-acknowledgement within 100ms", () => {
		const input = `${"好的，".repeat(60)}ok, got itx`;
		expect(input.length).toBeLessThan(200);
		const start = performance.now();
		const picked = pickReportCandidate([CHECKLIST_REPORT, input]);
		const duration = performance.now() - start;
		expect(picked).toBe(input);
		expect(duration).toBeLessThan(100);
	});

	it("treats repetitive acknowledgements within length limit as acknowledgement", () => {
		const input = "好的，".repeat(30);
		expect(pickReportCandidate([CHECKLIST_REPORT, input])).toBe(CHECKLIST_REPORT);
	});

	it("rejects overlong acknowledgement text exceeding 200 characters via structural protection", () => {
		const input = "好的，".repeat(300);
		expect(pickReportCandidate([CHECKLIST_REPORT, input])).toBe(input);
	});

	it("continues to recognize varied English and Chinese confirmation phrases as acknowledgements", () => {
		for (const ack of ["ok, got it. thanks!", "好的，收到。", "好的，明白！"]) {
			expect(pickReportCandidate([CHECKLIST_REPORT, ack])).toBe(CHECKLIST_REPORT);
		}
	});

	it("treats a 3000-character normal report as non-acknowledgement", () => {
		const normalReport = "调查报告正文结论，包含详细证据、路径与行号。".repeat(150);
		expect(normalReport.length).toBeGreaterThanOrEqual(3000);
		expect(pickReportCandidate([CHECKLIST_REPORT, normalReport])).toBe(normalReport);
	});
});
