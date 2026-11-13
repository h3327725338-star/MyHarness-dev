import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@myharness/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendedPrompt } from "../examples/extensions/claude-code-shell.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import {
	appendModelInstructions,
	MODEL_PROMPTS_FILE,
	ModelPromptStore,
	modelInstructionsBlock,
	modelInstructionsReminder,
	modelPromptsFileText,
	REMINDER_FULL_TEXT_CHARS,
	readModelPrompt,
	withModelInstructionsReminder,
	withModelPrompt,
} from "../src/providers/models/model-prompts.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { createReadOnlyGuardExtensionSource } from "../src/tools/shell/read-only-guard.ts";

const PROVIDER = "prompt-test";

function testModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

/** A provider that records the system prompt (and, when asked, the whole context) of every request it receives. */
function recordingProvider(seen: (string | undefined)[], contexts?: Context[]): Provider {
	const answer = (model: Model<any>, context: Context) => {
		seen.push(context.systemPrompt);
		contexts?.push(context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...fauxAssistantMessage("ok"), api: model.api, provider: model.provider, model: model.id },
			}),
		);
		return stream;
	};
	return {
		id: PROVIDER,
		name: "Prompt test",
		auth: {
			apiKey: {
				name: "Test API key",
				login: async () => ({ type: "api_key", key: "k" }),
				check: async () => ({ type: "api_key", source: "test" }),
				resolve: async () => ({ auth: { apiKey: "k" }, source: "test" }),
			},
		},
		getModels: () => [testModel("with-prompt"), testModel("without-prompt")],
		stream: answer,
		streamSimple: answer,
	};
}

