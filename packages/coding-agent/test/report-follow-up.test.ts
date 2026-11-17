import type { AgentMessage } from "@myharness/agent-core";
import { describe, expect, it } from "vitest";
import {
	CONTINUE_TRUNCATED_TEXT,
	type DelegatedFollowUpState,
	hasAcceptedReport,
	nextDelegatedFollowUp,
	REQUEST_REPORT_AFTER_TEXT,
	REQUEST_REPORT_EMPTY_ACCEPTED_TEXT,
	REQUEST_REPORT_WITHOUT_TEXT,
	runDelegatedReportFollowUps,
} from "../src/agent/delegation/report-follow-up.ts";

let clock = 0;

function assistant(text: string, stopReason = "stop", extraContent: unknown[] = []): AgentMessage {
	clock += 1;
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...extraContent],
		stopReason,
		timestamp: clock,
	} as unknown as AgentMessage;
}

function toolCall(id: string): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
	return { type: "toolCall", id, name: "read", arguments: { path: "a.ts" } };
}

function toolResult(callId: string, toolName: string, isError = false): AgentMessage {
	clock += 1;
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: clock,
	} as unknown as AgentMessage;
}

function acceptedReport(messages: AgentMessage[]): AgentMessage[] {
	return [...messages, toolResult("submit-1", "submit_report")];
}

const cleanState = (): DelegatedFollowUpState => ({
	continuedTruncated: false,
	requestedReport: false,
	requestedReportText: false,
});

function submitCall(id: string, args: Record<string, unknown>, text = "交报告。"): AgentMessage {
	clock += 1;
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name: "submit_report", arguments: args },
		],
		stopReason: "stop",
		timestamp: clock,
	} as unknown as AgentMessage;
}

/** An accepted `submit_report` round trip whose `report` field is explicitly empty. */
function acceptedEmptyReport(messages: AgentMessage[]): AgentMessage[] {
	return [
		...messages,
		submitCall("submit-empty", { report: "", questions: [] }),
		toolResult("submit-empty", "submit_report"),
	];
}

describe("hasAcceptedReport", () => {
	it("sees a successful submit_report result", () => {
		expect(hasAcceptedReport(acceptedReport([assistant("工作说明。", "stop", [toolCall("submit-1")])]))).toBe(true);
	});

	it("ignores a failed submit_report result", () => {
		const messages = [assistant("正文。"), toolResult("submit-1", "submit_report", true)];
		expect(hasAcceptedReport(messages)).toBe(false);
	});

	it("is false without any submit_report result", () => {
		expect(hasAcceptedReport([assistant("正文。"), toolResult("r1", "read")])).toBe(false);
	});
});

describe("nextDelegatedFollowUp", () => {
	it("returns nothing after an accepted submit_report result", () => {
		const messages = acceptedReport([assistant("正文。", "length")]);
		expect(nextDelegatedFollowUp(messages, cleanState())).toBeUndefined();
	});

	it("asks once for the report text when an accepted submit_report handed in nothing and no reply carries text", () => {
		// The dispatching process would file this submission as failed/no_report; the worker gets one more chance.
		const messages = acceptedEmptyReport([]);
		expect(nextDelegatedFollowUp(messages, cleanState())).toEqual({
			kind: "request_report_text",
			text: REQUEST_REPORT_EMPTY_ACCEPTED_TEXT,
		});
		// Only once: the state flag suppresses a second ask.
		expect(
			nextDelegatedFollowUp(messages, {
				continuedTruncated: false,
				requestedReport: false,
				requestedReportText: true,
			}),
		).toBeUndefined();
	});

	it("does not ask when the accepted report carries a body or any reply carries text", () => {
		const withBody = [
			submitCall("submit-1", { report: "完整报告正文。", questions: [] }),
			toolResult("submit-1", "submit_report"),
		];
		expect(nextDelegatedFollowUp(withBody, cleanState())).toBeUndefined();
		const withText = acceptedEmptyReport([assistant("正文已经在上面写完了。")]);
		expect(nextDelegatedFollowUp(withText, cleanState())).toBeUndefined();
		// A failed empty submission is handled by the ordinary report request instead.
		const failedEmpty = [
			assistant("备注。", "stop", [{ type: "toolCall", id: "s2", name: "submit_report", arguments: {} }]),
			toolResult("s2", "submit_report", true),
		];
		expect(nextDelegatedFollowUp(failedEmpty, cleanState())?.kind).toBe("request_report");
	});

	it("asks once to continue a reply the output limit cut off", () => {
		const messages = [assistant("报告写到一半", "length")];
		const followUp = nextDelegatedFollowUp(messages, cleanState());
		expect(followUp).toEqual({ kind: "continue_truncated", text: CONTINUE_TRUNCATED_TEXT });
		// Only once: the state flag suppresses a second continuation.
		expect(nextDelegatedFollowUp(messages, { continuedTruncated: true, requestedReport: false })).toEqual({
			kind: "request_report",
			text: REQUEST_REPORT_AFTER_TEXT,
		});
	});

	it("does not treat a truncated reply that carries a tool call as a cut-off report", () => {
		const messages = [assistant("备注。", "length", [toolCall("r1")])];
		expect(nextDelegatedFollowUp(messages, cleanState())?.kind).toBe("request_report");
	});

	it("asks once to hand the report in when none was accepted", () => {
		const followUp = nextDelegatedFollowUp([assistant("完整报告正文，含证据与路径。")], cleanState());
		expect(followUp).toEqual({ kind: "request_report", text: REQUEST_REPORT_AFTER_TEXT });
		expect(
			nextDelegatedFollowUp([assistant("完整报告正文。")], { continuedTruncated: false, requestedReport: true }),
		).toBeUndefined();
	});

	it("tells the worker to write the report when no reply carried report text", () => {
		// A short remark next to tool calls is not a report body.
		const messages = [
			assistant("好的，去查。", "stop", [toolCall("r1")]),
			toolResult("r1", "read"),
			assistant("查完了。", "stop", [toolCall("r2")]),
		];
		expect(nextDelegatedFollowUp(messages, cleanState())).toEqual({
			kind: "request_report",
			text: REQUEST_REPORT_WITHOUT_TEXT,
		});
		// An empty final reply is the same case.
		expect(nextDelegatedFollowUp([assistant("")], cleanState())?.text).toBe(REQUEST_REPORT_WITHOUT_TEXT);
	});

	it("returns nothing after a provider error or an abort", () => {
		expect(nextDelegatedFollowUp([assistant("写了一半", "error")], cleanState())).toBeUndefined();
		expect(nextDelegatedFollowUp([assistant("写了一半", "aborted")], cleanState())).toBeUndefined();
	});

	it("returns nothing when the run produced no assistant reply at all", () => {
		expect(nextDelegatedFollowUp([], cleanState())).toBeUndefined();
	});
});

