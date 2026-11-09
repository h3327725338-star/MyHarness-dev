/**
 * Cross-session attribution for workspace changes.
 *
 * Several conversations can be open on the same workspace at the same time, and
 * they share one filesystem and one Git state - with each other and with every
 * other program on the machine (another MyHarness process, an editor, another
 * coding agent). A run's final change detection compares the workspace against
 * its baseline, so it sees "what changed", not "who changed it".
 *
 * Every session records here what it did itself: direct file operations
 * (edit / write / apply_patch / apply_rename) with their paths, and the windows
 * during which it ran something that writes files without naming them - shell
 * commands, background jobs (until the job really ends), sub-agents and other
 * tools that may write. A finished run keeps only the detected changes it can
 * explain itself (see attributeRunChanges); the rest is listed as changed
 * elsewhere. An undo lists the files it would roll back that another
 * conversation changed, and the Changes panel asks who changed an uncommitted
 * file last (see session-ownership.ts).
 *
 * The registry is process-local: it knows the sessions of this app instance.
 * Another MyHarness process or any unrelated program leaves no record here,
 * which is why a run keeps a change only on evidence of its own.
 */

import { resolve } from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";

export interface ChangeClaim {
	sessionKey: string;
	runId: number;
	/** Absolute path of the file this session changed. */
	path: string;
	at: number;
	/** The tool that made the change, for diagnostics only. */
	tool: string;
}

/** What a window covers, for diagnostics and tests only. */
export type ActivityKind = "shell" | "job" | "agent" | "tool";

/**
 * A stretch of time during which a session ran something that may write files without naming them. The name is kept
 * from the time only shell commands were recorded.
 */
export interface ShellWindow {
	sessionKey: string;
	runId: number;
	startedAt: number;
	/** Undefined while the work still runs (a background job, a sub-agent or a tool call that has not ended). */
	endedAt?: number;
	kind?: ActivityKind;
}

/** Windows the registry does not store itself, read when needed (the background jobs of this process). */
export type WindowSource = () => Iterable<ShellWindow>;

export interface ChangeClaimRegistryOptions {
	windowSource?: WindowSource;
}

/** Records stay long enough to explain an old checkpoint's undo; the age window bounds memory. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_CLAIM_COUNT = 50_000;

/**
 * Slack around a window when a file's last write time is placed in it: file system time stamps are coarser than the
 * clock on some drives, and a command's last write can land just after the tool call reported its end.
 */
export const ATTRIBUTION_SLACK_MS = 2_000;

function covers(window: ShellWindow, at: number, slack: number): boolean {
	return window.startedAt - slack <= at && at <= (window.endedAt ?? Number.POSITIVE_INFINITY) + slack;
}

function overlaps(window: ShellWindow, from: number, to: number): boolean {
	return window.startedAt <= to && (window.endedAt ?? Number.POSITIVE_INFINITY) >= from;
}

export class ChangeClaimRegistry {
	private readonly claims = new Map<string, ChangeClaim[]>();
	private shellWindows: ShellWindow[] = [];
	/** Windows whose work has not ended yet, by the id their owner closes them with. */
	private readonly openWindows = new Map<string, ShellWindow>();
	private readonly windowSource: WindowSource | undefined;
	private claimCount = 0;
	private lastPruneAt = 0;

	constructor(options: ChangeClaimRegistryOptions = {}) {
		this.windowSource = options.windowSource;
	}

	record(claim: ChangeClaim): void {
		const key = pathIdentityKey(claim.path);
		const list = this.claims.get(key);
		if (list) list.push(claim);
		else this.claims.set(key, [claim]);
		this.claimCount += 1;
		this.maybePrune();
	}

	/** A finished window (its end is known). */
	recordShell(window: ShellWindow): void {
		this.shellWindows.push({ ...window, endedAt: Math.max(window.startedAt, window.endedAt ?? window.startedAt) });
		this.maybePrune();
	}

