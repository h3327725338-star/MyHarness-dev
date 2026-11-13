/**
 * The user's own prompt for one model (Settings → Personalization → Model prompts).
 *
 * Stored per Provider ID and Model ID in `<agentDir>/model-prompts.json`, global (not per project; Google Drive sync
 * carries the prompts to the user's other computers, sync/settings-data.ts). `ModelRuntime.stream` / `streamSimple`
 * append it as the last block of the system prompt of every request that model receives: the main chat, sub-agents,
 * compaction, memory, titles and every other helper request, and repeat it after what the user said since it was saved
 * (withModelInstructionsReminder). Requests to any other model never carry it. The file is read again whenever it
 * changes on disk, so a saved prompt applies from the next request on, in this process and in sub-agent processes alike.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context, Message } from "@myharness/ai";
import lockfile from "proper-lockfile";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";

export const MODEL_PROMPTS_FILE = "model-prompts.json";
const OPEN_TAG = `<model_instructions priority="highest">`;
const CLOSE_TAG = "</model_instructions>";
const REMINDER_OPEN_TAG = "<model_instructions_reminder>";
const REMINDER_CLOSE_TAG = "</model_instructions_reminder>";
/** The reminder repeats the prompt up to this many characters; of a longer one, its beginning. */
export const REMINDER_FULL_TEXT_CHARS = 800;

export interface ModelPromptEntry {
	provider: string;
	model: string;
	prompt: string;
}

interface StoredModelPrompts {
	version: 1;
	/** Provider ID → Model ID → the user's prompt. Only non-blank prompts are stored. */
	prompts: Record<string, Record<string, string>>;
	/**
	 * Provider ID → Model ID → when that prompt's text was last changed (ISO time). A prompt saved by an older version
	 * has none: it counts as having always been there.
	 */
	savedAt: Record<string, Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(text: string): StoredModelPrompts {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.prompts)) {
		throw new Error("Invalid model prompts file; it was not changed.");
	}
	const prompts: Record<string, Record<string, string>> = Object.create(null);
	for (const [provider, models] of Object.entries(value.prompts)) {
		if (!isRecord(models)) throw new Error("Invalid model prompts file; it was not changed.");
		const byModel: Record<string, string> = Object.create(null);
		for (const [model, prompt] of Object.entries(models)) {
			if (typeof prompt !== "string") throw new Error("Invalid model prompts file; it was not changed.");
			byModel[model] = prompt;
		}
		prompts[provider] = byModel;
	}
	// Times are a help, not the data: a malformed one is dropped instead of making the whole file invalid.
	const savedAt: Record<string, Record<string, string>> = Object.create(null);
	if (isRecord(value.savedAt)) {
		for (const [provider, models] of Object.entries(value.savedAt)) {
			if (!isRecord(models) || !prompts[provider]) continue;
			const byModel: Record<string, string> = Object.create(null);
			for (const [model, time] of Object.entries(models)) {
				if (
					typeof time === "string" &&
					Number.isFinite(Date.parse(time)) &&
					Object.hasOwn(prompts[provider], model)
				)
					byModel[model] = time;
			}
			if (Object.keys(byModel).length > 0) savedAt[provider] = byModel;
		}
	}
	return { version: 1, prompts, savedAt };
}

/** Last parse per file, reused while the file's size and modification time stay the same. */
const readCache = new Map<string, { stamp: string; value: StoredModelPrompts }>();

