// Settings → Providers: the providers on the left, the chosen one on the right. A provider has three layers: its own
// settings, its keys and their models (providers/models/layers.ts); a value set higher up covers the same value below.
// The right side draws them as a tree: the provider's card on top (name, state, its settings folded into one line), its
// keys one level in, each key's models one level further. One key is open at a time, and one save bar at the bottom
// saves whatever is changed on the provider; deleting, moving and the JSON view sit in each row's ⋯ menu. A key that
// stands alone is the provider itself: its connection fills the provider's card and its models hang below it. Managing
// several API keys of a key is its own sub-view. Opening or switching providers only reads what is saved: no endpoint
// is contacted.
import { html, useEffect, useRef, useState, COLLAPSE_MS, Collapse, Fold, FoldIn, Icon, Menu, MenuItem, MenuSep, Spinner, Toggle } from "./ui.js";
import { Select } from "./select.js";
import { api, attempt, loadModels, loadProviders, loadSettings, post, setView, toast, useStore } from "./store.js";
import { confirmDialog, inputDialog } from "./actions.js";
import { clip } from "./util.js";
import { N_, serverText, t, tNodes } from "./i18n.js";
import { Field, ProviderForm, SaveBar, apiLabel, apiOptions, apiShort, focusField, followIntoView, shortUrl, steadyRow, useUnsaved } from "./provider-form.js";
import { BASE_URL_EXAMPLE, baseUrlProblem, entryHasSharedKey, findRow, isLayeredMember, memberGapCount, memberValues, providerTree, rowName, uniqueProviderId } from "./provider-models.js";
import { nebiusSummary, openServicePage, useNebiusInfo } from "./service-keys.js";
import { ExternalLogin } from "./provider-login.js";

const NEW = "\u0000new";
// The forms of the right side that are not a key: the provider's own settings and the key being added.
const GLOBAL = "\u0000global";
const NEW_KEY = "\u0000new-key";

/** One value a provider from an extension stores itself; the provider checks it, and its message says what is wrong. */
function ProviderSettingField({ providerId, setting, onSaved, onDirty }) {
	const [value, setValue] = useState(setting.value);
	const [busy, setBusy] = useState(false);
	useEffect(() => setValue(setting.value), [setting.value]);
	const dirty = value.trim() !== setting.value;
	useEffect(() => onDirty?.(dirty), [dirty]);
	useEffect(() => () => onDirty?.(false), []);
	const save = async () => {
		if (!dirty || busy) return;
		setBusy(true);
		try {
			const result = await post("/api/providers/setting", { id: providerId, setting: setting.id, value: value.trim() });
			toast(t("Saved"), "info", 3500);
			setValue(result.value);
			await onSaved?.();
		} catch (error) {
			// The provider's own words, in the language it wrote them.
			toast(error.rawMessage || error.message, "error", 9000);
		}
		setBusy(false);
	};
	return html`<${Field} label=${setting.label} hint=${setting.description}>
		<div class="row">
			<input class="field grow" value=${value} placeholder=${setting.placeholder ?? undefined} disabled=${busy} onInput=${(event) => setValue(event.currentTarget.value)} onKeyDown=${(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
			<button class="btn" disabled=${!dirty || busy} onClick=${(event) => { event.preventDefault(); save(); }}>${busy ? t("Saving…") : t("Save")}</button>
		</div>
	<//>`;
}

/** The chats working on a provider right now: deleting it stops them, so the user decides first. */
const confirmStop = (name, running) =>
	confirmDialog({
		title: t("Delete {id} while tasks are running?", { id: name }),
		message: t("“{name}” is being used by tasks that are running right now (listed below). Deleting now stops them immediately, then removes the provider, its models and every API key or login saved for it. This cannot be undone.", { name }),
		detail: running.map((r) => `• ${r.name || clip(r.firstMessage || "", 70) || r.cwd}`).join("\n"),
		confirmLabel: t("Delete now"),
		cancelLabel: t("Don't delete"),
		danger: true,
	});

/** Deletes after the same checks the terminal makes: `ids` are the entries that go, `labels` what the question calls them. */
async function deleteWithChecks({ name, ids, url, body, labels }) {
	const usages = await Promise.all(ids.map((id) => attempt(() => api(`/api/providers/custom/usage?id=${encodeURIComponent(id)}`), { quiet: true })));
	const running = usages.flatMap((usage) => usage?.running || []);
	let stopRunning = false;
	if (running.length) {
		if (!(await confirmStop(name, running))) return false;
		stopRunning = true;
	} else if (!(await confirmDialog({
		title: labels?.title ?? t("Delete provider {id}?", { id: name }),
		message: labels?.message ?? t("“{name}” is removed from models.json, together with its models and every API key or login saved for it on this computer. This cannot be undone.", { name }),
		confirmLabel: labels?.confirm ?? t("Delete provider"),
		danger: true,
	}))) return false;
	let result = await attempt(() => post(url, { ...body, stopRunning }));
	// A task started on the provider after the check: ask again instead of deleting behind its back.
	if (result?.ok === false && result.running?.length) {
		result = (await confirmStop(name, result.running)) ? await attempt(() => post(url, { ...body, stopRunning: true })) : undefined;
	}
	if (!result?.ok) return false;
	toast(labels?.done ?? t("Provider deleted"), "info", 3500);
	await loadProviders();
	await loadModels();
	return true;
}

/** Deletes a provider defined in models.json. Resolves true when deleted. */
export function deleteCustomProvider(id, name, labels) {
	return deleteWithChecks({ name, ids: [id], url: "/api/providers/custom/delete", body: { id }, labels });
}

/**
 * Opened from elsewhere (command panel, model menu) with `setView({ providerEditor: { id } })`: shows the provider in
 * Settings → Providers (`id: null` starts a new one).
 */
export function ProviderEditorHost({ id }) {
	useEffect(() => {
		setView({ providerEditor: null, settingsOpen: true, settingsSection: "providers", providerSel: id ?? NEW });
	}, []);
	return null;
}

const statusOf = (p) => (p.missingBaseUrl ? { cls: "danger", text: t("No Base URL") } : !p.enabled ? { cls: "", text: t("Off") } : p.configured ? { cls: "ok", text: t("Ready") } : { cls: "danger", text: p.externalLogin ? t("Not signed in") : t("No API key") });

/** The status of one key: what its entry reports, or how many of its models lack something on every layer. */
function memberStatus(member, group) {
	const status = statusOf(member.provider);
	const gaps = memberGapCount(member, group);
	return status.cls === "ok" && gaps ? { cls: "danger", text: gaps === 1 ? t("1 model not set up") : t("{n} models not set up", { n: gaps }) } : status;
}

/** One status for a whole provider: red as soon as one of its keys is not set up, green when one is ready. */
function rowStatus(row) {
	const statuses = row.members.map((member) => memberStatus(member, row.group));
	return statuses.find((status) => status.cls === "danger") || statuses.find((status) => status.cls === "ok") || statuses[0];
}

const keyCount = (n) => (n === 1 ? t("1 key") : t("{n} keys", { n }));
const modelCount = (n) => (n === 1 ? t("1 model") : t("{n} models", { n }));
const modelsOf = ({ provider, entry }) => entry?.config?.models?.length ?? provider.modelCount ?? 0;
const totalModels = (row) => row.members.reduce((sum, member) => sum + modelsOf(member), 0);

