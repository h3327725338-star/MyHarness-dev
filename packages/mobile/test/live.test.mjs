// The reducer that turns the event stream (from the PC, or from the phone's own agent) into what the page shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addPending, applyEvent, awaitingFirstReply, markDelivered, removePending } from "../web/js/live.js";

const chat = () => ({ items: [], toolRuns: {}, runs: {}, queue: [], dialogs: [], running: false, title: "" });
const assistant = (text, ts = 100) => ({ kind: "assistant", ts, model: "m", blocks: [{ type: "text", text }] });

test("a sent message shows at once and is replaced by the agent's copy", () => {
	const c = chat();
	addPending(c, { clientMessageId: "c1", text: "hi", images: [{ data: "AAA", mimeType: "image/png" }] });
	assert.equal(c.items.length, 1);
	assert.equal(c.items[0].pending, true);
	applyEvent(c, "message_start", { clientMessageId: "c1", item: { kind: "user", ts: 5, text: "hi", images: [] } });
	assert.equal(c.items.length, 1);
	assert.equal(c.items[0].pending, undefined);
	assert.equal(c.items[0].images.length, 1, "the picture of the optimistic copy is kept");
	// The same start arriving twice (a reconnect) adds nothing.
	assert.equal(applyEvent(c, "message_start", { clientMessageId: "c1", item: { kind: "user", ts: 5, text: "hi" } }), false);
	assert.equal(c.items.length, 1);
});

test("a reply streams into one item and ends final", () => {
	const c = chat();
	applyEvent(c, "agent_start", { runId: "r1" });
	assert.equal(c.running, true);
	applyEvent(c, "message_start", { liveId: "L1", item: assistant("") });
	applyEvent(c, "message_update", { liveId: "L1", item: assistant("Hel") });
	applyEvent(c, "message_update", { liveId: "L1", item: assistant("Hello") });
	assert.equal(c.items.length, 1);
	assert.equal(c.items[0].blocks[0].text, "Hello");
	applyEvent(c, "message_end", { liveId: "L1", item: assistant("Hello."), endedAt: 200 });
	assert.equal(c.items[0].final, true);
	assert.equal(c.items[0].endedAt, 200);
	applyEvent(c, "entry_appended", { id: "e1", item: assistant("Hello.") });
	assert.equal(c.items[0].id, "e1");
	assert.equal(c.items.length, 1, "the saved entry names the item, it does not add one");
	applyEvent(c, "run_finished", { runId: "r1", outcome: "completed" });
	assert.equal(c.running, false);
	assert.equal(c.runs.r1.outcome, "completed");
});

test("an update for a reply the page missed still shows it, once", () => {
	const c = chat();
	assert.equal(applyEvent(c, "message_update", { liveId: "L9", item: assistant("late") }), true);
	assert.equal(c.items.length, 1);
	// An end without a known start is added once, not twice.
	const d = chat();
	applyEvent(d, "message_end", { liveId: "L2", item: assistant("done", 300), endedAt: 301 });
	applyEvent(d, "message_end", { liveId: "L3", item: assistant("done", 300), endedAt: 301 });
	assert.equal(d.items.length, 1);
});

test("a tool call runs, reports progress and leaves one result", () => {
	const c = chat();
	applyEvent(c, "tool_start", { toolCallId: "t1", ts: 1, args: { queries: ["x"] } });
	assert.equal(c.toolRuns.t1.status, "running");
	applyEvent(c, "tool_update", { toolCallId: "t1", text: "searching" });
	assert.equal(c.toolRuns.t1.partial, "searching");
	applyEvent(c, "tool_end", { toolCallId: "t1", toolName: "web_search", ts: 2, text: "result", isError: false });
	assert.equal(c.toolRuns.t1.status, "done");
	assert.equal(c.items.filter((item) => item.kind === "toolResult").length, 1);
	applyEvent(c, "tool_end", { toolCallId: "t1", toolName: "web_search", ts: 2, text: "result", isError: false });
	assert.equal(c.items.filter((item) => item.kind === "toolResult").length, 1);
	applyEvent(c, "entry_appended", { id: "e2", item: { kind: "toolResult", toolCallId: "t1", ts: 2 } });
	assert.equal(c.items[0].id, "e2");
	applyEvent(c, "tool_end", { toolCallId: "t2", toolName: "web_fetch", ts: 3, text: "boom", isError: true });
	assert.equal(c.toolRuns.t2.status, "error");
});

