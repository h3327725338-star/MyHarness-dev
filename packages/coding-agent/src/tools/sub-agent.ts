import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool, ThinkingLevel } from "@myharness/agent-core";
import { stripModelGuidance } from "@myharness/ai";
import type { Message } from "@myharness/ai/compat";
import { type Static, Type } from "typebox";
import { beginCopyPoolUse, scheduleCopyPoolPrewarm } from "../agent/delegation/copy-pool.ts";
import {
	collectDelegatedEventMessages,
	createDelegatedEventState,
	type DelegatedJsonEvent,
	extractDelegatedMessageToolEvidence,
} from "../agent/delegation/event-parser.ts";
import { acquireMirrorCopy, type MirrorCopyHandle, releaseMirrorCopy } from "../agent/delegation/mirror-pool.ts";
import { registerDelegatedSandboxWorker } from "../agent/delegation/non-git-sandbox.ts";
import {
	CONTINUE_TRUNCATED_TEXT,
	REQUEST_REPORT_AFTER_TEXT,
	REQUEST_REPORT_WITHOUT_TEXT,
} from "../agent/delegation/report-follow-up.ts";
import {
	acquirePooledWorktree,
	createWorkspaceSnapshot,
	type PooledWorktreeHandle,
	releasePooledWorktree,
} from "../agent/delegation/worktree-pool.ts";
import {
	DELEGATED_SANDBOX_ORIGIN_ENV,
	type DelegatedSandboxHandle,
	detectDelegatedWorkspace,
} from "../agent/delegation/worktree-sandbox.ts";
import {
	DELEGATED_TOOL_NAMES,
	DELEGATED_WRITE_TOOL_NAMES,
	isGatedBuiltinToolName,
	withoutDisabledBuiltinTools,
} from "../agent/runtime/role.ts";
import { SETTINGS_DEFAULTS, SUB_AGENT_SETTING_RANGES } from "../config/settings/defaults.ts";
import type { SubAgentMode } from "../config/settings/types.ts";
import { getAgentDir } from "../config.ts";
import {
	classifyToolStatus,
	getRuntimeTraceEnvironment,
	type RuntimeTrace,
	type RuntimeTraceChildContext,
	type RuntimeTraceScope,
} from "../observability/runtime-trace.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";
import { containProcessTree, endContainedLeftovers } from "../utils/child-process.ts";
import { getMyHarnessInvocation } from "../utils/myharness-invocation.ts";
import { killProcessTreeAndWait } from "../utils/shell.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { awaitForegroundDispatch, type DispatchRegistrar } from "./dispatch-control.ts";
import { createDelegatedWriteGuardExtensionSource, DELEGATED_READ_ROOTS_ENV } from "./shell/delegated-write-guard.ts";
import { createReadOnlyGuardExtensionSource, isReadOnlyGuardBlockedToolResult } from "./shell/read-only-guard.ts";
import {
	normalizeSubmittedReport,
	REPORT_QUESTION_STATUSES,
	REPORT_TEXT_MIN_BYTES,
	type ReportQuestionStatus,
	SUBMIT_REPORT_TOOL_NAME,
	type SubmittedQuestionStatus,
} from "./submit-report.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "./tool-result-persistence.ts";
import { truncateHead } from "./truncate.ts";

const PER_TASK_OUTPUT_CAP = 20 * 1024;
const SUB_AGENT_STOP_TIMEOUT_MS = 5_000;
/** How long a worker's output pipes may stay open after the worker itself has exited (see the "exit" handler). */
const WORKER_EXIT_DRAIN_MS = 2_000;
/** Zero means delegated Explore tasks have no wall-clock deadline by default. */
export const DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS = 0;
/** Zero means a delegated Explore task may use as many model/tool turns as needed. */
export const DEFAULT_SUB_AGENT_MAX_TURNS = 0;
/** Ten minutes without meaningful progress is a stall by default. */
export const DEFAULT_SUB_AGENT_STALL_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION = true;
export const DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION = true;
/** Reminder cadence: re-inject a steering reminder after every N repeats/errors/idle turns. */
const REPEATED_OPERATION_THRESHOLD = 3;
const CONSECUTIVE_TOOL_ERROR_THRESHOLD = 3;
const NO_PROGRESS_TURN_THRESHOLD = 3;
const PARTIAL_SUMMARY_CAP = 12 * 1024;
const MAX_STRUCTURED_ITEMS = 24;

/**
 * `maxItems` is bound to the live `subAgent.maxTasks` value, so the schema itself enforces the current cap;
 * the description names the same cap so the model plans at most N tasks and splits the rest into later batches.
 */
function subAgentTasksDescription(advertisedMaxTasks: number): string {
	return `Independent exploration tasks to run in parallel; this call accepts at most ${advertisedMaxTasks} - split more directions into separate agent calls of at most ${advertisedMaxTasks} each, keeping every direction without merging or dropping. Emit it as a real JSON array, never a quoted string, and keep double quotes out of the task text so the surrounding JSON stays valid`;
}
const SUB_AGENT_BACKGROUND_DESCRIPTION =
	"Preferred. Run the Explore tasks in the background and keep working on independent steps while they run; results arrive automatically. Omit only when you have nothing else to do until the results are in.";

/** Description of the per-task `access` field (read-write mode only); shared with the workflow task schema. */
export const SUB_AGENT_ACCESS_DESCRIPTION =
	"read: investigation, review or research only; the task runs in a read-only copy and cannot change files. write: the task may edit files and run commands inside its own copy. Mark every task that does not need to change files as read. Default: write";

/** Description of the per-task `readPaths` field; shared with the workflow task schema. */
export const SUB_AGENT_READ_PATHS_DESCRIPTION =
	"Absolute paths of folders or files outside the sub-agent's own copy that it may read with read, grep, find, ls and symbols (for example logs, reports or data folders); they are read-only for the sub-agent and cannot be used from its shell";

/** Description of the per-task `questions` field; shared with the workflow task schema. */
export const SUB_AGENT_QUESTIONS_DESCRIPTION =
	"Specific questions to answer; the sub-agent hands in one status per question with its report (answered, partial, unavailable when the material cannot be reached, not_done), and any partial or not_done question returns the task as not complete";

/** The per-task `access` field of read-write mode; read-only mode has no such field (every task reads only). */
export function createSubAgentAccessSchema() {
	return Type.Optional(
		Type.Union([Type.Literal("read"), Type.Literal("write")], { description: SUB_AGENT_ACCESS_DESCRIPTION }),
	);
}

function subAgentTaskItemProperties(mode: SubAgentMode) {
	return {
		description: Type.String({
			description: "Short name for this independent exploration task",
		}),
		prompt: Type.String({
			description:
				mode === "read-write"
					? "Clearly describe the investigation scope and, for a write task, the changes the sub-agent should make; it edits only inside its own copy and never commits"
					: "Clearly describe the investigation scope and the expected findings to check; must not require modifying files",
		}),
		goal: Type.Optional(Type.String({ description: "The bounded question this task must answer" })),
		scope: Type.Optional(
			Type.Array(Type.String(), { description: "Files, modules, or runtime areas that are in scope" }),
		),
		questions: Type.Optional(
			Type.Array(Type.String(), {
				description: SUB_AGENT_QUESTIONS_DESCRIPTION,
			}),
		),
		expectedOutput: Type.Optional(Type.String({ description: "Expected evidence-oriented output" })),
		stopConditions: Type.Optional(
			Type.Array(Type.String(), { description: "Conditions for stopping the investigation" }),
		),
		readPaths: Type.Optional(Type.Array(Type.String(), { description: SUB_AGENT_READ_PATHS_DESCRIPTION })),
	};
}

function createSubAgentTaskItemSchema(mode: SubAgentMode) {
	// Read-only mode keeps the historical task shape; read-write adds the optional `access`. The static type is the
	// read-write superset either way.
	return mode === "read-write"
		? Type.Object({ ...subAgentTaskItemProperties(mode), access: createSubAgentAccessSchema() })
		: (Type.Object(subAgentTaskItemProperties(mode)) as unknown as ReturnType<typeof readWriteTaskItemSchema>);
}

function readWriteTaskItemSchema() {
	return Type.Object({ ...subAgentTaskItemProperties("read-write"), access: createSubAgentAccessSchema() });
}

function createSubAgentSchemaBody(mode: SubAgentMode, advertisedMaxTasks: number) {
	return {
		tasks: Type.Array(createSubAgentTaskItemSchema(mode), {
			description: subAgentTasksDescription(advertisedMaxTasks),
			minItems: 1,
			maxItems: advertisedMaxTasks,
		}),
		run_in_background: Type.Optional(Type.Boolean({ description: SUB_AGENT_BACKGROUND_DESCRIPTION })),
	};
}

// The read-write body is the superset (it adds the optional per-task `access`), so the static input type covers both.
const subAgentSchema = Type.Object(createSubAgentSchemaBody("read-write", SETTINGS_DEFAULTS.defaultSubAgentMaxTasks));

/**
 * The `tasks` array binds `maxItems` to the live `subAgent.maxTasks` value, while its description and the tool
 * prompt name the same cap, so a model never plans more tasks than the current setting in one call and instead
 * advances in batches. Field names and types are unchanged; only the cap value follows the setting.
 */
function createSubAgentSchema(mode: SubAgentMode, advertisedMaxTasks: number): typeof subAgentSchema {
	return Type.Object(createSubAgentSchemaBody(mode, advertisedMaxTasks)) as typeof subAgentSchema;
}

export type SubAgentToolInput = Static<typeof subAgentSchema>;
export type SubAgentTaskSpec = SubAgentToolInput["tasks"][number];

export function formatDelegatedTaskPrompt(task: SubAgentTaskSpec): string {
	const sections = [task.prompt];
	if (task.goal) sections.push(`Goal:\n${task.goal}`);
	if (task.scope?.length) sections.push(`Scope:\n${task.scope.map((item) => `- ${item}`).join("\n")}`);
	if (task.questions?.length) {
		sections.push(`Questions:\n${task.questions.map((item) => `- ${item}`).join("\n")}`);
		sections.push(
			"Report requirement: answer every question under Questions item by item in the final report, then hand the report in with submit_report, giving one entry per question in the same order with its status (answered, partial, unavailable, not_done). Use unavailable when you investigated but the material does not exist or cannot be reached, and say in note where you looked and what blocked you.",
		);
	}
	if (task.expectedOutput) sections.push(`Expected output:\n${task.expectedOutput}`);
	if (task.stopConditions?.length) {
		sections.push(`Stop conditions:\n${task.stopConditions.map((item) => `- ${item}`).join("\n")}`);
	}
	return sections.join("\n\n");
}

export interface ExploreReportCompleteness {
	complete: boolean;
	unanswered: string[];
	note: string;
	/** False when the report carries no checklist at all, so nothing about its questions could be read. */
	checklistFound?: boolean;
}

/**
 * The `unanswered:` line of a free-text checklist, in the wordings models actually write: `- unanswered: none`,
 * `**Unanswered questions:** None.`, `未回答：无`. Only read when a worker did not hand its report in with
 * `submit_report` (see `evaluateExploreReportCompleteness`).
 */
const UNANSWERED_LINE_PATTERN =
	/^\s*(?:[-*]\s*)?(?:\*\*)?(?:unanswered(?:\s+questions?)?|未回答(?:的?问题)?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/gim;
/**
 * A declaration that nothing is unanswered, optionally followed by a remark: `none`, `none (all four answered above)`,
 * `无（均已回答）`, `0`. The remark is commentary, never a list of questions.
 */
const NOTHING_UNANSWERED_PATTERN =
	/^(?:none|no|n\/a|nothing|nil|-+|0|无|没有|暂无|全部已?回答|均已回答)(?=$|[\s.。,，;；:：!！()（）[\]【】*_-])/i;

/**
 * Fallback for a report that was not handed in with `submit_report`: read the self-declared checklist at the end of
 * the text. This trusts only the sub-agent's own declaration: a missing checklist or any declared unanswered item
 * makes the task not complete, so the Main Agent sees exactly which questions still need work.
 */
export function evaluateExploreReportCompleteness(
	questions: readonly string[] | undefined,
	report: string,
): ExploreReportCompleteness {
	const required = (questions ?? []).map((item) => item.trim()).filter((item) => item !== "");
	if (required.length === 0) return { complete: true, unanswered: [], note: "", checklistFound: true };
	const declaredLines = [...report.matchAll(UNANSWERED_LINE_PATTERN)].map((match) => (match[1] ?? "").trim());
	if (declaredLines.length === 0) {
		return {
			complete: false,
			unanswered: required,
			note: `报告既没有用 submit_report 提交，也没有 Completion checklist 清单，无法确认 ${required.length} 个问题是否逐项回答。`,
			checklistFound: false,
		};
	}
	const unanswered = declaredLines
		.filter((chunk) => !NOTHING_UNANSWERED_PATTERN.test(chunk.replace(/^[-*\s]+/, "")))
		.flatMap((chunk) => chunk.split(/[;；]+/))
		.map((item) => item.replace(/^[-*\s]+/, "").trim())
		.filter((item) => item !== "" && !NOTHING_UNANSWERED_PATTERN.test(item));
	return unanswered.length === 0
		? { complete: true, unanswered: [], note: "", checklistFound: true }
		: {
				complete: false,
				unanswered,
				note: `子 Agent 在报告中声明以下问题未回答：${unanswered.join("；")}。`,
				checklistFound: true,
			};
}

/** One question of the task with the status the worker handed in (or the status the fallback could read). */
export type ExploreQuestionStatus = SubmittedQuestionStatus;

/** What a handed-in report means for its task: every question answered, some only unreachable, or not complete. */
export interface SubmittedReportVerdict {
	outcome: "complete" | "data_gaps" | "incomplete";
	statuses: ExploreQuestionStatus[];
	/** `question: note` of every question whose material could not be reached. */
	dataGaps: string[];
	/** `question: note` of every partial or not done question. */
	unfinished: string[];
}

function normalizeQuestionKey(value: string): string {
	return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Line a same-count submission up with the task's questions by position (the historical behavior). */
function alignSubmittedByPosition(
	required: readonly string[],
	submitted: readonly ExploreQuestionStatus[],
): ExploreQuestionStatus[] {
	return required.map((question, index) => ({ ...submitted[index], question }));
}

/**
 * Line the submitted statuses up with the task's questions. When the counts match and every submitted entry matches
 * exactly one required question by the normalized key (the worker may list them in another order), align by key;
 * anything else keeps the historical positional alignment.
 */
function alignSubmittedByQuestion(
	required: readonly string[],
	submitted: readonly ExploreQuestionStatus[],
): ExploreQuestionStatus[] {
	const byKey = new Map<string, ExploreQuestionStatus>();
	for (const entry of submitted) {
		const key = normalizeQuestionKey(entry.question);
		if (key === "" || byKey.has(key)) return alignSubmittedByPosition(required, submitted);
		byKey.set(key, entry);
	}
	// Two required questions that normalize to the same key cannot be told apart by text: keep the positions.
	const requiredKeys = required.map(normalizeQuestionKey);
	if (new Set(requiredKeys).size !== requiredKeys.length || !requiredKeys.every((key) => byKey.has(key))) {
		return alignSubmittedByPosition(required, submitted);
	}
	return required.map((question) => ({ ...byKey.get(normalizeQuestionKey(question))!, question }));
}

/**
 * Line the submitted statuses up with the task's questions: by position when the counts match (the tool already
 * enforces that), else by text. A question the submission does not cover counts as not done.
 */
export function evaluateSubmittedReport(
	questions: readonly string[] | undefined,
	submitted: readonly ExploreQuestionStatus[],
): SubmittedReportVerdict {
	const required = (questions ?? []).map((item) => item.trim()).filter((item) => item !== "");
	let statuses: ExploreQuestionStatus[];
	if (required.length === 0) statuses = [...submitted];
	else if (submitted.length === required.length) {
		statuses = alignSubmittedByQuestion(required, submitted);
	} else {
		const byKey = new Map(submitted.map((entry) => [normalizeQuestionKey(entry.question), entry]));
		statuses = required.map(
			(question) =>
				byKey.get(normalizeQuestionKey(question)) ?? {
					question,
					status: "not_done" as const,
					note: "提交的报告没有给出这个问题的状态",
				},
		);
		statuses = statuses.map((entry, index) => ({ ...entry, question: required[index] }));
	}
	const describe = (entry: ExploreQuestionStatus) =>
		entry.note ? `${entry.question}：${entry.note}` : entry.question;
	const dataGaps = statuses.filter((entry) => entry.status === "unavailable").map(describe);
	const unfinished = statuses
		.filter((entry) => entry.status === "partial" || entry.status === "not_done")
		.map(describe);
	return {
		outcome: unfinished.length > 0 ? "incomplete" : dataGaps.length > 0 ? "data_gaps" : "complete",
		statuses,
		dataGaps,
		unfinished,
	};
}

/** Chinese label of one handed-in question status, for the reports the Main Agent and the user read. */
export const QUESTION_STATUS_LABEL: Record<ReportQuestionStatus, string> = {
	answered: "已回答",
	partial: "部分回答",
	unavailable: "查过但资料拿不到",
	not_done: "没做",
};

/** The `submit_report` the worker's tool accepted last, read from the transcript; `undefined` when there is none. */
export function findSubmittedReport(messages: readonly Message[]):
	| {
			report: string;
			questions: ExploreQuestionStatus[];
			messageText: string;
			/** Text of the truncated reply the accepted reply continued, when it does (`continue_truncated`). */
			continuedText?: string;
	  }
	| undefined {
	let acceptedId: string | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === SUBMIT_REPORT_TOOL_NAME && !message.isError) {
			acceptedId = message.toolCallId;
		}
	}
	if (!acceptedId) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const call = message.content.find(
			(part): part is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
				part.type === "toolCall" && part.id === acceptedId,
		);
		if (!call) continue;
		const args = (call.arguments ?? {}) as Record<string, unknown>;
		let normalized: { report: string; questions: ExploreQuestionStatus[] };
		try {
			normalized = normalizeSubmittedReport(args, []);
		} catch {
			// The worker's own tool accepted this call; keep whatever entries carry a known status.
			const raw = Array.isArray(args.questions) ? (args.questions as Array<Record<string, unknown>>) : [];
			normalized = {
				report: typeof args.report === "string" ? args.report.trim() : "",
				questions: raw
					.filter((item) => (REPORT_QUESTION_STATUSES as readonly unknown[]).includes(item?.status))
					.map((item) => ({
						question: typeof item.question === "string" ? item.question : "",
						status: item.status as ReportQuestionStatus,
						...(typeof item.note === "string" && item.note.trim() ? { note: item.note.trim() } : {}),
					})),
			};
		}
		return { ...normalized, messageText: assistantText(message), ...continuedReportText(messages, index) };
	}
	return undefined;
}

