// Settings → Providers: the providers on the left, the chosen one on the right. A provider has three layers: its global
// settings, its keys and their models (providers/models/layers.ts); a value set higher up covers the same value below.
// Each key is edited in one place (connection, current API key, models); managing several API keys of a key is its own
// sub-view, and deleting sits apart at the bottom. Opening or switching providers only reads what is saved: no endpoint
// is contacted.
import { html, useEffect, useRef, useState, Collapse, Fold, Icon, Spinner, Toggle } from "./ui.js";
import { Select } from "./select.js";
import { api, attempt, loadModels, loadProviders, loadSettings, post, setView, toast, useStore } from "./store.js";
import { confirmDialog, inputDialog } from "./actions.js";
import { clip } from "./util.js";
import { N_, serverText, t, tNodes } from "./i18n.js";
import { Field, ProviderForm, apiLabel, apiOptions } from "./provider-form.js";
import { BASE_URL_EXAMPLE, baseUrlProblem, entryHasSharedKey, findRow, isLayeredMember, memberGapCount, memberValues, providerTree, rowName, uniqueProviderId } from "./provider-models.js";
import { nebiusSummary, openServicePage, useNebiusInfo } from "./service-keys.js";

const NEW = "\u0000new";

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

const statusOf = (p) => (p.missingBaseUrl ? { cls: "danger", text: t("No Base URL") } : !p.enabled ? { cls: "", text: t("Off") } : p.configured ? { cls: "ok", text: t("Ready") } : { cls: "danger", text: t("No API key") });

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

/** The key in use, with the entry to manage all keys of the provider. */
function KeySummary({ provider, onManage, busy }) {
	const c = provider.credentials;
	const active = c?.apiKeys.find((k) => k.active);
	const oauthActive = c?.active?.type === "oauth";
	const count = c?.apiKeys.length || 0;
	return html`<div class="col field-label"><span class="field-name">${t("API key")}</span>
		<div class="key-current">
			<${Icon} name="key" size=${14} />
			${active
				? html`<span class="truncate grow"><span>${serverText(active.label)}</span> <span class="dim mono">${active.suffix ? `••••${active.suffix}` : ""}</span></span><span class="badge ok">${t("in use")}</span>`
				: oauthActive
					? html`<span class="grow">${t("OAuth login")}</span><span class="badge ok">${t("in use")}</span>`
					: html`<span class="grow dim">${provider.configured && provider.authSource ? t("Set outside MyHarness ({source})", { source: serverText(provider.authSource) }) : t("No API key saved")}</span>`}
			${provider.supportsApiKeyLogin || count || c?.hasOAuth ? html`<button class="btn sm" disabled=${busy} onClick=${onManage}>${count > 1 ? t("Manage API keys ({n})", { n: count }) : count ? t("Manage API keys") : t("Add API key")}</button>` : null}
		</div>
	</div>`;
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

/**
 * The top layer of a provider. What is filled in here applies to every key and model below it; a field left empty lets
 * them decide for themselves. A provider that so far stands alone becomes a group when this is first saved.
 */
function GlobalSettings({ row, apiTypes, onSaved, onDirty }) {
	const group = row.group;
	const fromRow = () => ({ name: group?.config?.name ?? "", baseUrl: group?.config?.baseUrl ?? "", api: group?.config?.api ?? "", apiKey: "", removeKey: false });
	const [draft, setDraft] = useState(fromRow);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [open, setOpen] = useState(false);
	useEffect(() => onDirty?.(dirty), [dirty]);
	useEffect(() => () => onDirty?.(false), []);
	const patch = (next) => {
		setDraft((current) => ({ ...current, ...next }));
		setDirty(true);
		setError("");
	};
	const save = async () => {
		const url = draft.baseUrl.trim();
		if (url && baseUrlProblem(url)) return setError(t("The Base URL must be a full http:// or https:// address."));
		setBusy(true);
		try {
			await post("/api/providers/group/save", { ...(group ? { id: group.id } : { memberId: row.members[0].provider.id }), name: draft.name, baseUrl: url, api: draft.api, apiKey: draft.apiKey, removeApiKey: draft.removeKey });
			setDirty(false);
			toast(t("Provider saved"), "info", 2500);
			await onSaved();
			setDraft((current) => ({ ...current, baseUrl: url, apiKey: "", removeKey: false }));
		} catch (failure) {
			setError(serverText(failure.message, t("The operation failed.")));
		}
		setBusy(false);
	};
	const discard = () => {
		setDraft(fromRow());
		setDirty(false);
		setError("");
	};
	const urls = memberValues(row.members, "baseUrl");
	const apis = memberValues(row.members, "api");
	return html`<section class="set-card collapsible prov-global">
		<div class="set-card-head"><button type="button" class="set-card-toggle grow" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Fold} /><strong>${t("Global settings")}</strong></button></div>
		<${Collapse} open=${open}>
		<div class="set-card-body pf-fields prov-global-body">
			<span class="set-card-desc">${t("What you fill in here applies to every key and model below. Leave a field empty and the layers below decide for themselves.")}</span>
			${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
			<div class="pf-two">
				<${Field} label=${t("Provider name")}><input class="field" placeholder=${rowName(row)} value=${draft.name} onInput=${(e) => patch({ name: e.target.value })} /><//>
				<${Field} label=${t("API format")} hint=${dirty && draft.api && apis.differ ? t("Your keys use different formats now. Saved like this, they all use {value}.", { value: apiLabel(draft.api) }) : null}><${Select} value=${draft.api} ariaLabel=${t("API format")} onChange=${(next) => patch({ api: next })} options=${apiOptions(apiTypes, t("Not set here"))} /><//>
			</div>
			<${Field} label=${t("Base URL")} hint=${dirty && draft.baseUrl.trim() && urls.differ ? t("Your keys use different addresses now ({values}). Saved like this, they all use this one. A service that needs a different address per format (with /v1 and without) should leave this empty.", { values: urls.values.join(", ") }) : null}><input class="field mono example-placeholder" placeholder=${BASE_URL_EXAMPLE} aria-label=${t("Base URL")} value=${draft.baseUrl} onInput=${(e) => patch({ baseUrl: e.target.value })} /><//>
			<div class="col field-label"><span class="field-name">${t("API key")}</span>
				${group?.key && !draft.removeKey
					? html`<div class="key-current"><${Icon} name="key" size=${14} /><span class="grow dim mono">${group.key.suffix ? `••••${group.key.suffix}` : ""}</span><button class="btn sm ghost" onClick=${() => patch({ removeKey: true })}>${t("Remove")}</button></div>`
					: html`<input class="field mono" type="password" autocomplete="off" placeholder=${t("Leave empty when each key has its own")} aria-label=${t("Global API key")} value=${draft.apiKey} onInput=${(e) => patch({ apiKey: e.target.value })} />`}
			</div>
			${dirty
				? html`<div class="row prov-global-foot"><span class="grow dim pf-hint">${t("Unsaved changes")}</span><button class="btn" disabled=${busy} onClick=${discard}>${t("Discard")}</button><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? t("Saving…") : t("Save")}</button></div>`
				: null}
		</div>
		<//>
	</section>`;
}