/** The key in use, with the entry to manage all keys of the provider (the form puts its label beside it). */
function KeySummary({ provider, onManage, busy }) {
	if (provider.externalLogin) return html`<${ExternalLogin} key=${provider.id} provider=${provider} />`;
	const c = provider.credentials;
	const active = c?.apiKeys.find((k) => k.active);
	const oauthActive = c?.active?.type === "oauth";
	const count = c?.apiKeys.length || 0;
	return html`<div class="key-current">
		<${Icon} name="key" size=${14} />
		${active
			? html`<span class="truncate grow"><span>${serverText(active.label)}</span> <span class="dim mono">${active.suffix ? `••••${active.suffix}` : ""}</span></span><span class="badge ok">${t("in use")}</span>`
			: oauthActive
				? html`<span class="grow">${t("OAuth login")}</span><span class="badge ok">${t("in use")}</span>`
				: html`<span class="grow dim">${provider.configured && provider.authSource ? t("Set outside MyHarness ({source})", { source: serverText(provider.authSource) }) : t("No API key saved")}</span>`}
		${provider.supportsApiKeyLogin || count || c?.hasOAuth ? html`<button class="btn sm" disabled=${busy} onClick=${onManage}>${count > 1 ? t("Manage API keys ({n})", { n: count }) : count ? t("Manage API keys") : t("Add API key")}</button>` : null}
	</div>`;
}

/** The ⋯ menu at the end of a row: what is done to the row as a whole (delete, move, the JSON view) lives here, away from Save. */
function RowMenu({ label, items, disabled }) {
	const list = items.filter(Boolean);
	if (!list.some((item) => item !== "-")) return null;
	return html`<${Menu} align="end" class="prov-menu" trigger=${({ toggle, open }) => html`<button type="button" class=${`icon-btn sm prov-more ${open ? "active" : ""}`} title=${t("More")} aria-label=${label} aria-haspopup="menu" aria-expanded=${open} disabled=${disabled} onClick=${toggle}><${Icon} name="more" size=${15} /></button>`}>
		${(close) => list.map((item, index) => (item === "-" ? html`<${MenuSep} key=${`sep-${index}`} />` : html`<${MenuItem} key=${item.label} icon=${item.icon} label=${item.label} danger=${item.danger} disabled=${item.disabled} onClick=${() => { close(); item.onClick(); }} />`))}
	<//>`;
}

/** Every saved API key of the provider: add, name, switch and delete. Deleting here removes one key, never the provider. */
function KeyManager({ provider, onBack }) {
	const [label, setLabel] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	// The active key being deleted while others exist: which one takes over.
	const [replacing, setReplacing] = useState(null);
	// The replacement picked in the row's Select, per key being deleted; unset means the first other key.
	const [repChoice, setRepChoice] = useState({});
	const login = useStore((s) => s.loginEvent);
	const c = provider.credentials;
	const keys = c?.apiKeys || [];
	const act = async (fn, ok) => {
		setBusy(true);
		const result = await attempt(fn, { success: ok });
		setBusy(false);
		await loadProviders();
		return result;
	};
	const remove = async (key, replacementKeyId) => {
		if (!(await confirmDialog({ title: t("Delete this API key?"), message: t("The key “{label}” is removed from this computer. The provider and its models stay.", { label: serverText(key.label) }), confirmLabel: t("Delete API key"), danger: true }))) return;
		setReplacing(null);
		await act(() => post("/api/providers/api-key/delete", { id: provider.id, keyId: key.id, replacementKeyId }), t("API key deleted"));
	};
	const add = async () => {
		const ok = await act(() => post("/api/providers/api-key/add", { id: provider.id, label, key: value }), t("API key saved"));
		if (ok) {
			setValue("");
			setLabel("");
		}
	};
	return html`<div class="stack">
		<div class="row"><button class="btn sm ghost" onClick=${onBack}><${Icon} name="chevronLeft" size=${14} />${provider.name}</button></div>
		<section class="set-card">
			<div class="set-card-head"><div class="col grow"><strong>${t("API keys")}</strong><span class="set-card-desc">${t("The key in use is sent with every request to {name}.", { name: provider.name })}</span></div></div>
			<div class="set-card-body key-list">
				${!keys.length && !c?.hasOAuth ? html`<div class="dim pf-hint">${t("No API key saved yet.")}</div>` : null}
				${keys.map((k) => html`<div class=${`key-row ${k.active ? "active" : ""}`} key=${k.id}>
					<span class=${`dot ${k.active ? "ok" : ""}`} />
					<span class="grow truncate">${serverText(k.label)} <span class="dim mono">${k.suffix ? `••••${k.suffix}` : ""}</span></span>
					${k.active ? html`<span class="badge ok">${t("in use")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/api-key/activate", { id: provider.id, keyId: k.id }))}>${t("Use this key")}</button>`}
					<button class="icon-btn sm" disabled=${busy} title=${t("Rename API key")} aria-label=${t("Rename API key")} onClick=${async () => { const next = await inputDialog({ title: t("Rename API key"), label: t("Name"), initial: k.label }); if (next) act(() => post("/api/providers/api-key/rename", { id: provider.id, keyId: k.id, label: next })); }}><${Icon} name="edit" size=${13} /></button>
					<button class="btn sm ghost danger" disabled=${busy} onClick=${() => (k.active && keys.length > 1 ? setReplacing(k.id) : remove(k))}><${Icon} name="trash" size=${13} />${t("Delete API key")}</button>
				</div>
				${replacing === k.id ? html`<div class="key-replace row">
					<span class="dim">${t("This key is in use. Switch to:")}</span>
					<${Select} id=${`rep-${k.id}`} size="sm" value=${repChoice[k.id] ?? keys.filter((o) => o.id !== k.id)[0]?.id ?? ""} onChange=${(next) => setRepChoice((current) => ({ ...current, [k.id]: next }))} options=${keys.filter((o) => o.id !== k.id).map((o) => ({ value: o.id, label: `${serverText(o.label)}${o.suffix ? ` ••••${o.suffix}` : ""}` }))} />
					<button class="btn sm danger" onClick=${() => remove(k, repChoice[k.id] ?? keys.filter((o) => o.id !== k.id)[0]?.id)}>${t("Delete API key")}</button>
					<button class="btn sm ghost" onClick=${() => setReplacing(null)}>${t("Cancel")}</button>
				</div>` : null}`)}
				${c?.hasOAuth ? html`<div class=${`key-row ${c.active?.type === "oauth" ? "active" : ""}`}><span class=${`dot ${c.active?.type === "oauth" ? "ok" : ""}`} /><span class="grow">${t("OAuth login")}</span>${c.active?.type === "oauth" ? html`<span class="badge ok">${t("in use")}</span>` : html`<button class="btn sm" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/activate", { id: provider.id }))}>${t("Use this login")}</button>`}</div>` : null}
			</div>
		</section>
		${provider.supportsApiKeyLogin
			? html`<section class="set-card">
				<div class="set-card-head"><strong>${t("Add API key")}</strong></div>
				<div class="set-card-body col">
					<div class="key-add stacked">
						<input class="field" placeholder=${t("Name (optional)")} aria-label=${t("Key name")} value=${label} onInput=${(e) => setLabel(e.target.value)} />
						<input class="field mono" type="password" autocomplete="off" placeholder=${t("Paste the API key")} aria-label=${t("API key")} value=${value} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && value.trim() && add()} />
						<button class="btn primary" disabled=${busy || !value.trim()} onClick=${add}>${t("Save key")}</button>
					</div>
					<span class="dim pf-hint">${t("Stored on this computer only. The first key is used right away; switch to a later one with “Use this key”.")}</span>
				</div>
			</section>`
			: null}
		${provider.supportsOAuth
			? html`<div class="row"><button class="btn" disabled=${busy} onClick=${() => act(() => post("/api/providers/oauth/login", { id: provider.id }), t("Signed in"))}>${busy && login ? t("Waiting for sign-in…") : t("Sign in with OAuth")}</button></div>`
			: null}
	</div>`;
}

