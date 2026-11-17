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

const toolCallIds = (item) => (item.blocks || []).filter((block) => block.type === "toolCall" && block.id).map((block) => block.id);
const wordsOf = (item) =>
	(item.blocks || [])
		.filter((block) => block.type === "text" || block.type === "thinking")
		.map((block) => block.text || "")
		.join("\n");

/**
 * What a reply says, without the whitespace at its end: the saved copy is trimmed, the copy written on the page may end
 * in the line break the model streamed last, and that alone must not make them two replies.
 */
const spokenWords = (item) => wordsOf(item).trimEnd();

/**
 * The PC's saved copy of a reply and the copy that is (or was) being written on the page are the same message. They
 * cannot be told by their time: the written copy carries when the reply started, the saved one when it was saved. So:
 * a tool call in common, or (a reply without tool calls) the same model and the same words (compared without the
 * whitespace at the end); `partial`: the written copy may hold only the beginning of them.
 */
function sameReply(saved, live, { partial = false } = {}) {
	if (saved.kind !== "assistant" || live.kind !== "assistant") return false;
	if (saved.id && live.id) return saved.id === live.id;
	const calls = toolCallIds(live);
	if (calls.length) {
		const theirs = new Set(toolCallIds(saved));
		return calls.some((id) => theirs.has(id));
	}
	if (toolCallIds(saved).length && !partial) return false;
	if (saved.model !== live.model || saved.ts + 2000 < live.ts) return false;
	const written = spokenWords(live);
	if (!written) return false;
	return partial ? spokenWords(saved).startsWith(written) : spokenWords(saved) === written;
}

/**
 * An event names a reply by the id it has while it is written, and no item on the page has that id: the chat was read
 * again from the PC in between and holds the saved copy. That copy is found here (among the items after the last
 * message of the user), so the event is not drawn as a second reply.
 */
function findSavedCopy(chat, live, partial) {
	if (!live) return -1;
	for (let i = chat.items.length - 1; i >= Math.max(0, chat.items.length - 40); i--) {
		const item = chat.items[i];
		if (item.kind === "user" && !item.pending) return -1;
		if (item.kind === "assistant" && item.id && !item.liveId && sameReply(item, live, { partial })) return i;
	}
	return -1;
}

function append(chat, item) {
	chat.items = [...chat.items, item];
}