/** One key of a provider: a summary row that opens into its form. The form stays mounted once opened, so a fold keeps what was typed. */
function KeyCard({ member, row, upper, open, onToggle, several, busy, apiTypes, defaults, onManage, onSaved, onDirty, onEnabled, onLeave, onDelete }) {
	const { provider, entry } = member;
	const mounted = useRef(open);
	if (open) mounted.current = true;
	// The sticky footer of the form needs the fold to stop clipping once it has finished opening.
	const [settled, setSettled] = useState(open);
	useEffect(() => {
		if (!open) return setSettled(false);
		const timer = setTimeout(() => setSettled(true), 320);
		return () => clearTimeout(timer);
	}, [open]);
	const status = memberStatus(member, row.group);
	const hasStoredKey = !!provider.credentials?.apiKeys?.length;
	const name = entry.config.name || provider.id;
	return html`<section class=${`prov-key ${settled ? "settled" : ""}`} data-key=${provider.id}>
		<div class="prov-key-head">
			<button type="button" class="prov-key-toggle grow" aria-expanded=${open} onClick=${onToggle}>
				<${Fold} />
				<span class="truncate prov-key-name">${name}</span>
			</button>
			<span class="dim prov-key-count">${modelCount(modelsOf(member))}</span>
			<span class=${`badge ${status.cls}`}>${status.text}</span>
			${several ? html`<${Toggle} checked=${provider.enabled} label=${t("Enable {name}", { name })} disabled=${busy || provider.missingBaseUrl} onChange=${(enabled) => onEnabled([member], enabled)} />` : null}
			${several ? html`<button class="icon-btn sm" disabled=${busy} title=${t("Move out of this provider")} aria-label=${t("Move {name} out of this provider", { name })} onClick=${onLeave}><${Icon} name="fork" size=${13} /></button>` : null}
		</div>
		<${Collapse} open=${open} keepMounted=${mounted.current}>
			${mounted.current
				? html`<div class="prov-key-body">
					<${ProviderForm} key=${provider.id} asKey upper=${upper} modelKeys=${entry.modelKeys} configured=${entryHasSharedKey(provider)} initial=${{ id: entry.id, config: entry.config }} apiTypes=${apiTypes} defaults=${defaults} keyArea=${html`<${KeySummary} provider=${provider} busy=${busy} onManage=${onManage} />`} hasStoredKey=${hasStoredKey} onSaved=${onSaved} onDirty=${onDirty}
						footerStart=${html`<button class="btn danger" disabled=${busy} onClick=${onDelete}><${Icon} name="trash" size=${13} />${several ? t("Delete this key") : t("Delete provider")}</button>`} />
				</div>`
				: null}
		<//>
	</section>`;
}