describe("runDelegatedReportFollowUps", () => {
	/** A fake worker session: each prompt appends the given messages to the transcript. */
	function fakeSession(script: AgentMessage[][]) {
		const messages: AgentMessage[] = [];
		const prompts: string[] = [];
		let index = 0;
		return {
			messages,
			prompts,
			prompt(text: string): Promise<void> {
				prompts.push(text);
				messages.push(...(script[index] ?? []));
				index += 1;
				return Promise.resolve();
			},
		};
	}

	it("runs one continuation and one report request, then stops once the report is accepted", async () => {
		const session = fakeSession([
			// After the continuation request: the model continues writing the report text.
			[assistant("……接着写完正文。")],
			// After the report request: the model hands the report in with submit_report.
			[assistant("", "stop", [toolCall("submit-1")]), toolResult("submit-1", "submit_report")],
		]);
		session.messages.push(assistant("报告写到一半", "length"));
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual(["continue_truncated", "request_report"]);
		expect(session.prompts).toEqual([CONTINUE_TRUNCATED_TEXT, REQUEST_REPORT_AFTER_TEXT]);
	});

	it("never takes a follow-up when the report was accepted without help", async () => {
		const session = fakeSession([]);
		session.messages.push(...acceptedReport([assistant("正文。", "stop", [toolCall("submit-1")])]));
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual([]);
		expect(session.prompts).toEqual([]);
	});

	it("takes at most one report request even when the reply still carries no report", async () => {
		const session = fakeSession([[assistant("我不需要再交报告。")]]);
		session.messages.push(assistant("正文在这里。"));
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual(["request_report"]);
		expect(session.prompts).toEqual([REQUEST_REPORT_AFTER_TEXT]);
	});

	it("stops completely when the last reply ended in a provider error", async () => {
		const session = fakeSession([[assistant("又试了一次。", "error")]]);
		session.messages.push(assistant("写了一半", "error"));
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual([]);
		expect(session.prompts).toEqual([]);
	});

	it("asks once for the report text after an accepted-but-empty submission, then stops once text is in", async () => {
		const session = fakeSession([
			// After the ask: the model writes the report body and hands it in again (accepted this time).
			[submitCall("submit-2", { report: "完整报告正文。", questions: [] }), toolResult("submit-2", "submit_report")],
		]);
		session.messages.push(...acceptedEmptyReport([]));
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual(["request_report_text"]);
		expect(session.prompts).toEqual([REQUEST_REPORT_EMPTY_ACCEPTED_TEXT]);
	});

	it("takes no report-text ask when the accepted submission carried a body", async () => {
		const session = fakeSession([]);
		session.messages.push(
			submitCall("submit-ok", { report: "完整报告正文。", questions: [] }),
			toolResult("submit-ok", "submit_report"),
		);
		const taken = await runDelegatedReportFollowUps(session);
		expect(taken).toEqual([]);
		expect(session.prompts).toEqual([]);
	});
});
