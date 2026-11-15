/**
 * Plan usage sources that extensions provide: what is left of a subscription plan's limits (the 5-hour window and the
 * weekly window) and when each resets, read from the program the plan belongs to (the Claude Code and agy plugins).
 *
 * A source only reports numbers: how much is left per window and when it resets. Reading them again, how often, and
 * what to say when the program is missing or an API key is in use are the source's own; this file keeps the list, hands
 * the numbers out in a form the browser can trust, and tells listeners when something changed.
 *
 * One registry per process, like the programs themselves: every chat, every sub-agent and the settings page see the
 * same sources. This file is a leaf (no imports) so the extension loader can register into it.
 */

/** The two kinds of limit a subscription plan counts: a rolling 5-hour window and a weekly one. */
export type PlanUsageWindowKind = "five_hour" | "weekly";

export interface PlanUsageWindow {
	kind: PlanUsageWindowKind;
	/** What is left of the window, 0 to 100. */
	leftPercent: number;
	/**
	 * When the window resets, in milliseconds since 1970. Unset for a window that has not started counting, or whose
	 * reset time is not known.
	 */
	resetsAt?: number;
}

/** The windows of one limit: the plan's limit across all models, or the limit of one pool of models. */
export interface PlanUsageGroup {
	/** Empty for the plan's limit across all models, otherwise the name of the pool or model. */
	label: string;
	/** The provider's model ids this limit applies to. Unset means all of them. */
	modelIds?: string[];
	windows: PlanUsageWindow[];
}

export interface PlanUsageSnapshot {
	groups: PlanUsageGroup[];
	/** When the groups were read, in milliseconds since 1970. */
	observedAt?: number;
	/** The program is being asked right now. */
	refreshing?: boolean;
	/** Why there are no numbers: the program is not installed, an API key is in use. */
	unavailable?: string;
	/** The last read failed; `groups` are the last ones read. */
	error?: string;
	/** The earliest time, in milliseconds since 1970, at which a refresh would really ask the program again. */
	nextRefreshAt?: number;
}

export interface PlanUsageSource {
	/** The provider's id: lowercase letters, digits and dashes (claude-code, agy). */
	id: string;
	/** The name shown beside the numbers. */
	label: string;
	/** What is known right now; never asks the program. */
	snapshot(): PlanUsageSnapshot;
	/**
	 * Read the numbers again when the newest reading is older than `maxAgeMs`. The source keeps its own minimum interval
	 * between two real reads. Must never reject: a failed read is reported through `snapshot().error`.
	 */
	refresh(options?: { maxAgeMs?: number }): Promise<void>;
}

/** What the browser is given for one source: its snapshot as it was cleaned up here, with the id and label. */
export interface PlanUsageSourceState extends PlanUsageSnapshot {
	id: string;
	label: string;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WINDOW_KINDS: readonly string[] = ["five_hour", "weekly"];
const sources = new Map<string, PlanUsageSource>();
const listeners = new Set<() => void>();

/** Tell every listener that some snapshot changed. A listener that throws must not keep the others from hearing it. */
function notify(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A failing listener is its own problem.
		}
	}
}

/**
 * Add a source, or replace the one of the same id (an extension is loaded again for every chat). Returns the function
 * the source calls whenever its snapshot changed; it stays valid after the chat that registered it is gone.
 */
export function registerPlanUsageSource(source: PlanUsageSource): () => void {
	const id: unknown = source?.id;
	if (typeof id !== "string" || !SOURCE_ID.test(id)) {
		throw new Error(`Invalid plan usage source id "${String(id)}".`);
	}
	if (
		typeof source.label !== "string" ||
		!source.label.trim() ||
		typeof source.snapshot !== "function" ||
		typeof source.refresh !== "function"
	) {
		throw new Error(`Plan usage source "${id}" needs a label, a snapshot function and a refresh function.`);
	}
	sources.set(id, source);
	notify();
	return () => notify();
}

export function unregisterPlanUsageSource(id: string): void {
	sources.delete(id);
	notify();
}

/** Every registered source, in the order they were first registered. */
export function listPlanUsageSources(): PlanUsageSource[] {
	return [...sources.values()];
}

/** Call `listener` after every change of the registry or of a snapshot. Returns the function that stops it. */
export function onPlanUsageChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function cleanWindows(value: unknown): PlanUsageWindow[] {
	if (!Array.isArray(value)) return [];
	const windows: PlanUsageWindow[] = [];
	for (const entry of value) {
		const kind: unknown = entry?.kind;
		const left = finiteNumber(entry?.leftPercent);
		if (typeof kind !== "string" || !WINDOW_KINDS.includes(kind) || left === undefined) continue;
		const resetsAt = finiteNumber(entry.resetsAt);
		windows.push({
			kind: kind as PlanUsageWindowKind,
			leftPercent: Math.min(100, Math.max(0, left)),
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}
	return windows;
}

function cleanGroups(value: unknown): PlanUsageGroup[] {
	if (!Array.isArray(value)) return [];
	const groups: PlanUsageGroup[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		groups.push({
			label: typeof entry.label === "string" ? entry.label : "",
			...(Array.isArray(entry.modelIds)
				? { modelIds: entry.modelIds.filter((id: unknown): id is string => typeof id === "string") }
				: {}),
			windows: cleanWindows(entry.windows),
		});
	}
	return groups;
}

function stateOf(source: PlanUsageSource): PlanUsageSourceState {
	const { id, label } = source;
	try {
		const snapshot = source.snapshot();
		const observedAt = finiteNumber(snapshot?.observedAt);
		const nextRefreshAt = finiteNumber(snapshot?.nextRefreshAt);
		const unavailable = nonEmptyString(snapshot?.unavailable);
		const error = nonEmptyString(snapshot?.error);
		return {
			id,
			label,
			groups: cleanGroups(snapshot?.groups),
			...(observedAt !== undefined ? { observedAt } : {}),
			...(typeof snapshot?.refreshing === "boolean" ? { refreshing: snapshot.refreshing } : {}),
			...(unavailable !== undefined ? { unavailable } : {}),
			...(error !== undefined ? { error } : {}),
			...(nextRefreshAt !== undefined ? { nextRefreshAt } : {}),
		};
	} catch (error) {
		return { id, label, groups: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * What the browser shows, one entry per source in registration order. A source is not trusted to hand over clean
 * numbers: percentages are clamped to 0-100, a window without a usable percentage or of an unknown kind is dropped, a
 * reset time that is not a finite number is dropped, and a source whose `snapshot()` throws shows its message as `error`.
 */
export function planUsageStates(): PlanUsageSourceState[] {
	return [...sources.values()].map(stateOf);
}

/**
 * Ask one source (or every source, in parallel) to read its numbers again. A source that fails is its own business:
 * the failure shows in its snapshot, never here.
 */
export async function refreshPlanUsage(options: { id?: string; maxAgeMs?: number } = {}): Promise<void> {
	const targets = options.id === undefined ? [...sources.values()] : [sources.get(options.id)];
	const request = options.maxAgeMs === undefined ? undefined : { maxAgeMs: options.maxAgeMs };
	await Promise.all(
		targets.map(async (source) => {
			try {
				await source?.refresh(request);
			} catch {
				// A source must not reject; if it does anyway, it must not fail the others or the caller.
			}
		}),
	);
}
