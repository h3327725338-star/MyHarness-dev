// The phone's own agent: chats that run on the phone, with the model providers the user set up here. The Agent loop
// and the provider adapters are the desktop's (core.bundle.js, built from packages/agent and packages/ai); this module
// adds what a product needs around them: providers and keys, saved chats, titles, and the events the page draws.
//
// Signed in with Google (account.js), the phone also has what the account's PCs have: their Providers with their keys
// and default model, their General chats (opened here, continued here, and the new lines sent back), and their
// memories (the profile in the prompt, the rest through memory_search / memory_get). Changes made here go to the PCs
// through the outbox; the phone never writes the PCs' sync state itself.
import { t } from "/shared/i18n.js";
import { uid } from "/shared/util.js";
import { Agent, clampThinkingLevel, completeSimple, getSupportedThinkingLevels, streamSimple } from "./core.bundle.js";
import { account as accountApi, onAccountView, queueOps, signedIn } from "./account.js";
import { chatFromJsonl, linesForPc, phoneContext, titleLine } from "./account-view.js";
import * as db from "./db.js";
import { addPending, applyEvent, removePending } from "./live.js";
import { httpFetch, nativeInfo, notifyDone, runActive, secretDelete, secretGet, secretSet } from "./native.js";
import { prefs, resolvedLang, setPrefs } from "./prefs.js";
import { PROMPTS } from "./prompts.generated.js";
import { emit, emptyChat, state, toast } from "./store.js";
import { buildTools, memoryTools } from "./tools.js";
import { textOf, wireAssistant, wireEntries, wireEntry } from "./wire.js";

// ---- Providers ---------------------------------------------------------------------------------
export const API_KINDS = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", hint: "https://api.example.com/v1" },
	{ value: "openai-responses", label: "OpenAI Responses", hint: "https://api.openai.com/v1" },
	{ value: "anthropic-messages", label: "Anthropic Messages", hint: "https://api.anthropic.com" },
	{ value: "google-generative-ai", label: "Google Gemini", hint: "https://generativelanguage.googleapis.com/v1beta" },
];