function LoginNotice() {
	const login = useStore((s) => s.loginEvent);
	if (!login) return null;
	if (login.type === "device_code") return html`<div class="notice">${tNodes("Open {url} and enter the code {code}.", { url: html`<a href=${login.verificationUri} target="_blank" rel="noopener noreferrer" data-link-system>${login.verificationUri}</a>`, code: html`<strong class="mono">${login.userCode}</strong>` })}</div>`;
	if (login.type === "auth_url") return html`<div class="notice">${t("Waiting for the browser sign-in…")} <a href=${login.url} target="_blank" rel="noopener noreferrer" data-link-system>${t("Open the sign-in page")}</a>${login.instructions ? html` — ${login.instructions}` : null}</div>`;
	if (login.type === "info") return html`<div class="notice">${login.message}</div>`;
	return null;
}

/** What a key uses from the top down, for the one line of its folded row: format, address and the end of its API key. */
function keyUses(member, group) {
	const config = member.entry?.config ?? {};
	return {
		api: group?.config?.api || config.api || "",
		url: group?.config?.baseUrl || config.baseUrl || "",
		suffix: group?.key?.suffix || member.provider.credentials?.apiKeys?.find((key) => key.active)?.suffix || "",
	};
}

/** The end of the API key a key's requests use, for the "In effect" line of its models. */
const activeSuffix = (provider) => provider.credentials?.apiKeys?.find((key) => key.active)?.suffix || "";

/** The parts of a summary line, with a quiet dot between them. */
const joined = (parts) => parts.filter(Boolean).flatMap((part, index) => (index ? [html`<span class="prov-sep" aria-hidden="true">·</span>`, part] : [part]));

/**
 * The provider's own settings, one foldable line of its card: what is filled in here applies to every key and model
 * below; a field left empty lets them decide for themselves. Folded, the line says what is set (or that each key
 * decides). A provider that so far stands alone becomes a group when this is first saved. The page's save bar saves it
 * through `ctl`; it has no buttons of its own.
 */
function GlobalSettings({ row, apiTypes, open, onToggle, onSaved, onDirty, ctl, onState, onReveal }) {
	const group = row.group;
	const fromRow = () => ({ name: group?.config?.name ?? "", baseUrl: group?.config?.baseUrl ?? "", api: group?.config?.api ?? "", apiKey: "", removeKey: false });
	const [draft, setDraft] = useState(fromRow);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const nameRef = useRef(null);
	// "Rename" on a folded line: the name field takes the keyboard once the fold has drawn it.
	const wantsName = useRef(false);
	const [nameAsks, setNameAsks] = useState(0);
	const changed = useUnsaved(draft, dirty);
	useEffect(() => onDirty?.(changed), [changed]);
	useEffect(() => onState?.({ dirty: changed, busy }), [changed, busy]);
	useEffect(() => () => {
		onDirty?.(false);
		onState?.({ dirty: false, busy: false });
	}, []);
	useEffect(() => {
		const input = nameRef.current;
		if (!wantsName.current || !input) return;
		wantsName.current = false;
		focusField(input, { scroll: true });
	}, [nameAsks, open]);
	const patch = (next) => {
		setDraft((current) => ({ ...current, ...next }));
		setDirty(true);
		setError("");
	};
	const fail = (message) => {
		setError(message);
		onReveal?.();
	};
	const save = async () => {
		const url = draft.baseUrl.trim();
		if (url && baseUrlProblem(url)) {
			fail(t("The Base URL must be a full http:// or https:// address."));
			return false;
		}
		setBusy(true);
		let saved = false;
		try {
			await post("/api/providers/group/save", { ...(group ? { id: group.id } : { memberId: row.members[0].provider.id }), name: draft.name, baseUrl: url, api: draft.api, apiKey: draft.apiKey, removeApiKey: draft.removeKey });
			saved = true;
			setDirty(false);
			setDraft((current) => ({ ...current, baseUrl: url, apiKey: "", removeKey: false }));
			await onSaved();
		} catch (failure) {
			if (!saved) fail(serverText(failure.message, t("The operation failed.")));
		}
		setBusy(false);
		return saved;
	};
	const discard = () => {
		setDraft(fromRow());
		setDirty(false);
		setError("");
	};
	if (ctl) ctl.current = { save, discard, focusName: () => ((wantsName.current = true), setNameAsks((n) => n + 1)) };
	const urls = memberValues(row.members, "baseUrl");
	const apis = memberValues(row.members, "api");
	const decide = t("Each key decides");
	const chip = (label, value, mono) => html`<span class="prov-chip"><span>${label}</span><b class=${mono ? "mono" : ""}>${value ?? decide}</b></span>`;
	return html`<div class=${`prov-group prov-global ${open ? "open" : ""}`}>
		<button type="button" class="prov-row prov-group-row" aria-expanded=${open} onClick=${onToggle}>
			<${Fold} />
			<span class="prov-group-label">${t("Provider settings")}</span>
			${changed ? html`<span class="dot accent prov-dirty" title=${t("Unsaved changes")} />` : null}
			<span class="prov-group-sum">
				<span class="prov-group-chips" aria-hidden=${open ? "true" : undefined}>
					${chip(t("API format"), group?.config?.api ? apiShort(group.config.api) : null)}
					${chip(t("Base URL"), group?.config?.baseUrl ? shortUrl(group.config.baseUrl) : null, !!group?.config?.baseUrl)}
					${chip(t("API key"), group?.key ? (group.key.suffix ? `••••${group.key.suffix}` : t("API key set")) : null, !!group?.key?.suffix)}
				</span>
				<span class="dim truncate prov-group-hint" aria-hidden=${open ? undefined : "true"}>${t("Filled in here, it applies to every key and model below; left empty, each key decides.")}</span>
			</span>
		</button>
		<${Collapse} open=${open}>
			<div class="prov-group-body">
				${error ? html`<div class="notice danger pf-error" role="alert">${error}</div>` : null}
				<div class="pf-two">
					<${Field} label=${t("Provider name")}><input ref=${nameRef} class="field" placeholder=${rowName(row)} value=${draft.name} onInput=${(e) => patch({ name: e.target.value })} /><//>
					<${Field} label=${t("API format")} hint=${changed && draft.api && apis.differ ? t("Your keys use different formats now. Saved like this, they all use {value}.", { value: apiLabel(draft.api) }) : null}><${Select} value=${draft.api} ariaLabel=${t("API format")} onChange=${(next) => patch({ api: next })} options=${apiOptions(apiTypes, t("Not set here"))} /><//>
				</div>
				<${Field} label=${t("Base URL")} hint=${changed && draft.baseUrl.trim() && urls.differ ? t("Your keys use different addresses now ({values}). Saved like this, they all use this one. A service that needs a different address per format (with /v1 and without) should leave this empty.", { values: urls.values.join(", ") }) : null}><input class="field mono example-placeholder" placeholder=${BASE_URL_EXAMPLE} aria-label=${t("Base URL")} value=${draft.baseUrl} onInput=${(e) => patch({ baseUrl: e.target.value })} /><//>
				<div class="col field-label"><span class="field-name">${t("API key")}</span>
					${group?.key && !draft.removeKey
						? html`<div class="key-current"><${Icon} name="key" size=${14} /><span class="grow dim mono">${group.key.suffix ? `••••${group.key.suffix}` : ""}</span><button type="button" class="btn sm ghost" onClick=${() => patch({ removeKey: true })}>${t("Remove")}</button></div>`
						: html`<input class="field mono" type="password" autocomplete="off" placeholder=${t("Leave empty when each key has its own")} aria-label=${t("API key")} value=${draft.apiKey} onInput=${(e) => patch({ apiKey: e.target.value })} />`}
				</div>
			</div>
		<//>
	</div>`;
}

