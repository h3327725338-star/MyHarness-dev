/**
 * The sub-agent copy pool of a Git workspace: a set of long-lived Git worktrees reused task after task.
 *
 * Why: creating a fresh worktree for every task wrote about two thousand files each time, and the antivirus scanned
 * all of them on the first wide search, so starting several sub-agents pegged the CPU. A pooled copy is created once,
 * read once while the computer is idle (prewarm), and afterwards only the files that differ from the previous task's
 * state are rewritten when it is synced to a new task.
 *
 * Rules (decided by the user):
 * - At dispatch the dispatching workspace is snapshotted once: its HEAD plus its uncommitted changes, written as one
 *   commit with a temporary index, so the workspace's own index and files are never touched. Every task of the batch
 *   starts from that same snapshot and does not see later edits.
 * - A task takes a free copy; when every copy is busy a new one is created at once. Nothing ever waits for a copy, and
 *   a new copy stays in the pool. Copies are never removed automatically.
 * - Before a copy is reused, changes a previous task left in it are saved as a Git commit (on that task's branch, or
 *   on a new `myharness-subagent-saved-*` branch), never discarded.
 * - Read tasks run detached and with the read-only tool set; write tasks get their own generated branch.
 * - Occupancy locks (slot-lock.ts) keep two processes off one copy and are taken back after a crash.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type GitCommandResult, runGit } from "../../git/repository/command.ts";
import { SUBAGENT_BRANCH_PREFIX, WorktreeArchiveRecords } from "../../git/worktrees/archive-records.ts";
import {
	isSubagentPoolSlotPath,
	subagentPoolLockPath,
	subagentPoolSlotIndex,
	subagentPoolSlotName,
	subagentPoolSlotPath,
	subagentPoolStateDir,
	subagentPoolStatePath,
} from "../../git/worktrees/pool-layout.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import { releaseSlotLock, type SlotLock, tryAcquireSlotLock, withPoolMutex } from "./slot-lock.ts";

const GIT_TIMEOUT_MS = 60_000;
/** A single uncommitted file larger than this stays out of the snapshot (reported in `importNotes`). */
const MAX_IMPORTED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_NOTES = 10;
const SNAPSHOT_COMMIT_MESSAGE = "myharness: workspace snapshot for sub-agent tasks";
const SAVED_CHANGES_MESSAGE = "myharness: unmerged changes a sub-agent task left in a pool copy, saved before reuse";
export const SAVED_CHANGES_BRANCH_PREFIX = "myharness-subagent-saved-";
const INTERNAL_COMMITTER_EMAIL = "myharness@example.invalid";
const INTERNAL_COMMITTER = ["-c", "user.name=MyHarness", "-c", `user.email=${INTERNAL_COMMITTER_EMAIL}`];

export type CopyAccess = "read" | "write";

/** The dispatching workspace at dispatch time, shared by every task of one batch. */
export interface WorkspaceSnapshot {
	/** Top level of the dispatching worktree. */
	repositoryRoot: string;
	/** Main worktree of the repository: the pool belongs to it. */
	mainPath: string;
	/** HEAD of the dispatching worktree. */
	baseCommit: string;
	/** The snapshot commit (HEAD itself when the workspace had no uncommitted changes). */
	commit: string;
	/** Uncommitted files carried into the snapshot. */
	importedFiles: number;
	/** Uncommitted paths that could not be carried over (and why); the workers are told. */
	importNotes: string[];
}

export interface PoolSlotState {
	version: 1;
	slotName: string;
	path: string;
	/** The copy holds changes of its last task that were not saved yet. */
	dirty: boolean;
	/** Branch the copy is on (write tasks), if any. */
	branch?: string;
	/** Snapshot commit the copy was last synced to. */
	syncedCommit?: string;
	/** Commit whose files were last read by the prewarm (the antivirus has seen them). */
	warmedCommit?: string;
	lastUsedAt?: string;
}

export interface PooledWorktreeHandle {
	/** Absolute path of the copy; the worker runs inside it. */
	worktreePath: string;
	slotName: string;
	access: CopyAccess;
	/** Generated branch of a write task. */
	branchName?: string;
	snapshot: WorkspaceSnapshot;
	agentDir: string;
	lock: SlotLock;
	/** The copy was created for this task (no free copy was available). */
	created: boolean;
	/** Changes a previous task left in this copy, saved as a commit before this task started. */
	savedChanges?: { branch: string; commit: string; files: number };
}

export interface PooledWorktreeReleaseResult {
	dirty: boolean;
	changedFiles: string[];
	error?: string;
}

