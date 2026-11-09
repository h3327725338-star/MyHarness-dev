import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ATTRIBUTION_SLACK_MS,
	attributeRunChanges,
	ChangeClaimRegistry,
	type ShellWindow,
} from "../src/modes/web/change-claims.ts";
import { ChangeTracker, MAX_CARD_ELSEWHERE_FILES, toolCallMayWriteFiles } from "../src/modes/web/changes.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes a file and sets its last write time, the fact attribution reads from disk. */
function writeAt(file: string, text: string, at: number): void {
	writeFileSync(file, text);
	utimesSync(file, new Date(at), new Date(at));
}

describe("change claim registry", () => {
	it("matches only another session's claims inside the window", () => {
		const dir = createTempDir("myharness-claims-window-");
		const now = Date.now();
		const file = path.join(dir, "a.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: file, at: now, tool: "edit" });
		expect(registry.foreignClaim(file, "A", now - 1, now + 1)).toBe(true);
		expect(registry.foreignClaim(file, "A", now + 1, now + 1_000)).toBe(false);
		expect(registry.foreignClaim(file, "A", now - 1_000, now - 1)).toBe(false);
		// The session's own claim is not foreign, and an unknown path has no claim at all.
		expect(registry.foreignClaim(file, "B", now - 1_000, now + 1_000)).toBe(false);
		expect(registry.foreignClaim(path.join(dir, "other.ts"), "A", now - 1_000, now + 1_000)).toBe(false);
	});

	it("bounds window coverage per session", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 100, endedAt: now + 100 });
		expect(registry.foreignShellCovers(now, "A")).toBe(true);
		expect(registry.foreignShellCovers(now - 200, "A")).toBe(false);
		expect(registry.foreignShellCovers(now + 200, "A")).toBe(false);
		expect(registry.ownShellCovers("B", now)).toBe(true);
		expect(registry.ownShellCovers("A", now)).toBe(false);
		// Slack widens a window on both sides.
		expect(registry.foreignShellCovers(now + 200, "A", 150)).toBe(true);
	});

	it("keeps an open window covering everything after its start until it is closed", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.openWindow("job-1", { sessionKey: "B", runId: 1, startedAt: now - 1_000, kind: "job" });
		expect(registry.isWindowOpen("job-1")).toBe(true);
		expect(registry.foreignShellCovers(now + 60_000, "A")).toBe(true);
		expect(registry.windowsCovering(now).map((window) => window.kind)).toEqual(["job"]);
		registry.closeWindow("job-1", now);
		expect(registry.isWindowOpen("job-1")).toBe(false);
		expect(registry.foreignShellCovers(now - 500, "A")).toBe(true);
		expect(registry.foreignShellCovers(now + 60_000, "A")).toBe(false);
		// Closing an unknown or already closed window changes nothing.
		registry.closeWindow("job-1", now + 10_000);
		registry.closeWindow("never-opened", now);
		expect(registry.foreignShellCovers(now + 5_000, "A")).toBe(false);
	});

	it("reads the windows of its source, such as the background jobs of this process", () => {
		const now = Date.now();
		const source: ShellWindow[] = [{ sessionKey: "B", runId: 0, startedAt: now - 1_000, kind: "job" }];
		const registry = new ChangeClaimRegistry({ windowSource: () => source });
		expect(registry.foreignShellCovers(now + 30_000, "A")).toBe(true);
		source[0] = { ...source[0], endedAt: now };
		expect(registry.foreignShellCovers(now + 30_000, "A")).toBe(false);
		// A failing source loses only its own windows.
		const failing = new ChangeClaimRegistry({
			windowSource: () => {
				throw new Error("job store unavailable");
			},
		});
		failing.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 10, endedAt: now + 10 });
		expect(failing.foreignShellCovers(now, "A")).toBe(true);
	});

	it("lists the candidates another session changed since a point in time", () => {
		const dir = createTempDir("myharness-claims-since-");
		const now = Date.now();
		const claimed = path.join(dir, "claimed.ts");
		const shelled = path.join(dir, "shelled.ts");
		const untouched = path.join(dir, "untouched.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: claimed, at: now, tool: "write" });
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 1_000, endedAt: now + 1_000 });
		const candidates = [
			{ path: claimed, modifiedAt: undefined },
			{ path: shelled, modifiedAt: now },
			// Written before the other session's shell window: nothing explains it.
			{ path: untouched, modifiedAt: now - 5_000 },
		];
		expect(registry.foreignChangedSince(candidates, "A", now - 5_000).map((candidate) => candidate.path)).toEqual([
			claimed,
			shelled,
		]);
		// Nothing of it happened after a later point in time, and own records never count.
		expect(registry.foreignChangedSince(candidates, "A", now + 5_000)).toEqual([]);
		expect(registry.foreignChangedSince(candidates, "B", now - 5_000)).toEqual([]);
	});

	it("drops records older than the retention window but keeps open windows", () => {
		const dir = createTempDir("myharness-claims-prune-");
		const now = Date.now();
		const file = path.join(dir, "a.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: file, at: now, tool: "edit" });
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 100, endedAt: now });
		registry.openWindow("still-running", { sessionKey: "C", runId: 1, startedAt: now - 100 });
		registry.prune(now + 31 * DAY_MS);
		expect(registry.foreignClaim(file, "A", 0, Number.POSITIVE_INFINITY)).toBe(false);
		expect(registry.foreignShellCovers(now - 50, "B")).toBe(true);
		expect(registry.windowsCovering(now - 50).map((window) => window.sessionKey)).toEqual(["C"]);
	});
});