/**
 * After a `continue_truncated` follow-up the reply that hands the report in only carries the tail: the head is the
 * earlier reply the output limit cut off. The two are one report, so the head text travels with the submission and
 * the dispatcher reads the merged whole (see the fullOutput assembly in `runExploreTask`).
 */
function continuedReportText(
	messages: readonly Message[],
	callMessageIndex: number,
): { continuedText?: string } | undefined {
	// Every earlier reply the output limit cut off while it was writing text (no tool call) is a piece of the report:
	// such a reply ends the run, so only a follow-up can come after it. Collect all of them back to the previous
	// complete text reply, skipping replies that only made tool calls in between (a check after the cut, for example),
	// so a report cut twice keeps every piece in order.
	const pieces: string[] = [];
	for (let index = callMessageIndex - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (assistantContainsToolCall(message)) continue;
		const text = assistantText(message);
		if (message.stopReason !== "length") {
			if (text !== "") break;
			continue;
		}
		if (text !== "") pieces.unshift(text);
	}
	return pieces.length > 0 ? { continuedText: pieces.join("\n") } : undefined;
}

export interface SubAgentRuntimeSettings {
	chatMode?: "coding" | "general";
	/** Sub-agent capability mode; anything other than "read-write" keeps the read-only runtime. */
	mode?: SubAgentMode;
	enabled: boolean;
	/**
	 * `codeIntelligence.symbolsEnabled` of the session that dispatches the workers. Off means the tool does
	 * not exist at all, so it is left out of the child's `--tools` list. `undefined` keeps the historical
	 * list (used by callers that have no settings manager).
	 */
	symbolsEnabled?: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Independent context cap forwarded to the child AgentSession. */
	contextWindow?: number;
	/**
	 * The extension file that registers the model's provider, when the model comes from an extension. A worker loads
	 * no extensions by itself, so without this file the model does not exist there (see worker-model.ts).
	 */
	providerExtensionPath?: string;
	/** Why no sub-agent can run on the configured model; a dispatch is refused with this text before anything starts. */
	unavailableReason?: string;
	/** Maximum wall-clock duration of one delegated Explore task; zero means no limit. */
	taskTimeoutMs?: number;
	/** Canonical name for the total wall-clock limit; taskTimeoutMs remains supported. */
	totalRuntimeLimitMs?: number;
	/** Maximum model/tool turns; zero means unlimited. */
	maxTurns?: number;
	/** Maximum Explore sub-agents one Agent tool call may start; clamped to 1–18 at runtime. */
	maxTasks?: number;
	/** Maximum time without meaningful progress; zero disables the watchdog. */
	stallTimeoutMs?: number;
	noProgressDetection?: boolean;
	repeatedOperationDetection?: boolean;
}

export type ResolvedSubAgentRuntimeSettings = Required<
	Pick<SubAgentRuntimeSettings, "provider" | "model" | "thinkingLevel">
> &
	Pick<
		SubAgentRuntimeSettings,
		| "mode"
		| "chatMode"
		| "maxTasks"
		| "symbolsEnabled"
		| "contextWindow"
		| "providerExtensionPath"
		| "taskTimeoutMs"
		| "totalRuntimeLimitMs"
		| "maxTurns"
		| "stallTimeoutMs"
		| "noProgressDetection"
		| "repeatedOperationDetection"
	>;

export interface SubAgentToolOptions {
	getSettings?: () => SubAgentRuntimeSettings;
	trace?: RuntimeTrace;
	getTraceParentScope?: () => RuntimeTraceScope | undefined;
	onBackgroundStarted?: (task: SubAgentBackgroundTask) => void;
	onBackgroundProgress?: (progress: SubAgentBackgroundProgress) => void;
	onBackgroundComplete?: (notification: SubAgentBackgroundNotification) => void | Promise<void>;
	/** Registers foreground batches with the session, which can stop them or move them to the background. */
	dispatch?: DispatchRegistrar;
}

export interface SubAgentBackgroundTask {
	batchId: string;
	cwd: string;
	tasks: SubAgentTaskSpec[];
	settings: ResolvedSubAgentRuntimeSettings;
	abort: () => void;
	promise: Promise<void>;
	/** The agent tool call that started the batch. */
	toolCallId?: string;
	/** Stop one task of the batch; the others keep running. */
	killTask?: (index: number) => void;
}

export interface SubAgentBackgroundProgress {
	batchId: string;
	details: SubAgentToolDetails;
}

export interface SubAgentToolTrace {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed";
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	errorType?: string;
	resultSummary?: string;
}

// Handing in the report is not investigation: a task that only called submit_report did no work.
const INVESTIGATION_TOOL_NAMES = new Set<string>(
	DELEGATED_TOOL_NAMES.filter((name) => name !== SUBMIT_REPORT_TOOL_NAME),
);
const INVESTIGATION_WRITE_TOOL_NAMES = new Set<string>(
	DELEGATED_WRITE_TOOL_NAMES.filter((name) => name !== SUBMIT_REPORT_TOOL_NAME),
);

/**
 * A delegated task counts as having done real work when its transcript shows a
 * successful tool call. In read-write mode the write tools are productive work
 * too; the read-only tool set is unchanged.
 */
export function hasSuccessfulInvestigationEvidence(
	transcript: readonly SubAgentToolTrace[],
	mode: SubAgentMode = "read-only",
): boolean {
	const allowed = mode === "read-write" ? INVESTIGATION_WRITE_TOOL_NAMES : INVESTIGATION_TOOL_NAMES;
	return transcript.some((entry) => entry.status === "completed" && allowed.has(entry.toolName.toLowerCase()));
}

export type ExploreTaskStatus = "running" | "completed" | "partial" | "failed" | "timeout" | "cancelled";

export type ExploreTaskStopReason =
	| "completed"
	| "max_turns_reached"
	| "stalled"
	| "incomplete_answer"
	/** The worker never handed its report in with submit_report and its text carries no readable checklist. */
	| "report_not_submitted"
	/** The output limit cut the reply off before any report text was written. */
	| "output_truncated"
	/** The worker ended without writing any report text. */
	| "no_report"
	| "context_budget"
	| "timeout"
	| "cancelled"
	| "provider_error"
	| "runtime_error"
	| "user_defined_limit";

export interface ExploreTaskTokenUsage {
	/** Provider-reported usage accumulated from each deduplicated assistant message. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ExploreTaskDiagnostics {
	repeatedOperations: number;
	consecutiveToolErrors: number;
	noProgressTurns: number;
	meaningfulProgressCount: number;
	lastMeaningfulProgressAt?: string;
	lastMeaningfulProgress?: string;
}

export interface ExploreTaskContextTelemetry {
	activeTokens?: number;
	effectiveWindow?: number;
	budgetLimit?: number;
	percent?: number;
	compactions: number;
	lastCompactionReason?: string;
	lastCompactionStatus?: string;
}

export interface ExploreTaskResult {
	description: string;
	prompt: string;
	status: ExploreTaskStatus;
	output: string;
	error?: string;
	model?: string;
	toolUseCount: number;
	/** Sum of input + output + cacheRead + cacheWrite; this is not a current-context estimate. */
	tokens: number;
	tokenUsage?: ExploreTaskTokenUsage;
	turnCount?: number;
	durationMs?: number;
	lastToolInfo?: string;
	lastMeaningfulProgress?: string;
	lastMeaningfulProgressAt?: string;
	stopReason?: ExploreTaskStopReason;
	goal?: string;
	coveredScope?: string[];
	findings?: string[];
	evidence?: string[];
	conflicts?: string[];
	unresolved?: string[];
	recommendedNextInvestigation?: string[];
	diagnostics?: ExploreTaskDiagnostics;
	contextTelemetry?: ExploreTaskContextTelemetry;
	/**
	 * How the report reached the dispatcher: `tool` through `submit_report`; `text` when the worker never handed it in
	 * and its reply text was read instead (shown as "没按格式提交").
	 */
	reportSubmission?: "tool" | "text";
	/** One status per question of the task, as handed in (or as the text fallback could read it). */
	questionStatuses?: ExploreQuestionStatus[];
	/**
	 * Questions investigated whose material could not be reached (`question: note`). A completed task with entries here
	 * is "complete with data gaps": not a failure, but the Main Agent must know what is missing.
	 */
	dataGaps?: string[];
	/** `read` tasks ran in a read-only copy; `write` tasks could edit inside their own copy. */
	access?: "read" | "write";
	/** The copy (worktree or file mirror of the pool) the task ran in. */
	worktreePath?: string;
	branchName?: string;
	changedFiles?: string[];
	transcript: SubAgentToolTrace[];
	taskId?: string;
	runId?: string;
	parentRunId?: string;
	agentId?: string;
	phaseId?: string;
	workflowRunId?: string;
	/** Internal-only original report. It is deliberately non-enumerable. */
	fullOutput?: string;
}

export interface SubAgentToolDetails {
	completed: number;
	total: number;
	results: ExploreTaskResult[];
	/** Results that can be consumed by a parent: completed plus useful partial results. */
	usable?: number;
	findings?: number;
	model?: string;
	background?: boolean;
	batchId?: string;
}

export interface SubAgentBackgroundNotification {
	batchId: string;
	status: "completed" | "partial" | "failed";
	text: string;
	fullText?: string;
	details?: SubAgentToolDetails;
}

export class SubAgentTaskTimeoutError extends Error {
	readonly code = "SUB_AGENT_TIMEOUT";
	readonly stopReason = "timeout" as const;
	readonly details: { timeoutMs: number };

	constructor(timeoutMs: number) {
		super(`Sub-agent task timed out after ${Math.round(timeoutMs / 1_000)} seconds`);
		this.name = "SubAgentTaskTimeoutError";
		this.details = { timeoutMs };
	}
}

/**
 * Hard convergence stops are limited to genuine non-progress: the stall
 * watchdog, the explicit turn cap, wall-clock timeouts, and cancellation.
 * Repeated operations / consecutive tool failures / idle turns only inject
 * steering reminders into the running child and never terminate it by count.
 */
class SubAgentConvergenceStopError extends Error {
	readonly code = "SUB_AGENT_CONVERGENCE_STOP";
	readonly stopReason: Extract<ExploreTaskStopReason, "max_turns_reached" | "stalled">;

	constructor(stopReason: SubAgentConvergenceStopError["stopReason"], message: string) {
		super(message);
		this.name = "SubAgentConvergenceStopError";
		this.stopReason = stopReason;
	}
}

export function resolvedTaskTimeoutMs(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0
		? Math.floor(value)
		: DEFAULT_SUB_AGENT_TASK_TIMEOUT_MS;
}

export function resolvedSubAgentMaxTurns(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : DEFAULT_SUB_AGENT_MAX_TURNS;
}

export function resolvedSubAgentStallTimeoutMs(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value >= 0
		? Math.floor(value)
		: DEFAULT_SUB_AGENT_STALL_TIMEOUT_MS;
}

