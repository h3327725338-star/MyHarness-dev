// Pure logic of the custom-provider form: how a model of models.json is edited as a draft, and how a detection of the
// Model IDs the user named becomes new models or updates exactly the fields it settled. No DOM here, so it can be
// tested directly.

import { fmtTokens } from "./util.js";

export const BASE_LEVELS = ["off", "minimal", "low", "medium", "high"];
export const EXTRA_LEVELS = ["xhigh", "max"];
export const DEFAULT_CONTEXT = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

let uidCounter = 0;
const uid = () => `m${++uidCounter}`;

/** Which thinking levels a model offers, read from models.json's thinkingLevelMap (null = unsupported, xhigh/max need an entry). */
export function levelsFromMap(map) {
	const levels = {};
	for (const level of BASE_LEVELS) levels[level] = map?.[level] !== null;
	for (const level of EXTRA_LEVELS) levels[level] = typeof map?.[level] === "string";
	return levels;
}

/**
 * Levels of a model whose accepted efforts nobody has stated: every standard level stays selectable and the user ticks
 * what the model really accepts. "xhigh" / "max" are opt-in in the runtime and stay off until ticked.
 */
const unknownLevels = () => Object.fromEntries([...BASE_LEVELS, ...EXTRA_LEVELS].map((level) => [level, !EXTRA_LEVELS.includes(level)]));

/**
 * Effort names the API accepts but runs as another level, as the provider's documentation states (`{ medium: "high" }`).
 * They are not levels of their own, so they are not offered; the form only tells the user about them.
 */
export const levelAliases = (model) => model.raw?.thinkingLevelAliases || {};

const LEVEL_ORDER = [...BASE_LEVELS, ...EXTRA_LEVELS, "ultra"];

/** The levels the form offers: every level except the names the documentation says only run as another level. */
export const offeredLevels = (model) => [...BASE_LEVELS, ...EXTRA_LEVELS].filter((level) => !levelAliases(model)[level]);

/** The aliases as [name, level] pairs in the order of the levels. */
export const aliasPairs = (model) =>
	Object.entries(levelAliases(model)).sort(([a], [b]) => (LEVEL_ORDER.indexOf(a) + 1 || 99) - (LEVEL_ORDER.indexOf(b) + 1 || 99));

export function positive(text) {
	const value = Number(String(text).trim());
	return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : undefined;
}

// Token capacities are edited in K (1K = 1000 tokens) and stored as the real token count. The conversion is exact in
// both directions: 128000 ⇄ "128", and a value that is not a whole thousand keeps its precision (131072 ⇄ "131.072").
/** A token count as K text, without rounding. */
export function toK(tokens) {
	const value = Math.round(Number(tokens));
	if (!Number.isFinite(value) || value < 0) return "";
	const whole = Math.floor(value / 1000);
	const rest = value - whole * 1000;
	return rest ? `${whole}.${String(rest).padStart(3, "0").replace(/0+$/u, "")}` : String(whole);
}