function failure(step: string, result: GitCommandResult): string {
	return `${step}：${result.stderr.trim() || result.error || "未知错误"}`;
}

function git(
	args: string[],
	cwd: string,
	options: { env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal } = {},
) {
	return runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, ...options });
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lstatIfExists(target: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(target);
	} catch {
		return undefined;
	}
}

/** `rel` (a repository-relative path from Git) resolved under `root`, or undefined when it would leave `root`. */
function resolveUnder(root: string, rel: string): string | undefined {
	const target = resolve(root, rel);
	const within = relative(root, target);
	return within !== "" && !within.startsWith("..") && !isAbsolute(within) ? target : undefined;
}

/** `mainWorktreeOf` and the read-only calls of {@link createWorkspaceSnapshot} never refresh the workspace's index. */
const READ_ONLY_ENV = { GIT_OPTIONAL_LOCKS: "0" };

/** The main worktree is the first entry of `git worktree list --porcelain`. */
async function mainWorktreeOf(repositoryRoot: string, signal?: AbortSignal): Promise<string | undefined> {
	const listed = await git(["worktree", "list", "--porcelain"], repositoryRoot, { signal, env: READ_ONLY_ENV });
	if (!listed.ok) return undefined;
	const first = listed.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "));
	return first ? resolve(first.slice("worktree ".length).trim()) : undefined;
}

/** Registered worktree paths of the repository, as Git sees them. */
async function registeredWorktrees(mainPath: string): Promise<Set<string>> {
	const listed = await git(["worktree", "list", "--porcelain"], mainPath);
	const paths = new Set<string>();
	if (!listed.ok) return paths;
	for (const line of listed.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) paths.add(pathIdentityKey(resolve(line.slice("worktree ".length).trim())));
	}
	return paths;
}

/**
 * Snapshot the dispatching workspace: HEAD plus its uncommitted changes (modified, deleted and untracked files, as
 * they are on disk now; ignored files excluded), written as one commit through a temporary index file. The
 * workspace's own index, files and branches are left exactly as they are. Files that cannot be carried over
 * (symlinks, nested repositories or submodules, files over 50 MB) keep their committed version and are listed in
 * `importNotes`.
 */