/** Explore sub-agents one Agent call may start: the configured `subAgent.maxTasks`, clamped to 1–18 (default 3). */
export function resolveExploreMaxTasks(settings?: { maxTasks?: number } | undefined): number {
	const value = settings?.maxTasks;
	if (!Number.isFinite(value) || value === undefined) return SETTINGS_DEFAULTS.defaultSubAgentMaxTasks;
	const { min, max } = SUB_AGENT_SETTING_RANGES.maxTasks;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function resolvedBoolean(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

function resolveTotalRuntimeLimit(settings: SubAgentRuntimeSettings): number {
	return resolvedTaskTimeoutMs(settings.totalRuntimeLimitMs ?? settings.taskTimeoutMs);
}

export function resolveSubAgentRuntimeSettings(
	settings: SubAgentRuntimeSettings & { enabled?: boolean },
): ResolvedSubAgentRuntimeSettings {
	const totalRuntimeLimitMs = resolveTotalRuntimeLimit(settings);
	return {
		mode: settings.mode === "read-write" ? "read-write" : "read-only",
		chatMode: settings.chatMode,
		// The pool keeps at least this many copies ready (see agent/delegation/copy-pool.ts).
		maxTasks: resolveExploreMaxTasks(settings),
		symbolsEnabled: settings.symbolsEnabled,
		provider: settings.provider ?? "",
		model: settings.model ?? "",
		thinkingLevel: settings.thinkingLevel ?? "off",
		contextWindow: settings.contextWindow,
		providerExtensionPath: settings.providerExtensionPath,
		taskTimeoutMs: totalRuntimeLimitMs,
		totalRuntimeLimitMs,
		maxTurns: resolvedSubAgentMaxTurns(settings.maxTurns),
		stallTimeoutMs: resolvedSubAgentStallTimeoutMs(settings.stallTimeoutMs),
		noProgressDetection: resolvedBoolean(settings.noProgressDetection, DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION),
		repeatedOperationDetection: resolvedBoolean(
			settings.repeatedOperationDetection,
			DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION,
		),
	};
}

function waitForProcessStop(pid: number | undefined): Promise<boolean> {
	if (!pid) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (confirmed: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(confirmed);
		};
		timer = setTimeout(() => finish(false), SUB_AGENT_STOP_TIMEOUT_MS);
		void killProcessTreeAndWait(pid, SUB_AGENT_STOP_TIMEOUT_MS).then(finish, () => finish(false));
	});
}

const EXPLORE_SYSTEM_PROMPT = loadSystemPrompt("roles/explore.md");
const EXPLORE_WRITE_SYSTEM_PROMPT = loadSystemPrompt("roles/explore-write.md");

/**
 * Marker of the free-text checklist section: the legacy fallback parser reads it (and only it) when a worker never
 * handed its report in with `submit_report`. A handed-in report does not carry it.
 */
const COMPLETION_CHECKLIST_PATTERN = /^#{1,6}\s*Completion checklist\s*$/im;
/** Text longer than this is never a lone acknowledgement: real acknowledgements are short sign-offs. */
const ACKNOWLEDGEMENT_MAX_LENGTH = 200;
const ACKNOWLEDGEMENT_PUNCT_OR_SPACE_PATTERN = /[。.!！,，、~～—\-_\s]+/y;
const ACKNOWLEDGEMENT_WORD_PATTERN =
	/(?:好的|收到|明白|了解|没问题|嗯|行|知道了|谢谢|ok(?:ay)?|got\s+it|yes|thanks|thank\s+you|thx|acknowledged|sure|roger)/iy;

/**
 * A turn that is nothing but an acknowledgement of a steering reminder carries no report content.
 * Checks linearly without backtracking, capped at 200 characters.
 */
function isAcknowledgementOnly(text: string): boolean {
	if (text.length > ACKNOWLEDGEMENT_MAX_LENGTH) return false;

	let index = 0;
	let wordCount = 0;
	const len = text.length;

	while (index < len) {
		ACKNOWLEDGEMENT_PUNCT_OR_SPACE_PATTERN.lastIndex = index;
		const punctMatch = ACKNOWLEDGEMENT_PUNCT_OR_SPACE_PATTERN.exec(text);
		if (punctMatch) {
			index = ACKNOWLEDGEMENT_PUNCT_OR_SPACE_PATTERN.lastIndex;
			if (index >= len) break;
		}

		ACKNOWLEDGEMENT_WORD_PATTERN.lastIndex = index;
		const wordMatch = ACKNOWLEDGEMENT_WORD_PATTERN.exec(text);
		if (!wordMatch) {
			return false;
		}
		index = ACKNOWLEDGEMENT_WORD_PATTERN.lastIndex;
		wordCount++;
	}

	return wordCount > 0;
}

/** A turn that is nothing but an acknowledgement of a steering reminder carries no report content. */
const ACKNOWLEDGEMENT_ONLY_PATTERN = {
	test(text: string): boolean {
		return isAcknowledgementOnly(text);
	},
};
/** Below this many UTF-8 bytes a tool-call-free turn reads as a remark rather than as a report body. */
const REPORT_CANDIDATE_MIN_BYTES = REPORT_TEXT_MIN_BYTES;
/** A short closing turn only loses to an earlier turn that carries this multiple of its content. */
const REPORT_DOMINANCE_RATIO = 8;
const REPORT_SHORT_CLOSING_BYTES = 512;

function reportCandidateBytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** A candidate that is an acknowledgement or too short to be the report the Main Agent asked for. */
function isRemarkLikeCandidate(text: string): boolean {
	return ACKNOWLEDGEMENT_ONLY_PATTERN.test(text) || reportCandidateBytes(text) < REPORT_CANDIDATE_MIN_BYTES;
}

/** The free-text checklist tail the legacy fallback parser looks for at the end of an unsubmitted report. */
function hasCompletionChecklist(text: string): boolean {
	return COMPLETION_CHECKLIST_PATTERN.test(text);
}

/**
 * Pick the report among the tool-call-free assistant turns that carry text (newest last). The newest turn normally
 * wins - it is the final answer - but a trailing turn must never erase the report above it when it only
 * acknowledges a steering reminder ("好的，收到") or is a short sign-off while an earlier turn carries the real
 * report. A free-text `## Completion checklist` is the strongest report signal for the legacy fallback parser (a
 * report handed in with `submit_report` does not carry one); a missing checklist stays the
 * report's own problem, because `evaluateExploreReportCompleteness` still decides the partial / `incomplete_answer`
 * verdict from whichever text this function selects. These rules only choose the text, never the verdict.
 */
export function pickReportCandidate(candidates: readonly string[]): string {
	if (candidates.length === 0) return "";
	const newest = candidates[candidates.length - 1];
	// A trailing turn with the checklist is the real final report: it wins outright.
	if (candidates.length === 1 || hasCompletionChecklist(newest)) return newest;

	// Nothing but an acknowledgement: it carries no report, so hand back the newest earlier turn that does.
	if (ACKNOWLEDGEMENT_ONLY_PATTERN.test(newest)) {
		for (let index = candidates.length - 2; index >= 0; index--) {
			if (hasCompletionChecklist(candidates[index])) return candidates[index];
		}
		for (let index = candidates.length - 2; index >= 0; index--) {
			if (!isRemarkLikeCandidate(candidates[index])) return candidates[index];
		}
		return candidates[candidates.length - 2];
	}

	// A short closing sign-off loses to the checklist report above it (tasks without Questions never match here,
	// because no turn declares a checklist and the newest turn keeps its historical priority).
	if (reportCandidateBytes(newest) <= REPORT_SHORT_CLOSING_BYTES) {
		for (let index = candidates.length - 2; index >= 0; index--) {
			const candidate = candidates[index];
			if (!hasCompletionChecklist(candidate)) continue;
			if (reportCandidateBytes(candidate) < REPORT_DOMINANCE_RATIO * reportCandidateBytes(newest)) continue;
			return candidate;
		}
	}
	return newest;
}

/**
 * The task report is the last assistant message that carries no tool call: a message with a tool call is a remark
 * made in the middle of the run, never the final answer. The delegated worker repeats every message in its closing
 * `agent_end` event, so a copy of such a remark can arrive after the real report and must not replace it. A trailing
 * tool-call-free message with empty text (for example a thinking-only turn after a steering reminder) must not erase
 * the real report either, so empty candidates are skipped, not adopted. Only when no assistant message carries usable
 * text at all does the last one stand in.
 */
export function getFinalAssistantText(messages: readonly Message[]): string {
	let lastAssistant: Message | undefined;
	const candidates: string[] = [];
	// A reply the output limit cut off is continued by the next reply (report-follow-up.ts): the two are one report.
	let continuesPrevious = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		lastAssistant = message;
		if (assistantContainsToolCall(message)) {
			continuesPrevious = false;
			continue;
		}
		const text = assistantText(message);
		if (text !== "") {
			if (continuesPrevious && candidates.length > 0) candidates[candidates.length - 1] += text;
			else candidates.push(text);
		}
		continuesPrevious = text !== "" && message.stopReason === "length";
	}
	if (candidates.length > 0) return pickReportCandidate(candidates);
	return lastAssistant ? assistantText(lastAssistant) : "";
}

/**
 * The reasoning the worker's last replies produced, for a task that ended without report text: the user decided such a
 * task is reported as failed together with what the model was thinking. Only replies after the last tool result count
 * (that is where the report should have been). Providers that return no reasoning text, or only an encrypted or
 * redacted form, leave nothing to show; the caller says so.
 */
export function collectFinalReasoning(messages: readonly Message[], maxBytes = 12 * 1024): string {
	const parts: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "toolResult") {
			// The trailing submit_report result only ends the run; the reasoning written just before handing it in is
			// still the last thing the model produced, so skip it and keep scanning.
			if (message.toolName === SUBMIT_REPORT_TOOL_NAME) continue;
			break;
		}
		if (message.role !== "assistant") continue;
		const thinking = message.content
			.filter(
				(part): part is Extract<(typeof message.content)[number], { type: "thinking" }> => part.type === "thinking",
			)
			.filter((part) => !part.redacted && typeof part.thinking === "string" && part.thinking.trim() !== "")
			.map((part) => part.thinking.trim())
			.join("\n\n");
		if (thinking) parts.unshift(thinking);
	}
	const text = parts.join("\n\n---\n\n");
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	// Keep the end: it is the part closest to the report that was never written.
	const buffer = Buffer.from(text, "utf8");
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
	return `[前面部分已省略]\n${buffer.subarray(start).toString("utf8")}`;
}

/** Stop reason of the worker's last reply, or `undefined` when it wrote none. */
function lastAssistantStopReason(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message.stopReason;
	}
	return undefined;
}

