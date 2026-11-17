import { beforeEach, describe, expect, it } from "vitest";
import {
	createSubmitReportTool,
	createSubmitReportToolDefinition,
	getDelegatedReportQuestions,
	normalizeSubmittedReport,
	noteDelegatedAssistantText,
	REPORT_QUESTION_STATUSES,
	SUBMIT_REPORT_TOOL_NAME,
	type SubmitReportInput,
	setDelegatedReportQuestions,
} from "../src/tools/submit-report.ts";

function submission(overrides: Partial<SubmitReportInput>): SubmitReportInput {
	return {
		report: "调查结论。",
		questions: [
			{ question: "守卫在哪实现？", status: "answered" },
			{ question: "测试在哪？", status: "answered" },
		],
		...overrides,
	};
}

const TWO_QUESTIONS = ["守卫在哪实现？", "测试在哪？"];

describe("normalizeSubmittedReport", () => {
	it("accepts a complete submission and trims the report", () => {
		const normalized = normalizeSubmittedReport(submission({ report: "  正文  " }), TWO_QUESTIONS);
		expect(normalized.report).toBe("正文");
		expect(normalized.questions).toHaveLength(2);
		expect(normalized.questions[0]).toEqual({ question: "守卫在哪实现？", status: "answered" });
	});

	it("keeps a non-empty note and drops an empty one", () => {
		const normalized = normalizeSubmittedReport(
			submission({
				questions: [
					{ question: "a", status: "unavailable", note: " 登录墙挡住了 " },
					{ question: "b", status: "answered", note: "   " },
				],
			}),
			TWO_QUESTIONS,
		);
		expect(normalized.questions[0].note).toBe("登录墙挡住了");
		expect(normalized.questions[1].note).toBeUndefined();
	});

	it("rejects a wrong entry count and names the required order", () => {
		const counts: SubmitReportInput["questions"][] = [
			[],
			[{ question: "守卫在哪实现？", status: "answered" }],
			[
				{ question: "a", status: "answered" },
				{ question: "b", status: "answered" },
				{ question: "c", status: "answered" },
			],
		];
		for (const questions of counts) {
			expect(() => normalizeSubmittedReport(submission({ questions }), TWO_QUESTIONS)).toThrow(
				/the task lists 2 question\(s\) but questions has \d+ entr/,
			);
		}
		expect(() => normalizeSubmittedReport(submission({ questions: [] }), TWO_QUESTIONS)).toThrow(
			/1\. 守卫在哪实现？\n2\. 测试在哪？/,
		);
	});

	it("rejects a missing note for a status that is not answered", () => {
		for (const status of ["partial", "unavailable", "not_done"] as const) {
			expect(() =>
				normalizeSubmittedReport(
					submission({
						questions: [
							{ question: "守卫在哪实现？", status: "answered" },
							{ question: "测试在哪？", status },
						],
					}),
					TWO_QUESTIONS,
				),
			).toThrow(/entry 2 of questions is not answered but carries no note/i);
		}
	});

	it("rejects an invalid status and lists the four allowed ones", () => {
		expect(() =>
			normalizeSubmittedReport(
				submission({
					questions: [{ question: "守卫在哪实现？", status: "done" as never }],
				}),
				["守卫在哪实现？"],
			),
		).toThrow(/invalid status; use answered, partial, unavailable or not_done/);
	});

	it("falls back to the task question when an entry has no question text", () => {
		const normalized = normalizeSubmittedReport(
			submission({
				questions: [
					{ question: "", status: "answered" },
					{ question: "x", status: "answered" },
				],
			}),
			TWO_QUESTIONS,
		);
		expect(normalized.questions[0].question).toBe("守卫在哪实现？");
		expect(normalized.questions[1].question).toBe("x");
	});

	it("checks nothing when the task lists no Questions", () => {
		const normalized = normalizeSubmittedReport({ report: "只有正文。", questions: [] }, []);
		expect(normalized).toEqual({ report: "只有正文。", questions: [] });
	});

	it("exposes the four allowed statuses", () => {
		expect(REPORT_QUESTION_STATUSES).toEqual(["answered", "partial", "unavailable", "not_done"]);
	});
});

