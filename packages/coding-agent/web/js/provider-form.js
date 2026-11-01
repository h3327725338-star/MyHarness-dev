// The editor of one provider defined in models.json, shown in the right pane of Settings → Providers: the connection
// (API format, Base URL, API key) and the models. Models are checked only on request, for the Model IDs the user types;
// opening, switching or saving a provider never contacts the endpoint. The JSON view is an optional advanced editor over
// the same data.
import { html, useEffect, useRef, useState, Collapse, Icon, Segmented, Spinner, Toggle, UnitGroup } from "./ui.js";
import { Select } from "./select.js";
import { post } from "./store.js";
import { effortName, fmtTokens } from "./util.js";
import { N_, t } from "./i18n.js";
import { BASE_URL_EXAMPLE, aliasPairs, applyDetection, applyToTickedModels, authModeOf, baseUrlProblem, buildModel, connectionReady, coverOf, detectOutcome, detectRecord, fmtK, fromK, modelDraft, modelGaps, offeredLevels, parseModelIds, parseProviderJson, uniqueProviderId } from "./provider-models.js";

const API_LABELS = {
	"openai-completions": N_("OpenAI Chat Completions (most compatible services)"),
	"openai-responses": N_("OpenAI Responses"),
	"anthropic-messages": N_("Anthropic Messages"),
	"google-generative-ai": N_("Google Gemini"),
	"mistral-conversations": N_("Mistral Conversations"),
};
export const apiLabel = (type) => (API_LABELS[type] ? t(API_LABELS[type]) : type);
/** The formats to choose from; `blank` names the choice of setting none on this layer. */
export const apiOptions = (types, blank) => [...(blank ? [{ value: "", label: blank }] : []), ...(types?.length ? types : Object.keys(API_LABELS)).map((type) => ({ value: type, label: apiLabel(type) }))];
const GAP_LABELS = { api: N_("No format"), baseUrl: N_("No Base URL"), key: N_("No API key") };

/** Says which layer applies to this field and with what; a value of its own here stays and applies again once that layer is cleared. */
function coverHint(cover, hasOwn, label = (value) => value) {
	const value = label(cover.value);
	if (!hasOwn) return cover.layer === "provider" ? t("Uses the global settings: {value}.", { value }) : t("Uses this key's: {value}.", { value });
	return cover.layer === "provider"
		? t("Covered by the global settings: {value}. What is here is kept and applies again once that is cleared.", { value })
		: t("Covered by this key: {value}. What is here is kept and applies again once that is cleared.", { value });
}
/** Names of the IP protocol choices; the default one gets "(default)" after its name. */
const IP_FAMILY_NAMES = { auto: N_("Auto"), ipv4: N_("IPv4 only"), ipv6: N_("IPv6 only") };
const ipFamilyLabel = (family, defaultFamily) => (family === defaultFamily ? t("{name} (default)", { name: t(IP_FAMILY_NAMES[family]) }) : t(IP_FAMILY_NAMES[family]));
/** Keep-alive time as typed: empty (use the default) or a whole number of seconds in range; anything else is a problem. */
const parseKeepAlive = (text, defaults) => {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return { value: undefined };
	const min = defaults?.keepAliveMin ?? 1;
	const max = defaults?.keepAliveMax ?? 600;
	const value = /^[0-9]+$/u.test(trimmed) ? Number(trimmed) : NaN;
	return Number.isSafeInteger(value) && value >= min && value <= max ? { value } : { problem: t("Enter a whole number of seconds from {min} to {max}, or leave it empty for the default.", { min, max }) };
};
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** The server reads the model list for up to 60 s; this only guards against no answer at all. */
const DETECT_TIMEOUT_MS = 90_000;

const DETECT_ERRORS = {
	authentication: N_("The endpoint rejected the API key."),
	permission: N_("The API key is not allowed to list models."),
	unsupported: N_("The endpoint has no model list at this address. It may not offer one, or the Base URL is wrong (many services need a /v1 suffix)."),
	connection: N_("Could not reach the endpoint."),
	timeout: N_("The model list request timed out."),
	rate_limited: N_("The endpoint is rate limiting requests; try again later."),
	upstream_error: N_("The endpoint reported an error of its own."),
	invalid_response: N_("The endpoint returned a model list in an unknown format."),
	pagination: N_("The endpoint's model list could not be read to the end."),
	invalid_base_url: N_("The Base URL is not valid."),
};

/** Why reading the model list failed, as specific as the answer allows. */
function detectMessage(result) {
	// A "connection" failure that carries an HTTP status means the endpoint was reached and answered with an error.
	const kind = result.code === "connection" && result.status ? "upstream_error" : result.code;
	const base = DETECT_ERRORS[kind] ? t(DETECT_ERRORS[kind]) : t("Could not read the model list.");
	const extra = [result.status ? `HTTP ${result.status}` : "", result.detail || "", result.url || ""].filter(Boolean);
	return extra.length ? `${base} (${extra.join(" · ")})` : base;
}

/** The request never produced an answer from the endpoint: MyHarness itself failed to run it. */
function detectFailure(error) {
	if (error.status === 404) return t("This MyHarness server has no model-detection interface; it is older than this page. Restart MyHarness and try again.");
	if (error.status) return t("MyHarness could not run the detection: {message}", { message: error.message });
	return error.message;
}

const withTimeout = (promise, ms) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(t("The detection timed out."))), ms);
		promise.then(
			(value) => (clearTimeout(timer), resolve(value)),
			(error) => (clearTimeout(timer), reject(error)),
		);
	});

const slugify = (name) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|-+$/g, "");