export async function createWorkspaceSnapshot(
	cwd: string,
	agentDir: string,
	signal?: AbortSignal,
): Promise<{ ok: true; snapshot: WorkspaceSnapshot } | { ok: false; error: string }> {
	const toplevel = await git(["rev-parse", "--show-toplevel"], cwd, { signal, env: READ_ONLY_ENV });
	if (!toplevel.ok) return { ok: false, error: "当前工作区不是 Git 仓库，无法为子代理建立副本快照。" };
	const repositoryRoot = resolve(toplevel.stdout.trim());
	const head = await git(["rev-parse", "HEAD"], repositoryRoot, { signal, env: READ_ONLY_ENV });
	if (!head.ok) {
		return {
			ok: false,
			error: `子代理副本需要仓库至少有一个提交（git rev-parse HEAD 失败）：${head.stderr.trim() || head.error}`,
		};
	}
	const baseCommit = head.stdout.trim();
	const mainPath = (await mainWorktreeOf(repositoryRoot, signal)) ?? repositoryRoot;
	const snapshot: WorkspaceSnapshot = {
		repositoryRoot,
		mainPath,
		baseCommit,
		commit: baseCommit,
		importedFiles: 0,
		importNotes: [],
	};
	const status = await git(
		["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
		repositoryRoot,
		{ signal, env: READ_ONLY_ENV },
	);
	if (!status.ok) return { ok: false, error: `无法读取工作区的未提交改动：${status.stderr.trim() || status.error}` };
	const paths = [
		...new Set(
			status.stdout
				.split("\0")
				.filter((entry) => entry.length > 3)
				.map((entry) => entry.slice(3).replace(/\/+$/, "")),
		),
	];
	if (paths.length === 0) return { ok: true, snapshot };

	const skipped: string[] = [];
	const listed: string[] = [];
	for (const rel of paths) {
		const source = resolveUnder(repositoryRoot, rel);
		if (!source) {
			skipped.push(`${rel}：路径越出仓库`);
			continue;
		}
		const stat = lstatIfExists(source);
		if (!stat) {
			listed.push(rel); // deleted in the workspace: `--remove` drops it from the snapshot
		} else if (stat.isDirectory()) {
			if (!paths.some((other) => other !== rel && other.startsWith(`${rel}/`))) {
				skipped.push(`${rel}：是目录（子模块或嵌套仓库）`);
			}
		} else if (!stat.isFile()) {
			skipped.push(`${rel}：不是普通文件（符号链接等）`);
		} else if (stat.size > MAX_IMPORTED_FILE_BYTES) {
			skipped.push(`${rel}：文件超过 ${MAX_IMPORTED_FILE_BYTES / 1024 / 1024} MB`);
		} else {
			listed.push(rel);
			snapshot.importedFiles += 1;
		}
	}
	snapshot.importNotes = skipped.slice(0, MAX_IMPORT_NOTES);
	if (skipped.length > MAX_IMPORT_NOTES) {
		snapshot.importNotes.push(`另有 ${skipped.length - MAX_IMPORT_NOTES} 个未提交文件同样没有带入`);
	}
	if (listed.length === 0) return { ok: true, snapshot };

	const stateDir = subagentPoolStateDir(agentDir, mainPath);
	fs.mkdirSync(stateDir, { recursive: true });
	const indexFile = join(stateDir, `snapshot-index-${randomBytes(6).toString("hex")}`);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		const read = await git(["read-tree", baseCommit], repositoryRoot, { env, signal });
		if (!read.ok) return { ok: false, error: failure("无法建立工作区快照（git read-tree）", read) };
		const updated = await git(["update-index", "--add", "--remove", "-z", "--stdin"], repositoryRoot, {
			env,
			input: `${listed.join("\0")}\0`,
			signal,
		});
		if (!updated.ok) return { ok: false, error: failure("无法建立工作区快照（git update-index）", updated) };
		const tree = await git(["write-tree"], repositoryRoot, { env, signal });
		if (!tree.ok) return { ok: false, error: failure("无法建立工作区快照（git write-tree）", tree) };
		const headTree = await git(["rev-parse", `${baseCommit}^{tree}`], repositoryRoot, { signal, env: READ_ONLY_ENV });
		if (!headTree.ok) return { ok: false, error: failure("无法建立工作区快照（git rev-parse）", headTree) };
		// Nothing differs once Git has normalized the files (only line endings changed, for example).
		if (tree.stdout.trim() === headTree.stdout.trim()) return { ok: true, snapshot };
		const commit = await git(
			[...INTERNAL_COMMITTER, "commit-tree", tree.stdout.trim(), "-p", baseCommit, "-m", SNAPSHOT_COMMIT_MESSAGE],
			repositoryRoot,
			{ signal },
		);
		if (!commit.ok) return { ok: false, error: failure("无法建立工作区快照（git commit-tree）", commit) };
		snapshot.commit = commit.stdout.trim();
		return { ok: true, snapshot };
	} finally {
		fs.rmSync(indexFile, { force: true });
		fs.rmSync(`${indexFile}.lock`, { force: true });
	}
}