/** A message the user just sent, shown at once; the real one replaces it when the agent takes it (message_start). */
export function addPending(chat, { clientMessageId, text, images = [], attachments = [] }) {
	// It goes after everything, also after a reply still being written: that is where it will be answered.
	// `whileRunning`: sent while a reply was being written, which goes on above it (transcript.js: the turn that is live).
	append(chat, { kind: "user", ts: Date.now(), text, images, attachments, pending: true, clientMessageId, ...(chat.running ? { whileRunning: true } : {}) });
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

/**
 * A chat was read again from the PC while messages sent from this phone were still shown as "on their way". The ones
 * the PC has saved by now are in what it sent (the event that says so was missed: the connection was down, or the chat
 * was reloaded in between): those leave, so a message is never shown twice; the rest stay after the saved messages.
 * A saved message counts as the same one when the PC did not have it before (`known`: the ids shown before the
 * reload), it has the same text, and it is among the newest.
 */
export function mergeReloaded(saved, pending, known = new Set()) {
	const items = saved.slice();
	const taken = new Set();
	const left = [];
	const same = (a, b) => String(a || "").trim() === String(b || "").trim();
	for (const mine of pending) {
		let found = -1;
		for (let index = items.length - 1; index >= Math.max(0, items.length - 12) && found < 0; index--) {
			const item = items[index];
			if (item.kind !== "user" || taken.has(index) || (item.id && known.has(item.id))) continue;
			const text = typeof item.text === "string" ? item.text : "";
			// With files the PC's copy may name them after the text.
			if (same(text, mine.text) || (mine.attachments?.length && mine.text && text.trim().startsWith(mine.text.trim()))) found = index;
		}
		if (found < 0) {
			left.push(mine);
			continue;
		}
		taken.add(found);
		const item = items[found];
		items[found] = { ...item, clientMessageId: mine.clientMessageId, images: item.images?.length ? item.images : mine.images, attachments: item.attachments?.length ? item.attachments : mine.attachments };
	}
	return [...items, ...left];
}

/**
 * A chat was read again from the PC while a reply is being written. The PC's answer holds only what it has saved: the
 * reply being written is saved when it ends, and the answer may be older than events the page has already shown
 * (through Google Drive an answer takes longer than an event). Replacing everything with the answer made the reply
 * disappear, set finished tool calls back to "running", and drew a reply twice when its last events came after the
 * answer. So what the page has from events and the PC has not saved yet stays (`items`: after the saved messages), a
 * saved reply keeps the name it had while it was written (its `liveId`: late events still find it, and its place on the
 * page is not built anew), and the state of tool calls without a saved result is kept (`toolRuns`).
 * `active`: the PC says a reply is being written. When none is, everything is saved and only the names are kept.
 */
export function carryLive(saved, current, toolRuns = {}, { active = true } = {}) {
	const items = saved.slice();
	const ids = new Map();
	const results = new Set();
	items.forEach((item, index) => {
		if (item.id) ids.set(item.id, index);
		if (item.kind === "toolResult" && item.toolCallId) results.add(item.toolCallId);
	});
	// Saved replies the page already showed as saved ones are nobody's copy.
	const settled = new Set(current.filter((item) => item.id && !item.liveId).map((item) => item.id));
	const taken = new Set();
	const carried = [];
	const kept = {};
	const keepRuns = (item) => {
		for (const id of toolCallIds(item)) if (toolRuns[id] && !results.has(id)) kept[id] = toolRuns[id];
	};
	for (const item of current) {
		// A message sent from this phone keeps the id it was sent under: its turn on the page is named by it (lastingKey).
		if (item.kind === "user" && item.clientMessageId && !item.pending && item.id && ids.has(item.id)) {
			const at = ids.get(item.id);
			if (!items[at].clientMessageId) items[at] = { ...items[at], clientMessageId: item.clientMessageId };
			continue;
		}
		if (item.kind === "toolResult") {
			if (active && item.live && !item.id && item.toolCallId && !results.has(item.toolCallId)) carried.push(item);
			continue;
		}
		if (item.kind !== "assistant" || !item.liveId) continue;
		let at = item.id ? (ids.get(item.id) ?? -1) : -1;
		if (at < 0 && !item.id)
			for (let index = items.length - 1; index >= 0 && at < 0; index--) {
				const entry = items[index];
				if (entry.kind === "user") break;
				if (entry.kind === "assistant" && !taken.has(index) && !settled.has(entry.id) && sameReply(entry, item, { partial: !item.final })) at = index;
			}
		if (at >= 0) {
			taken.add(at);
			items[at] = { ...items[at], liveId: item.liveId, final: true, ...(item.endedAt ? { endedAt: item.endedAt } : {}) };
			keepRuns(items[at]);
		} else if (active && !item.id) {
			// With an id it was saved once and is no longer in the chat (deleted, another branch): the PC's word counts.
			carried.push(item);
			keepRuns(item);
		}
	}
	return { items: carried.length ? [...items, ...carried] : items, toolRuns: kept };
}

/**
 * Where an event about a reply being written (`d.liveId`, `d.item`) belongs. `index`: the item it updates, -1 when it
 * is a reply the page does not have yet. `saved`: the PC's saved copy of that reply is on the page (the chat was read
 * again from the PC in between) and now carries the reply's name; a copy drawn from events beside it is removed. The
 * saved copy is the whole reply, so the event has nothing to add (`changed`: whether the page changed all the same).
 */
function placeOfReply(chat, d, partial) {
	let index = findLive(chat, d.liveId);
	const found = index >= 0 ? chat.items[index] : null;
	if (found?.id && found.final) {
		// A saved reply under this name. The same reply: the event is a late one. Another reply: the name is used again
		// (the PC's app was restarted and counts from 1 again), so the event is about a reply the page does not have.
		if (!d.item || sameReply(found, d.item, { partial })) return { index, saved: true, changed: false };
		index = -1;
	}
	const copy = findSavedCopy(chat, d.item, partial);
	if (copy < 0) return { index, saved: false, changed: false };
	chat.items = chat.items.map((entry, at) => (at === copy ? { ...entry, liveId: d.liveId, final: true } : entry)).filter((_, at) => at !== index);
	return { index: -1, saved: true, changed: true };
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
		case "run_redirecting":
			// A message sent with "interrupt" is ending this run (the PC says so before the stop starts): its stopped reply is
			// not a cancelled task. The record is the run's first; run_finished replaces it (same shape as the PC page's).
			if (!d.runId || !d.startedAt || chat.runs?.[d.runId]) return false;
			chat.runs = { ...chat.runs, [d.runId]: { runId: d.runId, outcome: "redirected", startedAt: d.startedAt, endedAt: d.ts || Date.now(), provisional: true } };
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
			// The agent's copy of a message sent from here names it by its id. A copy without one (a message taken into a
			// running reply is announced that way) settles the message on its way that has the same words.
			const words = (value) => String(value || "").trim();
			const index = d.clientMessageId
				? chat.items.findIndex((entry) => entry.pending && entry.clientMessageId === d.clientMessageId)
				: item.kind === "user"
					? chat.items.findIndex((entry) => entry.pending && words(entry.text) === words(item.text))
					: -1;
			if (index >= 0) {
				// The optimistic copy keeps its place and its pictures (the agent's copy may carry them by address only).
				const mine = chat.items[index];
				chat.items = chat.items.map((entry, at) => (at === index ? { ...item, clientMessageId: mine.clientMessageId, images: item.images?.length ? item.images : mine.images, attachments: item.attachments?.length ? item.attachments : mine.attachments } : entry));
			} else if (item.kind === "user" && d.clientMessageId && chat.items.some((entry) => entry.clientMessageId === d.clientMessageId)) return false;
			// The chat was read again from the PC in between and holds the saved copy of this message already.
			else if (item.kind === "user" && chat.items.slice(-12).some((entry) => entry.kind === "user" && entry.id && words(entry.text) === words(item.text) && Math.abs(entry.ts - item.ts) < 60_000)) return false;
			else append(chat, item);
			return true;
		}
		case "message_update": {
			if (!d.liveId || !d.item) return false;
			const place = placeOfReply(chat, d, true);
			if (place.saved) return place.changed;
			if (place.index < 0) {
				append(chat, { ...d.item, liveId: d.liveId });
				return true;
			}
			const items = chat.items.slice();
			items[place.index] = { ...d.item, liveId: d.liveId, id: items[place.index].id };
			chat.items = items;
			return true;
		}
		case "message_end": {
			if (!d.liveId) return false;
			const place = placeOfReply(chat, d, false);
			if (place.saved) {
				// The saved copy is the whole reply; it only learns when the reply ended.
				chat.items = chat.items.map((entry) => (entry.liveId === d.liveId && entry.id ? { ...entry, endedAt: entry.endedAt || d.endedAt } : entry));
				return true;
			}
			if (place.index >= 0) {
				const items = chat.items.slice();
				items[place.index] = { ...d.item, liveId: d.liveId, id: items[place.index].id, final: true, endedAt: d.endedAt };
				chat.items = items;
				return true;
			}
			if (d.item?.kind !== "assistant") return false;
			// The same end told a second time under another name (both copies carry the time the reply started).
			if (chat.items.some((entry) => entry.kind === "assistant" && entry.ts === d.item.ts && entry.model === d.item.model)) return false;
			append(chat, { ...d.item, liveId: d.liveId, final: true, endedAt: d.endedAt });
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

/**
 * A turn's place on the page under one name for as long as the chat is shown. The shared model names a turn by its
 * user message: by the time the phone noted when it was sent, then by the PC's own time when the PC takes it, then by
 * the id it is saved under. Each change would build the turn anew: the message just sent would fade in a second time
 * and everything open in the turn would close. The message's own id (given when it was sent from here) ties the names
 * together, and a name once given stays.
 */
export function lastingKey(names, turn) {
	const sent = turn.user?.clientMessageId ? `sent:${turn.user.clientMessageId}` : "";
	const known = names.get(turn.key) || (sent && names.get(sent)) || turn.key;
	names.set(turn.key, known);
	if (sent) names.set(sent, known);
	if (names.size > 600) for (const name of [...names.keys()].slice(0, 200)) names.delete(name);
	return known;
}

/** True while the last thing on the page is the user's own message and nothing answered it yet. */
export function awaitingFirstReply(chat) {
	if (!chat.running) return false;
	// A message sent while the reply was being written waits below it; it says nothing about that reply.
	let at = chat.items.length - 1;
	while (at >= 0 && chat.items[at].pending && chat.items[at].whileRunning) at--;
	const last = chat.items[at];
	return !last || last.kind === "user" || last.kind === "toolResult" || (last.kind === "assistant" && !!last.final);
}