describe("attributeRunChanges", () => {
	const baseDir = createTempDir("myharness-claims-attribute-");
	const attribute = (
		registry: ChangeClaimRegistry,
		changes: Array<{ path: string; status: string }>,
		options: { from: number; to: number; modifiedAt?: (file: string) => number | undefined; own?: string[] },
	) =>
		attributeRunChanges(changes, {
			registry,
			sessionKey: "A",
			ownPaths: new Set((options.own ?? []).map((file) => pathIdentityKey(path.join(baseDir, file)))),
			from: options.from,
			to: options.to,
			baseDir,
			modifiedAt: options.modifiedAt ?? (() => undefined),
		});

	it("keeps this run's own files even when another session claimed them, and leaves out the other session's", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: path.join(baseDir, "other.ts"), at: now, tool: "edit" });
		registry.record({ sessionKey: "B", runId: 1, path: path.join(baseDir, "mine.ts"), at: now, tool: "edit" });
		const result = attribute(
			registry,
			[
				{ path: "mine.ts", status: "modified" },
				{ path: "other.ts", status: "modified" },
			],
			{ from: now - 1_000, to: now + 1_000, own: ["mine.ts"] },
		);
		expect(result.kept.map((change) => change.path)).toEqual(["mine.ts"]);
		expect(result.elsewhere).toEqual([{ path: "other.ts", status: "modified", by: "chat" }]);
	});

	it("leaves out a file written during the run while this session ran nothing that writes (another program)", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		const result = attribute(registry, [{ path: "outside.ts", status: "modified" }], {
			from: now - 1_000,
			to: now + 1_000,
			modifiedAt: () => now,
		});
		expect(result.kept).toEqual([]);
		expect(result.elsewhere).toEqual([{ path: "outside.ts", status: "modified", by: "outside" }]);
	});

	it("keeps a file written inside the session's own window, also when another session's window overlaps it", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({ sessionKey: "A", runId: 1, startedAt: now - 500, endedAt: now + 500 });
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 1_000, endedAt: now + 1_000 });
		const result = attribute(
			registry,
			[
				{ path: "both.ts", status: "modified" },
				{ path: "theirs.ts", status: "modified" },
			],
			{
				from: now - 2_000,
				to: now + 2_000,
				modifiedAt: (file) => (file.endsWith("both.ts") ? now : now - 500 - ATTRIBUTION_SLACK_MS - 100),
			},
		);
		expect(result.kept.map((change) => change.path)).toEqual(["both.ts"]);
		expect(result.elsewhere).toEqual([{ path: "theirs.ts", status: "modified", by: "chat" }]);
	});

	it("counts a write a little after the own window ended as the session's (time stamp slack)", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({ sessionKey: "A", runId: 1, startedAt: now - 1_000, endedAt: now });
		const keep = attribute(registry, [{ path: "late.ts", status: "modified" }], {
			from: now - 5_000,
			to: now + 10_000,
			modifiedAt: () => now + ATTRIBUTION_SLACK_MS - 10,
		});
		expect(keep.kept.map((change) => change.path)).toEqual(["late.ts"]);
		const leave = attribute(registry, [{ path: "later.ts", status: "modified" }], {
			from: now - 5_000,
			to: now + 10_000,
			modifiedAt: () => now + ATTRIBUTION_SLACK_MS + 500,
		});
		expect(leave.elsewhere.map((change) => change.path)).toEqual(["later.ts"]);
	});

	it("places deleted files by whether the run had a window at all", () => {
		const now = Date.now();
		const idle = new ChangeClaimRegistry();
		idle.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 100, endedAt: now + 100 });
		expect(attribute(idle, [{ path: "gone.ts", status: "deleted" }], { from: now - 1_000, to: now + 1_000 })).toEqual(
			{
				kept: [],
				elsewhere: [{ path: "gone.ts", status: "deleted", by: "chat" }],
			},
		);
		expect(
			attribute(new ChangeClaimRegistry(), [{ path: "gone.ts", status: "deleted" }], {
				from: now - 1_000,
				to: now + 1_000,
			}).elsewhere,
		).toEqual([{ path: "gone.ts", status: "deleted", by: "outside" }]);
		const busy = new ChangeClaimRegistry();
		busy.recordShell({ sessionKey: "A", runId: 1, startedAt: now - 100, endedAt: now + 100 });
		expect(
			attribute(busy, [{ path: "gone.ts", status: "deleted" }], { from: now - 1_000, to: now + 1_000 }).kept,
		).toEqual([{ path: "gone.ts", status: "deleted" }]);
	});

	it("keeps a write time outside the run only when the run had a window (a copy that keeps old times)", () => {
		const now = Date.now();
		const old = () => now - 3_600_000;
		const busy = new ChangeClaimRegistry();
		busy.recordShell({ sessionKey: "A", runId: 1, startedAt: now - 100, endedAt: now + 100 });
		expect(
			attribute(busy, [{ path: "copied.ts", status: "added" }], {
				from: now - 1_000,
				to: now + 1_000,
				modifiedAt: old,
			}).kept,
		).toEqual([{ path: "copied.ts", status: "added" }]);
		expect(
			attribute(new ChangeClaimRegistry(), [{ path: "copied.ts", status: "added" }], {
				from: now - 1_000,
				to: now + 1_000,
				modifiedAt: old,
			}).elsewhere,
		).toEqual([{ path: "copied.ts", status: "added", by: "outside" }]);
	});

	it("counts the session's background job window as its own for as long as the job runs", () => {
		const now = Date.now();
		const jobs: ShellWindow[] = [{ sessionKey: "A", runId: 0, startedAt: now - 60_000, kind: "job" }];
		const registry = new ChangeClaimRegistry({ windowSource: () => jobs });
		const ownView = attribute(registry, [{ path: "built.js", status: "added" }], {
			from: now - 1_000,
			to: now + 1_000,
			modifiedAt: () => now,
		});
		expect(ownView.kept.map((change) => change.path)).toEqual(["built.js"]);
		const otherView = attributeRunChanges([{ path: "built.js", status: "added" }], {
			registry,
			sessionKey: "B",
			ownPaths: new Set(),
			from: now - 1_000,
			to: now + 1_000,
			baseDir,
			modifiedAt: () => now,
		});
		expect(otherView.elsewhere).toEqual([{ path: "built.js", status: "added", by: "chat" }]);
	});
});

