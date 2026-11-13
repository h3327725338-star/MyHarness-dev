// The built-in browser's tabs, bookmarks and history. The web pages themselves are native views of the Android shell
// (BrowserController.java); this module tells the shell what to do and keeps the page's picture of the tabs. The pane
// that draws the controls is browser.js; the agent's `browser` tool (tools.js) uses the same functions.
import { t } from "/shared/i18n.js";
import { uid } from "/shared/util.js";
import { kvGet, kvSet } from "./db.js";
import { browserCommand, isNative, onNative, openExternal } from "./native.js";
import { prefs } from "./prefs.js";
import { emit, state, toast } from "./store.js";

const SEARCH = {
	bing: "https://www.bing.com/search?q=",
	google: "https://www.google.com/search?q=",
	duckduckgo: "https://duckduckgo.com/?q=",
	baidu: "https://www.baidu.com/s?wd=",
};
export const SEARCH_ENGINES = [
	{ value: "bing", label: "Bing" },
	{ value: "google", label: "Google" },
	{ value: "duckduckgo", label: "DuckDuckGo" },
	{ value: "baidu", label: "百度" },
];

export const library = { bookmarks: [], history: [] };
const HISTORY_MAX = 300;

/** What the user typed in the address field, as an address: a URL as it is, anything else as a web search. */
export function toUrl(input) {
	const text = String(input || "").trim();
	if (!text) return "";
	if (/^https?:\/\//i.test(text)) return text;
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
	if (!/\s/.test(text) && /^[^\s/]+\.[a-z一-龥]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
	return (SEARCH[prefs.browserSearch] || SEARCH.bing) + encodeURIComponent(text);
}

export function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

const tabOf = (id) => state.browser.tabs.find((tab) => tab.id === id);
export const activeTab = () => tabOf(state.browser.active) || null;

function patchTab(id, patch) {
	state.browser = { ...state.browser, tabs: state.browser.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) };
	emit();
}

function applyList(answer) {
	if (!answer || !Array.isArray(answer.tabs)) return;
	const known = new Map(state.browser.tabs.map((tab) => [tab.id, tab]));
	state.browser = {
		...state.browser,
		tabs: answer.tabs.map((tab) => ({ ...known.get(tab.id), ...tab, loading: known.get(tab.id)?.loading ?? false })),
		active: answer.active ?? null,
	};
	emit();
}

async function command(action, params) {
	try {
		const answer = await browserCommand(action, params);
		applyList(answer);
		return answer;
	} catch (error) {
		console.error(`browser ${action} failed`, error);
		return null;
	}
}

export async function openTab(url = "", { activate = true } = {}) {
	const id = uid("tab");
	// The tab is on the page at once; the shell's answer fills in the rest.
	state.browser = { ...state.browser, tabs: [...state.browser.tabs, { id, url, title: "", canGoBack: false, canGoForward: false, progress: 0, loading: !!url }], active: activate ? id : state.browser.active };
	emit();
	await command("create", { id, url, activate, desktop: !!prefs.desktopSite });
	return id;
}

export async function closeTab(id) {
	await command("close", { id });
	if (!isNative && !state.browser.tabs.length) emit();
}

export function activateTab(id) {
	if (state.browser.active === id) return Promise.resolve();
	state.browser = { ...state.browser, active: id };
	emit();
	return command("activate", { id });
}

/** Go to an address or search in the shown tab (a first tab is made when there is none). */
export async function navigate(input, id = state.browser.active) {
	const url = toUrl(input);
	if (!url) return null;
	if (!id || !tabOf(id)) return openTab(url);
	patchTab(id, { url, loading: true, error: null, progress: 5 });
	await command("load", { id, url });
	return id;
}

export const goBack = (id = state.browser.active) => id && command("back", { id });
export const goForward = (id = state.browser.active) => id && command("forward", { id });
export const reload = (id = state.browser.active) => {
	if (!id) return;
	patchTab(id, { error: null });
	return command("reload", { id });
};
export const stopLoading = (id = state.browser.active) => id && command("stop", { id });
export const setDesktopSite = (on, id = state.browser.active) => id && command("desktop", { id, on });
export const findInPage = (query, { next = false, backwards = false } = {}, id = state.browser.active) => id && command("find", { id, query, next, backwards });
export const clearBrowsingData = () => command("clearData", {});

/** Where the web view sits on the screen (CSS px of the app's page); `visible` false hides it (a sheet is open, the start page shows). */
export function setBounds(rect, visible) {
	if (!isNative) return;
	browserCommand("bounds", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !!visible }).catch(() => {});
}

