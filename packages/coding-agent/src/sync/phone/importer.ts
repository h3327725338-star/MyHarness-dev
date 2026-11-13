/**
 * What a phone sent (`phone-v1/outbox/*.json`), applied to this computer's own files. Afterwards the ordinary sync
 * carries the change to every other computer, exactly as if it had been made here.
 *
 * Every operation is idempotent: two computers that both apply the same outbox file (each thought it was its turn)
 * produce the same files, because a chat line keeps the id the phone gave it and the sync merges chats by line id.
 *
 * Operations (`ops`):
 * - `chat.append` `{ chatId, key?, createdAt, entries }`: lines for a chat. `key` names a chat of the computers
 *   (`session:<workspaceId>/<sessionId>`); without it the lines belong to a chat the phone started, which becomes the
 *   chat `phone-<chatId>` of the default group. Lines are Session entries (`message`, `session_info`) with the ids
 *   and parents the phone chose.
 * - `provider.save` `{ provider, apiKey? }`: a Provider the phone added or changed, and the key it uses.
 * - `provider.remove` `{ id }`: a Provider the user removed on the phone.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDefaultWorkingDir, getSessionConversationDir, UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import { AuthStorage } from "../../providers/credentials/auth-storage.ts";
import { CustomProviderManager } from "../../providers/models/custom-provider-manager.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";
import { mergeSessionJsonl } from "../apply.ts";
import { ensureDir } from "../util.ts";
import { PHONE_APIS, phoneSessionId } from "./view.ts";

export class PhoneChatBusyError extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`The chat ${key} is running on this computer; the phone's lines wait for it.`);
		this.name = "PhoneChatBusyError";
		this.key = key;
	}
}

export interface PhoneOutboxFile {
	version: 1;
	phoneId: string;
	phoneName?: string;
	createdAt: string;
	ops: unknown[];
}

export interface PhoneImportContext {
	dataRoot: string;
	agentDir: string;
	isSessionActive?: (workspaceId: string, sessionId: string) => boolean;
	/**
	 * Lines for a computers' chat that never arrived here (removed on another computer) go into a chat of their own
	 * instead of waiting: set for an outbox file that has waited long enough (channel.ts).
	 */
	orphanAsNew?: boolean;
}

export interface PhoneImportResult {
	sessionsChanged: boolean;
	settingsChanged: boolean;
	/** Operations that were not what they claim to be; they are dropped. */
	refused: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_ENTRIES_PER_OP = 2000;
const ROLES = new Set(["user", "assistant", "toolResult"]);

export function parseOutboxFile(data: Uint8Array): PhoneOutboxFile | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(data));
		if (!isObject(value) || value.version !== 1 || typeof value.phoneId !== "string" || !Array.isArray(value.ops))
			return undefined;
		return {
			version: 1,
			phoneId: value.phoneId,
			...(typeof value.phoneName === "string" ? { phoneName: value.phoneName } : {}),
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
			ops: value.ops,
		};
	} catch {
		return undefined;
	}
}

/** One line the phone sent, checked: only message and title lines, with ids that cannot steer a file name. */
function cleanEntry(value: unknown): Json | undefined {
	if (!isObject(value) || typeof value.id !== "string" || !ENTRY_ID.test(value.id)) return undefined;
	if (value.parentId !== null && (typeof value.parentId !== "string" || !ENTRY_ID.test(value.parentId)))
		return undefined;
	const timestamp =
		typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))
			? new Date(value.timestamp).toISOString()
			: undefined;
	if (!timestamp) return undefined;
	if (value.type === "message") {
		const message = value.message;
		if (!isObject(message) || typeof message.role !== "string" || !ROLES.has(message.role)) return undefined;
		return { type: "message", id: value.id, parentId: value.parentId, timestamp, message };
	}
	if (value.type === "session_info") {
		const name =
			typeof value.name === "string"
				? value.name
						.replace(/[\u0000-\u001f]/gu, " ")
						.trim()
						.slice(0, 120)
				: "";
		return { type: "session_info", id: value.id, parentId: value.parentId, timestamp, ...(name ? { name } : {}) };
	}
	return undefined;
}

function conversationFileOf(directory: string): string | undefined {
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.at(-1);
	} catch {
		return undefined;
	}
}

