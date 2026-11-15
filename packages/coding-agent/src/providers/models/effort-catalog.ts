/** Maintained, exact-ID presets. These are vendor capabilities, not a probe of a relay's implementation.
 * Reviewed 2026-11-15. Unknown IDs deliberately have no preset. User overrides always win.
 *
 * Table IDs are bare model names: lower case, no `vendor/` path. A requested ID is normalized the same way before it is
 * compared (see `normalizeEffortModelId`), so `z-ai/glm-5.3-flash` and `GLM-5.3-Flash` both resolve the `glm-5.3-flash`
 * entry. Nothing else is guessed: no prefix, version or suffix matching.
 */
import type { ModelThinkingLevel, ThinkingLevelMap } from "@myharness/ai";

interface Entry {
	ids: readonly string[];
	levels: readonly ModelThinkingLevel[];
	source: string;
	aliases?: Record<string, string>;
}
const LMS = ["low", "medium", "high"] as const;
const EXTENDED = [...LMS, "xhigh", "max"] as const;
const ENTRIES: readonly Entry[] = [
	{
		ids: ["gpt-6-astra", "gpt-6.1-sol"],
		levels: EXTENDED,
		source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
	},
	{
		ids: ["gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
		levels: ["off", ...EXTENDED],
		source: "https://developers.openai.com/api/docs/guides/reasoning",
	},
	{
		ids: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
		levels: ["off", ...LMS, "xhigh"],
		source: "https://developers.openai.com/api/docs/models/gpt-5.5",
	},
	{
		ids: ["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.2-pro"],
		levels: ["medium", "high", "xhigh"],
		source: "https://developers.openai.com/api/docs/models/gpt-5.5-pro",
	},
	{ ids: ["gpt-5.1"], levels: ["off", ...LMS], source: "https://developers.openai.com/api/docs/models/gpt-5.1" },
	{ ids: ["gpt-5"], levels: ["minimal", ...LMS], source: "https://developers.openai.com/api/docs/models/gpt-5" },
	{ ids: ["gpt-5-pro"], levels: ["high"], source: "https://developers.openai.com/api/docs/models/gpt-5-pro" },
	{ ids: ["gpt-oss-120b"], levels: LMS, source: "https://developers.openai.com/api/docs/models/gpt-oss-120b" },
	{ ids: ["gpt-oss-20b"], levels: LMS, source: "https://developers.openai.com/api/docs/models/gpt-oss-20b" },
	{
		ids: ["gpt-5.3-codex"],
		levels: [...LMS, "xhigh"],
		source: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
	},
	{
		ids: [
			"claude-fable-5-2",
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-mythos-5-2",
			"claude-mythos-5-1",
			"claude-mythos-5",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
		],
		levels: EXTENDED,
		source: "https://platform.claude.com/docs/en/build-with-claude/effort",
	},
	{
		ids: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-haiku-5-5"],
		levels: ["off", ...EXTENDED],
		source: "https://platform.claude.com/docs/en/build-with-claude/effort",
	},
	{
		ids: ["claude-opus-4-6", "claude-sonnet-4-6"],
		levels: ["off", ...LMS, "max"],
		source: "https://platform.claude.com/docs/en/build-with-claude/effort",
	},
	{
		ids: ["claude-mythos-preview"],
		levels: [...LMS, "max"],
		source: "https://platform.claude.com/docs/en/build-with-claude/thinking",
	},
	{
		ids: ["gemini-4-hydrogen"],
		levels: [...LMS, "xhigh"],
		source: "https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen",
	},
	{
		ids: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview"],
		levels: LMS,
		source: "https://aistudio.google.com/docs/thinking",
	},
	{
		ids: [
			"gemini-3.6-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.1-flash-lite",
			"gemini-3-flash-preview",
			"gemini-robotics-er-2-preview",
		],
		levels: ["minimal", ...LMS],
		source: "https://aistudio.google.com/docs/thinking",
	},
	{
		ids: ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"],
		levels: ["off", "low", "high", "max"],
		source: "https://api-docs.deepseek.com/guides/thinking_mode",
		aliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
	},
	{
		// Official pricing identifies deepseek-flash as this exact model version:
		// https://api-docs.deepseek.com/quick_start/pricing/
		// This version ID is used by relays (also as the `deepseek-ai/` weight name); it is not a first-party API alias.
		ids: ["deepseek-v4.1-flash-1017"],
		levels: ["off", "low", "high", "max"],
		source: "https://api-docs.deepseek.com/guides/thinking_mode",
		aliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
	},
	{
		ids: ["grok-4.7", "grok-4.6"],
		levels: [...LMS, "xhigh"],
		source: "https://docs.x.ai/developers/model-capabilities/text/reasoning",
	},
	{
		// The model page also lists xhigh; the reasoning guide says grok-4.5 treats it as high, so it is not a level of its own.
		ids: ["grok-4.5", "grok-4.5-latest"],
		levels: LMS,
		source: "https://docs.x.ai/developers/model-capabilities/text/reasoning",
	},
	{
		// The page's capability list adds xhigh, its description does not; only what both state is offered.
		ids: ["grok-4.3", "grok-4.3-latest"],
		levels: ["off", ...LMS],
		source: "https://docs.x.ai/developers/models/grok-4.3",
	},
	{
		ids: ["qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash", "qwen3.8-27b", "qwen3.8-omni-flash"],
		levels: ["off", "low", "medium", "xhigh"],
		source: "https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions",
	},
	{
		// Its page states the three levels and nothing about turning thinking off, so "off" is not offered.
		// qwen4.0-max-preview is the same model's second ID (Token Plan page).
		ids: ["qwen4-max-preview", "qwen4.0-max-preview"],
		levels: ["low", "medium", "xhigh"],
		source: "https://www.alibabacloud.com/help/en/model-studio/qwen4-max-preview",
	},
	{
		ids: ["qwen3.8-2.4t-a95b"],
		levels: ["low", "medium", "xhigh"],
		source: "https://www.alibabacloud.com/help/en/model-studio/deep-thinking",
	},
	{
		// Thinking cannot be turned off on these: `thinking.type: disabled` is an error.
		ids: ["glm-5.3", "glm-5.3-flash"],
		levels: ["low", "high", "max"],
		source: "https://docs.z.ai/guides/capabilities/thinking",
	},
	{
		ids: ["glm-5.3-flashx", "glm-5.3-flashx-legal"],
		levels: ["low", "high", "max"],
		source: "https://docs.z.ai/api-reference/llm/chat-completion",
	},
	{
		// The API takes every name; low and medium run as high, xhigh as max, minimal and none stop thinking.
		ids: ["glm-5.2"],
		levels: ["off", "high", "max"],
		source: "https://docs.z.ai/guides/capabilities/thinking",
		aliases: { low: "high", medium: "high", xhigh: "max" },
	},
	{
		// GLM 5.3 as Mistral serves it, under Mistral's own IDs.
		ids: ["zai-glm-5-3", "zai-glm-5-3-flash"],
		levels: ["low", "high", "max"],
		source: "https://docs.mistral.ai/inference/conversations/reasoning",
	},
	{
		ids: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"],
		levels: ["low", "high", "max"],
		source: "https://platform.kimi.ai/docs/guide/use-reasoning-effort",
	},
	{
		ids: ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k"],
		levels: ["low", "high", "max"],
		source: "https://www.kimi.com/code/docs/en/kimi-code/models.html",
	},
	{
		ids: ["minimax-m3.1-flash"],
		levels: EXTENDED,
		source: "https://platform.minimax.io/docs/api-reference/text-openai-api",
	},
	{
		ids: ["muse-spark-1.3", "muse-wonder-1.0", "muse-ember-1.0"],
		levels: ["minimal", ...EXTENDED],
		source: "https://dev.meta.ai/docs/reasoning",
	},
	{
		ids: ["muse-spark-1.3-contributor"],
		levels: ["minimal", ...LMS, "xhigh"],
		source: "https://dev.meta.ai/docs/reasoning",
	},
	{
		ids: ["muse-spark-1.2", "muse-spark-1.1"],
		levels: ["minimal", ...LMS, "xhigh"],
		source: "https://dev.meta.ai/docs/choose-a-model",
	},
	{
		ids: ["mistral-large-4", "mistral-large-4-0"],
		levels: LMS,
		source: "https://docs.mistral.ai/inference/conversations/reasoning",
	},
	{
		ids: ["mistral-small-2603", "mistral-medium-3-5"],
		levels: ["off", "high"],
		source: "https://docs.mistral.ai/inference/conversations/reasoning",
	},
];
const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The key a model ID is looked up by: trimmed, lower case, and only its last `/` segment. Relays and hosts put the
 * vendor or a whole path in front of the model name (`z-ai/glm-5.3-flash`, `models/gemini-3.6-flash`,
 * `accounts/fireworks/models/glm-5.3`); the name after the last `/` is what the table lists. Nothing else changes: a
 * `:free` or dated suffix, a different version spelling (`4.6` vs `4-6`) or an extra word keeps the ID unknown.
 */
export function normalizeEffortModelId(modelId: string): string {
	const id = modelId.trim().toLowerCase();
	return id.slice(id.lastIndexOf("/") + 1);
}

/** Every model ID the table lists (already normalized). */
export function effortPresetModelIds(): string[] {
	return ENTRIES.flatMap((entry) => [...entry.ids]);
}

export function resolveEffortPreset(modelId: string) {
	const id = normalizeEffortModelId(modelId);
	const entry = ENTRIES.find((candidate) => candidate.ids.includes(id));
	if (!entry) return undefined;
	const thinkingLevelMap = Object.fromEntries(
		ORDER.map((level) => [level, entry.levels.includes(level) ? (level === "off" ? "none" : level) : null]),
	) as ThinkingLevelMap;
	return { reasoning: true, thinkingLevelMap, thinkingLevelAliases: entry.aliases, source: entry.source };
}

export interface EffortConfiguration {
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	thinkingLevelMode?: "catalog" | "manual";
}

/** Preserve explicit overrides and legacy differences; an identical legacy map can safely use its preset. */
export function resolveEffortConfiguration(definition: EffortConfiguration) {
	const preset = resolveEffortPreset(definition.id);
	let mode = definition.thinkingLevelMode;
	if (!mode) {
		const map = definition.thinkingLevelMap;
		const matches =
			preset &&
			(!map ||
				ORDER.every((level) => {
					const value = map[level];
					const supported =
						value !== null && ((level !== "xhigh" && level !== "max") || typeof value === "string");
					const expected = preset.thinkingLevelMap[level];
					return (
						supported === (typeof expected === "string") &&
						(!supported || value === undefined || value === expected)
					);
				}));
		mode = definition.reasoning === false || (map && !matches) ? "manual" : "catalog";
	}
	return { mode, preset };
}
