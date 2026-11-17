import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquirePooledWorktree,
	createWorkspaceSnapshot,
	prewarmWorktreePool,
	releasePooledWorktree,
	SAVED_CHANGES_BRANCH_PREFIX,
} from "../src/agent/delegation/worktree-pool.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { WorktreeArchiveRecords } from "../src/git/worktrees/archive-records.ts";
import { subagentPoolLockPath, subagentPoolSlotPath, subagentPoolStatePath } from "../src/git/worktrees/pool-layout.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

const TIMEOUT = 120_000;

function temporaryDirectory(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function normalized(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

function createRepository(): { repoDir: string; commit: string } {
	const repoDir = temporaryDirectory("myharness-pool-repo");
	writeFileSync(join(repoDir, "a.txt"), "base\n", "utf8");
	writeFileSync(join(repoDir, "gone.txt"), "will be deleted\n", "utf8");
	expect(initializeGitRepository(repoDir).ok).toBe(true);
	expect(setLocalGitIdentity(repoDir, { name: "Pool Test", email: "pool-test@example.invalid" }).ok).toBe(true);
	expect(runGit(repoDir, ["config", "core.hooksPath", ""]).ok).toBe(true);
	expect(createInitialGitBaseline(repoDir).ok).toBe(true);
	return { repoDir, commit: runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim() };
}

function git(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	expect(result.ok, `git ${args.join(" ")}: ${result.stderr}`).toBe(true);
	return result.stdout.trim();
}

describe("sub-agent worktree copy pool", () => {
	const created: string[] = [];
	const repositories: string[] = [];

	function track(dir: string): string {
		created.push(dir);
		return dir;
	}

	afterEach(() => {
		// Copies are registered worktrees of the fixture repository: drop the registrations before deleting folders.
		for (const repo of repositories.splice(0)) runGit(repo, ["worktree", "prune"]);
		while (created.length > 0) {
			const dir = created.pop();
			if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	function setup() {
		const { repoDir, commit } = createRepository();
		track(repoDir);
		repositories.push(repoDir);
		const agentDir = track(temporaryDirectory("myharness-pool-agent"));
		return { repoDir, commit, agentDir };
	}

	it(
		"snapshots uncommitted changes without touching the workspace index or files",
		async () => {
			const { repoDir, commit, agentDir } = setup();
			writeFileSync(join(repoDir, "a.txt"), "edited in the workspace\n", "utf8");
			writeFileSync(join(repoDir, "new.txt"), "untracked\n", "utf8");
			unlinkSync(join(repoDir, "gone.txt"));
			git(repoDir, ["add", "a.txt"]);
			const statusBefore = git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
			const stagedBefore = git(repoDir, ["diff", "--cached", "--name-only"]);

			const result = await createWorkspaceSnapshot(repoDir, agentDir);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const { snapshot } = result;
			expect(snapshot.baseCommit).toBe(commit);
			expect(snapshot.commit).not.toBe(commit);
			expect(snapshot.importedFiles).toBe(2);
			expect(git(repoDir, ["rev-parse", `${snapshot.commit}^`])).toBe(commit);
			expect(normalized(git(repoDir, ["show", `${snapshot.commit}:a.txt`]))).toBe("edited in the workspace");
			expect(normalized(git(repoDir, ["show", `${snapshot.commit}:new.txt`]))).toBe("untracked");
			expect(runGit(repoDir, ["cat-file", "-e", `${snapshot.commit}:gone.txt`]).ok).toBe(false);

			// The workspace is exactly as it was: same status, same staged files, same HEAD.
			expect(git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
			expect(git(repoDir, ["diff", "--cached", "--name-only"])).toBe(stagedBefore);
			expect(git(repoDir, ["rev-parse", "HEAD"])).toBe(commit);
		},
		TIMEOUT,
	);

	it(
		"uses HEAD itself when there is nothing uncommitted",
		async () => {
			const { repoDir, commit, agentDir } = setup();
			const result = await createWorkspaceSnapshot(repoDir, agentDir);
			expect(result.ok && result.snapshot.commit).toBe(commit);
		},
		TIMEOUT,
	);

	it(
		"gives a write task its own branch, reuses a free copy, and creates a new one when all are busy",
		async () => {
			const { repoDir, agentDir } = setup();
			writeFileSync(join(repoDir, "a.txt"), "dispatch state\n", "utf8");
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);

			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!first.ok) throw new Error(first.error);
			expect(first.handle.created).toBe(true);
			expect(first.handle.branchName).toMatch(/^myharness-subagent-[0-9a-f]{10}$/);
			expect(
				pathIdentityKey(first.handle.worktreePath).startsWith(pathIdentityKey(join(agentDir, "worktrees"))),
			).toBe(true);
			expect(normalized(readFileSync(join(first.handle.worktreePath, "a.txt"), "utf8"))).toBe("dispatch state\n");
			expect(git(first.handle.worktreePath, ["status", "--porcelain"])).toBe("");
			expect(new WorktreeArchiveRecords(agentDir).get(first.handle.worktreePath)?.origin).toBe("pool");

			// The first copy is busy: the second task gets a new copy at once instead of waiting.
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.created).toBe(true);
			expect(second.handle.slotName).not.toBe(first.handle.slotName);
			expect(second.handle.branchName).toBeUndefined();
			expect(runGit(second.handle.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]).ok).toBe(false);

			const branch = first.handle.branchName as string;
			const released = await releasePooledWorktree(first.handle);
			expect(released).toEqual({ dirty: false, changedFiles: [], error: undefined });
			// A clean copy gives its empty task branch back; the copy itself stays.
			expect(runGit(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok).toBe(false);
			expect(existsSync(first.handle.worktreePath)).toBe(true);
			await releasePooledWorktree(second.handle);

			const third = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!third.ok) throw new Error(third.error);
			expect(third.handle.created).toBe(false);
			expect(third.handle.slotName).toBe(first.handle.slotName);
			expect(third.handle.savedChanges).toBeUndefined();
			await releasePooledWorktree(third.handle);
		},
		TIMEOUT,
	);

	it(
		"saves a previous task's leftover changes as a commit before syncing the copy to a new snapshot",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap1 = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap1.ok) throw new Error(snap1.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap1.snapshot, access: "write" });
			if (!first.ok) throw new Error(first.error);
			writeFileSync(join(first.handle.worktreePath, "a.txt"), "sub-agent change\n", "utf8");
			writeFileSync(join(first.handle.worktreePath, "added.txt"), "sub-agent file\n", "utf8");
			const released = await releasePooledWorktree(first.handle);
			expect(released.dirty).toBe(true);
			expect([...released.changedFiles].sort()).toEqual(["a.txt", "added.txt"]);
			const state = JSON.parse(
				readFileSync(subagentPoolStatePath(agentDir, repoDir, first.handle.slotName), "utf8"),
			) as { dirty: boolean; branch?: string };
			expect(state.dirty).toBe(true);
			expect(state.branch).toBe(first.handle.branchName);

			// The workspace moves on; the next task syncs the same copy to the new snapshot.
			writeFileSync(join(repoDir, "a.txt"), "workspace moved on\n", "utf8");
			const snap2 = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap2.ok) throw new Error(snap2.error);
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap2.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.slotName).toBe(first.handle.slotName);
			expect(second.handle.savedChanges).toEqual({
				branch: first.handle.branchName,
				commit: expect.any(String),
				files: 2,
			});
			const saved = second.handle.savedChanges?.commit as string;
			expect(git(repoDir, ["rev-parse", `refs/heads/${first.handle.branchName}`])).toBe(saved);
			expect(normalized(git(repoDir, ["show", `${saved}:a.txt`]))).toBe("sub-agent change");
			expect(normalized(git(repoDir, ["show", `${saved}:added.txt`]))).toBe("sub-agent file");
			// The copy now holds the new snapshot and nothing else.
			expect(normalized(readFileSync(join(second.handle.worktreePath, "a.txt"), "utf8"))).toBe(
				"workspace moved on\n",
			);
			expect(existsSync(join(second.handle.worktreePath, "added.txt"))).toBe(false);
			expect(git(second.handle.worktreePath, ["status", "--porcelain"])).toBe("");
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);

	it(
		"saves leftovers of a detached copy on a new saved-changes branch",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			writeFileSync(join(first.handle.worktreePath, "stray.txt"), "left behind\n", "utf8");
			expect((await releasePooledWorktree(first.handle)).dirty).toBe(true);
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!second.ok) throw new Error(second.error);
			const saved = second.handle.savedChanges;
			expect(saved?.branch.startsWith(SAVED_CHANGES_BRANCH_PREFIX)).toBe(true);
			expect(normalized(git(repoDir, ["show", `refs/heads/${saved?.branch}:stray.txt`]))).toBe("left behind");
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);

	it(
		"takes over the copy of a crashed process",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			await releasePooledWorktree(first.handle);
			// A lock left behind by a process that no longer exists.
			const lockPath = subagentPoolLockPath(agentDir, repoDir, first.handle.slotName);
			writeFileSync(
				lockPath,
				JSON.stringify({
					version: 1,
					pid: 2_147_483_000,
					host: hostname(),
					token: "crashed",
					acquiredAt: new Date().toISOString(),
					purpose: "task",
				}),
				"utf8",
			);
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.slotName).toBe(first.handle.slotName);
			expect(second.handle.created).toBe(false);
			await releasePooledWorktree(second.handle);
			expect(existsSync(lockPath)).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"does not take a copy whose owner is alive",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			await releasePooledWorktree(first.handle);
			const lockPath = subagentPoolLockPath(agentDir, repoDir, first.handle.slotName);
			// The parent of this test process is alive and is not this process.
			writeFileSync(
				lockPath,
				JSON.stringify({
					version: 1,
					pid: process.ppid,
					host: hostname(),
					token: "other-process",
					acquiredAt: new Date().toISOString(),
					purpose: "task",
				}),
				"utf8",
			);
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.slotName).not.toBe(first.handle.slotName);
			expect(second.handle.created).toBe(true);
			await releasePooledWorktree(second.handle);
			expect(existsSync(lockPath)).toBe(true);
			unlinkSync(lockPath);
		},
		TIMEOUT,
	);

	it(
		"prewarm grows the pool to the requested size and records what it read",
		async () => {
			const { repoDir, commit, agentDir } = setup();
			mkdirSync(join(repoDir, "sub"), { recursive: true });
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 2 });
			const listed = git(repoDir, ["worktree", "list", "--porcelain"])
				.split(/\r?\n/)
				.filter((line) => line.startsWith("worktree ") && line.includes("myharness-subagent-pool-"));
			expect(listed).toHaveLength(2);
			for (const slotName of ["myharness-subagent-pool-1", "myharness-subagent-pool-2"]) {
				const state = JSON.parse(readFileSync(subagentPoolStatePath(agentDir, repoDir, slotName), "utf8")) as {
					warmedCommit?: string;
					dirty: boolean;
				};
				expect(state.warmedCommit).toBe(commit);
				expect(state.dirty).toBe(false);
			}
			// A second run with the same size adds nothing.
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 2 });
			expect(
				git(repoDir, ["worktree", "list", "--porcelain"])
					.split(/\r?\n/)
					.filter((line) => line.startsWith("worktree ") && line.includes("myharness-subagent-pool-")),
			).toHaveLength(2);
		},
		TIMEOUT,
	);
	it(
		"prewarm moves clean idle copies to the new commit and leaves a copy with task changes alone",
		async () => {
			const { repoDir, agentDir } = setup();
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 2 });
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			// One copy keeps a task change; the other stays clean.
			const dirty = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!dirty.ok) throw new Error(dirty.error);
			writeFileSync(join(dirty.handle.worktreePath, "task.txt"), "task output\n", "utf8");
			expect((await releasePooledWorktree(dirty.handle)).dirty).toBe(true);
			const dirtyHead = git(dirty.handle.worktreePath, ["rev-parse", "HEAD"]);

			// The workspace gets a new commit while the pool is idle.
			writeFileSync(join(repoDir, "later.txt"), "committed later\n", "utf8");
			git(repoDir, ["add", "later.txt"]);
			git(repoDir, ["commit", "-q", "-m", "later"]);
			const newHead = git(repoDir, ["rev-parse", "HEAD"]);
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 2 });

			const cleanSlot = ["myharness-subagent-pool-1", "myharness-subagent-pool-2"].find(
				(name) => name !== dirty.handle.slotName,
			) as string;
			const cleanPath = join(dirty.handle.worktreePath, "..", cleanSlot);
			expect(git(cleanPath, ["rev-parse", "HEAD"])).toBe(newHead);
			expect(existsSync(join(cleanPath, "later.txt"))).toBe(true);
			const state = JSON.parse(readFileSync(subagentPoolStatePath(agentDir, repoDir, cleanSlot), "utf8")) as {
				warmedCommit?: string;
				syncedCommit?: string;
			};
			expect(state).toMatchObject({ warmedCommit: newHead, syncedCommit: newHead });
			// The copy with the task change was not moved.
			expect(git(dirty.handle.worktreePath, ["rev-parse", "HEAD"])).toBe(dirtyHead);
			expect(normalized(readFileSync(join(dirty.handle.worktreePath, "task.txt"), "utf8"))).toBe("task output\n");
		},
		TIMEOUT,
	);

	it(
		"reports a renamed file as its old and new paths, not a garbage token",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!first.ok) throw new Error(first.error);
			git(first.handle.worktreePath, ["mv", "a.txt", "renamed.txt"]);
			const released = await releasePooledWorktree(first.handle);
			expect(released.dirty).toBe(true);
			expect([...released.changedFiles].sort()).toEqual(["a.txt", "renamed.txt"]);
		},
		TIMEOUT,
	);

	it(
		"snapshotting does not rewrite the workspace index file",
		async () => {
			const { repoDir, agentDir } = setup();
			// Same content, fresh mtime: a plain `git status` would opportunistically refresh the index and rewrite it.
			writeFileSync(join(repoDir, "a.txt"), "base\n", "utf8");
			const touched = new Date(Date.now() + 60_000);
			utimesSync(join(repoDir, "a.txt"), touched, touched);
			writeFileSync(join(repoDir, "new.txt"), "untracked\n", "utf8");
			const indexPath = join(repoDir, ".git", "index");
			const before = createHash("sha256").update(readFileSync(indexPath)).digest("hex");

			const result = await createWorkspaceSnapshot(repoDir, agentDir);
			expect(result.ok).toBe(true);
			// A status that opportunistically refreshes the index would change this file.
			expect(createHash("sha256").update(readFileSync(indexPath)).digest("hex")).toBe(before);
		},
		TIMEOUT,
	);

	it(
		"saves a commit made on a detached head before syncing the copy to a new snapshot",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			// The task commits while its head is detached: no branch names that commit.
			writeFileSync(join(first.handle.worktreePath, "committed.txt"), "committed in the copy\n", "utf8");
			git(first.handle.worktreePath, ["add", "committed.txt"]);
			git(first.handle.worktreePath, ["commit", "-q", "-m", "copy commit"]);
			const copyHead = git(first.handle.worktreePath, ["rev-parse", "HEAD"]);

			const released = await releasePooledWorktree(first.handle);
			expect(released.dirty).toBe(true);

			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.slotName).toBe(first.handle.slotName);
			const saved = second.handle.savedChanges;
			expect(saved?.branch.startsWith(SAVED_CHANGES_BRANCH_PREFIX)).toBe(true);
			expect(saved?.commit).toBe(copyHead);
			expect(git(repoDir, ["rev-parse", `refs/heads/${saved?.branch}`])).toBe(copyHead);
			expect(normalized(git(repoDir, ["show", `${copyHead}:committed.txt`]))).toBe("committed in the copy");
			// The copy itself is synced back to the snapshot and clean.
			expect(existsSync(join(second.handle.worktreePath, "committed.txt"))).toBe(false);
			expect(git(second.handle.worktreePath, ["rev-parse", "HEAD"])).toBe(snap.snapshot.commit);
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);

	it(
		"saves leftovers of a copy on a foreign branch without moving that branch",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			// A branch some other tool checked out in the copy; the pool must never move it.
			git(first.handle.worktreePath, ["checkout", "-q", "-b", "foreign-task"]);
			const foreignTip = git(first.handle.worktreePath, ["rev-parse", "HEAD"]);
			writeFileSync(join(first.handle.worktreePath, "stray.txt"), "left behind\n", "utf8");
			expect((await releasePooledWorktree(first.handle)).dirty).toBe(true);

			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "write" });
			if (!second.ok) throw new Error(second.error);
			const saved = second.handle.savedChanges;
			expect(saved?.branch.startsWith(SAVED_CHANGES_BRANCH_PREFIX)).toBe(true);
			expect(git(repoDir, ["rev-parse", "refs/heads/foreign-task"])).toBe(foreignTip);
			expect(normalized(git(repoDir, ["show", `refs/heads/${saved?.branch}:stray.txt`]))).toBe("left behind");
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);

	it(
		"a failed preparation releases the slot lock instead of rejecting or leaking it",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			// A directory sitting where the state file belongs makes writeSlotState throw during preparation.
			for (const index of [1, 2, 3, 4]) {
				mkdirSync(subagentPoolStatePath(agentDir, repoDir, `myharness-subagent-pool-${index}`), {
					recursive: true,
				});
			}
			const result = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			expect(result.ok).toBe(false);
			// No copy is left locked by the heartbeat.
			for (const index of [1, 2, 3, 4]) {
				expect(existsSync(subagentPoolLockPath(agentDir, repoDir, `myharness-subagent-pool-${index}`))).toBe(false);
			}
		},
		TIMEOUT,
	);

	it(
		"a recreated slot folder does not inherit the old state's warmedCommit",
		async () => {
			const { repoDir, commit, agentDir } = setup();
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 1 });
			const slotName = "myharness-subagent-pool-1";
			const slotPath = subagentPoolSlotPath(agentDir, repoDir, slotName);
			expect(JSON.parse(readFileSync(subagentPoolStatePath(agentDir, repoDir, slotName), "utf8"))).toMatchObject({
				warmedCommit: commit,
			});
			// The folder is deleted by hand; its state file survives.
			rmSync(slotPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			writeFileSync(join(repoDir, "later.txt"), "committed later\n", "utf8");
			git(repoDir, ["add", "later.txt"]);
			git(repoDir, ["commit", "-q", "-m", "later"]);
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);

			const acquired = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!acquired.ok) throw new Error(acquired.error);
			expect(acquired.handle.slotName).toBe(slotName);
			expect(acquired.handle.created).toBe(true);
			const state = JSON.parse(readFileSync(subagentPoolStatePath(agentDir, repoDir, slotName), "utf8")) as {
				warmedCommit?: string;
			};
			expect(state.warmedCommit).toBeUndefined();
			await releasePooledWorktree(acquired.handle);
			// The fresh folder really gets read now instead of being skipped as already warm.
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 1 });
			expect(
				(
					JSON.parse(readFileSync(subagentPoolStatePath(agentDir, repoDir, slotName), "utf8")) as {
						warmedCommit?: string;
					}
				).warmedCommit,
			).toBe(snap.snapshot.commit);
		},
		TIMEOUT,
	);

	it(
		"prewarm leaves a detached copy whose head is not its synced commit alone",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			writeFileSync(join(first.handle.worktreePath, "committed.txt"), "committed in the copy\n", "utf8");
			git(first.handle.worktreePath, ["add", "committed.txt"]);
			git(first.handle.worktreePath, ["commit", "-q", "-m", "copy commit"]);
			const copyHead = git(first.handle.worktreePath, ["rev-parse", "HEAD"]);
			// The lock has to be free so that prewarm can take the copy and try to move it.
			await releasePooledWorktree(first.handle);
			// A state file in the older format, which does not know about the detached commit.
			writeFileSync(
				subagentPoolStatePath(agentDir, repoDir, first.handle.slotName),
				JSON.stringify({
					version: 1,
					slotName: first.handle.slotName,
					path: first.handle.worktreePath,
					dirty: false,
					syncedCommit: snap.snapshot.commit,
				}),
				"utf8",
			);
			// The workspace gets a new commit, so prewarm would like to move the copy onto it.
			writeFileSync(join(repoDir, "later.txt"), "committed later\n", "utf8");
			git(repoDir, ["add", "later.txt"]);
			git(repoDir, ["commit", "-q", "-m", "later"]);
			await prewarmWorktreePool({ agentDir, cwd: repoDir, size: 1 });
			expect(git(first.handle.worktreePath, ["rev-parse", "HEAD"])).toBe(copyHead);
			expect(normalized(readFileSync(join(first.handle.worktreePath, "committed.txt"), "utf8"))).toBe(
				"committed in the copy\n",
			);
		},
		TIMEOUT,
	);
	it(
		"never moves a branch that only shares the pool name prefix",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			git(first.handle.worktreePath, ["checkout", "-q", "-b", "myharness-subagent-user-branch"]);
			const tip = git(first.handle.worktreePath, ["rev-parse", "HEAD"]);
			writeFileSync(join(first.handle.worktreePath, "stray.txt"), "left behind\n", "utf8");
			expect((await releasePooledWorktree(first.handle)).dirty).toBe(true);
			const second = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.savedChanges?.branch.startsWith(SAVED_CHANGES_BRANCH_PREFIX)).toBe(true);
			expect(git(repoDir, ["rev-parse", "refs/heads/myharness-subagent-user-branch"])).toBe(tip);
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);

	it(
		"does not save a snapshot commit as work when the state file was lost",
		async () => {
			const { repoDir, agentDir } = setup();
			const snap = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!snap.ok) throw new Error(snap.error);
			const first = await acquirePooledWorktree({ agentDir, snapshot: snap.snapshot, access: "read" });
			if (!first.ok) throw new Error(first.error);
			await releasePooledWorktree(first.handle);
			unlinkSync(subagentPoolStatePath(agentDir, repoDir, first.handle.slotName));
			writeFileSync(join(repoDir, "later.txt"), "committed later\n", "utf8");
			git(repoDir, ["add", "later.txt"]);
			git(repoDir, ["commit", "-q", "-m", "later"]);
			const next = await createWorkspaceSnapshot(repoDir, agentDir);
			if (!next.ok) throw new Error(next.error);
			const second = await acquirePooledWorktree({ agentDir, snapshot: next.snapshot, access: "read" });
			if (!second.ok) throw new Error(second.error);
			expect(second.handle.slotName).toBe(first.handle.slotName);
			expect(second.handle.savedChanges).toBeUndefined();
			expect(
				git(repoDir, ["for-each-ref", "--format=%(refname)", `refs/heads/${SAVED_CHANGES_BRANCH_PREFIX}*`]),
			).toBe("");
			await releasePooledWorktree(second.handle);
		},
		TIMEOUT,
	);
});
