/**
 * The configuration that travels between computers, as five small records of kind `settings`:
 *
 * - `models`: models.json (the Providers the user added, their models, context windows and layers);
 * - `keys`: the saved API keys of auth.json. Sign-ins (OAuth tokens) stay on the computer they were made on;
 * - `preferences`: the settings.json values that mean the same everywhere (default model, which model does which job,
 *   memory, titles, compaction, web search and so on). Paths, proxies, shells and other things of one computer stay;
 * - `model-prompts`: model-prompts.json;
 * - `search-keys`: web-search-keys.json;
 * - `mode-models`: the model each chat mode (Coding, General) starts with, from chat-mode-state.json;
 * - `skills`, `prompts`, `themes`: the user's own folders of that name in the agent directory, file by file (a file
 *   removed on one computer is removed on the others; installed extensions and packages never travel).
 *
 * Each record is published as normalized JSON text. Two computers that changed different parts both keep their change;
 * where both changed the same value, the later change wins (the first time a computer meets the record already on
 * Drive, Drive's value wins and what only this computer has is added). A record is never deleted as a whole.
 * Every file a remote version replaces is copied to `<agentDir>/sync/settings-backup/` first.
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { FileSettingsStorage } from "../config/settings/storage.ts";
import {
	FileAuthStorageBackend,
	type PortableApiKeys,
	portableApiKeysOf,
	withPortableApiKeys,
} from "../providers/credentials/auth-storage.ts";
import { MODEL_PROMPTS_FILE, modelPromptsFileText } from "../providers/models/model-prompts.ts";
import { ModeStateStore } from "../session/mode-state.ts";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stableJson } from "./util.ts";

export const SETTINGS_RECORD_IDS = [
	"models",
	"keys",
	"preferences",
	"model-prompts",
	"search-keys",
	"mode-models",
	"skills",
	"prompts",
	"themes",
] as const;
export type SettingsRecordId = (typeof SETTINGS_RECORD_IDS)[number];

/** The records that are a folder of the agent directory rather than one file. */
type FolderRecordId = "skills" | "prompts" | "themes";
const FOLDER_RECORDS: ReadonlySet<SettingsRecordId> = new Set<SettingsRecordId>(["skills", "prompts", "themes"]);

function isFolderRecord(id: SettingsRecordId): id is FolderRecordId {
	return FOLDER_RECORDS.has(id);
}

const FILES: Record<SettingsRecordId, string> = {
	models: "models.json",
	keys: "auth.json",
	preferences: "settings.json",
	"model-prompts": MODEL_PROMPTS_FILE,
	"search-keys": "web-search-keys.json",
	"mode-models": "chat-mode-state.json",
	skills: "skills",
	prompts: "prompts",
	themes: "themes",
};

/**
 * The agent-directory files whose change is worth a sync pass. chat-mode-state.json is left out on purpose: drafts are
 * written to it while the user types, and the model it holds is picked up by the next ordinary pass.
 */
export const SETTINGS_FILE_NAMES: ReadonlySet<string> = new Set(
	(["models", "keys", "preferences", "model-prompts", "search-keys"] as const).map((id) => FILES[id]),
);

const NAMES: Record<SettingsRecordId, string> = {
	models: "Providers and models",
	keys: "API keys",
	preferences: "Model and agent settings",
	"model-prompts": "Model prompts",
	"search-keys": "Web search keys",
	"mode-models": "Model of each chat mode",
	skills: "Skills",
	prompts: "Prompt templates",
	themes: "Themes",
};

/** Limits of a folder record: one record is one JSON text, so it stays small. */
const FOLDER_FILE_MAX_BYTES = 2 * 1024 * 1024;
const FOLDER_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const FOLDER_SKIPPED_NAMES = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * The settings.json keys that travel. Everything else in that file belongs to one computer (paths, shells, proxies,
 * timeouts, trust, installed packages) or to one installation (changelog and telemetry state) and is left alone.
 */