/** Keep the head of a string within `maxBytes` without ever cutting inside a UTF-8 codepoint. */
function sliceUtf8Head(content: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(content, "utf8");
	if (buffer.length <= maxBytes) return content;
	let end = maxBytes;
	// 0b10xxxxxx marks a continuation byte: step back until the slice ends on a codepoint boundary.
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

/**
 * Head truncation that never blanks out a non-empty input. `truncateHead` drops the whole content when the first
 * line alone exceeds `maxBytes` (`firstLineExceedsLimit`), which used to erase the report body silently. Fall back
 * to a UTF-8-safe byte slice of the head plus an explicit truncation marker, sized so the result stays within the
 * same `maxBytes` budget the main Agent already assumes.
 */
export function truncateHeadKeepingContent(content: string, options: { maxBytes: number; maxLines: number }): string {
	if (content === "") return "";
	const result = truncateHead(content, options);
	if (result.content !== "") return result.content;
	// The first line alone is over the byte cap: slice raw bytes and say so, keeping the total under the cap.
	const marker = `\n\n[正文首行超过 ${Math.floor(options.maxBytes / 1024)}KB 显示上限，已按字节截断；完整正文见落盘文件]`;
	const partial = sliceUtf8Head(content, Math.max(0, options.maxBytes - Buffer.byteLength(marker, "utf8")));
	return `${partial}${marker}`;
}

export function truncateSubAgentOutput(output: string): string {
	return truncateHeadKeepingContent(output, { maxBytes: PER_TASK_OUTPUT_CAP, maxLines: 500 });
}

function truncateDisplay(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatPathForDisplay(value: unknown, cwd: string): string {
	if (typeof value !== "string" || value === "") return ".";
	const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
	const relative = path.relative(cwd, absolute);
	const display = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
	return truncateDisplay(display.replace(/\\/g, "/"), 72);
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `Read(${formatPathForDisplay(args.path ?? args.file_path, cwd)})`;
	if (normalized === "grep") {
		return `Search(pattern: ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))})`;
	}
	if (normalized === "find") {
		return `Find(pattern: ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))})`;
	}
	if (normalized === "ls") return `List(${formatPathForDisplay(args.path, cwd)})`;
	if (normalized === "bash") return `Bash(${truncateDisplay(String(args.command ?? "…"), 72)})`;
	return `${toolName}()`;
}

function formatRunningTool(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `正在读取 ${formatPathForDisplay(args.path ?? args.file_path, cwd)}`;
	if (normalized === "grep") return `正在搜索 ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))}`;
	if (normalized === "find") return `正在查找 ${JSON.stringify(truncateDisplay(String(args.pattern ?? ""), 48))}`;
	if (normalized === "ls") return `正在列出 ${formatPathForDisplay(args.path, cwd)}`;
	if (normalized === "bash") return `正在执行 ${truncateDisplay(String(args.command ?? "…"), 72)}`;
	return `正在执行 ${toolName}`;
}

function getToolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function summarizeToolResult(toolName: string, result: unknown, isError: boolean): string {
	// The model-only guidance block would otherwise become the "error" line of a sub-agent trace.
	const text = stripModelGuidance(getToolResultText(result));
	const lines = text === "" ? [] : text.split("\n").filter((line) => line.trim() !== "");
	if (isError) return truncateDisplay(lines.at(-1)?.trim() || "执行失败", 100);
	const normalized = toolName.toLowerCase();
	if (normalized === "read") return `已读取 ${lines.length} 行`;
	if (normalized === "grep") return `找到 ${lines.length} 个匹配项`;
	if (normalized === "find") return `找到 ${lines.length} 个文件`;
	if (normalized === "ls") return `列出 ${lines.length} 个条目`;
	if (normalized === "bash") return truncateDisplay(lines.at(-1)?.trim() || "执行完成", 100);
	return truncateDisplay(lines[0]?.trim() || "执行完成", 100);
}

function reconcileMessageToolEvidence(result: ExploreTaskResult, messages: readonly Message[], cwd: string): void {
	for (const evidence of extractDelegatedMessageToolEvidence(messages)) {
		const trace = result.transcript.find((entry) => entry.toolCallId === evidence.toolCallId);
		const resultSummary = summarizeToolResult(evidence.toolName, evidence.result, evidence.isError);
		if (trace) {
			if (Object.keys(trace.args).length === 0) trace.args = evidence.args;
			if (trace.status === "running") trace.status = evidence.isError ? "failed" : "completed";
			trace.resultSummary ??= resultSummary;
			continue;
		}

		result.toolUseCount += 1;
		result.transcript.push({
			toolCallId: evidence.toolCallId,
			toolName: evidence.toolName,
			args: evidence.args,
			status: evidence.isError ? "failed" : "completed",
			resultSummary,
		});
		result.lastToolInfo = formatToolCall(evidence.toolName, evidence.args, cwd);
	}
}

function getMessageTokens(message: Message): number {
	const usage = getMessageTokenUsage(message);
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getMessageTokenUsage(message: Message): ExploreTaskTokenUsage {
	if (message.role !== "assistant" || !message.usage) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	return {
		input: message.usage.input ?? 0,
		output: message.usage.output ?? 0,
		cacheRead: message.usage.cacheRead ?? 0,
		cacheWrite: message.usage.cacheWrite ?? 0,
	};
}

function addTokenUsage(target: ExploreTaskTokenUsage, addition: ExploreTaskTokenUsage): void {
	target.input += addition.input;
	target.output += addition.output;
	target.cacheRead += addition.cacheRead;
	target.cacheWrite += addition.cacheWrite;
}

function stableStringify(value: unknown): string {
	try {
		return (
			JSON.stringify(value, (_key, item: unknown) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return item;
				return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
			}) ?? String(value)
		);
	} catch {
		return String(value);
	}
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function toolScopeKey(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "read") {
		return `read:${formatPathForDisplay(args.path ?? args.file_path, cwd)}:${String(args.offset ?? 0)}:${String(args.limit ?? "")}`;
	}
	if (normalized === "grep" || normalized === "find") {
		return `${normalized}:${String(args.pattern ?? "")}:${formatPathForDisplay(args.path, cwd)}:${String(args.glob ?? "")}`;
	}
	if (normalized === "ls") return `ls:${formatPathForDisplay(args.path, cwd)}`;
	if (normalized === "symbols") {
		return `symbols:${String(args.operation ?? "")}:${formatPathForDisplay(args.path, cwd)}`;
	}
	if (normalized === "bash") return `bash:${String(args.command ?? "")}`;
	return `${normalized}:${stableStringify(args)}`;
}

function pushUniqueLimited(target: string[] | undefined, value: string, limit = MAX_STRUCTURED_ITEMS): string[] {
	const result = target ?? [];
	const normalized = value.trim();
	if (!normalized || result.includes(normalized)) return result;
	result.push(truncateDisplay(normalized, 600));
	if (result.length > limit) result.splice(0, result.length - limit);
	return result;
}

function assistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function assistantContainsToolCall(message: Message): boolean {
	return message.role === "assistant" && message.content.some((part) => part.type === "toolCall");
}

function collectAssistantFinding(result: ExploreTaskResult, message: Message): void {
	if (assistantContainsToolCall(message)) return;
	const text = assistantText(message);
	if (!text) return;
	result.findings ??= [];
	result.conflicts ??= [];
	for (const line of text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-8)) {
		pushUniqueLimited(result.findings, line, 12);
		if (/冲突|conflict|contradict/i.test(line)) pushUniqueLimited(result.conflicts, line, 8);
	}
}

function applyContextBudgetTelemetry(result: ExploreTaskResult, budget: unknown, reason?: string): void {
	if (!budget || typeof budget !== "object") return;
	const value = budget as Record<string, unknown>;
	const current = result.contextTelemetry ?? { compactions: 0 };
	for (const key of ["activeTokens", "effectiveWindow", "budgetLimit", "percent"] as const) {
		const candidate = value[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) current[key] = candidate;
	}
	if (reason) current.lastCompactionReason = reason;
	result.contextTelemetry = current;
}

function cloneExploreTaskResult(result: ExploreTaskResult): ExploreTaskResult {
	return {
		...result,
		transcript: result.transcript.map((entry) => ({ ...entry, args: { ...entry.args } })),
		coveredScope: result.coveredScope ? [...result.coveredScope] : undefined,
		findings: result.findings ? [...result.findings] : undefined,
		evidence: result.evidence ? [...result.evidence] : undefined,
		conflicts: result.conflicts ? [...result.conflicts] : undefined,
		unresolved: result.unresolved ? [...result.unresolved] : undefined,
		changedFiles: result.changedFiles ? [...result.changedFiles] : undefined,
		questionStatuses: result.questionStatuses?.map((entry) => ({ ...entry })),
		dataGaps: result.dataGaps ? [...result.dataGaps] : undefined,
		recommendedNextInvestigation: result.recommendedNextInvestigation
			? [...result.recommendedNextInvestigation]
			: undefined,
		tokenUsage: result.tokenUsage ? { ...result.tokenUsage } : undefined,
		diagnostics: result.diagnostics ? { ...result.diagnostics } : undefined,
		contextTelemetry: result.contextTelemetry ? { ...result.contextTelemetry } : undefined,
	};
}

function formatProgress(details: SubAgentToolDetails): string {
	const running = details.results.filter((result) => result.status === "running").length;
	const active = details.results.find((result) => result.status === "running" && result.lastToolInfo);
	const activeText = active ? ` · ${active.description}: ${active.lastToolInfo}` : "";
	const usableText = details.usable !== undefined ? `，${details.usable} 个可供主 Agent 使用` : "";
	return `Explore：${details.completed}/${details.total} 已完成${usableText}，${running} 个正在运行${activeText}`;
}

function formatItems(label: string, items: readonly string[] | undefined): string {
	if (!items || items.length === 0) return `${label}: 无\n`;
	return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function formatTaskReport(result: ExploreTaskResult, full = false): string {
	const status = result.status;
	const body =
		result.output ||
		(status === "failed" || status === "timeout" || status === "cancelled"
			? (result.error ?? "Unknown sub-agent error")
			: "");
	const visibleBody = full ? body : truncateHeadKeepingContent(body, { maxBytes: 6 * 1024, maxLines: 160 });
	const diagnostics = result.diagnostics
		? `诊断：重复操作 ${result.diagnostics.repeatedOperations} 次，连续工具错误 ${result.diagnostics.consecutiveToolErrors} 次，无进展轮次 ${result.diagnostics.noProgressTurns} 次\n`
		: "";
	const verdictNote =
		status === "completed" && result.dataGaps?.length
			? "（完成，有资料缺口）"
			: result.reportSubmission === "text"
				? "（没按格式提交，按正文解析）"
				: "";
	const copyLabel = result.access === "read" ? "只读副本" : "读写副本";
	return [
		`### [${result.description}] ${status}${result.stopReason ? ` · ${result.stopReason}` : ""}${verdictNote}`,
		`目标：${full ? (result.goal ?? result.prompt) : truncateDisplay(result.goal ?? result.prompt, 1_200)}`,
		`工具调用：${result.toolUseCount} · turns：${result.turnCount ?? 0} · tokens：${result.tokens}`,
		result.worktreePath
			? `${copyLabel}：${result.worktreePath}${result.branchName ? `（分支 ${result.branchName}）` : ""}`
			: "",
		result.changedFiles?.length ? formatItems("改动文件", result.changedFiles) : "",
		result.questionStatuses?.length
			? formatItems(
					"问题状态",
					result.questionStatuses.map(
						(entry) =>
							`${QUESTION_STATUS_LABEL[entry.status]}：${entry.question}${entry.note ? `（${entry.note}）` : ""}`,
					),
				)
			: "",
		result.dataGaps?.length ? formatItems("资料缺口（查过但拿不到，不算失败）", result.dataGaps) : "",
		result.lastMeaningfulProgress ? `最近有效进展：${result.lastMeaningfulProgress}` : "",
		formatItems("已覆盖范围", result.coveredScope),
		formatItems("已知发现", result.findings),
		formatItems("证据", result.evidence),
		formatItems("冲突", result.conflicts),
		formatItems("未解决", result.unresolved),
		formatItems("建议后续调查", result.recommendedNextInvestigation),
		diagnostics,
		visibleBody ? `报告：\n${visibleBody}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatFinalResult(results: ExploreTaskResult[], full = false): string {
	const completed = results.filter((result) => result.status === "completed").length;
	const partial = results.filter((result) => result.status === "partial").length;
	const covered = [...new Set(results.flatMap((result) => result.coveredScope ?? []))].slice(0, MAX_STRUCTURED_ITEMS);
	const unresolved = [...new Set(results.flatMap((result) => result.unresolved ?? []))].slice(0, MAX_STRUCTURED_ITEMS);
	const withGaps = results.filter((result) => result.status === "completed" && result.dataGaps?.length).length;
	const notSubmitted = results.filter((result) => result.reportSubmission === "text").length;
	const sections = results.map((result) => formatTaskReport(result, full));
	const formatted = [
		`Explore：${completed}/${results.length} 个任务完成${withGaps ? `（其中 ${withGaps} 个有资料缺口）` : ""}，${partial} 个保留部分结果${notSubmitted ? `，${notSubmitted} 个没按格式提交` : ""}`,
		formatItems("Covered Scope", covered),
		formatItems("Unresolved Scope", unresolved),
		sections.join("\n\n---\n\n"),
	].join("\n\n");
	return full ? formatted : truncateHeadKeepingContent(formatted, { maxBytes: 48 * 1024, maxLines: 1_200 });
}

function collectTranscriptEvidence(result: ExploreTaskResult, cwd: string): void {
	result.coveredScope ??= [];
	result.evidence ??= [];
	for (const trace of result.transcript) {
		if (trace.status !== "completed") continue;
		pushUniqueLimited(result.coveredScope, formatToolCall(trace.toolName, trace.args, cwd));
		pushUniqueLimited(
			result.evidence,
			`${formatToolCall(trace.toolName, trace.args, cwd)}：${trace.resultSummary ?? "执行完成"}`,
		);
	}
}

function hasUsefulResult(result: ExploreTaskResult, mode: SubAgentMode = "read-only"): boolean {
	return (
		hasSuccessfulInvestigationEvidence(result.transcript, mode) ||
		Boolean(result.evidence?.length || result.findings?.length)
	);
}

function partialTaskSummary(result: ExploreTaskResult): string {
	const next = result.recommendedNextInvestigation?.length
		? result.recommendedNextInvestigation.map((item) => `- ${item}`).join("\n")
		: "- 针对未覆盖范围进行定向补查";
	const summary = [
		`状态：${result.status}`,
		`停止原因：${result.stopReason ?? "runtime_error"}`,
		`目标：${result.goal ?? result.prompt}`,
		formatItems("已覆盖范围", result.coveredScope),
		formatItems("已知发现", result.findings),
		formatItems("证据", result.evidence),
		formatItems("冲突", result.conflicts),
		formatItems("未解决", result.unresolved),
		`建议后续调查：\n${next}`,
		result.diagnostics
			? `诊断：重复操作 ${result.diagnostics.repeatedOperations} 次；连续工具错误 ${result.diagnostics.consecutiveToolErrors} 次；无进展轮次 ${result.diagnostics.noProgressTurns} 次`
			: "",
		result.error ? `运行时信息：${result.error}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return truncateSubAgentOutput(
		summary.length > PARTIAL_SUMMARY_CAP ? summary.slice(0, PARTIAL_SUMMARY_CAP) : summary,
	);
}

function finalizePartialResult(
	result: ExploreTaskResult,
	stopReason: ExploreTaskStopReason,
	error: string | undefined,
	cwd: string,
	rawOutput?: string,
): void {
	collectTranscriptEvidence(result, cwd);
	result.stopReason = stopReason;
	result.error = error;
	result.goal ??= result.prompt;
	result.coveredScope ??= [];
	result.findings ??= [];
	result.unresolved ??= [];
	if (error) pushUniqueLimited(result.unresolved, error);
	pushUniqueLimited(result.unresolved, "任务在完成完整调查前停止，未覆盖范围不能视为已确认");
	result.recommendedNextInvestigation ??= [];
	pushUniqueLimited(result.recommendedNextInvestigation, "针对未覆盖范围进行定向补查");
	result.output = partialTaskSummary(result);
	Object.defineProperty(result, "fullOutput", {
		value: rawOutput ? `${result.output}\n\n原始模型输出：\n${rawOutput}` : result.output,
		enumerable: false,
		configurable: true,
	});
}

function stopReasonForError(error: unknown): ExploreTaskStopReason {
	if (error instanceof SubAgentTaskTimeoutError) return "timeout";
	if (error instanceof SubAgentConvergenceStopError) return error.stopReason;
	return "runtime_error";
}

function classifyChildFailure(errorMessage: string, hasProviderError: boolean): ExploreTaskStopReason {
	if (
		/context|context window|token budget|maximum context|too many tokens|上下文|上下文窗口|token 上限/i.test(
			errorMessage,
		)
	) {
		return "context_budget";
	}
	return hasProviderError ? "provider_error" : "runtime_error";
}

async function runExploreTask(options: {
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	contextWindow?: number;
	providerExtensionPath?: string;
	taskTimeoutMs?: number;
	totalRuntimeLimitMs?: number;
	maxTurns?: number;
	stallTimeoutMs?: number;
	noProgressDetection?: boolean;
	repeatedOperationDetection?: boolean;
	description: string;
	prompt: string;
	goal?: string;
	questions?: string[];
	systemPromptPath: string;
	guardPath: string;
	signal?: AbortSignal;
	onProgress?: (result: ExploreTaskResult) => void;
	chatMode?: "coding" | "general";
	/** Capability mode of this task; "read-write" workers run in their own worktree. */
	mode?: SubAgentMode;
	/** `codeIntelligence.symbolsEnabled` of the dispatching session; false keeps symbols out of `--tools`. */
	symbolsEnabled?: boolean;
	traceContext?: RuntimeTraceChildContext;
	/** Non-Git fallback: original workspace the sandbox worker may read (read-only). */
	sandboxOrigin?: string;
	sandboxHandle?: DelegatedSandboxHandle;
	/** Absolute paths outside the copy this task may read with the read-only file tools (see delegated-write-guard.ts). */
	readRoots?: string[];
}): Promise<ExploreTaskResult> {
	const eventState = createDelegatedEventState();
	const messages = eventState.messages;
	const startedAt = Date.now();
	const currentResult: ExploreTaskResult = {
		description: options.description,
		prompt: options.prompt,
		status: "running",
		output: "",
		model: options.model,
		toolUseCount: 0,
		tokens: 0,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		turnCount: 0,
		lastToolInfo: "初始化中…",
		goal: options.goal ?? options.prompt,
		coveredScope: [],
		findings: [],
		evidence: [],
		conflicts: [],
		unresolved: [],
		recommendedNextInvestigation: [],
		diagnostics: {
			repeatedOperations: 0,
			consecutiveToolErrors: 0,
			noProgressTurns: 0,
			meaningfulProgressCount: 0,
		},
		contextTelemetry: { compactions: 0 },
		transcript: [],
		...(options.traceContext
			? {
					taskId: options.traceContext.taskId,
					runId: options.traceContext.runId,
					parentRunId: options.traceContext.parentRunId,
					agentId: options.traceContext.agentId,
					phaseId: options.traceContext.phaseId,
					workflowRunId: options.traceContext.workflowRunId,
				}
			: {}),
	};
	const emitProgress = () => options.onProgress?.(cloneExploreTaskResult(currentResult));
	let stderr = "";
	const args = buildSubAgentArgs(options);
	emitProgress();

	const taskTimeoutMs = resolvedTaskTimeoutMs(options.totalRuntimeLimitMs ?? options.taskTimeoutMs);
	const maxTurns = resolvedSubAgentMaxTurns(options.maxTurns);
	const stallTimeoutMs = resolvedSubAgentStallTimeoutMs(options.stallTimeoutMs);
	const noProgressDetection = options.noProgressDetection ?? DEFAULT_SUB_AGENT_NO_PROGRESS_DETECTION;
	const repeatedOperationDetection =
		options.repeatedOperationDetection ?? DEFAULT_SUB_AGENT_REPEATED_OPERATION_DETECTION;
	let stopError: unknown;
	let exitCode = 1;
	try {
		exitCode = await new Promise<number>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("Sub-agent execution aborted"));
				return;
			}

			const invocation = getMyHarnessInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				// Match the bash/pwsh tools: never flash a console window on Windows.
				windowsHide: true,
				env: {
					...process.env,
					MYHARNESS_INTERNAL_CHAT_MODE: options.chatMode ?? "coding",
					...(options.mode === "read-write" ? { MYHARNESS_INTERNAL_DELEGATED_MODE: "read-write" } : {}),
					...(options.mode === "read-write" ? { MYHARNESS_INTERNAL_DELEGATED_WORKTREE: options.cwd } : {}),
					...(options.sandboxOrigin ? { [DELEGATED_SANDBOX_ORIGIN_ENV]: options.sandboxOrigin } : {}),
					...(options.readRoots?.length ? { [DELEGATED_READ_ROOTS_ENV]: JSON.stringify(options.readRoots) } : {}),
					...(options.traceContext ? getRuntimeTraceEnvironment(options.traceContext) : {}),
				},
			});
			containProcessTree(child);
			if (options.sandboxHandle && child.pid) {
				try {
					registerDelegatedSandboxWorker(options.sandboxHandle, child.pid);
				} catch (error) {
					child.on("error", () => {});
					void waitForProcessStop(child.pid).then(() => reject(error));
					return;
				}
			}
			// 任务 prompt 与运行中提醒都通过 stdin 以 NDJSON 行传入：
			// 避免超长命令行触发 ENAMETOOLONG，并允许向运行中的子会话注入 steering 提醒。
			child.stdin?.on("error", () => {});
			const writeWorkerInput = (payload: { type: "prompt" | "steer"; text: string; questions?: string[] }) => {
				if (!child.stdin?.writable) return false;
				return child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
			};
			// The questions travel with the prompt so the worker's submit_report can check each submission.
			writeWorkerInput({
				type: "prompt",
				text: options.prompt,
				...(options.questions?.length ? { questions: options.questions } : {}),
			});
			let buffer = "";
			let settled = false;
			let stopKind: "aborted" | "timeout" | "max_turns_reached" | "stalled" | undefined;
			let stopFinished = false;
			let stopConfirmed = false;
			let taskTimer: NodeJS.Timeout | undefined;
			let stallTimer: NodeJS.Timeout | undefined;
			let progressSinceTurn = false;
			const seenOperationCounts = new Map<string, number>();
			const seenScopes = new Set<string>();
			const seenResultHashes = new Set<string>();
			const seenAssistantHashes = new Set<string>();
			const warnedOperationKeys = new Set<string>();
			// Steering reminders reach the running child session through its stdin;
			// they nudge the model but never terminate the task by themselves.
			const injectSteeringReminder = (text: string) => {
				if (settled || stopKind) return;
				currentResult.lastToolInfo = truncateDisplay(text, 160);
				writeWorkerInput({ type: "steer", text });
				emitProgress();
			};

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (taskTimer) clearTimeout(taskTimer);
				if (stallTimer) clearTimeout(stallTimer);
				options.signal?.removeEventListener("abort", onAbort);
				child.stdin?.end();
				fn();
			};
			const armStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer);
				if (stallTimeoutMs <= 0 || settled || stopKind) return;
				stallTimer = setTimeout(() => requestStop("stalled"), stallTimeoutMs);
			};
			const markMeaningfulProgress = (description: string) => {
				const timestamp = new Date().toISOString();
				currentResult.lastMeaningfulProgress = truncateDisplay(description, 160);
				currentResult.lastMeaningfulProgressAt = timestamp;
				if (currentResult.diagnostics) {
					currentResult.diagnostics.meaningfulProgressCount += 1;
					currentResult.diagnostics.lastMeaningfulProgress = currentResult.lastMeaningfulProgress;
					currentResult.diagnostics.lastMeaningfulProgressAt = timestamp;
					currentResult.diagnostics.noProgressTurns = 0;
				}
				progressSinceTurn = true;
				armStallTimer();
				emitProgress();
			};
			const finishStop = () => {
				if (!stopKind || !stopFinished) return;
				settle(() => {
					if (stopKind === "timeout") {
						reject(new SubAgentTaskTimeoutError(taskTimeoutMs));
						return;
					}
					if (stopKind === "max_turns_reached" || stopKind === "stalled") {
						const messagesByReason = {
							max_turns_reached: `达到 Sub Agent 最大 turns 限制（${maxTurns}）`,
							stalled: `超过 ${Math.round(stallTimeoutMs / 60_000)} 分钟没有有效进展`,
						} as const;
						reject(new SubAgentConvergenceStopError(stopKind, messagesByReason[stopKind]));
						return;
					}
					const suffix = stopConfirmed ? "" : ", but its process could not be confirmed to have exited";
					reject(new Error(`Sub-agent execution aborted${suffix}`));
				});
			};
			const requestStop = (kind: Exclude<typeof stopKind, undefined>) => {
				if (stopKind) return;
				stopKind = kind;
				currentResult.stopReason = kind === "aborted" ? "cancelled" : kind === "timeout" ? "timeout" : kind;
				currentResult.lastToolInfo =
					kind === "timeout"
						? "执行超时"
						: kind === "aborted"
							? "已取消"
							: kind === "stalled"
								? "检测到长时间没有有效进展，正在停止"
								: `达到最大 turns（${maxTurns}），正在保留部分结果`;
				emitProgress();
				void waitForProcessStop(child.pid).then((confirmed) => {
					stopFinished = true;
					stopConfirmed = confirmed;
					finishStop();
				});
			};
			const processLine = (line: string) => {
				if (!line.trim() || stopKind) return;
				try {
					const event = JSON.parse(line) as DelegatedJsonEvent;
					const addedMessages = collectDelegatedEventMessages(eventState, event);
					for (const message of addedMessages) {
						const usage = getMessageTokenUsage(message);
						addTokenUsage(currentResult.tokenUsage!, usage);
						currentResult.tokens += getMessageTokens(message);
						collectAssistantFinding(currentResult, message);
						const text = assistantText(message);
						if (text && !assistantContainsToolCall(message)) {
							const assistantHash = hashValue(text);
							if (!seenAssistantHashes.has(assistantHash)) {
								seenAssistantHashes.add(assistantHash);
								markMeaningfulProgress("模型产生了新的调查分析");
							}
						}
					}
					if (addedMessages.length > 0) emitProgress();
					if (event.type === "compaction_start") {
						applyContextBudgetTelemetry(currentResult, event.budget, event.reason);
						currentResult.lastToolInfo = `正在压缩 Context（${event.reason ?? "unknown"}）`;
						emitProgress();
					}
					if (event.type === "compaction_end") {
						applyContextBudgetTelemetry(currentResult, event.budget, event.reason);
						if (currentResult.contextTelemetry) {
							currentResult.contextTelemetry.compactions += 1;
							currentResult.contextTelemetry.lastCompactionStatus = event.aborted
								? "aborted"
								: event.errorMessage
									? "failed"
									: "completed";
						}
						currentResult.lastToolInfo = event.errorMessage
							? `Context 压缩失败：${truncateDisplay(event.errorMessage, 100)}`
							: event.aborted
								? "Context 压缩已取消"
								: "Context 压缩完成";
						emitProgress();
					}
					if (event.type === "turn_start" || event.type === "turn_started") {
						currentResult.turnCount = (currentResult.turnCount ?? 0) + 1;
						progressSinceTurn = false;
						if (maxTurns > 0 && currentResult.turnCount > maxTurns) requestStop("max_turns_reached");
						emitProgress();
					}
					if (event.type === "turn_end" || event.type === "turn_finished") {
						if (!progressSinceTurn && currentResult.diagnostics) {
							currentResult.diagnostics.noProgressTurns += 1;
						} else if (currentResult.diagnostics) {
							currentResult.diagnostics.noProgressTurns = 0;
						}
						const idleTurns = currentResult.diagnostics?.noProgressTurns ?? 0;
						if (
							noProgressDetection &&
							idleTurns >= NO_PROGRESS_TURN_THRESHOLD &&
							(idleTurns - NO_PROGRESS_TURN_THRESHOLD) % NO_PROGRESS_TURN_THRESHOLD === 0
						) {
							injectSteeringReminder(
								`收敛提醒：连续 ${idleTurns} 轮没有产生新的调查信息。请更换关键词、路径或工具做针对性检查；如果已有证据足够，请直接整理输出最终报告。`,
							);
						}
						if (maxTurns > 0 && (currentResult.turnCount ?? 0) >= maxTurns) {
							requestStop("max_turns_reached");
						}
						progressSinceTurn = false;
						emitProgress();
					}
					if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
						const toolArgs =
							event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
						currentResult.toolUseCount++;
						currentResult.lastToolInfo = formatRunningTool(event.toolName, toolArgs, options.cwd);
						currentResult.transcript.push({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: toolArgs,
							status: "running",
							startedAt: new Date().toISOString(),
						});
						emitProgress();
					}
					if (event.type === "tool_execution_end" && event.toolCallId && event.toolName) {
						const trace = currentResult.transcript.find((entry) => entry.toolCallId === event.toolCallId);
						const resultSummary = summarizeToolResult(event.toolName, event.result, event.isError ?? false);
						const toolArgs =
							trace?.args ??
							(event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {});
						if (trace) {
							trace.status = event.isError ? "failed" : "completed";
							trace.finishedAt = new Date().toISOString();
							if (trace.startedAt) {
								trace.durationMs = Math.max(0, Date.now() - Date.parse(trace.startedAt));
							}
							trace.errorType = event.isError ? classifyToolStatus(event.result, true) : undefined;
							trace.resultSummary = resultSummary;
						} else {
							currentResult.toolUseCount++;
							currentResult.transcript.push({
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: {},
								status: event.isError ? "failed" : "completed",
								finishedAt: new Date().toISOString(),
								errorType: event.isError ? classifyToolStatus(event.result, true) : undefined,
								resultSummary,
							});
						}
						currentResult.lastToolInfo = resultSummary;
						if (event.isError && isReadOnlyGuardBlockedToolResult(event.result)) {
							// 只读守卫拦截：reason 已包含给模型的可执行指引；它不是工具故障，
							// 不计入连续失败数，避免把策略拦截误判成子 Agent 卡死。
						} else if (event.isError) {
							currentResult.diagnostics!.consecutiveToolErrors += 1;
							pushUniqueLimited(
								currentResult.unresolved,
								`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
							);
							const errorStreak = currentResult.diagnostics!.consecutiveToolErrors;
							if (
								noProgressDetection &&
								errorStreak >= CONSECUTIVE_TOOL_ERROR_THRESHOLD &&
								(errorStreak - CONSECUTIVE_TOOL_ERROR_THRESHOLD) % CONSECUTIVE_TOOL_ERROR_THRESHOLD === 0
							) {
								injectSteeringReminder(
									`收敛提醒：连续 ${errorStreak} 次调查工具调用失败。请检查参数与路径是否正确，或改用其他只读工具；必要时基于已有证据输出报告。`,
								);
							}
						} else {
							currentResult.diagnostics!.consecutiveToolErrors = 0;
							const scopeKey = toolScopeKey(event.toolName, toolArgs, options.cwd);
							const operationKey = `${event.toolName.toLowerCase()}:${hashValue(toolArgs)}:${hashValue(event.result)}`;
							const operationCount = (seenOperationCounts.get(operationKey) ?? 0) + 1;
							seenOperationCounts.set(operationKey, operationCount);
							if (operationCount > 1) currentResult.diagnostics!.repeatedOperations += 1;
							const newScope = !seenScopes.has(scopeKey);
							const newResult = !seenResultHashes.has(hashValue(event.result));
							seenScopes.add(scopeKey);
							seenResultHashes.add(hashValue(event.result));
							pushUniqueLimited(
								currentResult.coveredScope,
								formatToolCall(event.toolName, toolArgs, options.cwd),
							);
							pushUniqueLimited(
								currentResult.evidence,
								`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
							);
							if (newScope || newResult)
								markMeaningfulProgress(
									`${formatToolCall(event.toolName, toolArgs, options.cwd)}：${resultSummary}`,
								);
							if (repeatedOperationDetection && operationCount >= REPEATED_OPERATION_THRESHOLD) {
								if (!warnedOperationKeys.has(operationKey)) {
									warnedOperationKeys.add(operationKey);
									injectSteeringReminder(
										`收敛提醒：你似乎在重复已完成的调查（${formatToolCall(event.toolName, toolArgs, options.cwd)}）。请复用已有证据，改用未调查的角度；如果证据已足够，请直接输出最终报告。`,
									);
								} else {
									currentResult.lastToolInfo = `检测到重复操作：${formatToolCall(event.toolName, toolArgs, options.cwd)}`;
									emitProgress();
								}
							}
						}
						emitProgress();
					}
				} catch {
					// Non-JSON diagnostics are reported through stderr/exit status.
				}
			};
			const onAbort = () => requestStop("aborted");

			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (taskTimeoutMs > 0) {
				taskTimer = setTimeout(() => requestStop("timeout"), taskTimeoutMs);
			}
			armStallTimer();
			// A pipe chunk may end inside a multibyte character; each stream keeps its own decoder so the cut-off
			// bytes are completed by the next chunk instead of turning into U+FFFD.
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			child.stdout.on("data", (data: Buffer | string) => {
				buffer += typeof data === "string" ? data : stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data: Buffer | string) => {
				stderr = truncateSubAgentOutput(stderr + (typeof data === "string" ? data : stderrDecoder.write(data)));
			});
			child.on("error", (error) => {
				// A failed spawn (ENOENT: no node/global myharness on PATH, EACCES...) must say which command
				// could not be started instead of leaking Node's raw errno text as a mysterious runtime_error.
				const code = (error as NodeJS.ErrnoException).code;
				const cause =
					code === "ENOENT"
						? `Cannot start the sub-agent worker: the command "${invocation.command}" was not found`
						: `Cannot start the sub-agent worker ("${invocation.command}")`;
				const wrapped = new Error(`${cause}: ${error.message}`, { cause: error });
				if (stopKind) {
					stopFinished = true;
					stopConfirmed = true;
					finishStop();
					return;
				}
				settle(() => reject(wrapped));
			});
			// "close" waits for the worker's output pipes, and on Windows a process the worker started can hold a copy of
			// them after the worker itself is gone (a command it left running, a provider's own program). The worker's
			// last line is written before it exits, so shortly after the exit whatever is left of its tree is ended;
			// the pipes close and the task is reported instead of waiting for the stall watchdog.
			child.once("exit", () => {
				const leftovers = setTimeout(() => {
					if (!settled) endContainedLeftovers(child.pid);
				}, WORKER_EXIT_DRAIN_MS);
				leftovers.unref();
				child.once("close", () => clearTimeout(leftovers));
			});
			child.on("close", (code) => {
				buffer += stdoutDecoder.end();
				stderr = truncateSubAgentOutput(stderr + stderrDecoder.end());
				if (buffer.trim()) processLine(buffer);
				if (stopKind || options.signal?.aborted) {
					if (!stopKind) onAbort();
					if (stopKind && !stopFinished) {
						stopFinished = true;
						stopConfirmed = true;
					}
					finishStop();
					return;
				}
				settle(() => resolve(code ?? 1));
			});
		});
	} catch (error) {
		stopError = error;
	}

	reconcileMessageToolEvidence(currentResult, messages, options.cwd);
	collectTranscriptEvidence(currentResult, options.cwd);
	// The report the worker handed in with submit_report wins; its empty `report` means "the text I already wrote".
	// After a `continue_truncated` follow-up that text is the merged head (the cut-off reply) and tail (the reply that
	// hands the report in), so the full output keeps both halves.
	const submitted = findSubmittedReport(messages);
	const textReport = getFinalAssistantText(messages);
	const fullOutput = submitted
		? submitted.report ||
			(submitted.continuedText && submitted.messageText
				? `${submitted.continuedText}\n${submitted.messageText}`
				: "") ||
			submitted.messageText ||
			textReport
		: textReport;
	const output = truncateSubAgentOutput(fullOutput);
	currentResult.access = options.mode === "read-write" ? "write" : "read";
	currentResult.durationMs = Date.now() - startedAt;
	if (currentResult.tokenUsage) {
		currentResult.tokens =
			currentResult.tokenUsage.input +
			currentResult.tokenUsage.output +
			currentResult.tokenUsage.cacheRead +
			currentResult.tokenUsage.cacheWrite;
	}
	if (stopError) {
		const stopReason = stopReasonForError(stopError);
		currentResult.stopReason = stopReason;
		const convergenceStop = stopReason === "max_turns_reached" || stopReason === "stalled";
		currentResult.status =
			stopReason === "timeout"
				? hasUsefulResult(currentResult)
					? "partial"
					: "timeout"
				: stopReason === "cancelled"
					? "cancelled"
					: convergenceStop
						? "partial"
						: "failed";
		currentResult.lastToolInfo =
			stopReason === "timeout"
				? "执行超时"
				: stopReason === "cancelled"
					? "已取消"
					: stopError instanceof Error
						? stopError.message
						: String(stopError);
		if (stopReason === "timeout" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else if (stopReason === "cancelled" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else if (stopReason === "runtime_error" && !hasUsefulResult(currentResult)) {
			currentResult.error = stopError instanceof Error ? stopError.message : String(stopError);
		} else {
			if (stopReason === "runtime_error") currentResult.status = "partial";
			finalizePartialResult(
				currentResult,
				stopReason,
				stopError instanceof Error ? stopError.message : String(stopError),
				options.cwd,
				fullOutput,
			);
		}
		emitProgress();
		return currentResult;
	}
	const childError = [...messages]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" &&
				"errorMessage" in message &&
				typeof (message as { errorMessage?: unknown }).errorMessage === "string" &&
				(message as { errorMessage: string }).errorMessage.length > 0,
		);
	const stderrText = stderr.trim();
	if (exitCode === 0 && output === "" && messages.length > 0 && !stderrText && !childError) {
		// The worker ran to its end (including the follow-up turns of report-follow-up.ts) without any report text. The
		// user decided this is a failure, reported together with the reasoning the model produced instead.
		finalizeMissingReport(currentResult, messages, options.cwd);
		emitProgress();
		return currentResult;
	}
	if (exitCode !== 0 || output === "") {
		// A nonzero worker exit after an accepted report does not downgrade the verdict (V3): the report was handed in
		// and accepted before the process died, so the verdict comes from the report below; only the exit itself is
		// kept as a note. Cancellation by the user and an empty report body still take the failure paths.
		if (submitted && output !== "" && currentResult.status !== "cancelled") {
			pushUniqueLimited(
				currentResult.unresolved,
				`子 Agent 进程在交回报告后异常退出（退出码 ${exitCode}${stderrText ? `；输出：${stderrText}` : ""}），报告判定不受影响`,
			);
		} else {
			// Prefer the child's real error message (model request failure, provider
			// error, timeout...) over a generic exit-code string so the parent UI can
			// tell the user what actually went wrong.
			const childErrorMessage =
				stderrText ||
				(childError
					? ((childError as { errorMessage: string }).errorMessage ??
						`Sub-agent process exited with code ${exitCode}`)
					: `Sub-agent process exited with code ${exitCode}`);
			// A child that emitted not a single event never started the task (bad entry,
			// parent/worker version skew, startup crash). Say that plainly instead of
			// handing raw stderr back as if it were the sub-agent's report.
			const errorMessage =
				messages.length === 0
					? `子 Agent 进程未产生任何事件（退出码 ${exitCode}），任务没有真正开始${stderrText ? `；进程输出：${stderrText}` : ""}`
					: childErrorMessage;
			if (hasUsefulResult(currentResult)) {
				currentResult.status = "partial";
				finalizePartialResult(
					currentResult,
					classifyChildFailure(errorMessage, Boolean(childError)),
					errorMessage,
					options.cwd,
					fullOutput,
				);
			} else {
				currentResult.status = "failed";
				currentResult.stopReason = classifyChildFailure(errorMessage, Boolean(childError));
				currentResult.error = errorMessage;
				currentResult.lastToolInfo = currentResult.error;
			}
			emitProgress();
			return currentResult;
		}
	}
	if (!hasSuccessfulInvestigationEvidence(currentResult.transcript, options.mode)) {
		currentResult.status = "failed";
		currentResult.stopReason = "runtime_error";
		currentResult.error = "子 Agent 未执行调查工具，返回内容不能视为完成";
		currentResult.lastToolInfo = currentResult.error;
		emitProgress();
		return currentResult;
	}
	currentResult.goal ??= currentResult.prompt;
	const setFullOutput = (value: string) =>
		Object.defineProperty(currentResult, "fullOutput", { value, enumerable: false, configurable: true });
	if (submitted) {
		const verdict = evaluateSubmittedReport(options.questions, submitted.questions);
		currentResult.reportSubmission = "tool";
		if (verdict.statuses.length > 0) currentResult.questionStatuses = verdict.statuses;
		if (verdict.dataGaps.length > 0) {
			currentResult.dataGaps = verdict.dataGaps;
			for (const item of verdict.dataGaps) pushUniqueLimited(currentResult.unresolved, `资料拿不到：${item}`);
		}
		currentResult.output = output;
		setFullOutput(fullOutput);
		if (verdict.outcome === "incomplete") {
			currentResult.status = "partial";
			currentResult.stopReason = "incomplete_answer";
			currentResult.error = `子 Agent 提交的报告里有问题没有完成：${verdict.unfinished.join("；")}`;
			for (const item of verdict.unfinished) pushUniqueLimited(currentResult.unresolved, `问题未完成：${item}`);
			currentResult.recommendedNextInvestigation ??= [];
			pushUniqueLimited(currentResult.recommendedNextInvestigation, "针对没有完成的问题做定向补查");
			currentResult.lastToolInfo = "提交的报告里有问题没有完成";
			emitProgress();
			return currentResult;
		}
		currentResult.status = "completed";
		currentResult.stopReason = "completed";
		currentResult.lastToolInfo = verdict.dataGaps.length > 0 ? "完成（有资料缺口）" : "完成";
		emitProgress();
		return currentResult;
	}
	// Not handed in with submit_report, even after the follow-up request: read the text, and say so.
	currentResult.reportSubmission = "text";
	const completeness = evaluateExploreReportCompleteness(options.questions, fullOutput);
	if (!completeness.complete) {
		currentResult.status = "partial";
		currentResult.stopReason = completeness.checklistFound === false ? "report_not_submitted" : "incomplete_answer";
		currentResult.error = `没按格式提交（未调用 submit_report）。${completeness.note}`;
		for (const item of completeness.unanswered) {
			pushUniqueLimited(currentResult.unresolved, `问题未逐项回答：${item}`);
		}
		currentResult.recommendedNextInvestigation ??= [];
		pushUniqueLimited(currentResult.recommendedNextInvestigation, "针对未回答的问题做定向补查");
		const annotatedOutput = `${fullOutput}\n\n[自动检查] 没按格式提交（未调用 submit_report），以下按正文解析：${completeness.note}`;
		currentResult.output = truncateSubAgentOutput(annotatedOutput);
		setFullOutput(annotatedOutput);
		currentResult.lastToolInfo = "没按格式提交，正文里也确认不了问题是否答完";
		emitProgress();
		return currentResult;
	}
	currentResult.status = "completed";
	currentResult.stopReason = "completed";
	currentResult.output = output;
	setFullOutput(fullOutput);
	currentResult.lastToolInfo = "完成（没按格式提交，按正文解析）";
	emitProgress();
	return currentResult;
}