/** Starting points for the "add provider" form. Addresses are the providers' documented API roots; models are fetched, never guessed. */
export const PROVIDER_PRESETS = [
	{ key: "openai", name: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	{ key: "anthropic", name: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	{ key: "google", name: "Google Gemini", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
	{ key: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
	{ key: "openrouter", name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
	{ key: "zhipu", name: "智谱 GLM", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
	{ key: "custom", name: "", api: "openai-completions", baseUrl: "" },
];

let providers = [];
export const getProviders = () => providers;
export const providerKey = (id) => secretGet(`provider.${id}`);
const modelKey = (providerId, modelId) => `${providerId}/${modelId}`;

function coreModel(provider, model) {
	return {
		id: model.id,
		name: model.name || model.id,
		api: provider.api,
		provider: provider.id,
		baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
		reasoning: !!model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Number(model.contextWindow) || 128000,
		maxTokens: Number(model.maxTokens) || 8192,
		...(provider.headers ? { headers: provider.headers } : {}),
		...(model.compat || provider.compat ? { compat: { ...provider.compat, ...model.compat } } : {}),
	};
}

function findModel(key = prefs.model) {
	for (const provider of providers) for (const model of provider.models || []) if (modelKey(provider.id, model.id) === key) return { provider, model };
	return null;
}

function firstModel() {
	for (const provider of providers) if (provider.models?.length) return { provider, model: provider.models[0] };
	return null;
}

/** Publish the providers and the chosen model to the page. */
function publishModels() {
	let found = findModel();
	if (!found) {
		found = firstModel();
		if (found && prefs.model !== modelKey(found.provider.id, found.model.id)) setPrefs({ model: modelKey(found.provider.id, found.model.id) });
	}
	const model = found ? coreModel(found.provider, found.model) : null;
	const efforts = model ? getSupportedThinkingLevels(model) : [];
	const effort = model ? clampThinkingLevel(model, prefs.effort || "off") : "off";
	state.local.models = {
		loaded: true,
		providers: providers.map((provider) => ({
			id: provider.id,
			name: provider.name,
			hasKey: !!providerKey(provider.id),
			models: (provider.models || []).map((entry) => ({ id: entry.id, name: entry.name || entry.id, reasoning: !!entry.reasoning, vision: !!entry.vision })),
		})),
		current: found ? { provider: found.provider.id, providerName: found.provider.name, id: found.model.id, name: found.model.name || found.model.id, reasoning: !!found.model.reasoning, vision: !!found.model.vision } : null,
		efforts: efforts.length > 1 ? efforts : [],
		effort,
	};
	emit();
}

async function persistProviders() {
	await db.kvSet("providers", providers);
	publishModels();
}

/** What a PC's importer takes for `provider.save` (packages/coding-agent/src/sync/phone/importer.ts). */
function providerForPc(provider) {
	return {
		id: provider.id,
		name: provider.name,
		api: provider.api,
		baseUrl: provider.baseUrl,
		...(provider.headers ? { headers: provider.headers } : {}),
		models: (provider.models || []).map((model) => ({ id: model.id, name: model.name || model.id, reasoning: !!model.reasoning, vision: !!model.vision, ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}) })),
	};
}

/** Add or change a provider. `apiKey` undefined keeps the stored key; an empty string removes it. */
export async function saveProvider(provider, apiKey) {
	const before = providers.find((entry) => entry.id === provider.id);
	const clean = {
		id: provider.id || uid("p").replace(/[^a-z0-9]/gi, ""),
		name: String(provider.name || "").trim() || t("Provider"),
		api: provider.api,
		baseUrl: String(provider.baseUrl || "").trim().replace(/\/+$/, ""),
		models: (provider.models || []).map((model) => ({ ...model, id: String(model.id).trim() })).filter((model) => model.id),
		...(provider.headers ? { headers: provider.headers } : {}),
		...(provider.compat ? { compat: provider.compat } : {}),
		// Signed in, a Provider belongs to the account: the PCs get it too, and it comes back in their view.
		...(signedIn() || before?.synced ? { synced: true, sentAt: Date.now() } : {}),
	};
	if (apiKey !== undefined && !secretSet(`provider.${clean.id}`, apiKey)) throw new Error(t("The key could not be stored on this phone."));
	if (signedIn()) await queueOps([{ type: "provider.save", provider: providerForPc(clean), ...(providerKey(clean.id) ? { apiKey: providerKey(clean.id) } : {}) }]);
	const at = providers.findIndex((entry) => entry.id === clean.id);
	providers = at >= 0 ? providers.map((entry, index) => (index === at ? clean : entry)) : [...providers, clean];
	await persistProviders();
	return clean;
}

/** Remove a provider. One that came from the PCs is removed there too (the settings page asks first). */
export async function removeProvider(id) {
	const removed = providers.find((entry) => entry.id === id);
	if (removed?.synced && signedIn()) await queueOps([{ type: "provider.remove", id }]);
	providers = providers.filter((entry) => entry.id !== id);
	secretDelete(`provider.${id}`);
	await persistProviders();
}

/**
 * Take the PCs' Providers: each one with its key, the same id as on the PCs. A synced Provider that the PCs no longer
 * have is removed, unless it was saved here after their view was written (it is on its way to them).
 */
function applySyncedProviders(settings) {
	const incoming = Array.isArray(settings?.providers) ? settings.providers : [];
	const writtenAt = Date.parse(settings?.writtenAt || "") || 0;
	const ids = new Set(incoming.map((entry) => entry.id));
	let changed = false;
	const next = providers.filter((entry) => {
		if (!entry.synced || ids.has(entry.id) || (entry.sentAt || 0) > writtenAt) return true;
		secretDelete(`provider.${entry.id}`);
		changed = true;
		return false;
	});
	for (const remote of incoming) {
		if (!remote?.id || !API_KINDS.some((kind) => kind.value === remote.api)) continue;
		const local = next.find((entry) => entry.id === remote.id);
		// A change made here that the PCs have not shown back yet wins over their older view.
		if (local && (local.sentAt || 0) > writtenAt) continue;
		const clean = {
			id: remote.id,
			name: remote.name || remote.id,
			api: remote.api,
			baseUrl: String(remote.baseUrl || "").replace(/\/+$/, ""),
			models: (remote.models || []).map((model) => ({ id: model.id, name: model.name || model.id, reasoning: !!model.reasoning, vision: !!model.vision, contextWindow: model.contextWindow, maxTokens: model.maxTokens, ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}), ...(model.compat ? { compat: model.compat } : {}) })),
			...(remote.headers ? { headers: remote.headers } : {}),
			...(remote.compat ? { compat: remote.compat } : {}),
			synced: true,
		};
		if (remote.apiKey && providerKey(remote.id) !== remote.apiKey) {
			secretSet(`provider.${remote.id}`, remote.apiKey);
			changed = true;
		}
		const at = next.findIndex((entry) => entry.id === remote.id);
		if (at < 0) next.push(clean);
		else if (JSON.stringify(next[at]) !== JSON.stringify(clean)) next[at] = clean;
		else continue;
		changed = true;
	}
	providers = next;
	// The PCs' default model, until a model is picked on the phone.
	const wanted = settings?.model ? modelKey(settings.model.provider, settings.model.id) : "";
	if (wanted && !prefs.modelPicked && prefs.model !== wanted && findModel(wanted)) {
		setPrefs({ model: wanted, ...(settings.thinkingLevel ? { effort: settings.thinkingLevel } : {}) });
		changed = true;
	}
	return changed;
}

/** Signed in for the first time: Providers set up only on this phone go to the PCs as well. */
async function shareLocalProviders() {
	const local = providers.filter((entry) => !entry.synced);
	if (!local.length) return;
	providers = providers.map((entry) => (entry.synced ? entry : { ...entry, synced: true, sentAt: Date.now() }));
	await queueOps(local.map((entry) => ({ type: "provider.save", provider: providerForPc(entry), ...(providerKey(entry.id) ? { apiKey: providerKey(entry.id) } : {}) })));
	await persistProviders();
}

/** The model ids a provider offers, asked from the provider itself with the given key. */
export async function fetchModelIds({ api, baseUrl }, apiKey) {
	const root = String(baseUrl || "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(root)) throw new Error(t("Enter the provider's address first (it starts with https://)."));
	let url = `${root}/models`;
	const headers = { accept: "application/json" };
	if (api === "anthropic-messages") {
		url = `${root.replace(/\/v1$/, "")}/v1/models?limit=1000`;
		headers["x-api-key"] = apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else if (api === "google-generative-ai") {
		url = `${root}/models?pageSize=1000`;
		headers["x-goog-api-key"] = apiKey;
	} else if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await httpFetch(url, { headers });
	const body = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error(t("The provider's answer is not a model list."));
	}
	const rows = Array.isArray(data) ? data : data.data || data.models || [];
	const ids = [];
	for (const row of rows) {
		if (api === "google-generative-ai") {
			if (row.supportedGenerationMethods && !row.supportedGenerationMethods.includes("generateContent")) continue;
			ids.push({ id: String(row.name || "").replace(/^models\//, ""), name: row.displayName || "", contextWindow: row.inputTokenLimit, maxTokens: row.outputTokenLimit });
		} else if (row?.id) ids.push({ id: String(row.id), name: row.display_name || row.name || "", contextWindow: row.context_length || row.context_window || undefined });
	}
	return ids.filter((entry) => entry.id).sort((a, b) => a.id.localeCompare(b.id));
}

// ---- Prompt and context ------------------------------------------------------------------------
function systemPrompt() {
	const now = new Date();
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
	const mm = String(Math.abs(offset) % 60).padStart(2, "0");
	const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
	const environment = [
		"# Environment",
		`- Current local date and time: ${local} (${weekday}), UTC${sign}${hh}:${mm}${zone ? `, time zone ${zone}` : ""}.`,
		`- Device: Android phone${nativeInfo.device && nativeInfo.device !== "Browser" ? ` (${nativeInfo.device})` : ""}.`,
		`- Interface language of the app: ${resolvedLang() === "zh-CN" ? "Simplified Chinese" : "English"}.`,
	].join("\n");
	const personal = String(prefs.personalPrompt || "").trim();
	return [PROMPTS.identity.trim(), PROMPTS.outputLanguage.trim(), environment, personal ? `# The user's own instructions\n${personal}` : "", memoryPrompt()].filter(Boolean).join("\n\n");
}

// ---- Memories (from the account's PCs) ---------------------------------------------------------
let memories = [];
const PROFILE_CHARS = 8000;

function memoryPrompt() {
	if (!memories.length) return "";
	let profile = "";
	for (const memory of memories.filter((entry) => entry.profile)) {
		const next = `## ${memory.name}\n${String(memory.content || "").trim()}\n`;
		if (profile.length + next.length > PROFILE_CHARS) break;
		profile += next;
	}
	return [
		"# What you remember about the user",
		"These are the user's own MyHarness memories, kept on their PCs and read here. Use them where they help; do not recite them.",
		profile.trim(),
		`There are ${memories.length} memories in all. Look for others with memory_search and read one with memory_get when the conversation needs what they hold.`,
	]
		.filter(Boolean)
		.join("\n\n");
}

function messageSize(message) {
	if (typeof message.content === "string") return message.content.length / 3;
	let size = 0;
	for (const part of message.content || []) {
		if (part.type === "image") size += 1500;
		else if (part.type === "text") size += part.text.length / 3;
		else if (part.type === "thinking") size += (part.thinking?.length || 0) / 3;
		else if (part.type === "toolCall") size += JSON.stringify(part.arguments || {}).length / 3 + 20;
	}
	return size + 8;
}

/**
 * Keep the request inside the model's context window: when the chat has grown past it, the oldest rounds are left out
 * of the request (they stay in the chat on the phone). A round is never cut in the middle, and the newest one always goes.
 */
function trimContext(messages, model) {
	const budget = Math.max(4000, (model.contextWindow || 128000) - (model.maxTokens || 8192) - 6000);
	let total = 0;
	for (const message of messages) total += messageSize(message);
	if (total <= budget) return messages;
	const starts = [];
	messages.forEach((message, index) => message.role === "user" && starts.push(index));
	let from = 0;
	for (let i = 1; i < starts.length && total > budget; i++) {
		for (let k = from; k < starts[i]; k++) total -= messageSize(messages[k]);
		from = starts[i];
	}
	return from > 0 ? messages.slice(from) : messages;
}

// ---- Sessions ----------------------------------------------------------------------------------
const sessions = new Map();
let liveSeq = 0;
let runSeq = 0;

function chatRow(session) {
	const { row } = session;
	return { id: row.id, title: row.title || t("New chat"), updatedAt: row.updatedAt, preview: row.preview || "", running: !!session.chat.running, synced: !!row.sync?.key || !!row.sync?.shared };
}

let pcChats = []; // the PCs' General chats (account-view.js mergeViews)
let hiddenKeys = new Set(); // PC chats removed from this phone's list (they stay on the PCs)

function publishChats() {
	const rows = [...sessions.values()].filter((session) => session.saved);
	const keys = new Set(rows.map((session) => session.row.sync?.key).filter(Boolean));
	const ids = new Set(rows.map((session) => session.row.id));
	const remote = pcChats
		.filter((chat) => !chat.archived && !keys.has(chat.key) && !hiddenKeys.has(chat.key) && !(chat.origin && ids.has(chat.origin)))
		.map((chat) => ({ id: `sync:${chat.key}`, title: chat.title || t("New chat"), updatedAt: Date.parse(chat.updatedAt) || 0, preview: chat.preview || "", running: false, synced: true, place: chat.workspaceName || "" }));
	state.local.chats = [...rows.map(chatRow), ...remote].sort((a, b) => b.updatedAt - a.updatedAt);
	state.local.chatsLoaded = true;
	emit();
}

/** Lines of a chat the PCs do not have yet, in their format, sent through the outbox. */
async function sendNewLines(session) {
	if (!signedIn()) return;
	const { row } = session;
	row.sync ??= { shared: true, known: [] };
	const known = new Set(row.sync.known || []);
	const entries = session.entries.filter((entry) => entry.message && entry.message.role);
	// Each line hangs on the one before it in the phone's chat; the first phone line of a PC chat hangs on that chat's
	// last line on the PC.
	const lines = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (known.has(entry.id)) continue;
		const previous = entries[index - 1];
		const parent = !previous ? null : previous.id === row.sync.lastPc ? row.sync.leaf || previous.id : previous.id;
		lines.push(...linesForPc([entry], parent).lines);
	}
	const titled = row.titled && row.title && row.sync.sentTitle !== row.title;
	if (!lines.length && !titled) return;
	const last = lines.at(-1)?.id || entries.at(-1)?.id || row.sync.leaf || null;
	if (titled) lines.push(titleLine(`t-${Date.now().toString(36)}`, last, row.title));
	await queueOps([{ type: "chat.append", chatId: row.id, ...(row.sync.key ? { key: row.sync.key } : {}), createdAt: new Date(row.createdAt || Date.now()).toISOString(), entries: lines }]);
	for (const line of lines) if (line.type === "message") known.add(line.id);
	row.sync.known = [...known];
	if (titled) row.sync.sentTitle = row.title;
	scheduleSave(session, true);
}

/** Open a chat of the PCs here: its content is read from the account's Drive, the branch the PC shows. */
async function openPcChat(key) {
	const chat = pcChats.find((entry) => entry.key === key);
	if (!chat) throw new Error(t("This chat is no longer on the PCs."));
	const existing = [...sessions.values()].find((session) => session.row.sync?.key === key);
	const placeholder = emptyChat();
	placeholder.id = `sync:${key}`;
	placeholder.title = chat.title || "";
	placeholder.loading = true;
	state.local.chat = placeholder;
	emit();
	try {
		const text = await accountApi.readChat(chat.hash);
		if (!text) throw new Error(t("The chat's content is not in Google Drive yet. Try again in a minute."));
		const parsed = chatFromJsonl(text);
		const last = parsed.entries.at(-1);
		const row = {
			id: existing?.row.id || uid("c"),
			title: parsed.title || chat.title || t("New chat"),
			createdAt: Date.parse(chat.createdAt) || Date.now(),
			updatedAt: Date.parse(chat.updatedAt) || Date.now(),
			preview: chat.preview || "",
			titled: true,
			sync: { key, hash: chat.hash, leaf: parsed.leaf, lastPc: last?.id || null, known: parsed.entries.map((entry) => entry.id), sentTitle: parsed.title || chat.title || "" },
		};
		if (existing) sessions.delete(existing.row.id);
		const session = createSession(row, parsed.entries, true);
		scheduleSave(session, true);
		publishChats();
		if (state.local.chat === placeholder) showSession(session);
		return session;
	} catch (error) {
		placeholder.loading = false;
		emit();
		throw error;
	}
}

/** The account's view changed: Providers, default model, chats and memories as the PCs have them now. */
function applyAccountView(view, list) {
	memories = Array.isArray(list) ? list : [];
	state.pcBookmarks = view ? view.bookmarks || [] : [];
	if (!view) {
		// Signed out: what came from the account leaves the phone; chats stay, as chats of this phone.
		const before = providers.length;
		providers = providers.filter((entry) => {
			if (entry.synced) secretDelete(`provider.${entry.id}`);
			return !entry.synced;
		});
		pcChats = [];
		if (before !== providers.length) persistProviders();
		publishChats();
		return;
	}
	if (applySyncedProviders(view.settings)) persistProviders();
	pcChats = Array.isArray(view.chats) ? view.chats : [];
	// A chat started on this phone that a PC turned into its own: from now on its lines name that chat.
	for (const chat of pcChats) {
		if (!chat.origin) continue;
		const session = sessions.get(chat.origin);
		if (session && !session.row.sync?.key) {
			session.row.sync = { ...(session.row.sync || {}), key: chat.key };
			scheduleSave(session, true);
		}
	}
	// A PC chat kept here that changed on a PC is read again when it is opened (if nothing waits to be sent).
	for (const session of sessions.values()) {
		const key = session.row.sync?.key;
		if (!key) continue;
		const chat = pcChats.find((entry) => entry.key === key);
		if (chat && chat.hash !== session.row.sync.hash) session.row.sync.stale = chat.hash;
	}
	publishChats();
}

function createSession(row, entries, saved) {
	const chat = emptyChat();
	chat.id = row.id;
	chat.title = row.title || "";
	chat.items = wireEntries(entries);
	const session = { row, entries, chat, saved, agent: null, loaded: true, metaOf: new WeakMap(), liveId: null, updateTimer: 0, pendingUpdate: null, saveTimer: 0, run: null };
	sessions.set(row.id, session);
	return session;
}

function scheduleSave(session, now = false) {
	clearTimeout(session.saveTimer);
	const save = () => {
		session.saved = true;
		db.saveChat(session.row, session.entries).catch((error) => console.error("chat save failed", error));
	};
	if (now) save();
	else session.saveTimer = setTimeout(save, 400);
}

const isShown = (session) => state.local.chat === session.chat;

function apply(session, name, data) {
	if (applyEvent(session.chat, name, data) && isShown(session)) emit();
}

function flushUpdate(session) {
	clearTimeout(session.updateTimer);
	session.updateTimer = 0;
	const message = session.pendingUpdate;
	session.pendingUpdate = null;
	if (message && session.liveId) apply(session, "message_update", { liveId: session.liveId, item: wireAssistant(message) });
}

function addEntry(session, message, meta) {
	const entry = { id: uid("e"), ts: message.timestamp || Date.now(), message, ...(meta ? { meta } : {}) };
	session.entries.push(entry);
	session.row.updatedAt = Date.now();
	return entry;
}

function onAgentEvent(session, event) {
	switch (event.type) {
		case "agent_start": {
			const runId = ++runSeq;
			session.run = { runId, startedAt: Date.now() };
			apply(session, "agent_start", { runId });
			apply(session, "run_state", { state: "running", startedAt: session.run.startedAt });
			runActive(true, session.row.title || t("MyHarness is working"));
			publishChats();
			break;
		}
		case "message_start": {
			const message = event.message;
			if (message.role === "user") {
				const meta = session.metaOf.get(message) || {};
				const entry = addEntry(session, message, meta);
				session.row.preview = String(meta.text ?? textOf(message.content)).slice(0, 120);
				apply(session, "message_start", { item: wireEntry(entry), clientMessageId: meta.clientMessageId });
				session.chat.queue = session.chat.queue.filter((queued) => queued.clientMessageId !== meta.clientMessageId);
				scheduleSave(session);
			} else if (message.role === "assistant") {
				session.liveId = `live-${++liveSeq}`;
				apply(session, "message_start", { liveId: session.liveId, item: wireAssistant(message) });
			}
			break;
		}
		case "message_update":
			if (event.message.role !== "assistant") break;
			// Tokens arrive far faster than a screen refreshes: the page gets the newest state about 20 times a second.
			session.pendingUpdate = event.message;
			session.updateTimer ||= setTimeout(() => flushUpdate(session), 50);
			break;
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant") {
				session.pendingUpdate = null;
				clearTimeout(session.updateTimer);
				session.updateTimer = 0;
				const endedAt = Date.now();
				const entry = addEntry(session, message, { endedAt });
				const item = wireAssistant(message);
				if (session.liveId) apply(session, "message_end", { liveId: session.liveId, item, endedAt });
				else apply(session, "message_start", { item: { ...item, final: true, endedAt } });
				apply(session, "entry_appended", { id: entry.id, item });
				session.liveId = null;
				scheduleSave(session);
			} else if (message.role === "toolResult") {
				const entry = addEntry(session, message);
				apply(session, "entry_appended", { id: entry.id, item: wireEntry(entry) });
				scheduleSave(session);
			}
			break;
		}
		case "tool_execution_start":
			apply(session, "tool_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, ts: Date.now() });
			break;
		case "tool_execution_update":
			apply(session, "tool_update", { toolCallId: event.toolCallId, text: textOf(event.partialResult?.content), details: event.partialResult?.details });
			break;
		case "tool_execution_end": {
			const result = event.result || {};
			apply(session, "tool_end", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				text: textOf(result.content),
				images: (result.content || []).filter((part) => part.type === "image").map((part) => ({ mimeType: part.mimeType, data: part.data })),
				isError: !!event.isError,
				details: result.details,
				ts: Date.now(),
			});
			break;
		}
		case "agent_end": {
			flushUpdate(session);
			const last = [...session.entries].reverse().find((entry) => entry.message.role === "assistant")?.message;
			const outcome = last?.stopReason === "aborted" ? "cancelled" : last?.stopReason === "error" ? "failed" : "completed";
			const run = session.run || { runId: ++runSeq, startedAt: Date.now() };
			session.run = null;
			session.chat.queue = [];
			apply(session, "run_finished", { runId: run.runId, outcome, startedAt: run.startedAt, endedAt: Date.now() });
			scheduleSave(session, true);
			if (![...sessions.values()].some((other) => other.chat.running)) runActive(false);
			publishChats();
			if (outcome === "completed" && document.visibilityState === "hidden" && prefs.notifyDone !== false) notifyDone(session.row.title || "MyHarness", textOf(last?.content).slice(0, 140) || t("The reply is ready."));
			if (outcome === "completed" && !session.row.titled) generateTitle(session);
			else sendNewLines(session).catch((error) => console.warn("chat lines not queued", error));
			break;
		}
		default:
			break;
	}
}

function currentModel() {
	const found = findModel() || firstModel();
	return found ? coreModel(found.provider, found.model) : null;
}

const agentTools = () => [...buildTools(), ...(memories.length ? memoryTools(() => memories) : [])];

function ensureAgent(session) {
	const model = currentModel();
	if (!model) return null;
	if (!session.agent) {
		session.agent = new Agent({
			initialState: { systemPrompt: systemPrompt(), model, thinkingLevel: "off", tools: agentTools(), messages: session.entries.map((entry) => entry.message) },
			streamFunction: streamSimple,
			getApiKey: (providerId) => providerKey(providerId) || undefined,
			transformContext: async (messages) => phoneContext(trimContext(messages, session.agent.state.model), session.agent.state.tools.map((tool) => tool.name)),
			sessionId: session.row.id,
		});
		session.agent.subscribe((event) => {
			try {
				onAgentEvent(session, event);
			} catch (error) {
				console.error("agent event failed", event.type, error);
			}
		});
	}
	const agent = session.agent;
	agent.state.model = model;
	agent.state.systemPrompt = systemPrompt();
	agent.state.tools = agentTools();
	const level = clampThinkingLevel(model, prefs.effort || "off");
	agent.state.thinkingLevel = level;
	session.row.model = modelKey(model.provider, model.id);
	return agent;
}

function cleanTitle(value) {
	return String(value || "")
		.replace(/<(think|thinking|thought|reasoning)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean)
		?.replace(/^["'“”‘’《「『#*\s]+|["'“”‘’》」』*\s。.！!]+$/g, "")
		.slice(0, 80);
}

async function generateTitle(session) {
	const model = currentModel();
	const firstUser = session.entries.find((entry) => entry.message.role === "user");
	const lastAssistant = [...session.entries].reverse().find((entry) => entry.message.role === "assistant" && entry.message.stopReason === "stop");
	if (!model || !firstUser || !lastAssistant) return;
	session.row.titled = true;
	try {
		const conversation = `User: ${String(firstUser.meta?.text ?? textOf(firstUser.message.content)).slice(0, 2000)}\n\nAssistant: ${textOf(lastAssistant.message.content).slice(0, 2000)}`;
		const answer = await completeSimple(
			model,
			{ systemPrompt: PROMPTS.title, messages: [{ role: "user", content: `<conversation>\n${conversation}\n</conversation>\n\nReturn the title for this conversation.`, timestamp: Date.now() }] },
			{ apiKey: providerKey(model.provider) || undefined, maxTokens: Math.min(model.maxTokens, 2000) },
		);
		const title = answer.stopReason === "stop" ? cleanTitle(textOf(answer.content)) : "";
		if (!title) return;
		session.row.title = title;
		session.chat.title = title;
		scheduleSave(session, true);
		publishChats();
		emit();
		sendNewLines(session).catch(() => {});
	} catch (error) {
		// The chat keeps the title made from its first message.
		console.warn("title generation failed", error);
		sendNewLines(session).catch(() => {});
	}
}

function fallbackTitle(text, attachments) {
	const line = String(text || "").split("\n").find((part) => part.trim())?.trim();
	if (line) return line.length > 30 ? `${line.slice(0, 30)}…` : line;
	return attachments[0]?.name || t("New chat");
}

/** The message as the model reads it: attached text files first (each in its own block), then what the user typed, then pictures. */
function buildUserMessage(text, attachments) {
	const files = attachments.filter((entry) => entry.type === "text");
	const images = attachments.filter((entry) => entry.type === "image");
	const blocks = files.map((file) => `<attached_file name=${JSON.stringify(file.name)}>\n${file.text}\n</attached_file>`);
	const body = [...blocks, text].filter((part) => part && part.trim()).join("\n\n");
	const content = [{ type: "text", text: body || (images.length ? "(see the attached pictures)" : "") }, ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))];
	return { role: "user", content, timestamp: Date.now() };
}

function showSession(session) {
	state.local.chat = session.chat;
	emit();
}

function blankChat() {
	const chat = emptyChat();
	state.local.chat = chat;
	emit();
}

export const local = {
	id: "local",

	async init() {
		providers = (await db.kvGet("providers", [])) || [];
		publishModels();
		const rows = await db.listChats().catch(() => []);
		for (const row of rows) {
			const session = createSession(row, [], true);
			session.loaded = false;
		}
		hiddenKeys = new Set((await db.kvGet("hidden-pc-chats", [])) || []);
		publishChats();
		let shared = false;
		onAccountView((view, list) => {
			applyAccountView(view, list);
			if (view && !shared) {
				shared = true;
				shareLocalProviders().catch((error) => console.warn("providers not shared", error));
			}
			if (!view) shared = false;
		});
	},

	hasModel: () => !!currentModel(),

	async refreshChats() {
		publishChats();
	},

	async openChat(id) {
		if (id.startsWith("sync:")) {
			await openPcChat(id.slice(5));
			return;
		}
		const session = sessions.get(id);
		if (!session) return;
		// Changed on a PC since it was read, and nothing of the phone's waits to go there: read it again.
		const sync = session.row.sync;
		if (sync?.key && sync.stale && !session.chat.running && signedIn()) {
			if (!session.loaded) session.entries = await db.getEntries(id);
			const unsent = session.entries.some((entry) => !(sync.known || []).includes(entry.id));
			if (!unsent) {
				await openPcChat(sync.key).catch((error) => toast(error.message, "error"));
				return;
			}
		}
		if (!session.loaded) {
			session.chat.loading = true;
			showSession(session);
			try {
				session.entries = await db.getEntries(id);
				session.chat.items = wireEntries(session.entries);
				session.loaded = true;
			} finally {
				session.chat.loading = false;
			}
		}
		showSession(session);
	},

	newChat() {
		blankChat();
	},

	/** Send a message in the shown chat (a first message creates the chat). While a reply runs it is queued and read at the next step. */
	async send({ text, attachments = [] }) {
		if (!currentModel()) throw new Error(t("Add a model first: Settings → Models."));
		const images = attachments.filter((entry) => entry.type === "image");
		if (images.length && !state.local.models.current?.vision) throw new Error(t("The chosen model is not marked as able to read pictures. Turn on “Reads pictures” for it in Settings → Models, or pick another model."));
		let session = sessions.get(state.local.chat.id);
		if (!session) {
			const now = Date.now();
			session = createSession({ id: uid("c"), title: fallbackTitle(text, attachments), createdAt: now, updatedAt: now, preview: "", titled: false }, [], false);
			showSession(session);
		}
		const agent = ensureAgent(session);
		const message = buildUserMessage(text, attachments);
		const clientMessageId = uid("m");
		const meta = { text, clientMessageId, attachments: attachments.filter((entry) => entry.type !== "image").map((entry) => ({ name: entry.name, size: entry.size, path: entry.name })) };
		session.metaOf.set(message, meta);
		addPending(session.chat, { clientMessageId, text, images: images.map((image) => ({ mimeType: image.mimeType, data: image.data })), attachments: meta.attachments });
		if (agent.state.isStreaming) {
			session.chat.queue = [...session.chat.queue, { text, mode: "steer", clientMessageId }];
			agent.steer(message);
			emit();
			return;
		}
		session.chat.running = true;
		session.chat.runStartedAt = Date.now();
		session.saved = true;
		emit();
		publishChats();
		agent.prompt(message).catch((error) => {
			console.error("prompt failed", error);
			removePending(session.chat, clientMessageId);
			session.chat.running = false;
			toast(error?.message || String(error), "error");
			emit();
		});
	},

	stop() {
		const session = sessions.get(state.local.chat.id);
		if (!session?.agent) return;
		// Messages still waiting are dropped with the reply they were meant for; they return to nothing, as on the desktop.
		session.agent.clearAllQueues();
		for (const queued of session.chat.queue) removePending(session.chat, queued.clientMessageId);
		session.chat.queue = [];
		session.agent.abort();
		emit();
	},

	/** Ask again after a reply that failed or was stopped: the failed reply leaves the chat and the model answers the same message. */
	async retry() {
		const session = sessions.get(state.local.chat.id);
		if (!session || session.chat.running) return;
		const agent = ensureAgent(session);
		if (!agent) throw new Error(t("Add a model first: Settings → Models."));
		while (session.entries.length) {
			const last = session.entries[session.entries.length - 1].message;
			if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) session.entries.pop();
			else break;
		}
		const tail = session.entries[session.entries.length - 1]?.message;
		if (!tail || tail.role === "assistant") return;
		agent.state.messages = session.entries.map((entry) => entry.message);
		session.chat.items = wireEntries(session.entries);
		session.chat.runs = {};
		session.chat.running = true;
		session.chat.runStartedAt = Date.now();
		emit();
		agent.continue().catch((error) => {
			session.chat.running = false;
			toast(error?.message || String(error), "error");
			emit();
		});
	},

	async setModel(providerId, modelId) {
		// Picked by hand: the PCs' default no longer replaces it.
		setPrefs({ model: modelKey(providerId, modelId), modelPicked: true });
		publishModels();
	},

	async setEffort(level) {
		setPrefs({ effort: level });
		publishModels();
	},

	async renameChat(id, title) {
		const session = sessions.get(id);
		const clean = String(title || "").trim().slice(0, 80);
		if (!session || !clean) return;
		session.row.title = clean;
		session.row.titled = true;
		session.chat.title = clean;
		if (!session.loaded) await db.putChat(session.row);
		else scheduleSave(session, true);
		publishChats();
		if (session.row.sync && session.loaded) sendNewLines(session).catch(() => {});
	},

	/** Remove a chat from this phone. A chat of the PCs stays on the PCs and leaves this phone's list. */
	async deleteChat(id) {
		const key = id.startsWith("sync:") ? id.slice(5) : sessions.get(id)?.row.sync?.key;
		if (key) {
			hiddenKeys.add(key);
			await db.kvSet("hidden-pc-chats", [...hiddenKeys]);
		}
		const session = sessions.get(id);
		if (!session) {
			publishChats();
			return;
		}
		session.agent?.abort();
		clearTimeout(session.saveTimer);
		sessions.delete(id);
		await db.deleteChat(id);
		if (state.local.chat.id === id) blankChat();
		publishChats();
	},

	async deleteAllChats() {
		for (const session of sessions.values()) {
			session.agent?.abort();
			clearTimeout(session.saveTimer);
		}
		sessions.clear();
		await db.clearChats();
		blankChat();
		publishChats();
	},

	respond() {},
	loadOlder() {},
	refreshModels: publishModels,
};