export const PORTABLE_SETTINGS_KEYS: readonly string[] = [
	"autoMemory",
	"bookmarkNotes",
	"branchSummary",
	"commitDescription",
	"compaction",
	"contextWindow",
	"conversationNaming",
	"defaultModel",
	"defaultProvider",
	"defaultThinkingLevel",
	"disabledProviders",
	"enabledModels",
	"fallbackModel",
	"followUpMode",
	"gitCommit",
	"gitIntegration",
	"gitPush",
	"hideThinkingBlock",
	// The proxy and the request time limits the Providers are reached with: set once, used on every computer.
	"httpProxy",
	"images",
	"memoryPicker",
	"network",
	"popupNotifications",
	"retry",
	"scheduledTasks",
	"sessionContinuity",
	"showCacheMissNotices",
	"steeringMode",
	"subAgent",
	"thinkingBudgets",
	"translation",
	"usageRanking",
	"visionAssistant",
	"visionCapabilityTests",
	"warnings",
	"webSearch",
	"worktreeNaming",
];

/**
 * Never taken from another computer and never published, whatever a record holds: these name programs, folders,
 * installed extensions and packages, and trust on one computer.
 */
const LOCAL_ONLY_SETTINGS_KEYS: ReadonlySet<string> = new Set([
	"defaultProjectTrust",
	"externalEditor",
	"extensions",
	"npmCommand",
	"officeJwtSecret",
	"officeServerUrl",
	"packages",
	"projectTrusted",
	"prompts",
	"sessionDir",
	"shellCommandPrefix",
	"shellPath",
	"skills",
	"terminal",
	"themes",
]);

const BACKUPS_KEPT_PER_FILE = 5;

/**
 * Settings a newer version publishes that this one does not list yet. They are written and published like the listed
 * ones; without this, an older version would drop them from the record and the newer computer would lose them.
 */
function extraKeysFile(agentDir: string): string {
	return join(agentDir, "sync", "settings-extra-keys.json");
}

function readExtraKeys(agentDir: string): string[] {
	try {
		const value: unknown = JSON.parse(readFileSync(extraKeysFile(agentDir), "utf8"));
		return Array.isArray(value)
			? value.filter((key): key is string => typeof key === "string" && !LOCAL_ONLY_SETTINGS_KEYS.has(key))
			: [];
	} catch {
		return [];
	}
}

function portableSettingsKeys(agentDir: string): string[] {
	return [...new Set([...PORTABLE_SETTINGS_KEYS, ...readExtraKeys(agentDir)])];
}