function readSlotState(agentDir: string, mainPath: string, slotName: string): PoolSlotState | undefined {
	try {
		const value = JSON.parse(
			fs.readFileSync(subagentPoolStatePath(agentDir, mainPath, slotName), "utf8"),
		) as PoolSlotState;
		return value?.version === 1 ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeSlotState(agentDir: string, mainPath: string, state: PoolSlotState): void {
	const target = subagentPoolStatePath(agentDir, mainPath, state.slotName);
	fs.mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
		fs.renameSync(temp, target);
	} catch (error) {
		// A state file that cannot be replaced must not leave a temp file behind on every attempt.
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

interface SlotCandidate {
	index: number;
	slotName: string;
	path: string;
	/** Folder and Git registration are intact. */
	valid: boolean;
	dirty: boolean;
	/** When the copy was last taken or given back (ISO time), if known. */
	lastUsedAt?: string;
}

/** Every pool copy of the repository: folders named like pool copies, valid when Git knows them and `.git` exists. */
async function listSlots(agentDir: string, mainPath: string): Promise<SlotCandidate[]> {
	const base = dirname(subagentPoolSlotPath(agentDir, mainPath, subagentPoolSlotName(1)));
	let names: string[] = [];
	try {
		names = fs.readdirSync(base);
	} catch {
		names = [];
	}
	const registered = await registeredWorktrees(mainPath);
	const slots: SlotCandidate[] = [];
	for (const name of names) {
		const path = join(base, name);
		const index = subagentPoolSlotIndex(path);
		if (index === undefined) continue;
		const valid = registered.has(pathIdentityKey(path)) && fs.existsSync(join(path, ".git"));
		const state = readSlotState(agentDir, mainPath, name);
		slots.push({ index, slotName: name, path, valid, dirty: state?.dirty === true, lastUsedAt: state?.lastUsedAt });
	}
	return slots.sort((left, right) => left.index - right.index);
}

/**
 * Save what a previous task left in a copy as a commit, so syncing the copy cannot lose it. The commit goes on the
 * branch the copy is on when that branch is one the pool itself created for a task, and on a new
 * `myharness-subagent-saved-*` branch otherwise (a branch of another tool is never moved). Internal plumbing only:
 * no hook runs, nothing is signed, and the dispatching workspace is not touched.
 */
async function saveLeftoverChanges(
	slotPath: string,
	files: number,
	ownBranch: string | undefined,
): Promise<{ ok: true; saved: { branch: string; commit: string; files: number } } | { ok: false; error: string }> {
	const added = await git(["add", "-A"], slotPath);
	if (!added.ok) return { ok: false, error: failure("无法保存副本里遗留的改动（git add）", added) };
	const tree = await git(["write-tree"], slotPath);
	if (!tree.ok) return { ok: false, error: failure("无法保存副本里遗留的改动（git write-tree）", tree) };
	const head = await git(["rev-parse", "HEAD"], slotPath);
	if (!head.ok) return { ok: false, error: failure("无法保存副本里遗留的改动（git rev-parse）", head) };
	const commit = await git(
		[...INTERNAL_COMMITTER, "commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", SAVED_CHANGES_MESSAGE],
		slotPath,
	);
	if (!commit.ok) return { ok: false, error: failure("无法保存副本里遗留的改动（git commit-tree）", commit) };
	// Only the task branch the pool itself recorded for this copy is moved to the saved commit. Any other branch
	// checked out in the copy (even one that merely shares the pool's name prefix) is left exactly where it is: the
	// saved commit (whose parent is the copy HEAD) goes to a new saved branch instead, so nothing is lost and nothing
	// foreign changes.
	const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], slotPath);
	const onOwnBranch = current.ok && ownBranch !== undefined && current.stdout.trim() === ownBranch;
	if (onOwnBranch) {
		const moved = await git(["update-ref", `refs/heads/${ownBranch}`, commit.stdout.trim()], slotPath);
		if (!moved.ok) return { ok: false, error: failure("无法保存副本里遗留的改动（git update-ref）", moved) };
		return { ok: true, saved: { branch: ownBranch, commit: commit.stdout.trim(), files } };
	}
	const created = await createSavedBranch(slotPath, commit.stdout.trim());
	if (!created.ok) return created;
	return { ok: true, saved: { branch: created.branch, commit: commit.stdout.trim(), files } };
}

/**
 * A new `myharness-subagent-saved-*` branch at `commit`. `update-ref` with an empty old value only creates the ref:
 * an existing ref of the same (random) name is never moved.
 */
async function createSavedBranch(
	slotPath: string,
	commit: string,
): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
	let last: Awaited<ReturnType<typeof git>> | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		const branch = `${SAVED_CHANGES_BRANCH_PREFIX}${randomBytes(5).toString("hex")}`;
		last = await git(["update-ref", `refs/heads/${branch}`, commit, ""], slotPath);
		if (last.ok) return { ok: true, branch };
	}
	return { ok: false, error: last ? failure("无法建立保存分支（git update-ref）", last) : "无法建立保存分支" };
}

/**
 * A copy can sit detached on a commit no branch names (a task committed without leaving its detached head) while
 * `git status` is clean: moving it to the next snapshot would drop that commit. This saves it under a fresh
 * `myharness-subagent-saved-*` branch, created with `update-ref` only when that ref does not exist yet — an existing
 * ref is never moved. `syncedCommit` (when known) is only used to count the changed files for the report.
 */
async function saveDetachedHead(
	slotPath: string,
	commit: string,
	syncedCommit: string | undefined,
): Promise<{ ok: true; branch: string; files: number } | { ok: false; error: string }> {
	let files = 0;
	if (syncedCommit) {
		const diff = await git(["diff", "--name-only", "-z", syncedCommit, commit], slotPath);
		if (diff.ok) files = new Set(diff.stdout.split("\0").filter(Boolean)).size;
	}
	const created = await createSavedBranch(slotPath, commit);
	if (!created.ok) return { ok: false, error: `无法为副本的游离 HEAD 建立保存分支：${created.error}` };
	return { ok: true, branch: created.branch, files };
}

/**
 * Whether some local branch already contains `commit` (a detached head that was only moved to an existing commit,
 * for example): such a commit cannot be lost by moving the copy, so it needs no saved branch. A failed lookup
 * answers `false`, which keeps the safe path of saving it.
 */
async function isNamedByBranch(slotPath: string, commit: string): Promise<boolean> {
	const listed = await git(
		["for-each-ref", "--contains", commit, "--count=1", "--format=%(refname)", "refs/heads/"],
		slotPath,
	);
	return listed.ok && listed.stdout.trim() !== "";
}

