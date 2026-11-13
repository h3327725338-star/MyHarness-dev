// The PC side's chat list on the phone, grouped as the PC's own sidebar groups it (web/js/pc-groups.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGroups, COPIES_KEY, DEFAULT_KEY, emptyLists, isOpen, SCHEDULED_KEY } from "../web/js/pc-groups.js";

const row = (path, modified, extra = {}) => ({ path, modified, name: null, firstMessage: path, blank: false, pinned: false, scheduled: false, copy: false, ...extra });

function lists(patch = {}) {
	return {
		...emptyLists(),
		loaded: true,
		workspaces: [
			{ name: "AP", rootPath: "C:\\Study\\AP" },
			{ name: "OS", rootPath: "C:\\Study\\OS" },
		],
		unbound: [row("C:/d/a.jsonl", 300), row("C:/d/b.jsonl", 500)],
		unboundTotal: 2,
		scheduled: [],
		sessions: { "C:\\Study\\AP": [row("C:/ap/1.jsonl", 100), row("C:/ap/2.jsonl", 400)] },
		totals: { "C:\\Study\\AP": 2 },
		...patch,
	};
}

test("Workspaces come in the PC's order, then Default; each lists its chats newest first", () => {
	const groups = buildGroups({ lists: lists(), mode: "general", now: 1000 });
	assert.deepEqual(
		groups.map((group) => [group.kind, group.name]),
		[
			["workspace", "AP"],
			["workspace", "OS"],
			["default", ""],
		],
	);
	assert.deepEqual(
		groups[0].rows.map((entry) => entry.path),
		["C:/ap/2.jsonl", "C:/ap/1.jsonl"],
	);
	// A Workspace whose chats were not read yet waits for them; Default is open unless folded.
	assert.equal(groups[1].loading, true);
	assert.equal(groups[1].rows, undefined);
	assert.equal(groups[2].open, true);
	assert.deepEqual(
		groups[2].rows.map((entry) => entry.path),
		["C:/d/b.jsonl", "C:/d/a.jsonl"],
	);
});

test("a Workspace group is folded unless the user opened it or the chat on screen is in it", () => {
	assert.equal(isOpen({}, "C:\\Study\\AP"), false);
	assert.equal(isOpen({}, "C:\\Study\\AP", { current: true }), true);
	assert.equal(isOpen({ "C:\\Study\\AP": false }, "C:\\Study\\AP", { current: true }), false);
	assert.equal(isOpen({}, DEFAULT_KEY), true);
	assert.equal(isOpen({}, SCHEDULED_KEY), false);
	const groups = buildGroups({ lists: lists(), mode: "general", currentRoot: "c:/study/ap/", now: 1000 });
	assert.equal(groups[0].open, true, "the same folder, spelled another way");
});

test("pinned chats first, then running ones; the PC's open chats mark their rows", () => {
	const slots = [
		{ slot: "s1", mode: "general", sessionFile: "C:\\ap\\1.jsonl", active: true, cwd: "C:\\Study\\AP" },
		{ slot: "s2", mode: "general", sessionFile: "C:/d/a.jsonl", unread: true, unbound: true },
		{ slot: "s3", mode: "coding", sessionFile: "C:/ap/2.jsonl", waiting: true },
	];
	const data = lists({ unbound: [row("C:/d/a.jsonl", 300), row("C:/d/b.jsonl", 500), row("C:/d/c.jsonl", 100, { pinned: true })] });
	const groups = buildGroups({ lists: data, slots, mode: "general", active: { slot: "s9" }, now: 1000 });
	const ap = groups[0].rows;
	assert.equal(ap[0].path, "C:/ap/1.jsonl", "running first");
	assert.equal(ap[0].running, true);
	assert.equal(ap[0].slot, "s1");
	assert.equal(ap[1].waiting, false, "a Coding chat's slot does not mark a General row");
	const def = groups[2].rows;
	assert.equal(def[0].path, "C:/d/c.jsonl", "pinned first");
	assert.equal(def.find((entry) => entry.path === "C:/d/a.jsonl").unread, true);
	// The chat on screen is not unread.
	const onScreen = buildGroups({ lists: data, slots, mode: "general", active: { slot: "s2" }, now: 1000 });
	const a = onScreen[2].rows.find((entry) => entry.path === "C:/d/a.jsonl");
	assert.equal(a.unread, false);
	assert.equal(a.current, true);
});

