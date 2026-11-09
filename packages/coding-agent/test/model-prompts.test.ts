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
	readModelPrompt,
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

/** A provider that records the system prompt of every request it receives. */
function recordingProvider(seen: (string | undefined)[]): Provider {
	const answer = (model: Model<any>, context: Context) => {
		seen.push(context.systemPrompt);
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