/**
 * Whether `commit` is one of the pool's own snapshot commits: it holds no task work (a copy whose state file was lost
 * sits detached on its last snapshot), so it needs no saved branch.
 */
async function isSnapshotCommit(slotPath: string, commit: string): Promise<boolean> {
	const subject = await git(["show", "-s", "--format=%s%x00%ce", commit], slotPath);
	return subject.ok && subject.stdout.trim() === `${SNAPSHOT_COMMIT_MESSAGE}\0${INTERNAL_COMMITTER_EMAIL}`;
}

async function changedPaths(slotPath: string): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
	// `--no-renames` keeps every entry self-contained: a rename is reported as its old and new paths instead of the
	// original path riding behind the new one as a bare token that path slicing would turn into garbage.
	const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], slotPath);
	if (!status.ok) return { ok: false, error: failure("无法读取副本状态", status) };
	const entries = status.stdout.split("\0").filter((entry) => entry.length > 3);
	return { ok: true, paths: [...new Set(entries.map((entry) => entry.slice(3)))] };
}

/** Delete a generated task branch that holds nothing beyond the snapshot it was created from. */
async function pruneEmptyTaskBranch(mainPath: string, branch: string | undefined, snapshotCommit: string | undefined) {
	if (!branch || !snapshotCommit || !branch.startsWith(SUBAGENT_BRANCH_PREFIX)) return;
	if (branch.startsWith(SAVED_CHANGES_BRANCH_PREFIX)) return;
	const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], mainPath);
	if (!tip.ok || tip.stdout.trim() !== snapshotCommit) return;
	await git(["branch", "-D", branch], mainPath);
}

/**
 * Lock the first unused copy number after every pool folder on disk. A number whose lock is held belongs to a copy
 * another process is creating right now, so it is skipped rather than waited for.
 */
function claimNewSlot(
	agentDir: string,
	mainPath: string,
	slots: readonly SlotCandidate[],
	purpose: string,
): { slot: { index: number; slotName: string; path: string }; lock: SlotLock } | undefined {
	const first = slots.reduce((max, slot) => Math.max(max, slot.index), 0) + 1;
	for (let index = first; index < first + 64; index++) {
		const slotName = subagentPoolSlotName(index);
		const path = subagentPoolSlotPath(agentDir, mainPath, slotName);
		if (fs.existsSync(path)) continue;
		const lock = tryAcquireSlotLock(subagentPoolLockPath(agentDir, mainPath, slotName), purpose);
		if (lock) return { slot: { index, slotName, path }, lock };
	}
	return undefined;
}

function recordPoolCopy(agentDir: string, worktreePath: string, branch: string | undefined): void {
	try {
		new WorktreeArchiveRecords(agentDir).update(worktreePath, {
			origin: "pool",
			archivedAt: undefined,
			reason: undefined,
			branch,
		});
	} catch {
		// The copy list only reads this record; a pool copy works without it.
	}
}

/**
 * Take one copy for a task: a free copy of the pool, or a new copy when all are busy. Then save whatever the copy's
 * previous task left in it, and sync it to the batch's snapshot (only files that differ are rewritten). Never waits for
 * a busy copy.
 */
