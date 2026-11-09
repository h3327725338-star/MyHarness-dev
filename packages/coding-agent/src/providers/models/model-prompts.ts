/**
 * The user's own prompt for one model (Settings → Personalization → Model prompts).
 *
 * Stored per Provider ID and Model ID in `<agentDir>/model-prompts.json`, global for this computer (not per project,
 * not synced). `ModelRuntime.stream` / `streamSimple` append it as the last block of the system prompt of every request
 * that model receives: the main chat, sub-agents, compaction, memory, titles and every other helper request. Requests
 * to any other model never carry it. The file is read again whenever it changes on disk, so a saved prompt applies from
 * the next request on, in this process and in sub-agent processes alike.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@myharness/ai";
import lockfile from "proper-lockfile";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";

export const MODEL_PROMPTS_FILE = "model-prompts.json";
const OPEN_TAG = `<model_instructions priority="highest">`;
const CLOSE_TAG = "</model_instructions>";

export interface ModelPromptEntry {
	provider: string;
	model: string;
	prompt: string;
}

interface StoredModelPrompts {
	version: 1;
	/** Provider ID → Model ID → the user's prompt. Only non-blank prompts are stored. */
	prompts: Record<string, Record<string, string>>;
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
	return { version: 1, prompts };
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
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, prompts: Object.create(null) };
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
			if (prompt.trim()) {
				prompts[provider] = { ...(prompts[provider] ?? {}), [model]: prompt };
			} else if (prompts[provider]) {
				delete prompts[provider][model];
				if (Object.keys(prompts[provider]).length === 0) delete prompts[provider];
			}
			writeFileAtomicallySync(this.path, `${JSON.stringify({ version: 1, prompts }, null, 2)}\n`);
		} finally {
			release();
		}
	}
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
 * The prompt the user saved for this model, or "" when there is none or the file cannot be read. A broken file is
 * reported once per change instead of failing every request of every model.
 */
const reportedProblems = new Map<string, string>();
export function readModelPrompt(agentDir: string | undefined, provider: string, model: string): string {
	if (!agentDir) return "";
	const store = new ModelPromptStore(agentDir);
	try {
		const prompt = store.get(provider, model);
		reportedProblems.delete(store.path);
		return prompt;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (reportedProblems.get(store.path) !== message) {
			reportedProblems.set(store.path, message);
			console.warn(`[model-prompts] warning: ${store.path}: ${message}`);
		}
		return "";
	}
}

/** The request context with the model's prompt appended to its system prompt; the same object when there is none. */
export function withModelPrompt(
	context: Context,
	agentDir: string | undefined,
	model: { provider: string; id: string },
): Context {
	const prompt = readModelPrompt(agentDir, model.provider, model.id);
	if (!prompt) return context;
	return { ...context, systemPrompt: appendModelInstructions(context.systemPrompt, prompt) };
}