/** Where a phone's lines go: an existing chat of the computers, or the default-group chat made from the phone's chat. */
function chatTarget(
	ctx: PhoneImportContext,
	op: Json,
): { key: string; workspaceId: string; sessionId: string; path: string; created: boolean } | undefined {
	if (typeof op.key === "string") {
		const match = /^session:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(op.key);
		if (!match) return undefined;
		const [, workspaceId, sessionId] = match as unknown as [string, string, string];
		const directory = getSessionConversationDir(ctx.dataRoot, workspaceId, sessionId);
		const file = conversationFileOf(directory);
		// A chat this computer does not have (yet): the lines wait until sync brings it.
		if (file) return { key: op.key, workspaceId, sessionId, path: join(directory, file), created: false };
		if (!ctx.orphanAsNew) return undefined;
	}
	const sessionId = typeof op.chatId === "string" ? phoneSessionId(op.chatId) : undefined;
	if (!sessionId) return undefined;
	const directory = getSessionConversationDir(ctx.dataRoot, UNBOUND_WORKSPACE_ID, sessionId);
	const existing = conversationFileOf(directory);
	const createdAt =
		typeof op.createdAt === "string" && Number.isFinite(Date.parse(op.createdAt))
			? new Date(op.createdAt).toISOString()
			: new Date().toISOString();
	// The same name on every computer, so two computers that both apply the phone's chat make one chat.
	const fileName = existing ?? `${createdAt.replace(/[:.]/gu, "-")}_${sessionId}.jsonl`;
	return {
		key: `session:${UNBOUND_WORKSPACE_ID}/${sessionId}`,
		workspaceId: UNBOUND_WORKSPACE_ID,
		sessionId,
		path: join(directory, fileName),
		created: !existing,
	};
}

class WaitForChatError extends Error {}

/** The ids of a chat file's lines (the header is not a line of the conversation). */
function lineIds(path: string): string[] {
	if (!existsSync(path)) return [];
	const ids: string[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (entry.type !== "session" && typeof entry.id === "string") ids.push(entry.id);
		} catch {
			// A damaged line names no id.
		}
	}
	return ids;
}

async function applyChatAppend(ctx: PhoneImportContext, op: Json): Promise<boolean> {
	const target = chatTarget(ctx, op);
	if (!target) {
		if (typeof op.key === "string") throw new WaitForChatError(op.key);
		throw new Error("invalid chat");
	}
	if (ctx.isSessionActive?.(target.workspaceId, target.sessionId)) throw new PhoneChatBusyError(target.key);
	const entries = (Array.isArray(op.entries) ? op.entries : []).slice(0, MAX_ENTRIES_PER_OP).map(cleanEntry);
	if (entries.some((entry) => !entry)) throw new Error("invalid chat line");
	const lines: string[] = [];
	if (target.created || !existsSync(target.path)) {
		const createdAt =
			typeof op.createdAt === "string" && Number.isFinite(Date.parse(op.createdAt))
				? new Date(op.createdAt).toISOString()
				: new Date().toISOString();
		lines.push(
			JSON.stringify({
				type: "session",
				version: 3,
				id: target.sessionId,
				mode: "general",
				timestamp: createdAt,
				cwd: getDefaultWorkingDir(ctx.agentDir),
				workspaceId: UNBOUND_WORKSPACE_ID,
			}),
		);
	}
	const known = new Set(entries.map((entry) => entry?.id));
	for (const id of lineIds(target.path)) known.add(id);
	for (const entry of entries) {
		// A line that hangs on a line this chat does not have (an orphan's first line) starts the chat instead.
		if (entry && typeof entry.parentId === "string" && !known.has(entry.parentId)) entry.parentId = null;
		lines.push(JSON.stringify(entry));
	}
	const localText = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
	const merged = mergeSessionJsonl(localText, `${lines.join("\n")}\n`, false);
	if (!merged.changed) return false;
	ensureDir(dirname(target.path));
	writeFileAtomicallySync(target.path, merged.text);
	return true;
}

function cleanModels(value: unknown): Array<Json & { id: string }> {
	if (!Array.isArray(value)) return [];
	const models: Array<Json & { id: string }> = [];
	for (const item of value.slice(0, 500)) {
		if (!isObject(item) || typeof item.id !== "string" || !item.id.trim()) continue;
		const model: Json & { id: string } = { id: item.id.trim().slice(0, 200) };
		if (typeof item.name === "string" && item.name.trim()) model.name = item.name.trim().slice(0, 200);
		if (typeof item.reasoning === "boolean") model.reasoning = item.reasoning;
		if (typeof item.vision === "boolean") model.input = item.vision ? ["text", "image"] : ["text"];
		if (typeof item.contextWindow === "number" && item.contextWindow > 0) model.contextWindow = item.contextWindow;
		if (typeof item.maxTokens === "number" && item.maxTokens > 0) model.maxTokens = item.maxTokens;
		models.push(model);
	}
	return models;
}

