/**
 * "What did the agent change" for the Web UI.
 *
 * Facts come from the existing change-detection layer (Git checkpoint, workspace
 * baseline, edit/write/apply_patch/apply_rename tool snapshots). This module only turns those facts into
 * per-file unified diffs; it never guesses content it cannot observe.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
import { isNonMutatingTool } from "../../git/checkpoints/coordinator.ts";
import { runGit, runGitSync } from "../../git/repository/command.ts";
import { getCachedGitInspect } from "../../git/repository/read-cache.ts";
import type { ReviewChange, ReviewChangeStatus } from "../../git/repository/review-types.ts";
import {
	type ChangeDetectionResult,
	collectCheckpointChanges,
	type GitTaskChangeSummary,
	type TaskCommitDelta,
} from "../../git/repository/workspace-changes.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import {
	type ActivityKind,
	attributeRunChanges,
	type ChangeClaimRegistry,
	type ChangedElsewhere,
} from "./change-claims.ts";
import {
	batchWorktreeStats,
	coalescedWorktreeListFetch,
	getCachedWorktreeChangesSync,
	invalidateWorktreeCache,
} from "./changes-stats.ts";

export { batchWorktreeStats, invalidateWorktreeCache };

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_FILES_WITH_STATS = 300;
/** How many files' earlier content is read from the checkpoint at the same time (one Git process each). */
const BEFORE_READ_PARALLEL = 8;
/** Diffs kept with a task's change card in the session: larger ones (per file, or all together) are left out. */
const MAX_CARD_PATCH_CHARS = 200_000;
const MAX_CARD_PATCH_CHARS_PER_RUN = 1_000_000;
/** Files changed elsewhere that a card lists by name; the count beyond it is kept as a number. */
export const MAX_CARD_ELSEWHERE_FILES = 200;

/** Tools whose file changes are observed from their own calls: the before/after content of each file they name. */
export type FileMutationTool = "edit" | "write" | "apply_patch" | "apply_rename";

export interface FileChangeSummary {
	path: string;
	status: ReviewChangeStatus;
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	/** Why the content diff cannot be shown (status is still real). */
	unavailable?: string;
	/** The text is the same once CRLF and LF count as one line ending: only the line endings changed. */
	lineEndingsOnly?: boolean;
	/** Another conversation changed this file more recently: that conversation commits it, this one keeps its history only. */
	lastChangeElsewhere?: boolean;
	/** Changed by the task that is still running: not saved with the conversation yet (the Changes panel only). */
	live?: boolean;
}

/** One file of a task's change card: its summary and, while it fits the budget, its diff. */
export interface RunChangeCardFile extends FileChangeSummary {
	patch?: string;
	/** The file has a text diff, but it was too large to keep with the card. */
	patchOmitted?: boolean;
}

export interface RunCommitCard {
	runId: number;
	files: RunChangeCardFile[];
}

export interface RunChangeRecord {
	runId: number;
	startedAt: number;
	endedAt?: number;
	/** known: the change list is authoritative. indeterminate: it may be incomplete. */
	reliability: "known" | "indeterminate" | "pending";
	reason?: string;
	changes: ReviewChange[];
	commitDelta?: TaskCommitDelta;
	git?: GitTaskChangeSummary;
	checkpointId?: string;
	checkpointStatus?: string;
	/** Tool-level file operations observed during the run (edit/write/apply_patch/apply_rename), regardless of detection. */
	toolFileOps: Array<{ path: string; tool: FileMutationTool; ok: boolean }>;
	bashRuns: number;
	/** Calls of the run that may write files without naming them: shell commands, sub-agent batches, other tools. */
	opaqueCalls: number;
	/** Shell calls that may have moved Git HEAD (git commit/merge/switch/...): HEAD progress is then treated as possibly own. */
	gitHeadOps: number;
	/** Detected changes the run cannot explain: another conversation or another program changed them meanwhile. */
	elsewhere?: ChangedElsewhere[];
}

interface Snapshot {
	/** null: the file did not exist before the first edit/write of this run. */
	before: string | null;
	binary: boolean;
}

/** Why a file's earlier content is missing from a change card, by whether a Git checkpoint existed to read it from. */
const UNAVAILABLE_WITH_CHECKPOINT = "The file's content before the task could not be read from the Git checkpoint.";
const UNAVAILABLE_WITHOUT_CHECKPOINT =
	"No Git checkpoint: the pre-task content of files changed by shell commands is not recorded.";

interface BeforeContent {
	text: string | null;
	binary: boolean;
	known: boolean;
}

/**
 * One file of a task that a new message cut into several runs (see ChangeTracker.deferRun): how it first changed, how it
 * changed last, and what it held before the first of those runs. Later runs never replace `before`.
 */
interface ChainFile {
	path: string;
	first: ReviewChange;
	last: ReviewChange;
	before: BeforeContent;
	unavailable: string;
}

/**
 * The status of a file after several runs in a row, from how the first and the last of them changed it; undefined when
 * the file was created and deleted again, so the whole task left nothing behind.
 */
function mergeChainChange(entry: ChainFile): ReviewChange | undefined {
	const { first, last } = entry;
	const oldPath = first.oldPath;
	if (first.status === "added") return last.status === "deleted" ? undefined : { path: entry.path, status: "added" };
	if (first.status === "deleted") {
		return { path: entry.path, status: last.status === "deleted" ? "deleted" : "modified" };
	}
	if (last.status === "deleted") return { path: oldPath ?? entry.path, status: "deleted" };
	if (first.status === "renamed") return { path: entry.path, status: "renamed", ...(oldPath ? { oldPath } : {}) };
	return { path: entry.path, status: "modified" };
}

