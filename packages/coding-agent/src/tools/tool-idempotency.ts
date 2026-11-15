/**
 * P2-11 idempotency keys for mutating tools (write / edit / bash only; read tools stay uncached).
 *
 * Key design: tool + NUL + sessionScope + NUL + sha256(stableStringify(normalizedArgs)).
 * - `sessionScope` keeps one session from replaying another session's result (falls back to
 *   the tool's creation cwd when no session id is reachable, the same fallback as the shell
 *   session scope). Entries never cross scopes.
 * - `normalizedArgs` are the execution parameters only: write {absolute file key, content},
 *   edit {absolute file key, edits}, bash {cwd, command}. Timeouts, background flags and
 *   presentation options are excluded so a retry with a different timeout still hits the key.
 * - `stableStringify` sorts object keys so semantically identical arguments hash identically
 *   regardless of key order in the model's JSON.
 *
 * Policy per tool (a repeat is skipped only while skipping it cannot change the outcome):
 * - write: identical path+content yields identical bytes, so the stored success result is
 *   replayed while the file is still exactly as that write left it. Once anything else has
 *   touched the file (another write or edit, a command, the user), the bytes are written again.
 * - edit: a repeated identical edit cannot apply twice while the file is as the first one left
 *   it (oldText is gone), so the repeat is answered as a duplicate without touching the
 *   filesystem. Once the file has changed since, the edit runs as any other.
 * - bash (foreground only): background jobs always start fresh (they return a taskId, never a
 *   result) and are never cached; an identical foreground command is answered as a duplicate
 *   without respawning only when it comes again in the same reply of the model (see
 *   `beginReply`). In a later reply the model has seen the first result and asks again on
 *   purpose (`git status` after an edit, the tests after a fix, `sleep` while it waits), so the
 *   command runs. Thrown outcomes (abort, timeout, non-zero exit) are never stored, so a failed
 *   command stays retryable and a timeout keeps counting as a failure.
 *
 * Bound: LRU cap of 200 entries; the oldest key is dropped. No timers, no cross-process state.
 */

import { createHash } from "node:crypto";

/** Maximum cached keys; each entry is one small result object, so the table stays trivial. */
export const MAX_IDEMPOTENCY_ENTRIES = 200;

/** Separator inside idempotency keys: NUL, which cannot appear in scopes carrying cwd paths. */
const KEY_SEPARATOR: string = String.fromCharCode(0);

/** Deterministic JSON with sorted object keys; handles the plain-data shapes tool args use. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/** sha256 hex of the stable argument rendering; the stored map key suffix. */
export function hashToolArgs(normalizedArgs: unknown): string {
	return createHash("sha256").update(stableStringify(normalizedArgs)).digest("hex");
}

/** Full idempotency key for one mutating call. Never reuse a key across tools or scopes. */
export function idempotencyKey(toolName: string, scope: string, normalizedArgs: unknown): string {
	return toolName + KEY_SEPARATOR + scope + KEY_SEPARATOR + hashToolArgs(normalizedArgs);
}

type CacheEntry = { result: unknown };

/**
 * Session-scoped store of completed mutating-tool results plus in-flight bash
 * executions. Single process-local instance is exported as `toolIdempotency`;
 * tests can construct their own.
 */
export class ToolIdempotencyCache {
	private readonly completed = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<unknown>>();
	private readonly replies = new Map<string, number>();

	/**
	 * A session starts a new reply of its model (one response and the tool calls in it). The session calls this;
	 * `replyOf` then tells a tool which reply its call belongs to.
	 */
	beginReply(sessionId: string): void {
		const next = (this.replies.get(sessionId) ?? 0) + 1;
		// Re-inserted so the map keeps the sessions used last; the oldest are dropped.
		this.replies.delete(sessionId);
		this.replies.set(sessionId, next);
		while (this.replies.size > MAX_IDEMPOTENCY_ENTRIES) {
			const oldest = this.replies.keys().next();
			if (oldest.done) break;
			this.replies.delete(oldest.value);
		}
	}

	/** The number of the session's current reply; 0 for a session that never announced one. */
	replyOf(sessionId: string): number {
		return this.replies.get(sessionId) ?? 0;
	}

	get(key: string): unknown | undefined {
		const entry = this.completed.get(key);
		if (!entry) return undefined;
		// Touch for LRU order.
		this.completed.delete(key);
		this.completed.set(key, entry);
		return entry.result;
	}

	has(key: string): boolean {
		return this.completed.has(key);
	}

	set(key: string, result: unknown): void {
		this.completed.delete(key);
		this.completed.set(key, { result });
		while (this.completed.size > MAX_IDEMPOTENCY_ENTRIES) {
			const oldest = this.completed.keys().next();
			if (oldest.done) break;
			this.completed.delete(oldest.value);
		}
	}

	/**
	 * Share one execution for concurrent identical foreground bash calls in the same turn.
	 * Sequential duplicates are handled by the completed table / duplicate refusal at the
	 * call sites; this only prevents two overlapping spawns of the same command.
	 */
	async runInflight<T>(key: string, start: () => Promise<T>): Promise<T> {
		const ongoing = this.inflight.get(key) as Promise<T> | undefined;
		if (ongoing) return ongoing;
		// A second caller with the same key always observes `ongoing` above and never
		// installs its own entry, so an unconditional delete on settle cannot remove a
		// newer execution.
		const execution = (async () => {
			try {
				return await start();
			} finally {
				this.inflight.delete(key);
			}
		})();
		this.inflight.set(key, execution);
		return execution;
	}

	/** Forget everything. Exposed for tests and session teardown. */
	clear(): void {
		this.completed.clear();
		this.inflight.clear();
		this.replies.clear();
	}

	/** Forget one key: what it stood for no longer holds. */
	delete(key: string): void {
		this.completed.delete(key);
	}

	/** How many completed keys are stored. Exposed for tests. */
	get size(): number {
		return this.completed.size;
	}
}

/** Process-local idempotency store shared by the write / edit / bash tools. */
export const toolIdempotency = new ToolIdempotencyCache();

/** Duplicate refusal body shared by edit and bash repeats. */
export function duplicateToolResultText(toolName: string): string {
	return toolName === "bash"
		? "Duplicate bash call: the same command already ran successfully earlier in this same reply and was not run again. Its output is in that call's result. To run it once more on purpose, call it again in your next reply."
		: `Duplicate ${toolName} call: the same change was already applied by an earlier call and the file has not changed since, so nothing was done.`;
}