/** K text as a whole, positive token count; undefined when it is not one (more than three decimals, 0, text …). */
export function fromK(text) {
	const value = String(text ?? "").trim();
	const match = /^(\d+)(?:\.(\d{1,3}))?$/u.exec(value);
	if (!match) return undefined;
	const tokens = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** A token capacity in the shared compact display format. */
export const fmtK = fmtTokens;

/** `detected` records which fields were read from the endpoint's catalog (shown as "auto"). */
export function modelDraft(model = {}, detected = {}) {
	return {
		uid: uid(),
		raw: model,
		id: model.id ?? "",
		name: model.name ?? "",
		reasoning: model.reasoning === true,
		// A model that declares reasoning without a map keeps the runtime's meaning (no level is excluded); one that does
		// not declare reasoning has no known levels.
		levels: model.thinkingLevelMap || model.reasoning === true ? levelsFromMap(model.thinkingLevelMap) : unknownLevels(),
		image: model.input?.includes("image") === true,
		// Edited in K; see toK / fromK.
		contextWindow: toK(model.contextWindow ?? DEFAULT_CONTEXT),
		maxTokens: toK(model.maxTokens ?? DEFAULT_MAX_TOKENS),
		pricing: model.cost ? { ...model.cost, tiers: (model.cost.tiers || []).map((tier) => ({ ...tier })) } : null,
		// This model's own format and address; "" = not set here. A key typed for it goes to the credential store.
		api: model.api ?? "",
		baseUrl: model.baseUrl ?? "",
		apiKey: "",
		removeKey: false,
		detected,
	};
}

/** The models.json entry a draft stands for. */
export function buildModel(draft) {
	const model = { ...draft.raw, id: draft.id.trim() };
	if (draft.pricing) {
		const rates = (source) => Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) => [key, Number(source[key])]));
		model.cost = { ...rates(draft.pricing), currency: draft.pricing.currency || "USD", tiers: (draft.pricing.tiers || []).map((tier) => ({ ...rates(tier), inputTokensAbove: Number(tier.inputTokensAbove) })) };
	} else delete model.cost;
	const name = draft.name.trim();
	if (name && name !== model.id) model.name = name;
	else delete model.name;
	model.reasoning = draft.reasoning;
	model.input = draft.image ? ["text", "image"] : ["text"];
	const context = fromK(draft.contextWindow);
	const maxTokens = fromK(draft.maxTokens);
	if (context) model.contextWindow = context;
	else delete model.contextWindow;
	if (maxTokens) model.maxTokens = maxTokens;
	else delete model.maxTokens;
	if (draft.reasoning) {
		const map = { ...draft.raw.thinkingLevelMap };
		for (const level of BASE_LEVELS) {
			if (!draft.levels[level]) map[level] = null;
			else if (map[level] === null) delete map[level];
		}
		for (const level of EXTRA_LEVELS) {
			if (draft.levels[level]) {
				if (typeof map[level] !== "string") map[level] = level;
			} else delete map[level];
		}
		if (Object.keys(map).length) model.thinkingLevelMap = map;
		else delete model.thinkingLevelMap;
	}
	if (draft.api) model.api = draft.api;
	else delete model.api;
	const baseUrl = String(draft.baseUrl ?? "").trim();
	if (baseUrl) model.baseUrl = baseUrl;
	else delete model.baseUrl;
	return model;
}

/** A catalog entry as a new model of the form. Only what the catalog states is set; the rest keeps the usual defaults. */
export function seedFromDetected(found) {
	const seed = { id: found.id };
	if (found.name && found.name !== found.id) seed.name = found.name;
	if (found.reasoning !== undefined) seed.reasoning = found.reasoning;
	if (found.input) seed.input = found.input;
	if (found.contextWindow) seed.contextWindow = found.contextWindow;
	if (found.maxTokens) seed.maxTokens = found.maxTokens;
	if (found.thinkingLevelMap) seed.thinkingLevelMap = found.thinkingLevelMap;
	if (found.thinkingLevelAliases) seed.thinkingLevelAliases = found.thinkingLevelAliases;
	const detected = {};
	for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) if (found[key] !== undefined) detected[key] = true;
	// Levels are marked "auto" only when the provider's documentation or the catalog states them; for any other model the
	// user ticks the levels.
	if (found.thinkingLevelMap && (found.thinkingSource === "official" || found.thinkingSource === "catalog")) detected.levels = true;
	if (found.thinkingSource) detected.levelsSource = found.thinkingSource;
	return modelDraft(seed, detected);
}

/** Model IDs typed by the user: separated by commas, spaces or new lines; duplicates removed, order kept. */
export function parseModelIds(text) {
	return [...new Set(String(text || "").split(/[\s,;\uFF0C\uFF1B]+/u).map((id) => id.trim()).filter(Boolean))];
}

/**
 * Brings what one detection settled into a model already in the form. Only fields the answer really states change:
 * image input, context window and max output when the model list names them, and thinking levels when the list or the
 * provider's documentation states them. Everything the detection could not settle keeps its value.
 */
