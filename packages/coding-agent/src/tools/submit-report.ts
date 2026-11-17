/**
 * submit_report: how a delegated Explore worker hands in its final report.
 *
 * The worker fills fixed fields instead of ending its reply with a free-text checklist: the report body and one status
 * per question of the task. The dispatching process reads these fields from the tool call itself (see
 * `tools/sub-agent.ts`), so whether a task is complete, complete with data gaps, or not complete is never guessed from
 * the wording of the report. A successful call ends the worker's run (`terminate`), so the report is the last thing it
 * produces.
 *
 * The tool exists only in delegated worker sessions (see `agent/runtime/role.ts` and the session tool registry); the
 * main agent never sees it.
 */

import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const SUBMIT_REPORT_TOOL_NAME = "submit_report";

/**
 * - `answered`: fully answered with evidence.
 * - `partial`: only part of the question is answered.
 * - `unavailable`: investigated, but the material needed does not exist or cannot be reached (login, CAPTCHA,
 *   unreadable image...); the note says where the worker looked and what blocked it. A data gap, not a failure.
 * - `not_done`: not worked on.
 */
export type ReportQuestionStatus = "answered" | "partial" | "unavailable" | "not_done";

export const REPORT_QUESTION_STATUSES: readonly ReportQuestionStatus[] = [
	"answered",
	"partial",
	"unavailable",
	"not_done",
];

const questionStatusSchema = Type.Union(
	[Type.Literal("answered"), Type.Literal("partial"), Type.Literal("unavailable"), Type.Literal("not_done")],
	{
		description:
			"answered: fully answered with evidence; partial: only part of it is answered; unavailable: you investigated but the needed material does not exist or cannot be reached (login, CAPTCHA, unreadable image...); not_done: not worked on.",
	},
);

const submitReportSchema = Type.Object({
	report: Type.Optional(
		Type.String({
			description:
				"The complete final report in Markdown: findings, evidence with file paths or URLs, conflicts and unresolved points. Leave it empty only when this same reply already contains the complete report as text before this call.",
		}),
	),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String({ description: "The question, as listed under Questions in the task." }),
				status: questionStatusSchema,
				note: Type.Optional(
					Type.String({
						description:
							"Required unless answered: what is missing, where you looked and what blocked you, or why it was not done.",
					}),
				),
			}),
			{
				description:
					"One entry per question listed under Questions in the task, in the same order. Omit when the task lists no Questions.",
			},
		),
	),
});

export type SubmitReportInput = Static<typeof submitReportSchema>;

export interface SubmittedQuestionStatus {
	question: string;
	status: ReportQuestionStatus;
	note?: string;
}

export interface SubmitReportDetails {
	questions: SubmittedQuestionStatus[];
	reportBytes: number;
}

/**
 * Questions of the task this worker process runs. The worker sets them once from its first stdin line (see
 * `agent/delegation/worker.ts`); the tool checks each submission against them so a missing or extra entry is fixed by
 * the worker itself, inside the same run, instead of turning the task partial afterwards. One worker process runs one
 * task, so a process-wide value is exact.
 */
let expectedQuestions: readonly string[] = [];

/**
 * Whether the worker session has already released an assistant reply that carried text, tracked from the worker's
 * event stream (see `noteDelegatedAssistantText`). An empty `report` field means "the text I already wrote is the
 * report", so the tool checks this before accepting an empty report; a worker that wrote nothing cannot hand in an
 * empty report, because the Main Agent would receive nothing at all.
 */
let delegatedAssistantTextSeen = false;

/**
 * Record one assistant reply of the worker session (called from the worker's event stream). Only non-empty text
 * counts: a thinking-only or empty turn is no report body.
 */
export function noteDelegatedAssistantText(text: string): void {
	// A bare acknowledgement or a one-line remark ("好的，收到") is not a report body: below this size an empty report
	// field is refused, so the worker puts the report into the field itself.
	if (Buffer.byteLength(text.trim(), "utf8") >= REPORT_TEXT_MIN_BYTES) delegatedAssistantTextSeen = true;
}

/**
 * Below this many UTF-8 bytes a reply's text reads as a remark rather than as a report body (shared with the
 * dispatcher's report picking in sub-agent.ts).
 */