test("run states, queue, dialogs and the title follow their events", () => {
	const c = chat();
	applyEvent(c, "run_state", { state: "running", activity: "Thinking", startedAt: 50 });
	assert.equal(c.running, true);
	assert.equal(c.runStartedAt, 50);
	applyEvent(c, "run_state", { state: "idle" });
	assert.equal(c.running, false);
	applyEvent(c, "queue_update", { steering: ["a"], followUp: ["b"] });
	assert.deepEqual(c.queue, [
		{ text: "a", mode: "steer" },
		{ text: "b", mode: "followUp" },
	]);
	addPending(c, { clientMessageId: "c2", text: "queued" });
	applyEvent(c, "queue_cleared", {});
	assert.deepEqual(c.queue, []);
	assert.equal(c.items.length, 0);
	applyEvent(c, "dialogs", { requests: [{ id: "d1", kind: "confirm", title: "Sure?" }] });
	assert.equal(c.dialogs.length, 1);
	applyEvent(c, "dialogs", {});
	assert.deepEqual(c.dialogs, []);
	applyEvent(c, "session_info", { name: "Trip plan" });
	assert.equal(c.title, "Trip plan");
	assert.equal(applyEvent(c, "terminal_output", {}), false);
});

test("a rejected message is taken back", () => {
	const c = chat();
	addPending(c, { clientMessageId: "c3", text: "nope" });
	assert.equal(applyEvent(c, "prompt_rejected", { clientMessageId: "c3" }), true);
	assert.equal(c.items.length, 0);
	assert.equal(removePending(c, "c3"), false);
});

test("the waiting dots show only until the reply starts", () => {
	const c = chat();
	assert.equal(awaitingFirstReply(c), false);
	c.running = true;
	assert.equal(awaitingFirstReply(c), true);
	c.items = [{ kind: "user", ts: 1, text: "q" }];
	assert.equal(awaitingFirstReply(c), true);
	c.items = [...c.items, { ...assistant("a"), liveId: "L1" }];
	assert.equal(awaitingFirstReply(c), false);
	c.items = [c.items[0], { ...assistant("a"), final: true }];
	assert.equal(awaitingFirstReply(c), true, "between two steps of one run");
});

test("every change replaces the array, so the page can compare by reference", () => {
	const c = chat();
	const before = c.items;
	addPending(c, { clientMessageId: "c4", text: "x" });
	assert.notEqual(c.items, before);
	const runs = c.toolRuns;
	applyEvent(c, "tool_start", { toolCallId: "t9", ts: 1 });
	assert.notEqual(c.toolRuns, runs);
});

test("a sent message stops showing as being sent once the PC says it has it", () => {
	const c = chat();
	addPending(c, { clientMessageId: "c7", text: "hello" });
	assert.equal(c.items[0].delivered, undefined);
	// The PC's receipt arrives before the agent takes the message (it prepares first).
	assert.equal(applyEvent(c, "prompt_received", { clientMessageId: "c7", slot: "s1" }), true);
	assert.equal(c.items[0].pending, true);
	assert.equal(c.items[0].delivered, true);
	// Twice, or for a message that is not here, changes nothing.
	assert.equal(applyEvent(c, "prompt_received", { clientMessageId: "c7" }), false);
	assert.equal(markDelivered(c, "other"), false);
	applyEvent(c, "message_start", { clientMessageId: "c7", item: { kind: "user", ts: 9, text: "hello" } });
	assert.equal(c.items.length, 1);
	assert.equal(c.items[0].pending, undefined);
});