export function updateFromDetection(model, found) {
	const next = { ...model, raw: { ...model.raw }, detected: { ...model.detected } };
	if (found.input !== undefined) {
		next.image = found.input.includes("image");
		next.detected.input = true;
	}
	for (const field of ["contextWindow", "maxTokens"]) {
		if (found[field]) {
			next[field] = toK(found[field]);
			next.detected[field] = true;
		}
	}
	if (found.thinkingLevelMap && found.thinkingSource && found.thinkingSource !== "unconfirmed") {
		next.reasoning = true;
		next.detected.reasoning = true;
		next.levels = levelsFromMap(found.thinkingLevelMap);
		// A provider-side name the user wrote for a level stays when the level is still supported.
		const map = { ...found.thinkingLevelMap };
		for (const [level, value] of Object.entries(model.raw?.thinkingLevelMap || {})) if (typeof value === "string" && typeof map[level] === "string") map[level] = value;
		next.raw.thinkingLevelMap = map;
		if (found.thinkingSource !== "official") delete next.raw.thinkingLevelAliases;
		else {
			// The documentation settles the levels: what the model really runs as is kept.
			if (found.thinkingLevelAliases) next.raw.thinkingLevelAliases = found.thinkingLevelAliases;
			else delete next.raw.thinkingLevelAliases;
		}
		next.detected.levels = true;
		next.detected.levelsSource = found.thinkingSource;
	} else if (found.reasoning !== undefined) {
		next.reasoning = found.reasoning;
		next.detected.reasoning = true;
	}
	return next;
}

/**
 * Applies a detection answer (only the specified models) to the form's models: a detected model already in the form is
 * updated in place, a new ID is added. Models that were not specified are returned untouched.
 */
export function applyDetection(models, foundList) {
	let next = models;
	const added = [];
	const updated = [];
	for (const found of foundList) {
		const index = next.findIndex((model) => model.id.trim() === found.id);
		if (index < 0) {
			const model = seedFromDetected(found);
			next = [...next.filter((m) => m.id.trim() || m.name.trim()), model];
			added.push(model);
		} else {
			next = next.map((model, i) => (i === index ? updateFromDetection(model, found) : model));
			updated.push(found.id);
		}
	}
	return { models: next, added, updated };
}

/**
 * What one detection settled, remembered per model entry of the form (`uid`) instead of as finished sentences: the user
 * can still remove an entry before saving, and every part of the notice that belonged to it must go with it.
 * `summary` is applyDetection's answer for the same found list; `unlisted` names Model IDs.
 */
export function detectRecord(summary, foundList, { unlisted = [], listError = null } = {}) {
	const uidOf = (id) => summary.models.find((model) => model.id.trim() === id)?.uid;
	const addedUids = new Set(summary.added.map((model) => model.uid));
	const entries = (ids) =>
		[...new Set(ids)]
			.map((id) => ({ uid: uidOf(id), id }))
			.filter((entry) => entry.uid);
	return {
		touched: entries(foundList.map((found) => found.id)).map((entry) => ({ ...entry, added: addedUids.has(entry.uid) })),
		unlisted: entries(unlisted),
		listError,
	};
}

/**
 * The part of a detection that still applies to the models left in the form: a removed entry takes its share of the
 * summary and its warnings with it, and once nothing this detection added or changed is left there is nothing to
 * report, so the notice is gone (`null`). Models the detection did not touch do not matter either way.
 */
export function detectOutcome(record, models) {
	if (!record) return null;
	const present = new Set(models.map((model) => model.uid));
	const kept = (entries) => entries.filter((entry) => present.has(entry.uid));
	const touched = kept(record.touched);
	if (!touched.length) return null;
	return {
		total: touched.length,
		added: touched.filter((entry) => entry.added).length,
		updated: touched.filter((entry) => !entry.added).length,
		unlisted: kept(record.unlisted).map((entry) => entry.id),
		listError: record.listError,
	};
}

/** The address shown in the empty Base URL field. It is only an example: it is never saved and never used. */
export const BASE_URL_EXAMPLE = "https://api.example.com/v1";

/**
 * What is wrong with a Base URL as typed: "" (fine), "missing" (nothing typed: the provider can be saved but stays
 * off), "example" (the example address, which is not a real one) or "invalid" (not an http(s) address).
 */
