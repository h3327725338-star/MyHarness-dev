import { describe, expect, it } from "vitest";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { collectSessionChanges, lastClosingRunChanges } from "../src/modes/web/session-changes.ts";
import { entriesToWire, entryProjectsToWire, runChangesToWire } from "../src/modes/web/wire.ts";
import type { SessionEntry } from "../src/session/types.ts";

function card(id: string, runId: number, files: unknown[]): Extract<SessionEntry, { type: "custom" }> {
	return {
		type: "custom",
		customType: "web-run-changes",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		data: { runId, files },
	};
}
const file = (path: string, patch: string, additions = 1) => ({
	path,
	status: "modified",
	additions,
	deletions: 1,
	binary: false,
	patch,
});

describe("conversation change review", () => {
	it("restores all saved edits, deduplicates paths and keeps diffs separate even when run IDs repeat", () => {
		const entries = [
			card("a", 1, [file("a.ts", "first")]),
			card("b", 1, [file("a.ts", "second", 2), file("b.ts", "third")]),
		];
		const restored = collectSessionChanges(JSON.parse(JSON.stringify(entries)));
		expect(restored.files).toHaveLength(2);
		expect(restored.files[0]).toMatchObject({ path: "a.ts", additions: 3, deletions: 2 });
		expect(restored.diffs.get("a.ts")?.map((part) => [part.entryId, part.patch])).toEqual([
			["a", "first"],
			["b", "second"],
		]);
		// A later read-only turn has no change card and must not replace the history.
		expect(collectSessionChanges([...entries, { ...card("question", 2, []), customType: "other" }]).files).toEqual(
			restored.files,
		);
	});
	it("includes commit-only paths and counts overlapping edits once", () => {
		const files = [file("both.ts", "edit")];
		const entry = {
			...card("task", 2, files),
			data: {
				runId: 2,
				files,
				commits: [
					{ runId: 1, files: [file("both.ts", "commit"), file("committed.ts", "earlier")] },
					{ runId: 2, files: [file("committed.ts", "latest", 3)] },
				],
			},
		};
		const result = collectSessionChanges([entry]);
		expect(result.files.map(({ path, additions }) => [path, additions])).toEqual([
			["both.ts", 1],
			["committed.ts", 3],
		]);
		expect(result.diffs.get("both.ts")).toMatchObject([{ patch: "edit" }]);
		expect(result.diffs.get("committed.ts")).toMatchObject([{ runId: 2, patch: "latest" }]);
	});
	it("never draws the changes a new message held back for its task's card, and counts each file once", () => {
		const held = (id: string, runId: number, files: unknown[]) => ({
			...card(id, runId, files),
			data: { runId, deferred: true, files },
		});
		const entries = [
			held("run-1", 1, [file("a.ts", "first")]),
			// The task's last run: its card lists run 1's files as well, with the net diff.
			card("task", 2, [file("a.ts", "net", 2), file("b.ts", "third")]),
		];
		// Held back: no card on the page, in the wire items or in an export.
		expect(
			runChangesToWire("run-1", 0, entries[0]!.type === "custom" ? entries[0]!.data : undefined),
		).toBeUndefined();
		expect(entryProjectsToWire(entries[0]!)).toBe(false);
		expect(entryProjectsToWire(entries[1]!)).toBe(true);
		expect(entriesToWire(entries).map((item) => item.id)).toEqual(["task"]);
		// The held entry is superseded by the card after it: only that card counts.
		expect(lastClosingRunChanges(entries)).toBe(1);
		const counted = collectSessionChanges(entries);
		expect(counted.files.map((summary) => [summary.path, summary.additions])).toEqual([
			["a.ts", 2],
			["b.ts", 1],
		]);
		expect(counted.diffs.get("a.ts")?.map((part) => part.patch)).toEqual(["net"]);
	});
	it("still counts held-back changes of a task that never got its card", () => {
		const entries = [
			card("earlier", 1, [file("old.ts", "old")]),
			{
				...card("run-2", 2, [file("a.ts", "held")]),
				data: { runId: 2, deferred: true, files: [file("a.ts", "held")] },
			},
		];
		expect(lastClosingRunChanges(entries)).toBe(0);
		expect(collectSessionChanges(entries).files.map((summary) => summary.path)).toEqual(["old.ts", "a.ts"]);
		// A card with no files still closes the task: nothing is left of the held changes (they were all put back).
		const closed = [...entries, card("closing", 3, [])];
		expect(collectSessionChanges(closed).files.map((summary) => summary.path)).toEqual(["old.ts"]);
	});
	it("handles missing or malformed old cards without inventing changes, and marks omitted diffs", () => {
		expect(collectSessionChanges([card("empty", 1, [null, {}])]).files).toEqual([]);
		const result = collectSessionChanges([card("large", 1, [{ ...file("a.ts", "not saved"), patchOmitted: true }])]);
		expect(result.files[0].unavailable).toContain("too large");
		expect(result.diffs.get("a.ts")?.[0].patch).toBeUndefined();
	});
	it("serves persisted conversation records with no live tracker after restart, and isolates the selected branch", async () => {
		let branch = [card("saved", 9, [file("a.ts", "saved diff")])];
		const routes = new Map<string, (context: { url: URL }) => unknown>();
		registerFileRoutes(
			{
				route: (_method: string, route: string, handler: (context: { url: URL }) => unknown) =>
					routes.set(route, handler),
			} as never,
			{
				session: { sessionManager: { getBranch: () => branch } },
				// No task is running: nothing to add to the saved records.
				liveRun: () => undefined,
				// The conversation's uncommitted count is the Working tree list intersected with this chat's files; a host
				// without change claims answers it from one listing.
				tracker: {
					listWorktreeChanges: async () => ({
						repositoryRoot: "/repo",
						changes: [{ path: "a.ts", status: "modified" }],
					}),
				},
			} as never,
		);
		const request = (route: string, query: string) =>
			routes.get(route)!({ url: new URL(`http://localhost${route}?${query}`) });
		expect(await request("/api/changes", "scope=session")).toMatchObject({
			scope: "session",
			total: 1,
			files: [{ path: "a.ts" }],
			uncommitted: 1,
		});
		expect(await request("/api/changes/diff", "scope=session&path=a.ts")).toMatchObject({
			history: [{ entryId: "saved", patch: "saved diff" }],
		});
		branch = [];
		expect(await request("/api/changes", "scope=session")).toMatchObject({ total: 0, files: [], uncommitted: 0 });
		await expect(request("/api/changes/diff", "scope=session&path=a.ts")).rejects.toThrow("No such change");
	});
});
