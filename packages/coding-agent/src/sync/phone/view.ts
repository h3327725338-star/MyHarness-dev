/**
 * What one computer tells a phone (`phone-v1/views/<deviceId>.json.gz`, `<deviceId>.memories.json.gz` and
 * `<deviceId>.dial.json.gz`).
 *
 * A view only describes: the chats this computer has committed to the sync space (the content stays in
 * `sync-v1/objects/<hash>`, so a phone downloads a chat only when it opens it), the Providers and API keys that a phone
 * can use, the web search sources and keys, the global memories and the user profile, and the built-in browser's
 * bookmarks and the shortcuts of its new-tab page (a file of their own: their icons are large and change rarely, the
 * view changes with every chat). Every computer writes its
 * own view; a phone combines them (each chat from the view that has its newest version, the settings, memories and
 * bookmarks from the computer that has seen the most of them), so no computer has to be the "main" one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMemoryProfile, readMemoryEntries } from "../../agent/runtime/auto-memory.ts";
import { UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import { WorkspaceStore } from "../../data/workspace-store.ts";
import { getMemoryPaths } from "../../session/memory/store.ts";
import { listWorkspaceSessions } from "../../session/storage/jsonl/index.ts";
import type { SessionInfo } from "../../session/types.ts";
import type { SyncRecord, VersionVector } from "../types.ts";

export const PHONE_VIEW_VERSION = 1;

/** The four request formats the phone's own agent speaks. */
export const PHONE_APIS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

export interface PhoneModel {
	id: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, unknown>;
	compat?: Record<string, unknown>;
}

export interface PhoneProvider {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	/** The key this computer uses for the Provider (only a key saved in MyHarness, never an environment variable). */
	apiKey: string;
	models: PhoneModel[];
}

export interface PhoneChatRow {
	/** The sync record key, `session:<workspaceId>/<sessionId>`. */
	key: string;
	workspaceId: string;
	/** Empty for the default group (chats without a Workspace). */
	workspaceName: string;
	sessionId: string;
	title: string;
	preview: string;
	createdAt: string;
	updatedAt: string;
	/** SHA-256 of the conversation JSONL in `sync-v1/objects/`. */
	hash: string;
	size: number;
	messageCount: number;
	archived: boolean;
	/** Sum of the record's version vector: the view with the larger one has the newer version. */
	rank: number;
	/** The phone chat this one was made from, for a chat a phone started. */
	origin?: string;
}

export interface PhoneMemory {
	id: string;
	name: string;
	description: string;
	content: string;
	updatedAt: string;
	profile: boolean;
}

export interface PhoneView {
	version: 1;
	device: { id: string; name: string; version: string };
	writtenAt: string;
	settings: {
		rank: number;
		providers: PhoneProvider[];
		/** The model new General chats start with on the computer. */
		model: { provider: string; id: string } | null;
		thinkingLevel: string | null;
		/** The web search sources switched on here, and the keys saved for them (absent from computers before 0.0.10). */
		search?: PhoneSearch;
	};
	chats: PhoneChatRow[];
	bookmarks: { rank: number; items: Array<{ title: string; url: string; icon?: string }> };
}

/** Web search as this computer is set up: the phone's own agent searches the same way without being set up again. */
export interface PhoneSearch {
	engines: string[];
	/** Tavily API keys saved in MyHarness (never one from an environment variable), in the order they are tried. */
	tavilyKeys: string[];
}

export interface PhoneDialSite {
	id: string;
	type: "site";
	title: string;
	url: string;
	icon?: string;
}

export interface PhoneDialGroup {
	id: string;
	type: "group";
	title: string;
	items: PhoneDialSite[];
}

/** The shortcuts of the built-in browser's new-tab page, in their order, groups included. */
export interface PhoneDialPack {
	version: 1;
	device: { id: string; name: string };
	writtenAt: string;
	rank: number;
	items: Array<PhoneDialSite | PhoneDialGroup>;
}

export interface PhoneMemoryPack {
	version: 1;
	device: { id: string; name: string };
	writtenAt: string;
	rank: number;
	entries: PhoneMemory[];
}

export function vectorSum(vector: VersionVector | undefined): number {
	let sum = 0;
	for (const value of Object.values(vector ?? {})) if (Number.isFinite(value)) sum += value;
	return sum;
}