export function baseUrlProblem(text) {
	const value = String(text ?? "").trim();
	if (!value) return "missing";
	if (value.replace(/\/+$/u, "").toLowerCase() === BASE_URL_EXAMPLE) return "example";
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? "" : "invalid";
	} catch {
		return "invalid";
	}
}

/**
 * The way a provider authenticates, as the form shows it: "key" (an API key in the credential store) or "config" (the
 * key written in models.json). The saved choice (`authMode`) decides; an entry from before the choice was saved uses
 * models.json exactly when it holds a key.
 */
export function authModeOf(config) {
	if (config?.authMode === "config") return "config";
	if (config?.authMode === "apiKey") return "key";
	return config?.apiKey ? "config" : "key";
}

/**
 * Whether the connection fields are complete enough to detect models: a real http(s) Base URL, an API format, and
 * credentials (a typed key, a key already stored, or the key in models.json).
 */
export function connectionReady(draft, { hasStoredKey }) {
	if (baseUrlProblem(draft.baseUrl)) return false;
	if (!draft.api) return false;
	if (draft.auth === "key") return !!draft.apiKey.trim() || hasStoredKey;
	return true;
}

// ---- The three layers of a provider: the provider itself, its keys and their models (see providers/models/layers.ts). -----

/**
 * An entry the layers apply to. A login, an extension's provider (the server sends those without `layered`) and the
 * ready-made Nebius entry stay as they are.
 */
export const isLayeredMember = ({ provider, entry }) =>
	entry?.config?.layered === true && provider.id !== "nebius" && !provider.supportsOAuth && !provider.credentials?.hasOAuth;

/**
 * One row per top-level provider, in the order of the list: a group with its keys as `members`, or an entry that stands
 * alone as its only key. A group's row is where its first key would have been.
 */
export function providerTree(providers, custom) {
	const entries = new Map((custom?.providers || []).map((entry) => [entry.id, entry]));
	const groups = new Map((custom?.groups || []).map((group) => [group.id, group]));
	const rows = [];
	const rowOfGroup = new Map();
	for (const provider of providers) {
		const entry = entries.get(provider.id);
		const group = entry?.config?.group ? groups.get(entry.config.group) : undefined;
		if (!group) {
			rows.push({ id: provider.id, group: null, members: [{ provider, entry }] });
			continue;
		}
		let row = rowOfGroup.get(group.id);
		if (!row) {
			row = { id: `group:${group.id}`, group, members: [] };
			rowOfGroup.set(group.id, row);
			rows.push(row);
		}
		row.members.push({ provider, entry });
	}
	return rows;
}

/** What the page calls a row: the group's name, else the key's own name, else its ID. */
export const rowName = (row) => row.group?.config?.name || row.members[0]?.entry?.config?.name || row.members[0]?.provider.name || row.members[0]?.provider.id;

/** The row a provider entry is shown in, asked for by its row ID or by the ID of one of its keys. */
export const findRow = (rows, id) => rows.find((row) => row.id === id || row.members.some((member) => member.provider.id === id));

/** What no layer sets for a model, as "api", "baseUrl" and "key": such a model is marked, nothing is guessed for it. */
export function modelGaps(model, { group, entry, hasKey }) {
	const gaps = [];
	if (!(group?.api || entry?.api || model.api)) gaps.push("api");
	if (!(group?.baseUrl || entry?.baseUrl || String(model.baseUrl ?? "").trim())) gaps.push("baseUrl");
	if (!hasKey) gaps.push("key");
	return gaps;
}

/**
 * Whether this entry itself has a key, which then serves all its models: one saved for it, a login, or one from outside
 * MyHarness. The server also reports "stored" for a key of the group or of a single model, so that alone does not say.
 */
export function entryHasSharedKey(provider) {
	const credentials = provider.credentials;
	if (!credentials) return !!provider.configured;
	return credentials.apiKeys?.length > 0 || !!credentials.hasOAuth || !!credentials.runtimeOverride || (!!provider.configured && provider.authSource !== "stored");
}