export const REPORT_TEXT_MIN_BYTES = 96;

function hasDelegatedAssistantText(): boolean {
	return delegatedAssistantTextSeen;
}

export function setDelegatedReportQuestions(questions: readonly string[] | undefined): void {
	expectedQuestions = (questions ?? []).map((item) => item.trim()).filter((item) => item !== "");
	// A new task starts with no assistant text seen; the worker sets the questions once per run (worker.ts).
	delegatedAssistantTextSeen = false;
}

export function getDelegatedReportQuestions(): readonly string[] {
	return expectedQuestions;
}

function isReportQuestionStatus(value: unknown): value is ReportQuestionStatus {
	return typeof value === "string" && (REPORT_QUESTION_STATUSES as readonly string[]).includes(value);
}

/** Normalize and validate one submission against the task's questions. Throws a message the model can act on. */
export function normalizeSubmittedReport(
	input: SubmitReportInput | undefined,
	questions: readonly string[],
): { report: string; questions: SubmittedQuestionStatus[] } {
	const report = typeof input?.report === "string" ? input.report.trim() : "";
	const raw = Array.isArray(input?.questions) ? input.questions : [];
	const entries: SubmittedQuestionStatus[] = raw.map((item, index) => {
		const status = item?.status;
		if (!isReportQuestionStatus(status)) {
			throw new Error(
				`Entry ${index + 1} of questions has an invalid status; use answered, partial, unavailable or not_done.`,
			);
		}
		const question = typeof item?.question === "string" ? item.question.trim() : "";
		const note = typeof item?.note === "string" ? item.note.trim() : "";
		return { question: question || questions[index] || `Question ${index + 1}`, status, ...(note ? { note } : {}) };
	});
	if (questions.length > 0 && entries.length !== questions.length) {
		throw new Error(
			`Report not accepted: the task lists ${questions.length} question(s) but questions has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}. Call submit_report again with exactly one entry per question, in this order:\n${questions.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
		);
	}
	const missingNotes = entries
		.map((entry, index) => (entry.status !== "answered" && !entry.note ? index + 1 : undefined))
		.filter((index): index is number => index !== undefined);
	if (missingNotes.length > 0) {
		throw new Error(
			`Report not accepted: entr${missingNotes.length === 1 ? "y" : "ies"} ${missingNotes.join(", ")} of questions ${missingNotes.length === 1 ? "is" : "are"} not answered but carr${missingNotes.length === 1 ? "ies" : "y"} no note. Call submit_report again and say in note what is missing, where you looked and what blocked you.`,
		);
	}
	return { report, questions: entries };
}

export function createSubmitReportToolDefinition(): BusinessToolDefinition<
	typeof submitReportSchema,
	SubmitReportDetails
> {
	return {
		name: SUBMIT_REPORT_TOOL_NAME,
		label: SUBMIT_REPORT_TOOL_NAME,
		description:
			"Hand in your final report and end the task. Call it exactly once, as the last step, alone in its reply: report carries the complete report (or stays empty when the same reply already holds it as text), and questions gives one status per question listed in the task, in order. Do not start new investigation after calling it.",
		promptSnippet: loadSystemPrompt("tools/submit-report/snippet.md"),
		parameters: submitReportSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const normalized = normalizeSubmittedReport(params, expectedQuestions);
			// An empty `report` means "the text I already wrote in this run is the report". When the worker never wrote
			// any assistant text, accepting it would hand the Main Agent an empty report that fails as no_report; reject
			// inside the run instead, so the model can fix the submission in its next turn.
			if (normalized.report === "" && !hasDelegatedAssistantText()) {
				throw new Error(
					"Report not accepted: report is empty and no reply of this run carried a report body either (a short remark or an acknowledgement does not count). Call submit_report again as the only call of your next reply, with the complete final report in the report field.",
				);
			}
			return {
				content: [{ type: "text", text: "Report received. The task is finished; do not continue." }],
				details: { questions: normalized.questions, reportBytes: Buffer.byteLength(normalized.report, "utf8") },
				terminate: true,
			};
		},
	};
}

export function createSubmitReportTool(): AgentTool<typeof submitReportSchema> {
	return wrapToolDefinition(createSubmitReportToolDefinition());
}