export async function acquirePooledWorktree(options: {
	agentDir: string;
	snapshot: WorkspaceSnapshot;
	access: CopyAccess;
	signal?: AbortSignal;
}): Promise<{ ok: true; handle: PooledWorktreeHandle } | { ok: false; error: string }> {
	const { agentDir, snapshot } = options;
	const stateDir = subagentPoolStateDir(agentDir, snapshot.mainPath);
	let lastError = "";
	// A copy that turns out to be unusable (folder damaged by hand, for example) is skipped and the next one taken.
	const skip = new Set<string>();
	for (let attempt = 0; attempt < 4; attempt++) {
		options.signal?.throwIfAborted();
		const picking = withPoolMutex(stateDir, async () => {
			const slots = await listSlots(agentDir, snapshot.mainPath);
			// Clean copies first: a copy with leftover changes is reused only when no clean one is free, and then the one
			// left longest ago, so the Main Agent has had the most time to look at the changes in place.
			const dirty = slots
				.filter((slot) => slot.valid && slot.dirty)
				.sort((left, right) => (left.lastUsedAt ?? "").localeCompare(right.lastUsedAt ?? ""));
			const ordered = [...slots.filter((slot) => slot.valid && !slot.dirty), ...dirty];
			for (const slot of ordered) {
				if (skip.has(slot.slotName)) continue;
				const lock = tryAcquireSlotLock(subagentPoolLockPath(agentDir, snapshot.mainPath, slot.slotName), "task");
				if (lock) return { slot, lock, created: false };
			}
			// Every copy is busy (or none exists yet): a new one, numbered after every pool folder on disk.
			const fresh = claimNewSlot(agentDir, snapshot.mainPath, slots, "task");
			return fresh
				? { slot: { ...fresh.slot, valid: false, dirty: false }, lock: fresh.lock, created: true }
				: undefined;
		});
		let picked: Awaited<typeof picking>;
		try {
			picked = await picking;
		} catch (error) {
			// The pool mutex held too long by another process: report it like any other failure instead of rejecting.
			if (options.signal?.aborted) throw error;
			return { ok: false, error: `无法为子代理准备副本：${describeError(error)}` };
		}
		if (!picked) {
			lastError = "新副本的占用锁被抢先占用";
			continue;
		}
		let prepared: Awaited<ReturnType<typeof prepareSlot>>;
		try {
			prepared = await prepareSlot(agentDir, snapshot, picked.slot, options.access, picked.created);
		} catch (error) {
			// A step that throws (a state file that cannot be replaced, for example) must not reject with the slot lock
			// still held: the heartbeat would keep the copy locked forever. Treat it like any failed preparation.
			prepared = { ok: false, error: `准备副本时出错：${describeError(error)}` };
		}
		if (prepared.ok) {
			return {
				ok: true,
				handle: {
					worktreePath: picked.slot.path,
					slotName: picked.slot.slotName,
					access: options.access,
					branchName: prepared.branch,
					snapshot,
					agentDir,
					lock: picked.lock,
					created: picked.created,
					savedChanges: prepared.saved,
				},
			};
		}
		lastError = prepared.error;
		skip.add(picked.slot.slotName);
		releaseSlotLock(picked.lock);
		// Leftover changes that could not be saved make the copy unusable for now, but they stay where they are.
	}
	return { ok: false, error: `无法为子代理准备副本：${lastError}` };
}

async function prepareSlot(
	agentDir: string,
	snapshot: WorkspaceSnapshot,
	slot: SlotCandidate,
	access: CopyAccess,
	created: boolean,
): Promise<
	| { ok: true; branch?: string; saved?: { branch: string; commit: string; files: number } }
	| { ok: false; error: string }
> {
	const branch = access === "write" ? `${SUBAGENT_BRANCH_PREFIX}${randomBytes(5).toString("hex")}` : undefined;
	const previous = readSlotState(agentDir, snapshot.mainPath, slot.slotName);
	let saved: { branch: string; commit: string; files: number } | undefined;
	if (created || !slot.valid) {
		// A folder of that name with no worktree registration is not ours to reuse; the caller skips this number.
		if (fs.existsSync(slot.path) && !slot.valid && !created)
			return { ok: false, error: `副本目录已损坏：${slot.path}` };
		if (fs.existsSync(slot.path) && created) {
			return { ok: false, error: `副本目录已存在但不是 Git 副本：${slot.path}` };
		}
		fs.mkdirSync(dirname(slot.path), { recursive: true });
		// `--force` only lets Git reuse the registration of a copy whose folder was deleted by hand.
		const added = await git(
			["worktree", "add", "--force", ...(branch ? ["-b", branch] : ["--detach"]), slot.path, snapshot.commit],
			snapshot.mainPath,
		);
		if (!added.ok) return { ok: false, error: failure("创建副本失败（git worktree add）", added) };
	} else {
		const changes = await changedPaths(slot.path);
		if (!changes.ok) return { ok: false, error: changes.error };
		if (changes.paths.length > 0) {
			const result = await saveLeftoverChanges(slot.path, changes.paths.length, previous?.branch);
			if (!result.ok) return { ok: false, error: result.error };
			saved = result.saved;
		}
		if (!saved) {
			// The copy may also hold committed work that no branch names: a task that committed while its head was
			// detached. `git status` is clean then, but the sync below would move the copy away and drop that commit,
			// so it is saved under a fresh saved branch first (unless it is the snapshot itself, which never moves).
			const head = await git(["rev-parse", "HEAD"], slot.path);
			const onBranch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], slot.path);
			if (
				head.ok &&
				!onBranch.ok &&
				head.stdout.trim() !== snapshot.commit &&
				head.stdout.trim() !== previous?.syncedCommit &&
				!(await isNamedByBranch(slot.path, head.stdout.trim())) &&
				!(await isSnapshotCommit(slot.path, head.stdout.trim()))
			) {
				const preserved = await saveDetachedHead(slot.path, head.stdout.trim(), previous?.syncedCommit);
				if (!preserved.ok) return { ok: false, error: preserved.error };
				saved = { branch: preserved.branch, commit: head.stdout.trim(), files: preserved.files };
			}
		}
		// Only the files that differ between the copy's current commit and the snapshot are rewritten.
		const synced = await git(
			["checkout", "--force", "--quiet", ...(branch ? ["-B", branch] : ["--detach"]), snapshot.commit],
			slot.path,
		);
		if (!synced.ok) return { ok: false, error: failure("同步副本失败（git checkout）", synced) };
		if (previous?.branch && previous.branch !== saved?.branch) {
			await pruneEmptyTaskBranch(snapshot.mainPath, previous.branch, previous.syncedCommit);
		}
	}
	// A folder that was just created must not inherit the state of the copy that used to live here: when its folder
	// was deleted by hand, the old state file survives (a stale `warmedCommit`, for example) and would mark the fresh,
	// never-read folder as already warmed.
	writeSlotState(agentDir, snapshot.mainPath, {
		...(created
			? { version: 1 as const, slotName: slot.slotName, path: slot.path }
			: (previous ?? { version: 1 as const, slotName: slot.slotName, path: slot.path })),
		version: 1,
		slotName: slot.slotName,
		path: slot.path,
		dirty: false,
		branch,
		syncedCommit: snapshot.commit,
		lastUsedAt: new Date().toISOString(),
	});
	recordPoolCopy(agentDir, slot.path, branch);
	return { ok: true, branch, saved };
}