/** How many saved models of a key lack something on every layer. */
export function memberGapCount({ provider, entry }, group) {
	if (!entry?.config?.layered) return 0;
	// A key from the provider or from this entry serves every model; otherwise a model needs its own.
	const shared = !!group?.key || entryHasSharedKey(provider);
	return (entry.config.models ?? []).filter((model) => modelGaps(model, { group: group?.config, entry: entry.config, hasKey: shared || !!entry.modelKeys?.[model.id] }).length > 0).length;
}

/**
 * What a field holds on every key of a provider, for the warning before a value on top replaces them: `differ` when the
 * keys use different values now.
 */
export function memberValues(members, field) {
	const values = new Set();
	for (const { entry } of members) {
		const config = entry?.config;
		if (config?.[field]) values.add(config[field]);
		for (const model of config?.models ?? []) if (!config?.[field] && model[field]) values.add(model[field]);
	}
	return { values: [...values], differ: values.size > 1 };
}

/** A value on the layer above covers a model's: what is left of the model's own stays where it is. */
export function coverOf(field, { upper, draft }) {
	if (upper?.[field]) return { layer: "provider", value: upper[field] };
	const own = draft?.raw?.layered ? String(draft[field] ?? "").trim() : "";
	return own ? { layer: "key", value: own } : null;
}

/** The first ID from this base no other entry has. */
export function uniqueProviderId(base, taken) {
	const name = base || "provider";
	if (!taken.has(name)) return name;
	for (let index = 2; ; index++) {
		const candidate = `${name}-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Sets a format and / or address on the ticked models. Under the layered rule a value of the key would cover them, so it
 * moves down onto its models first: the ones not ticked keep using exactly what they use now.
 */
export function applyToTickedModels(draft, ticked, { api, baseUrl }) {
	const layered = draft.raw?.layered === true;
	const keyApi = layered ? draft.api : "";
	const keyUrl = layered ? String(draft.baseUrl ?? "").trim() : "";
	const url = String(baseUrl ?? "").trim();
	const models = draft.models.map((model) => {
		const on = ticked.has(model.uid);
		const next = { ...model };
		if (api) {
			if (on) next.api = api;
			else if (keyApi) next.api = keyApi;
		}
		if (url) {
			if (on) next.baseUrl = url;
			else if (keyUrl) next.baseUrl = keyUrl;
		}
		return next;
	});
	return {
		models,
		...(api && keyApi ? { api: "" } : {}),
		...(url && keyUrl ? { baseUrl: "" } : {}),
		movedDown: !!((api && keyApi) || (url && keyUrl)),
	};
}

/** Fields only a provider entry of models.json has; a value with none of them is a wrapper around one. */
const PROVIDER_FIELDS = ["api", "baseUrl", "models", "apiKey", "authMode", "headers"];
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isProviderEntry = (value) => isPlainObject(value) && PROVIDER_FIELDS.some((field) => field in value);

/**
 * The provider entry in what the user typed or pasted in the JSON view. Besides the entry itself, it accepts the forms
 * an entry is usually copied in: with its key (`"anthropic": { ... }`, as models.json and answers show it), wrapped
 * in braces with that key, or a whole models.json (`{ "providers": { ... } }`), where the entry named `providerId`, or
 * the only one, is taken. Returns `{ config }`, `{ error: "not-object" }`, or `{ error: "syntax", message }`.
 */
export function parseProviderJson(text, providerId) {
	const source = String(text ?? "").trim();
	let value;
	try {
		value = JSON.parse(source);
	} catch (error) {
		// `"id": { ... }` (perhaps with a trailing comma) is one member of an object: try it with the braces around it.
		try {
			value = JSON.parse(`{${source.replace(/,\s*$/u, "")}}`);
		} catch {
			return { error: "syntax", message: error.message };
		}
	}
	if (!isPlainObject(value)) return { error: "not-object" };
	if (isProviderEntry(value)) return { config: value };
	const map = isPlainObject(value.providers) && !isProviderEntry(value.providers) ? value.providers : value;
	const keys = Object.keys(map);
	const key = providerId && keys.includes(providerId) ? providerId : keys.length === 1 ? keys[0] : undefined;
	return { config: key !== undefined && isProviderEntry(map[key]) ? map[key] : value };
}