function learnExtraKeys(agentDir: string, keys: string[]): void {
	const known = new Set(portableSettingsKeys(agentDir));
	const added = keys.filter((key) => !known.has(key) && !LOCAL_ONLY_SETTINGS_KEYS.has(key));
	if (added.length === 0) return;
	const file = extraKeysFile(agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileAtomicallySync(file, JSON.stringify([...readExtraKeys(agentDir), ...added].sort()));
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSettingsRecordId(id: string): id is SettingsRecordId {
	return (SETTINGS_RECORD_IDS as readonly string[]).includes(id);
}

export function settingsRecordName(id: string): string {
	return isSettingsRecordId(id) ? NAMES[id] : "Settings";
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseObject(text: string | undefined, comments = false): Json | undefined {
	if (text === undefined) return undefined;
	if (!text.trim()) return {};
	try {
		const value: unknown = JSON.parse(comments ? stripJsonComments(text) : text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The published form of one record from the text of its file; undefined when the file is missing or cannot be read
 * (then nothing is published, and the engine never turns that into a deletion). A file that exists and holds nothing
 * is published as empty, so removing the last Provider, key or prompt reaches the other computers too.
 */
function portableText(agentDir: string, id: SettingsRecordId, fileText: string | undefined): string | undefined {
	if (fileText === undefined) return undefined;
	switch (id) {
		case "models": {
			const document = parseObject(fileText, true);
			if (!document || !isRecord(document.providers)) return undefined;
			// Key order is kept: it is the order the user's file has, and a merge keeps it too.
			return JSON.stringify(document);
		}
		case "keys": {
			let keys: PortableApiKeys;
			try {
				keys = portableApiKeysOf(fileText);
			} catch {
				return undefined;
			}
			return stableJson(keys);
		}
		case "preferences": {
			const settings = parseObject(fileText);
			if (!settings) return undefined;
			const portable: Json = {};
			for (const key of portableSettingsKeys(agentDir))
				if (settings[key] !== undefined) portable[key] = settings[key];
			return stableJson(portable);
		}
		case "model-prompts": {
			const stored = parseObject(fileText);
			if (!stored || stored.version !== 1 || !isRecord(stored.prompts)) return undefined;
			const prompts: Json = {};
			for (const [provider, models] of Object.entries(stored.prompts)) {
				if (!isRecord(models)) continue;
				const kept: Json = {};
				for (const [model, prompt] of Object.entries(models)) {
					if (typeof prompt === "string" && prompt.trim()) kept[model] = prompt;
				}
				if (Object.keys(kept).length > 0) prompts[provider] = kept;
			}
			return stableJson({ version: 1, prompts });
		}
		case "search-keys": {
			const keys = parseObject(fileText);
			return keys ? stableJson(keys) : undefined;
		}
		case "mode-models": {
			const state = parseObject(fileText);
			if (!state || state.version !== 1) return undefined;
			const modelOf = (mode: unknown): Json | null => {
				const model = isRecord(mode) ? mode.model : undefined;
				return isRecord(model) && typeof model.provider === "string" && typeof model.id === "string"
					? { provider: model.provider, id: model.id }
					: null;
			};
			return stableJson({ coding: modelOf(state.coding), general: modelOf(state.general) });
		}
		case "skills":
		case "prompts":
		case "themes":
			// A folder is read by folderText, never as one file.
			return undefined;
	}
}

// ---- folders (skills, prompts, themes) ---------------------------------------------------------------------------

interface FolderFile {
	/** Path inside the folder with forward slashes. */
	path: string;
	absolute: string;
	size: number;
	mtimeMs: number;
}

/**
 * The files of one folder record that travel: regular files up to FOLDER_FILE_MAX_BYTES, outside `.git`,
 * `node_modules` and the like, no links followed, at most FOLDER_TOTAL_MAX_BYTES in all (the rest stays here).
 * Undefined when the folder does not exist, so a computer without it publishes nothing and removes nothing.
 */
function folderFiles(root: string, overflow?: { hit: boolean }): FolderFile[] | undefined {
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(root);
	} catch {
		return undefined;
	}
	if (!rootStat.isDirectory()) return undefined;
	const files: FolderFile[] = [];
	let total = 0;
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (FOLDER_SKIPPED_NAMES.has(name) || name.endsWith(".tmp")) continue;
			const absolute = join(dir, name);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(absolute);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!stat.isFile() || stat.size > FOLDER_FILE_MAX_BYTES) continue;
			if (total + stat.size > FOLDER_TOTAL_MAX_BYTES) {
				if (overflow) overflow.hit = true;
				continue;
			}
			total += stat.size;
			files.push({
				path: relative(root, absolute).split(sep).join("/"),
				absolute,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			});
		}
	};
	walk(root);
	return files;
}

/** A file's content as it travels: its text when it is UTF-8 text, else `{ base64 }`. */
function encodeFolderFile(data: Buffer): string | { base64: string } {
	if (!data.includes(0)) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(data);
		} catch {
			// Not text: sent as base64 below.
		}
	}
	return { base64: data.toString("base64") };
}