const READ_SCRIPT = `(function () {
	var body = document.body;
	var text = body ? (body.innerText || "") : "";
	var links = [];
	try {
		var anchors = document.querySelectorAll("a[href]");
		for (var i = 0; i < anchors.length && links.length < 40; i++) {
			var label = (anchors[i].innerText || "").trim().replace(/\\s+/g, " ");
			var href = anchors[i].href;
			if (label && /^https?:/.test(href)) links.push([label.slice(0, 80), href]);
		}
	} catch (error) {}
	return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, LIMIT), length: text.length, links: links });
})()`;

/** The text a tab shows right now (what the user would read), cut to `maxChars`. */
export async function readPage(id = state.browser.active, maxChars = 16000) {
	if (!id || !tabOf(id)) throw new Error("No browser tab is open");
	const value = await browserCommand("evaluate", { id, script: READ_SCRIPT.replace("LIMIT", String(Math.max(500, Math.min(60000, maxChars)))) });
	const page = typeof value === "string" ? JSON.parse(value) : value;
	if (!page || typeof page !== "object") throw new Error("The page gave nothing to read");
	return page;
}

export async function screenshotPage(id = state.browser.active, maxWidth = 900) {
	if (!id || !tabOf(id)) throw new Error("No browser tab is open");
	const shot = await browserCommand("screenshot", { id, maxWidth });
	return { mimeType: shot.mimeType || "image/jpeg", data: shot.data };
}

/** Wait until a tab stopped loading (or the time is up), so a page that was just opened can be read. */
export function waitForLoad(id, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const started = Date.now();
		let seenLoading = false;
		const check = () => {
			const tab = tabOf(id);
			if (!tab) return resolve(false);
			if (tab.loading) seenLoading = true;
			const settled = !tab.loading && (seenLoading || Date.now() - started > 700);
			if (settled || Date.now() - started > timeoutMs) return resolve(settled);
			setTimeout(check, 120);
		};
		check();
	});
}

// ---- Bookmarks and history ---------------------------------------------------------------------
function saveLibrary() {
	kvSet("browser.library", { bookmarks: library.bookmarks, history: library.history }).catch(() => {});
	emit();
}

export const isBookmarked = (url) => library.bookmarks.some((entry) => entry.url === url);

export function toggleBookmark(url, title) {
	if (!url) return false;
	if (isBookmarked(url)) library.bookmarks = library.bookmarks.filter((entry) => entry.url !== url);
	else library.bookmarks = [{ url, title: title || hostOf(url) || url }, ...library.bookmarks];
	saveLibrary();
	return isBookmarked(url);
}

export function clearHistory() {
	library.history = [];
	saveLibrary();
}

function remember(url, title) {
	if (!/^https?:/i.test(url)) return;
	const last = library.history[0];
	if (last?.url === url) {
		if (title && last.title !== title) last.title = title;
	} else library.history = [{ url, title: title || "", ts: Date.now() }, ...library.history.filter((entry) => entry.url !== url)].slice(0, HISTORY_MAX);
	clearTimeout(remember.timer);
	remember.timer = setTimeout(() => kvSet("browser.library", { bookmarks: library.bookmarks, history: library.history }).catch(() => {}), 800);
}

export async function initBrowser() {
	const saved = await kvGet("browser.library", null);
	if (saved) {
		library.bookmarks = Array.isArray(saved.bookmarks) ? saved.bookmarks : [];
		library.history = Array.isArray(saved.history) ? saved.history : [];
	}
	onNative("browser", (event) => {
		if (event.type === "state") {
			if (!tabOf(event.id)) return;
			patchTab(event.id, { url: event.url, title: event.title, canGoBack: event.canGoBack, canGoForward: event.canGoForward, progress: event.progress, loading: !!event.loading, ...(event.loading ? { error: null } : {}) });
			if (!event.loading && event.url) remember(event.url, event.title);
		} else if (event.type === "error") {
			if (event.id && tabOf(event.id)) patchTab(event.id, { loading: false, error: { url: event.failedUrl, message: event.message } });
		} else if (event.type === "newTab") {
			if (event.url) openTab(event.url);
		} else if (event.type === "external") {
			// A link to another app (tel:, mailto:, intent:, a store page): the user decides, the page does not.
			state.browser = { ...state.browser, external: { url: event.url, nonce: Date.now() } };
			emit();
		} else if (event.type === "download") {
			if (event.error) toast(event.error === "unsupported" ? t("This kind of download is not supported here. Open the page in your browser instead.") : t("Download failed: {reason}", { reason: event.error }), "error");
			else toast(t("Downloading {name} to Downloads", { name: event.name || t("file") }), "ok");
		}
	});
	const answer = await command("list", {});
	if (answer?.tabs?.length && !state.browser.active) activateTab(answer.tabs[answer.tabs.length - 1].id);
}

export function openOutside(url) {
	openExternal(url);
}
