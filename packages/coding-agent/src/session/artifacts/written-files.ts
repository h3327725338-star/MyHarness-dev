import { isAbsolute, resolve } from "node:path";
import { scanSessionLineHeads, scanSessionLines } from "../storage/jsonl/line-scan.ts";

// A write or edit result is one JSONL line; only lines holding this exact text are parsed.
const TOOL_RESULTS = [Buffer.from('"toolName":"write"'), Buffer.from('"toolName":"edit"')];
// The first line of each tool's result names the path as the Agent gave it (see tools/files/write.ts and edit.ts).
const WROTE_LINE = /^Successfully wrote \d+ bytes to (.+)$/u;
const EDITED_LINE = /^Successfully replaced \d+ block\(s\) in (.+)\.$/u;

/** One file a chat's write and edit tools reached. */
export interface WrittenFile {
	path: string;
	/** The write tool reported that the file did not exist before. Results older than that field say nothing, so no. */
	created: boolean;
	/** When the chat last wrote or edited it, epoch ms. */
	lastTouched: number;
}

interface ResultLine {
	type?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		toolName?: unknown;
		isError?: unknown;
		content?: unknown;
		details?: { created?: unknown };
	};
}

const pathKey = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);

/**
 * The files one chat wrote or edited, read from its own successful tool results. Entries copied from a parent chat
 * (older than this chat's header) are the parent's. Files made by shell commands leave no such record: see
 * readChatActivity for those.
 */
export async function readWrittenFiles(sessionPath: string): Promise<WrittenFile[]> {
	const files = new Map<string, WrittenFile>();
	await scanSessionLines(sessionPath, TOOL_RESULTS, (line, header) => {
		let entry: ResultLine;
		try {
			entry = JSON.parse(line) as ResultLine;
		} catch {
			return;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || message?.role !== "toolResult" || message.isError === true) return;
		if (message.toolName !== "write" && message.toolName !== "edit") return;
		const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isFinite(time) || (header.time !== undefined && time < header.time)) return;
		const first = Array.isArray(message.content) ? (message.content[0] as { text?: unknown } | undefined) : undefined;
		const firstLine = typeof first?.text === "string" ? first.text.split(/\r?\n/u, 1)[0]! : "";
		const named = (message.toolName === "write" ? WROTE_LINE : EDITED_LINE).exec(firstLine)?.[1];
		if (!named || (!isAbsolute(named) && !header.cwd)) return;
		const path = resolve(header.cwd ?? "", named);
		const known = files.get(pathKey(path));
		files.set(pathKey(path), {
			path: known?.path ?? path,
			created: known?.created === true || (message.toolName === "write" && message.details?.created === true),
			lastTouched: Math.max(known?.lastTouched ?? 0, time),
		});
	});
	return [...files.values()];
}

/** Several chats' files as one list: created by any of them, last touched by whichever came last. */
export function mergeWrittenFiles(lists: readonly (readonly WrittenFile[])[]): WrittenFile[] {
	const files = new Map<string, WrittenFile>();
	for (const list of lists) {
		for (const file of list) {
			const known = files.get(pathKey(file.path));
			files.set(pathKey(file.path), {
				path: known?.path ?? file.path,
				created: known?.created === true || file.created,
				lastTouched: Math.max(known?.lastTouched ?? 0, file.lastTouched),
			});
		}
	}
	return [...files.values()];
}

/** A stretch of time, epoch ms. */
export interface TimeSpan {
	start: number;
	end: number;
}

/** What one chat did to the disk, as far as its history tells. */
export interface ChatActivity {
	cwd?: string;
	written: WrittenFile[];
	/** When a tool that can make files ran: a file born in one of these is this chat's work, whatever made it. */
	toolRuns: TimeSpan[];
	/** The time of its newest entry. A tool still running has its result to come, and started no earlier than this. */
	lastEntry?: number;
}

// These read, look things up or wait for the user. A file born while one of them runs is not its work.
const TOOLS_MAKING_NO_FILES = new Set([
	"agent_tasks",
	"ask_user_question",
	"find",
	"grep",
	"job_kill",
	"job_list",
	"job_output",
	"ls",
	"mail",
	"memory_claim",
	"memory_delete",
	"memory_get",
	"memory_search",
	"memory_write",
	"read",
	"schedule",
	"session_get",
	"session_search",
	"symbols",
	"todo_write",
	"web_fetch",
	"web_search",
	"workspace",
]);
const SHELL_TOOLS = new Set(["bash", "pwsh"]);
const JOB_TOOLS = new Set(["job_kill", "job_output"]);
const ENTRY_TIME = /"timestamp":"([^"]+)"/u;
const MESSAGE_HEAD =
	/^\{"type":"message".*?"message":\{"role":"(\w+)"(?:,"toolCallId":"[^"]*","toolName":"([^"]+)")?/su;
// A shell tool's result carries this only when the command went on in the background.
const JOB_STARTED = Buffer.from('"taskId":"');

/**
 * When a chat's tools ran, from the times of its own entries: each result closes the time since the entry before it.
 * A background job also runs between entries, until its turn ends and whenever the chat comes back to look at it.
 */
async function readToolRuns(sessionPath: string): Promise<Omit<ChatActivity, "written">> {
	const toolRuns: TimeSpan[] = [];
	let cwd: string | undefined;
	let previous: number | undefined;
	let jobStart: number | undefined;
	let jobInThisTurn = false;
	const endTurn = () => {
		if (jobInThisTurn && jobStart !== undefined && previous !== undefined)
			toolRuns.push({ start: jobStart, end: previous });
		jobInThisTurn = false;
	};
	await scanSessionLineHeads(sessionPath, (head, line, header) => {
		cwd = header.cwd;
		const stamp = ENTRY_TIME.exec(head)?.[1];
		const time = stamp ? Date.parse(stamp) : Number.NaN;
		if (!Number.isFinite(time) || (header.time !== undefined && time < header.time)) return;
		const message = MESSAGE_HEAD.exec(head);
		if (message?.[1] === "user") endTurn();
		if (message?.[1] === "toolResult") {
			const tool = message[2] ?? "";
			if (!TOOLS_MAKING_NO_FILES.has(tool)) toolRuns.push({ start: previous ?? time, end: time });
			if (SHELL_TOOLS.has(tool) && line?.includes(JOB_STARTED)) {
				jobStart ??= time;
				jobInThisTurn = true;
			}
			if (JOB_TOOLS.has(tool) && jobStart !== undefined) toolRuns.push({ start: jobStart, end: time });
		}
		previous = time;
	});
	endTurn();
	return {
		...(cwd === undefined ? {} : { cwd }),
		toolRuns,
		...(previous === undefined ? {} : { lastEntry: previous }),
	};
}

export async function readChatActivity(sessionPath: string): Promise<ChatActivity> {
	const [written, runs] = await Promise.all([readWrittenFiles(sessionPath), readToolRuns(sessionPath)]);
	return { written, ...runs };
}

/** The spans in order, with the ones that touch or overlap joined. */
export function mergeTimeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
	const merged: TimeSpan[] = [];
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

/** Whether a time falls in one of these merged spans, give or take `slack`. */
export function isWithinTimeSpans(spans: readonly TimeSpan[], time: number, slack: number): boolean {
	let low = 0;
	let high = spans.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const span = spans[middle]!;
		if (time < span.start - slack) high = middle - 1;
		else if (time > span.end + slack) low = middle + 1;
		else return true;
	}
	return false;
}