/**
 * One key of a provider: a row of the tree (name, what it uses, its models, its state, ⋯) that opens into its form. The
 * form stays mounted once opened, so folding keeps what was typed; the row then shows a dot until it is saved.
 */
function KeyNode({ member, row, upper, open, onToggle, several, busy, dirty, apiTypes, defaults, onManage, onSaved, onDirty, ctl, onState, onReveal, initialView, onEnabled, menu }) {
	const { provider, entry } = member;
	const mounted = useRef(open);
	if (open) mounted.current = true;
	const status = memberStatus(member, row.group);
	const hasStoredKey = !!provider.credentials?.apiKeys?.length;
	const name = entry.config.name || provider.id;
	const uses = keyUses(member, row.group);
	return html`<div class=${`prov-node prov-key ${open ? "open" : ""}`} data-key=${provider.id}>
		<div class="prov-row prov-key-head">
			<button type="button" class="prov-row-toggle prov-key-toggle grow" aria-expanded=${open} onClick=${onToggle}>
				<${Fold} />
				<${Icon} name="key" size=${14} class="prov-ico" />
				<span class="truncate prov-key-name">${name}</span>
				<span class="dim truncate prov-key-sum">${joined([uses.api && apiShort(uses.api), uses.url && html`<span class="mono">${shortUrl(uses.url)}</span>`, uses.suffix && html`<span class="mono">••••${uses.suffix}</span>`])}</span>
				${dirty ? html`<span class="dot accent prov-dirty" title=${t("Unsaved changes")} />` : null}
				<span class="dim prov-key-count">${modelCount(modelsOf(member))}</span>
				<span class=${`badge ${status.cls}`}>${status.text}</span>
			</button>
			${several ? html`<${Toggle} checked=${provider.enabled} label=${t("Enable {name}", { name })} disabled=${busy || provider.missingBaseUrl} onChange=${(enabled) => onEnabled([member], enabled)} />` : null}
			${menu}
		</div>
		<${Collapse} open=${open} keepMounted=${mounted.current}>
			${mounted.current
				? html`<div class="prov-key-body">
					<${ProviderForm} key=${provider.id} asKey upper=${upper} modelKeys=${entry.modelKeys} configured=${entryHasSharedKey(provider)} initial=${{ id: entry.id, config: entry.config }} apiTypes=${apiTypes} defaults=${defaults} keyArea=${html`<${KeySummary} provider=${provider} busy=${busy} onManage=${onManage} />`} hasStoredKey=${hasStoredKey} keySuffix=${upper?.key ? upper.key.suffix : activeSuffix(provider)} onSaved=${onSaved} onDirty=${onDirty} ctl=${ctl} onState=${onState} onReveal=${onReveal} initialView=${initialView} />
				</div>`
				: null}
		<//>
	</div>`;
}

