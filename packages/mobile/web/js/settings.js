// Settings: the Google account, model providers of the phone's own agent, the PC connection, appearance, and the
// app's data.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useState } from "/shared/ui.js";
import { fmtBytes } from "/shared/util.js";
import { API_KINDS, PROVIDER_PRESETS, fetchModelIds, getProviders, local, providerKey, removeProvider, saveProvider } from "./backend-local.js";
import { account } from "./account.js";
import { pc } from "./backend-remote.js";
import { setMode } from "./backends.js";
import { SEARCH_ENGINES, clearBrowsingData } from "./browser-model.js";
import { storageEstimate } from "./db.js";
import { AccountPcs, routeLabel } from "./drawer.js";
import { Icon } from "./micons.js";
import { canScan, haptic, nativeInfo, onNative, scanQr, secretGet, secretSet } from "./native.js";
import { prefs, setPrefs } from "./prefs.js";
import { Page, Row, Sheet, Switch, actionSheet, confirmSheet, openPage, openSheet, pickSheet, promptSheet } from "./sheets.js";
import { attempt, toast, useStore } from "./store.js";

function usePrefs() {
	const [, force] = useState(0);
	return (patch) => {
		setPrefs(patch);
		force((n) => n + 1);
	};
}

function Section({ title, note, children }) {
	return html`<div>
		${title && html`<div class="rows-title">${title}</div>`}
		<div class="rows">${children}</div>
		${note && html`<div class="rows-note">${note}</div>`}
	</div>`;
}

// ---- Providers and models ----------------------------------------------------------------------
function ModelPickSheet({ close, found, existing, onAdd }) {
	const [picked, setPicked] = useState(() => new Set());
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const rows = found.filter((entry) => !existing.has(entry.id) && (!needle || `${entry.id} ${entry.name}`.toLowerCase().includes(needle)));
	const toggle = (id) => {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setPicked(next);
	};
	return html`<${Sheet}
		title=${t("Models of this provider")}
		sub=${String(found.length)}
		close=${close}
		footer=${html`<button class="btn" onClick=${close}>${t("Cancel")}</button>
			<button class="btn primary" disabled=${picked.size === 0} onClick=${() => (onAdd(found.filter((entry) => picked.has(entry.id))), close())}>${t("Add {n}", { n: picked.size })}</button>`}
	>
		<input class="field sheet-search" style="width:calc(100% - 8px)" placeholder=${t("Search models")} value=${query} onInput=${(event) => setQuery(event.target.value)} />
		${rows.length === 0 && html`<div class="empty-state">${found.length ? t("Every model is already added, or none matches.") : t("The provider listed no models.")}</div>`}
		<div class="rows">${rows.slice(0, 300).map((entry) => html`<${Row} key=${entry.id} title=${entry.id} sub=${entry.name && entry.name !== entry.id ? entry.name : ""} check=${picked.has(entry.id)} on=${picked.has(entry.id)} onClick=${() => toggle(entry.id)} />`)}</div>
	<//>`;
}

function ModelEditSheet({ close, model, onSave }) {
	const [draft, setDraft] = useState({ ...model });
	const set = (patch) => setDraft({ ...draft, ...patch });
	return html`<${Sheet} title=${model.id} close=${close} footer=${html`<button class="btn" onClick=${close}>${t("Cancel")}</button><button class="btn primary" onClick=${() => (onSave(draft), close())}>${t("Done")}</button>`}>
		<div class="form">
			<div class="form-field"><label>${t("Name shown in the app")}</label><input class="field" value=${draft.name || ""} placeholder=${model.id} onInput=${(event) => set({ name: event.target.value })} /></div>
			<div class="rows">
				<${Row} title=${t("Can reason (thinking)")} sub=${t("Shows the effort choice next to the model.")}><${Switch} on=${!!draft.reasoning} onChange=${(on) => set({ reasoning: on })} label=${t("Can reason (thinking)")} /><//>
				<${Row} title=${t("Reads pictures")} sub=${t("Lets you attach photos and screenshots.")}><${Switch} on=${!!draft.vision} onChange=${(on) => set({ vision: on })} label=${t("Reads pictures")} /><//>
			</div>
			<div class="field-row">
				<div class="form-field" style="flex:1"><label>${t("Context window (tokens)")}</label><input class="field" type="number" inputmode="numeric" value=${draft.contextWindow || ""} placeholder="128000" onInput=${(event) => set({ contextWindow: Number(event.target.value) || undefined })} /></div>
				<div class="form-field" style="flex:1"><label>${t("Longest reply (tokens)")}</label><input class="field" type="number" inputmode="numeric" value=${draft.maxTokens || ""} placeholder="8192" onInput=${(event) => set({ maxTokens: Number(event.target.value) || undefined })} /></div>
			</div>
		</div>
	<//>`;
}