describe("tool calls that may write files", () => {
	it("opens a window only for calls that may write without naming their files", () => {
		expect(toolCallMayWriteFiles("agent")).toBe(true);
		expect(toolCallMayWriteFiles("mail")).toBe(true);
		expect(toolCallMayWriteFiles("mcp_some_tool")).toBe(true);
		for (const name of ["read", "grep", "edit", "write", "apply_patch", "apply_rename", "web_search", "job_output"]) {
			expect(toolCallMayWriteFiles(name)).toBe(false);
		}
	});
});

describe("run change cards keep only this session's files", () => {
	it("drops files another session changed through its own file tools", () => {
		const dir = createTempDir("myharness-claims-card-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		writeFileSync(path.join(dir, "other.ts"), "before\n");
		writeFileSync(path.join(dir, "mine.ts"), "before\n");
		a.beginRun(1);
		b.beginRun(1);
		writeFileSync(path.join(dir, "other.ts"), "after\n");
		b.captureBefore(1, "t1", "edit", { path: "other.ts" });
		b.recordToolOp(1, "t1", "edit", true);
		// The other session even touched this session's file: the run's own operation still wins.
		b.captureBefore(1, "t2", "edit", { path: "mine.ts" });
		b.recordToolOp(1, "t2", "edit", true);
		a.captureBefore(1, "ta", "edit", { path: "mine.ts" });
		a.recordToolOp(1, "ta", "edit", true);
		const record = a.finishRun(
			1,
			{
				status: "known",
				changes: [
					{ path: "other.ts", status: "modified" },
					{ path: "mine.ts", status: "modified" },
				],
			},
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["mine.ts"]);
		expect(record?.elsewhere).toEqual([{ path: "other.ts", status: "modified", by: "chat" }]);
		expect(a.runChangeCardElsewhere(1)).toEqual({
			elsewhere: [{ path: "other.ts", status: "modified", by: "chat" }],
		});
	});

	it("does not treat a failed operation as a claim", () => {
		const dir = createTempDir("myharness-claims-failed-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		a.beginRun(1);
		b.beginRun(1);
		b.captureBefore(1, "t1", "edit", { path: "other.ts" });
		b.recordToolOp(1, "t1", "edit", false);
		// This run ran a command meanwhile, so the change can be its own: the failed edit does not make it B's.
		a.recordShellStart(1, "sa");
		a.recordShellEnd(1, "sa");
		const record = a.finishRun(
			1,
			{ status: "known", changes: [{ path: "other.ts", status: "modified" }] },
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["other.ts"]);
		expect(record?.elsewhere).toBeUndefined();
	});

	it("attributes unrecorded files by window: another session's window leaves them out, an overlap keeps them", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const dir = createTempDir("myharness-claims-shell-");
			const registry = new ChangeClaimRegistry();
			const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
			const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
			const t0 = Date.parse("2026-11-08T00:00:00Z");
			const at = (seconds: number) => {
				vi.setSystemTime(t0 + seconds * 1_000);
				return t0 + seconds * 1_000;
			};
			at(0);
			a.beginRun(1);
			b.beginRun(1);
			// The tracker opens a real window when a shell call starts (other sessions see it at once) and closes it at
			// the call's end. B runs commands at 1-3 s and 9-13 s, A at 10-12 s.
			at(1);
			b.recordShellStart(1, "b-1");
			expect(registry.foreignShellCovers(t0 + 30_000, "A")).toBe(true);
			at(3);
			b.recordShellEnd(1, "b-1");
			at(9);
			b.recordShellStart(1, "b-2");
			at(10);
			a.recordShellStart(1, "a-1");
			at(12);
			a.recordShellEnd(1, "a-1");
			at(13);
			b.recordShellEnd(1, "b-2");
			writeAt(path.join(dir, "generated.ts"), "x\n", t0 + 2_000);
			writeAt(path.join(dir, "built.ts"), "y\n", t0 + 11_000);
			writeAt(path.join(dir, "edited.ts"), "z\n", t0 + 16_500);
			at(20);
			const record = a.finishRun(
				1,
				{
					status: "known",
					changes: [
						{ path: "generated.ts", status: "modified" },
						{ path: "built.ts", status: "modified" },
						{ path: "edited.ts", status: "modified" },
					],
				},
				undefined,
			);
			// Only B ran something at 2 s: B's. Both ran something at 11 s: kept. Nobody here ran anything at 16.5 s.
			expect(record?.changes.map((change) => change.path)).toEqual(["built.ts"]);
			expect(record?.elsewhere).toEqual([
				{ path: "generated.ts", status: "modified", by: "chat" },
				{ path: "edited.ts", status: "modified", by: "outside" },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves out what another program wrote while the run edited its own file", async () => {
		const dir = createTempDir("myharness-claims-outside-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		writeFileSync(path.join(dir, "mine.ts"), "before\n");
		writeFileSync(path.join(dir, "theirs.ts"), "before\n");
		a.beginRun(1);
		a.captureBefore(1, "t1", "edit", { path: "mine.ts" });
		writeFileSync(path.join(dir, "mine.ts"), "after\n");
		a.recordToolOp(1, "t1", "edit", true);
		await sleep(20);
		writeFileSync(path.join(dir, "theirs.ts"), "changed by an editor\n");
		await sleep(20);
		const record = a.finishRun(
			1,
			{
				status: "known",
				changes: [
					{ path: "mine.ts", status: "modified" },
					{ path: "theirs.ts", status: "modified" },
				],
			},
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["mine.ts"]);
		expect(record?.elsewhere).toEqual([{ path: "theirs.ts", status: "modified", by: "outside" }]);
	});

	it("keeps what the run's own sub-agent or other tool wrote while the call ran", async () => {
		const dir = createTempDir("myharness-claims-tool-window-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		a.beginRun(1);
		a.recordToolStart(1, "agent-1", "agent");
		// While the call runs, other sessions already see its window.
		expect(registry.foreignShellCovers(Date.now(), "B")).toBe(true);
		await sleep(10);
		writeFileSync(path.join(dir, "from-sub-agent.ts"), "x\n");
		await sleep(10);
		a.recordToolEnd(1, "agent-1");
		const record = a.finishRun(
			1,
			{ status: "known", changes: [{ path: "from-sub-agent.ts", status: "added" }] },
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["from-sub-agent.ts"]);
	});

	it("keeps a background sub-agent's window open until the dispatch ends or stops being reported", () => {
		const dir = createTempDir("myharness-claims-dispatch-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const started = Date.now() - 1_000;
		a.recordDispatches([{ id: "explore-1", startedAt: started, status: "running" }]);
		expect(registry.ownShellCovers("A", Date.now() + 60_000)).toBe(true);
		a.recordDispatches([{ id: "explore-1", startedAt: started, endedAt: started + 500, status: "completed" }]);
		expect(registry.ownShellCovers("A", started + 400)).toBe(true);
		expect(registry.ownShellCovers("A", started + 500 + 60_000)).toBe(false);
		// The final report of a wave repeats: it is recorded once.
		a.recordDispatches([{ id: "explore-1", startedAt: started, endedAt: started + 500, status: "completed" }]);
		expect(registry.windows().filter((window) => window.kind === "agent")).toHaveLength(1);
		// A dispatch that finished between two reports still counts for its whole run; one that disappears ends now.
		a.recordDispatches([
			{ id: "explore-2", startedAt: started, endedAt: started + 200, status: "completed" },
			{ id: "explore-3", startedAt: started, status: "running" },
		]);
		expect(registry.windows().filter((window) => window.kind === "agent")).toHaveLength(3);
		a.recordDispatches([]);
		expect(registry.ownShellCovers("A", Date.now() + 60_000)).toBe(false);
	});

	it("ends its open windows when the tracker is disposed", () => {
		const dir = createTempDir("myharness-claims-dispose-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		a.beginRun(1);
		a.recordShellStart(1, "never-ends");
		a.recordDispatches([{ id: "explore-9", startedAt: Date.now(), status: "running" }]);
		expect(registry.ownShellCovers("A", Date.now() + 60_000)).toBe(true);
		a.dispose();
		expect(registry.ownShellCovers("A", Date.now() + 60_000)).toBe(false);
	});

	it("lists at most a bounded number of files changed elsewhere on the card, with the full count", () => {
		const dir = createTempDir("myharness-claims-cap-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		a.beginRun(1);
		const changes = Array.from({ length: MAX_CARD_ELSEWHERE_FILES + 5 }, (_, index) => ({
			path: `gen/${index}.ts`,
			status: "deleted" as const,
		}));
		a.finishRun(1, { status: "known", changes }, undefined);
		const card = a.runChangeCardElsewhere(1);
		expect(card.elsewhere).toHaveLength(MAX_CARD_ELSEWHERE_FILES);
		expect(card.elsewhereTotal).toBe(MAX_CARD_ELSEWHERE_FILES + 5);
	});

	it("keeps the detected changes unchanged when no registry is wired", () => {
		const dir = createTempDir("myharness-claims-none-");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		const record = tracker.finishRun(
			1,
			{ status: "known", changes: [{ path: "a.ts", status: "modified" }] },
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["a.ts"]);
		expect(record?.elsewhere).toBeUndefined();
	});
});

describe("whether a run ran something that writes files without naming them", () => {
	it("is true for the run's own shell or other write-capable calls, with or without a registry", () => {
		const dir = createTempDir("myharness-claims-opaque-");
		const plain = new ChangeTracker(dir);
		plain.beginRun(1);
		plain.captureBefore(1, "t1", "write", { path: "a.ts" });
		plain.recordToolOp(1, "t1", "write", true);
		// edit/write name their files: the run is known from their snapshots alone.
		expect(plain.runHadOpaqueActivity(1)).toBe(false);
		plain.recordShellStart(1, "sh1");
		plain.recordShellEnd(1, "sh1");
		expect(plain.runHadOpaqueActivity(1)).toBe(true);

		const tool = new ChangeTracker(dir, { changeClaims: new ChangeClaimRegistry(), sessionKey: () => "A" });
		tool.beginRun(1);
		tool.recordToolStart(1, "mcp1", "tool");
		expect(tool.runHadOpaqueActivity(1)).toBe(true);
		expect(tool.runHadOpaqueActivity(2)).toBe(false);
	});

	it("counts this session's background job from an earlier task while it runs, never another session's", () => {
		const dir = createTempDir("myharness-claims-opaque-job-");
		const jobs: ShellWindow[] = [];
		const registry = new ChangeClaimRegistry({ windowSource: () => jobs });
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		a.beginRun(1);
		expect(a.runHadOpaqueActivity(1)).toBe(false);
		jobs.push({ sessionKey: "B", runId: 0, startedAt: Date.now() - 5_000, kind: "job" });
		expect(a.runHadOpaqueActivity(1)).toBe(false);
		// A job of this session that ended before the run started does not count either.
		jobs.push({ sessionKey: "A", runId: 0, startedAt: Date.now() - 9_000, endedAt: Date.now() - 8_000, kind: "job" });
		expect(a.runHadOpaqueActivity(1)).toBe(false);
		jobs.push({ sessionKey: "A", runId: 0, startedAt: Date.now() - 5_000, kind: "job" });
		expect(a.runHadOpaqueActivity(1)).toBe(true);
		expect(registry.hasWindowDuring("A", Date.now() - 1_000, Date.now())).toBe(true);
		expect(registry.hasWindowDuring("C", Date.now() - 1_000, Date.now())).toBe(false);
	});
});
