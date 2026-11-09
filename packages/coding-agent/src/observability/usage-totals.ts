import type { AssistantMessage, Usage } from "@myharness/ai/compat";
import type { SessionEntry } from "../session/types.ts";

type AccountingMessage = Pick<AssistantMessage, "usage"> &
	Partial<Pick<AssistantMessage, "provider" | "api" | "diagnostics">>;

const tokenBuckets = ["input", "output", "cacheRead", "cacheWrite"] as const;
const accountingCostBuckets = [...tokenBuckets, "total"] as const;
type TokenBucket = (typeof tokenBuckets)[number];
type AccountingTally = Record<TokenBucket, number> & {
	totalTokens: number;
	cost: Record<(typeof accountingCostBuckets)[number], number>;
};
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const tokenCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function accountingTally(value: unknown, anchor: Usage): value is AccountingTally {
	if (!record(value) || !record(value.cost)) return false;
	const cost = value.cost;
	const total = tokenBuckets.reduce((sum, key) => sum + (tokenCount(value[key]) ? value[key] : 0), 0);
	return (
		tokenBuckets.every((key) => tokenCount(value[key]) && tokenCount(anchor[key]) && value[key] >= anchor[key]) &&
		tokenCount(value.totalTokens) &&
		tokenCount(total) &&
		value.totalTokens === total &&
		accountingCostBuckets.every((key) => cost[key] === 0)
	);
}

/** Accounting may cover several native requests; message.usage remains the last main context anchor. */
export function usageForAccounting(message: AccountingMessage): Usage {
	if (message.provider !== "claude-code" || message.api !== "claude-code-cli") return message.usage;
	const diagnostics = message.diagnostics?.filter((item) => item.type === "claude-code-interactive-usage");
	if (diagnostics?.length !== 1) return message.usage;
	const details = diagnostics[0].details;
	if (
		!record(details) ||
		details.version !== 1 ||
		details.transport !== "interactive-pty-mod" ||
		details.contextUsage !== "last-main-request" ||
		details.usageIncludesOnlyObservedModSteps !== true ||
		!tokenCount(details.requestCount) ||
		details.requestCount === 0
	)
		return message.usage;
	const totals = details.turnTokens;
	if (!accountingTally(totals, message.usage)) return message.usage;
	return { ...message.usage, ...totals };
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = usageForAccounting(entry.message);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
