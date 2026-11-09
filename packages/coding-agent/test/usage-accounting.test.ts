import type { AssistantMessage, Usage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { collectSessionUsageStats } from "../src/observability/session-stats.ts";
import { usageForAccounting } from "../src/observability/usage-totals.ts";
import type { SessionEntry } from "../src/session/types.ts";

const usage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function claudeMessage(anchor: Usage, totals: Usage, version = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "claude-code-cli",
		provider: "claude-code",
		model: "claude-sonnet-fixture",
		usage: anchor,
		stopReason: "stop",
		timestamp: 1,
		diagnostics: [
			{
				type: "claude-code-interactive-usage",
				timestamp: 2,
				details: {
					version,
					transport: "interactive-pty-mod",
					requestCount: 2,
					turnTokens: { ...totals, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					contextUsage: "last-main-request",
					usageIncludesOnlyObservedModSteps: true,
				},
			},
		],
	};
}

const entry = (message: AssistantMessage): SessionEntry => ({
	type: "message",
	id: "assistant",
	parentId: null,
	timestamp: "",
	message,
});

describe("Claude Code accounting usage", () => {
	it("uses the full observed turn for totals while preserving the last-step anchor", () => {
		const anchor = usage(10, 4);
		const totals = usage(30, 12);
		const message = claudeMessage(anchor, totals);
		expect(usageForAccounting(message)).toMatchObject({ input: 30, output: 12, totalTokens: 42 });
		expect(message.usage).toMatchObject({ input: 10, output: 4, totalTokens: 14 });
		const stats = collectSessionUsageStats([entry(message)]);
		expect(stats.tokens).toEqual({ input: 30, output: 12, cacheRead: 0, cacheWrite: 0, total: 42 });
		// Session totals use the explicit turn tally, while the latest-request view stays anchored to the final main step.
		expect(stats.latestRequest?.cache.input.value).toBe(10);
		expect(stats.latestRequest?.cache.prompt.value).toBe(10);
	});

	it("falls back to message usage for unknown or malformed diagnostics", () => {
		const anchor = usage(10, 4);
		const invalid = claudeMessage(anchor, usage(30, 12), 2);
		const stats = collectSessionUsageStats([entry(invalid)]);
		expect(usageForAccounting(invalid)).toBe(anchor);
		expect(stats.tokens.total).toBe(14);
	});
});