/**
 * A task that ended without any report text is a failure. Its result says why (the output limit cut the reply off
 * before any text, or the worker simply wrote none even after being asked once more), attaches the reasoning the model
 * produced when the provider returned it, and keeps the tool evidence collected so far.
 */
function finalizeMissingReport(result: ExploreTaskResult, messages: readonly Message[], cwd: string): void {
	collectTranscriptEvidence(result, cwd);
	const truncated = lastAssistantStopReason(messages) === "length";
	const followUpTexts = [REQUEST_REPORT_AFTER_TEXT, REQUEST_REPORT_WITHOUT_TEXT, CONTINUE_TRUNCATED_TEXT];
	const askedAgain = messages.some(
		(message) =>
			message.role === "user" && followUpTexts.some((text) => JSON.stringify(message.content).includes(text)),
	);
	const reason = truncated
		? `模型输出达到这个模型设置的输出上限，还没写出报告正文就被截断${askedAgain ? "（已续过一轮，仍被截断）" : ""}。`
		: `子 Agent 结束时没有写出报告正文${askedAgain ? "（已追问一次，仍没有）" : ""}。`;
	const reasoning = collectFinalReasoning(messages);
	result.status = "failed";
	result.stopReason = truncated ? "output_truncated" : "no_report";
	result.error = reason;
	result.goal ??= result.prompt;
	result.lastToolInfo = truncated ? "输出被截断，没有写出报告" : "没有写出报告";
	const body = [
		`[失败] ${reason}`,
		reasoning
			? `模型最后生成的推理过程（服务方返回的原文）：\n${reasoning}`
			: "服务方没有返回推理原文（或只返回了加密/隐藏的推理），无法附上推理过程。",
		formatItems("已覆盖范围", result.coveredScope),
		formatItems("证据", result.evidence),
	].join("\n\n");
	result.output = truncateSubAgentOutput(body);
	Object.defineProperty(result, "fullOutput", { value: body, enumerable: false, configurable: true });
}