/** Reads and writes `<agentDir>/model-prompts.json`. Holds no state of its own besides the path. */
export class ModelPromptStore {
	readonly path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, MODEL_PROMPTS_FILE);
	}

	/** Throws when the file exists but is not a valid prompts file (the file is then left as it is). */
	private read(): StoredModelPrompts {
		let stamp: string;
		try {
			const stat = statSync(this.path);
			stamp = `${stat.size}:${stat.mtimeMs}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, prompts: Object.create(null), savedAt: Object.create(null) };
			throw error;
		}
		const cached = readCache.get(this.path);
		if (cached && cached.stamp === stamp) return cached.value;
		const value = parse(readFileSync(this.path, "utf8"));
		readCache.set(this.path, { stamp, value });
		return value;
	}

	/** The prompt for one model; empty when it has none. */
	get(provider: string, model: string): string {
		const byModel = this.read().prompts[provider];
		const prompt = byModel && Object.hasOwn(byModel, model) ? byModel[model] : "";
		return prompt.trim() ? prompt : "";
	}

	/** When that model's prompt text was last changed, in milliseconds; 0 when it has no prompt or no recorded time. */
	savedAt(provider: string, model: string): number {
		const byModel = this.read().savedAt[provider];
		const time = byModel && Object.hasOwn(byModel, model) ? Date.parse(byModel[model]) : 0;
		return Number.isFinite(time) ? time : 0;
	}

	/** Every model that has a prompt, sorted by Provider ID then Model ID. */
	list(): ModelPromptEntry[] {
		const entries: ModelPromptEntry[] = [];
		for (const [provider, models] of Object.entries(this.read().prompts)) {
			for (const [model, prompt] of Object.entries(models)) {
				if (prompt.trim()) entries.push({ provider, model, prompt });
			}
		}
		return entries.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
	}

	/** Saves one model's prompt; a blank prompt removes it. */
	set(provider: string, model: string, prompt: string): void {
		if (!provider || !model) throw new Error("A Provider ID and a Model ID are required.");
		mkdirSync(dirname(this.path), { recursive: true });
		const release = lockfile.lockSync(dirname(this.path), { realpath: false, lockfilePath: `${this.path}.lock` });
		try {
			readCache.delete(this.path);
			const current = existsSync(this.path) ? parse(readFileSync(this.path, "utf8")) : undefined;
			const prompts: Record<string, Record<string, string>> = Object.create(null);
			for (const [id, models] of Object.entries(current?.prompts ?? {})) prompts[id] = { ...models };
			const savedAt: Record<string, Record<string, string>> = Object.create(null);
			for (const [id, models] of Object.entries(current?.savedAt ?? {})) savedAt[id] = { ...models };
			const before = prompts[provider] && Object.hasOwn(prompts[provider], model) ? prompts[provider][model] : "";
			if (prompt.trim()) {
				prompts[provider] = { ...(prompts[provider] ?? {}), [model]: prompt };
				// The time moves only with the text: saving the same text again changes nothing a request would see.
				if (prompt.trim() !== before.trim())
					savedAt[provider] = { ...(savedAt[provider] ?? {}), [model]: new Date().toISOString() };
			} else {
				if (prompts[provider]) {
					delete prompts[provider][model];
					if (Object.keys(prompts[provider]).length === 0) delete prompts[provider];
				}
				if (savedAt[provider]) {
					delete savedAt[provider][model];
					if (Object.keys(savedAt[provider]).length === 0) delete savedAt[provider];
				}
			}
			const stored = Object.keys(savedAt).length > 0 ? { version: 1, prompts, savedAt } : { version: 1, prompts };
			writeFileAtomicallySync(this.path, `${JSON.stringify(stored, null, 2)}\n`);
		} finally {
			release();
		}
	}
}

/**
 * The file's text for a whole set of prompts that arrived from another computer (sync/settings-data.ts), given the
 * file as it is now. A prompt whose text stays the same keeps its time; a new or changed one counts as saved now, on
 * this computer: its chats follow it from here on, like a prompt saved in Settings.
 */
export function modelPromptsFileText(
	currentText: string | undefined,
	incoming: Record<string, Record<string, string>>,
	now = new Date(),
): string {
	let current: StoredModelPrompts | undefined;
	try {
		current = currentText === undefined ? undefined : parse(currentText);
	} catch {
		current = undefined;
	}
	const prompts: Record<string, Record<string, string>> = {};
	const savedAt: Record<string, Record<string, string>> = {};
	for (const [provider, models] of Object.entries(incoming)) {
		for (const [model, prompt] of Object.entries(models)) {
			if (typeof prompt !== "string" || !prompt.trim()) continue;
			prompts[provider] = { ...(prompts[provider] ?? {}), [model]: prompt };
			const before = current?.prompts[provider];
			const same = before && Object.hasOwn(before, model) && before[model].trim() === prompt.trim();
			const kept = same ? current?.savedAt[provider]?.[model] : now.toISOString();
			if (kept) savedAt[provider] = { ...(savedAt[provider] ?? {}), [model]: kept };
		}
	}
	const stored = Object.keys(savedAt).length > 0 ? { version: 1, prompts, savedAt } : { version: 1, prompts };
	return `${JSON.stringify(stored, null, 2)}\n`;
}

/** The block appended to the system prompt: the fixed priority rules, then the user's text as written. */
export function modelInstructionsBlock(prompt: string): string {
	const rules = loadSystemPrompt("session/model-instructions.md");
	return [OPEN_TAG, ...(rules ? [rules, ""] : []), prompt.trim(), CLOSE_TAG].join("\n");
}

/** `systemPrompt` with the model's block as its last part; unchanged when the block is already there. */
export function appendModelInstructions(systemPrompt: string | undefined, prompt: string): string {
	const block = modelInstructionsBlock(prompt);
	const base = systemPrompt ?? "";
	if (base.endsWith(block)) return base;
	return base.trim() ? `${base}\n\n${block}` : block;
}

/**
 * The note put after what the user said, next to the question, where the model answers: a pointer to the block and
 * the user's text again. A pointer alone changes nothing on weaker models (measured: the text itself has to stand
 * there). A long prompt is repeated up to REMINDER_FULL_TEXT_CHARS only, since the note is paid for at every turn; the
 * block in the system prompt always holds all of it.
 */
export function modelInstructionsReminder(prompt: string): string {
	const rules = loadSystemPrompt("session/model-instructions-reminder.md");
	const characters = Array.from(prompt.trim());
	const again =
		characters.length <= REMINDER_FULL_TEXT_CHARS
			? characters.join("")
			: `${characters.slice(0, REMINDER_FULL_TEXT_CHARS).join("").trimEnd()} …`;
	const lines = rules ? [rules, "", again] : [again];
	return [REMINDER_OPEN_TAG, ...lines, REMINDER_CLOSE_TAG].join("\n");
}

/**
 * `messages` with the reminder after each thing the user said since the prompt was saved (`since`, in milliseconds; 0
 * for always): on the last message of every run of user messages that is not older.
 *
 * The block at the end of a long system prompt is far from where the model answers. In a conversation whose earlier
 * replies were written without the instructions, weaker models go on like those replies and the block changes nothing.
 * The reminder stands next to the question instead, and only from the moment the prompt exists: the earlier turns stay
 * as they were, so what the model sees is a conversation that changes at that point, not a rule its own replies never
 * followed. A message that has the reminder has it on every later request too, so the part of the conversation a
 * provider has cached stays the same from one request to the next. Nothing is stored: the conversation keeps the
 * user's own words.
 */
export function withModelInstructionsReminder(messages: Message[], prompt: string, since = 0): Message[] {
	const reminder = modelInstructionsReminder(prompt);
	let changed = false;
	const next = messages.map((message, index) => {
		if (message.role !== "user" || message.compactionCheckpoint) return message;
		if (messages[index + 1]?.role === "user") return message;
		if (message.timestamp < since) return message;
		if (typeof message.content === "string") {
			if (message.content.endsWith(reminder)) return message;
			changed = true;
			return { ...message, content: message.content.trim() ? `${message.content}\n\n${reminder}` : reminder };
		}
		const last = message.content.at(-1);
		if (last?.type === "text" && last.text === reminder) return message;
		changed = true;
		return { ...message, content: [...message.content, { type: "text" as const, text: reminder }] };
	});
	return changed ? next : messages;
}

/**
 * The prompt the user saved for this model, or "" when there is none or the file cannot be read. A broken file is
 * reported once per change instead of failing every request of every model.
 */
const reportedProblems = new Map<string, string>();
export function readModelPrompt(agentDir: string | undefined, provider: string, model: string): string {
	return readSavedModelPrompt(agentDir, provider, model).prompt;
}

/** The same, with the time its text was last changed (0 when unknown). */
function readSavedModelPrompt(
	agentDir: string | undefined,
	provider: string,
	model: string,
): { prompt: string; savedAt: number } {
	if (!agentDir) return { prompt: "", savedAt: 0 };
	const store = new ModelPromptStore(agentDir);
	try {
		const prompt = store.get(provider, model);
		reportedProblems.delete(store.path);
		return { prompt, savedAt: prompt ? store.savedAt(provider, model) : 0 };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (reportedProblems.get(store.path) !== message) {
			reportedProblems.set(store.path, message);
			console.warn(`[model-prompts] warning: ${store.path}: ${message}`);
		}
		return { prompt: "", savedAt: 0 };
	}
}

/**
 * The request context with the model's prompt: appended to the system prompt, and repeated after what the user said
 * since it was saved. The same object when the model has none.
 */
export function withModelPrompt(
	context: Context,
	agentDir: string | undefined,
	model: { provider: string; id: string },
): Context {
	const { prompt, savedAt } = readSavedModelPrompt(agentDir, model.provider, model.id);
	if (!prompt) return context;
	return {
		...context,
		systemPrompt: appendModelInstructions(context.systemPrompt, prompt),
		messages: withModelInstructionsReminder(context.messages, prompt, savedAt),
	};
}