	/** A window that starts now and stays open until `closeWindow(id)`: other sessions see it while the work runs. */
	openWindow(id: string, window: Omit<ShellWindow, "endedAt">): void {
		this.openWindows.set(id, { ...window });
		this.maybePrune();
	}

	/** Ends an open window; an unknown id (never opened, or already closed) is ignored. */
	closeWindow(id: string, endedAt: number): void {
		const window = this.openWindows.get(id);
		if (!window) return;
		this.openWindows.delete(id);
		this.shellWindows.push({ ...window, endedAt: Math.max(window.startedAt, endedAt) });
	}

	/** Whether `id` names a window that is still open. */
	isWindowOpen(id: string): boolean {
		return this.openWindows.has(id);
	}

	/** Every window on record: finished, still open and the ones the source reports. */
	windows(): ShellWindow[] {
		const all = [...this.shellWindows, ...this.openWindows.values()];
		if (this.windowSource) {
			try {
				for (const window of this.windowSource()) all.push(window);
			} catch {
				// A failing source only loses its windows; the recorded ones still count.
			}
		}
		return all;
	}

	/** The newest direct change of `path` on record, whoever made it, or undefined when nobody recorded one. */
	latestClaim(path: string): ChangeClaim | undefined {
		const list = this.claims.get(pathIdentityKey(path));
		if (!list || list.length === 0) return undefined;
		let latest = list[0];
		for (const claim of list) if (claim.at > latest.at) latest = claim;
		return latest;
	}

	/** The windows of any session that cover `at`; something that session ran then may have written the file. */
	windowsCovering(at: number, slack = 0): ShellWindow[] {
		return this.windows().filter((window) => covers(window, at, slack));
	}

	/** Whether a session other than `sessionKey` claimed `path` at a time inside [from, to]. */
	foreignClaim(path: string, sessionKey: string, from: number, to: number): boolean {
		const list = this.claims.get(pathIdentityKey(path));
		if (!list) return false;
		for (const claim of list) {
			if (claim.sessionKey !== sessionKey && claim.at >= from && claim.at <= to) return true;
		}
		return false;
	}

	/** Whether a window of another session covers `at`. */
	foreignShellCovers(at: number, sessionKey: string, slack = 0): boolean {
		return this.windows().some((window) => window.sessionKey !== sessionKey && covers(window, at, slack));
	}

	/** Whether a window of this session covers `at`. */
	ownShellCovers(sessionKey: string, at: number, slack = 0): boolean {
		return this.windows().some((window) => window.sessionKey === sessionKey && covers(window, at, slack));
	}

	/**
	 * The candidates another session changed at or after `since` - by a direct
	 * file operation or inside one of its windows. Used before an undo:
	 * rolling the workspace back to an old checkpoint takes these changes with it.
	 */
	/** Whether `sessionKey` had a window (a call, a background job, a sub-agent dispatch) overlapping [from, to]. */
	hasWindowDuring(sessionKey: string, from: number, to: number): boolean {
		return this.windows().some((window) => window.sessionKey === sessionKey && overlaps(window, from, to));
	}

	foreignChangedSince<T extends { path: string; modifiedAt?: number }>(
		candidates: readonly T[],
		sessionKey: string,
		since: number,
	): T[] {
		const foreign: T[] = [];
		const windows = this.windows().filter((window) => window.sessionKey !== sessionKey);
		for (const candidate of candidates) {
			if (this.foreignClaim(candidate.path, sessionKey, since, Number.POSITIVE_INFINITY)) {
				foreign.push(candidate);
				continue;
			}
			const at = candidate.modifiedAt;
			if (at !== undefined && at >= since && windows.some((window) => covers(window, at, 0)))
				foreign.push(candidate);
		}
		return foreign;
	}

	private maybePrune(): void {
		const now = Date.now();
		if (
			this.claimCount <= PRUNE_CLAIM_COUNT &&
			this.shellWindows.length <= PRUNE_CLAIM_COUNT &&
			now - this.lastPruneAt < PRUNE_INTERVAL_MS
		) {
			return;
		}
		this.prune(now);
	}