function ProviderPage({ close, provider }) {
	const isNew = !provider.id;
	const [draft, setDraft] = useState(() => ({ ...provider, models: [...(provider.models || [])] }));
	const [key, setKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [busy, setBusy] = useState("");
	const hasKey = !isNew && !!providerKey(provider.id);
	const set = (patch) => setDraft({ ...draft, ...patch });
	const kind = API_KINDS.find((entry) => entry.value === draft.api) || API_KINDS[0];

	const pickKind = async () => {
		const value = await pickSheet({ title: t("API type"), value: draft.api, options: API_KINDS.map((entry) => ({ value: entry.value, label: entry.label, sub: entry.hint })) });
		if (value) set({ api: value });
	};

	const fetchModels = async () => {
		setBusy("fetch");
		try {
			const found = await fetchModelIds(draft, key || (hasKey ? providerKey(provider.id) : ""));
			const existing = new Set(draft.models.map((model) => model.id));
			openSheet(
				(closeSheet) => html`<${ModelPickSheet}
					close=${closeSheet}
					found=${found}
					existing=${existing}
					onAdd=${(added) => setDraft((before) => ({ ...before, models: [...before.models, ...added.map((entry) => ({ id: entry.id, name: entry.name || "", reasoning: false, vision: false, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens }))] }))}
				/>`,
			);
		} catch (error) {
			toast(t("The model list could not be read: {reason}", { reason: error.message }), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const addManually = async () => {
		const id = await promptSheet({ title: t("Add a model"), label: t("Model ID, exactly as the provider names it"), placeholder: "model-id", confirmLabel: t("Add"), validate: (value) => (!value.trim() ? t("Enter a model ID.") : draft.models.some((model) => model.id === value.trim()) ? t("This model is already in the list.") : "") });
		if (id) setDraft((before) => ({ ...before, models: [...before.models, { id: id.trim(), name: "", reasoning: false, vision: false }] }));
	};

	const patchModel = (id, patch) => setDraft((before) => ({ ...before, models: before.models.map((model) => (model.id === id ? { ...model, ...patch } : model)) }));

	const save = async () => {
		if (!draft.name?.trim()) return toast(t("Give the provider a name."), "warning");
		if (!/^https?:\/\//i.test(draft.baseUrl || "")) return toast(t("Enter the provider's address (it starts with https://)."), "warning");
		setBusy("save");
		const saved = await attempt(() => saveProvider(draft, key ? key.trim() : undefined));
		setBusy("");
		if (saved) {
			haptic("confirm");
			toast(t("Saved"), "ok", 1400);
			close();
		}
	};

	const remove = async () => {
		const message = provider.synced
			? t("“{name}” came from your PCs. It is removed from this phone and from every PC of your Google account, with its key and its models.", { name: provider.name })
			: t("“{name}”, its key and its models are removed from this phone.", { name: provider.name });
		if (!(await confirmSheet({ title: t("Remove this provider?"), message, confirmLabel: t("Remove"), danger: true }))) return;
		await attempt(() => removeProvider(provider.id));
		close();
	};

	return html`<${Page} title=${isNew ? t("Add provider") : provider.name} close=${close} action=${html`<button class="btn sm primary" disabled=${busy === "save"} onClick=${save}>${t("Save")}</button>`}>
		${provider.synced && html`<div class="rows-note">${t("This provider is shared by your PCs (same Google account). A change saved here goes to the PCs too.")}</div>`}
		<div class="form">
			<div class="form-field"><label>${t("Name")}</label><input class="field" value=${draft.name || ""} placeholder=${t("For example: My provider")} onInput=${(event) => set({ name: event.target.value })} /></div>
			<div class="form-field">
				<label>${t("API type")}</label>
				<button class="field" style="text-align:left;display:flex;align-items:center" onClick=${pickKind}><span class="grow">${kind.label}</span><${Icon} name="chevronsUpDown" size=${16} /></button>
			</div>
			<div class="form-field">
				<label>${t("Address")}</label>
				<input class="field" type="url" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck=${false} value=${draft.baseUrl || ""} placeholder=${kind.hint} onInput=${(event) => set({ baseUrl: event.target.value })} />
				<div class="hint">${draft.api === "anthropic-messages" ? t("The API root, without /v1.") : t("The API root, including the version path (usually /v1).")}</div>
			</div>
			<div class="form-field">
				<label>${t("API key")}</label>
				<div class="field-row">
					<input class="field" type=${showKey ? "text" : "password"} autocapitalize="off" autocomplete="off" spellcheck=${false} value=${key} placeholder=${hasKey ? t("Saved. Leave empty to keep it.") : "sk-…"} onInput=${(event) => setKey(event.target.value)} />
					<button class="icon-btn" onClick=${() => setShowKey(!showKey)} aria-label=${t("Show")}><${Icon} name="eye" size=${20} /></button>
				</div>
				<div class="hint">${t("Kept encrypted on this phone (Android Keystore). It is sent only to this provider's address.")}</div>
			</div>
		</div>
		<div>
			<div class="rows-title">${t("Models")}</div>
			<div style="display:flex;flex-direction:column;gap:8px">
				${draft.models.map(
					(model) => html`<div class="model-row" key=${model.id}>
						<button class="mname" style="text-align:left" onClick=${() => openSheet((closeSheet) => html`<${ModelEditSheet} close=${closeSheet} model=${model} onSave=${(next) => patchModel(model.id, next)} />`)}>${model.name || model.id}</button>
						<span class="mtags">
							<button class="tag ${model.reasoning ? "on" : ""}" onClick=${() => patchModel(model.id, { reasoning: !model.reasoning })}>${t("Thinks")}</button>
							<button class="tag ${model.vision ? "on" : ""}" onClick=${() => patchModel(model.id, { vision: !model.vision })}>${t("Sees")}</button>
						</span>
						<button class="icon-btn sm" onClick=${() => setDraft((before) => ({ ...before, models: before.models.filter((entry) => entry.id !== model.id) }))} aria-label=${t("Remove")}><${Icon} name="x" size=${16} /></button>
					</div>`,
				)}
				${draft.models.length === 0 && html`<div class="rows-note" style="padding:4px 8px">${t("No models yet. Read the list from the provider, or add a model ID by hand.")}</div>`}
				<div class="field-row" style="margin-top:4px">
					<button class="btn grow" disabled=${busy === "fetch"} onClick=${fetchModels}>${busy === "fetch" ? html`<${Spinner} size=${16} />` : html`<${Icon} name="refresh" size=${17} />`}${t("Read the list")}</button>
					<button class="btn grow" onClick=${addManually}><${Icon} name="plus" size=${17} />${t("Add by ID")}</button>
				</div>
				<div class="rows-note">${t("“Thinks” and “Sees” say what a model can do; the app cannot find that out by itself. Tap a model's name for its limits.")}</div>
			</div>
		</div>
		${!isNew && html`<button class="btn danger block" onClick=${remove}><${Icon} name="trash" size=${17} />${t("Remove this provider")}</button>`}
	<//>`;
}

function openProvider(provider) {
	openPage((close) => html`<${ProviderPage} close=${close} provider=${provider} />`);
}

async function addProvider() {
	const choice = await actionSheet({
		title: t("Add provider"),
		actions: PROVIDER_PRESETS.map((preset) => ({ value: preset.key, label: preset.name || t("Other (OpenAI-compatible)"), sub: preset.baseUrl || t("Any service that speaks one of the supported APIs"), icon: preset.key === "custom" ? "plus" : "cpu" })),
	});
	const preset = PROVIDER_PRESETS.find((entry) => entry.key === choice);
	if (preset) openProvider({ name: preset.name, api: preset.api, baseUrl: preset.baseUrl, models: [] });
}

function ModelsPage({ close }) {
	const models = useStore((s) => s.local.models);
	const providers = getProviders();
	const [tavily, setTavily] = useState(() => !!secretGet("search.tavily"));
	const update = usePrefs();
	return html`<${Page} title=${t("Models on this phone")} close=${close}>
		<${Section} title=${t("Providers")} note=${t("The phone's own agent calls these providers directly with your key. Signed in with Google, the providers of your PCs are here too, with their keys; a provider added here goes to the PCs. Chats on the PC side use the PC's models.")}>
			${providers.map((provider) => html`<${Row} key=${provider.id} icon="cpu" title=${provider.name} sub=${`${t("{n} models", { n: provider.models.length })}${models.providers.find((entry) => entry.id === provider.id)?.hasKey ? "" : ` · ${t("no key")}`}${provider.synced ? ` · ${t("from your PCs")}` : ""}`} chevron onClick=${() => openProvider(provider)} />`)}
			<${Row} icon="plus" title=${t("Add provider")} onClick=${addProvider} />
		<//>
		<${Section} title=${t("Web search")} note=${t("Used when the assistant searches the web. Tavily works without a key (rate limited); a free key lifts the limit. Bing and DuckDuckGo are read as web pages and take over when Tavily fails.")}>
			<${Row}
				icon="search"
				title=${t("First choice")}
				value=${{ auto: t("Automatic"), tavily: "Tavily", bing: "Bing", duckduckgo: "DuckDuckGo" }[prefs.searchEngine] || t("Automatic")}
				chevron
				onClick=${async () => {
					const value = await pickSheet({
						title: t("Search with"),
						value: prefs.searchEngine,
						options: [
							{ value: "auto", label: t("Automatic"), sub: t("Tavily, then Bing, then DuckDuckGo") },
							{ value: "tavily", label: "Tavily" },
							{ value: "bing", label: "Bing" },
							{ value: "duckduckgo", label: "DuckDuckGo" },
						],
					});
					if (value) update({ searchEngine: value });
				}}
			/>
			<${Row}
				icon="key"
				title=${t("Tavily API key")}
				value=${tavily ? t("Saved") : t("Not set")}
				chevron
				onClick=${async () => {
					const value = await promptSheet({ title: t("Tavily API key"), password: true, placeholder: "tvly-…", hint: t("Free at app.tavily.com. Leave empty and save to remove the key.") });
					if (value !== null) {
						secretSet("search.tavily", value.trim());
						setTavily(!!value.trim());
					}
				}}
			/>
		<//>
	<//>`;
}

// ---- PC connection -----------------------------------------------------------------------------
async function pairWith(text) {
	try {
		const paired = await pc.pair(text);
		haptic("confirm");
		toast(t("Connected to {name}", { name: paired.name }), "ok");
		setMode("pc");
		return true;
	} catch (error) {
		toast(t(error.message || String(error)), "error", 7000);
		return false;
	}
}

/** Pair from a `myharness://link` address opened on the phone (main.js calls this). */
export async function pairFromLink(text) {
	if (await confirmSheet({ title: t("Connect to a PC?"), message: t("This pairs the phone with the MyHarness that made this code. What you type on the PC side is then sent to that PC."), confirmLabel: t("Connect") })) return pairWith(text);
	return false;
}

function LinkPage({ close }) {
	const link = useStore((s) => s.pc.link);
	const [busy, setBusy] = useState(false);

	useEffect(
		() =>
			onNative("scan", async (event) => {
				if (!event.text) return;
				setBusy(true);
				const ok = await pairWith(event.text);
				setBusy(false);
				if (ok) close();
			}),
		[],
	);

	const paste = async () => {
		const text = await promptSheet({ title: t("Pairing code"), label: t("Paste the code shown under the QR code on the PC"), placeholder: "myharness://link?…", confirmLabel: t("Connect"), multiline: true });
		if (!text) return;
		setBusy(true);
		const ok = await pairWith(text.trim());
		setBusy(false);
		if (ok) close();
	};

	const unpair = async () => {
		if (!(await confirmSheet({ title: t("Disconnect from {name}?", { name: link.paired.name }), message: t("The phone forgets this PC. To connect again, scan a new code on the PC. Removing the phone on the PC as well makes the old key useless."), confirmLabel: t("Disconnect"), danger: true }))) return;
		pc.unpair({ byUser: true });
		setMode("local");
	};

	const signed = useStore((s) => s.account.status !== "signedOut");
	const statusText = { online: t("Connected"), connecting: t("Connecting…"), offline: link.error || t("Not reachable"), none: t("Not connected") }[link.status];
	const route = link.status === "online" ? routeLabel(link) : "";

	return html`<${Page} title=${t("PC connection")} close=${close}>
		${signed &&
		html`<div>
			<div class="rows-title">${t("PCs of your Google account")}</div>
			<${AccountPcs} onPicked=${close} />
			<div class="rows-note">${t("Reached from any network: on the local network when the PC listens there, else directly over the internet, else through your Google Drive (slower). Every message stays encrypted with this phone's key.")}</div>
		</div>`}
		${link.paired
			? html`<div class="status-card ${link.status === "online" ? "ok" : link.status === "offline" ? "bad" : ""}">
						<span class="sicon">${link.status === "connecting" ? html`<${Spinner} size=${20} />` : html`<${Icon} name="desktop" size=${22} />`}</span>
						<span class="smain"><div class="stitle">${link.paired.name}</div><div class="ssub">${statusText}${route ? ` · ${route}` : ""}${link.status === "online" && link.host ? ` · ${link.host}:${link.paired.port}` : ""}</div></span>
					</div>
					${link.status === "online" && link.route === "relay" && link.direct && !link.direct.ok
						? html`<div class="rows-note">${t("Why not direct: {reason}", { reason: link.direct.reason })} ${t("Tried at {time}; tried again every 2 minutes and when the phone changes networks.", { time: new Date(link.direct.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</div>`
						: null}
					<${Section}>
						<${Row} icon="refresh" title=${t("Connect again")} onClick=${() => pc.reconnect()} disabled=${link.status === "connecting"} />
						<${Row} icon="qr" title=${t("Pair with another PC")} onClick=${() => (canScan ? scanQr() : paste())} />
						<${Row} icon="x" title=${t("Disconnect and forget this PC")} danger onClick=${unpair} />
					<//>`
			: html`<div class="empty-state" style="padding-bottom:10px">
						<span class="eicon"><${Icon} name="desktop" size=${26} /></span>
						<h3>${t("Use your PC from your phone")}</h3>
						${t("What you type here is sent to MyHarness on your PC; the PC does the work with its own models, files and tools, and the reply shows on both.")}
					</div>
					<div class="steps-list">
						<div class="sitem"><span class="snum">1</span><span>${t("On the PC, open MyHarness → Settings → Phone, and turn on “Phone link”.")}</span></div>
						<div class="sitem"><span class="snum">2</span><span>${t("Keep the phone and the PC on the same Wi-Fi or network.")}</span></div>
						<div class="sitem"><span class="snum">3</span><span>${t("Scan the QR code shown there.")}</span></div>
					</div>
					<div style="display:flex;flex-direction:column;gap:10px">
						${canScan && html`<button class="btn primary block" disabled=${busy} onClick=${() => scanQr()}>${busy ? html`<${Spinner} size=${17} />` : html`<${Icon} name="qr" size=${18} />`}${t("Scan the QR code")}</button>`}
						<button class="btn block ${canScan ? "" : "primary"}" disabled=${busy} onClick=${paste}><${Icon} name="link" size=${18} />${t("Paste the pairing code")}</button>
					</div>`}
		<div class="rows-note">${t("The phone and the PC talk directly over your local network; nothing goes through a server. Every message is encrypted with a key that only the QR code carried. A paired phone can make the agent on the PC act, so pair only your own phone.")}</div>
	<//>`;
}

export function openLinkPage() {
	openPage((close) => html`<${LinkPage} close=${close} />`);
}

// ---- Main settings page ------------------------------------------------------------------------
const THEMES = [
	{ value: "system", label: "Follow the phone" },
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];
const FONT_SCALES = [
	{ value: "small", label: "Small" },
	{ value: "normal", label: "Standard" },
	{ value: "large", label: "Large" },
	{ value: "xlarge", label: "Extra large" },
];
const COLOR_THEMES = [
	{ value: "classic", label: "Classic", dark: "#79a8f5", light: "#2c66d6" },
	{ value: "forest", label: "Forest", dark: "#a7c080", light: "#47773a" },
	{ value: "amber", label: "Amber", dark: "#d4ae82", light: "#96632b" },
];

function AccountSection() {
	const info = useStore((s) => s.account);
	const [busy, setBusy] = useState(false);
	if (info.status === "signedOut") return null;
	const when = info.syncedAt ? new Date(info.syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
	const status =
		info.status === "noSpace"
			? t("No PC has used this account with MyHarness yet")
			: info.status === "loading"
				? t("Reading your Google Drive…")
				: info.error
					? info.error
					: when
						? t("Up to date ({time})", { time: when })
						: "";
	const signOut = async () => {
		if (!(await confirmSheet({ title: t("Sign out of Google?"), message: t("The phone leaves your PCs: they forget its key, and the providers that came from them are removed from this phone. Chats on this phone stay."), confirmLabel: t("Sign out"), danger: true }))) return;
		setBusy(true);
		await attempt(() => account.signOut());
		setBusy(false);
	};
	return html`<${Section} title=${t("Google account")} note=${t("Your PCs' chats, providers, memories and bookmarks come to this phone through this account's Google Drive. MyHarness sees only the files it created there.")}>
		<${Row} icon="drive" title=${info.email || info.name} sub=${status} />
		<${Row} icon="refresh" title=${t("Sync now")} disabled=${busy || info.status === "loading"} onClick=${() => attempt(() => account.refresh())} />
		<${Row} icon="x" title=${t("Sign out")} danger disabled=${busy} onClick=${signOut} />
	<//>`;
}

function SettingsPage({ close }) {
	const update = usePrefs();
	const models = useStore((s) => s.local.models);
	const link = useStore((s) => s.pc.link);
	const chats = useStore((s) => s.local.chats.length);
	const [storage, setStorage] = useState(null);
	useEffect(() => {
		storageEstimate().then(setStorage);
	}, [chats]);
	const dark = document.documentElement.dataset.theme === "dark";
	const label = (list, value) => t(list.find((entry) => entry.value === value)?.label || list[0].label);
	const pick = async (title, list, key) => {
		const value = await pickSheet({ title, value: prefs[key], options: list.map((entry) => ({ value: entry.value, label: t(entry.label) })) });
		if (value !== undefined) update({ [key]: value });
	};
	const modelCount = models.providers.reduce((sum, provider) => sum + provider.models.length, 0);

	return html`<${Page} title=${t("Settings")} close=${close}>
		<${AccountSection} />
		<${Section} title=${t("Assistant")}>
			<${Row} icon="cpu" title=${t("Models on this phone")} value=${modelCount ? t("{n} models", { n: modelCount }) : t("Set up")} chevron onClick=${() => openModelsPage()} />
			<${Row} icon="desktop" title=${t("PC connection")} value=${link.paired ? link.paired.name : t("Not connected")} chevron onClick=${openLinkPage} />
			<${Row}
				icon="edit"
				title=${t("Your instructions")}
				sub=${prefs.personalPrompt ? prefs.personalPrompt.replace(/\s+/g, " ").slice(0, 80) : t("How the assistant on this phone should answer you")}
				chevron
				onClick=${async () => {
					const value = await promptSheet({ title: t("Your instructions"), value: prefs.personalPrompt, multiline: true, placeholder: t("For example: answer briefly; I am a student of computer science."), hint: t("Added to every chat on this phone. The PC has its own.") });
					if (value !== null) update({ personalPrompt: value.trim() });
				}}
			/>
		<//>
		<div>
			<div class="rows-title">${t("Appearance")}</div>
			<div class="swatches" style="margin-bottom:10px">
				${COLOR_THEMES.map((theme) => html`<button class="swatch ${prefs.colorTheme === theme.value ? "on" : ""}" key=${theme.value} onClick=${() => (haptic("tick"), update({ colorTheme: theme.value }))}><i style=${`background:${dark ? theme.dark : theme.light}`}></i>${t(theme.label)}</button>`)}
			</div>
			<div class="rows">
				<${Row} icon=${dark ? "moon" : "sun"} title=${t("Theme")} value=${label(THEMES, prefs.theme)} chevron onClick=${() => pick(t("Theme"), THEMES, "theme")} />
				<${Row} icon="type" title=${t("Text size")} value=${label(FONT_SCALES, prefs.fontScale)} chevron onClick=${() => pick(t("Text size"), FONT_SCALES, "fontScale")} />
				<${Row} icon="sparkle" title=${t("Animations")}><${Switch} on=${prefs.motion !== false} onChange=${(on) => update({ motion: on })} label=${t("Animations")} /><//>
				<${Row} icon="pulse" title=${t("Vibration feedback")}><${Switch} on=${prefs.haptics !== false} onChange=${(on) => update({ haptics: on })} label=${t("Vibration feedback")} /><//>
			</div>
		</div>
		<${Section} title=${t("General")}>
			<${Row}
				icon="language"
				title=${t("Language")}
				value=${prefs.lang === "zh-CN" ? "简体中文" : prefs.lang === "en" ? "English" : t("Follow the phone")}
				chevron
				onClick=${async () => {
					const value = await pickSheet({ title: t("Language"), value: prefs.lang || "", options: [{ value: "", label: t("Follow the phone") }, { value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }] });
					if (value !== undefined && value !== (prefs.lang || "")) {
						setPrefs({ lang: value });
						// Every label on the page is looked up when it is drawn: the page starts again in the new language.
						location.reload();
					}
				}}
			/>
			<${Row} icon="enter" title=${t("Enter sends the message")} sub=${t("Off: Enter starts a new line.")}><${Switch} on=${!!prefs.sendOnEnter} onChange=${(on) => update({ sendOnEnter: on })} label=${t("Enter sends the message")} /><//>
			<${Row} icon="bell" title=${t("Notify when a reply is ready")} sub=${t("When the app is in the background.")}><${Switch} on=${prefs.notifyDone !== false} onChange=${(on) => update({ notifyDone: on })} label=${t("Notify when a reply is ready")} /><//>
		<//>
		<${Section} title=${t("Browser")}>
			<${Row} icon="search" title=${t("Search engine of the address field")} value=${SEARCH_ENGINES.find((entry) => entry.value === prefs.browserSearch)?.label || "Bing"} chevron onClick=${() => pick(t("Search engine"), SEARCH_ENGINES, "browserSearch")} />
			<${Row}
				icon="trash"
				title=${t("Clear cookies and site data")}
				onClick=${async () => {
					if (await confirmSheet({ title: t("Clear cookies and site data?"), message: t("You will be signed out of websites in the built-in browser."), confirmLabel: t("Clear"), danger: true })) {
						await clearBrowsingData();
						toast(t("Cleared"), "ok", 1500);
					}
				}}
			/>
		<//>
		<${Section} title=${t("Data on this phone")} note=${t("Chats on this phone stay in the app's private storage and are removed with the app. Chats on the PC are stored on the PC.")}>
			<${Row} icon="chat" title=${t("Chats")} value=${`${chats}${storage?.usage ? ` · ${fmtBytes(storage.usage)}` : ""}`} />
			<${Row}
				icon="trash"
				title=${t("Delete all chats on this phone")}
				danger
				disabled=${chats === 0}
				onClick=${async () => {
					if (await confirmSheet({ title: t("Delete all chats on this phone?"), message: t("All {n} chats are removed. This cannot be undone.", { n: chats }), confirmLabel: t("Delete all"), danger: true })) {
						await attempt(() => local.deleteAllChats());
						toast(t("All chats deleted"), "ok");
					}
				}}
			/>
		<//>
		<${Section} title=${t("About")}>
			<${Row} icon="info" title="MyHarness" value=${`${nativeInfo.version}${nativeInfo.debug && nativeInfo.version !== "dev" ? " (debug)" : ""}`} />
			${nativeInfo.android && html`<${Row} icon="phone" title=${nativeInfo.device} value=${`Android ${nativeInfo.android}`} />`}
		<//>
	<//>`;
}

export function openModelsPage() {
	openPage((close) => html`<${ModelsPage} close=${close} />`);
}

export function openSettings(section) {
	if (section === "models") return openModelsPage();
	if (section === "link") return openLinkPage();
	openPage((close) => html`<${SettingsPage} close=${close} />`);
}