/**
 * Give a copy back after its task. Its files stay as the task left them: a write task's changes remain in the copy
 * (and on its branch) for the Main Agent to review, and are saved as a commit before the copy is used again. A clean
 * copy releases its generated branch. The copy itself always stays in the pool.
 */
export async function releasePooledWorktree(handle: PooledWorktreeHandle): Promise<PooledWorktreeReleaseResult> {
	const mainPath = handle.snapshot.mainPath;
	try {
		const changes = await changedPaths(handle.worktreePath);
		const head = await git(["rev-parse", "HEAD"], handle.worktreePath);
		const onBranch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], handle.worktreePath);
		// A commit made while the head was detached sits on no branch: the next sync would move the copy away and drop
		// it, even though `git status` is clean. Such a copy counts as holding leftover work.
		const detachedCommit = head.ok && !onBranch.ok && head.stdout.trim() !== handle.snapshot.commit;
		const dirty = !changes.ok || changes.paths.length > 0 || detachedCommit;
		let error = changes.ok ? undefined : `${changes.error}；副本按“有改动”保留`;
		let branch = handle.branchName;
		if (!dirty && handle.branchName) {
			const detached = await git(["checkout", "--detach", "--quiet"], handle.worktreePath);
			if (detached.ok) {
				await pruneEmptyTaskBranch(mainPath, handle.branchName, handle.snapshot.commit);
				branch = undefined;
			} else {
				error = failure("副本已归还，但释放分支失败", detached);
			}
		}
		const previous = readSlotState(handle.agentDir, mainPath, handle.slotName);
		writeSlotState(handle.agentDir, mainPath, {
			...(previous ?? { version: 1 as const, slotName: handle.slotName, path: handle.worktreePath }),
			version: 1,
			slotName: handle.slotName,
			path: handle.worktreePath,
			dirty,
			branch,
			syncedCommit: handle.snapshot.commit,
			lastUsedAt: new Date().toISOString(),
		});
		recordPoolCopy(handle.agentDir, handle.worktreePath, branch);
		return { dirty, changedFiles: changes.ok ? changes.paths : [], error };
	} catch (error) {
		return { dirty: true, changedFiles: [], error: `归还副本时出错，副本按“有改动”保留：${describeError(error)}` };
	} finally {
		releaseSlotLock(handle.lock);
	}
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Read files of a copy once, gently, so the antivirus scans them now instead of during the next dispatch. */
async function readFilesOnce(root: string, files: string[], signal?: AbortSignal): Promise<void> {
	let index = 0;
	for (const rel of files) {
		if (signal?.aborted) return;
		const target = resolveUnder(root, rel);
		if (!target) continue;
		try {
			const stat = fs.lstatSync(target);
			if (stat.isFile()) await fs.promises.readFile(target);
		} catch {
			// A file that vanished or cannot be read is simply skipped.
		}
		if (++index % 40 === 0) await sleep(15);
	}
}

/**
 * Bring the pool up to `size` copies and read the files of every idle copy the antivirus has not seen yet. Runs one
 * copy at a time and skips copies in use; meant for idle time (see copy-pool.ts).
 */