describe("model prompts", () => {
	let agentDir: string;
	let originalOffline: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "model-prompts-"));
		originalOffline = process.env.MYHARNESS_OFFLINE;
		process.env.MYHARNESS_OFFLINE = "1";
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		if (originalOffline === undefined) delete process.env.MYHARNESS_OFFLINE;
		else process.env.MYHARNESS_OFFLINE = originalOffline;
	});

	it("saves one prompt per Provider and Model ID, and a blank prompt removes it", () => {
		const store = new ModelPromptStore(agentDir);
		expect(store.list()).toEqual([]);
		store.set("zai", "glm-5.3-flash", "Answer in English only.");
		store.set("zai", "z-ai/glm-5.3", "Be brief.");
		store.set("other", "__proto__", "Odd ID.");
		expect(store.get("zai", "glm-5.3-flash")).toBe("Answer in English only.");
		expect(store.get("zai", "z-ai/glm-5.3")).toBe("Be brief.");
		expect(store.get("zai", "missing")).toBe("");
		expect(store.get("other", "__proto__")).toBe("Odd ID.");
		expect(store.list().map((entry) => `${entry.provider}/${entry.model}`)).toEqual([
			"other/__proto__",
			"zai/glm-5.3-flash",
			"zai/z-ai/glm-5.3",
		]);

		store.set("zai", "glm-5.3-flash", "   \n");
		expect(store.get("zai", "glm-5.3-flash")).toBe("");
		store.set("zai", "z-ai/glm-5.3", "");
		store.set("other", "__proto__", "");
		expect(store.list()).toEqual([]);
		expect(JSON.parse(readFileSync(join(agentDir, MODEL_PROMPTS_FILE), "utf8"))).toEqual({ version: 1, prompts: {} });
	});

	it("leaves a broken file alone and sends nothing instead of failing requests", () => {
		const file = join(agentDir, MODEL_PROMPTS_FILE);
		writeFileSync(file, "{ not json");
		const store = new ModelPromptStore(agentDir);
		expect(() => store.list()).toThrow();
		expect(() => store.set("zai", "glm", "x")).toThrow();
		expect(readFileSync(file, "utf8")).toBe("{ not json");
		expect(readModelPrompt(agentDir, "zai", "glm")).toBe("");
		expect(readModelPrompt(undefined, "zai", "glm")).toBe("");
	});

	it("puts the block last in the system prompt, once", () => {
		const block = modelInstructionsBlock("  Answer in English only.  ");
		expect(block.startsWith(`<model_instructions priority="highest">\n# Model-specific user instructions\n`)).toBe(
			true,
		);
		expect(block.endsWith("\nAnswer in English only.\n</model_instructions>")).toBe(true);
		const once = appendModelInstructions("Base prompt.", "Answer in English only.");
		expect(once).toBe(`Base prompt.\n\n${block}`);
		expect(appendModelInstructions(once, "Answer in English only.")).toBe(once);
		expect(appendModelInstructions(undefined, "Answer in English only.")).toBe(block);

		const context: Context = { systemPrompt: "Base prompt.", messages: [] };
		expect(withModelPrompt(context, agentDir, { provider: "zai", id: "glm" })).toBe(context);
		new ModelPromptStore(agentDir).set("zai", "glm", "Answer in English only.");
		const changed = withModelPrompt(context, agentDir, { provider: "zai", id: "glm" });
		expect(changed.systemPrompt).toBe(once);
		expect(context.systemPrompt).toBe("Base prompt.");
	});

	it("adds the prompt to every request of that model only, read again when it changes", async () => {
		const seen: (string | undefined)[] = [];
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(recordingProvider(seen));
		const store = new ModelPromptStore(agentDir);
		store.set(PROVIDER, "with-prompt", "Answer in English only.");
		const context: Context = { systemPrompt: "Base prompt.", messages: [] };

		await runtime.completeSimple(testModel("with-prompt"), context);
		await runtime.complete(testModel("with-prompt"), context);
		await runtime.completeSimple(testModel("without-prompt"), context);
		await runtime.completeSimple(testModel("with-prompt"), { messages: [] });
		store.set(PROVIDER, "with-prompt", "Now in French.");
		await runtime.completeSimple(testModel("with-prompt"), context);
		store.set(PROVIDER, "with-prompt", "");
		await runtime.completeSimple(testModel("with-prompt"), context);

		const english = appendModelInstructions("Base prompt.", "Answer in English only.");
		expect(seen).toEqual([
			english,
			english,
			"Base prompt.",
			modelInstructionsBlock("Answer in English only."),
			appendModelInstructions("Base prompt.", "Now in French."),
			"Base prompt.",
		]);
		expect(context.systemPrompt).toBe("Base prompt.");
	});

	it("records when a prompt's text changed, and forgets it with the prompt", async () => {
		const store = new ModelPromptStore(agentDir);
		expect(store.savedAt("zai", "glm")).toBe(0);
		const before = Date.now();
		store.set("zai", "glm", "Answer in English only.");
		const first = store.savedAt("zai", "glm");
		expect(first).toBeGreaterThanOrEqual(before);
		expect(first).toBeLessThanOrEqual(Date.now());
		// The same text saved again is no change; another text is.
		await new Promise((done) => setTimeout(done, 15));
		store.set("zai", "glm", "Answer in English only.  ");
		expect(store.savedAt("zai", "glm")).toBe(first);
		store.set("zai", "glm", "Answer in French only.");
		expect(store.savedAt("zai", "glm")).toBeGreaterThan(first);
		store.set("zai", "glm", "");
		expect(store.savedAt("zai", "glm")).toBe(0);
		expect(JSON.parse(readFileSync(join(agentDir, MODEL_PROMPTS_FILE), "utf8"))).toEqual({ version: 1, prompts: {} });
		// A file written by an older version has no times; a malformed time is dropped, the prompt stays.
		writeFileSync(
			join(agentDir, MODEL_PROMPTS_FILE),
			JSON.stringify({ version: 1, prompts: { zai: { glm: "Old." } }, savedAt: { zai: { glm: "not a time" } } }),
		);
		expect(store.get("zai", "glm")).toBe("Old.");
		expect(store.savedAt("zai", "glm")).toBe(0);
	});

	it("keeps a prompt's time when the same text arrives from another computer, and counts a new text from now", () => {
		const store = new ModelPromptStore(agentDir);
		store.set("zai", "glm", "Answer in English only.");
		const mine = store.savedAt("zai", "glm");
		const file = join(agentDir, MODEL_PROMPTS_FILE);
		const arrival = new Date(mine + 60_000);
		writeFileSync(
			file,
			modelPromptsFileText(
				readFileSync(file, "utf8"),
				{ zai: { glm: "Answer in English only.", other: "Be brief.", blank: "  " } },
				arrival,
			),
		);
		expect(store.list().map((entry) => `${entry.model}: ${entry.prompt}`)).toEqual([
			"glm: Answer in English only.",
			"other: Be brief.",
		]);
		expect(store.savedAt("zai", "glm")).toBe(mine);
		expect(store.savedAt("zai", "other")).toBe(arrival.getTime());
		// A prompt the other computer no longer has is gone, with its time; a file that cannot be read counts as empty.
		writeFileSync(file, modelPromptsFileText(readFileSync(file, "utf8"), { zai: { other: "Be brief." } }, arrival));
		expect(store.get("zai", "glm")).toBe("");
		expect(store.savedAt("zai", "glm")).toBe(0);
		expect(JSON.parse(modelPromptsFileText("{ broken", { zai: { glm: "x" } }, arrival))).toEqual({
			version: 1,
			prompts: { zai: { glm: "x" } },
			savedAt: { zai: { glm: arrival.toISOString() } },
		});
	});

	it("repeats the prompt after what the user said, from the moment it was saved", () => {
		const reminder = modelInstructionsReminder("Answer in English only.");
		expect(
			reminder.startsWith("<model_instructions_reminder>\n# Model-specific user instructions, repeated\n- "),
		).toBe(true);
		expect(reminder.endsWith("\n\nAnswer in English only.\n</model_instructions_reminder>")).toBe(true);
		type Message = Context["messages"][number];
		const user = (content: string | { type: "text"; text: string }[], timestamp: number): Message => ({
			role: "user",
			content,
			timestamp,
		});
		const assistant = (timestamp: number) => ({ ...fauxAssistantMessage("ok"), timestamp }) as Message;
		const messages = [
			user("old question", 100),
			user("context added by the app", 101),
			assistant(110),
			user([{ type: "text", text: "new question" }], 200),
			assistant(210),
			user("", 300),
			user("newest question", 301),
		];

		// Since 150: the first turn is older and stays as it was; in a run of user messages only the last one is marked.
		const marked = withModelInstructionsReminder(messages, "Answer in English only.", 150);
		expect(marked[0]).toBe(messages[0]);
		expect(marked[1]).toBe(messages[1]);
		expect(marked[2]).toBe(messages[2]);
		expect(marked[3].content).toEqual([
			{ type: "text", text: "new question" },
			{ type: "text", text: reminder },
		]);
		expect(marked[5]).toBe(messages[5]);
		expect(marked[6].content).toBe(`newest question\n\n${reminder}`);
		expect(messages[6].content).toBe("newest question");
		// Marked once: a context that passes twice is not marked twice.
		expect(withModelInstructionsReminder(marked, "Answer in English only.", 150)).toBe(marked);
		// No recorded time: the prompt counts as having always been there.
		expect(withModelInstructionsReminder(messages, "Answer in English only.")[1].content).toBe(
			`context added by the app\n\n${reminder}`,
		);
		// Nothing to mark: the same array.
		expect(withModelInstructionsReminder(messages, "Answer in English only.", 1000)).toBe(messages);
		// A compaction checkpoint is a protocol item, not something the user said.
		const checkpoint: Message[] = [
			{
				role: "user",
				content: "",
				timestamp: 500,
				compactionCheckpoint: { type: "compaction", encrypted_content: "x" },
			},
		];
		expect(withModelInstructionsReminder(checkpoint, "Answer in English only.")).toBe(checkpoint);

		// A long prompt is repeated up to the limit only: its beginning, marked as cut.
		const exact = "x".repeat(REMINDER_FULL_TEXT_CHARS);
		expect(modelInstructionsReminder(exact)).toContain(`\n\n${exact}\n</model_instructions_reminder>`);
		const long = `${"A rule. ".repeat(REMINDER_FULL_TEXT_CHARS / 8)}The last rule.`;
		const cut = modelInstructionsReminder(long);
		expect(cut).not.toContain("The last rule.");
		expect(cut.endsWith("A rule. …\n</model_instructions_reminder>")).toBe(true);
		expect(cut.length).toBeLessThan(REMINDER_FULL_TEXT_CHARS + 600);
	});

	it("keeps the earlier part of a chat the same from one request to the next", async () => {
		const contexts: Context[] = [];
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(recordingProvider([], contexts));
		const model = testModel("with-prompt");
		type Message = Context["messages"][number];
		const early = Date.now() - 60_000;
		const first: Message = { role: "user", content: "before the prompt", timestamp: early };
		const firstAnswer = { ...fauxAssistantMessage("ok"), timestamp: early + 1 } as Message;
		await runtime.completeSimple(model, { systemPrompt: "Base.", messages: [first] });
		expect(contexts[0].messages[0].content).toBe("before the prompt");

		new ModelPromptStore(agentDir).set(PROVIDER, "with-prompt", "Answer in English only.");
		const reminder = modelInstructionsReminder("Answer in English only.");
		const second: Message = { role: "user", content: "after the prompt", timestamp: Date.now() + 5 };
		const secondAnswer = { ...fauxAssistantMessage("ok"), timestamp: Date.now() + 6 } as Message;
		await runtime.completeSimple(model, { systemPrompt: "Base.", messages: [first, firstAnswer, second] });
		const third: Message = { role: "user", content: "and again", timestamp: Date.now() + 10 };
		const all = [first, firstAnswer, second, secondAnswer, third];
		await runtime.completeSimple(model, { systemPrompt: "Base.", messages: all });

		// The turn from before the prompt is never marked; the turns since are, on every request alike.
		expect(contexts[1].messages.map((message) => message.content)).toEqual([
			"before the prompt",
			firstAnswer.content,
			`after the prompt\n\n${reminder}`,
		]);
		expect(contexts[2].messages.slice(0, 3).map((message) => message.content)).toEqual(
			contexts[1].messages.map((message) => message.content),
		);
		expect(contexts[2].messages.at(-1)?.content).toBe(`and again\n\n${reminder}`);
		// What the caller holds is untouched, and a model without a prompt gets the conversation as it is.
		expect(third.content).toBe("and again");
		await runtime.completeSimple(testModel("without-prompt"), { systemPrompt: "Base.", messages: all });
		expect(contexts[3].messages).toEqual(all);
	});

	it("adds the sub-agent model's prompt to the shell adjudicator request", () => {
		new ModelPromptStore(agentDir).set("zai", "glm", "Answer in English only.");
		const withPrompt = createReadOnlyGuardExtensionSource("blocked", {
			mode: "delegated",
			adjudicator: { provider: "zai", model: "glm", agentDir },
		});
		expect(withPrompt).toContain(JSON.stringify(modelInstructionsBlock("Answer in English only.")).slice(1, -1));
		const otherModel = createReadOnlyGuardExtensionSource("blocked", {
			mode: "delegated",
			adjudicator: { provider: "zai", model: "other", agentDir },
		});
		expect(otherModel).not.toContain("model_instructions");
	});

	it("lets the claude-code-shell provider pass the block on to its own claude session", () => {
		const block = modelInstructionsBlock("Answer in English only.");
		const prompt = appendModelInstructions("Base prompt.", "Answer in English only.");
		// The plugin appends MyHarness's whole prompt to claude's own, so the block stays the last thing claude reads.
		for (const active of [["read", "bash", "todo_write"], []]) {
			for (const systemPrompt of [prompt, block]) {
				const appended = appendedPrompt(active, systemPrompt);
				expect(appended.endsWith(systemPrompt)).toBe(true);
				expect(appended.endsWith("</model_instructions>")).toBe(true);
			}
			expect(appendedPrompt(active, "Base prompt.")).not.toContain("model_instructions");
		}
	});
});