function decodeFolderFile(value: unknown): Buffer | undefined {
	if (typeof value === "string") return Buffer.from(value, "utf8");
	if (isRecord(value) && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
	return undefined;
}

function folderText(agentDir: string, id: FolderRecordId): { text: string; mtimeMs: number } | undefined {
	const overflow = { hit: false };
	const files = folderFiles(join(agentDir, FILES[id]), overflow);
	if (!files) return undefined;
	const out: Json = {};
	let mtimeMs = 0;
	for (const file of files) {
		try {
			out[file.path] = encodeFolderFile(readFileSync(file.absolute));
			mtimeMs = Math.max(mtimeMs, file.mtimeMs);
		} catch {
			// A file that vanished or cannot be read now is simply not part of this version.
		}
	}
	if (!mtimeMs) {
		try {
			mtimeMs = statSync(join(agentDir, FILES[id])).mtimeMs;
		} catch {
			mtimeMs = Date.now();
		}
	}
	// A folder over the size limit travels in part; the other computer then adds and updates but removes nothing.
	return { text: stableJson(overflow.hit ? { files: out, partial: true } : { files: out }), mtimeMs };
}

/** A path another computer sent, as a file inside the folder; undefined when it would leave the folder. */
function safeFolderPath(root: string, path: string): string | undefined {
	if (!path || path.includes("\\") || path.startsWith("/") || /^[a-z]:/iu.test(path)) return undefined;
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || FOLDER_SKIPPED_NAMES.has(part))) return undefined;
	if (parts.some((part) => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu.test(part) || /[<>:"|?*]/u.test(part)))
		return undefined;
	const absolute = resolve(root, ...parts);
	return absolute.startsWith(resolve(root) + sep) ? absolute : undefined;
}

/** Make the folder hold exactly the record's files, keeping a copy of every file that is replaced or removed. */
function writeFolderRecord(agentDir: string, id: FolderRecordId, value: Json): boolean {
	if (!isRecord(value.files)) return false;
	const root = join(agentDir, FILES[id]);
	// Windows names are case-insensitive: "Skill.md" from another computer is the "skill.md" here, not a second file.
	const identity = (absolute: string) =>
		process.platform === "win32" ? resolve(absolute).toLowerCase() : resolve(absolute);
	const wanted = new Map<string, Buffer>();
	const wantedIds = new Set<string>();
	for (const [path, content] of Object.entries(value.files)) {
		const absolute = safeFolderPath(root, path);
		const data = decodeFolderFile(content);
		if (!absolute || !data) continue;
		wanted.set(absolute, data);
		wantedIds.add(identity(absolute));
	}
	let changed = false;
	const backup = (absolute: string): void => {
		const target = join(backupDir(agentDir), FILES[id], new Date().toISOString().replace(/[:.]/gu, "-"));
		try {
			const copy = join(target, relative(root, absolute));
			mkdirSync(dirname(copy), { recursive: true });
			copyFileSync(absolute, copy);
		} catch {
			// A backup that cannot be written must not stop the folder from arriving.
		}
	};
	for (const [absolute, data] of wanted) {
		let current: Buffer | undefined;
		try {
			current = readFileSync(absolute);
		} catch {
			current = undefined;
		}
		if (current?.equals(data)) continue;
		if (current) backup(absolute);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileAtomicallySync(absolute, data);
		changed = true;
	}
	// Only files this record could have held are removed: a file over the limits stays where it is, and a record that
	// holds only part of its folder removes nothing.
	for (const file of value.partial === true ? [] : (folderFiles(root) ?? [])) {
		if (wantedIds.has(identity(file.absolute))) continue;
		backup(file.absolute);
		try {
			unlinkSync(file.absolute);
			changed = true;
		} catch {
			// A file in use stays; the next pass publishes it again.
		}
	}
	return changed;
}

export interface ScannedSettingsRecord {
	id: SettingsRecordId;
	text: string;
	mtimeMs: number;
	name: string;
}

/** What this computer has to publish, read from the files as they are now. */
export function readSettingsRecords(agentDir: string): ScannedSettingsRecord[] {
	const records: ScannedSettingsRecord[] = [];
	for (const id of SETTINGS_RECORD_IDS) {
		if (isFolderRecord(id)) {
			const folder = folderText(agentDir, id);
			if (folder) records.push({ id, text: folder.text, mtimeMs: folder.mtimeMs, name: NAMES[id] });
			continue;
		}
		const path = join(agentDir, FILES[id]);
		const text = portableText(agentDir, id, readText(path));
		if (text === undefined) continue;
		let mtimeMs = Date.now();
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			// The file was just read; a vanished file only loses the time stamp.
		}
		records.push({ id, text, mtimeMs, name: NAMES[id] });
	}
	return records;
}

// ---- merge -------------------------------------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
	return stableJson(a ?? null) === stableJson(b ?? null);
}

