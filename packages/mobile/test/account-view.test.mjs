// What the phone makes of the account's Drive (web/js/account-view.js): which PCs are on, the newest version of each
// chat and setting across several PCs, chats turned from the PC's format and back, and the memory search.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFromJsonl, linesForPc, listPcs, mergeViews, PC_FRESH_MS, phoneContext, pickMemories, searchMemories } from "../web/js/account-view.js";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("PCs that wrote their presence lately are on and listed first; bad addresses are dropped", () => {
	const pcs = listPcs(
		[
			{ deviceId: "old", name: "Laptop", lastSeenAt: ago(PC_FRESH_MS + 1000), accepts: true },
			{ deviceId: "desk", name: "Desk", lastSeenAt: ago(5000), accepts: false, lan: { addresses: ["192.168.1.5", "fe80::1", "evil.example"], port: 8787 } },
			{ name: "no id" },
			null,
		],
		NOW,
	);
	assert.deepEqual(
		pcs.map((pc) => [pc.id, pc.online, pc.accepts]),
		[
			["desk", true, false],
			["old", false, true],
		],
	);
	assert.deepEqual(pcs[0].lan, { addresses: ["192.168.1.5"], port: 8787 });
	assert.equal(pcs[1].lan, null);
});

test("several PCs' views add up to one: the larger rank wins for each chat, setting and bookmark list", () => {
	const view = (id, writtenAt, settingsRank, chats, bookmarks) => ({
		version: 1,
		device: { id },
		writtenAt,
		settings: { rank: settingsRank, providers: [{ id: `p-${id}` }], model: { provider: `p-${id}`, id: "m" } },
		chats,
		bookmarks,
	});
	const merged = mergeViews([
		view("a", "2026-11-13T09:00:00Z", 5, [{ key: "c1", rank: 3, title: "old title", updatedAt: "2026-11-13T08:00:00Z" }], { rank: 9, items: [{ url: "https://a.test" }] }),
		view("b", "2026-11-13T09:30:00Z", 4, [
			{ key: "c1", rank: 4, title: "new title", updatedAt: "2026-11-13T07:00:00Z" },
			{ key: "c2", rank: 1, title: "only on b", updatedAt: "2026-11-13T09:10:00Z" },
		], { rank: 2, items: [{ url: "https://b.test" }] }),
		{ version: 2, settings: {}, chats: [] },
	]);
	assert.equal(merged.settings.from, "a");
	assert.deepEqual(merged.settings.providers, [{ id: "p-a" }]);
	assert.deepEqual(
		merged.chats.map((chat) => [chat.key, chat.title]),
		[
			["c2", "only on b"],
			["c1", "new title"],
		],
	);
	assert.deepEqual(merged.bookmarks, [{ url: "https://a.test" }]);
	assert.equal(merged.writtenAt, "2026-11-13T09:30:00Z");
	// No valid view at all: an empty one, not a crash.
	assert.deepEqual(mergeViews([]).settings.providers, []);
	assert.deepEqual(pickMemories([{ version: 1, rank: 2, entries: ["x"] }, { version: 1, rank: 7, entries: ["y"] }, null]), ["y"]);
});

test("a PC chat becomes the branch that ends at its last line, and phone lines chain onto it", () => {
	const lines = [
		{ type: "session", version: 3, id: "s" },
		{ type: "message", id: "u1", parentId: null, timestamp: "2026-11-13T01:00:00Z", message: { role: "user", content: [{ type: "text", text: "first" }] } },
		{ type: "message", id: "a-old", parentId: "u1", timestamp: "2026-11-13T01:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned branch" }] } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-13T01:00:02Z", message: { role: "assistant", content: [{ type: "image", mimeType: "image/png" }, { type: "text", text: "kept" }] } },
		"not json",
		{ type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-11-13T01:00:03Z", name: "  A title  " },
	];
	const parsed = chatFromJsonl(lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
	assert.equal(parsed.header.id, "s");
	assert.equal(parsed.leaf, "i1");
	assert.equal(parsed.title, "A title");
	assert.deepEqual(parsed.entries.map((entry) => entry.id), ["u1", "a1"]);
	// A picture the PC keeps in a file of its own has no data here.
	assert.deepEqual(parsed.entries[1].message.content[0], { type: "text", text: "[picture]" });

	const back = linesForPc(
		[
			{ id: "p1", ts: Date.parse("2026-11-13T02:00:00Z"), message: { role: "user", content: [] } },
			{ id: "bad id!", ts: 0, message: { role: "user", content: [] } },
			{ id: "p2", ts: Date.parse("2026-11-13T02:00:01Z"), message: { role: "assistant", content: [] } },
		],
		parsed.leaf,
	);
	assert.deepEqual(back.lines.map((line) => [line.id, line.parentId]), [
		["p1", "i1"],
		["p2", "p1"],
	]);
	assert.equal(back.leaf, "p2");
	assert.equal(back.lines[0].timestamp, "2026-11-13T02:00:00.000Z");
});

test("tool calls of tools the phone lacks reach the phone's model as text, with their results", () => {
	const out = phoneContext(
		[
			{ role: "user", content: [{ type: "text", text: "list files" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "dir" } }, { type: "toolCall", id: "t2", name: "web_search", arguments: { query: "x" } }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: "Access denied" }] },
			{ role: "toolResult", toolCallId: "t2", toolName: "web_search", content: [{ type: "text", text: "results" }] },
		],
		["web_search"],
	);
	assert.equal(out[1].content[0].type, "text");
	assert.match(out[1].content[0].text, /used the tool bash: \{"command":"dir"\}/);
	assert.deepEqual(out[1].content[1], { type: "toolCall", id: "t2", name: "web_search", arguments: { query: "x" } });
	assert.equal(out[2].role, "user");
	assert.match(out[2].content[0].text, /^\[Result of bash on the PC, an error\]\nAccess denied/);
	assert.equal(out[3].role, "toolResult");
});

test("the memory search ranks names above bodies and finds Chinese without spaces", () => {
	const memories = [
		{ name: "diet", description: "what the user eats", content: "no coffee, weak stomach" },
		{ name: "coffee-shop", description: "favourite place", content: "near the campus" },
		{ name: "学校", description: "课程安排", content: "周三有操作系统课" },
	];
	assert.deepEqual(searchMemories(memories, "coffee").map((memory) => memory.name), ["coffee-shop", "diet"]);
	assert.deepEqual(searchMemories(memories, "操作系统").map((memory) => memory.name), ["学校"]);
	assert.deepEqual(searchMemories(memories, "").length, 3);
	assert.deepEqual(searchMemories(memories, "zzz"), []);
});
