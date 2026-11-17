/**
 * Where the sub-agent copy pool keeps its reusable Git worktrees and their bookkeeping.
 *
 * The copies themselves live next to every other copy of the repository, `<agentDir>/worktrees/<repo>/`, under the
 * stable folder names `myharness-subagent-pool-<n>`; they are long-lived infrastructure, reused task after task, never
 * archived, never removed automatically. Their occupancy locks and state files live in
 * `<agentDir>/worktrees/subagent-pool/<repository id>/`. Pure path helpers only: no filesystem or Git access, so the
 * Web copy list and the pool share one definition.
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";

/** Folder name prefix of a pool copy; the number after it identifies the copy within its repository. */
export const SUBAGENT_POOL_SLOT_PREFIX = "myharness-subagent-pool-";
const POOL_SLOT_NAME_PATTERN = /^myharness-subagent-pool-(\d+)$/i;

/** Folder name of pool copy number `index` (1-based). */
export function subagentPoolSlotName(index: number): string {
	return `${SUBAGENT_POOL_SLOT_PREFIX}${index}`;
}

/** The copy number of a pool copy folder, or `undefined` when the folder is not a pool copy. */
export function subagentPoolSlotIndex(worktreePath: string): number | undefined {
	const match = POOL_SLOT_NAME_PATTERN.exec(basename(worktreePath.replace(/[\\/]+$/, "")));
	if (!match) return undefined;
	const index = Number(match[1]);
	return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

/** Whether a worktree folder is one of the pool's reusable copies. */
export function isSubagentPoolSlotPath(worktreePath: string): boolean {
	return subagentPoolSlotIndex(worktreePath) !== undefined;
}

/** Same folder-name rule as the copy manager (manager.ts `safePathSegment`), so pool copies sit with the others. */
function repositorySegment(mainWorktreePath: string): string {
	const segment = basename(mainWorktreePath.replace(/[\\/]+$/, ""))
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return segment || "repository";
}

/** Folder of pool copy `slotName` of the repository whose main worktree is `mainWorktreePath`. */
export function subagentPoolSlotPath(agentDir: string, mainWorktreePath: string, slotName: string): string {
	return join(agentDir, "worktrees", repositorySegment(mainWorktreePath), slotName);
}

/** Stable key of a repository (its main worktree path), used to keep each repository's pool state apart. */
export function subagentPoolRepositoryId(mainWorktreePath: string): string {
	return createHash("sha256").update(pathIdentityKey(mainWorktreePath)).digest("hex").slice(0, 16);
}

/** Directory with the occupancy locks and state files of one repository's pool. */
export function subagentPoolStateDir(agentDir: string, mainWorktreePath: string): string {
	return join(agentDir, "worktrees", "subagent-pool", subagentPoolRepositoryId(mainWorktreePath));
}

/** Occupancy lock file of one pool copy. */
export function subagentPoolLockPath(agentDir: string, mainWorktreePath: string, slotName: string): string {
	return join(subagentPoolStateDir(agentDir, mainWorktreePath), `${slotName}.lock`);
}

/** State file of one pool copy (what it was last synced to, whether it holds unmerged changes, warm-up). */
export function subagentPoolStatePath(agentDir: string, mainWorktreePath: string, slotName: string): string {
	return join(subagentPoolStateDir(agentDir, mainWorktreePath), `${slotName}.json`);
}
