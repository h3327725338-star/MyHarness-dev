// A chat that is read again from the PC while a reply is being written: what the page shows of that reply stays, and
// events that come after the answer do not draw a reply a second time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addPending, applyEvent, awaitingFirstReply, carryLive, mergeReloaded } from "../web/js/live.js";
import { drawnPrefix } from "../web/js/reveal.js";

const chat = () => ({ items: [], toolRuns: {}, runs: {}, queue: [], dialogs: [], running: false, title: "" });
const text = (value) => ({ type: "text", text: value });
const call = (id) => ({ type: "toolCall", id, name: "read", args: { path: "a.txt" } });
const assistant = (blocks, ts = 100, extra = {}) => ({ kind: "assistant", ts, model: "m", blocks, ...extra });
const user = (value, ts = 1, extra = {}) => ({ kind: "user", ts, text: value, ...extra });

/** What loadChat does with the PC's answer (backend-remote.js). */
function reload(c, saved, { active = true } = {}) {
	const live = carryLive(saved, c.items, c.toolRuns, { active });
	const pending = c.items.filter((item) => item.pending);
	const known = new Set(c.items.filter((item) => item.id).map((item) => item.id));
	c.items = mergeReloaded(live.items, pending, known);
	c.toolRuns = live.toolRuns;
}

test("the reply being written survives a reload, with the state of its tool call", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: 1 });
	applyEvent(c, "message_start", { item: user("go") });
	applyEvent(c, "message_start", { liveId: "live-1", item: assistant([]) });
	applyEvent(c, "message_update", { liveId: "live-1", item: assistant([text("Looking."), call("t1")]) });
	applyEvent(c, "message_end", { liveId: "live-1", item: assistant([text("Looking."), call("t1")], 100, { stopReason: "toolUse" }), endedAt: 110 });
	applyEvent(c, "tool_start", { toolCallId: "t1", toolName: "read", args: {}, ts: 111 });
	// The PC has saved only the user's message when it answers.
	reload(c, [user("go", 1, { id: "u1" })]);
	assert.deepEqual(
		c.items.map((item) => item.kind),
		["user", "assistant"],
	);
	assert.equal(c.items[1].liveId, "live-1");
	assert.equal(c.toolRuns.t1.status, "running", "the tool call is still shown as running");
	// Its end still finds it.
	applyEvent(c, "tool_end", { toolCallId: "t1", toolName: "read", text: "body", isError: false, ts: 120 });
	assert.equal(c.items.filter((item) => item.kind === "toolResult").length, 1);
});

test("a result the page has and the answer has not is kept; a saved one is not doubled", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: 1 });
	applyEvent(c, "message_start", { item: user("go") });
	applyEvent(c, "message_start", { liveId: "live-1", item: assistant([call("t1")]) });
	applyEvent(c, "message_end", { liveId: "live-1", item: assistant([call("t1")], 100, { stopReason: "toolUse" }), endedAt: 110 });
	applyEvent(c, "tool_start", { toolCallId: "t1", toolName: "read", args: {}, ts: 111 });
	applyEvent(c, "tool_end", { toolCallId: "t1", toolName: "read", text: "body", isError: false, ts: 120 });
	const savedReply = assistant([call("t1")], 9000, { id: "a1", stopReason: "toolUse" });
	reload(c, [user("go", 1, { id: "u1" }), savedReply]);
	assert.deepEqual(
		c.items.map((item) => item.kind),
		["user", "assistant", "toolResult"],
	);
	assert.equal(c.items[1].id, "a1");
	assert.equal(c.items[1].liveId, "live-1", "the saved reply keeps the name it was written under");
	reload(c, [user("go", 1, { id: "u1" }), savedReply, { kind: "toolResult", id: "r1", ts: 9100, toolCallId: "t1", toolName: "read", text: "body" }]);
	assert.equal(c.items.filter((item) => item.kind === "toolResult").length, 1);
	assert.equal(c.items.filter((item) => item.kind === "assistant").length, 1);
});

