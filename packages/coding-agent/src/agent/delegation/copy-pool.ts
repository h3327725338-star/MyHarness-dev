/**
 * When the sub-agent copy pool is topped up and prewarmed.
 *
 * Prewarming creates the copies a pool is short of (up to the configured maximum number of parallel sub-agents) and
 * reads each copy's files once, so the antivirus scans them while the computer is idle instead of in the moment
 * several sub-agents start. It runs only when no dispatch of this process is using the pool, one copy at a time, and
 * stops as soon as a dispatch begins. A Git workspace whose pool does not exist yet is never prewarmed at session
 * start: the pool is created by the first dispatch, so a repository that never uses sub-agents gets no copies.
 */
import { runGit } from "../../git/repository/command.ts";
import { prewarmMirrorPool } from "./mirror-pool.ts";
import { hasWorktreePool, prewarmWorktreePool } from "./worktree-pool.ts";

/** Wait after a dispatch before prewarming, so a follow-up dispatch right after it is not slowed down. */
const PREWARM_DELAY_MS = 20_000;
/** When a dispatch is still running at the planned time, look again this much later. */
const PREWARM_RETRY_MS = 30_000;

let activeUses = 0;
const runningPrewarms = new Set<AbortController>();
const scheduled = new Map<string, NodeJS.Timeout>();

/** Mark the pool as in use by a dispatch; stops a running prewarm. Returns the function that ends the use. */
export function beginCopyPoolUse(): () => void {
	activeUses += 1;
	for (const controller of runningPrewarms) controller.abort();
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		activeUses = Math.max(0, activeUses - 1);
	};
}

export interface CopyPoolPrewarmRequest {
	agentDir: string;
	cwd: string;
	/** Whether `cwd` is a Git workspace; found out at prewarm time when not known. */
	isGit?: boolean;
	/** Copies the pool should hold: the configured maximum number of parallel sub-agents. */
	size: number;
	delayMs?: number;
	/** Only top up a pool that already exists (session start); a dispatch creates the pool itself. */
	onlyIfPoolExists?: boolean;
}

/** Plan one prewarm for this workspace after a quiet period; a newer request replaces a pending one. */
export function scheduleCopyPoolPrewarm(request: CopyPoolPrewarmRequest): void {
	if (process.env.MYHARNESS_DISABLE_COPY_POOL_PREWARM === "1") return;
	if (!Number.isFinite(request.size) || request.size < 1) return;
	const key = request.cwd;
	const pending = scheduled.get(key);
	if (pending) clearTimeout(pending);
	const timer = setTimeout(() => {
		scheduled.delete(key);
		if (activeUses > 0) {
			scheduleCopyPoolPrewarm({ ...request, delayMs: PREWARM_RETRY_MS });
			return;
		}
		void runPrewarm(request).catch(() => {
			// Prewarming is an optimization: a failure leaves the pool to be filled by the next dispatch.
		});
	}, request.delayMs ?? PREWARM_DELAY_MS);
	timer.unref?.();
	scheduled.set(key, timer);
}

/** `true` for a Git workspace, `false` for a plain folder, `undefined` when Git itself cannot tell. */
async function isGitWorkspace(cwd: string): Promise<boolean | undefined> {
	const result = await runGit(["rev-parse", "--show-toplevel"], {
		cwd,
		timeoutMs: 10_000,
		env: { LC_ALL: "C", LANG: "C" },
	});
	if (result.ok && result.stdout.trim()) return true;
	if (result.failureKind === "exit" && /not a git repository/i.test(result.stderr)) return false;
	return undefined;
}

async function runPrewarm(request: CopyPoolPrewarmRequest): Promise<void> {
	const controller = new AbortController();
	runningPrewarms.add(controller);
	try {
		const isGit = request.isGit ?? (await isGitWorkspace(request.cwd));
		if (isGit === undefined || controller.signal.aborted) return;
		if (isGit) {
			if (request.onlyIfPoolExists && !(await hasWorktreePool(request.agentDir, request.cwd))) return;
			await prewarmWorktreePool({
				agentDir: request.agentDir,
				cwd: request.cwd,
				size: request.size,
				signal: controller.signal,
			});
		} else {
			await prewarmMirrorPool({
				agentDir: request.agentDir,
				originCwd: request.cwd,
				size: request.size,
				signal: controller.signal,
				...(request.onlyIfPoolExists ? { onlyIfPoolExists: true } : {}),
			});
		}
	} finally {
		runningPrewarms.delete(controller);
	}
}