function ProviderDetail({ row, rows, focus, takenIds, apiTypes, defaults, onSaved, onDirty, onDeleted, onShow, onMerged, confirmDiscard, reload }) {
	const members = row.members;
	const first = members[0];
	const provider = first.provider;
	const entry = first.entry;
	const managed = members.every(isLayeredMember);
	const several = members.length > 1;
	const [managing, setManaging] = useState(null);
	const [busy, setBusy] = useState("");
	const [adding, setAdding] = useState(false);
	// Every key starts folded; only one asked for by name opens. Asking for a row, even of one key, is not that.
	const isAskedFor = (id) => !!id && id !== row.id && members.some((member) => member.provider.id === id);
	const [opened, setOpened] = useState(() => new Set(isAskedFor(focus) ? [focus] : []));
	useEffect(() => {
		if (isAskedFor(focus)) setOpened((current) => (current.has(focus) ? current : new Set(current).add(focus)));
	}, [focus]);
	const toggle = (id) =>
		setOpened((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
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
				? t("{target} has global settings for: {fields}. They will cover what these keys use now. Clear them there if these keys should keep their own. A backup of models.json is kept first.", { target: rowName(target), fields: covering.join(", ") })
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
	const managedMember = managing ? members.find((member) => member.provider.id === managing) : null;
	const status = rowStatus(row);
	const anyEnabled = members.some((member) => member.provider.enabled);
	const noneCanRun = members.every((member) => member.provider.missingBaseUrl);
	const upper = row.group ? { ...row.group.config, key: row.group.key } : null;
	const keyArea = html`<${KeySummary} provider=${provider} busy=${!!busy} onManage=${() => setManaging(provider.id)} />`;
	const hasStoredKey = !!provider.credentials?.apiKeys?.length || provider.credentials?.active?.type === "oauth";
	return html`<div class="stack">
		${managedMember ? html`<${KeyManager} provider=${managedMember.provider} onBack=${() => setManaging(null)} />` : null}
		<div class="stack" style=${managedMember ? "display:none" : undefined}>
			<div class="prov-head">
				<div class="col grow"><div class="prov-title truncate">${rowName(row)}</div><div class=${`dim truncate ${row.group ? "" : "mono"}`}>${row.group ? `${keyCount(members.length)} · ${modelCount(totalModels(row))}` : provider.id}</div></div>
				<span class=${`badge ${status.cls}`}>${status.text}</span>
				<label class="check-label sm" title=${noneCanRun ? t("Fill in the Base URL and save to turn this provider on.") : undefined}><span class="dim">${t("Enabled")}</span><${Toggle} checked=${anyEnabled} label=${t("Enable {name}", { name: rowName(row) })} disabled=${!!busy || noneCanRun} onChange=${(enabled) => setEnabled(members, enabled)} /></label>
			</div>
			${!several && provider.missingBaseUrl ? html`<div class="notice danger" role="status">${t("The Base URL is not filled in, so this provider is off. Enter the Base URL and save to use it.")}</div>` : null}
			<${LoginNotice} />
			${managed
				? html`<${GlobalSettings} row=${row} apiTypes=${apiTypes} onSaved=${reload} onDirty=${(d) => onDirty("global", d)} />
					<div class="prov-keys stack">
						<div class="row prov-keys-head"><strong class="grow">${t("Keys")} <span class="dim">${members.length}</span></strong><button class="btn sm ghost" disabled=${adding} onClick=${() => setAdding(true)}><${Icon} name="plus" size=${13} />${t("Add key")}</button></div>
						${members.map((member) => html`<${KeyCard} key=${member.provider.id} member=${member} row=${row} upper=${upper} open=${opened.has(member.provider.id)} onToggle=${() => toggle(member.provider.id)} several=${several} busy=${!!busy} apiTypes=${apiTypes} defaults=${defaults} onManage=${() => setManaging(member.provider.id)} onSaved=${onSaved} onDirty=${(d) => onDirty(member.provider.id, d)} onEnabled=${setEnabled} onLeave=${() => leave(member)} onDelete=${() => removeKey(member)} />`)}
						${adding
							? html`<section class="prov-key settled prov-key-new">
								<div class="prov-key-head"><strong class="grow">${t("New key")}</strong></div>
								<div class="prov-key-body">
									<${ProviderForm} key="new-key" asKey initial=${null} seed=${newKeySeed()} attachTo=${provider.id} takenIds=${takenIds} upper=${upper} apiTypes=${apiTypes} defaults=${defaults} onDirty=${(d) => onDirty("new-key", d)}
										onSaved=${(id, info) => { setAdding(false); setOpened((current) => new Set(current).add(id)); return onSaved(id, info); }}
										footerStart=${html`<button class="btn" onClick=${() => setAdding(false)}>${t("Cancel")}</button>`} />
								</div>
							</section>`
							: null}
					</div>
					<div class="row prov-actions">
						${mergeTargets.length ? html`<${Select} size="sm" value="" disabled=${!!busy} placeholder=${t("Merge into another provider…")} ariaLabel=${t("Merge into another provider")} onChange=${mergeInto} options=${mergeTargets.map((other) => ({ value: other.id, label: rowName(other) }))} />` : null}
						<span class="grow" />
						${row.group && several ? html`<button class="btn danger" disabled=${!!busy} onClick=${removeRow}><${Icon} name="trash" size=${13} />${busy === "delete" ? t("Deleting…") : t("Delete provider")}</button>` : null}
					</div>`
				: entry
					? html`<${ProviderForm} key=${provider.id} initial=${{ id: entry.id, config: entry.config }} apiTypes=${apiTypes} defaults=${defaults} keyArea=${keyArea} hasStoredKey=${hasStoredKey} onSaved=${onSaved} onDirty=${(d) => onDirty(provider.id, d)}
						footerStart=${html`<button class="btn danger" disabled=${!!busy} onClick=${removeRow}><${Icon} name="trash" size=${13} />${busy === "delete" ? t("Deleting…") : t("Delete provider")}</button>`} />`
					: html`<section class="set-card">
						<div class="set-card-head"><strong>${t("Connection")}</strong></div>
						<div class="set-card-body pf-fields">
							${provider.baseUrl ? html`<div class="col field-label"><span class="field-name">${t("Base URL")}</span><span class="mono">${provider.baseUrl}</span></div>` : null}
							${keyArea}
							<div class="col field-label"><span class="field-name">${t("Models")}</span><span>${t("{modelCount} models", { modelCount: provider.modelCount })}</span></div>
							<span class="dim pf-hint">${t("This provider is not defined in models.json (it comes from an extension), so its address and models are managed there.")}</span>
						</div>
					</section>
					${provider.settings?.length
						? html`<section class="set-card">
							<div class="set-card-head"><strong>${t("Provider settings")}</strong></div>
							<div class="set-card-body pf-fields">
								${provider.settings.map((setting) => html`<${ProviderSettingField} key=${setting.id} providerId=${provider.id} setting=${setting} onSaved=${reload} onDirty=${(d) => onDirty(`setting:${setting.id}`, d)} />`)}
							</div>
						</section>`
						: null}`}
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
	const saved = async (id, { missingBaseUrl } = {}) => {
		if (missingBaseUrl) toast(t("Saved. The Base URL is not filled in, so the provider is off."), "warning", 6000);
		else toast(t("Provider saved"), "info", 2500);
		const before = sel;
		await reload();
		// Another provider chosen while this was saving stays chosen.
		setSel((current) => (current === before ? id : current));
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
	return html`<div class="stack">
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
					? html`<div class="stack">
						<div class="prov-head"><div class="col grow"><div class="prov-title">${t("Add provider")}</div><div class="dim">${t("Any OpenAI-, Anthropic-, Gemini- or Mistral-compatible endpoint.")}</div></div></div>
						<${ProviderForm} key="new" initial=${null} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${(d) => markDirty(NEW, d)} />
					</div>`
					: html`${current.id === NEBIUS ? html`<${NebiusResult} result=${nebiusResult} /><${NebiusExtras} info=${nebiusInfo} />` : null}<${ProviderDetail} key=${`${current.members[0].provider.id}:${detailVersion}`} row=${current} rows=${rows} focus=${sel} takenIds=${takenIds} apiTypes=${custom.apiTypes} defaults=${custom.connectionDefaults} onSaved=${saved} onDirty=${markDirty} onShow=${setSel} onMerged=${merged} confirmDiscard=${confirmDiscard} reload=${reload} onDeleted=${() => (loadCustom(), setNebiusResult(null), setNebiusNonce((n) => n + 1), setSel(null))} />`}
		</div>
		</div>
	</div>`;
}