/** A list whose items are told apart by `id` (the models of a Provider, saved keys): merged item by item. */
function isIdList(value: unknown): value is Array<Json & { id: string }> {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => isRecord(item) && typeof item.id === "string") &&
		new Set(value.map((item) => (item as { id: string }).id)).size === value.length
	);
}

/**
 * Three-way merge of two JSON values. A part only one side changed keeps that change; a part both changed differently
 * goes to `thereWins ? there : here`. `MISSING` stands for "this side does not have it".
 */
const MISSING = Symbol("missing");
type Side = unknown | typeof MISSING;

function mergeValue(base: Side, here: Side, there: Side, thereWins: boolean): Side {
	if (here === MISSING && there === MISSING) return MISSING;
	if (here !== MISSING && there !== MISSING && sameValue(here, there)) return here;
	if (base !== MISSING) {
		if (here !== MISSING && sameValue(base, here)) return there;
		if (there !== MISSING && sameValue(base, there)) return here;
		if (here === MISSING || there === MISSING) {
			// One side removed it and the other changed it: the later of the two.
			return thereWins ? there : here;
		}
	} else if (here === MISSING || there === MISSING) {
		// Added on one side only.
		return here === MISSING ? there : here;
	}
	if (isRecord(here) && isRecord(there)) {
		const ancestor = isRecord(base) ? base : undefined;
		const first = thereWins ? there : here;
		const second = thereWins ? here : there;
		const merged: Json = {};
		for (const key of [...Object.keys(first), ...Object.keys(second).filter((name) => !Object.hasOwn(first, name))]) {
			const value = mergeValue(
				ancestor && Object.hasOwn(ancestor, key) ? ancestor[key] : MISSING,
				Object.hasOwn(here, key) ? here[key] : MISSING,
				Object.hasOwn(there, key) ? there[key] : MISSING,
				thereWins,
			);
			if (value !== MISSING) merged[key] = value;
		}
		return merged;
	}
	if (isIdList(here) && isIdList(there)) {
		const ancestor = isIdList(base) ? base : undefined;
		const find = (list: Array<Json & { id: string }> | undefined, id: string): Side =>
			list?.find((item) => item.id === id) ?? MISSING;
		const first = thereWins ? there : here;
		const second = thereWins ? here : there;
		const ids = [...first.map((item) => item.id), ...second.map((item) => item.id)];
		const merged: unknown[] = [];
		for (const id of new Set(ids)) {
			const value = mergeValue(find(ancestor, id), find(here, id), find(there, id), thereWins);
			if (value !== MISSING) merged.push(value);
		}
		return merged;
	}
	return thereWins ? there : here;
}

/**
 * The merge of two published versions of one record, as text; undefined when either is not what the record holds.
 * Returns `there` (or `here`) itself when the result says the same, so a merge that changes nothing writes nothing.
 */
export function mergeSettingsText(
	base: string | undefined,
	here: string,
	there: string,
	thereWins: boolean,
): string | undefined {
	const hereValue = parseObject(here);
	const thereValue = parseObject(there);
	if (!hereValue || !thereValue) return undefined;
	const baseValue = parseObject(base);
	const merged = mergeValue(baseValue ?? MISSING, hereValue, thereValue, thereWins);
	if (!isRecord(merged)) return undefined;
	if (sameValue(merged, thereValue)) return there;
	if (sameValue(merged, hereValue)) return here;
	return JSON.stringify(merged);
}

// ---- apply -------------------------------------------------------------------------------------------------------

function backupDir(agentDir: string): string {
	return join(agentDir, "sync", "settings-backup");
}

/** Keep the file as it is now before a version from another computer replaces it; the oldest copies are dropped. */
function backupFile(agentDir: string, path: string, file: string): void {
	if (!existsSync(path)) return;
	const dir = backupDir(agentDir);
	try {
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		copyFileSync(path, join(dir, `${stamp}_${file}`));
		const copies = readdirSync(dir)
			.filter((name) => name.endsWith(`_${file}`))
			.sort();
		for (const old of copies.slice(0, Math.max(0, copies.length - BACKUPS_KEPT_PER_FILE))) {
			try {
				unlinkSync(join(dir, old));
			} catch {
				// A copy that cannot be removed is only an extra backup.
			}
		}
	} catch {
		// A backup that cannot be written must not stop the user's settings from arriving.
	}
}

