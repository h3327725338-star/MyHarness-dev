import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	estimateContextTokens,
	fauxAssistantMessage,
	InMemoryModelsStore,
	type Message,
	type Model,
	type Provider,
} from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { fitContextToModelWindow, requestTokenLimit } from "../src/providers/runtime/context-fit.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const PROVIDER = "fit-test";

function model(contextWindow: number, extra: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: `window-${contextWindow}`,
		name: "Fit test",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 16_000,
		...extra,
	};
}

let clock = 1;
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
const assistant = (text: string, usageTokens = 0, toolCallId?: string): AssistantMessage => ({
	...fauxAssistantMessage(text),
	content: [
		{ type: "text", text },
		...(toolCallId
			? [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path: "a.txt" } }]
			: []),
	],
	usage: {
		input: usageTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: usageTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: clock++,
});
const toolResult = (toolCallId: string, text: string): Message => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: clock++,
});
const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("fitContextToModelWindow", () => {
	it("leaves a request that fits untouched, and a model without a host-managed window alone", () => {
		const context: Context = { systemPrompt: "Base.", messages: [user("hello")] };
		const fitted = fitContextToModelWindow(model(100_000), context);
		expect(fitted.changed).toBe(false);
		expect(fitted.context).toBe(context);

		const huge: Context = { messages: [user("x".repeat(2_000_000))] };
		expect(fitContextToModelWindow(model(0), huge).context).toBe(huge);
		expect(fitContextToModelWindow(model(100_000, { managesOwnContext: true }), huge).context).toBe(huge);
		expect(requestTokenLimit(model(100_000))).toBe(95_000);
		expect(requestTokenLimit(model(32_000))).toBe(30_400);
	});

	it("cuts the middle out of long tool outputs first and keeps every message", () => {
		const context: Context = {
			systemPrompt: "Base.",
			messages: [
				user("Read the two files."),
				assistant("Reading.", 0, "call-1"),
				toolResult("call-1", `HEAD-A ${"a".repeat(600_000)} TAIL-A`),
				assistant("Reading the next.", 0, "call-2"),
				toolResult("call-2", `HEAD-B ${"b".repeat(300_000)} TAIL-B`),
				user("Now summarize."),
			],
		};
		const target = model(100_000);
		const fitted = fitContextToModelWindow(target, context);
		expect(fitted.changed).toBe(true);
		expect(fitted.context.messages).toHaveLength(6);
		// Cut down far enough to leave the answer 15% of the window, not just to the limit.
		expect(estimateContextTokens(fitted.context).tokens).toBeLessThanOrEqual(100_000 - 4096 - 15_000);
		expect(estimateContextTokens(fitted.context).tokens).toBeGreaterThan(70_000);
		const first = textOf(fitted.context.messages[2]!);
		expect(first.startsWith("HEAD-A ")).toBe(true);
		expect(first.endsWith(" TAIL-A")).toBe(true);
		expect(first).toContain("left out to fit this model's context window");
		expect(textOf(fitted.context.messages[4]!).endsWith(" TAIL-B")).toBe(true);
		expect(textOf(fitted.context.messages[5]!)).toBe("Now summarize.");
		// The caller's messages are not changed.
		expect(textOf(context.messages[2]!)).toHaveLength(600_014);
	});

	it("drops the oldest messages with their tool results when cutting texts is not enough", () => {
		const messages: Message[] = [];
		for (let index = 0; index < 400; index++) {
			messages.push(user(`question ${index} ${"q".repeat(3000)}`));
			messages.push(assistant(`answer ${index}`, 0, `call-${index}`));
			messages.push(toolResult(`call-${index}`, `result ${index} ${"r".repeat(3000)}`));
		}
		messages.push(user("Write the summary."));
		const target = model(100_000);
		const fitted = fitContextToModelWindow(target, { messages });
		const kept = fitted.context.messages;
		expect(estimateContextTokens(fitted.context).tokens).toBeLessThanOrEqual(requestTokenLimit(target));
		expect(kept.length).toBeLessThan(messages.length);
		expect(kept[0]!.role).toBe("user");
		expect(textOf(kept.at(-1)!)).toBe("Write the summary.");
		// No tool result is left without its call, and no call without its result.
		const calls = new Set<string>();
		for (const message of kept) {
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
			}
		}
		const results = new Set(kept.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
		expect([...results].every((id) => calls.has(id))).toBe(true);
		expect([...calls].every((id) => results.has(id))).toBe(true);
		// The newest exchange survives.
		expect(kept.some((message) => textOf(message).startsWith("result 399 "))).toBe(true);
	});

	it("cuts a single message that is too long by itself", () => {
		const target = model(32_000);
		const fitted = fitContextToModelWindow(target, { messages: [user(`START ${"长".repeat(400_000)} END`)] });
		expect(fitted.context.messages).toHaveLength(1);
		const text = textOf(fitted.context.messages[0]!);
		expect(text.startsWith("START ")).toBe(true);
		expect(text.endsWith(" END")).toBe(true);
		expect(estimateContextTokens(fitted.context).tokens).toBeLessThanOrEqual(requestTokenLimit(target));
	});

	it("does not count a larger model's usage against a request that holds only part of its conversation", () => {
		// The answer reports 300K tokens of context, as a chat on a 350K model would; the request holds a few words.
		const context: Context = { messages: [user("hi"), assistant("hello", 300_000), user("Name this chat.")] };
		const target = model(100_000);
		expect(estimateContextTokens(context).tokens).toBeGreaterThan(requestTokenLimit(target));
		const fitted = fitContextToModelWindow(target, context);
		expect(fitted.context.messages).toHaveLength(3);
		expect(fitted.context.messages.map(textOf)).toEqual(["hi", "hello", "Name this chat."]);
		expect(estimateContextTokens(fitted.context).tokens).toBeLessThan(100);
	});

	it("is applied to every request the model runtime sends", async () => {
		const seen: Context[] = [];
		const answer = (requestModel: Model<any>, context: Context) => {
			seen.push(context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("ok"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				}),
			);
			return stream;
		};
		const provider: Provider = {
			id: PROVIDER,
			name: "Fit test",
			auth: {
				apiKey: {
					name: "Test API key",
					login: async () => ({ type: "api_key", key: "k" }),
					check: async () => ({ type: "api_key", source: "test" }),
					resolve: async () => ({ auth: { apiKey: "k" }, source: "test" }),
				},
			},
			getModels: () => [model(100_000), model(350_000)],
			stream: answer,
			streamSimple: answer,
		};
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(provider);
		// About 250K tokens: fine for the 350K model, far too much for the 100K one.
		const context: Context = {
			messages: [
				user("Start."),
				assistant("Working.", 0, "c1"),
				toolResult("c1", "z".repeat(1_000_000)),
				user("Go on."),
			],
		};
		await runtime.completeSimple(model(350_000), context);
		await runtime.completeSimple(model(100_000), context);
		await runtime.complete(model(100_000), context);
		expect(seen[0]).toBe(context);
		for (const sent of seen.slice(1)) {
			expect(estimateContextTokens(sent).tokens).toBeLessThanOrEqual(requestTokenLimit(model(100_000)));
			expect(textOf(sent.messages.at(-1)!)).toBe("Go on.");
		}
	});
});