export function buildSubAgentArgs(options: {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	contextWindow?: number;
	systemPromptPath: string;
	guardPath: string;
	/** The extension that registers the model's provider; the only extension a worker loads besides its guard. */
	providerExtensionPath?: string;
	mode?: SubAgentMode;
	/** `codeIntelligence.symbolsEnabled`; false leaves symbols out of the worker's `--tools`. */
	symbolsEnabled?: boolean;
}): string[] {
	// The worker builds its own session in its own process, so it reads the saved switch itself. This list
	// is what its role boundary receives as the requested tools, so dropping the name here is what keeps a
	// switched-off symbols tool out of the worker.
	const isConfigured = (name: string): boolean =>
		isGatedBuiltinToolName(name) ? options.symbolsEnabled !== false : true;
	const toolNames = withoutDisabledBuiltinTools(
		options.mode === "read-write" ? DELEGATED_WRITE_TOOL_NAMES : DELEGATED_TOOL_NAMES,
		isConfigured,
	);
	return [
		"--internal-delegated-worker",
		"--no-session",
		"--no-context-files",
		"--no-extensions",
		"--extension",
		options.guardPath,
		// A model that an extension registers exists in the worker only with that extension loaded. The worker's
		// session is delegated: it takes none of the extension's tools, only its provider.
		...(options.providerExtensionPath ? ["--extension", options.providerExtensionPath] : []),
		"--tools",
		toolNames.join(","),
		"--model",
		`${options.provider}/${options.model}`,
		"--thinking",
		options.thinkingLevel,
		"--agent-role",
		"delegated",
		...(options.contextWindow !== undefined ? ["--context-window", String(options.contextWindow)] : []),
		"--append-system-prompt",
		options.systemPromptPath,
	];
}

export interface RunExploreBatchOptions {
	cwd: string;
	tasks: SubAgentTaskSpec[];
	settings: ResolvedSubAgentRuntimeSettings;
	signal?: AbortSignal;
	onProgress?: (details: SubAgentToolDetails) => void;
	/**
	 * Called once before tasks start. The provided callback aborts the task at
	 * the given index (kills its sub-agent process); other tasks keep running.
	 */
	onKillReady?: (killTask: (index: number) => void) => void;
	trace?: RuntimeTrace;
	parentTraceScope?: RuntimeTraceScope;
	phaseId?: string;
	workflowRunId?: string;
	/**
	 * Absolute paths outside their copies that every task of the batch may read with the read-only file tools (the
	 * workflow engine passes its phase results folder). Each task may add its own `readPaths`.
	 */
	extraReadRoots?: string[];
}

export interface ExploreBatchResult {
	text: string;
	fullText: string;
	details: SubAgentToolDetails;
}

/** The access a task runs with: read-only mode allows reading only; read-write mode follows the task (default write). */
export function resolveTaskAccess(mode: SubAgentMode, task: Pick<SubAgentTaskSpec, "access">): "read" | "write" {
	if (mode !== "read-write") return "read";
	return task.access === "read" ? "read" : "write";
}

/** The copy one task runs in: a pooled Git worktree or a pooled file mirror of a non-Git folder. */
type TaskCopy = { kind: "worktree"; handle: PooledWorktreeHandle } | { kind: "mirror"; handle: MirrorCopyHandle };

function taskCopyPath(copy: TaskCopy | undefined): string | undefined {
	if (!copy) return undefined;
	return copy.kind === "worktree" ? copy.handle.worktreePath : copy.handle.sandboxPath;
}

/**
 * The locations outside its own copy a task may read: the batch's extra read roots (a workflow's phase results) plus
 * the task's own `readPaths`, as absolute paths without duplicates. The worker's write guard receives exactly this list.
 */
export function resolveTaskReadRoots(
	cwd: string,
	extraReadRoots: readonly string[] | undefined,
	readPaths: readonly string[] | undefined,
): string[] {
	return [
		...new Set(
			[...(extraReadRoots ?? []), ...(readPaths ?? [])]
				.map((item) => item.trim())
				.filter((item) => item !== "")
				.map((item) => path.resolve(cwd, item)),
		),
	];
}

function describeReadRoots(readRoots: readonly string[]): string {
	if (readRoots.length === 0) return "";
	return `\n\n[可读清单] Outside your copy you may also read these locations, with the read, grep, find, ls and symbols tools and absolute paths only (not from the shell); they are read-only for you:\n${readRoots.map((item) => `- ${item}`).join("\n")}`;
}

function describeWorktreeCopy(handle: PooledWorktreeHandle): string {
	const lines = [
		`[副本说明] You run in a copy of the Main Agent's workspace taken when this task was dispatched (snapshot commit ${handle.snapshot.commit.slice(0, 12)}): ${handle.worktreePath}. Use paths relative to your current directory; when the task names the Main Agent's workspace (${handle.snapshot.repositoryRoot}) by an absolute path, use the same path relative to your copy. Edits the Main Agent makes after dispatch are not visible to you.`,
		handle.access === "read"
			? "This copy is read-only for you: do not create, modify or delete files."
			: `Your edits stay in this copy on branch ${handle.branchName ?? "(detached)"}; never commit.`,
	];
	if (handle.snapshot.importNotes.length > 0) {
		lines.push(
			`Workspace snapshot notes (these uncommitted files of the Main Agent's workspace are NOT in your copy):\n${handle.snapshot.importNotes.map((note) => `- ${note}`).join("\n")}`,
		);
	}
	return `\n\n${lines.join("\n")}`;
}

