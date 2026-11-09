import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCheckpoint } from "../src/git/checkpoints/checkpoint.ts";
import { collectFinalWorkspaceChanges } from "../src/git/repository/workspace-changes.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";

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

const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const crlf = (lines: string[]) => `${lines.join("\r\n")}\r\n`;
const lf = (lines: string[]) => `${lines.join("\n")}\n`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository whose .ps1 files are checked out with CRLF while Git stores them with LF, as on Windows. */
function createRepository(): { project: string; storageRoot: string } {
	const project = createTempDir("myharness-eol-project-");
	const storageRoot = createTempDir("myharness-eol-storage-");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "user.name", "test");
	git(project, "config", "core.autocrlf", "true");
	git(project, "config", "core.hooksPath", "");
	writeFileSync(path.join(project, ".gitattributes"), "* text=auto eol=lf\n*.ps1 text eol=crlf\n");
	writeFileSync(path.join(project, "run.ps1"), crlf(LINES));
	writeFileSync(path.join(project, "notes.md"), lf(LINES));
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "init");
	// Let Git write the file back the way it checks it out (CRLF for .ps1).
	unlinkSync(path.join(project, "run.ps1"));
	git(project, "checkout", "--", "run.ps1");
	return { project, storageRoot };
}

describe("change card diffs compare line endings the way Git does", () => {
	it("counts one changed line of a CRLF file changed by a command, not the whole file", async () => {
		const { project, storageRoot } = createRepository();
		const created = await createGitCheckpoint({ cwd: project, sessionId: "eol", storageRoot });
		expect(created.ok).toBe(true);
		const checkpoint = created.checkpoint!;
		const tracker = new ChangeTracker(project);
		tracker.beginRun(1);
		const changed = [...LINES];
		changed[5] = "line 6 changed";
		writeFileSync(path.join(project, "run.ps1"), crlf(changed));
		const detection = await collectFinalWorkspaceChanges({ cwd: project, checkpoint, excludeExternalCommits: true });
		tracker.finishRun(1, detection, checkpoint);
		const card = tracker.runChangeCard(1, checkpoint);
		expect(card.map((file) => [file.path, file.additions, file.deletions])).toEqual([["run.ps1", 1, 1]]);
		expect(card[0]?.patch).toContain("+line 6 changed");
		expect(card[0]?.patch).not.toContain("\r");
	});

	it("says a file only changed its line endings when its text lines are the same", () => {
		const project = createTempDir("myharness-eol-snapshot-");
		writeFileSync(path.join(project, "script.ps1"), crlf(LINES));
		const tracker = new ChangeTracker(project);
		tracker.beginRun(1);
		tracker.captureBefore(1, "t1", "write", { path: "script.ps1" });
		writeFileSync(path.join(project, "script.ps1"), lf(LINES));
		tracker.recordToolOp(1, "t1", "write", true);
		tracker.finishRun(1, undefined, undefined);
		const [file] = tracker.runChangeCard(1, undefined);
		expect(file).toMatchObject({ path: "script.ps1", lineEndingsOnly: true, additions: 0, deletions: 0 });
		expect(file?.patch).toBeUndefined();
	});

	it("counts a real edit of a CRLF file written back with LF as the edited lines only", () => {
		const project = createTempDir("myharness-eol-rewrite-");
		writeFileSync(path.join(project, "script.ps1"), crlf(LINES));
		const tracker = new ChangeTracker(project);
		tracker.beginRun(1);
		tracker.captureBefore(1, "t1", "write", { path: "script.ps1" });
		writeFileSync(path.join(project, "script.ps1"), lf([...LINES, "line 13"]));
		tracker.recordToolOp(1, "t1", "write", true);
		tracker.finishRun(1, undefined, undefined);
		const [file] = tracker.runChangeCard(1, undefined);
		expect([file?.additions, file?.deletions, file?.lineEndingsOnly]).toEqual([1, 0, undefined]);
	});

	it("shows the Changes panel's working-tree diff of a CRLF file with the lines that changed", async () => {
		const { project } = createRepository();
		const changed = [...LINES];
		changed[0] = "first line changed";
		writeFileSync(path.join(project, "run.ps1"), crlf(changed));
		const tracker = new ChangeTracker(project);
		const listed = await tracker.listWorktreeChanges({ forceRefresh: true });
		const change = listed.changes.find((candidate) => candidate.path === "run.ps1");
		expect(change).toBeDefined();
		const diff = await tracker.diffForWorktreeFile(listed.repositoryRoot!, change!);
		expect([diff.summary.additions, diff.summary.deletions]).toEqual([1, 1]);
		expect(diff.patch).toContain("+first line changed");
	});
});
