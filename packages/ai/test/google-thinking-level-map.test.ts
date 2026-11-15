import { describe, expect, it } from "vitest";
import { streamSimple as streamGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamVertex } from "../src/api/google-vertex.ts";
import type { Model, ModelThinkingLevel, SimpleStreamOptions, StreamFunction, ThinkingLevelMap } from "../src/types.ts";

type Reasoning = Exclude<ModelThinkingLevel, "off">;

const model = (api: "google-generative-ai" | "google-vertex", id: string, thinkingLevelMap?: ThinkingLevelMap) =>
	({
		id,
		name: id,
		api,
		provider: "google-test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	}) as Model<any>;

/** The `thinkingConfig` of the request that would be sent; the hook stops the call before any network use. */
async function thinkingConfig(candidate: Model<any>, reasoning: Reasoning) {
	let config: unknown;
	const run = (candidate.api === "google-vertex" ? streamVertex : streamGoogle) as StreamFunction<
		any,
		SimpleStreamOptions
	>;
	const events = run(
		candidate,
		{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] },
		{
			apiKey: "test-key",
			reasoning,
			maxRetries: 0,
			onPayload: (payload) => {
				config = (payload as { config?: { thinkingConfig?: unknown } }).config?.thinkingConfig;
				throw new Error("stop before the request");
			},
		},
	);
	for await (const _ of events) {
		// drain
	}
	return config;
}

const HYDROGEN: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

describe.each(["google-generative-ai", "google-vertex"] as const)("%s thinking levels from the model's map", (api) => {
	it("sends a level the map spells out as written, including one newer than the SDK's enum", async () => {
		const hydrogen = model(api, "gemini-4-hydrogen", HYDROGEN);
		expect(await thinkingConfig(hydrogen, "xhigh")).toEqual({ includeThoughts: true, thinkingLevel: "XHIGH" });
		expect(await thinkingConfig(hydrogen, "medium")).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
	});

	it("keeps the budget of a budget-based model whose map only hides levels", async () => {
		const legacy = model(api, "gemini-2.5-pro", { minimal: null });
		expect(await thinkingConfig(legacy, "high")).toEqual({ includeThoughts: true, thinkingBudget: 32768 });
	});

	it("keeps the family rule for a Gemini 3 Pro entry whose map leaves the level unset", async () => {
		const legacy = model(api, "gemini-3-pro-preview", { minimal: null });
		expect(await thinkingConfig(legacy, "medium")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});
});
