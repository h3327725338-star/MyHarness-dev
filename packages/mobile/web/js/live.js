// How a conversation on the page changes while a reply is written. Both sides speak the event vocabulary of the
// desktop Web UI (message_start, message_update, tool_start…): the PC sends these events itself, and the phone's own
// agent (backend-local.js) is translated into them, so one reducer and one transcript serve both.
// Every change replaces the array or object it touches, so components can compare by reference.

const ACTIVE_RUN_STATES = new Set(["queued", "starting", "running", "waiting", "recovering"]);

function findLive(chat, liveId) {
	if (!liveId) return -1;
	for (let i = chat.items.length - 1; i >= 0; i--) if (chat.items[i].liveId === liveId) return i;
	return -1;
}

function sameAssistant(a, b) {
	return a.kind === "assistant" && b.kind === "assistant" && a.ts === b.ts && a.model === b.model;
}

function append(chat, item) {
	chat.items = [...chat.items, item];
}

/** A message the user just sent, shown at once; the real one replaces it when the agent takes it (message_start). */
export function addPending(chat, { clientMessageId, text, images = [], attachments = [] }) {
	// It goes after everything, also after a reply still being written: that is where it will be answered.
	append(chat, { kind: "user", ts: Date.now(), text, images, attachments, pending: true, clientMessageId });
}

/**
 * The PC has the message (its receipt, or the answer to the request): it stops showing as being sent, while it waits
 * for the agent to take it.
 */
export function markDelivered(chat, clientMessageId) {
	let changed = false;
	chat.items = chat.items.map((item) => {
		if (!item.pending || item.delivered || item.clientMessageId !== clientMessageId) return item;
		changed = true;
		return { ...item, delivered: true };
	});
	return changed;
}

export function removePending(chat, clientMessageId) {
	const before = chat.items.length;
	chat.items = chat.items.filter((item) => !(item.pending && item.clientMessageId === clientMessageId));
	return chat.items.length !== before;
}

function attachEntryId(chat, d) {
	const item = d.item;
	if (!item || chat.items.some((entry) => entry.id === d.id)) return false;
	const items = chat.items;
	for (let i = items.length - 1; i >= Math.max(0, items.length - 60); i--) {
		const candidate = items[i];
		if (candidate.id) continue;
		let match = false;
		if (item.kind === "toolResult") match = candidate.kind === "toolResult" && candidate.toolCallId === item.toolCallId;
		else if (item.kind === "assistant") match = candidate.kind === "assistant" && Math.abs(candidate.ts - item.ts) < 60_000;
		else if (item.kind === "user") match = candidate.kind === "user" && !candidate.pending && (candidate.ts === item.ts || (typeof item.text === "string" && candidate.text === item.text && Math.abs(candidate.ts - item.ts) < 60_000));
		else if (item.kind === "custom") match = candidate.kind === "custom" && candidate.customType === item.customType && (candidate.ts === item.ts || (candidate.text === item.text && Math.abs(candidate.ts - item.ts) < 60_000));
		else match = candidate.kind === item.kind && candidate.ts === item.ts;
		if (match) {
			const next = items.slice();
			next[i] = { ...candidate, id: d.id };
			chat.items = next;
			return true;
		}
	}
	// Not on the page yet (a compaction marker, a change card): it goes at the end, before messages still on their way.
	let at = items.length;
	while (at > 0 && items[at - 1].pending) at--;
	chat.items = [...items.slice(0, at), { ...item, id: d.id }, ...items.slice(at)];
	return true;
}

/**
 * Apply one event to a chat. Returns true when something the page shows changed.
 * Events the phone has no use for (terminals, Git, sub-agent panels…) are ignored.
 */