async function applyProviderSave(ctx: PhoneImportContext, op: Json): Promise<boolean> {
	const provider = isObject(op.provider) ? op.provider : undefined;
	const id = typeof provider?.id === "string" ? provider.id.trim() : "";
	if (!provider || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) throw new Error("invalid provider");
	const manager = new CustomProviderManager(join(ctx.agentDir, "models.json"));
	let changed = false;
	if (!manager.isBuiltinProviderId(id)) {
		const api = typeof provider.api === "string" && PHONE_APIS.has(provider.api) ? provider.api : undefined;
		const baseUrl =
			typeof provider.baseUrl === "string" && /^https?:\/\//iu.test(provider.baseUrl) ? provider.baseUrl : undefined;
		const current = (await manager.get(id)) as Json | undefined;
		const models = cleanModels(provider.models);
		const next: Json = { ...(current ?? {}) };
		if (typeof provider.name === "string" && provider.name.trim()) next.name = provider.name.trim().slice(0, 80);
		if (api) next.api = api;
		if (baseUrl) next.baseUrl = baseUrl.replace(/\/+$/u, "");
		// Models the phone lists are added or updated; models only this computer lists stay (the phone shows fewer fields).
		const existing = Array.isArray(next.models) ? (next.models as Array<Json & { id: string }>) : [];
		const byId = new Map(existing.map((model) => [model.id, model]));
		for (const model of models) byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model });
		next.models = [...byId.values()];
		if (!next.api || !next.baseUrl) throw new Error("incomplete provider");
		if (JSON.stringify(next) !== JSON.stringify(current ?? null)) {
			await manager.upsert(id, next as never);
			changed = true;
		}
	}
	if (typeof op.apiKey === "string" && op.apiKey.trim()) {
		const key = op.apiKey.trim();
		const auth = AuthStorage.create(join(ctx.agentDir, "auth.json"));
		const stored = await auth.listStoredApiKeys(id);
		const same = stored.find((entry) => entry.credential.type === "api_key" && entry.credential.key === key);
		if (same) {
			if (!same.active) {
				await auth.activateApiKey(id, same.id);
				changed = true;
			}
		} else {
			const labels = new Set(stored.map((entry) => entry.label));
			let label = "Phone";
			for (let n = 2; labels.has(label); n += 1) label = `Phone ${n}`;
			const added = await auth.addApiKey(id, label, { type: "api_key", key });
			await auth.activateApiKey(id, added.id);
			changed = true;
		}
	}
	return changed;
}

async function applyProviderRemove(ctx: PhoneImportContext, op: Json): Promise<boolean> {
	const id = typeof op.id === "string" ? op.id.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) throw new Error("invalid provider");
	const manager = new CustomProviderManager(join(ctx.agentDir, "models.json"));
	// A Provider MyHarness ships stays; only what the user added can be removed from a phone.
	if (manager.isBuiltinProviderId(id)) return false;
	return manager.delete(id);
}

/**
 * Apply one outbox file. Throws PhoneChatBusyError (or a wait) when a chat it writes to is running here or has not
 * arrived yet: the whole file then waits for the next round, so the phone's lines keep their order.
 */
export async function applyOutboxFile(ctx: PhoneImportContext, file: PhoneOutboxFile): Promise<PhoneImportResult> {
	const result: PhoneImportResult = { sessionsChanged: false, settingsChanged: false, refused: [] };
	for (const raw of file.ops) {
		if (!isObject(raw) || typeof raw.type !== "string") {
			result.refused.push("unknown");
			continue;
		}
		try {
			switch (raw.type) {
				case "chat.append":
					result.sessionsChanged = (await applyChatAppend(ctx, raw)) || result.sessionsChanged;
					break;
				case "provider.save":
					result.settingsChanged = (await applyProviderSave(ctx, raw)) || result.settingsChanged;
					break;
				case "provider.remove":
					result.settingsChanged = (await applyProviderRemove(ctx, raw)) || result.settingsChanged;
					break;
				default:
					result.refused.push(raw.type);
			}
		} catch (error) {
			if (error instanceof PhoneChatBusyError || error instanceof WaitForChatError) throw error;
			result.refused.push(`${raw.type}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

/** Whether a file waits only for a computers' chat that has not arrived here (not for one that runs). */
export function isMissingChatError(error: unknown): boolean {
	return error instanceof WaitForChatError;
}

/** Whether an error only means "later": the chat runs here, or this computer does not have it yet. */
export function isWaitError(error: unknown): boolean {
	return error instanceof PhoneChatBusyError || error instanceof WaitForChatError;
}