function ProviderDetail({ row, rows, focus, takenIds, apiTypes, defaults, onSaved, onDirty, onDeleted, onShow, onMerged, confirmDiscard, reload }) {
	const members = row.members;
	const first = members[0];
	const provider = first.provider;
	const entry = first.entry;
	const managed = members.every(isLayeredMember);
	const several = members.length > 1;
	// A key that stands alone is the provider itself: no key level, its connection in the provider's card.
	const single = managed && !row.group && members.length === 1;
	const [managing, setManaging] = useState(null);
	const [busy, setBusy] = useState("");
	const [adding, setAdding] = useState(false);
	// Every new key gets a fresh form.
	const [addCount, setAddCount] = useState(0);
	const [globalOpen, setGlobalOpen] = useState(false);
	const [merging, setMerging] = useState(false);
	// The key whose form opens straight in the JSON view (its ⋯ menu, before the form was ever drawn).
	const [jsonFor, setJsonFor] = useState(null);
	// What each form of the right side reports: unsaved changes, a save on its way. One bar acts on all of them.
	const [states, setStates] = useState({});
	const [saving, setSaving] = useState(false);
	const [nudge, setNudge] = useState(0);
	const ctls = useRef({});
	const ctlOf = (id) => (ctls.current[id] ??= { current: null });
	const stateOf = (id) => (next) => setStates((current) => (current[id]?.dirty === next.dirty && current[id]?.busy === next.busy ? current : { ...current, [id]: next }));
	const rootRef = useRef(null);
	// Every key starts folded; only one asked for by name opens. Asking for a row, even of one key, is not that.
	const isAskedFor = (id) => !!id && id !== row.id && members.some((member) => member.provider.id === id);
	const [openKey, setOpenKey] = useState(() => (isAskedFor(focus) ? focus : null));
	useEffect(() => {
		if (isAskedFor(focus)) setOpenKey(focus);
	}, [focus]);
	const dirtyIds = Object.keys(states).filter((id) => id !== NEW_KEY && states[id].dirty);
	const anyBusy = saving || Object.values(states).some((state) => state.busy);
	/** Something the unsaved changes block: say so, and shake the bar so the eye finds it. */
	const blocked = (message) => {
		toast(message, "warning", 4500);
		setNudge((n) => n + 1);
	};
	const toggleKey = (id, event) => {
		const rowEl = event?.currentTarget?.closest(".prov-row");
		if (openKey === id) return setOpenKey(null);
		if (adding) {
			if (states[NEW_KEY]?.dirty) return blocked(t("Add or cancel the new key first."));
			setAdding(false);
		}
		setOpenKey(id);
		if (rowEl) steadyRow(rowEl);
	};
	const startAdding = () => {
		if (dirtyIds.length) return blocked(t("Save or discard the changes first, then add a key."));
		setOpenKey(null);
		setAddCount((n) => n + 1);
		setAdding(true);
	};
	// The new key unfolds where it is added and comes into view while the others fold; its name already has the keyboard.
	useEffect(() => {
		if (!adding) return;
		ctlOf(NEW_KEY).current?.focusName?.({ scroll: false });
		const node = rootRef.current?.querySelector(".prov-new");
		if (node) followIntoView(node, COLLAPSE_MS + 220);
	}, [adding, addCount]);
	const editJson = (id) => {
		const control = ctlOf(id).current;
		if (control) control.editJson();
		else setJsonFor(id);
		if (openKey !== id) {
			if (adding && states[NEW_KEY]?.dirty) return blocked(t("Add or cancel the new key first."));
			setAdding(false);
			setOpenKey(id);
		}
	};
	const setEnabled = async (targets, enabled) => {
		setBusy("enabled");
		// A key without an address cannot be switched on; the others still can.
		for (const target of targets) if (!enabled || !target.provider.missingBaseUrl) await attempt(() => post("/api/providers/enabled", { id: target.provider.id, enabled }));
		setBusy("");
		await loadProviders();
		loadModels();
	};
	const removeRow = async () => {
		setBusy("delete");
		const deleted = row.group && several
			? await deleteWithChecks({ name: rowName(row), ids: members.map((member) => member.provider.id), url: "/api/providers/group/delete", body: { id: row.group.id } })
			: await deleteCustomProvider(provider.id, provider.name);
		setBusy("");
		if (deleted) onDeleted();
	};
	const removeKey = async (member) => {
		if (!several) return removeRow();
		const name = member.entry.config.name || member.provider.id;
		onShow(row.id);
		setBusy("delete");
		const deleted = await deleteCustomProvider(member.provider.id, name, {
			title: t("Delete key {name}?", { name }),
			message: t("“{name}” is removed from this provider, together with its models and every API key saved for it on this computer. This cannot be undone.", { name }),
			confirm: t("Delete this key"),
			done: t("Key deleted"),
		});
		setBusy("");
		if (deleted) await reload();
	};
	const leave = async (member) => {
		setBusy("leave");
		const done = await attempt(() => post("/api/providers/group/leave", { id: member.provider.id }), { success: t("It stands on its own now and keeps using what it used.") });
		setBusy("");
		if (done) await reload();
	};
	const mergeTargets = rows.filter((other) => other.id !== row.id && other.members.every(isLayeredMember));
	const mergeInto = async (targetId) => {
		const target = rows.find((other) => other.id === targetId);
		if (!target) return;
		const covering = target.group ? [target.group.config?.baseUrl && t("Base URL"), target.group.config?.api && t("API format"), target.group.key && t("API key")].filter(Boolean) : [];
		if (!(await confirmDialog({
			title: t("Merge {name} into {target}?", { name: rowName(row), target: rowName(target) }),
			message: covering.length
				? t("{target} has provider settings for: {fields}. They will cover what these keys use now. Clear them there if these keys should keep their own. A backup of models.json is kept first.", { target: rowName(target), fields: covering.join(", ") })
				: t("Each key keeps its name, its models and what it uses now. A backup of models.json is kept first."),
			confirmLabel: t("Merge"),
		}))) return;
		if (!(await confirmDiscard())) return;
		setBusy("merge");
		const ids = members.map((member) => member.provider.id);
		const result = await attempt(() => post("/api/providers/group/merge", target.group ? { ids, groupId: target.group.id } : { ids: [target.members[0].provider.id, ...ids], name: rowName(target) }));
		setBusy("");
		if (result?.ok) await onMerged(result.id);
	};
	const newKeySeed = () => {
		const urls = memberValues(members, "baseUrl").values;
		const formats = memberValues(members, "api").values;
		return {
			id: uniqueProviderId(row.group?.id ?? provider.id, takenIds),
			baseUrl: !row.group?.config?.baseUrl && urls.length === 1 ? urls[0] : "",
			api: !row.group?.config?.api && formats.length === 1 ? formats[0] : "",
		};
	};
	// The forms of the tree, top down: the order the bar saves them in.
	const formIds = [GLOBAL, ...members.map((member) => member.provider.id)];
	const nameOf = (id) => (id === GLOBAL ? t("Provider settings") : (members.find((member) => member.provider.id === id)?.entry?.config?.name || rowName(row)));
	const saveAll = async () => {
		if (anyBusy) return;
		setSaving(true);
		for (const id of [...formIds.filter((id) => states[id]?.dirty), ...(adding ? [NEW_KEY] : [])]) {
			// A refused save names its problem in its own form; the rest waits for the next click.
			if (!(await ctlOf(id).current?.save?.())) break;
		}
		setSaving(false);
	};
	const discardAll = () => {
		for (const id of dirtyIds) ctlOf(id).current?.discard?.();
		setAdding(false);
	};
	/** A form whose save was refused unfolds, so the notice at its top can be read. */
	const reveal = (id) => () => {
		if (id === GLOBAL) setGlobalOpen(true);
		else if (id !== NEW_KEY && openKey !== id) setOpenKey(id);
	};
	/** A key's save stays where it is: the page does not jump to the key just saved. */
	const keepSaved = (id, info) => onSaved(id, { ...info, keep: true });
	const rename = () => {
		if (single || !managed) return ctlOf(provider.id).current?.focusName?.();
		setGlobalOpen(true);
		ctlOf(GLOBAL).current?.focusName?.();
	};
	const managedMember = managing ? members.find((member) => member.provider.id === managing) : null;
	const status = rowStatus(row);
	const anyEnabled = members.some((member) => member.provider.enabled);
	const noneCanRun = members.every((member) => member.provider.missingBaseUrl);
	const upper = row.group ? { ...row.group.config, key: row.group.key } : null;
	const keyArea = html`<${KeySummary} provider=${provider} busy=${!!busy} onManage=${() => setManaging(provider.id)} />`;
	const hasStoredKey = !!provider.credentials?.apiKeys?.length || provider.credentials?.active?.type === "oauth";
	const name = rowName(row);
	const inModelsJson = !!entry;
	const menuLabel = t("More actions for {name}", { name });
	const head = html`<div class="prov-head prov-root-head">
		<div class="col grow">
			<div class="prov-title truncate">${name}</div>
			<div class="dim truncate prov-root-sub">${row.group ? `${keyCount(members.length)} · ${modelCount(totalModels(row))}` : html`<span class="mono">${provider.id}</span>${inModelsJson ? ` · ${modelCount(modelsOf(first))}` : ""}`}</div>
		</div>
		<span class=${`badge ${status.cls}`}>${status.text}</span>
		<label class="check-label sm" title=${noneCanRun ? t("Fill in the Base URL and save to turn this provider on.") : undefined}><span class="dim">${t("Enabled")}</span><${Toggle} checked=${anyEnabled} label=${t("Enable {name}", { name })} disabled=${!!busy || noneCanRun} onChange=${(enabled) => setEnabled(members, enabled)} /></label>
		${inModelsJson
			? html`<${RowMenu} label=${menuLabel} disabled=${!!busy} items=${[
				{ icon: "edit", label: t("Rename"), onClick: rename },
				(single || !managed) && { icon: "wrench", label: t("Edit as JSON (advanced)"), onClick: () => ctlOf(provider.id).current?.editJson?.() },
				managed && mergeTargets.length && { icon: "gitMerge", label: t("Merge into another provider…"), onClick: () => setMerging(true) },
				"-",
				{ icon: "trash", label: t("Delete provider"), danger: true, onClick: removeRow },
			]} />`
			: null}
	</div>`;
	const mergeRow = html`<${FoldIn} content=${merging && mergeTargets.length
		? html`<div class="row prov-merge">
			<${Icon} name="gitMerge" size=${14} class="prov-ico" />
			<span class="dim">${t("Merge into")}</span>
			<${Select} size="sm" value="" disabled=${!!busy} placeholder=${t("Merge into another provider…")} ariaLabel=${t("Merge into another provider")} onChange=${(target) => (setMerging(false), mergeInto(target))} options=${mergeTargets.map((other) => ({ value: other.id, label: rowName(other) }))} />
			<span class="grow" />
			<button type="button" class="btn sm ghost" onClick=${() => setMerging(false)}>${t("Cancel")}</button>
		</div>`
		: null} />`;
	const addRow = html`<div class="prov-node prov-add-node">
		<div class="prov-add-row">
			<button type="button" class="btn sm ghost prov-add-key" disabled=${adding || !!busy} onClick=${startAdding}><${Icon} name="plus" size=${13} />${t("Add key")}</button>
			${single ? html`<span class="dim pf-hint">${t("With a second key, this splits into provider settings and keys.")}</span>` : null}
		</div>
	</div>`;
	const newKey = html`<${FoldIn} class="prov-node prov-new" content=${adding
		? html`<div class="prov-row prov-key-head prov-new-head">
				<${Icon} name="chevronDown" size=${13} class="prov-new-chev" />
				<${Icon} name="key" size=${14} class="prov-ico" />
				<span class="truncate prov-key-name">${t("New key")}</span>
				<span class="dim truncate prov-key-sum">${t("Not added yet")}</span>
			</div>
			<div class="prov-key-body">
				<${ProviderForm} key=${`new-key-${addCount}`} asKey initial=${null} seed=${newKeySeed()} attachTo=${provider.id} takenIds=${takenIds} upper=${upper} apiTypes=${apiTypes} defaults=${defaults} onDirty=${(d) => onDirty("new-key", d)} ctl=${ctlOf(NEW_KEY)} onState=${stateOf(NEW_KEY)}
					onSaved=${(id, info) => {
						setAdding(false);
						setOpenKey(id);
						return onSaved(id, info);
					}} />
			</div>`
		: null} />`;
	const shown = adding || dirtyIds.length > 0;
	const places = dirtyIds.length + (adding ? 1 : 0);
	const bar = html`<div class="prov-tree-end" />
		<${SaveBar} show=${shown} nudge=${nudge} busy=${anyBusy}
			message=${places > 1 ? t("{n} places have unsaved changes", { n: places }) : adding ? t("The new key is not added yet") : t("{name} has unsaved changes", { name: nameOf(dirtyIds[0]) })}
			cancelLabel=${dirtyIds.length ? t("Discard") : t("Cancel")} onCancel=${discardAll}
			saveLabel=${adding && !dirtyIds.length ? t("Add key") : t("Save")} onSave=${saveAll} />`;
	const formProps = (id) => ({ ctl: ctlOf(id), onState: stateOf(id), onReveal: reveal(id), onDirty: (d) => onDirty(id, d) });
	let body;
	if (single || (inModelsJson && !managed)) {
		// One key, or an entry outside the layers: the provider's card holds the connection, its models hang below it.
		// The bar shares a gapless column with the form, so its coming and going never moves what is above it.
		body = html`<div class="prov-tree"><${ProviderForm} key=${provider.id} head=${html`${head}${mergeRow}`} tail=${single ? html`${newKey}${addRow}` : null} initial=${{ id: entry.id, config: entry.config }} upper=${null} modelKeys=${entry.modelKeys} configured=${entryHasSharedKey(provider)} apiTypes=${apiTypes} defaults=${defaults} keyArea=${keyArea} hasStoredKey=${hasStoredKey} keySuffix=${activeSuffix(provider)} onSaved=${keepSaved} ...${formProps(provider.id)} />${bar}</div>`;
	} else if (managed) {
		body = html`<div class="prov-tree">
				<section class="prov-root">
					${head}
					${mergeRow}
					<div class="prov-root-body">
						<${GlobalSettings} row=${row} apiTypes=${apiTypes} open=${globalOpen} onToggle=${() => setGlobalOpen(!globalOpen)} onSaved=${reload} ...${formProps(GLOBAL)} />
					</div>
				</section>
				<div class="prov-branch prov-keys">
					${members.map((member) => {
						const id = member.provider.id;
						return html`<${KeyNode} key=${id} member=${member} row=${row} upper=${upper} open=${openKey === id} onToggle=${(event) => toggleKey(id, event)} several=${several} busy=${!!busy} dirty=${!!states[id]?.dirty} apiTypes=${apiTypes} defaults=${defaults} onManage=${() => setManaging(id)} onSaved=${keepSaved} initialView=${jsonFor === id ? "json" : undefined} onEnabled=${setEnabled} ...${formProps(id)}
							menu=${html`<${RowMenu} label=${t("More actions for {name}", { name: member.entry.config.name || id })} disabled=${!!busy} items=${[
								{ icon: "key", label: t("Manage API keys"), onClick: () => setManaging(id) },
								{ icon: "wrench", label: t("Edit as JSON (advanced)"), onClick: () => editJson(id) },
								several && { icon: "fork", label: t("Move out of this provider"), onClick: () => leave(member) },
								"-",
								{ icon: "trash", label: several ? t("Delete this key") : t("Delete provider"), danger: true, onClick: () => removeKey(member) },
							]} />`} />`;
					})}
					${newKey}
					${addRow}
				</div>
				${bar}
			</div>`;
	} else {
		// A provider from an extension: shown as it is; its address and models are managed there.
		body = html`<div class="prov-tree">
			<section class="prov-root">
				${head}
				<div class="prov-root-body">
					<div class="pf-conn"><div class="pf-fields">
						${provider.baseUrl ? html`<div class="col field-label pf-row"><span class="field-name">${t("Base URL")}</span><span class="mono pf-value">${provider.baseUrl}</span></div>` : null}
						<div class="col field-label pf-row"><span class="field-name">${provider.externalLogin ? t("Sign-in status") : t("API key")}</span>${keyArea}</div>
						<div class="col field-label pf-row"><span class="field-name">${t("Models")}</span><span class="pf-value">${t("{modelCount} models", { modelCount: provider.modelCount })}</span></div>
						<span class="dim pf-hint">${t("This provider is not defined in models.json (it comes from an extension), so its address and models are managed there.")}</span>
					</div></div>
				</div>
			</section>
			${provider.settings?.length
				? html`<section class="set-card prov-ext-settings">
					<div class="set-card-head"><strong>${t("Provider settings")}</strong></div>
					<div class="set-card-body pf-fields">
						${provider.settings.map((setting) => html`<${ProviderSettingField} key=${setting.id} providerId=${provider.id} setting=${setting} onSaved=${reload} onDirty=${(d) => onDirty(`setting:${setting.id}`, d)} />`)}
					</div>
				</section>`
				: null}
		</div>`;
	}
	return html`<div ref=${rootRef} class="stack prov-fill">
		${managedMember ? html`<${KeyManager} provider=${managedMember.provider} onBack=${() => setManaging(null)} />` : null}
		<div class="stack prov-fill" style=${managedMember ? "display:none" : undefined}>
			${!several && provider.missingBaseUrl ? html`<div class="notice danger" role="status">${t("The Base URL is not filled in, so this provider is off. Enter the Base URL and save to use it.")}</div>` : null}
			<${LoginNotice} />
			${body}
		</div>
	</div>`;
}