export function applyEvent(chat, name, d) {
	switch (name) {
		case "agent_start":
			chat.running = true;
			chat.runStartedAt ||= Date.now();
			chat.currentRunId = d.runId;
			return true;
		case "run_state":
			chat.run = d;
			chat.running = ACTIVE_RUN_STATES.has(d.state);
			chat.activity = d.activity || "";
			if (chat.running) chat.runStartedAt = d.turnStartedAt || d.startedAt || chat.runStartedAt || Date.now();
			return true;
		case "run_finished":
			chat.runs = { ...chat.runs, [d.runId]: d };
			chat.running = false;
			chat.runStartedAt = 0;
			chat.activity = "";
			return true;
		case "message_start": {
			const item = d.liveId ? { ...d.item, liveId: d.liveId } : d.item;
			if (!item) return false;
			const index = d.clientMessageId ? chat.items.findIndex((entry) => entry.pending && entry.clientMessageId === d.clientMessageId) : -1;
			if (index >= 0) {
				// The optimistic copy keeps its place and its pictures (the agent's copy may carry them by address only).
				const mine = chat.items[index];
				chat.items = chat.items.map((entry, at) => (at === index ? { ...item, clientMessageId: mine.clientMessageId, images: item.images?.length ? item.images : mine.images, attachments: item.attachments?.length ? item.attachments : mine.attachments } : entry));
			} else if (item.kind === "user" && d.clientMessageId && chat.items.some((entry) => entry.clientMessageId === d.clientMessageId)) return false;
			else append(chat, item);
			return true;
		}
		case "message_update": {
			const index = findLive(chat, d.liveId);
			if (index < 0) {
				if (!d.liveId || !d.item) return false;
				append(chat, { ...d.item, liveId: d.liveId });
				return true;
			}
			const items = chat.items.slice();
			items[index] = { ...d.item, liveId: d.liveId, id: items[index].id };
			chat.items = items;
			return true;
		}
		case "message_end": {
			if (!d.liveId) return false;
			const index = findLive(chat, d.liveId);
			if (index >= 0) {
				const items = chat.items.slice();
				items[index] = { ...d.item, liveId: d.liveId, id: items[index].id, final: true, endedAt: d.endedAt };
				chat.items = items;
				return true;
			}
			const ended = d.item?.kind === "assistant" ? { ...d.item, liveId: d.liveId, final: true, endedAt: d.endedAt } : null;
			if (!ended || chat.items.some((entry) => sameAssistant(entry, ended))) return false;
			append(chat, ended);
			return true;
		}
		case "tool_start":
			chat.toolRuns = { ...chat.toolRuns, [d.toolCallId]: { status: "running", startedAt: d.ts, args: d.args, partial: "" } };
			return true;
		case "tool_update": {
			const run = chat.toolRuns[d.toolCallId] || { status: "running" };
			chat.toolRuns = { ...chat.toolRuns, [d.toolCallId]: { ...run, partial: d.text, partialDetails: d.details } };
			return true;
		}
		case "tool_end": {
			const run = chat.toolRuns[d.toolCallId] || {};
			chat.toolRuns = { ...chat.toolRuns, [d.toolCallId]: { ...run, status: d.isError ? "error" : "done", endedAt: d.ts, partial: undefined } };
			if (!chat.items.some((entry) => entry.kind === "toolResult" && entry.toolCallId === d.toolCallId))
				append(chat, { kind: "toolResult", ts: d.ts, toolCallId: d.toolCallId, toolName: d.toolName, text: d.text, images: d.images || [], isError: d.isError, details: d.details, live: true });
			return true;
		}
		case "entry_appended":
			return attachEntryId(chat, d);
		case "prompt_received":
			return markDelivered(chat, d.clientMessageId);
		case "prompt_settled":
		case "prompt_rejected":
			return removePending(chat, d.clientMessageId);
		case "queue_cleared":
			chat.items = chat.items.filter((item) => !item.pending);
			chat.queue = [];
			return true;
		case "queue_update":
			chat.queue = [...(d.steering || []).map((text) => ({ text, mode: "steer" })), ...(d.followUp || []).map((text) => ({ text, mode: "followUp" }))];
			return true;
		case "dialogs":
			chat.dialogs = Array.isArray(d.requests) ? d.requests : [];
			return true;
		case "session_info":
			if (typeof d.name === "string" && d.name) chat.title = d.name;
			return true;
		case "usage":
			chat.usage = d;
			return true;
		default:
			return false;
	}
}

/** True while the last thing on the page is the user's own message and nothing answered it yet. */
export function awaitingFirstReply(chat) {
	if (!chat.running) return false;
	const last = chat.items[chat.items.length - 1];
	return !last || last.kind === "user" || last.kind === "toolResult" || (last.kind === "assistant" && !!last.final);
}
