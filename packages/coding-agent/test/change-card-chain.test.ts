import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCheckpoint } from "../src/git/checkpoints/checkpoint.ts";
import { collectFinalWorkspaceChanges } from "../src/git/repository/workspace-changes.ts";
import { ChangeClaimRegistry } from "../src/modes/web/change-claims.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";

/**
 * A task that new messages cut into several runs gets one card: the runs a message cut short are deferred, and the
 * last run's card (finishChain) lists the union of their files, each once, from before the first run that changed it.
 */

const temporaryDirectories: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** What the `write` tool does to the tracker: the content before is captured, the file written, the call recorded. */
function write(tracker: ChangeTracker, runId: number, dir: string, file: string, content: string): void {
	const id = `${runId}-${file}-${content.length}`;
	tracker.captureBefore(runId, id, "write", { path: file });
	writeFileSync(path.join(dir, file), content);
	tracker.recordToolOp(runId, id, "write", true);
}

function removeFile(tracker: ChangeTracker, runId: number, dir: string, file: string): void {
	const id = `${runId}-${file}-delete`;
	tracker.captureBefore(runId, id, "write", { path: file });
	unlinkSync(path.join(dir, file));
	tracker.recordToolOp(runId, id, "write", true);
}

const byPath = <T extends { path: string }>(files: T[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

describe("the card of a task cut into runs", () => {
	it("lists every file once, measured from before the first run that changed it", () => {
		const dir = createTempDir("myharness-chain-tools-");
		writeFileSync(path.join(dir, "notes.txt"), "alpha\n");
		const tracker = new ChangeTracker(dir);

		tracker.beginRun(1);
		write(tracker, 1, dir, "notes.txt", "alpha\nbeta\n");
		write(tracker, 1, dir, "one.txt", "one\n");
		tracker.finishRun(1, undefined, undefined);
		// On its own the first run would have a card with its two files...
		expect(tracker.runChangeCard(1, undefined).map((file) => file.path)).toEqual(["notes.txt", "one.txt"]);
		// ...but a new message cut it short: nothing is listed until the task's last run ends.
		expect(tracker.hasDeferredRuns()).toBe(false);
		tracker.deferRun(1, undefined);
		expect(tracker.hasDeferredRuns()).toBe(true);

		tracker.beginRun(2);
		write(tracker, 2, dir, "notes.txt", "alpha\nbeta\ngamma\n");
		write(tracker, 2, dir, "two.txt", "two\n");
		tracker.finishRun(2, undefined, undefined);

		const card = tracker.finishChain(2, undefined);
		expect(byPath(card.files).map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
			["notes.txt", "modified", 2, 0],
			["one.txt", "added", 1, 0],
			["two.txt", "added", 1, 0],
		]);
		// The one entry of notes.txt shows the whole task's change: the first run's content before, the last run's after.
		const notes = card.files.find((file) => file.path === "notes.txt");
		expect(notes?.patch).toContain("+beta");
		expect(notes?.patch).toContain("+gamma");
		expect(notes?.patch).not.toContain("-beta");
		expect(card.elsewhere).toBeUndefined();
		// The held changes are released: the next task starts from nothing.
		expect(tracker.hasDeferredRuns()).toBe(false);
	});

	it("keeps accumulating through several runs that were each cut short", () => {
		const dir = createTempDir("myharness-chain-three-");
		writeFileSync(path.join(dir, "notes.txt"), "v0\n");
		const tracker = new ChangeTracker(dir);
		for (const runId of [1, 2]) {
			tracker.beginRun(runId);
			write(tracker, runId, dir, "notes.txt", `v${runId}\n`);
			tracker.finishRun(runId, undefined, undefined);
			tracker.deferRun(runId, undefined);
		}
		tracker.beginRun(3);
		write(tracker, 3, dir, "notes.txt", "v3\n");
		tracker.finishRun(3, undefined, undefined);
		const { files } = tracker.finishChain(3, undefined);
		expect(files).toHaveLength(1);
		expect(files[0]?.patch).toContain("-v0");
		expect(files[0]?.patch).toContain("+v3");
		expect(files[0]?.patch).not.toContain("v1");
		expect(files[0]?.patch).not.toContain("v2");
	});

	it("leaves out what the runs changed and put back, and what they created and deleted again", () => {
		const dir = createTempDir("myharness-chain-undo-");
		writeFileSync(path.join(dir, "notes.txt"), "alpha\n");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		write(tracker, 1, dir, "notes.txt", "changed\n");
		write(tracker, 1, dir, "scratch.txt", "scratch\n");
		write(tracker, 1, dir, "kept.txt", "kept\n");
		tracker.finishRun(1, undefined, undefined);
		tracker.deferRun(1, undefined);

		tracker.beginRun(2);
		write(tracker, 2, dir, "notes.txt", "alpha\n");
		removeFile(tracker, 2, dir, "scratch.txt");
		tracker.finishRun(2, undefined, undefined);

		const { files } = tracker.finishChain(2, undefined);
		expect(files.map((file) => file.path)).toEqual(["kept.txt"]);
	});

	it("ends with the card of a last run that changed nothing itself", () => {
		const dir = createTempDir("myharness-chain-quiet-");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		write(tracker, 1, dir, "one.txt", "one\n");
		tracker.finishRun(1, undefined, undefined);
		tracker.deferRun(1, undefined);
		tracker.beginRun(2);
		tracker.finishRun(2, undefined, undefined);
		const { files } = tracker.finishChain(2, undefined);
		expect(files.map((file) => [file.path, file.status])).toEqual([["one.txt", "added"]]);
		expect(readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("one\n");
	});

	it("can end without a last run (the message that cut a run short got none)", () => {
		const dir = createTempDir("myharness-chain-flush-");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		write(tracker, 1, dir, "one.txt", "one\n");
		tracker.finishRun(1, undefined, undefined);
		tracker.deferRun(1, undefined);
		expect(tracker.finishChain(undefined, undefined).files.map((file) => file.path)).toEqual(["one.txt"]);
		expect(tracker.hasDeferredRuns()).toBe(false);
	});

	it("keeps what another conversation changed apart from the files, never counted", () => {
		const dir = createTempDir("myharness-chain-elsewhere-");
		const registry = new ChangeClaimRegistry();
		const mine = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const other = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		writeFileSync(path.join(dir, "other.ts"), "before\n");
		mine.beginRun(1);
		other.beginRun(1);
		write(other, 1, dir, "other.ts", "after\n");
		write(mine, 1, dir, "mine.ts", "mine\n");
		mine.finishRun(
			1,
			{
				status: "known",
				changes: [
					{ path: "other.ts", status: "modified" },
					{ path: "mine.ts", status: "added" },
				],
			},
			undefined,
		);
		mine.deferRun(1, undefined);

		mine.beginRun(2);
		write(mine, 2, dir, "second.ts", "second\n");
		mine.finishRun(2, undefined, undefined);
		const card = mine.finishChain(2, undefined);
		expect(byPath(card.files).map((file) => file.path)).toEqual(["mine.ts", "second.ts"]);
		expect(card.elsewhere).toEqual([{ path: "other.ts", status: "modified", by: "chat" }]);
	});

	it("follows a file that a later run moved, from the content it held before the first run", () => {
		const dir = createTempDir("myharness-chain-rename-");
		writeFileSync(path.join(dir, "old.txt"), "one\n");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		write(tracker, 1, dir, "old.txt", "one\ntwo\n");
		tracker.finishRun(1, undefined, undefined);
		tracker.deferRun(1, undefined);
		tracker.beginRun(2);
		tracker.captureBeforePaths(2, "mv", ["old.txt", "new.txt"]);
		writeFileSync(path.join(dir, "new.txt"), "one\ntwo\n");
		unlinkSync(path.join(dir, "old.txt"));
		tracker.recordToolOp(2, "mv", "apply_rename", true);
		tracker.finishRun(
			2,
			{ status: "known", changes: [{ path: "new.txt", status: "renamed", oldPath: "old.txt" }] },
			undefined,
		);
		const { files } = tracker.finishChain(2, undefined);
		expect(files.map((file) => [file.path, file.status, file.oldPath])).toEqual([["new.txt", "renamed", "old.txt"]]);
	});
});

describe("the card of a task cut into runs reads earlier content from the first run's checkpoint", () => {
	it("shows a file a command changed in both runs as one change from before the first", async () => {
		const project = createTempDir("myharness-chain-git-");
		const storageRoot = createTempDir("myharness-chain-storage-");
		git(project, "init", "-q", "-b", "main");
		git(project, "config", "user.email", "test@example.invalid");
		git(project, "config", "user.name", "test");
		git(project, "config", "core.hooksPath", "");
		writeFileSync(path.join(project, "a.txt"), "original\n");
		writeFileSync(path.join(project, "b.txt"), "b original\n");
		git(project, "add", "-A");
		git(project, "commit", "-q", "-m", "init");

		const tracker = new ChangeTracker(project);
		const first = await createGitCheckpoint({ cwd: project, sessionId: "chain", storageRoot });
		expect(first.ok).toBe(true);
		tracker.beginRun(1);
		writeFileSync(path.join(project, "a.txt"), "run one\n");
		const detectedFirst = await collectFinalWorkspaceChanges({
			cwd: project,
			checkpoint: first.checkpoint!,
			excludeExternalCommits: true,
		});
		tracker.finishRun(1, detectedFirst, first.checkpoint);
		await tracker.prefetchBefore(1, first.checkpoint);
		tracker.deferRun(1, first.checkpoint);

		// The next run takes a fresh checkpoint, which already holds what the first run changed.
		const second = await createGitCheckpoint({ cwd: project, sessionId: "chain", storageRoot });
		expect(second.ok).toBe(true);
		tracker.beginRun(2);
		writeFileSync(path.join(project, "a.txt"), "run two\n");
		writeFileSync(path.join(project, "b.txt"), "b changed\n");
		const detectedSecond = await collectFinalWorkspaceChanges({
			cwd: project,
			checkpoint: second.checkpoint!,
			excludeExternalCommits: true,
		});
		tracker.finishRun(2, detectedSecond, second.checkpoint);
		await tracker.prefetchBefore(2, second.checkpoint);

		const { files } = tracker.finishChain(2, second.checkpoint);
		expect(byPath(files).map((file) => [file.path, file.additions, file.deletions])).toEqual([
			["a.txt", 1, 1],
			["b.txt", 1, 1],
		]);
		const a = files.find((file) => file.path === "a.txt");
		expect(a?.patch).toContain("-original");
		expect(a?.patch).toContain("+run two");
		expect(a?.patch).not.toContain("run one");
		expect(files.find((file) => file.path === "b.txt")?.patch).toContain("-b original");
	});
});