const SESSION_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Why the session header name cannot be saved, or "" when empty (off) or fine. Only the name is edited; the value is always the current conversation ID. */
const sessionHeaderProblem = (text) => {
	const name = String(text ?? "").trim();
	if (!name) return "";
	if (name.length > 128 || !SESSION_HEADER_NAME_PATTERN.test(name)) return t("Header name “{name}” is not valid.", { name });
	return "";
};

function draftFromConfig(id, config, previous) {
	const authMode = authModeOf(config);
	return {
		id,
		raw: config,
		name: config.name ?? "",
		// Under the layers an empty format means this key leaves it to the layer that sets it.
		api: config.api ?? (config.layered ? "" : "openai-completions"),
		baseUrl: config.baseUrl ?? "",
		// Empty = not set in models.json (the default applies); a choice, even "auto", is written to the file.
		keepAlive: config.keepAliveSeconds === undefined ? "" : String(config.keepAliveSeconds),
		ipFamily: config.ipFamily ?? "",
		sessionHeader: config.sessionHeader ?? "",
		auth: authMode,
		apiKey: previous?.apiKey ?? "",
		models: (config.models ?? []).map((model) => modelDraft(model)),
	};
}

function buildConfig(draft, defaults) {
	const config = { ...draft.raw };
	const name = draft.name.trim();
	if (name) config.name = name;
	else delete config.name;
	// An empty Base URL is "not filled in yet": nothing is written for it, least of all the example address.
	if (draft.baseUrl.trim()) config.baseUrl = draft.baseUrl.trim();
	else delete config.baseUrl;
	if (draft.api) config.api = draft.api;
	else delete config.api;
	const keepAlive = parseKeepAlive(draft.keepAlive, defaults).value;
	if (keepAlive === undefined) delete config.keepAliveSeconds;
	else config.keepAliveSeconds = keepAlive;
	if (draft.ipFamily) config.ipFamily = draft.ipFamily;
	else delete config.ipFamily;
	// Static `headers` already in the file are left untouched here; this form only edits the session header name.
	const sessionHeader = String(draft.sessionHeader ?? "").trim();
	if (sessionHeader) config.sessionHeader = sessionHeader;
	else delete config.sessionHeader;
	// The chosen way to authenticate is saved with the provider. Whatever models.json already holds for the other way
	// stays where it is, so switching back loses nothing.
	config.authMode = draft.auth === "config" ? "config" : "apiKey";
	config.models = draft.models.map(buildModel);
	return config;
}