test("an open chat that is not saved yet is listed in its group from the PC's slot", () => {
	const slots = [
		{ slot: "s5", mode: "general", sessionFile: "C:/ap/new.jsonl", firstMessage: "LAB question", hasContent: true, cwd: "c:/study/ap", unbound: false },
		{ slot: "s6", mode: "general", sessionFile: "C:/d/new.jsonl", firstMessage: "", hasContent: false, unbound: true },
		{ slot: "s7", mode: "general", sessionFile: "C:/d/empty.jsonl", hasContent: false, unbound: true },
	];
	const groups = buildGroups({ lists: lists(), slots, mode: "general", active: { slot: "s6" }, now: 1000 });
	assert.ok(groups[0].rows.some((entry) => entry.path === "C:/ap/new.jsonl" && entry.unsaved));
	// The new empty chat on screen leads Default; an empty chat that is not on screen is not listed.
	assert.equal(groups[2].rows[0].path, "C:/d/new.jsonl");
	assert.ok(!groups[2].rows.some((entry) => entry.path === "C:/d/empty.jsonl"));
});

test("scheduled chats and chats in worktree copies leave their groups for their own", () => {
	const data = lists({
		unbound: [row("C:/d/a.jsonl", 300), row("C:/d/s.jsonl", 900, { scheduled: true }), row("C:/d/copy.jsonl", 800, { copy: true })],
		scheduled: [row("C:/d/s.jsonl", 900, { scheduled: true })],
	});
	const groups = buildGroups({ lists: data, mode: "general", now: 1000 });
	assert.deepEqual(
		groups.map((group) => group.key),
		["C:\\Study\\AP", "C:\\Study\\OS", DEFAULT_KEY, SCHEDULED_KEY, COPIES_KEY],
	);
	assert.deepEqual(
		groups[2].rows.map((entry) => entry.path),
		["C:/d/a.jsonl"],
	);
	assert.equal(groups[3].open, false);
	// A PC that does not hand its scheduled chats to phones (null) keeps them in their groups.
	const older = buildGroups({ lists: { ...data, scheduled: null }, mode: "general", now: 1000 });
	assert.ok(older.find((group) => group.key === DEFAULT_KEY).rows.some((entry) => entry.path === "C:/d/s.jsonl"));
	assert.ok(!older.some((group) => group.key === SCHEDULED_KEY));
});

test("a blank chat nothing keeps is left off; one that is pinned, named or on screen stays", () => {
	const data = lists({ unbound: [row("C:/d/blank.jsonl", 900, { blank: true }), row("C:/d/kept.jsonl", 800, { blank: true, pinned: true }), row("C:/d/a.jsonl", 300)] });
	const paths = buildGroups({ lists: data, mode: "general", now: 1000 })[2].rows.map((entry) => entry.path);
	assert.deepEqual(paths, ["C:/d/kept.jsonl", "C:/d/a.jsonl"]);
	const shown = buildGroups({ lists: data, mode: "general", active: { file: "c:\\d\\blank.jsonl" }, now: 1000 })[2].rows.map((entry) => entry.path);
	assert.equal(shown[0], "C:/d/blank.jsonl");
});

test("a search keeps the groups with a match, opened, and the ones still being read", () => {
	const groups = buildGroups({ lists: lists(), mode: "general", query: "AP/2", now: 1000 });
	assert.deepEqual(
		groups.map((group) => [group.name, group.open, group.loading, group.rows?.map((entry) => entry.path)]),
		[
			["AP", true, false, ["C:/ap/2.jsonl"]],
			["OS", true, true, undefined],
		],
	);
});

test("a group knows when the PC has more chats than it sent", () => {
	const data = lists({ unboundTotal: 140, totals: { "C:\\Study\\AP": 2 } });
	const groups = buildGroups({ lists: data, mode: "general", now: 1000 });
	assert.equal(groups[0].hasMore, false);
	assert.equal(groups[2].hasMore, true);
});