	/** Drop records older than the retention window. Open windows stay until they are closed. */
	prune(now = Date.now()): void {
		this.lastPruneAt = now;
		const floor = now - RETENTION_MS;
		let count = 0;
		for (const [key, list] of this.claims) {
			const kept = list.filter((claim) => claim.at >= floor);
			count += kept.length;
			if (kept.length === 0) this.claims.delete(key);
			else if (kept.length !== list.length) this.claims.set(key, kept);
		}
		this.claimCount = count;
		this.shellWindows = this.shellWindows.filter((window) => (window.endedAt ?? now) >= floor);
	}
}

export interface AttributableChange {
	path: string;
	status: string;
}

/** Who made a change a run leaves out: another conversation of this app, or something outside it. */
export type ChangedElsewhereBy = "chat" | "outside";

/** A detected change that is not the run's own: shown under its card, never counted. */
export interface ChangedElsewhere {
	path: string;
	status: string;
	by: ChangedElsewhereBy;
}

export interface RunAttributionInput {
	registry: ChangeClaimRegistry;
	/** Identity of the session whose run is being attributed. */
	sessionKey: string;
	/** Identity keys of the files this run changed itself (successful file tool operations). */
	ownPaths: ReadonlySet<string>;
	/** The run's window. */
	from: number;
	to: number;
	/** Directory the change paths are relative to. */
	baseDir: string;
	/** Last write time of a file on disk, undefined when it cannot be read. */
	modifiedAt: (absolutePath: string) => number | undefined;
}

/**
 * Splits a run's detected changes into the ones the run can explain and the ones changed elsewhere.
 *
 * A change stays with the run when the run changed the file through its own file tools, or when the file's last write
 * falls inside one of this session's windows (a command, a background job, a sub-agent, another tool that may write).
 * Ambiguity keeps it: windows of two sessions that overlap, and a write time outside the run (a command that copies or
 * unpacks files keeps their old times) while the run had a window of its own. A deleted file has no write time, so it
 * stays when the run had any window. Everything else - another conversation's direct operation inside the run, or a
 * write inside the run while this session was not running anything that writes - was made elsewhere.
 */
export function attributeRunChanges<T extends AttributableChange>(
	changes: readonly T[],
	input: RunAttributionInput,
): { kept: T[]; elsewhere: ChangedElsewhere[] } {
	const { registry, sessionKey, ownPaths, from, to, baseDir, modifiedAt } = input;
	const slack = ATTRIBUTION_SLACK_MS;
	const windows = registry.windows();
	const own = windows.filter((window) => window.sessionKey === sessionKey);
	const foreign = windows.filter((window) => window.sessionKey !== sessionKey);
	const ownActive = own.some((window) => overlaps(window, from - slack, to + slack));
	const foreignActive = foreign.some((window) => overlaps(window, from - slack, to + slack));
	const kept: T[] = [];
	const elsewhere: ChangedElsewhere[] = [];
	const leave = (change: T, by: ChangedElsewhereBy) =>
		elsewhere.push({ path: change.path, status: change.status, by });
	for (const change of changes) {
		const absolute = resolve(baseDir, change.path);
		if (ownPaths.has(pathIdentityKey(absolute))) {
			kept.push(change);
			continue;
		}
		if (registry.foreignClaim(absolute, sessionKey, from, to)) {
			leave(change, "chat");
			continue;
		}
		if (change.status === "deleted") {
			if (ownActive) kept.push(change);
			else leave(change, foreignActive ? "chat" : "outside");
			continue;
		}
		const at = modifiedAt(absolute);
		if (at !== undefined && own.some((window) => covers(window, at, slack))) {
			kept.push(change);
			continue;
		}
		if (at !== undefined && at >= from - slack && at <= to + slack) {
			leave(change, foreign.some((window) => covers(window, at, slack)) ? "chat" : "outside");
			continue;
		}
		if (ownActive) kept.push(change);
		else leave(change, "outside");
	}
	return { kept, elsewhere };
}
