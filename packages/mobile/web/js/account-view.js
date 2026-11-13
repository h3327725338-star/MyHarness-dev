// What the phone makes of the account's Drive, without touching Drive or the page (account.js does both): which PCs
// are on, the one view of chats, Providers and bookmarks that several PCs' views add up to, and chats turned from the
// PC's format (Session JSONL, packages/coding-agent/docs/session-format.md) into the phone's and back.

/** A PC that has not said it is on for this long is shown as off (the PC writes its presence every minute). */
export const PC_FRESH_MS = 150000;
/** Ids the PC accepts for chat lines (importer.ts). */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_INLINE_IMAGE_CHARS = 2_800_000;

/** PCs of the account from their presence files, those that are on first. */
export function listPcs(presences, now = Date.now()) {
	return presences
		.filter((entry) => entry && typeof entry.deviceId === "string")
		.map((entry) => {
			const seen = Date.parse(entry.lastSeenAt || "") || 0;
			return {
				id: entry.deviceId,
				name: String(entry.name || "PC").slice(0, 80),
				version: String(entry.appVersion || ""),
				lastSeenAt: seen,
				online: now - seen < PC_FRESH_MS,
				accepts: entry.accepts !== false,
				lan: entry.lan && Array.isArray(entry.lan.addresses) && Number.isInteger(entry.lan.port) ? { addresses: entry.lan.addresses.filter((address) => /^[0-9.]{7,15}$/.test(address)).slice(0, 6), port: entry.lan.port } : null,
			};
		})
		.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt);
}

const rankOf = (value) => (Number.isFinite(value?.rank) ? value.rank : -1);

/**
 * One view from the views of several PCs. Each PC describes what it holds with a rank (the sum of the record's
 * version vector): for the same chat, setting or bookmark list, the larger rank is the newer version.
 */
export function mergeViews(views) {
	const valid = views.filter((view) => view && view.version === 1 && view.settings && Array.isArray(view.chats));
	let settings = null;
	let bookmarks = null;
	const chats = new Map();
	for (const view of valid) {
		if (!settings || rankOf(view.settings) > rankOf(settings) || (rankOf(view.settings) === rankOf(settings) && view.writtenAt > settings.writtenAt)) settings = { ...view.settings, writtenAt: view.writtenAt, from: view.device?.id || "" };
		if (view.bookmarks && (!bookmarks || rankOf(view.bookmarks) > rankOf(bookmarks))) bookmarks = view.bookmarks;
		for (const chat of view.chats) {
			const known = chats.get(chat.key);
			if (!known || chat.rank > known.rank || (chat.rank === known.rank && chat.updatedAt > known.updatedAt)) chats.set(chat.key, chat);
		}
	}
	return {
		settings: settings || { rank: -1, providers: [], model: null, thinkingLevel: null, writtenAt: "" },
		chats: [...chats.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
		bookmarks: bookmarks?.items || [],
		writtenAt: valid.map((view) => view.writtenAt).sort().pop() || "",
	};
}

/** The memory pack with the largest rank (all PCs hold the same memories once sync caught up). */
export function pickMemories(packs) {
	let best = null;
	for (const pack of packs) if (pack && pack.version === 1 && Array.isArray(pack.entries) && (!best || pack.rank > best.rank)) best = pack;
	return best?.entries || [];
}

/**
 * The shortcuts of the PC browser's new-tab page (`<deviceId>.dial.json.gz`), from the PC that has seen the most of
 * them: sites and groups of sites, in the order the desktop draws them.
 */
export function pickDial(packs) {
	let best = null;
	for (const pack of packs) {
		if (!pack || pack.version !== 1 || !Array.isArray(pack.items)) continue;
		if (!best || rankOf(pack) > rankOf(best) || (rankOf(pack) === rankOf(best) && String(pack.writtenAt) > String(best.writtenAt))) best = pack;
	}
	const site = (entry) => (entry && typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? { id: String(entry.id || entry.url), type: "site", title: String(entry.title || ""), url: entry.url, ...(typeof entry.icon === "string" && entry.icon.startsWith("data:image/") ? { icon: entry.icon } : {}) } : null);
	const items = [];
	for (const entry of best?.items || []) {
		if (entry?.type === "group") {
			const inside = (Array.isArray(entry.items) ? entry.items : []).map(site).filter(Boolean);
			if (inside.length) items.push({ id: String(entry.id || `group-${items.length}`), type: "group", title: String(entry.title || ""), items: inside });
		} else {
			const one = site(entry);
			if (one) items.push(one);
		}
	}
	return items;
}

function cleanContent(content) {
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		// Pictures the PC keeps as separate files (sessionImageFile) have no data in the chat itself.
		if (part?.type === "image" && (!part.data || part.data.length > MAX_INLINE_IMAGE_CHARS)) return { type: "text", text: "[picture]" };
		return part;
	});
}