/** A phone chat that a computer turned into a chat of its own keeps the phone chat's id in its session id. */
export const PHONE_SESSION_PREFIX = "phone-";

export function phoneSessionId(phoneChatId: string): string | undefined {
	const clean = phoneChatId.replace(/[^A-Za-z0-9._-]+/gu, "").replace(/^[._-]+|[._-]+$/gu, "");
	if (!clean || clean.length > 80) return undefined;
	return `${PHONE_SESSION_PREFIX}${clean}`;
}

const MAX_ICON_CHARS = 12 * 1024;
const PREVIEW_CHARS = 140;

function sessionIdOf(info: SessionInfo): string {
	// .../sessions/<sessionId>/conversation/<file>.jsonl
	const parts = info.path.split(/[\\/]/u);
	const at = parts.lastIndexOf("conversation");
	return at > 0 ? parts[at - 1]! : info.id;
}

/** The chats of this computer's sync records, newest first, with what the sidebar shows for each. */
export async function buildPhoneChats(input: {
	dataRoot: string;
	agentDir: string;
	committed: Readonly<Record<string, SyncRecord>>;
}): Promise<PhoneChatRow[]> {
	const byWorkspace = new Map<string, Map<string, SyncRecord>>();
	for (const record of Object.values(input.committed)) {
		if (record.kind !== "session" || !record.hash) continue;
		const [workspaceId, sessionId] = record.id.split("/");
		if (!workspaceId || !sessionId) continue;
		let sessions = byWorkspace.get(workspaceId);
		if (!sessions) {
			sessions = new Map();
			byWorkspace.set(workspaceId, sessions);
		}
		sessions.set(sessionId, record);
	}
	const names = new Map<string, string>();
	try {
		for (const workspace of WorkspaceStore.create(input.agentDir, input.dataRoot).list()) {
			names.set(workspace.workspaceId, workspace.name);
		}
	} catch {
		// Without the registry the chats are still listed, without their Workspace name.
	}
	const rows: PhoneChatRow[] = [];
	for (const [workspaceId, sessions] of byWorkspace) {
		let infos: SessionInfo[] = [];
		try {
			infos = await listWorkspaceSessions(input.dataRoot, workspaceId);
		} catch {
			infos = [];
		}
		for (const info of infos) {
			const sessionId = sessionIdOf(info);
			const record = sessions.get(sessionId);
			if (!record || (info.mode && info.mode !== "general")) continue;
			const firstLine = (info.firstMessage || "").split("\n").find((line) => line.trim()) ?? "";
			rows.push({
				key: record.key,
				workspaceId,
				workspaceName: workspaceId === UNBOUND_WORKSPACE_ID ? "" : (names.get(workspaceId) ?? ""),
				sessionId,
				title: (info.name || firstLine || "").trim().slice(0, 120),
				preview: firstLine.trim().slice(0, PREVIEW_CHARS),
				createdAt: info.created.toISOString(),
				updatedAt: record.updatedAt,
				hash: record.hash,
				size: record.size,
				messageCount: info.messageCount,
				archived: existsSync(`${info.path}.archived`),
				rank: vectorSum(record.vector),
				...(sessionId.startsWith(PHONE_SESSION_PREFIX)
					? { origin: sessionId.slice(PHONE_SESSION_PREFIX.length) }
					: {}),
			});
		}
	}
	return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The global memories and the user profile, as the phone's agent reads them. */
export function buildPhoneMemories(dataRoot: string): PhoneMemory[] {
	const paths = getMemoryPaths({ dataRoot, workspaceId: UNBOUND_WORKSPACE_ID, sessionId: "phone-view" });
	let entries: ReturnType<typeof readMemoryEntries> = [];
	try {
		entries = readMemoryEntries({
			globalDir: paths.globalDir,
			projectDir: join(paths.globalDir, ".none"),
			sessionDir: join(paths.globalDir, ".none"),
		});
	} catch {
		entries = [];
	}
	return entries
		.filter((entry) => entry.scope === "global")
		.map((entry) => ({
			id: entry.id,
			name: entry.name,
			description: entry.description,
			content: entry.content,
			updatedAt: entry.updatedAt,
			profile: isMemoryProfile(entry),
		}));
}

/** The built-in browser's bookmarks (desktop profile), without icons too large to send. */
export function buildPhoneBookmarks(agentDir: string): Array<{ title: string; url: string; icon?: string }> {
	try {
		const value = JSON.parse(readFileSync(join(agentDir, "desktop-profile", "browser-bookmarks.json"), "utf8")) as {
			bookmarks?: Array<Record<string, unknown>>;
		};
		return (value.bookmarks ?? [])
			.filter((entry) => typeof entry.url === "string" && /^https?:\/\//iu.test(entry.url))
			.map((entry) => ({
				title: typeof entry.title === "string" ? entry.title.slice(0, 200) : String(entry.url),
				url: String(entry.url),
				...(typeof entry.icon === "string" && entry.icon.length <= MAX_ICON_CHARS ? { icon: entry.icon } : {}),
			}))
			.slice(0, 500);
	} catch {
		return [];
	}
}

const MAX_DIAL_ICON_CHARS = 160 * 1024;
const MAX_DIAL_ICONS_CHARS = 2 * 1024 * 1024;
const MAX_DIAL_ITEMS = 120;

/**
 * The shortcuts of the new-tab page (desktop profile, `browser-speed-dial.json`) as the desktop draws them: sites and
 * groups of sites in their order. Before the user arranged any, the desktop shows the first bookmarks there; so does
 * this. Icons too large to send are left out (the phone then shows the site's first letter).
 */
export function buildPhoneSpeedDial(agentDir: string): Array<PhoneDialSite | PhoneDialGroup> {
	let budget = MAX_DIAL_ICONS_CHARS;
	const site = (entry: Record<string, unknown>, index: number): PhoneDialSite | null => {
		if (typeof entry.url !== "string" || !/^https?:\/\//iu.test(entry.url)) return null;
		const icon = typeof entry.icon === "string" && entry.icon.startsWith("data:image/") ? entry.icon : "";
		const keep = icon.length > 0 && icon.length <= MAX_DIAL_ICON_CHARS && icon.length <= budget;
		if (keep) budget -= icon.length;
		return {
			id: typeof entry.id === "string" && entry.id ? entry.id : `site-${index}`,
			type: "site",
			title: typeof entry.title === "string" ? entry.title.slice(0, 80) : "",
			url: entry.url,
			...(keep ? { icon } : {}),
		};
	};
	const sites = (list: unknown): PhoneDialSite[] =>
		(Array.isArray(list) ? list : [])
			.map((entry, index) =>
				entry && typeof entry === "object" ? site(entry as Record<string, unknown>, index) : null,
			)
			.filter((entry): entry is PhoneDialSite => entry !== null);
	try {
		const value = JSON.parse(readFileSync(join(agentDir, "desktop-profile", "browser-speed-dial.json"), "utf8")) as {
			items?: Array<Record<string, unknown>>;
		};
		const items: Array<PhoneDialSite | PhoneDialGroup> = [];
		for (const [index, entry] of (Array.isArray(value.items) ? value.items : []).entries()) {
			if (!entry || typeof entry !== "object") continue;
			if (entry.type === "group") {
				const inside = sites(entry.items);
				if (!inside.length) continue;
				items.push({
					id: typeof entry.id === "string" && entry.id ? entry.id : `group-${index}`,
					type: "group",
					title: typeof entry.title === "string" ? entry.title.slice(0, 80) : "",
					items: inside,
				});
			} else {
				const one = site(entry, index);
				if (one) items.push(one);
			}
			if (items.length >= MAX_DIAL_ITEMS) break;
		}
		if (items.length) return items;
	} catch {
		// Not arranged yet (or unreadable): the first bookmarks, as on the desktop.
	}
	return buildPhoneBookmarks(agentDir)
		.slice(0, 12)
		.map((entry, index) => ({ id: `bookmark-${index}`, type: "site" as const, ...entry }));
}

/** How much of a kind of record this computer has seen: what a phone uses to choose between two computers' views. */
export function rankOf(committed: Readonly<Record<string, SyncRecord>>, kind: SyncRecord["kind"], id?: string): number {
	let sum = 0;
	for (const record of Object.values(committed)) {
		if (record.kind !== kind || (id !== undefined && record.id !== id)) continue;
		sum += vectorSum(record.vector);
	}
	return sum;
}