export async function prewarmWorktreePool(options: {
	agentDir: string;
	cwd: string;
	size: number;
	signal?: AbortSignal;
}): Promise<void> {
	const { agentDir, signal } = options;
	const toplevel = await git(["rev-parse", "--show-toplevel"], options.cwd, { signal });
	if (!toplevel.ok) return;
	const repositoryRoot = resolve(toplevel.stdout.trim());
	const head = await git(["rev-parse", "HEAD"], repositoryRoot, { signal });
	if (!head.ok) return;
	const mainPath = (await mainWorktreeOf(repositoryRoot, signal)) ?? repositoryRoot;
	const stateDir = subagentPoolStateDir(agentDir, mainPath);
	const commit = head.stdout.trim();
	// Grow the pool to `size` copies, one at a time.
	for (;;) {
		if (signal?.aborted) return;
		const slots = await listSlots(agentDir, mainPath);
		if (slots.filter((slot) => slot.valid).length >= options.size) break;
		const claimed = await withPoolMutex(stateDir, () => claimNewSlot(agentDir, mainPath, slots, "prewarm"));
		if (!claimed) return;
		const picked = { slotName: claimed.slot.slotName, path: claimed.slot.path, lock: claimed.lock };
		try {
			if (fs.existsSync(picked.path)) return;
			fs.mkdirSync(dirname(picked.path), { recursive: true });
			const added = await git(["worktree", "add", "--force", "--detach", picked.path, commit], mainPath, { signal });
			if (!added.ok) return;
			writeSlotState(agentDir, mainPath, {
				version: 1,
				slotName: picked.slotName,
				path: picked.path,
				dirty: false,
				syncedCommit: commit,
				lastUsedAt: new Date().toISOString(),
			});
			recordPoolCopy(agentDir, picked.path, undefined);
		} finally {
			releaseSlotLock(picked.lock);
		}
	}
	// Each idle copy: a clean one is first moved to the current commit (only files that differ are rewritten), so the
	// next dispatch has little left to sync; then the files not read yet are read: everything once, then only files
	// changed since. A copy holding a task's changes or a task branch is not moved.
	for (const slot of await listSlots(agentDir, mainPath)) {
		if (signal?.aborted) return;
		if (!slot.valid || !isSubagentPoolSlotPath(slot.path)) continue;
		const lock = await withPoolMutex(stateDir, () =>
			tryAcquireSlotLock(subagentPoolLockPath(agentDir, mainPath, slot.slotName), "prewarm"),
		);
		if (!lock) continue;
		try {
			let state = readSlotState(agentDir, mainPath, slot.slotName);
			if (state && !state.dirty && !state.branch && state.syncedCommit !== commit) {
				// Only a copy that really sits on its synced commit may be moved: a detached head elsewhere holds a
				// commit no branch names, and moving the copy would drop that commit.
				const head = await git(["rev-parse", "HEAD"], slot.path, { signal });
				const changes =
					head.ok && head.stdout.trim() === state.syncedCommit ? await changedPaths(slot.path) : undefined;
				if (changes?.ok && changes.paths.length === 0) {
					const moved = await git(["checkout", "--force", "--quiet", "--detach", commit], slot.path, { signal });
					if (moved.ok) {
						state = { ...state, syncedCommit: commit };
						writeSlotState(agentDir, mainPath, state);
					}
				}
			}
			const current = await git(["rev-parse", "HEAD"], slot.path, { signal });
			if (!current.ok) continue;
			const currentCommit = current.stdout.trim();
			if (state?.warmedCommit === currentCommit) continue;
			const listed = state?.warmedCommit
				? await git(["diff", "--name-only", "-z", state.warmedCommit, currentCommit], slot.path, { signal })
				: await git(["ls-files", "-z"], slot.path, { signal });
			if (!listed.ok) continue;
			await readFilesOnce(slot.path, listed.stdout.split("\0").filter(Boolean), signal);
			if (signal?.aborted) return;
			writeSlotState(agentDir, mainPath, {
				...(state ?? { version: 1 as const, slotName: slot.slotName, path: slot.path, dirty: false }),
				version: 1,
				warmedCommit: currentCommit,
			});
		} finally {
			releaseSlotLock(lock);
		}
	}
}

/** Whether the repository of `cwd` already has a pool (prewarm at session start only tops up an existing pool). */
export async function hasWorktreePool(agentDir: string, cwd: string): Promise<boolean> {
	const toplevel = await git(["rev-parse", "--show-toplevel"], cwd);
	if (!toplevel.ok) return false;
	const mainPath = (await mainWorktreeOf(resolve(toplevel.stdout.trim()))) ?? resolve(toplevel.stdout.trim());
	return fs.existsSync(subagentPoolStateDir(agentDir, mainPath));
}