const MERGE_DISMISSED = "myharness.providerMergeDismissed";
const readDismissed = () => {
	try {
		return new Set(JSON.parse(localStorage.getItem(MERGE_DISMISSED) || "[]"));
	} catch {
		return new Set();
	}
};
const writeDismissed = (keys) => {
	try {
		localStorage.setItem(MERGE_DISMISSED, JSON.stringify([...keys]));
	} catch {}
};

/**
 * Entries that look like one service, offered as one provider. Nothing happens until the user merges: the same address is
 * ticked from the start, what only looks related is left for the user to tick, and every member keeps what it uses.
 */
function MergeSuggestion({ suggestion, groupName, onMerge, onDismiss }) {
	const [ticked, setTicked] = useState(() => new Set(suggestion.members.filter((member) => member.sure).map((member) => member.id)));
	const [name, setName] = useState(suggestion.name);
	const [busy, setBusy] = useState(false);
	const joining = !!suggestion.groupId;
	const tick = (id, on) =>
		setTicked((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	const merge = async () => {
		setBusy(true);
		await onMerge({ ids: suggestion.members.filter((member) => ticked.has(member.id)).map((member) => member.id), ...(joining ? { groupId: suggestion.groupId } : { name: name.trim() }) });
		setBusy(false);
	};
	return html`<div class="prov-suggest-item">
		${joining ? html`<div class="field-name">${t("These look like part of {name}", { name: groupName })}</div>` : null}
		${suggestion.members.map((member) => html`<label class="check-label prov-suggest-row" key=${member.id}><input type="checkbox" checked=${ticked.has(member.id)} onChange=${(e) => tick(member.id, e.target.checked)} /><span class="truncate prov-suggest-name">${member.name}</span><span class="dim mono truncate">${member.host}</span>${member.sure ? null : html`<span class="badge">${t("may be the same")}</span>`}</label>`)}
		<div class="row prov-suggest-foot">
			${joining ? html`<span class="grow" />` : html`<input class="field grow" placeholder=${t("Provider name")} aria-label=${t("Provider name")} value=${name} onInput=${(e) => setName(e.target.value)} />`}
			<button class="btn" disabled=${busy} onClick=${onDismiss}>${t("Not now")}</button>
			<button class="btn primary" disabled=${busy || ticked.size < (joining ? 1 : 2) || (!joining && !name.trim())} onClick=${merge}>${busy ? t("Merging…") : t("Merge")}</button>
		</div>
	</div>`;
}

/** One quiet line at the top of the page that opens into the suggestions: not acting on it changes nothing. */
function MergeSuggestions({ suggestions, groups, onMerge, onDismiss }) {
	const [open, setOpen] = useState(false);
	if (!suggestions.length) return null;
	return html`<section class="set-card collapsible prov-suggest">
		<div class="set-card-head">
			<button type="button" class="set-card-toggle grow" aria-expanded=${open} onClick=${() => setOpen(!open)}>
				<${Fold} />
				<strong>${suggestions.length === 1 ? t("1 group looks like one service") : t("{n} groups look like one service", { n: suggestions.length })}</strong>
			</button>
			<span class="dim pf-hint">${t("Merging is up to you")}</span>
		</div>
		<${Collapse} open=${open}>
			<div class="set-card-body prov-suggest-body">
				<div class="set-card-desc">${t("Nothing changes until you merge. Each becomes a key of one provider and keeps its name, its models and what it uses now. A backup of models.json is kept first.")}</div>
				${suggestions.map((suggestion) => html`<${MergeSuggestion} key=${suggestion.key} suggestion=${suggestion} groupName=${groups?.find((group) => group.id === suggestion.groupId)?.config?.name ?? suggestion.groupId} onMerge=${onMerge} onDismiss=${() => onDismiss(suggestion.key)} />`)}
			</div>
		<//>
	</section>`;
}

const NEBIUS = "nebius";

/** Which model does which job once a Token Factory key is saved (NEBIUS_ROLE_PLAN on the server). */
const NEBIUS_PLAN = [
	{ model: "DeepSeek V4.1 Flash", jobs: N_("Main model, commit descriptions") },
	{ model: "Nemotron 3 Ultra", jobs: N_("Sub-agents, conversation naming, translation") },
	{ model: "Nemotron 3.5 Lightning", jobs: N_("Compaction, fallback, Auto Memory, hand-off notes, bookmark notes, scheduled tasks, worktree naming, branch summaries") },
	{ model: "Nemotron 3.5 Super VL", jobs: N_("Vision assistant (reads images)") },
];

function NebiusPlan() {
	return html`<section class="set-card">
		<div class="set-card-head"><div class="col grow"><strong>${t("Who does what")}</strong><span class="set-card-desc">${t("Only jobs you have not set get a model; a job with its own model keeps it. Without DeepSeek on the account, Ultra takes its jobs.")}</span></div></div>
		<div class="set-card-body nebius-plan">
			${NEBIUS_PLAN.map((row) => html`<div class="nebius-plan-row" key=${row.model}><span class="nebius-plan-model">${row.model}</span><span class="dim">${t(row.jobs)}</span></div>`)}
		</div>
	</section>`;
}

/** What a setup did, under the button that ran it. */
function NebiusResult({ result }) {
	if (!result) return null;
	return html`<div class="notice ok" role="status">${nebiusSummary(result)}${result.turnedOn?.length ? ` ${t("Turned on: {jobs}.", { jobs: result.turnedOn.map((job) => t(NEBIUS_JOB_NAMES[job] || job)).join(", ") })}` : ""}${result.listError ? html`<div class="dim">${t("The model list could not be read, so only the checked models were added: {error}", { error: result.listError })}</div>` : null}</div>`;
}

const NEBIUS_JOB_NAMES = { visionAssistant: N_("Vision assistant"), subAgent: N_("Sub-agents"), fallbackModel: N_("Fallback model"), conversationNaming: N_("Conversation naming") };

const runNebiusSetup = async (apiKey) => {
	const result = await post("/api/providers/nebius/setup", apiKey ? { apiKey } : {});
	if (!result?.ok) throw new Error(serverText(result?.message, t("The key could not be saved.")));
	await Promise.all([loadProviders(), loadSettings()]);
	loadModels();
	return result;
};

/** Nebius before it is set up: get a key, paste it, and every job gets its model. */
function NebiusSetup({ onDone }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const save = async () => {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError("");
		try {
			const result = await runNebiusSetup(value.trim());
			toast(nebiusSummary(result), "info", 5000);
			setValue("");
			onDone(result);
		} catch (failure) {
			setError(failure.message);
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="stack">
		<div class="prov-head"><div class="col grow"><div class="prov-title truncate">Nebius Token Factory <span class="badge">${t("Built in")}</span></div><div class="dim">${t("DeepSeek V4.1 Flash and NVIDIA Nemotron models, served by Nebius Token Factory. Paste one API key and every job gets its model.")}</div></div></div>
		<section class="set-card">
			<div class="set-card-head"><strong>${t("API key")}</strong></div>
			<div class="set-card-body col">
				<div class="row nebius-get"><button class="btn" onClick=${() => openServicePage(NEBIUS)}><${Icon} name="externalLink" size=${13} />${t("Get an API key")}</button><span class="dim">${t("Opens Token Factory: sign in, create a key, and paste it here or in the strip above the page.")}</span></div>
				<form class="key-add stacked" onSubmit=${(event) => { event.preventDefault(); void save(); }}>
					<input class="field mono" type="password" autocomplete="off" spellcheck=${false} placeholder=${t("Paste the API key")} aria-label=${t("{name} API key", { name: "Nebius Token Factory" })} value=${value} onInput=${(e) => setValue(e.target.value)} />
					<button class="btn primary" type="submit" disabled=${busy || !value.trim()}>${busy ? html`<${Spinner} size=${12} />` : null}${t("Save and set up")}</button>
				</form>
				${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
				<span class="dim pf-hint">${t("The key is checked against your account's model list first (a free request) and stored on this computer only.")}</span>
			</div>
		</section>
		<${NebiusPlan} />
	</div>`;
}

/** Nebius once it is set up: the console (balance, top-up, keys) and this computer's estimate. */
function NebiusExtras({ info }) {
	const spend = info?.spend;
	const amount = spend ? `${spend.currency === "CNY" ? "¥" : "$"}${spend.total.toFixed(spend.total < 1 ? 4 : 2)}` : "";
	return html`<section class="set-card nebius-card">
		<div class="set-card-head"><div class="col grow"><strong>${t("Balance and spending")}</strong><span class="set-card-desc">${t("Token Factory has no balance API: the balance and Top up are in its console. This computer estimates what it spent from the model prices.")}</span></div></div>
		<div class="set-card-body col">
			<div class="nebius-spend" role="status">${spend ? t("Estimated on this computer: {amount} since {date} ({count} requests). The Token Factory bill is what counts.", { amount, date: new Date(spend.since).toLocaleDateString(), count: spend.requests }) : t("Nothing spent from this computer yet.")}</div>
			<div class="row nebius-links">
				<button class="btn sm" onClick=${() => openServicePage(NEBIUS, info?.consoleUrl, { keyStrip: false })}><${Icon} name="externalLink" size=${13} />${t("Balance and top up")}</button>
				<button class="btn sm" onClick=${() => openServicePage(NEBIUS)}><${Icon} name="key" size=${13} />${t("Get an API key")}</button>
			</div>
		</div>
	</section>`;
}

export function ProvidersPage() {
	const providers = useStore((s) => s.providers);
	const request = useStore((s) => s.view.providerSel);
	const [custom, setCustom] = useState(null);
	const [sel, setSel] = useState(request || null);
	const [nebiusNonce, setNebiusNonce] = useState(0);
	const [nebiusResult, setNebiusResult] = useState(null);
	const [dismissed, setDismissed] = useState(readDismissed);
	// Starts the right side afresh after a merge: the keys it shows are not the ones it was showing.
	const [detailVersion, setDetailVersion] = useState(0);
	const nebiusInfo = useNebiusInfo(nebiusNonce);
	// Which forms hold unsaved changes: the right side can show several at once.
	const dirty = useRef(new Set());
	const markDirty = (form, value) => {
		if (value) dirty.current.add(form);
		else dirty.current.delete(form);
	};
	const loadCustom = () =>
		api("/api/providers/custom")
			.then(setCustom)
			.catch((error) => toast(error.message, "error"));
	useEffect(() => {
		loadProviders();
		loadCustom();
	}, []);
	// A provider asked for from elsewhere (command panel, "Add provider").
	useEffect(() => {
		if (!request) return;
		setSel(request);
		setView({ providerSel: null });
	}, [request]);
	// Nebius is always offered, first: before it is set up the list shows it anyway, and an empty list opens on it.
	const listed = providers?.providers || [];
	const nebiusListed = listed.some((p) => p.id === NEBIUS);
	const list = nebiusListed ? [...listed.filter((p) => p.id === NEBIUS), ...listed.filter((p) => p.id !== NEBIUS)] : listed;
	const nebiusSetup = !nebiusListed && (sel === NEBIUS || (!sel && !list.length));
	const rows = providerTree(list, custom);
	const current = sel === NEW || nebiusSetup ? null : findRow(rows, sel) || rows[0];
	const confirmDiscard = async () => {
		if (dirty.current.size && !(await confirmDialog({ title: t("Discard unsaved changes?"), message: t("The changes to this provider have not been saved."), confirmLabel: t("Discard"), danger: true }))) return false;
		dirty.current.clear();
		return true;
	};
	const choose = async (id) => {
		if (id === (current?.id ?? (sel === NEW ? NEW : nebiusSetup ? NEBIUS : null))) return;
		if (!(await confirmDiscard())) return;
		setSel(id);
	};
	const reload = async () => {
		await Promise.all([loadProviders(), loadCustom()]);
		loadModels();
	};
	// `keep`: a key saved in place; the page stays on what it shows instead of asking for the key just saved.
	const saved = async (id, { missingBaseUrl, keep } = {}) => {
		if (missingBaseUrl) toast(t("Saved. The Base URL is not filled in, so the provider is off."), "warning", 6000);
		else toast(t("Provider saved"), "info", 2500);
		const before = sel;
		await reload();
		// Another provider chosen while this was saving stays chosen.
		if (!keep) setSel((current) => (current === before ? id : current));
	};
	const merged = async (groupId) => {
		toast(t("Merged. The file as it was is kept as models.json.before-merge.bak."), "info", 6000);
		await reload();
		setDetailVersion((version) => version + 1);
		setSel(`group:${groupId}`);
	};
	const mergeSuggested = async (body) => {
		if (!(await confirmDiscard())) return;
		const result = await attempt(() => post("/api/providers/group/merge", body));
		if (result?.ok) await merged(result.id);
	};
	const dismiss = (key) => {
		const next = new Set(dismissed).add(key);
		writeDismissed(next);
		setDismissed(next);
	};
	const suggestions = (custom?.mergeSuggestions || []).filter((suggestion) => !dismissed.has(suggestion.key));
	const takenIds = new Set([...(custom?.providers || []).map((entry) => entry.id), ...list.map((p) => p.id)]);
	return html`<div class="stack prov-page">
		<${MergeSuggestions} suggestions=${suggestions} groups=${custom?.groups} onMerge=${mergeSuggested} onDismiss=${dismiss} />
		<div class="prov">
		<div class="prov-list" role="listbox" aria-label=${t("Providers")}>
			${!providers || !custom ? html`<div class="empty"><${Spinner} /></div>` : null}
			${providers && custom && !nebiusListed
				? html`<button key=${NEBIUS} role="option" aria-selected=${nebiusSetup} class=${`prov-item prov-builtin ${nebiusSetup ? "on" : ""}`} onClick=${() => choose(NEBIUS)}>
					<span class="dot warn" title=${t("No API key")} />
					<span class="col grow"><span class="truncate">Nebius Token Factory</span><span class="dim truncate prov-item-sub">${t("Built in · NVIDIA Nemotron")}</span></span>
				</button>`
				: null}
			${custom
				? rows.map((row) => {
					const status = rowStatus(row);
					const on = current?.id === row.id && sel !== NEW;
					const only = row.members[0].provider.id;
					return html`<button key=${row.id} role="option" aria-selected=${on} class=${`prov-item ${only === NEBIUS ? "prov-builtin" : ""} ${on ? "on" : ""}`} onClick=${() => choose(row.id)}>
						<span class=${`dot ${status.cls}`} title=${status.text} />
						<span class="col grow"><span class="truncate">${rowName(row)}</span><span class=${`dim truncate prov-item-sub ${row.group ? "" : "mono"}`}>${only === NEBIUS ? t("Built in · NVIDIA Nemotron") : row.group ? `${keyCount(row.members.length)} · ${modelCount(totalModels(row))}` : only}</span></span>
					</button>`;
				})
				: null}
			<button class=${`prov-item prov-add ${sel === NEW ? "on" : ""}`} onClick=${() => choose(NEW)}><${Icon} name="plus" size=${14} /><span>${t("Add provider")}</span></button>
		</div>
		<div class="prov-detail stack">
			${providers?.error ? html`<div class="notice danger">${t("models.json: {error}", { error: providers.error })}</div>` : null}
			${!providers || !custom
				? html`<${Spinner} />`
				: nebiusSetup
					? html`<${NebiusSetup} onDone=${(result) => { setNebiusResult(result); setNebiusNonce((n) => n + 1); loadCustom(); setSel(NEBIUS); }} />`
				: sel === NEW || !current
					? html`<div class="stack prov-fill">
						<${ProviderForm} key="new" initial=${null} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${(d) => markDirty(NEW, d)}
							head=${html`<div class="prov-head prov-root-head"><div class="col grow"><div class="prov-title">${t("Add provider")}</div><div class="dim prov-root-sub">${t("Any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")}</div></div></div>`} />
					</div>`
					: html`${current.id === NEBIUS ? html`<${NebiusResult} result=${nebiusResult} /><${NebiusExtras} info=${nebiusInfo} />` : null}<${ProviderDetail} key=${`${current.members[0].provider.id}:${detailVersion}`} row=${current} rows=${rows} focus=${sel} takenIds=${takenIds} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${markDirty} onShow=${setSel} onMerged=${merged} confirmDiscard=${confirmDiscard} reload=${reload} onDeleted=${() => (loadCustom(), setNebiusResult(null), setNebiusNonce((n) => n + 1), setSel(null))} />`}
		</div>
		</div>
	</div>`;
}