function toRelative(cwd: string, absolute: string): string | undefined {
	const relative = path.relative(path.resolve(cwd), path.resolve(absolute));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

/** Last write time of a file on disk, undefined when it cannot be read. */
export function statModifiedAt(absolutePath: string): number | undefined {
	try {
		return statSync(absolutePath).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Text with CRLF line endings written as LF, the way Git compares text files: the content before a task often comes
 * from Git (LF) while the file on disk has CRLF (a .ps1/.cmd/.bat file, or any text file with core.autocrlf), and
 * without this every line would count as changed.
 */
function withLfLineEndings(text: string | null): string | null {
	return text === null ? null : text.replace(/\r\n/g, "\n");
}

/** Builds a file's summary diff with line endings compared the way Git compares text. */
function textDiff(
	summary: FileChangeSummary,
	before: string | null,
	after: string | null,
	oldPathName: string,
): { summary: FileChangeSummary; patch?: string } {
	const beforeText = withLfLineEndings(before);
	const afterText = withLfLineEndings(after);
	if (before !== null && after !== null && before !== after && beforeText === afterText) {
		summary.lineEndingsOnly = true;
		return { summary };
	}
	const patch = makePatch(summary.path, beforeText, afterText, oldPathName);
	const counts = countPatchLines(patch);
	summary.additions = counts.additions;
	summary.deletions = counts.deletions;
	return { summary, patch };
}

/**
 * Tools that write nothing in the workspace beyond the checkpoint list's read-only tools: web pages and memories are
 * saved in the data folder, and stopping a sub-agent writes nothing. Their calls are no window of their own, so a run
 * that only searched the web does not claim what other programs changed meanwhile.
 */
const NO_WORKSPACE_WRITE_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"memory_write",
	"memory_delete",
	"memory_claim",
	"agent_tasks",
]);

/**
 * Whether a call of `toolName` may write files without naming them, so the time it runs counts as a window in which
 * the session may have changed any file. File tools name their files and are recorded by path instead.
 */
export function toolCallMayWriteFiles(toolName: string): boolean {
	if (toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "apply_rename") {
		return false;
	}
	return !isNonMutatingTool(toolName) && !NO_WORKSPACE_WRITE_TOOLS.has(toolName);
}

function looksBinary(buffer: Buffer): boolean {
	const length = Math.min(buffer.length, 8000);
	for (let index = 0; index < length; index++) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

function readTextIfSmall(file: string): { text: string | null; binary: boolean; tooLarge: boolean } {
	try {
		if (!existsSync(file)) return { text: null, binary: false, tooLarge: false };
		const stat = statSync(file);
		if (!stat.isFile()) return { text: null, binary: false, tooLarge: false };
		if (stat.size > MAX_TEXT_BYTES) return { text: null, binary: false, tooLarge: true };
		const buffer = readFileSync(file);
		if (looksBinary(buffer)) return { text: null, binary: true, tooLarge: false };
		return { text: buffer.toString("utf8"), binary: false, tooLarge: false };
	} catch {
		return { text: null, binary: false, tooLarge: false };
	}
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

export function makePatch(
	pathName: string,
	oldText: string | null,
	newText: string | null,
	oldPathName = pathName,
): string {
	const patch = createTwoFilesPatch(
		oldText === null ? "/dev/null" : `a/${oldPathName}`,
		newText === null ? "/dev/null" : `b/${pathName}`,
		oldText ?? "",
		newText ?? "",
		"",
		"",
		{ context: 3 },
	);
	// createTwoFilesPatch prefixes an "Index:" banner; drop it so the patch starts at the file headers.
	const start = patch.indexOf("---");
	return start > 0 ? patch.slice(start) : patch;
}

function gitShow(repositoryRoot: string, spec: string): { text: string | null; binary: boolean } {
	const result = runGitSync(["show", spec], { cwd: repositoryRoot, timeoutMs: 20_000, preserveOutput: true });
	if (!result.ok) return { text: null, binary: false };
	if (result.stdout.includes("\u0000")) return { text: null, binary: true };
	return { text: result.stdout, binary: false };
}

async function gitShowAsync(repositoryRoot: string, spec: string): Promise<{ text: string | null; binary: boolean }> {
	const result = await runGit(["show", spec], {
		cwd: repositoryRoot,
		timeoutMs: 20_000,
		env: { GIT_OPTIONAL_LOCKS: "0" },
	});
	if (!result.ok) return { text: null, binary: false };
	if (result.stdout.includes("\u0000")) return { text: null, binary: true };
	return { text: result.stdout, binary: false };
}

export interface ChangeTrackerOptions {
	/** Shared registry of what each open conversation changed (see change-claims.ts). */
	changeClaims?: ChangeClaimRegistry;
	/** Identity of this tracker's session; changes claimed under the same key are never treated as foreign. */
	sessionKey?: () => string;
}

/** Tracks per-run tool snapshots and produces file diffs. One instance per runtime cwd. */
export class ChangeTracker {
	private cwd: string;
	private readonly changeClaims: ChangeClaimRegistry | undefined;
	private readonly sessionKeyProvider: (() => string) | undefined;
	private readonly runs = new Map<number, RunChangeRecord>();
	private readonly snapshots = new Map<number, Map<string, Snapshot>>();
	private readonly snapshotBytes = new Map<number, number>();
	private readonly checkpoints = new Map<number, GitCheckpoint>();
	private readonly pendingBefore = new Map<string, { runId: number; rels: string[] }>();
	/**
	 * The files of runs a new message cut short, by path in the order they first changed: they have no card of their own,
	 * the card of the task's last run holds them all (deferRun, finishChain).
	 */
	private readonly chain = new Map<string, ChainFile>();
	private readonly chainCommits: RunCommitCard[] = [];
	private chainCommitChars = 0;
	private readonly chainElsewhere = new Map<string, ChangedElsewhere>();
	private chainBytes = 0;
	/**
	 * Calls that may write files without naming them (shell commands, sub-agent batches, other tools) and have not
	 * reported an end yet, by tool call id. Each is an open window in the shared registry while it runs.
	 */
	private readonly openActivities = new Map<string, { runId: number; startedAt: number; windowId?: string }>();
	/** Sub-agent dispatches seen running, by dispatch id, with the registry window that stays open until they end. */
	private readonly openDispatches = new Map<string, string>();
	/** Dispatches whose window is already recorded as ended. */
	private readonly endedDispatches = new Set<string>();

	constructor(cwd: string, options: ChangeTrackerOptions = {}) {
		this.cwd = cwd;
		this.changeClaims = options.changeClaims;
		this.sessionKeyProvider = options.sessionKey;
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	reset(): void {
		this.dispose();
		this.runs.clear();
		this.snapshots.clear();
		this.snapshotBytes.clear();
		this.pendingBefore.clear();
		this.checkpoints.clear();
		this.clearChain();
	}

	/**
	 * The tracker is being replaced (another session bound to the slot, or the slot closed): the windows it still holds
	 * open in the shared registry end now, so they do not cover time this tracker no longer watches.
	 */
	dispose(): void {
		const now = Date.now();
		for (const activity of this.openActivities.values()) {
			if (activity.windowId) this.changeClaims?.closeWindow(activity.windowId, now);
		}
		this.openActivities.clear();
		for (const windowId of this.openDispatches.values()) this.changeClaims?.closeWindow(windowId, now);
		this.openDispatches.clear();
	}

	beginRun(runId: number): RunChangeRecord {
		const record: RunChangeRecord = {
			runId,
			startedAt: Date.now(),
			reliability: "pending",
			changes: [],
			toolFileOps: [],
			bashRuns: 0,
			opaqueCalls: 0,
			gitHeadOps: 0,
		};
		this.runs.set(runId, record);
		this.snapshots.set(runId, new Map());
		this.snapshotBytes.set(runId, 0);
		// A call from an earlier run never reported its end: its window ends where that run ended (or now, when the
		// run never finished) instead of being stretched over the new run.
		for (const [toolCallId, activity] of this.openActivities) {
			if (activity.runId === runId) continue;
			this.endActivity(toolCallId, this.runs.get(activity.runId)?.endedAt ?? Date.now());
		}
		// Keep memory bounded: only the most recent runs retain snapshots.
		const ids = [...this.runs.keys()].sort((a, b) => a - b);
		while (ids.length > 12) {
			const drop = ids.shift()!;
			this.runs.delete(drop);
			this.snapshots.delete(drop);
			this.snapshotBytes.delete(drop);
			this.checkpoints.delete(drop);
		}
		return record;
	}

	getRun(runId: number): RunChangeRecord | undefined {
		return this.runs.get(runId);
	}

	/** Live status of the checkpoint recorded for a run ("restored" after Undo). */
	checkpointStatus(runId: number): string | undefined {
		return this.checkpoints.get(runId)?.status;
	}

	latestRunId(): number | undefined {
		const ids = [...this.runs.keys()];
		return ids.length ? Math.max(...ids) : undefined;
	}

	listRuns(): RunChangeRecord[] {
		return [...this.runs.values()].sort((a, b) => b.runId - a.runId);
	}

	/** Capture the file's content before an edit/write executes (first touch per run wins). */
	captureBefore(runId: number, toolCallId: string, tool: FileMutationTool, args: { path?: unknown }): void {
		void tool;
		if (typeof args?.path !== "string") return;
		this.captureBeforePaths(runId, toolCallId, [args.path]);
	}

	/**
	 * Capture the content of every file one tool call is about to change, e.g. both ends of an apply_patch move. A file
	 * that several calls touch keeps the content from before the first of them.
	 */
	captureBeforePaths(runId: number, toolCallId: string, paths: readonly string[]): void {
		const rels: string[] = [];
		for (const candidate of paths) {
			const absolute = path.resolve(this.cwd, candidate);
			const rel = toRelative(this.cwd, absolute);
			if (!rel) continue;
			rels.push(rel);
			const snapshots = this.snapshots.get(runId);
			if (!snapshots || snapshots.has(rel)) continue;
			const read = readTextIfSmall(absolute);
			if (read.tooLarge) continue;
			const size = read.text ? Buffer.byteLength(read.text) : 0;
			const total = (this.snapshotBytes.get(runId) ?? 0) + size;
			if (total > MAX_SNAPSHOT_BYTES_PER_RUN) continue;
			this.snapshotBytes.set(runId, total);
			snapshots.set(rel, { before: read.text, binary: read.binary });
		}
		if (rels.length > 0) this.pendingBefore.set(toolCallId, { runId, rels });
	}

	recordToolOp(runId: number, toolCallId: string, tool: FileMutationTool, ok: boolean): void {
		const pending = this.pendingBefore.get(toolCallId);
		this.pendingBefore.delete(toolCallId);
		const record = this.runs.get(runId);
		if (!record || !pending) return;
		const at = Date.now();
		for (const rel of pending.rels) {
			record.toolFileOps.push({ path: rel, tool, ok });
			if (ok) this.publishClaim(runId, rel, tool, at);
		}
	}

	/** A shell call started: the files written while it runs can be this session's. */
	recordShellStart(runId: number, toolCallId: string): void {
		this.recordToolStart(runId, toolCallId, "shell");
	}

	/** A shell call ended: its window is what file writes inside it are attributed to. */
	recordShellEnd(runId: number, toolCallId: string): void {
		this.recordToolEnd(runId, toolCallId);
	}

	/**
	 * A call that may write files without naming them started (a shell command, a sub-agent batch, another tool). Its
	 * window opens in the shared registry right away, so other sessions see it while it runs.
	 */
	recordToolStart(runId: number, toolCallId: string, kind: ActivityKind): void {
		const startedAt = Date.now();
		const record = this.runs.get(runId);
		if (record) record.opaqueCalls += 1;
		const sessionKey = this.sessionKeyProvider?.();
		let windowId: string | undefined;
		if (this.changeClaims && sessionKey) {
			windowId = `${sessionKey}\u0000call\u0000${toolCallId}`;
			this.changeClaims.openWindow(windowId, { sessionKey, runId, startedAt, kind });
		}
		this.openActivities.set(toolCallId, { runId, startedAt, ...(windowId ? { windowId } : {}) });
	}

	/**
	 * Whether something of this session ran during the run that may write files without naming them: a shell command or
	 * another write-capable call of the run, a sub-agent dispatch, or a background job still running from an earlier
	 * task. Final detection then has to compare the whole folder: the Git checkpoint, or the content baseline taken
	 * when the run started.
	 */
	runHadOpaqueActivity(runId: number): boolean {
		const record = this.runs.get(runId);
		if (!record) return false;
		if (record.opaqueCalls > 0) return true;
		const sessionKey = this.sessionKeyProvider?.();
		if (!this.changeClaims || !sessionKey) return false;
		return this.changeClaims.hasWindowDuring(sessionKey, record.startedAt, record.endedAt ?? Date.now());
	}

	/** The call ended, whatever its result: a failed command may still have written files. */
	recordToolEnd(_runId: number, toolCallId: string): void {
		this.endActivity(toolCallId, Date.now());
	}

	private endActivity(toolCallId: string, endedAt: number): void {
		const activity = this.openActivities.get(toolCallId);
		this.openActivities.delete(toolCallId);
		if (activity?.windowId) this.changeClaims?.closeWindow(activity.windowId, endedAt);
	}

	/**
	 * The session's sub-agent dispatches as the session reports them. A dispatch that runs in the background outlives
	 * the tool call that started it: its window stays open until it ends, so the files its sub-agents write count as
	 * this session's. A dispatch that is no longer reported has ended.
	 */
	recordDispatches(
		dispatches: ReadonlyArray<{ id: string; startedAt: number; endedAt?: number; status: string }>,
	): void {
		const registry = this.changeClaims;
		const sessionKey = this.sessionKeyProvider?.();
		if (!registry || !sessionKey) return;
		const now = Date.now();
		const runId = this.latestRunId() ?? 0;
		const reported = new Set<string>();
		for (const dispatch of dispatches) {
			reported.add(dispatch.id);
			if (this.endedDispatches.has(dispatch.id)) continue;
			const ended = dispatch.endedAt !== undefined || dispatch.status !== "running";
			const windowId = this.openDispatches.get(dispatch.id);
			if (!ended) {
				if (windowId) continue;
				const id = `${sessionKey}\u0000dispatch\u0000${dispatch.id}`;
				registry.openWindow(id, { sessionKey, runId, startedAt: dispatch.startedAt, kind: "agent" });
				this.openDispatches.set(dispatch.id, id);
				continue;
			}
			if (windowId) registry.closeWindow(windowId, dispatch.endedAt ?? now);
			// First seen already finished (it started and ended between two reports): its whole run is one window.
			else
				registry.recordShell({
					sessionKey,
					runId,
					startedAt: dispatch.startedAt,
					endedAt: dispatch.endedAt ?? now,
					kind: "agent",
				});
			this.markDispatchEnded(dispatch.id);
		}
		for (const [id, windowId] of this.openDispatches) {
			if (reported.has(id)) continue;
			registry.closeWindow(windowId, now);
			this.markDispatchEnded(id);
		}
	}

	private markDispatchEnded(id: string): void {
		this.openDispatches.delete(id);
		this.endedDispatches.add(id);
		// Dispatch ids never repeat; the set only stops the final report of a wave from being recorded twice.
		if (this.endedDispatches.size > 500) {
			const oldest = this.endedDispatches.values().next().value;
			if (oldest !== undefined) this.endedDispatches.delete(oldest);
		}
	}

	private publishClaim(runId: number, rel: string, tool: FileMutationTool, at: number): void {
		const sessionKey = this.sessionKeyProvider?.();
		if (!this.changeClaims || !sessionKey) return;
		this.changeClaims.record({ sessionKey, runId, path: path.resolve(this.cwd, rel), at, tool });
	}

	recordBash(runId: number): void {
		const record = this.runs.get(runId);
		if (record) record.bashRuns += 1;
	}

	recordGitHeadOp(runId: number): void {
		const record = this.runs.get(runId);
		if (record) record.gitHeadOps += 1;
	}

	finishRun(
		runId: number,
		detection: ChangeDetectionResult | undefined,
		checkpoint: GitCheckpoint | undefined,
	): RunChangeRecord | undefined {
		const record = this.runs.get(runId);
		if (!record) return undefined;
		record.endedAt = Date.now();
		if (detection) {
			record.reliability = detection.status;
			record.changes = [...(detection.workingChanges ?? detection.changes)];
			record.commitDelta = detection.commitDelta;
			if (detection.status === "indeterminate") record.reason = detection.reason;
			record.git = detection.git;
			this.mergeToolChanges(runId, record);
		} else {
			// Fall back to observed edit/write/apply_patch/apply_rename operations so the run reports real file writes.
			record.reliability = "indeterminate";
			record.reason = "Final change detection was unavailable; showing files touched by edit/write only.";
			this.mergeToolChanges(runId, record);
		}
		this.closeOpenActivities(runId, record.endedAt ?? Date.now());
		this.attributeChanges(record);
		if (checkpoint) {
			this.checkpoints.set(runId, checkpoint);
			record.checkpointId = checkpoint.id;
			record.checkpointStatus = checkpoint.status;
		}
		return record;
	}

	/**
	 * edit/write/apply_patch/apply_rename calls are observed directly (before/after content). Final change detection
	 * does not cover them when Git integration is off and no shell command ran, so add the net effect here.
	 */
	private mergeToolChanges(runId: number, record: RunChangeRecord): void {
		record.changes.push(...this.toolChangesBeyond(runId, record, record.changes));
	}

	/** The net effect of the run's own file tool calls on the files `changes` does not list yet. */
	private toolChangesBeyond(runId: number, record: RunChangeRecord, changes: readonly ReviewChange[]): ReviewChange[] {
		const known = new Set(changes.map((change) => change.path));
		const snapshots = this.snapshots.get(runId);
		const found: ReviewChange[] = [];
		for (const op of record.toolFileOps) {
			if (!op.ok || known.has(op.path)) continue;
			const snapshot = snapshots?.get(op.path);
			const absolute = path.resolve(this.cwd, op.path);
			const exists = existsSync(absolute);
			if (!snapshot) {
				known.add(op.path);
				found.push({ path: op.path, status: exists ? "modified" : "deleted" });
				continue;
			}
			const after = readTextIfSmall(absolute);
			if (snapshot.before === null && !exists) continue;
			if (snapshot.before !== null && after.text === snapshot.before && exists) continue;
			known.add(op.path);
			found.push({
				path: op.path,
				status: snapshot.before === null ? "added" : exists ? "modified" : "deleted",
			});
		}
		return found;
	}

	/**
	 * Keep only the changes this run can explain (see attributeRunChanges in change-claims.ts): its own file
	 * operations, and files last written inside one of this session's windows. The others were changed by another
	 * conversation or another program while the run went on; they leave the card and are listed under it.
	 */
	private attributeChanges(record: RunChangeRecord): void {
		if (record.changes.length === 0) return;
		const { kept, elsewhere } = this.attributed(record, record.changes);
		record.changes = kept;
		if (elsewhere.length > 0) record.elsewhere = elsewhere;
	}

	/** `changes` split into the ones the run can explain and the ones changed elsewhere; all kept without a registry. */
	private attributed(
		record: RunChangeRecord,
		changes: readonly ReviewChange[],
	): { kept: ReviewChange[]; elsewhere: ChangedElsewhere[] } {
		const sessionKey = this.sessionKeyProvider?.();
		if (!this.changeClaims || !sessionKey || changes.length === 0) return { kept: [...changes], elsewhere: [] };
		const ownPaths = new Set(
			record.toolFileOps.filter((op) => op.ok).map((op) => pathIdentityKey(path.resolve(this.cwd, op.path))),
		);
		return attributeRunChanges(changes, {
			registry: this.changeClaims,
			sessionKey,
			ownPaths,
			from: record.startedAt,
			to: record.endedAt ?? Date.now(),
			baseDir: this.cwd,
			modifiedAt: statModifiedAt,
		});
	}

	/**
	 * What a run that is still going on has changed so far, for the Changes panel: the files its own file tools changed,
	 * and, once the run has a Git checkpoint, everything that differs from it and that this session can explain (the same
	 * rule a finished run's card follows, applied up to now). In a folder without a checkpoint the files changed by
	 * commands are only found when the run ends, against its content baseline. The record is not touched.
	 */
	async liveRunChanges(runId: number, checkpoint: GitCheckpoint | undefined): Promise<ReviewChange[]> {
		const record = this.runs.get(runId);
		if (!record || record.endedAt !== undefined) return [];
		let detected: ReviewChange[] = [];
		if (checkpoint?.status === "created" && checkpoint.worktreeTree) {
			detected = await collectCheckpointChanges({ cwd: this.cwd, checkpoint }).catch(() => []);
		}
		// The run may have ended while Git was read: its card has the changes now.
		if (record.endedAt !== undefined) return [];
		const changes = [...detected, ...this.toolChangesBeyond(runId, record, detected)];
		return this.attributed(record, changes).kept;
	}

	/** The diff of one file a run changed and has not recorded yet (see liveRunChanges). */
	diffForLiveChange(
		runId: number,
		change: ReviewChange,
		checkpoint: GitCheckpoint | undefined,
	): { summary: FileChangeSummary; patch?: string } {
		return this.diffForChange(runId, change, checkpoint);
	}

	/**
	 * Reads what the run's changed files held before it from the Git checkpoint, several at a time, for the files no
	 * tool call captured (a command or another program of this chat changed them). The change card and the panel then
	 * find that content here instead of starting one blocking Git process per file while the page waits for the task
	 * to finish. A file whose earlier content cannot be read this way is left to the reader that explains why.
	 */
	async prefetchBefore(
		runId: number,
		checkpoint: GitCheckpoint | undefined,
		changes?: readonly ReviewChange[],
	): Promise<void> {
		const record = this.runs.get(runId);
		const snapshots = this.snapshots.get(runId);
		const source = this.checkpoints.get(runId) ?? checkpoint;
		const tree = source?.worktreeTree;
		if (!record || !snapshots || !source || !tree) return;
		const wanted = (changes ?? record.changes)
			.slice(0, MAX_FILES_WITH_STATS)
			.filter((change) => !snapshots.has(change.path));
		let next = 0;
		const worker = async () => {
			while (next < wanted.length) {
				const change = wanted[next++];
				const repoRelative = toRelative(
					source.repositoryRoot,
					path.resolve(this.cwd, change.oldPath ?? change.path),
				);
				if (!repoRelative) continue;
				const shown = await gitShowAsync(source.repositoryRoot, `${tree}:${repoRelative}`).catch(() => undefined);
				if (!shown || snapshots.has(change.path)) continue;
				// Not in the checkpoint's tree: a file the run created has no earlier content; any other is unknown.
				if (shown.text === null && !shown.binary && change.status !== "added") continue;
				const size = shown.text ? Buffer.byteLength(shown.text) : 0;
				const total = (this.snapshotBytes.get(runId) ?? 0) + size;
				if (total > MAX_SNAPSHOT_BYTES_PER_RUN) continue;
				this.snapshotBytes.set(runId, total);
				snapshots.set(change.path, { before: shown.text, binary: shown.binary });
			}
		};
		await Promise.all(Array.from({ length: Math.min(BEFORE_READ_PARALLEL, wanted.length) }, worker));
	}

	/** The calls of this run that never reported an end: their windows end with the run. */
	private closeOpenActivities(runId: number, endedAt: number): void {
		for (const [toolCallId, activity] of this.openActivities) {
			if (activity.runId === runId) this.endActivity(toolCallId, endedAt);
		}
	}

	private beforeFor(runId: number, change: ReviewChange, checkpoint: GitCheckpoint | undefined): BeforeContent {
		const snapshot = this.snapshots.get(runId)?.get(change.path);
		if (snapshot) return { text: snapshot.before, binary: snapshot.binary, known: true };
		if (checkpoint?.worktreeTree) {
			const repoRelative = toRelative(
				checkpoint.repositoryRoot,
				path.resolve(this.cwd, change.oldPath ?? change.path),
			);
			if (repoRelative) {
				const shown = gitShow(checkpoint.repositoryRoot, `${checkpoint.worktreeTree}:${repoRelative}`);
				if (shown.binary) return { text: null, binary: true, known: true };
				if (shown.text !== null) return { text: shown.text, binary: false, known: true };
				// Not in the baseline tree: the file was created during the run.
				if (change.status === "added") return { text: null, binary: false, known: true };
			}
		}
		if (change.status === "added") return { text: null, binary: false, known: true };
		return { text: null, binary: false, known: false };
	}

	/** Compute the diff for one file of a run. */
	diffForRunFile(
		runId: number,
		filePath: string,
		checkpoint: GitCheckpoint | undefined,
	): { summary: FileChangeSummary; patch?: string } | undefined {
		const record = this.runs.get(runId);
		const change = record?.changes.find((candidate) => candidate.path === filePath);
		if (!record || !change) return undefined;
		return this.diffForChange(runId, change, checkpoint);
	}

	private diffForChange(
		runId: number,
		change: ReviewChange,
		checkpoint: GitCheckpoint | undefined,
	): { summary: FileChangeSummary; patch?: string } {
		const effective = this.checkpoints.get(runId) ?? checkpoint;
		return this.diffFromBefore(
			change,
			this.beforeFor(runId, change, effective),
			effective ? UNAVAILABLE_WITH_CHECKPOINT : UNAVAILABLE_WITHOUT_CHECKPOINT,
		);
	}

	/** The diff of one changed file from the content it held before, against what is on disk now. */
	private diffFromBefore(
		change: ReviewChange,
		before: BeforeContent,
		unavailable: string,
	): { summary: FileChangeSummary; patch?: string } {
		const summary: FileChangeSummary = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
			additions: 0,
			deletions: 0,
			binary: false,
		};
		const absolute = path.resolve(this.cwd, change.path);
		const after =
			change.status === "deleted" ? { text: null, binary: false, tooLarge: false } : readTextIfSmall(absolute);
		if (before.binary || after.binary) {
			summary.binary = true;
			return { summary };
		}
		if (after.tooLarge) {
			summary.unavailable = "File is larger than 2 MB; content diff skipped.";
			return { summary };
		}
		if (!before.known) {
			summary.unavailable = unavailable;
			return { summary };
		}
		return textDiff(summary, before.text, after.text, change.oldPath ?? change.path);
	}

	summariseRun(runId: number, checkpoint: GitCheckpoint | undefined): FileChangeSummary[] {
		const record = this.runs.get(runId);
		if (!record) return [];
		return record.changes.slice(0, MAX_FILES_WITH_STATS).map((change, index) => {
			const diff = this.diffForRunFile(runId, change.path, checkpoint);
			void index;
			return (
				diff?.summary ?? {
					path: change.path,
					status: change.status,
					additions: 0,
					deletions: 0,
					binary: false,
				}
			);
		});
	}

	/**
	 * What a finished run changed, as its change card keeps it: every file with its counts and its diff as it is at this
	 * moment. Later runs change the same files again, so the diff is taken now and not when the card is opened.
	 */
	runChangeCard(runId: number, checkpoint: GitCheckpoint | undefined): RunChangeCardFile[] {
		const record = this.runs.get(runId);
		if (!record) return [];
		let kept = 0;
		return record.changes.slice(0, MAX_FILES_WITH_STATS).map((change): RunChangeCardFile => {
			const diff = this.diffForRunFile(runId, change.path, checkpoint);
			if (!diff) return { path: change.path, status: change.status, additions: 0, deletions: 0, binary: false };
			if (!diff.patch) return diff.summary;
			if (diff.patch.length > MAX_CARD_PATCH_CHARS || kept + diff.patch.length > MAX_CARD_PATCH_CHARS_PER_RUN) {
				return { ...diff.summary, patchOmitted: true };
			}
			kept += diff.patch.length;
			return { ...diff.summary, patch: diff.patch };
		});
	}

	/** Compare immutable Git versions, not the run's dirty starting tree or its ending disk contents. */
	async runCommitCard(runId: number): Promise<RunCommitCard | undefined> {
		const delta = this.runs.get(runId)?.commitDelta;
		if (!delta) return undefined;
		const changes = delta.changes.slice(0, MAX_FILES_WITH_STATS);
		const files: RunChangeCardFile[] = new Array(changes.length);
		let next = 0;
		let kept = 0;
		const worker = async () => {
			while (next < changes.length) {
				const index = next++;
				const change = changes[index];
				const summary: FileChangeSummary = { ...change, additions: 0, deletions: 0, binary: false };
				const repoPath = toRelative(delta.repositoryRoot, path.resolve(this.cwd, change.path));
				if (!repoPath) {
					files[index] = { ...summary, unavailable: "The committed content could not be read from Git." };
					continue;
				}
				const read = async (
					commit: string,
					absent: boolean,
				): Promise<{ text: string | null; binary: boolean; tooLarge?: boolean } | undefined> => {
					if (absent) return { text: null, binary: false };
					const spec = `${commit}:${repoPath}`;
					const size = await runGit(["cat-file", "-s", spec], { cwd: delta.repositoryRoot });
					if (!size.ok) return undefined;
					if (Number(size.stdout.trim()) > MAX_TEXT_BYTES) return { text: null, binary: false, tooLarge: true };
					const content = await gitShowAsync(delta.repositoryRoot, spec);
					return content.text !== null || content.binary ? content : undefined;
				};
				const [before, after] = await Promise.all([
					read(delta.before, change.status === "added"),
					read(delta.after, change.status === "deleted"),
				]);
				if (!before || !after)
					files[index] = { ...summary, unavailable: "The committed content could not be read from Git." };
				else if (before.binary || after.binary) files[index] = { ...summary, binary: true };
				else if (before.tooLarge || after.tooLarge)
					files[index] = { ...summary, unavailable: "File is larger than 2 MB; content diff skipped." };
				else {
					const { patch } = textDiff(summary, before.text, after.text, change.path);
					if (!patch) files[index] = summary;
					else if (patch.length > MAX_CARD_PATCH_CHARS || kept + patch.length > MAX_CARD_PATCH_CHARS_PER_RUN) {
						files[index] = { ...summary, patchOmitted: true };
					} else {
						kept += patch.length;
						files[index] = { ...summary, patch };
					}
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(BEFORE_READ_PARALLEL, changes.length) }, worker));
		return { runId, files };
	}

	/**
	 * The files a finished run left out because they were changed elsewhere, as its card keeps them: names and
	 * statuses only (never counted, no diffs), at most MAX_CARD_ELSEWHERE_FILES by name plus the full count.
	 */
	runChangeCardElsewhere(runId: number): { elsewhere?: ChangedElsewhere[]; elsewhereTotal?: number } {
		const elsewhere = this.runs.get(runId)?.elsewhere;
		if (!elsewhere?.length) return {};
		return {
			elsewhere: elsewhere.slice(0, MAX_CARD_ELSEWHERE_FILES),
			...(elsewhere.length > MAX_CARD_ELSEWHERE_FILES ? { elsewhereTotal: elsewhere.length } : {}),
		};
	}

	// ---------------------------------------------------------------------
	// A task cut into runs by new messages
	// ---------------------------------------------------------------------

	/** Whether runs a new message cut short have changes that still wait for the card of the task's last run. */
	hasDeferredRuns(): boolean {
		return this.chain.size > 0 || this.chainCommits.length > 0;
	}

	deferCommit(card: RunCommitCard): void {
		this.chainCommits.push({
			runId: card.runId,
			files: card.files.map((file) => {
				const { patch, ...summary } = file;
				if (!patch) return file;
				if (this.chainCommitChars + patch.length > MAX_CARD_PATCH_CHARS_PER_RUN)
					return { ...summary, patchOmitted: true };
				this.chainCommitChars += patch.length;
				return file;
			}),
		});
	}

	/**
	 * A finished run that a new message cut short (its outcome is "redirected"): the message goes on with the same task, so
	 * this run gets no card of its own. Its changes wait here, and the card of the task's last run (finishChain) lists the
	 * union of them, each file measured from what it held before the first run that changed it. Call it once the run's
	 * earlier content is read (prefetchBefore): the checkpoint of a later run starts after this run's own changes.
	 */
	deferRun(runId: number, checkpoint: GitCheckpoint | undefined): void {
		const record = this.runs.get(runId);
		if (!record) return;
		const source = this.checkpoints.get(runId) ?? checkpoint;
		// Paths a file moved away from in this run: the move already says it left (a tool call that names both ends can
		// list the old path again as deleted).
		const movedAway = new Set<string>();
		for (const change of record.changes.slice(0, MAX_FILES_WITH_STATS)) {
			if (change.status === "deleted" && movedAway.has(change.path)) continue;
			const existing = this.chain.get(change.path);
			if (existing) {
				existing.last = change;
				continue;
			}
			// A file moved in this run keeps the history of the path it came from.
			const from = change.oldPath ? this.chain.get(change.oldPath) : undefined;
			if (from) {
				this.chain.delete(from.path);
				movedAway.add(from.path);
				const first: ReviewChange =
					from.first.status === "added"
						? { path: change.path, status: "added" }
						: { path: change.path, status: "renamed", oldPath: from.first.oldPath ?? from.path };
				this.chain.set(change.path, { ...from, path: change.path, first, last: change });
				continue;
			}
			let before = this.beforeFor(runId, change, source);
			const size = before.text ? Buffer.byteLength(before.text) : 0;
			if (this.chainBytes + size > MAX_SNAPSHOT_BYTES_PER_RUN) before = { text: null, binary: false, known: false };
			else this.chainBytes += size;
			this.chain.set(change.path, {
				path: change.path,
				first: change,
				last: change,
				before,
				unavailable: source ? UNAVAILABLE_WITH_CHECKPOINT : UNAVAILABLE_WITHOUT_CHECKPOINT,
			});
		}
		// What another conversation or program changed meanwhile stays listed apart, never counted.
		for (const file of record.elsewhere ?? []) this.chainElsewhere.set(file.path, file);
	}

	/**
	 * The card of a task that a new message cut into runs, once its last run has ended: `runId` is that run (undefined when
	 * no run follows the cut, e.g. the new message was refused). Every file the runs changed appears once, with the diff from
	 * before the first run to what is on disk now; a file the runs changed and put back is left out. The held changes are
	 * released.
	 */
	finishChain(
		runId: number | undefined,
		checkpoint: GitCheckpoint | undefined,
	): {
		files: RunChangeCardFile[];
		commits?: RunCommitCard[];
		elsewhere?: ChangedElsewhere[];
		elsewhereTotal?: number;
	} {
		if (runId !== undefined) this.deferRun(runId, checkpoint);
		const files: RunChangeCardFile[] = [];
		let kept = 0;
		for (const entry of [...this.chain.values()].slice(0, MAX_FILES_WITH_STATS)) {
			const change = mergeChainChange(entry);
			if (!change) continue;
			const diff = this.diffFromBefore(change, entry.before, entry.unavailable);
			const { summary } = diff;
			// Changed and changed back: nothing is left of it.
			if (
				change.status === "modified" &&
				!summary.binary &&
				!summary.unavailable &&
				!summary.lineEndingsOnly &&
				summary.additions === 0 &&
				summary.deletions === 0
			) {
				continue;
			}
			if (!diff.patch) {
				files.push(summary);
			} else if (
				diff.patch.length > MAX_CARD_PATCH_CHARS ||
				kept + diff.patch.length > MAX_CARD_PATCH_CHARS_PER_RUN
			) {
				files.push({ ...summary, patchOmitted: true });
			} else {
				kept += diff.patch.length;
				files.push({ ...summary, patch: diff.patch });
			}
		}
		const own = new Set(files.map((file) => file.path));
		const elsewhere = [...this.chainElsewhere.values()].filter((file) => !own.has(file.path));
		const commits = this.chainCommits.slice();
		this.clearChain();
		return {
			files,
			...(commits.length > 0 ? { commits } : {}),
			...(elsewhere.length > 0 ? { elsewhere: elsewhere.slice(0, MAX_CARD_ELSEWHERE_FILES) } : {}),
			...(elsewhere.length > MAX_CARD_ELSEWHERE_FILES ? { elsewhereTotal: elsewhere.length } : {}),
		};
	}

	private clearChain(): void {
		this.chain.clear();
		this.chainElsewhere.clear();
		this.chainBytes = 0;
		this.chainCommits.length = 0;
		this.chainCommitChars = 0;
	}

	// ---------------------------------------------------------------------
	// Working tree (all uncommitted changes versus HEAD)
	// ---------------------------------------------------------------------

	invalidateWorktreeCache(): void {
		invalidateWorktreeCache(this.cwd);
	}

	async batchWorktreeStats(repositoryRoot: string, changes: readonly ReviewChange[]): Promise<FileChangeSummary[]> {
		return batchWorktreeStats(repositoryRoot, this.cwd, changes, (root, change) =>
			this.diffForWorktreeFile(root, change),
		);
	}

	// The working-tree view runs Git asynchronously: a large or slow repository must not stall the Web server.
	// 列表读取短 TTL 缓存 + 同 checkout 在途合并；`fresh` 强制重验且不加入旧的在途查询。
	async listWorktreeChanges(options?: {
		forceRefresh?: boolean;
	}): Promise<{ repositoryRoot?: string; changes: ReviewChange[]; error?: string; cacheVersion?: number }> {
		if (!options?.forceRefresh) {
			const cached = getCachedWorktreeChangesSync(this.cwd);
			if (cached) {
				return {
					repositoryRoot: cached.repositoryRoot,
					changes: cached.changes,
					error: cached.error,
					cacheVersion: cached.version,
				};
			}
		}
		const fresh = options?.forceRefresh === true;
		return coalescedWorktreeListFetch(
			this.cwd,
			async () => {
				const state = await getCachedGitInspect(this.cwd, fresh ? { fresh: true } : undefined);
				if (!state.isRepository || !state.root) {
					return {
						changes: [],
						error: state.gitAvailable ? "The workspace is not a Git repository." : "Git is not available.",
					};
				}
				const result = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
					cwd: state.root,
					timeoutMs: 30_000,
					env: { GIT_OPTIONAL_LOCKS: "0" },
				});
				if (!result.ok) {
					return { repositoryRoot: state.root, changes: [], error: result.stderr || result.error };
				}
				const changes: ReviewChange[] = [];
				const fields = result.stdout.split("\u0000");
				for (let index = 0; index < fields.length; index++) {
					const field = fields[index];
					if (field.length < 4) continue;
					const x = field[0];
					const y = field[1];
					let file = field.slice(3);
					let oldPath: string | undefined;
					if (x === "R" || x === "C") {
						oldPath = fields[++index];
					}
					const absolute = path.join(state.root, file);
					const rel = toRelative(this.cwd, absolute);
					if (!rel) continue;
					file = rel;
					let status: ReviewChangeStatus = "modified";
					if (x === "?" || x === "A" || y === "A") status = "added";
					else if (x === "D" || y === "D") status = "deleted";
					else if (x === "R") status = "renamed";
					const oldRel = oldPath ? toRelative(this.cwd, path.join(state.root, oldPath)) : undefined;
					changes.push({ path: file, status, ...(oldRel ? { oldPath: oldRel } : {}) });
				}
				return { repositoryRoot: state.root, changes };
			},
			{ fresh },
		);
	}

	async diffForWorktreeFile(
		repositoryRoot: string,
		change: ReviewChange,
	): Promise<{ summary: FileChangeSummary; patch?: string }> {
		const summary: FileChangeSummary = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
			additions: 0,
			deletions: 0,
			binary: false,
		};
		const beforePath = toRelative(repositoryRoot, path.resolve(this.cwd, change.oldPath ?? change.path));
		const before =
			change.status === "added" || !beforePath
				? { text: null, binary: false }
				: await gitShowAsync(repositoryRoot, `HEAD:${beforePath}`);
		const after =
			change.status === "deleted"
				? { text: null, binary: false, tooLarge: false }
				: readTextIfSmall(path.resolve(this.cwd, change.path));
		if (before.binary || after.binary) {
			summary.binary = true;
			return { summary };
		}
		if (after.tooLarge) {
			summary.unavailable = "File is larger than 2 MB; content diff skipped.";
			return { summary };
		}
		return textDiff(summary, before.text, after.text, change.oldPath ?? change.path);
	}
}