test("events that come after the answer do not draw the saved reply again", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: 1 });
	// The page was read from the PC: the reply is there as a saved one, written 9 s after it started.
	c.items = [user("q", 1, { id: "u1" }), assistant([text("Answer.")], 9100, { id: "a1", stopReason: "stop" })];
	applyEvent(c, "message_update", { liveId: "live-1", item: assistant([text("Ans")], 100) });
	assert.equal(c.items.filter((item) => item.kind === "assistant").length, 1);
	assert.equal(c.items[1].blocks[0].text, "Answer.", "the saved copy is the whole reply");
	applyEvent(c, "message_end", { liveId: "live-1", item: assistant([text("Answer.")], 100, { stopReason: "stop" }), endedAt: 9099 });
	assert.equal(c.items.filter((item) => item.kind === "assistant").length, 1);
	assert.equal(c.items[1].endedAt, 9099);
	// A start that was drawn before the saved copy was recognised is removed again.
	const d = chat();
	d.items = [user("q", 1, { id: "u1" }), assistant([text("Looking."), call("t1")], 9100, { id: "a1", stopReason: "toolUse" })];
	applyEvent(d, "message_start", { liveId: "live-1", item: assistant([], 100) });
	assert.equal(d.items.length, 3);
	applyEvent(d, "message_update", { liveId: "live-1", item: assistant([text("Looking."), call("t1")], 100) });
	assert.equal(d.items.length, 2);
	assert.equal(d.items[1].id, "a1");
	// The saved copy of the user's own message is not added a second time either.
	assert.equal(applyEvent(d, "message_start", { item: user("q", 1) }), false);
});

test("an earlier reply with the same first words is not taken for the one being written", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: 2 });
	c.items = [user("q1", 1, { id: "u1" }), assistant([text("OK, done.")], 50, { id: "a1", stopReason: "stop" }), user("q2", 60, { id: "u2" })];
	applyEvent(c, "message_start", { liveId: "live-7", item: assistant([], 100) });
	applyEvent(c, "message_update", { liveId: "live-7", item: assistant([text("OK")], 100) });
	assert.equal(c.items.length, 4);
	assert.equal(c.items[3].liveId, "live-7");
	assert.equal(c.items[1].liveId, undefined);
});

test("when the PC says no reply is being written, only what it has saved is shown", () => {
	const c = chat();
	c.items = [user("q", 1, { id: "u1" }), assistant([text("Half")], 100, { liveId: "live-1" })];
	reload(c, [user("q", 1, { id: "u1" }), assistant([text("Half an answer.")], 900, { id: "a1", stopReason: "stop" })], { active: false });
	assert.equal(c.items.length, 2);
	assert.equal(c.items[1].id, "a1");
	// A name used again by a restarted PC app does not overwrite the saved reply.
	applyEvent(c, "message_update", { liveId: "live-1", item: assistant([text("Another")], 5000) });
	assert.equal(c.items.length, 3);
	assert.equal(c.items[1].blocks[0].text, "Half an answer.");
});

test("a message sent while the reply is written waits below it and does not end it", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: 1 });
	applyEvent(c, "message_start", { item: user("q1") });
	applyEvent(c, "message_start", { liveId: "live-1", item: assistant([text("Writing")]) });
	addPending(c, { clientMessageId: "c2", text: "q2" });
	assert.equal(c.items[2].whileRunning, true);
	assert.equal(awaitingFirstReply(c), false, "the reply above is being written, nothing is awaited");
	const idle = chat();
	addPending(idle, { clientMessageId: "c1", text: "q" });
	assert.equal(idle.items[0].whileRunning, undefined);
});

test("text being written out never ends in a half-made heading, list, fence or table", () => {
	const list = "Files found:\n- a.txt\n- b.txt";
	assert.equal(drawnPrefix(list, 14), "Files found:\n", "a lone dash is not drawn (it would make the line above a heading)");
	assert.equal(drawnPrefix(list, 16), "Files found:\n- a");
	const code = "Run:\n```python\nprint(1)\n```\nDone";
	assert.equal(drawnPrefix(code, 9), "Run:\n", "a fence waits for its language");
	assert.equal(drawnPrefix(code, 15), "Run:\n```python\n");
	const table = "Sizes:\n| name | size |\n| --- | --- |\n| a | 1 |\n";
	assert.equal(drawnPrefix(table, 20), "Sizes:\n", "a table waits for its first two lines");
	assert.equal(drawnPrefix(table, 30), "Sizes:\n");
	assert.equal(drawnPrefix(table, 40), table.slice(0, 40));
	assert.equal(drawnPrefix("plain words", 5), "plain");
	assert.equal(drawnPrefix(list, list.length), list);
});