/**
 * A PC chat (its JSONL text) as the phone keeps one: the messages of the branch that ends at the last line, each
 * with the PC's line id, and the chat's title. `leaf` is the id the next line from the phone hangs on.
 */
export function chatFromJsonl(text) {
	const byId = new Map();
	let leaf = null;
	let title = "";
	let header = null;
	for (const line of String(text).split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			header = entry;
			continue;
		}
		if (typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		leaf = entry.id;
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) title = entry.name.trim();
	}
	const branch = [];
	const seen = new Set();
	for (let id = leaf; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) {
		seen.add(id);
		branch.push(byId.get(id));
	}
	branch.reverse();
	const entries = branch
		.filter((entry) => entry.type === "message" && entry.message && ["user", "assistant", "toolResult"].includes(entry.message.role))
		.map((entry) => ({ id: entry.id, ts: Date.parse(entry.timestamp) || entry.message.timestamp || 0, message: { ...entry.message, content: cleanContent(entry.message.content) } }));
	return { header, entries, leaf, title };
}

/** Lines in the PC's format for phone entries, chained from `parent` (the chat's last line on the PC, or null). */
export function linesForPc(entries, parent) {
	const lines = [];
	let previous = parent ?? null;
	for (const entry of entries) {
		if (!ENTRY_ID.test(entry.id)) continue;
		lines.push({ type: "message", id: entry.id, parentId: previous, timestamp: new Date(entry.ts || entry.message?.timestamp || Date.now()).toISOString(), message: entry.message });
		previous = entry.id;
	}
	return { lines, leaf: previous };
}

/** A title line in the PC's format. */
export function titleLine(id, parent, title) {
	return { type: "session_info", id, parentId: parent ?? null, timestamp: new Date().toISOString(), name: String(title).slice(0, 120) };
}

/**
 * The messages a phone model reads of a chat that ran on a PC: tool calls of tools the phone does not have become
 * text (a provider refuses calls to tools it was not given), as do their results.
 */
export function phoneContext(messages, toolNames) {
	const known = new Set(toolNames);
	const foreign = new Set();
	const out = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const content = [];
			for (const part of message.content) {
				if (part?.type === "toolCall" && !known.has(part.name)) {
					foreign.add(part.id);
					content.push({ type: "text", text: `[On the PC the assistant used the tool ${part.name}: ${JSON.stringify(part.arguments ?? {}).slice(0, 600)}]` });
				} else content.push(part);
			}
			out.push({ ...message, content });
			continue;
		}
		if (message.role === "toolResult" && foreign.has(message.toolCallId)) {
			const text = (Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
			out.push({ role: "user", content: [{ type: "text", text: `[Result of ${message.toolName || "the tool"} on the PC${message.isError ? ", an error" : ""}]\n${text.slice(0, 4000)}` }], timestamp: message.timestamp || Date.now() });
			continue;
		}
		out.push(message);
	}
	return out;
}

/** Memories that fit the words of a question best (the phone's memory_search tool). */
export function searchMemories(memories, query, limit = 8) {
	const words = String(query || "")
		.toLowerCase()
		.split(/[\s,.;:!?，。；：！？、]+/)
		.filter((word) => word.length > 1 || /[一-鿿]/.test(word));
	if (!words.length) return memories.slice(0, limit);
	const scored = memories.map((memory) => {
		const name = `${memory.name} ${memory.description}`.toLowerCase();
		const body = String(memory.content || "").toLowerCase();
		let score = 0;
		for (const word of words) {
			if (name.includes(word)) score += 3;
			if (body.includes(word)) score += 1;
			// Chinese has no spaces: a word's characters count one by one too.
			if (/[一-鿿]/.test(word)) for (const char of word) if (body.includes(char) || name.includes(char)) score += 0.2;
		}
		return { memory, score };
	});
	return scored
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.memory);
}