describe("setDelegatedReportQuestions", () => {
	beforeEach(() => {
		setDelegatedReportQuestions([]);
	});

	it("stores the trimmed non-empty questions of the task", () => {
		setDelegatedReportQuestions(["  A  ", "", "B"]);
		expect(getDelegatedReportQuestions()).toEqual(["A", "B"]);
	});

	it("treats undefined as no questions", () => {
		setDelegatedReportQuestions(["A"]);
		setDelegatedReportQuestions(undefined);
		expect(getDelegatedReportQuestions()).toEqual([]);
	});
});

describe("submit_report tool execute", () => {
	beforeEach(() => {
		setDelegatedReportQuestions(TWO_QUESTIONS);
	});

	it("terminates the worker run on a successful call", async () => {
		const tool = createSubmitReportToolDefinition();
		expect(tool.name).toBe(SUBMIT_REPORT_TOOL_NAME);
		const result = await tool.execute("call-1", submission({}), undefined, undefined, undefined as never);
		expect(result.terminate).toBe(true);
		expect(result.details).toEqual({
			questions: [
				{ question: "守卫在哪实现？", status: "answered" },
				{ question: "测试在哪？", status: "answered" },
			],
			reportBytes: Buffer.byteLength("调查结论。", "utf8"),
		});
		expect(result.content).toEqual([
			{ type: "text", text: "Report received. The task is finished; do not continue." },
		]);
	});

	it("refuses a submission that does not match the task questions and does not terminate", async () => {
		const tool = createSubmitReportTool();
		expect(tool.name).toBe(SUBMIT_REPORT_TOOL_NAME);
		await expect(
			tool.execute(
				"call-1",
				submission({ questions: [{ question: "只有一条", status: "answered" }] }),
				undefined,
				undefined,
			),
		).rejects.toThrow(/the task lists 2 question\(s\)/);
	});

	it("accepts a task without Questions when only the report is handed in", async () => {
		setDelegatedReportQuestions([]);
		const tool = createSubmitReportToolDefinition();
		const result = await tool.execute("call-2", { report: "正文" }, undefined, undefined, undefined as never);
		expect(result.terminate).toBe(true);
		expect(result.details).toEqual({ questions: [], reportBytes: Buffer.byteLength("正文", "utf8") });
	});

	it("rejects an empty report when the worker has not written any assistant text in the run", async () => {
		setDelegatedReportQuestions([]);
		const tool = createSubmitReportToolDefinition();
		// An empty `report` means "the text I already wrote is the report": with no text anywhere in the run, the
		// Main Agent would receive an empty report that fails as no_report. The tool refuses inside the run instead.
		await expect(tool.execute("call-3", { report: "" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty and no reply of this run carried a report body/i,
		);
		// Same for an omitted report field and for whitespace-only text.
		await expect(tool.execute("call-4", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty/i,
		);
		await expect(tool.execute("call-5", { report: "   " }, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty/i,
		);
	});

	it("accepts an empty report once the worker has written assistant text, and resets with the next task", async () => {
		setDelegatedReportQuestions([]);
		noteDelegatedAssistantText("");
		noteDelegatedAssistantText("   ");
		// Empty and whitespace-only replies are no report text.
		const tool = createSubmitReportToolDefinition();
		await expect(tool.execute("call-6", { report: "" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty/i,
		);
		// A bare acknowledgement is no report body either.
		noteDelegatedAssistantText("好的，收到");
		await expect(tool.execute("call-6b", { report: "" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty/i,
		);
		noteDelegatedAssistantText(
			"完整报告正文：第一个问题已在 src/a.ts 第 12 行确认，第二个问题的资料拿不到，原因见下文的卡点说明。",
		);
		const result = await tool.execute("call-7", { report: "" }, undefined, undefined, undefined as never);
		expect(result.terminate).toBe(true);
		// A non-empty report needs no text at all.
		const direct = await tool.execute("call-8", { report: "正文" }, undefined, undefined, undefined as never);
		expect(direct.terminate).toBe(true);
		// The next task starts clean: no text seen again. Questions stay empty so the count check does not
		// fire first; the empty-report check is what this asserts.
		setDelegatedReportQuestions([]);
		await expect(tool.execute("call-9", { report: "" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/report is empty/i,
		);
	});
});
