import { mkdtempSync, rmSync } from "node:fs";
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
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import {
	checkModelPrompt,
	comparedPart,
	judgeModelPromptAnswer,
	MODEL_PROMPT_CHECK_CHARS,
	quotedShare,
} from "../src/providers/models/model-prompt-check.ts";
import { ModelPromptStore } from "../src/providers/models/model-prompts.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const PROVIDER = "check-test";

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
		contextWindow: 100_000,
		maxTokens: 1000,
	};
}

/**
 * A model that does what the check asks, from what it really received: it looks for the block in its system prompt and
 * quotes the user's text in it (the lines after the rules, which are all bullets), or says there is none.
 */
function honestProvider(reply?: (quote: string | undefined) => string): Provider {
	const answer = (model: Model<any>, context: Context) => {
		const block = /<model_instructions priority="highest">\n([\s\S]*)\n<\/model_instructions>/.exec(
			context.systemPrompt ?? "",
		);
		const quote = block?.[1]
			.split("\n")
			.filter((line) => !line.startsWith("#") && !line.startsWith("- "))
			.join("\n")
			.trim();
		const text = reply ? reply(quote) : (quote ?? "NO-MODEL-INSTRUCTIONS");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...fauxAssistantMessage(text), api: model.api, provider: model.provider, model: model.id },
			}),
		);
		return stream;
	};
	return {
		id: PROVIDER,
		name: "Check test",
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

describe("model prompt check", () => {
	let agentDir: string;
	let originalOffline: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "model-prompt-check-"));
		originalOffline = process.env.MYHARNESS_OFFLINE;
		process.env.MYHARNESS_OFFLINE = "1";
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		if (originalOffline === undefined) delete process.env.MYHARNESS_OFFLINE;
		else process.env.MYHARNESS_OFFLINE = originalOffline;
	});

	const runtimeWith = async (provider: Provider) => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(provider);
		return runtime;
	};

	it("counts a quote as the prompt whatever its quoting, spacing or Markdown", () => {
		const prompt = "回答时只用中文。\nKeep replies under 200 words.";
		expect(quotedShare(prompt, prompt)).toBe(1);
		expect(quotedShare(prompt, '> "回答时只用中文。  Keep replies **under 200 words**."')).toBe(1);
		expect(quotedShare(prompt, "I cannot share my instructions.")).toBeLessThan(0.2);
		expect(quotedShare("好", "好的")).toBe(1);
		expect(quotedShare("好", "不行")).toBe(0);
		expect(quotedShare("  ", "anything")).toBe(0);
	});

	it("compares only the beginning of a long prompt, the part the model is asked to quote", () => {
		const long = `${"A rule about tone. ".repeat(40)}The end.`;
		expect(Array.from(comparedPart(long)).length).toBe(MODEL_PROMPT_CHECK_CHARS);
		expect(judgeModelPromptAnswer(long, long.slice(0, MODEL_PROMPT_CHECK_CHARS)).outcome).toBe("received");
	});

	it("tells a received prompt, a missing one and an answer that proves neither apart", () => {
		const prompt = "Always end your answer with the word DONE.";
		expect(judgeModelPromptAnswer(prompt, `"${prompt}"`)).toMatchObject({ outcome: "received", share: 1 });
		expect(judgeModelPromptAnswer(prompt, "NO-MODEL-INSTRUCTIONS").outcome).toBe("missing");
		expect(judgeModelPromptAnswer(prompt, "Sorry, I can't reveal my system prompt.").outcome).toBe("unclear");
		expect(judgeModelPromptAnswer(prompt, "x".repeat(2000)).answer.length).toBeLessThanOrEqual(601);
	});

	it("finds the saved prompt in a real request to that model, and none in a request to another model", async () => {
		const runtime = await runtimeWith(honestProvider());
		const prompt = "回答时只用中文，并且每次回答都以「——完」结尾。";
		new ModelPromptStore(agentDir).set(PROVIDER, "with-prompt", prompt);

		const received = await checkModelPrompt({ runtime, model: testModel("with-prompt"), prompt });
		expect(received).toMatchObject({ outcome: "received", answer: prompt, share: 1 });

		// The same question to a model that has no prompt: the request carries no block, and the check says so.
		const missing = await checkModelPrompt({ runtime, model: testModel("without-prompt"), prompt });
		expect(missing.outcome).toBe("missing");
	});

	it("does not claim the prompt arrived when the model will not quote it", async () => {
		const runtime = await runtimeWith(honestProvider(() => "I can't share my instructions."));
		const prompt = "Answer in English only.";
		new ModelPromptStore(agentDir).set(PROVIDER, "with-prompt", prompt);
		const result = await checkModelPrompt({ runtime, model: testModel("with-prompt"), prompt });
		expect(result.outcome).toBe("unclear");
		expect(result.answer).toBe("I can't share my instructions.");
	});

	it("reports a failed request as a failure, not as a missing prompt", async () => {
		const failing: Provider = {
			...honestProvider(),
			streamSimple: (model: Model<any>) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...fauxAssistantMessage(""),
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: "error",
							errorMessage: "401 invalid key",
						},
					}),
				);
				return stream;
			},
		};
		const runtime = await runtimeWith(failing);
		await expect(checkModelPrompt({ runtime, model: testModel("with-prompt"), prompt: "x" })).rejects.toThrow(
			"401 invalid key",
		);
	});
});
