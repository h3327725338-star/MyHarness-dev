/**
 * Occupancy locks for the reusable copies of the sub-agent copy pool (Git worktrees and non-Git file mirrors).
 *
 * One copy runs one task at a time. A lock is a small JSON file created with `wx` (exclusive create), so two
 * processes (two chats, the desktop app and a second MyHarness) can never take the same copy. A lock is stale, and is
 * taken over, when its owner process is gone or when the owner stopped refreshing it (its heartbeat is older than
 * {@link SLOT_LOCK_STALE_MS}): that covers a crash, a kill and a reused process id. Taking a stale lock over happens
 * under the pool's short mutex, so two processes cannot both reclaim the same lock.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** How often a held lock's file time is refreshed. */
export const SLOT_LOCK_HEARTBEAT_MS = 30_000;
/** A lock whose owner has not refreshed it for this long is stale, even when a process with its id exists. */
export const SLOT_LOCK_STALE_MS = 10 * 60_000;
/** The pool mutex is held only while copies are picked (milliseconds); one older than this was left by a crash. */
const POOL_MUTEX_STALE_MS = 60_000;
const POOL_MUTEX_WAIT_MS = 30_000;

export interface SlotLockOwner {
	version: 1;
	pid: number;
	host: string;
	token: string;
	acquiredAt: string;
	/** What holds the copy, for diagnostics ("task", "prewarm"). */
	purpose: string;
}

export interface SlotLock {
	path: string;
	token: string;
}

const heldLocks = new Map<string, SlotLock>();
let heartbeat: NodeJS.Timeout | undefined;

function ensureHeartbeat(): void {
	if (heartbeat || heldLocks.size === 0) return;
	heartbeat = setInterval(() => {
		const now = new Date();
		for (const lock of heldLocks.values()) {
			try {
				fs.utimesSync(lock.path, now, now);
			} catch {
				// A lock file removed behind our back is noticed when the copy is released.
			}
		}
	}, SLOT_LOCK_HEARTBEAT_MS);
	heartbeat.unref?.();
}

function stopHeartbeatIfIdle(): void {
	if (heldLocks.size > 0 || !heartbeat) return;
	clearInterval(heartbeat);
	heartbeat = undefined;
}

/** Whether a process with this id exists. An unknown error is taken as "alive": never steal on a guess. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function readOwner(lockPath: string): SlotLockOwner | undefined {
	try {
		const stat = fs.lstatSync(lockPath);
		if (!stat.isFile() || stat.size > 8192) return undefined;
		const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<SlotLockOwner>;
		if (value.version !== 1 || typeof value.pid !== "number" || typeof value.token !== "string") return undefined;
		return value as SlotLockOwner;
	} catch {
		return undefined;
	}
}

/**
 * Whether the lock at `lockPath` is held by a live owner. A missing file is free; a file that cannot be read is
 * treated as held until it is old enough to be a crash leftover.
 */
export function isSlotLockHeld(lockPath: string, now = Date.now()): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(lockPath);
	} catch {
		return false;
	}
	const age = now - stat.mtimeMs;
	const owner = readOwner(lockPath);
	if (!owner) return age < SLOT_LOCK_STALE_MS;
	if (age >= SLOT_LOCK_STALE_MS) return false;
	if (owner.host !== hostname()) return true;
	if (owner.pid === process.pid) return heldLocks.get(lockPath)?.token === owner.token || age < SLOT_LOCK_STALE_MS;
	return isProcessAlive(owner.pid);
}

/**
 * Try to take the lock at `lockPath`. Returns the lock, or `undefined` when a live owner holds it. A stale lock is
 * removed and taken; callers do this under {@link withPoolMutex} so the takeover cannot race another process.
 */
export function tryAcquireSlotLock(lockPath: string, purpose: string): SlotLock | undefined {
	const token = randomBytes(12).toString("hex");
	const owner: SlotLockOwner = {
		version: 1,
		pid: process.pid,
		host: hostname(),
		token,
		acquiredAt: new Date().toISOString(),
		purpose,
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
			const lock = { path: lockPath, token };
			heldLocks.set(lockPath, lock);
			ensureHeartbeat();
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (isSlotLockHeld(lockPath)) return undefined;
			try {
				fs.unlinkSync(lockPath);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			}
		}
	}
	return undefined;
}

/** Release a lock this process holds. A lock file that now belongs to someone else is left alone. */
export function releaseSlotLock(lock: SlotLock): void {
	heldLocks.delete(lock.path);
	stopHeartbeatIfIdle();
	const owner = readOwner(lock.path);
	if (!owner || owner.token !== lock.token) return;
	try {
		fs.unlinkSync(lock.path);
	} catch {
		// Already gone: nothing to release.
	}
}

/**
 * Run `fn` while holding the pool's mutex (`<stateDir>/pool.mutex`). The mutex guards only the short step of picking
 * and locking copies, never the slow preparation of a copy, so waiting for it is brief. One left by a crash is taken
 * over once it is older than a minute.
 */
export async function withPoolMutex<T>(stateDir: string, fn: () => Promise<T> | T): Promise<T> {
	fs.mkdirSync(stateDir, { recursive: true });
	const mutexPath = join(stateDir, "pool.mutex");
	const deadline = Date.now() + POOL_MUTEX_WAIT_MS;
	const token = randomBytes(12).toString("hex");
	for (;;) {
		try {
			fs.writeFileSync(mutexPath, JSON.stringify({ pid: process.pid, host: hostname(), token }), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const stat = fs.statSync(mutexPath);
				stale = Date.now() - stat.mtimeMs > POOL_MUTEX_STALE_MS;
				if (!stale) {
					const owner = JSON.parse(fs.readFileSync(mutexPath, "utf8")) as { pid?: number; host?: string };
					stale = owner.host === hostname() && typeof owner.pid === "number" && !isProcessAlive(owner.pid);
				}
			} catch {
				// Vanished or half written: try again.
			}
			if (stale) {
				try {
					fs.unlinkSync(mutexPath);
				} catch {
					// Someone else took it over first.
				}
				continue;
			}
			if (Date.now() > deadline)
				throw new Error(`副本池正被另一个任务占用超过 ${POOL_MUTEX_WAIT_MS / 1000} 秒：${mutexPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			const owner = JSON.parse(fs.readFileSync(mutexPath, "utf8")) as { token?: string };
			if (owner.token === token) fs.unlinkSync(mutexPath);
		} catch {
			// Gone already.
		}
	}
}