function validate(draft, defaults) {
	if (!ID_PATTERN.test(draft.id.trim())) return t("Provider ID may only use lowercase letters, digits, dots, underscores and hyphens.");
	// A provider may be saved before its Base URL is known (it stays off until then); a wrong address is still refused.
	const urlProblem = baseUrlProblem(draft.baseUrl);
	if (urlProblem === "example") return t("{url} is only the example. Enter the address of your service, or leave the field empty for now.", { url: BASE_URL_EXAMPLE });
	if (urlProblem === "invalid") return t("The Base URL must be a full http:// or https:// address.");
	const keepAliveProblem = parseKeepAlive(draft.keepAlive, defaults).problem;
	if (keepAliveProblem) return keepAliveProblem;
	const headerProblem = sessionHeaderProblem(draft.sessionHeader);
	if (headerProblem) return headerProblem;
	const seen = new Set();
	for (const model of draft.models) {
		const id = model.id.trim();
		if (!id) return t("Every model needs an ID.");
		if (seen.has(id)) return t("Model ID “{id}” appears twice.", { id });
		seen.add(id);
		if (String(model.baseUrl ?? "").trim() && baseUrlProblem(model.baseUrl)) return t("The Base URL of “{id}” must be a full http:// or https:// address.", { id });
		if (model.pricing) {
			const rows = [model.pricing, ...(model.pricing.tiers || [])];
			if (rows.some((row) => ["input", "output", "cacheRead", "cacheWrite"].some((key) => String(row[key]).trim() === "" || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) || (model.pricing.tiers || []).some((row) => !Number.isSafeInteger(Number(row.inputTokensAbove)) || Number(row.inputTokensAbove) <= 0)) return t("Prices must be non-negative numbers; tier thresholds must be positive whole tokens.");
		}
		if (fromK(model.contextWindow) === undefined || fromK(model.maxTokens) === undefined) return t("Context window and max output of “{id}” must be positive numbers of K tokens (1K = 1000, at most three decimals).", { id });
	}
	return "";
}

export function Field({ label, children, hint, class: cls }) {
	return html`<label class=${`col field-label ${cls || ""}`}><span class="field-name">${label}</span>${children}${hint ? html`<span class="dim pf-hint">${hint}</span>` : null}</label>`;
}

function Detected({ title }) {
	return html`<span class="badge accent pf-auto" title=${title || t("Set by the last detection")}>${t("detected")}</span>`;
}

const levelSummary = (model) => offeredLevels(model).filter((level) => model.levels[level] && level !== "off").map((level) => effortName(level)).join(" · ");

/** Where the levels of a detected model come from. */
const levelSourceTitle = (source) => (source === "official" ? t("Taken from the provider's documentation") : t("Read from the endpoint's model list"));

/** What a level chip says when it is hovered or focused. */
function levelTitle(model, level, detected) {
	if (model.levels[level] && detected.levelsSource === "official") return t("Stated in the provider's documentation.");
	return undefined;
}

/** A token capacity edited in K: the number is typed, the unit is fixed. */
function KField({ label, detected, value, onInput }) {
	const tokens = fromK(value);
	return html`<label class="col field-label"><span class="field-name">${label}${detected ? html` <${Detected} />` : null}</span>
		<span class="k-field"><input class="field mono" inputmode="decimal" value=${value} onInput=${(e) => onInput(e.target.value)} /><span class="k-unit" aria-hidden="true">K</span></span>
		<span class="dim pf-hint">${tokens ? t("{n} tokens", { n: fmtTokens(tokens) }) : t("1K = 1000 tokens")}</span>
	</label>`;
}

const PRICE_FIELDS = [["input", N_("Input price")], ["output", N_("Output price")], ["cacheRead", N_("Cache read")], ["cacheWrite", N_("Cache write")]];
const emptyRates = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function Pricing({ value, onChange }) {
	const update = (patch) => onChange({ ...value, ...patch });
	const row = (rates, change) => html`<div class="pf-two">${PRICE_FIELDS.map(([key, label]) => html`<${Field} key=${key} label=${`${t(label)} (${value.currency === "CNY" ? "¥" : "$"}/1M)`}><input class="field mono" type="number" min="0" step="any" value=${rates[key]} onInput=${(e) => change({ ...rates, [key]: e.target.value })} /><//>`)}</div>`;
	return html`<div class="col pf-pricing">
		<div class="row"><strong class="grow">${t("Custom pricing")}</strong><${Toggle} checked=${!!value} label=${t("Custom pricing")} onChange=${(enabled) => onChange(enabled ? { ...emptyRates(), currency: "USD", tiers: [] } : null)} /></div>
		${value ? html`<${Field} label=${t("Currency")} hint=${t("Prices per 1M tokens. Currency changes do not convert rates.")}><${Select} value=${value.currency || "USD"} ariaLabel=${t("Currency")} onChange=${(next) => update({ currency: next })} options=${[{ value: "USD", label: "USD ($)" }, { value: "CNY", label: "CNY (¥)" }]} /><//>
			${row(value, onChange)}
			${(value.tiers || []).map((tier, index) => html`<div class="col pf-pricing" key=${index}>
				<div class="row"><strong class="grow">${t("Long-context tier")} ${index + 1}</strong><button class="icon-btn sm" title=${t("Remove tier")} aria-label=${t("Remove tier")} onClick=${() => update({ tiers: value.tiers.filter((_, i) => i !== index) })}><${Icon} name="trash" size=${14} /></button></div>
				<${Field} label=${t("Input token threshold")} hint=${t("Applies to the full request when input plus cached tokens exceeds this threshold.")}><input class="field mono" type="number" min="1" step="1" value=${tier.inputTokensAbove} onInput=${(e) => update({ tiers: value.tiers.map((item, i) => i === index ? { ...item, inputTokensAbove: e.target.value } : item) })} /><//>
				${row(tier, (next) => update({ tiers: value.tiers.map((item, i) => i === index ? next : item) }))}
			</div>`)}
			<button class="btn sm" onClick=${() => update({ tiers: [...(value.tiers || []), { ...emptyRates(), inputTokensAbove: 200000 }] })}><${Icon} name="plus" size=${14} />${t("Add pricing tier")}</button>` : null}
	</div>`;
}

/** What the model itself sets, greyed when a layer above covers it: its format, its address and a key of its own. */
function ModelLayerFields({ model, set, types, layers, storedKey, sharedKey }) {
	const apiCover = coverOf("api", layers);
	const urlCover = coverOf("baseUrl", layers);
	const keyCover = layers.upper?.key ? "provider" : sharedKey ? "key" : null;
	const gaps = modelGaps(model, { group: layers.upper, entry: layers.draft, hasKey: true });
	const ownKey = !!storedKey && !model.removeKey;
	return html`<${Field} label=${t("API format")} hint=${apiCover ? coverHint(apiCover, !!model.api, apiLabel) : null}>
			<${Select} value=${model.api} disabled=${!!apiCover} ariaLabel=${t("API format")} onChange=${(next) => set({ api: next })} options=${apiOptions(types, t("Not set here"))} />
			${gaps.includes("api") ? html`<span class="pf-hint pf-problem" role="alert">${t("No layer sets the format, so this model is not offered until it is filled in.")}</span>` : null}
		<//>
		<${Field} label=${t("Base URL")} hint=${urlCover ? coverHint(urlCover, !!model.baseUrl.trim()) : null}>
			<input class="field mono" disabled=${!!urlCover} placeholder=${t("Not set here")} aria-label=${t("Base URL")} value=${model.baseUrl} onInput=${(e) => set({ baseUrl: e.target.value })} />
			${gaps.includes("baseUrl") ? html`<span class="pf-hint pf-problem" role="alert">${t("No layer sets the address, so this model is not offered until it is filled in.")}</span>` : null}
		<//>
		<div class="col field-label"><span class="field-name">${t("API key")}</span>
			${ownKey
				? html`<div class=${`key-current ${keyCover ? "covered" : ""}`}><${Icon} name="key" size=${14} /><span class="grow dim mono">${storedKey.suffix ? `••••${storedKey.suffix}` : ""}</span><button type="button" class="btn sm ghost" onClick=${() => set({ removeKey: true, apiKey: "" })}>${t("Remove")}</button></div>`
				: html`<input class="field mono" type="password" autocomplete="off" disabled=${!!keyCover} placeholder=${keyCover ? t("Not needed") : t("Only when this model needs a key of its own")} aria-label=${t("API key of {id}", { id: model.id.trim() })} value=${model.apiKey} onInput=${(e) => set({ apiKey: e.target.value })} />`}
			${keyCover
				? html`<span class="dim pf-hint">${ownKey
					? (keyCover === "provider" ? t("Covered by the global API key. What is here is kept and applies again once that is removed.") : t("Covered by this key's API key. What is here is kept and applies again once that is removed."))
					: (keyCover === "provider" ? t("Uses the global API key.") : t("Uses this key's API key."))}</span>`
				: null}
		</div>`;
}

/** One model of the provider: a summary row that opens into its settings. */
function ModelCard({ model, open, onToggle, onChange, onRemove, types, layers, storedKey, sharedKey, ticked, onTick }) {
	const set = (patch) => onChange({ ...model, ...patch });
	// A switch the user flips by hand is theirs.
	const touch = (key, patch) => set({ ...patch, touched: { ...model.touched, [key]: true } });
	const d = model.detected || {};
	const title = model.name.trim() || model.id.trim() || t("New model");
	const hasKey = !!sharedKey || !!layers?.upper?.key || !!model.apiKey.trim() || (!!storedKey && !model.removeKey);
	const gaps = layers ? modelGaps(model, { group: layers.upper, entry: layers.draft, hasKey }) : [];
	return html`<div class=${`pf-model ${open ? "open" : ""}`}>
		<div class="row pf-model-head">
			${onTick ? html`<input type="checkbox" class="pf-tick" aria-label=${t("Select {name}", { name: title })} checked=${!!ticked} onChange=${(e) => onTick(e.target.checked)} />` : null}
			<button type="button" class="pf-model-toggle grow" aria-expanded=${open} onClick=${onToggle}>
				<${Icon} name="chevronRight" size=${13} class="disclose" />
				<span class="truncate pf-model-title">${title}</span>
				${model.id.trim() && title !== model.id.trim() ? html`<span class="dim mono truncate">${model.id.trim()}</span>` : null}
			</button>
			<span class="pf-model-badges">
				${gaps.length ? html`<span class="badge danger" title=${t("No layer sets this, so the model is not offered until it is filled in.")}>${gaps.map((gap) => t(GAP_LABELS[gap])).join(" · ")}</span>` : null}
				${model.reasoning ? html`<span class="badge" title=${levelSummary(model)}>${t("thinking")}</span>` : null}
				${model.image ? html`<span class="badge">${t("images")}</span>` : null}
				${fromK(model.contextWindow) ? html`<span class="dim">${fmtK(fromK(model.contextWindow))}</span>` : null}
			</span>
			<button class="icon-btn sm" title=${t("Remove model")} aria-label=${t("Remove model")} onClick=${onRemove}><${Icon} name="trash" size=${14} /></button>
		</div>
		<${Collapse} open=${open}>
			<div class="col pf-model-body">
				<div class="pf-two">
					<${Field} label=${t("Model ID")}><input class="field mono" value=${model.id} autofocus=${!model.id} onInput=${(e) => set({ id: e.target.value })} /><//>
					<${Field} label=${t("Display name")}><input class="field" placeholder=${t("Optional")} value=${model.name} onInput=${(e) => set({ name: e.target.value })} /><//>
				</div>
				${layers ? html`<${ModelLayerFields} model=${model} set=${set} types=${types} layers=${layers} storedKey=${storedKey} sharedKey=${sharedKey} />` : null}
				<div class="pf-two">
					<${KField} label=${t("Context window")} detected=${d.contextWindow} value=${model.contextWindow} onInput=${(v) => set({ contextWindow: v })} />
					<${KField} label=${t("Max output")} detected=${d.maxTokens} value=${model.maxTokens} onInput=${(v) => set({ maxTokens: v })} />
				</div>
				<${Pricing} value=${model.pricing} onChange=${(pricing) => set({ pricing })} />
				<div class="pf-switches">
					<label class="check-label"><${Toggle} checked=${model.reasoning} label=${t("Supports reasoning")} onChange=${(v) => touch("reasoning", { reasoning: v })} /><span>${t("Supports reasoning")}</span>${d.reasoning ? html`<${Detected} />` : null}</label>
					<label class="check-label"><${Toggle} checked=${model.image} label=${t("Accepts images")} onChange=${(v) => set({ image: v })} /><span>${t("Accepts images")}</span>${d.input ? html`<${Detected} />` : null}</label>
				</div>
				${model.reasoning
					? html`<div class="col field-label"><span class="field-name">${t("Thinking effort this model accepts")}${d.levels ? html` <${Detected} title=${levelSourceTitle(d.levelsSource)} />` : null}</span>
						<div class="pf-levels">${offeredLevels(model).map((level) => html`<button type="button" key=${level} class=${`chip-toggle ${model.levels[level] ? "on" : ""}`} aria-pressed=${model.levels[level]} title=${levelTitle(model, level, d)} onClick=${() => touch("levels", { levels: { ...model.levels, [level]: !model.levels[level] }, detected: { ...d, levels: false } })}>${effortName(level)}</button>`)}</div>
						<span class="dim pf-hint">${d.levels ? (d.levelsSource === "official" ? t("These are the levels the provider's documentation lists for this model.") : t("These are the levels the endpoint lists for this model.")) : t("Nothing states which levels this model accepts, so the standard ones stay available. Tick the levels it really accepts and untick the others; MyHarness does not test them.")}</span>
						${aliasPairs(model).length ? html`<span class="dim pf-hint">${t("Accepted by the API, but not separate levels (provider documentation): {pairs}", { pairs: aliasPairs(model).map(([name, level]) => `${effortName(name)} → ${effortName(level)}`).join(" · ") })}</span>` : null}</div>`
					: null}
			</div>
		<//>
	</div>`;
}

/**
 * props:
 * - initial = { id, config } to edit (secrets in config arrive as the server's placeholder), or null to add a provider
 * - apiTypes: API formats the server accepts
 * - defaults: the server's connection defaults (keepAliveSeconds, keepAliveMin/Max, ipFamily, ipFamilies)
 * - keyArea: the provider's API key summary (rendered by the page; it has the "Manage API keys" entry)
 * - hasStoredKey: a key is already saved for this provider
 * - onSaved(id), onDirty(bool), footerStart: extra actions at the start of the footer (Delete provider)
 * - asKey: this form edits one key of a provider, so it is called that
 * - upper: what the layer above sets (name, baseUrl, api, key): it covers the same fields here
 * - modelKeys: the keys saved for single models, as { modelId: { suffix } }
 * - configured: this entry already has a key from outside the form (an environment variable, for example)
 * - attachTo and seed, for a new key: the entry whose provider it joins, and the { id, baseUrl, api } it starts from
 * - takenIds: the entry IDs a new key must not use
 */
export function ProviderForm({ initial, apiTypes, defaults, keyArea, hasStoredKey, onSaved, onDirty, footerStart, asKey, upper, modelKeys, configured, attachTo, seed, takenIds }) {
	const isNew = !initial;
	const makeDraft = () => {
		if (initial) return draftFromConfig(initial.id, initial.config);
		if (seed) return draftFromConfig(seed.id, { layered: true, ...(seed.api ? { api: seed.api } : {}), ...(seed.baseUrl ? { baseUrl: seed.baseUrl } : {}), models: [] });
		return draftFromConfig("", { layered: true, api: "openai-completions", models: [] });
	};
	const [draft, setDraft] = useState(makeDraft);
	const [dirty, setDirty] = useState(false);
	const [idTouched, setIdTouched] = useState(!isNew);
	const [view, setView] = useState("form");
	const [json, setJson] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [idsText, setIdsText] = useState("");
	// `result` is what the last detection settled, kept per model entry, so the notice can follow the list while the
	// user still edits it; `message` / `notes` carry a failure, which is about the request and not about the entries.
	const [detect, setDetect] = useState({ status: "idle", message: "", notes: [], result: null });
	// Models whose settings are open. A model added by hand opens at once.
	const [openModels, setOpenModels] = useState(() => new Set());
	// Models ticked to change together, and what to set on them.
	const [ticked, setTicked] = useState(() => new Set());
	const [batch, setBatch] = useState({ api: "", baseUrl: "", note: false });
	const rootRef = useRef(null);
	const alive = useRef(true);
	// The detection answer arrives after an await: it is applied to the form as it is then, not as it was when asked.
	const draftRef = useRef(draft);
	draftRef.current = draft;
	useEffect(() => () => {
		alive.current = false;
		onDirty?.(false);
	}, []);
	useEffect(() => onDirty?.(dirty), [dirty]);
	const patch = (next) => {
		setDraft((current) => ({ ...current, ...next }));
		setDirty(true);
	};
	const types = apiTypes?.length ? apiTypes : Object.keys(API_LABELS);
	const layered = draft.raw.layered === true;
	const upperKey = upper?.key || null;
	// What the requests of this key would use, from the top down; a key that leaves both to its models uses one of theirs.
	const effective = {
		...draft,
		baseUrl: upper?.baseUrl || draft.baseUrl || draft.models.find((model) => model.baseUrl.trim())?.baseUrl || "",
		api: upper?.api || draft.api || draft.models.find((model) => model.api)?.api || "",
	};
	const ready = connectionReady(effective, { hasStoredKey: hasStoredKey || !!upperKey });
	// A key that serves every model of this entry; without one a model needs its own.
	const sharedKey = hasStoredKey || !!configured || !!draft.apiKey.trim() || (draft.auth === "config" && !!draft.raw.apiKey);
	const layers = layered ? { upper, draft: { ...draft, baseUrl: draft.baseUrl.trim() } } : null;
	const keepAliveProblem = parseKeepAlive(draft.keepAlive, defaults).problem;
	const headerProblem = sessionHeaderProblem(draft.sessionHeader);
	const ipFamilies = defaults?.ipFamilies?.length ? defaults.ipFamilies : Object.keys(IP_FAMILY_NAMES);

	/** The provider entry in the JSON view, or why it cannot be read. */
	const readJson = () => {
		const result = parseProviderJson(json, draft.id.trim());
		if (result.error === "syntax") return { problem: t("Invalid JSON: {message}", { message: result.message }) };
		if (result.error) return { problem: t("Invalid JSON: {message}", { message: t("The configuration must be a JSON object.") }) };
		return { config: result.config };
	};

	const switchView = (next) => {
		if (next === view) return;
		if (next === "json") {
			const keepAliveProblem = parseKeepAlive(draft.keepAlive, defaults).problem;
			if (keepAliveProblem) return setError(keepAliveProblem);
			setJson(JSON.stringify(buildConfig(draft, defaults), null, 2));
			setError("");
			setView("json");
			return;
		}
		const read = readJson();
		if (read.problem) return setError(read.problem);
		const parsed = read.config;
		setError("");
		setDraft((current) => ({ ...draftFromConfig(current.id, parsed, current), apiKey: current.apiKey }));
		setView("form");
	};

	/** Checks exactly the Model IDs typed in the box; nothing else is looked up or changed. */
	const runDetect = async () => {
		const ids = parseModelIds(idsText);
		if (!ids.length) return setDetect({ status: "error", message: t("Type one or more Model IDs to detect."), notes: [], result: null });
		if (!ready) return setDetect({ status: "error", message: t("Complete the connection first (Base URL and API key)."), notes: [], result: null });
		// Each named Model ID is asked directly, level by level; it does not have to be in the endpoint's model list.
		setDetect({ status: "loading", message: "", notes: [], result: null });
		let result;
		try {
			result = await withTimeout(
				post("/api/providers/custom/detect", {
					baseUrl: effective.baseUrl.trim(),
					api: effective.api,
					auth: draft.auth,
					apiKey: draft.auth === "key" ? draft.apiKey : "",
					configApiKey: draft.auth === "config" ? draft.raw.apiKey : undefined,
					// A new key under a provider with a global key asks with that key; nothing else of the other entry is used.
					headers: draft.raw.headers ?? (isNew ? {} : undefined),
					id: isNew ? (upperKey && attachTo ? attachTo : "") : draft.id,
					modelIds: ids,
				}),
				DETECT_TIMEOUT_MS,
			);
		} catch (e) {
			if (alive.current) setDetect({ status: "error", message: detectFailure(e), notes: [], result: null });
			return;
		}
		if (!alive.current) return;
		if (!result.ok) return setDetect({ status: "error", message: detectMessage(result), notes: [], result: null });
		const summary = applyDetection(draftRef.current.models, result.models);
		setDraft({ ...draftRef.current, models: summary.models });
		setDirty(true);
		setDetect({
			status: "ok",
			message: "",
			notes: [],
			result: detectRecord(summary, result.models, {
				unlisted: result.unlisted ?? [],
				listError: result.listError ?? null,
			}),
		});
		if (summary.added.length) setOpenModels((current) => new Set([...current, ...summary.added.map((m) => m.uid)]));
		setIdsText("");
	};

	const updateModel = (uid, next) => patch({ models: draft.models.map((m) => (m.uid === uid ? next : m)) });
	const toggleOpen = (uid) =>
		setOpenModels((current) => {
			const next = new Set(current);
			if (next.has(uid)) next.delete(uid);
			else next.add(uid);
			return next;
		});
	const addManually = () => {
		const model = modelDraft();
		patch({ models: [...draft.models, model] });
		setOpenModels((current) => new Set(current).add(model.uid));
	};
	const tick = (uid, on) =>
		setTicked((current) => {
			const next = new Set(current);
			if (on) next.add(uid);
			else next.delete(uid);
			return next;
		});
	const applyBatch = () => {
		const { movedDown, ...next } = applyToTickedModels(draft, ticked, batch);
		patch(next);
		setTicked(new Set());
		setBatch({ api: "", baseUrl: "", note: movedDown });
	};
	/** The keys of single models this save changes: typed, removed, or following a Model ID that was edited. */
	const modelKeyChanges = () => {
		const keys = {};
		const moves = {};
		for (const model of draft.models) {
			const id = model.id.trim();
			const before = model.raw?.id;
			if (before && before !== id && modelKeys?.[before]) moves[before] = id;
			if (model.apiKey.trim()) keys[id] = model.apiKey.trim();
			else if (model.removeKey) keys[id] = null;
		}
		return { modelKeys: keys, modelKeyMoves: moves };
	};

	const save = async () => {
		let config;
		let problem = "";
		if (view === "json") {
			const read = readJson();
			if (read.problem) return setError(read.problem);
			config = read.config;
			if (!ID_PATTERN.test(draft.id.trim())) problem = t("Provider ID may only use lowercase letters, digits, dots, underscores and hyphens.");
			else problem = sessionHeaderProblem(config.sessionHeader);
		} else {
			problem = validate(draft, defaults);
			config = buildConfig(draft, defaults);
		}
		if (problem) {
			setError(problem);
			return rootRef.current?.closest(".settings-body")?.scrollTo?.({ top: 0, behavior: "smooth" });
		}
		setError("");
		setBusy(true);
		try {
			const result = await post("/api/providers/custom/save", { id: draft.id.trim(), previousId: initial?.id, config, apiKey: draft.auth === "key" ? draft.apiKey : "", ...(attachTo ? { attachTo } : {}), ...(view === "json" ? {} : modelKeyChanges()) });
			if (!alive.current) return;
			setDirty(false);
			await Promise.resolve(onSaved(draft.id.trim(), { missingBaseUrl: !!result?.missingBaseUrl })).catch(() => {});
			if (!alive.current) return;
			// What was just saved is now the starting point; typed keys are stored and leave the form.
			if (view === "json") setDraft((current) => ({ ...current, apiKey: "" }));
			else setDraft((current) => ({ ...current, raw: config, apiKey: "", models: current.models.map((model) => ({ ...model, raw: buildModel(model), apiKey: "", removeKey: false })) }));
		} catch (e) {
			if (alive.current) {
				setError(e.message);
				rootRef.current?.closest(".settings-body")?.scrollTo?.({ top: 0, behavior: "smooth" });
			}
		}
		if (alive.current) setBusy(false);
	};
	const discard = () => {
		setDraft(makeDraft());
		setView("form");
		setError("");
		setDetect({ status: "idle", message: "", notes: [], result: null });
		setTicked(new Set());
		setBatch({ api: "", baseUrl: "", note: false });
		setDirty(false);
	};

	// Both ways are always offered, whichever one is chosen.
	const authOptions = [{ value: "key", label: t("API key") }, { value: "config", label: t("Set in models.json") }];
	const configHasKey = !!draft.raw.apiKey;
	const detecting = detect.status === "loading";
	const autoId = (name) => {
		const slug = slugify(name);
		return seed ? uniqueProviderId(slug || seed.id, takenIds ?? new Set()) : slug;
	};
	const someModelHas = (field) => draft.models.some((model) => String(model[field] ?? "").trim());
	const notSetHint = (field) => (someModelHas(field) ? t("Not set here: the models below use their own.") : null);
	const tickable = layered && draft.models.length > 1;
	const allTicked = tickable && draft.models.every((model) => ticked.has(model.uid));
	// What the notice says is worked out from the models that are still in the form: removing an entry the detection
	// produced takes its part of the summary and the warnings naming it away, and the notice disappears with the last one.
	const outcome = detect.status === "ok" ? detectOutcome(detect.result, draft.models) : null;
	const notice = outcome
		? {
				warn: false,
				message: t("Detected {n}: {added} added, {updated} updated. Save to keep the result.", { n: outcome.total, added: outcome.added, updated: outcome.updated }),
				notes: [
					...(outcome.listError ? [t("The model list could not be read ({reason}); the models were added with default values.", { reason: detectMessage(outcome.listError) })] : []),
					...(outcome.unlisted.length ? [t("Not in the endpoint's model list: {ids}. Check the spelling; they were added with default values.", { ids: outcome.unlisted.join(", ") })] : []),
				],
			}
		: detect.message && detect.status !== "loading"
			? { warn: detect.status === "error", message: detect.message, notes: detect.notes }
			: null;
	return html`<div ref=${rootRef} class="pf stack">
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
		${view === "json"
			? html`<section class="set-card">
				<div class="set-card-head"><strong class="grow">${t("Advanced (JSON)")}</strong><button class="btn sm" onClick=${() => switchView("form")}>${t("Back to the form")}</button></div>
				<div class="set-card-body col">
					<div class="dim pf-hint">${t("The full models.json entry for this provider. Secrets already in the file show as a placeholder and are kept when you leave them unchanged. Keys you type in the form are stored in the credential store, not in this JSON.")}</div>
					<textarea class="field mono" rows="18" spellcheck="false" aria-label=${t("Configuration (JSON)")} value=${json} onInput=${(e) => (setJson(e.target.value), setDirty(true))} />
				</div>
			</section>`
			: html`
			<section class="set-card">
				<div class="set-card-head"><strong>${t("Connection")}</strong></div>
				<div class="set-card-body pf-fields">
					<div class="pf-two">
						<${Field} label=${asKey ? t("Name of this key") : t("Name")}><input class="field" autofocus=${isNew} placeholder=${asKey ? t("e.g. Cheap group") : t("e.g. My Gateway")} value=${draft.name} onInput=${(e) => patch({ name: e.target.value, ...(idTouched ? {} : { id: autoId(e.target.value) }) })} /><//>
						<${Field} label=${asKey ? t("Key ID") : t("Provider ID")} hint=${isNew ? t("Unique lowercase name used in settings.") : t("The ID cannot change after creation.")}><input class="field mono" disabled=${!isNew} placeholder="my-gateway" value=${draft.id} onInput=${(e) => (setIdTouched(true), patch({ id: e.target.value }))} /><//>
					</div>
					<${Field} label=${t("API format")} hint=${upper?.api ? coverHint({ layer: "provider", value: upper.api }, !!draft.api, apiLabel) : layered && !draft.api ? notSetHint("api") : null}><${Select} value=${draft.api} disabled=${!!upper?.api} ariaLabel=${t("API format")} onChange=${(next) => patch({ api: next })} options=${apiOptions(types, layered ? t("Not set here") : null)} /><//>
					<${Field} label=${t("Base URL")} hint=${upper?.baseUrl ? coverHint({ layer: "provider", value: upper.baseUrl }, !!draft.baseUrl.trim()) : draft.baseUrl.trim() ? undefined : notSetHint("baseUrl") ?? t("Not filled in yet. The provider can be saved, but stays off until it has a Base URL.")}><input class="field mono example-placeholder" disabled=${!!upper?.baseUrl} placeholder=${BASE_URL_EXAMPLE} aria-label=${t("Base URL")} value=${draft.baseUrl} onInput=${(e) => patch({ baseUrl: e.target.value })} /><//>
					<${Field} label=${t("Keep-alive time")} hint=${html`${t("An idle connection closes after this time. A longer time saves handshakes; if the server closes first, requests fail, so shorten it when that happens.")}${keepAliveProblem ? html`<span class="pf-problem" role="alert"> ${keepAliveProblem}</span>` : null}`}>
						<${UnitGroup} value=${draft.keepAlive} onInput=${(v) => patch({ keepAlive: v })} unit=${t("seconds")} label=${t("Keep-alive time")} placeholder=${defaults?.keepAliveSeconds === undefined ? "" : String(defaults.keepAliveSeconds)} invalid=${!!keepAliveProblem} inputMode="numeric" />
					<//>
					<${Field} label=${t("IP protocol")} hint=${t("Forces one address type. If the chosen type does not work on this network, requests fail outright; switch back to Auto then.")}>
						<${Select} value=${draft.ipFamily} ariaLabel=${t("IP protocol")} placeholder=${ipFamilyLabel(defaults?.ipFamily ?? "auto", defaults?.ipFamily)} onChange=${(next) => patch({ ipFamily: next })} options=${ipFamilies.map((family) => ({ value: family, label: ipFamilyLabel(family, defaults?.ipFamily) }))} />
					<//>
					<${Field} label=${t("Custom headers")} hint=${html`${t("Only the header name is filled in here, e.g. x-opencode-session. The value is always the current conversation ID; empty turns it off.")}${headerProblem ? html`<span class="pf-problem" role="alert"> ${headerProblem}</span>` : null}`}>
						<input class="field mono" placeholder="x-opencode-session" aria-label=${t("Custom headers")} value=${draft.sessionHeader} onInput=${(e) => patch({ sessionHeader: e.target.value })} />
					<//>
					<div class="col field-label"><span class="field-name">${t("Authentication")}</span>
						<div class="row"><${Segmented} value=${draft.auth} onChange=${(v) => patch({ auth: v })} options=${authOptions} /></div>
					</div>
					<div class=${`col pf-key-area ${upperKey ? "covered" : ""}`}>
						${draft.auth === "key"
							? hasStoredKey && keyArea
								? keyArea
								: html`<${Field} label=${t("API key")} hint=${upperKey ? null : t("Stored on this computer only, never in models.json.")}><input class="field mono" type="password" autocomplete="off" disabled=${!!upperKey} placeholder=${t("Paste the API key")} value=${draft.apiKey} onInput=${(e) => patch({ apiKey: e.target.value })} /><//>`
							: html`<span class="dim pf-hint">${configHasKey ? t("The key is set in models.json (shown hidden). Use the JSON view to change it.") : (hasStoredKey ? t("models.json has no key for this provider yet. Add “apiKey” in the JSON view; until then the saved API key is used.") : t("models.json has no key for this provider yet. Add “apiKey” in the JSON view."))}</span>`}
						${upperKey ? html`<span class="dim pf-hint">${t("Covered by the global API key {suffix}. What is here is kept and applies again once that is removed.", { suffix: upperKey.suffix ? `••••${upperKey.suffix}` : "" })}</span>` : null}
					</div>
				</div>
			</section>
			<section class="set-card">
				<div class="set-card-head"><strong class="grow">${t("Models")} <span class="dim">${draft.models.length}</span></strong>
					<button class="btn sm ghost" onClick=${addManually}><${Icon} name="plus" size=${13} />${t("Add manually")}</button></div>
				<div class="set-card-body col">
					<div class="pf-detect">
						<div class="row pf-detect-bar">
							<input class="field mono grow" placeholder=${t("e.g. gpt-5, deepseek-chat")} aria-label=${t("Model IDs to detect")} value=${idsText} disabled=${detecting} onInput=${(e) => setIdsText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && (e.preventDefault(), runDetect())} />
							<button class="btn" disabled=${detecting || !idsText.trim()} onClick=${runDetect}>${detecting ? html`<${Spinner} />` : html`<${Icon} name="search" size=${13} />`}${detecting ? t("Detecting…") : t("Detect")}</button>
						</div>
						<span class="dim pf-hint">${t("Only the Model IDs typed here are looked up in the endpoint's model list (separate several with commas or spaces); no request is sent to the models themselves. A new ID is added; for an existing model only what the list states is updated. Thinking effort levels, context window and the other values are never tested: tick or enter them yourself.")}</span>
						${notice ? html`<div class=${`notice ${notice.warn ? "warn" : ""}`} role="status">${notice.message}${notice.notes.map((note, i) => html`<div class="dim pf-hint" key=${i}>${note}</div>`)}</div>` : null}
					</div>
					${!draft.models.length ? html`<div class="dim pf-hint">${t("No model yet. Type its Model ID above and detect it, or add it manually.")}</div>` : null}
					${tickable
						? html`<div class="pf-batch">
							<label class="check-label sm"><input type="checkbox" checked=${allTicked} onChange=${(e) => setTicked(new Set(e.target.checked ? draft.models.map((model) => model.uid) : []))} /><span>${ticked.size ? t("{n} selected", { n: ticked.size }) : t("Select all")}</span></label>
							<${Collapse} open=${ticked.size > 0}>
								<div class="pf-batch-fields">
									<${Select} value=${batch.api} disabled=${!!upper?.api} placeholder=${t("Set the format…")} ariaLabel=${t("Format of the selected models")} onChange=${(next) => setBatch((current) => ({ ...current, api: next, note: false }))} options=${apiOptions(types)} />
									<input class="field mono" disabled=${!!upper?.baseUrl} placeholder=${t("Base URL (optional)")} aria-label=${t("Base URL of the selected models")} value=${batch.baseUrl} onInput=${(e) => setBatch((current) => ({ ...current, baseUrl: e.target.value, note: false }))} />
									<button class="btn" disabled=${!batch.api && !(batch.baseUrl.trim() && !baseUrlProblem(batch.baseUrl))} onClick=${applyBatch}>${t("Apply")}</button>
								</div>
								${upper?.api || upper?.baseUrl ? html`<span class="dim pf-hint">${t("The global settings cover this for every model. Clear them there to set it per model.")}</span>` : null}
							<//>
							${batch.note ? html`<span class="dim pf-hint" role="status">${t("What this key set moved down onto its models, so the ones you did not tick keep using it.")}</span>` : null}
						</div>`
						: null}
					${draft.models.map((model) => html`<${ModelCard} key=${model.uid} model=${model} open=${openModels.has(model.uid)} onToggle=${() => toggleOpen(model.uid)} onChange=${(next) => updateModel(model.uid, next)} onRemove=${() => patch({ models: draft.models.filter((m) => m.uid !== model.uid) })} types=${types} layers=${layers} storedKey=${modelKeys?.[model.raw?.id]} sharedKey=${sharedKey} ticked=${ticked.has(model.uid)} onTick=${tickable ? (on) => tick(model.uid, on) : null} />`)}
				</div>
			</section>
			<div class="pf-advanced"><button class="link-btn" onClick=${() => switchView("json")}><${Icon} name="edit" size=${12} /> ${t("Edit as JSON (advanced)")}</button></div>`}
		<div class="pf-foot">
			${footerStart || null}
			<span class="grow" />
			${dirty ? html`<span class="dim pf-hint">${t("Unsaved changes")}</span><button class="btn" disabled=${busy} onClick=${discard}>${t("Discard")}</button>` : null}
			<button class="btn primary" disabled=${busy || (!dirty && !isNew)} onClick=${save}>${busy ? t("Saving…") : isNew ? (asKey ? t("Add key") : t("Add provider")) : t("Save")}</button>
		</div>
	</div>`;
}
