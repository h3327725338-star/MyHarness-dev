// The reasoning effort that goes with a model: which levels the model offers, which one is in use, what "Default"
// stands for, and what the effort becomes when another model is chosen. Pure functions (no page state, no network), so
// the PC side (backend-remote.js, whose answers come from the PC) and the tests share them. The rules are the
// desktop's: packages/ai/src/models.ts (getSupportedThinkingLevels, getDefaultThinkingLevel, clampThinkingLevel) and
// packages/coding-agent/src/providers/runtime/session-model.ts (the level a model switch starts from).

/** Every level, weakest first (packages/ai EXTENDED_THINKING_LEVELS). */
export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What a session uses when a switch starts from a model that cannot reason (agent/runtime/defaults.ts). */
export const FALLBACK_LEVEL = "medium";

/** The levels a model offers on the picker; none when there is nothing to choose between (the desktop's modelEfforts). */
export function offeredLevels(model) {
	const levels = model?.reasoning && Array.isArray(model.thinkingLevels) ? model.thinkingLevels.filter((level) => typeof level === "string") : [];
	return levels.length > 1 ? levels : [];
}

/**
 * A level brought within the levels a model offers, as the desktop does: the requested level when offered, else the
 * next stronger one, else the next weaker one.
 */
export function clampLevel(levels, level) {
	if (!levels.length) return "off";
	if (levels.includes(level)) return level;
	const at = LEVEL_ORDER.indexOf(level);
	if (at < 0) return levels[0];
	for (let i = at; i < LEVEL_ORDER.length; i++) if (levels.includes(LEVEL_ORDER[i])) return LEVEL_ORDER[i];
	for (let i = at - 1; i >= 0; i--) if (levels.includes(LEVEL_ORDER[i])) return LEVEL_ORDER[i];
	return levels[0];
}

/**
 * What "Default" stands for on a model: the default the model was set up with when it offers it, else its strongest
 * level (Settings → Providers → "Highest supported level"). "" when the model has no effort choice.
 */
export function defaultLevel(model, levels = offeredLevels(model)) {
	if (!levels.length) return "";
	const configured = model?.defaultThinkingLevel;
	return typeof configured === "string" && levels.includes(configured) ? configured : levels[levels.length - 1];
}

const wireModel = (model) => ({
	id: model.id,
	name: model.name || model.id,
	reasoning: !!model.reasoning,
	vision: (model.input || []).includes("image"),
	thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels : undefined,
	defaultThinkingLevel: typeof model.defaultThinkingLevel === "string" ? model.defaultThinkingLevel : undefined,
});

/**
 * The page's `models` object of the PC side, from the PC's answers: `list` is GET /api/models, `snap` is GET /api/state
 * (its `model` and `thinking`). The picker's rows keep each model's own levels, so a model can be shown with the
 * effort it would get before it is chosen.
 */
export function pcModels({ list, snap }) {
	const providers = (list?.providers || []).map((provider) => ({ id: provider.id, name: provider.name, models: (provider.models || []).map(wireModel) }));
	const model = snap?.model || null;
	const levels = snap?.thinking?.supported ? snap.thinking.levels || [] : [];
	const efforts = levels.length > 1 ? levels : [];
	const effort = snap?.thinking?.level || "off";
	const fallback = list?.defaults?.thinkingLevel || FALLBACK_LEVEL;
	const current = model
		? {
				provider: model.provider,
				providerName: providers.find((provider) => provider.id === model.provider)?.name || model.provider,
				id: model.id,
				name: model.name || model.id,
				reasoning: model.reasoning,
				vision: (model.input || []).includes("image"),
			}
		: null;
	return {
		loaded: true,
		providers,
		current,
		efforts,
		effort,
		// "Default" on this model, named in the picker.
		defaultEffort: efforts.length ? defaultLevel(model, efforts) : "",
		// Where a switch to another model starts from: the level in use, or the PC's own default when this model cannot reason.
		base: snap?.thinking?.supported ? effort : fallback,
		fallback,
	};
}

/** The level a model gets when it is chosen now (what its picker row shows); "" when it offers no choice. */
export function levelAfterSwitch(models, entry) {
	const levels = offeredLevels(entry);
	return levels.length ? clampLevel(levels, models.base || models.effort) : "";
}

/**
 * The PC's snapshot (`{ model, thinking }` of GET /api/state) as it will be right after another model is chosen, worked
 * out here so the name, the levels and the level in use follow the choice at once; the PC's own answer replaces it.
 * `models` is the page's current `models`. Null when the model is not in the list, or the PC did not say which levels
 * it has (an older PC): then the PC's answer alone decides.
 */
export function switchSnap(models, providerId, modelId) {
	const provider = (models.providers || []).find((entry) => entry.id === providerId);
	const entry = provider?.models.find((model) => model.id === modelId);
	if (!provider || !entry) return null;
	const input = entry.vision ? ["text", "image"] : ["text"];
	if (!entry.reasoning) return { model: { provider: provider.id, id: entry.id, name: entry.name, reasoning: false, input }, thinking: { supported: false, levels: ["off"], level: "off" } };
	if (!entry.thinkingLevels?.length) return null;
	const level = clampLevel(entry.thinkingLevels, models.base || models.effort);
	return {
		model: { provider: provider.id, id: entry.id, name: entry.name, reasoning: true, input, thinkingLevels: entry.thinkingLevels, defaultThinkingLevel: entry.defaultThinkingLevel },
		thinking: { supported: true, levels: entry.thinkingLevels, level },
	};
}

/**
 * The PC's model_changed event as the chat's snapshot ({ model, thinking }, the part of GET /api/state that pcModels
 * reads): the model now in use with its own levels and default, the levels the session offers on it and the level in
 * use. The PC sends it whenever its model changes, whoever changed it, with the level already within the new model's
 * levels, so the page shows all of it at once and needs no second read. Null when the data does not look like that
 * (then the PC is asked for its state instead).
 */
export function snapFromEvent(data) {
	const model = data?.model;
	const thinking = data?.thinking;
	if (!thinking || typeof thinking !== "object" || typeof thinking.level !== "string") return null;
	// A null model is a state of its own: the PC has none set up (the chip then shows nothing).
	if (model !== null && (!model || typeof model !== "object" || typeof model.id !== "string" || typeof model.provider !== "string")) return null;
	return {
		model,
		thinking: { supported: !!thinking.supported, levels: Array.isArray(thinking.levels) ? thinking.levels.filter((level) => typeof level === "string") : [], level: thinking.level },
	};
}
