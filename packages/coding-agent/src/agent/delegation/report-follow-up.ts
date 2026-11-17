/**
 * What a delegated worker does after its task prompt has run to the end without a handed-in report.
 *
 * The worker's run is over when the agent loop has nothing left to do. Three endings still deserve one more turn of
 * the same model, with the same thinking level and the same output limit:
 *
 * - the reply was cut off by the output limit while it was writing the report text: the model is asked once to go on
 *   exactly where the text stopped (`continue_truncated`);
 * - the run ended without a successful `submit_report` call, with or without report text: the model is asked once to
 *   stop investigating and hand in the report it has (`request_report`).
 *
 * Every follow-up happens at most once per task. Whatever is still missing afterwards is reported honestly by the
 * dispatching process (`tools/sub-agent.ts`): a missing report body is a failure that carries the reasoning the model
 * produced; a report without `submit_report` falls back to reading the text and is marked as not handed in properly.
 * A tool call whose arguments were cut off is never executed (the agent loop fails it and gives the model another
 * turn), so it ends up here as a reply without a report like any other.
 */
import type { AgentMessage } from "@myharness/agent-core";
import { SUBMIT_REPORT_TOOL_NAME } from "../../tools/submit-report.ts";

export type DelegatedFollowUpKind = "continue_truncated" | "request_report" | "request_report_text";

export interface DelegatedFollowUp {
	kind: DelegatedFollowUpKind;
	text: string;
}

export interface DelegatedFollowUpState {
	continuedTruncated: boolean;
	requestedReport: boolean;
	/** Whether the worker was already asked once to write the report text for an accepted-but-empty submission. */
	requestedReportText?: boolean;
}

export const CONTINUE_TRUNCATED_TEXT =
	"Your previous reply was cut off by the output length limit. Continue the report exactly where it stopped, without repeating anything you already wrote, and then hand it in with submit_report (leave report empty to hand in the text you wrote).";

export const REQUEST_REPORT_AFTER_TEXT =
	"You ended without a successful submit_report call. Do not investigate any further. Call submit_report now as the only call in your reply: give one status per question of the task, and leave report empty to hand in the report you already wrote above, or put the complete report in it.";

export const REQUEST_REPORT_WITHOUT_TEXT =
	"Your last reply contained no report text and no successful submit_report call. Do not investigate any further. Write your final report from the evidence you already have and hand it in with submit_report now, as the only call in your reply.";

export const REQUEST_REPORT_EMPTY_ACCEPTED_TEXT =
	"Your submit_report call was accepted, but its report field was empty and no reply of this run carried the report text either. Do not investigate any further. Write your final report from the evidence you already have and call submit_report again now, as the only call in your reply, putting the complete report in the report field (with one entry per question listed in the task).";

type AssistantLike = Extract<AgentMessage, { role: "assistant" }>;

function isAssistant(message: AgentMessage): message is AssistantLike {
	return (message as { role?: unknown }).role === "assistant";
}

function assistantTextOf(message: AssistantLike): string {
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Whether `messages` hold a `submit_report` call that the tool accepted. */
export function hasAcceptedReport(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		const value = message as { role?: unknown; toolName?: unknown; isError?: unknown };
		return value.role === "toolResult" && value.toolName === SUBMIT_REPORT_TOOL_NAME && value.isError !== true;
	});
}

/**
 * The report body the accepted `submit_report` handed in: the trimmed `report` argument when the call carries one,
 * `undefined` when it does not (no explicit empty hand-in). Reads the call arguments from the transcript the same
 * way the dispatching process does (`findSubmittedReport` in sub-agent.ts).
 */
function acceptedReportBody(messages: readonly AgentMessage[]): string | undefined {
	let acceptedId: string | undefined;
	for (const message of messages) {
		const value = message as { role?: unknown; toolName?: unknown; isError?: unknown; toolCallId?: unknown };
		if (value.role === "toolResult" && value.toolName === SUBMIT_REPORT_TOOL_NAME && value.isError !== true) {
			acceptedId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
		}
	}
	if (!acceptedId) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isAssistant(message)) continue;
		const call = message.content.find(
			(part): part is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
				part.type === "toolCall" && part.id === acceptedId,
		);
		if (!call) continue;
		const report = (call.arguments as { report?: unknown } | undefined)?.report;
		return typeof report === "string" ? report.trim() : undefined;
	}
	return undefined;
}

/** The one follow-up turn this worker should take now, or `undefined` when its run is complete. */
export function nextDelegatedFollowUp(
	messages: readonly AgentMessage[],
	state: DelegatedFollowUpState,
): DelegatedFollowUp | undefined {
	if (hasAcceptedReport(messages)) {
		// The tool accepted an explicitly empty report and the worker wrote no report text anywhere in the run: the
		// dispatching process would otherwise file that submission as failed/no_report. Ask once, so the worker gets
		// its chance. A short remark next to tool calls is not report text (same rule as the report request below).
		if (
			!state.requestedReportText &&
			acceptedReportBody(messages) === "" &&
			!messages.some((message) => isAssistant(message) && assistantTextOf(message) !== "" && !hasOnlyRemark(message))
		) {
			return { kind: "request_report_text", text: REQUEST_REPORT_EMPTY_ACCEPTED_TEXT };
		}
		return undefined;
	}
	const last = [...messages].reverse().find(isAssistant);
	if (!last) return undefined;
	// A provider failure or a stop is reported as such; another turn would only hide it.
	if (last.stopReason === "error" || last.stopReason === "aborted") return undefined;
	const text = assistantTextOf(last);
	const hasToolCall = last.content.some((part) => part.type === "toolCall");
	if (last.stopReason === "length" && text !== "" && !hasToolCall && !state.continuedTruncated) {
		return { kind: "continue_truncated", text: CONTINUE_TRUNCATED_TEXT };
	}
	if (!state.requestedReport) {
		const wroteReport = messages.some(
			(message) => isAssistant(message) && assistantTextOf(message) !== "" && !hasOnlyRemark(message),
		);
		return { kind: "request_report", text: wroteReport ? REQUEST_REPORT_AFTER_TEXT : REQUEST_REPORT_WITHOUT_TEXT };
	}
	return undefined;
}

/** A reply that is a short remark next to tool calls, never a report body. */
function hasOnlyRemark(message: AssistantLike): boolean {
	return message.content.some((part) => part.type === "toolCall") && Buffer.byteLength(assistantTextOf(message)) < 512;
}

/**
 * Run the follow-up turns on a finished worker session: at most one continuation after a cut-off report and at most
 * one request to hand the report in. `prompt` runs one more user turn on the same session and resolves when it ends.
 */
export async function runDelegatedReportFollowUps(session: {
	readonly messages: AgentMessage[];
	prompt(text: string): Promise<void>;
}): Promise<DelegatedFollowUpKind[]> {
	const state: DelegatedFollowUpState = {
		continuedTruncated: false,
		requestedReport: false,
		requestedReportText: false,
	};
	const taken: DelegatedFollowUpKind[] = [];
	for (;;) {
		const followUp = nextDelegatedFollowUp(session.messages, state);
		if (!followUp) return taken;
		if (followUp.kind === "continue_truncated") state.continuedTruncated = true;
		else if (followUp.kind === "request_report_text") state.requestedReportText = true;
		else state.requestedReport = true;
		taken.push(followUp.kind);
		await session.prompt(followUp.text);
	}
}