/**
 * Write a record another computer published (already merged with this computer's) into its file. False when the text
 * is not what the record holds, or nothing changed. Each file is written by the rules of the module that owns it.
 */
export async function writeSettingsRecord(agentDir: string, id: string, text: string): Promise<boolean> {
	if (!isSettingsRecordId(id)) return false;
	const value = parseObject(text);
	if (!value) return false;
	const file = FILES[id];
	const path = join(agentDir, file);
	if (isFolderRecord(id)) {
		const current = folderText(agentDir, id);
		if (current && sameValue(parseObject(current.text), value)) return false;
		return writeFolderRecord(agentDir, id, value);
	}
	if (id !== "keys") {
		// Already what the file says: nothing to write.
		const current = parseObject(portableText(agentDir, id, readText(path)));
		if (current && sameValue(current, value)) return false;
	}
	switch (id) {
		case "models": {
			if (!isRecord(value.providers)) return false;
			backupFile(agentDir, path, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileAtomicallySync(path, `${JSON.stringify(value, null, 2)}\n`);
			return true;
		}
		case "keys": {
			const storage = new FileAuthStorageBackend(path);
			return storage.withLock((current) => {
				const next = withPortableApiKeys(current, value as PortableApiKeys);
				if (next === undefined) return { result: false };
				backupFile(agentDir, path, file);
				return { result: true, next };
			});
		}
		case "preferences": {
			let changed = false;
			let backedUp = false;
			learnExtraKeys(agentDir, Object.keys(value));
			const keys = portableSettingsKeys(agentDir);
			await new FileSettingsStorage(agentDir, agentDir).withLockAsync("global", (current) => {
				const settings = parseObject(current) ?? {};
				// A settings file that cannot be read is left exactly as it is.
				if (current?.trim() && !parseObject(current)) return undefined;
				const next: Json = { ...settings };
				for (const key of keys) {
					if (value[key] === undefined) delete next[key];
					else next[key] = value[key];
				}
				if (sameValue(next, settings)) return undefined;
				if (!backedUp) backupFile(agentDir, path, file);
				backedUp = true;
				changed = true;
				return JSON.stringify(next, null, 2);
			});
			return changed;
		}
		case "model-prompts": {
			if (value.version !== 1 || !isRecord(value.prompts)) return false;
			backupFile(agentDir, path, file);
			mkdirSync(dirname(path), { recursive: true });
			// The times a prompt was saved are this computer's own (they are not published): kept for a text that stays.
			writeFileAtomicallySync(
				path,
				modelPromptsFileText(readText(path), value.prompts as Record<string, Record<string, string>>),
			);
			return true;
		}
		case "search-keys": {
			const storage = new FileAuthStorageBackend(path);
			return storage.withLock((current) => {
				if (sameValue(parseObject(current) ?? {}, value)) return { result: false };
				backupFile(agentDir, path, file);
				return { result: true, next: JSON.stringify(value, null, 2) };
			});
		}
		case "mode-models": {
			// Only the model of each mode is taken; drafts, prompts and the last chat of this computer stay as they are.
			const store = new ModeStateStore(agentDir);
			let changed = false;
			for (const mode of ["coding", "general"] as const) {
				const model = isRecord(value[mode]) ? value[mode] : null;
				const next =
					model && typeof model.provider === "string" && typeof model.id === "string"
						? { provider: model.provider, id: model.id }
						: null;
				try {
					const current = store.get(mode).model;
					if (sameValue(current, next)) continue;
					// A mode that has a model here keeps it when the other computer has none.
					if (!next) continue;
					backupFile(agentDir, path, file);
					store.update(mode, { model: next });
					changed = true;
				} catch {
					// A mode state file that cannot be read is left exactly as it is.
					return false;
				}
			}
			return changed;
		}
	}
}