function describeMirrorCopy(handle: MirrorCopyHandle): string {
	return `\n\n[沙箱说明]工作区文件已同步到独立副本 ${handle.sandboxPath}（${handle.importedFiles} 个文件，${handle.importedBytes} 字节；本次只同步变化的 ${handle.copiedFiles} 个文件，移除 ${handle.removedFiles} 个，用时 ${handle.preparationMs}ms）。优先用相对路径（如 ./课件.pdf）读取；${handle.access === "read" ? "这个副本对你只读，不要创建、修改或删除文件。" : "所有修改和临时文件只留在副本里，不写回宿主。"}原工作区 ${handle.originCwd} 仅可通过 read/grep/find/ls/symbols 绝对路径补读，不得通过 bash/pwsh/edit/write 访问或修改。副本${handle.complete ? "已按过滤规则完成" : "不完整，不能将缺失文件当成不存在"}。\n未带入副本的项目：\n${handle.importNotes.length ? handle.importNotes.map((note) => `- ${note}`).join("\n") : "- 无"}`;
}

export async function runExploreBatch(options: RunExploreBatchOptions): Promise<ExploreBatchResult> {
	const mode: SubAgentMode = options.settings.mode === "read-write" ? "read-write" : "read-only";
	const agentDir = getAgentDir();
	const endPoolUse = beginCopyPoolUse();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myharness-sub-agent-"));
	const readPromptPath = path.join(tempDir, "explore-prompt.md");
	const writePromptPath = path.join(tempDir, "explore-write-prompt.md");
	const readGuardPath = path.join(tempDir, "read-only-guard.js");
	const writeGuardPath = path.join(tempDir, "delegated-write-guard.js");
	const taskAccess = options.tasks.map((task) => resolveTaskAccess(mode, task));
	const taskPrompts = options.tasks.map(formatDelegatedTaskPrompt);
	// Batch-wide readable roots plus the task's own, as absolute paths (relative ones are the Main Agent's workspace).
	const taskReadRoots = options.tasks.map((task) =>
		resolveTaskReadRoots(options.cwd, options.extraReadRoots, task.readPaths),
	);
	const parentTraceScope = options.parentTraceScope;
	const taskTraceContexts = options.tasks.map((task) => {
		if (!options.trace || !parentTraceScope) return undefined;
		return {
			task,
			context: options.trace.createChildContext(parentTraceScope, {
				role: "delegated",
				agentId: options.trace.createId("agent"),
				taskId: options.trace.createId("task"),
				phaseId: options.phaseId ?? parentTraceScope.phaseId,
				workflowRunId: options.workflowRunId ?? parentTraceScope.workflowRunId,
			}),
		};
	});
	const results: ExploreTaskResult[] = options.tasks.map((task, index) => ({
		description: task.description,
		prompt: taskPrompts[index] ?? task.prompt,
		status: "running",
		output: "",
		model: options.settings.model,
		toolUseCount: 0,
		tokens: 0,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		turnCount: 0,
		lastToolInfo: "初始化中…",
		goal: task.goal ?? task.prompt,
		coveredScope: [],
		findings: [],
		evidence: [],
		conflicts: [],
		unresolved: [],
		recommendedNextInvestigation: [],
		diagnostics: {
			repeatedOperations: 0,
			consecutiveToolErrors: 0,
			noProgressTurns: 0,
			meaningfulProgressCount: 0,
		},
		contextTelemetry: { compactions: 0 },
		access: taskAccess[index],
		transcript: [],
	}));
	const emitProgress = () => {
		const usable = results.filter(
			(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result, mode)),
		).length;
		options.onProgress?.({
			completed: results.filter((result) => result.status === "completed").length,
			total: results.length,
			usable,
			findings: results.reduce((count, result) => count + (result.findings?.length ?? 0), 0),
			results: results.map(cloneExploreTaskResult),
		});
	};

	const copies: Array<TaskCopy | undefined> = options.tasks.map(() => undefined);
	const copyErrors: Array<string | undefined> = options.tasks.map(() => undefined);
	// Notes about a task's copy written before its worker starts (saved leftover changes); kept through every update.
	const copyNotes: string[][] = options.tasks.map(() => []);
	const released: boolean[] = options.tasks.map(() => false);
	const taskControllers = options.tasks.map(() => new AbortController());
	options.onKillReady?.((index) => taskControllers[index]?.abort());
	const taskSignalFor = (index: number) =>
		options.signal ? AbortSignal.any([options.signal, taskControllers[index].signal]) : taskControllers[index].signal;
	/** Known once the workspace was inspected; a dispatch that failed before that schedules no prewarm. */
	let workspaceIsGit: boolean | undefined;
	/** Give one task's copy back to the pool and record what the task left in it. Runs once per task. */
	const releaseCopy = async (index: number) => {
		const copy = copies[index];
		if (!copy || released[index]) return;
		released[index] = true;
		// Updated in place: the result carries the untruncated report as a non-enumerable `fullOutput`, which a spread
		// copy would drop (the Main Agent's full-text file would then hold only the truncated report).
		if (copy.kind === "worktree") {
			const finalized = await releasePooledWorktree(copy.handle);
			Object.assign(results[index], {
				worktreePath: copy.handle.worktreePath,
				...(copy.handle.branchName && finalized.dirty ? { branchName: copy.handle.branchName } : {}),
				...(finalized.dirty ? { changedFiles: finalized.changedFiles } : {}),
			});
			if (finalized.error) results[index].unresolved = pushUniqueLimited(results[index].unresolved, finalized.error);
		} else {
			const finalized = await releaseMirrorCopy(copy.handle);
			Object.assign(results[index], {
				worktreePath: copy.handle.sandboxPath,
				...(finalized.changedFiles.length ? { changedFiles: finalized.changedFiles } : {}),
			});
			if (finalized.error) results[index].unresolved = pushUniqueLimited(results[index].unresolved, finalized.error);
		}
	};
	try {
		for (let index = 0; index < taskTraceContexts.length; index++) {
			const traceTask = taskTraceContexts[index];
			if (!traceTask || !options.trace || !parentTraceScope) continue;
			results[index] = {
				...results[index],
				taskId: traceTask.context.taskId,
				runId: traceTask.context.runId,
				parentRunId: traceTask.context.parentRunId,
				agentId: traceTask.context.agentId,
				phaseId: traceTask.context.phaseId,
				workflowRunId: traceTask.context.workflowRunId,
			};
			await options.trace.record(parentTraceScope, "task-started", {
				taskId: traceTask.context.taskId,
				childRunId: traceTask.context.runId,
				agentId: traceTask.context.agentId,
				description: traceTask.task.description,
				access: taskAccess[index],
				maxTurns: resolvedSubAgentMaxTurns(options.settings.maxTurns),
				stallTimeoutMs: resolvedSubAgentStallTimeoutMs(options.settings.stallTimeoutMs),
				totalRuntimeLimitMs: resolvedTaskTimeoutMs(
					options.settings.totalRuntimeLimitMs ?? options.settings.taskTimeoutMs,
				),
			});
		}
		const needsRead = taskAccess.includes("read");
		const needsWrite = taskAccess.includes("write");
		await Promise.all([
			...(needsRead
				? [
						fs.promises.writeFile(readPromptPath, EXPLORE_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 }),
						fs.promises.writeFile(
							readGuardPath,
							createReadOnlyGuardExtensionSource("Sub Agent 已拦截命中的修改型 Bash 命令。", {
								mode: "delegated",
								adjudicator: {
									provider: options.settings.provider,
									model: options.settings.model,
									agentDir,
								},
							}),
							{ encoding: "utf8", mode: 0o600 },
						),
					]
				: []),
			...(needsWrite
				? [
						fs.promises.writeFile(writePromptPath, EXPLORE_WRITE_SYSTEM_PROMPT, {
							encoding: "utf8",
							mode: 0o600,
						}),
						fs.promises.writeFile(writeGuardPath, createDelegatedWriteGuardExtensionSource(), {
							encoding: "utf8",
							mode: 0o600,
						}),
					]
				: []),
		]);
		emitProgress();
		// Every task runs in a copy from the pool, never in the Main Agent's workspace: a pooled Git worktree synced to
		// one snapshot of the workspace, or, outside Git, a pooled file mirror (never `git init`, never a write into the
		// origin folder). A copy that cannot be prepared fails the dispatch or that task; nothing falls back to the host.
		const workspace = detectDelegatedWorkspace(options.cwd);
		if (!workspace.ok) throw new Error(workspace.error);
		workspaceIsGit = workspace.isGit;
		if (workspaceIsGit) {
			for (const result of results) result.lastToolInfo = "正在给工作区拍快照…";
			emitProgress();
			const snapshot = await createWorkspaceSnapshot(options.cwd, agentDir, options.signal);
			if (!snapshot.ok) throw new Error(`无法派出子代理：${snapshot.error}`);
			for (let index = 0; index < options.tasks.length; index++) {
				results[index].lastToolInfo = "正在准备副本…";
				emitProgress();
				const acquired = await acquirePooledWorktree({
					agentDir,
					snapshot: snapshot.snapshot,
					access: taskAccess[index],
					signal: options.signal,
				});
				if (!acquired.ok) {
					// No task may start on a half-prepared batch: give back what was taken and fail the dispatch.
					for (let taken = 0; taken < index; taken++) await releaseCopy(taken);
					throw new Error(`无法派出子代理：${acquired.error}`);
				}
				copies[index] = { kind: "worktree", handle: acquired.handle };
				if (acquired.handle.savedChanges) {
					const saved = acquired.handle.savedChanges;
					copyNotes[index].push(
						`副本 ${acquired.handle.slotName} 里上一个任务留下的 ${saved.files} 个未合并改动，已在重用前存为提交 ${saved.commit.slice(0, 12)}（分支 ${saved.branch}）`,
					);
				}
			}
		} else {
			for (let index = 0; index < options.tasks.length; index++) {
				results[index].lastToolInfo = "正在同步工作区副本…";
				emitProgress();
				const acquired = await acquireMirrorCopy({
					agentDir,
					originCwd: options.cwd,
					access: taskAccess[index],
					signal: taskSignalFor(index),
				});
				if (acquired.ok) {
					copies[index] = { kind: "mirror", handle: acquired.handle };
					if (acquired.handle.savedChanges) {
						const saved = acquired.handle.savedChanges;
						copyNotes[index].push(
							`副本 ${acquired.handle.slotName} 里上一个任务留下的 ${saved.files} 个改动，已在重用前另存到 ${saved.path}`,
						);
					}
				} else copyErrors[index] = acquired.error;
			}
		}
		// Per-task abort controllers: the panel can kill a single Explore task
		// while the rest of the batch keeps running.
		const lastProgressAt = options.tasks.map(() => undefined as string | undefined);
		const workerPromptFor = (index: number): string => {
			const base = taskPrompts[index] ?? options.tasks[index]?.prompt ?? "";
			const copy = copies[index];
			const copyNote = !copy
				? ""
				: copy.kind === "worktree"
					? describeWorktreeCopy(copy.handle)
					: describeMirrorCopy(copy.handle);
			return `${base}${copyNote}${describeReadRoots(taskReadRoots[index] ?? [])}`;
		};
		const taskSettlements = await Promise.allSettled(
			options.tasks.map(async (task, index) => {
				const traceContext = taskTraceContexts[index]?.context;
				const copy = copies[index];
				const access = taskAccess[index];
				try {
					if (copyErrors[index]) throw new Error(copyErrors[index]);
					const cwd = taskCopyPath(copy);
					if (!cwd) throw new Error("子代理没有可用的副本，已拒绝在主工作区运行");
					const finished = await runExploreTask({
						cwd,
						sandboxOrigin: copy?.kind === "mirror" ? copy.handle.originCwd : undefined,
						readRoots: taskReadRoots[index],
						provider: options.settings.provider,
						model: options.settings.model,
						chatMode: options.settings.chatMode,
						mode: access === "write" ? "read-write" : "read-only",
						symbolsEnabled: options.settings.symbolsEnabled,
						thinkingLevel: options.settings.thinkingLevel,
						contextWindow: options.settings.contextWindow,
						providerExtensionPath: options.settings.providerExtensionPath,
						description: task.description,
						prompt: workerPromptFor(index),
						goal: task.goal ?? task.prompt,
						questions: task.questions,
						systemPromptPath: access === "write" ? writePromptPath : readPromptPath,
						guardPath: access === "write" ? writeGuardPath : readGuardPath,
						signal: taskSignalFor(index),
						taskTimeoutMs: options.settings.taskTimeoutMs,
						totalRuntimeLimitMs: options.settings.totalRuntimeLimitMs,
						maxTurns: options.settings.maxTurns,
						stallTimeoutMs: options.settings.stallTimeoutMs,
						noProgressDetection: options.settings.noProgressDetection,
						repeatedOperationDetection: options.settings.repeatedOperationDetection,
						traceContext,
						onProgress: (result) => {
							results[index] = { ...result, unresolved: mergeUnresolved(copyNotes[index], result.unresolved) };
							if (
								options.trace &&
								parentTraceScope &&
								traceContext &&
								result.lastMeaningfulProgressAt &&
								lastProgressAt[index] !== result.lastMeaningfulProgressAt
							) {
								lastProgressAt[index] = result.lastMeaningfulProgressAt;
								void options.trace
									.record(parentTraceScope, "task-progress", {
										taskId: traceContext.taskId,
										childRunId: traceContext.runId,
										toolUseCount: result.toolUseCount,
										turnCount: result.turnCount,
										tokens: result.tokens,
										findings: result.findings?.length ?? 0,
										lastMeaningfulProgress: result.lastMeaningfulProgress,
										lastMeaningfulProgressAt: result.lastMeaningfulProgressAt,
									})
									.catch(() => {});
							}
							emitProgress();
						},
					});
					finished.unresolved = mergeUnresolved(copyNotes[index], finished.unresolved);
					results[index] = finished;
					if (options.trace && parentTraceScope && traceContext) {
						await options.trace
							.record(parentTraceScope, "task-finished", {
								taskId: traceContext.taskId,
								childRunId: traceContext.runId,
								status: results[index].status,
								toolUseCount: results[index].toolUseCount,
								turnCount: results[index].turnCount,
								tokens: results[index].tokens,
								stopReason: results[index].stopReason,
								reportSubmission: results[index].reportSubmission,
								dataGaps: results[index].dataGaps?.length ?? 0,
								findings: results[index].findings?.length ?? 0,
								durationMs: results[index].durationMs,
							})
							.catch(() => {});
					}
					emitProgress();
				} catch (error) {
					const timeout = error instanceof SubAgentTaskTimeoutError;
					const cancelled = taskControllers[index]?.signal.aborted === true || options.signal?.aborted === true;
					const status: ExploreTaskStatus = timeout ? "timeout" : cancelled ? "cancelled" : "failed";
					const message = timeout
						? error.message
						: taskControllers[index]?.signal.aborted
							? "已手动中止"
							: options.signal?.aborted
								? "父任务已取消"
								: error instanceof Error
									? error.message
									: String(error);
					// Object.assign instead of a spread: `fullOutput` is non-enumerable, and a spread copy would drop the
					// untruncated report a finished task had already attached (for example when the trace above threw).
					Object.assign(results[index], {
						unresolved: mergeUnresolved(copyNotes[index], results[index].unresolved),
						status,
						error: message,
						lastToolInfo: status === "timeout" ? "执行超时" : status === "cancelled" ? "已取消" : message,
					});
					emitProgress();
					if (options.trace && parentTraceScope && traceContext) {
						await options.trace
							.record(parentTraceScope, "task-finished", {
								taskId: traceContext.taskId,
								childRunId: traceContext.runId,
								status,
								error: message,
								stopReason: timeout ? "timeout" : cancelled ? "cancelled" : "runtime_error",
								toolUseCount: results[index].toolUseCount,
								turnCount: results[index].turnCount,
								tokens: results[index].tokens,
							})
							// Same as task-progress: a trace failure must not rewrite the settlement.
							.catch(() => {});
					}
				} finally {
					// What the copy left out matters to whoever reads a report made from that copy. A task that failed has
					// no report: the list would only bury the one line that says why it failed.
					if (copy && results[index].status !== "failed") {
						const notes = copy.kind === "worktree" ? copy.handle.snapshot.importNotes : copy.handle.importNotes;
						for (const note of notes) {
							results[index].unresolved = pushUniqueLimited(
								results[index].unresolved,
								copy.kind === "worktree" ? `未带入副本的未提交文件：${note}` : `未带入副本：${note}`,
							);
						}
					}
					await releaseCopy(index);
				}
			}),
		);
		let normalizedRejectedTask = false;
		for (let index = 0; index < taskSettlements.length; index++) {
			const settlement = taskSettlements[index];
			if (settlement.status !== "rejected" || results[index].status !== "running") continue;
			const message = settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
			results[index] = {
				...results[index],
				status: "failed",
				stopReason: "runtime_error",
				error: message,
				lastToolInfo: message,
			};
			normalizedRejectedTask = true;
		}
		if (normalizedRejectedTask) emitProgress();
		emitProgress();

		const details: SubAgentToolDetails = {
			completed: results.filter((result) => result.status === "completed").length,
			total: results.length,
			usable: results.filter(
				(result) => result.status === "completed" || (result.status === "partial" && hasUsefulResult(result, mode)),
			).length,
			findings: results.reduce((count, result) => count + (result.findings?.length ?? 0), 0),
			results: results.map(cloneExploreTaskResult),
			model: options.settings.model,
		};
		const fullResults = results.map((result) => ({
			...result,
			output: result.fullOutput ?? result.output,
		}));
		return {
			text: formatFinalResult(results),
			fullText: formatFinalResult(fullResults, true),
			details,
		};
	} finally {
		for (let index = 0; index < copies.length; index++) await releaseCopy(index).catch(() => {});
		endPoolUse();
		// Top the pool up and let the antivirus read new files while the computer is idle, not at the next dispatch.
		if (workspaceIsGit !== undefined) {
			scheduleCopyPoolPrewarm({
				agentDir,
				cwd: options.cwd,
				isGit: workspaceIsGit,
				size: resolveExploreMaxTasks({ maxTasks: options.settings.maxTasks }),
			});
		}
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((error) => {
			console.warn(
				`清理子代理提示目录失败（已保留 ${tempDir}）：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}

/** Notes recorded on a task before its worker started (saved leftover changes) survive the worker's own list. */
function mergeUnresolved(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
	let merged = [...(after ?? [])];
	for (const item of before ?? []) merged = pushUniqueLimited(merged, item);
	return merged;
}

function batchOutcomeStatus(details: SubAgentToolDetails): "completed" | "partial" | "failed" {
	return details.results.some(
		(item) => item.status === "failed" || item.status === "cancelled" || item.status === "timeout",
	)
		? "failed"
		: details.results.some((item) => item.status === "partial")
			? "partial"
			: "completed";
}

export function createSubAgentToolDefinition(
	cwd: string,
	options?: SubAgentToolOptions,
): BusinessToolDefinition<typeof subAgentSchema, SubAgentToolDetails> {
	const settingsSnapshot = options?.getSettings?.();
	const mode: SubAgentMode = settingsSnapshot?.mode === "read-write" ? "read-write" : "read-only";
	const advertisedMaxTasks = resolveExploreMaxTasks(settingsSnapshot);
	const promptVariables = { maxTasks: String(advertisedMaxTasks), capability: mode };
	return {
		name: "agent",
		label: "Agent",
		description:
			mode === "read-write"
				? `Dispatch up to ${advertisedMaxTasks} parallel read-write scouts: use it as the first step whenever a task has 2 or more independently actionable directions (independent files or modules, multi-source comparison, parallel topics, per-section work, batch tests), and do the work directly only for single-point, single-file, strictly ordered, or simple factual work. Give every task a work order that names the exact files or topics in scope, the expected deliverable, and the isolation red line. Mark a task access read when it only investigates, reviews or researches, and write when it must change files. Each sub-agent runs in its own copy of the workspace taken at dispatch: in Git, its own Git worktree from a reusable pool kept under the settings directory, synced to the current HEAD plus the workspace's uncommitted changes as they are now, so it sees the same files you see; your later edits are not visible to it. A write task may edit files and run commands only inside its copy; a read task may not change anything. Your workspace cannot be read from a copy by absolute path: list folders or files outside it that a task must read in readPaths. A sub-agent can never commit, push, merge or stage, cannot start further sub-agents, hands in its report with one status per question, and reports its copy path and changed files back with the result, plus the branch only when the copy kept changes. Its changes stay in its copy for the Main Agent, which reviews every diff, integrates the changes, runs the real verification, and repairs defects itself. In a non-Git folder each task instead receives a filtered file mirror from the same kind of reusable pool; use relative paths there, and changes are never written back to the host. Copy preparation failure never runs a writable worker in the host folder. Applying it as the highest-priority first step in every chat mode is the default working style: never start a single-threaded pass on a task with 2 or more independent directions.`
				: `Dispatch up to ${advertisedMaxTasks} parallel read-only scouts: use it as the first step whenever a task has 2 or more independently actionable directions (independent files or modules, multi-source comparison, parallel topics, per-section work, batch tests), and do the work directly only for single-point, single-file, strictly ordered, or simple factual work. Give every task a work order that names the exact files or topics in scope, the expected deliverable, and the isolation red line. Sub-agents cannot modify the project. Each task reads a copy of the workspace taken at dispatch from a reusable pool (a Git worktree, or a filtered file mirror outside Git); use relative paths, observe the reported skipped files, and list folders or files outside the workspace that a task must read in readPaths. Every sub-agent hands in its report with one status per question. The Main Agent reviews every receipt, verifies key findings, and repairs gaps itself. Applying it as the highest-priority first step in every chat mode is the default working style: never start a single-threaded pass on a task with 2 or more independent directions.`,
		promptSnippet: loadSystemPrompt("tools/agent/snippet.md", promptVariables),
		promptGuidelines: [
			...loadSystemPromptLines("tools/agent/guidelines.md", promptVariables),
			`当前允许的最大子智能体并发/派发上限为 ${advertisedMaxTasks}，单次派发任务严禁超过该数量；如需更多方向，必须保留全部方向并分批推进，每批至多 ${advertisedMaxTasks} 个，首批完成后根据回执再派下一批，全程任何时刻活动子任务数不超过 ${advertisedMaxTasks}，严禁合并或丢弃任务。`,
			...(mode === "read-write"
				? [
						"Read-write Explore sub-agents with access write edit only inside their own copy (their own Git worktree from the reusable pool, or a file mirror outside Git); tasks with access read cannot change their copy. They never commit, push, merge or stage, and never start further sub-agents; their result reports the copy path and changed files, and the branch only when the copy kept changes. Each copy starts as a snapshot of the current workspace (HEAD plus its uncommitted changes): refer to files by paths relative to the project root, because absolute paths of your own workspace are not readable from a copy unless listed in readPaths.",
					]
				: []),
		],
		parameters: createSubAgentSchema(mode, advertisedMaxTasks),
		// Each call already runs its tasks in parallel, capped by the configured subAgent.maxTasks. Serializing
		// separate Agent tool calls keeps the process-wide Explore concurrency at that same cap. The schema binds
		// maxItems to the live configured value; execute re-checks it and returns batch guidance without running.
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate) {
			const settings = options?.getSettings?.() ?? { enabled: false };
			const maxTasks = resolveExploreMaxTasks(settings);
			if (params.tasks.length < 1) {
				return {
					content: [
						{
							type: "text" as const,
							text: `当前单次至少派发 1 个子智能体，本次收到 0 个，未执行任何任务。请按原需求重构为 1 到 ${maxTasks} 个任务后重新提交。`,
						},
					],
					details: { completed: 0, total: 0, results: [] } as SubAgentToolDetails,
				};
			}
			if (params.tasks.length > maxTasks) {
				const received = params.tasks.length;
				const batches = Math.ceil(received / maxTasks);
				return {
					content: [
						{
							type: "text" as const,
							text: `当前单次最多派发 ${maxTasks} 个子智能体，本次收到 ${received} 个，已拦截未执行。请保留全部 ${received} 个方向，不合并、不丢弃，按原顺序分成 ${batches} 批、每批至多 ${maxTasks} 个的 agent 调用分批推进，首批完成后根据结果回执再派下一批，全程活动子任务数不超过 ${maxTasks}。`,
						},
					],
					details: { completed: 0, total: received, results: [] } as SubAgentToolDetails,
				};
			}
			if (!settings.enabled) throw new Error("Sub Agent is disabled in /settings.");
			if (!settings.provider || !settings.model || !settings.thinkingLevel) {
				throw new Error("Sub Agent model or thinking level is not configured. Configure it in /settings.");
			}
			// Known before anything is copied or started: no worker could run on this model.
			if (settings.unavailableReason) throw new Error(settings.unavailableReason);
			const runtimeSettings = resolveSubAgentRuntimeSettings(settings);
			const parentTraceScope = options?.getTraceParentScope?.();

			if (params.run_in_background) {
				const batchId = `explore-${randomBytes(5).toString("hex")}`;
				const controller = new AbortController();
				let killTask: ((index: number) => void) | undefined;
				const initialDetails: SubAgentToolDetails = {
					completed: 0,
					total: params.tasks.length,
					background: true,
					batchId,
					results: params.tasks.map((task) => ({
						description: task.description,
						prompt: formatDelegatedTaskPrompt(task),
						status: "running",
						output: "",
						toolUseCount: 0,
						tokens: 0,
						lastToolInfo: "后台运行中…",
						transcript: [],
					})),
				};
				const promise = runExploreBatch({
					cwd,
					tasks: params.tasks,
					settings: runtimeSettings,
					signal: controller.signal,
					trace: options?.trace,
					parentTraceScope,
					onProgress: (details) => options?.onBackgroundProgress?.({ batchId, details }),
					onKillReady: (kill) => {
						killTask = kill;
					},
				})
					.then(async (result) => {
						await options?.onBackgroundComplete?.({
							batchId,
							status: batchOutcomeStatus(result.details),
							text: result.text,
							fullText: result.fullText,
							details: { ...result.details, background: true, batchId },
						});
					})
					.catch(async (error) => {
						const message = error instanceof Error ? error.message : String(error);
						try {
							await options?.onBackgroundComplete?.({
								batchId,
								status: "failed",
								text: `后台 Explore ${batchId} 失败：${message}`,
							});
						} catch {
							// Completion notification failure must not create an unhandled background rejection.
						}
					});
				options?.onBackgroundStarted?.({
					batchId,
					cwd,
					tasks: params.tasks.map((task) => ({ ...task })),
					settings: runtimeSettings,
					abort: () => controller.abort(),
					promise,
					toolCallId,
					killTask: (index) => killTask?.(index),
				});
				return {
					content: [
						{
							type: "text",
							text: `已启动后台 Explore ${batchId}（${params.tasks.length} 个任务）。完成结果会自动通知主 Agent。`,
						},
					],
					details: initialDetails,
				};
			}

			const handle = options?.dispatch?.begin({ source: "agent", toolCallId, tasks: params.tasks });
			// After a detach the tool call is over: progress goes to the session only.
			let toolLive = true;
			const work = runExploreBatch({
				cwd,
				tasks: params.tasks,
				settings: runtimeSettings,
				signal: handle ? handle.signal : signal,
				trace: options?.trace,
				parentTraceScope,
				onProgress: (progress) => {
					const details = handle ? { ...progress, batchId: handle.id } : progress;
					handle?.progress(details);
					if (toolLive) onUpdate?.({ content: [{ type: "text", text: formatProgress(details) }], details });
				},
				onKillReady: handle ? (kill) => handle.setControls({ killTask: (ref) => kill(ref.task) }) : undefined,
			});
			if (!handle) {
				const result = await work;
				const toolResult = { content: [{ type: "text" as const, text: result.text }], details: result.details };
				if (result.fullText !== result.text) {
					Object.assign(toolResult, { [FULL_TEXT_OUTPUT]: result.fullText });
				}
				return toolResult;
			}
			let outcome: Awaited<ReturnType<typeof awaitForegroundDispatch<ExploreBatchResult>>>;
			try {
				outcome = await awaitForegroundDispatch(handle, work, signal);
			} catch (error) {
				handle.finishForeground();
				throw error;
			}
			if (outcome.kind === "detached") {
				toolLive = false;
				handle.completeInBackground(
					work.then((result) => ({
						status: batchOutcomeStatus(result.details),
						text: result.text,
						fullText: result.fullText,
						details: { ...result.details, background: true, batchId: handle.id },
					})),
				);
				return {
					content: [
						{
							type: "text",
							text: `主智能体被用户的新消息打断；这批子智能体（${handle.id}，${params.tasks.length} 个任务）没有被取消，已转入后台继续运行，完成后结果会自动交回主 Agent。不要重复派发同样的任务。`,
						},
					],
					details: {
						completed: 0,
						total: params.tasks.length,
						background: true,
						batchId: handle.id,
						results: params.tasks.map((task) => ({
							description: task.description,
							prompt: formatDelegatedTaskPrompt(task),
							status: "running",
							output: "",
							toolUseCount: 0,
							tokens: 0,
							lastToolInfo: "后台运行中…",
							transcript: [],
						})),
					} as SubAgentToolDetails,
				};
			}
			const result = outcome.value;
			const details = { ...result.details, batchId: handle.id };
			handle.finishForeground(details);
			const note = handle.stopNote();
			const text = note ? `${note}\n\n${result.text}` : result.text;
			const toolResult = { content: [{ type: "text" as const, text }], details };
			if (result.fullText !== result.text) {
				Object.assign(toolResult, { [FULL_TEXT_OUTPUT]: result.fullText });
			}
			return toolResult;
		},
	};
}

export function createSubAgentTool(cwd: string, options?: SubAgentToolOptions): AgentTool<typeof subAgentSchema> {
	return wrapToolDefinition(createSubAgentToolDefinition(cwd, options));
}
