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
	google: "https://www.google.com/search?q=",
	bing: "https://www.bing.com/search?q=",
	duckduckgo: "https://duckduckgo.com/?q=",
	baidu: "https://www.baidu.com/s?wd=",
};
export const SEARCH_ENGINES = [
	{ value: "google", label: "Google" },
	{ value: "bing", label: "Bing" },
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
	return (SEARCH[prefs.browserSearch] || SEARCH.google) + encodeURIComponent(text);
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

// Web views the app reads a page in without showing it (runInHiddenPage) are not tabs.
const HIDDEN = "hidden-";
const hiddenPages = new Map(); // id → what its state events are told to

/**
 * The shell's list of web views, laid over the page's tabs. A tab that has no web view yet (`lazy`: a page the agent on
 * the PC opened, shown here when it is first looked at) is kept as it is and in its place.
 */
function applyList(answer) {
	if (!answer || !Array.isArray(answer.tabs)) return;
	const made = new Map(answer.tabs.filter((tab) => !String(tab.id).startsWith(HIDDEN)).map((tab) => [tab.id, tab]));
	const tabs = [];
	for (const tab of state.browser.tabs) {
		const view = made.get(tab.id);
		// A web view that was just made has no address yet: the one the tab is loading stays on the page meanwhile.
		if (view) tabs.push({ ...tab, ...view, url: view.url || tab.url, title: view.title || (view.url ? "" : tab.title), lazy: false, loading: tab.loading ?? false });
		else if (tab.lazy) tabs.push(tab);
		made.delete(tab.id);
	}
	for (const view of made.values()) tabs.push({ ...view, loading: false });
	const shown = state.browser.active;
	const keeps = tabs.some((tab) => tab.id === shown && tab.lazy);
	state.browser = { ...state.browser, tabs, active: keeps ? shown : (answer.active ?? null) };
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

/** Give a tab that only has an address its web view, and load it. */
function materialize(id) {
	const tab = tabOf(id);
	if (!tab?.lazy) return Promise.resolve();
	patchTab(id, { lazy: false, loading: true, progress: 5, error: null });
	return command("create", { id, url: tab.url, activate: state.browser.active === id, desktop: !!prefs.desktopSite });
}

export async function closeTab(id) {
	const closing = tabOf(id);
	if (!closing) return;
	const at = state.browser.tabs.indexOf(closing);
	const wasShown = state.browser.active === id;
	if (closing.lazy) {
		state.browser = { ...state.browser, tabs: state.browser.tabs.filter((tab) => tab.id !== id), active: wasShown ? null : state.browser.active };
		emit();
	} else await command("close", { id });
	// The tab on screen was closed: the one beside it is shown, not the start page over a row of open tabs.
	const next = state.browser.tabs[Math.min(at, state.browser.tabs.length - 1)];
	if (wasShown && next && !state.browser.active) await activateTab(next.id);
	else if (!isNative && !state.browser.tabs.length) emit();
}

export async function closeAllTabs() {
	for (const tab of [...state.browser.tabs]) {
		if (tab.lazy) continue;
		await command("close", { id: tab.id });
	}
	state.browser = { ...state.browser, tabs: [], active: null };
	emit();
}

export function activateTab(id) {
	if (state.browser.active === id) return Promise.resolve();
	const tab = tabOf(id);
	if (!tab) return Promise.resolve();
	state.browser = { ...state.browser, active: id, find: null };
	emit();
	// A tab without a web view gets one when the browser is on screen (ensureShownTab); until then only its name shows.
	if (tab.lazy) return state.pane === "browser" ? materialize(id) : Promise.resolve();
	return command("activate", { id });
}

/** The browser pane came on screen (or its shown tab changed): a shown tab that has no web view yet gets it now. */
export function ensureShownTab() {
	const tab = activeTab();
	if (tab?.lazy) materialize(tab.id);
}

const PC_TABS_MAX = 12;

/**
 * A page the agent on the PC opened in the PC's browser gets a tab here as well (`key` names the PC's tab). The
 * phone opens the same address itself, with its own sign-ins, and only when the tab is first looked at: nothing is
 * loaded over mobile data for a page nobody reads. It becomes the shown tab when the browser shows no page of the
 * user's own.
 */
export function mirrorPcTab(key, url, title = "") {
	if (!/^https?:\/\//i.test(url || "")) return;
	const existing = state.browser.tabs.find((tab) => tab.pcKey === key);
	if (existing) {
		if (existing.url === url) return;
		// A page the user is reading stays; otherwise the tab follows the PC's.
		if (existing.lazy) patchTab(existing.id, { url, title });
		else if (!(state.pane === "browser" && state.browser.active === existing.id)) navigate(url, existing.id);
		return;
	}
	const shown = activeTab();
	const takeOver = !shown || !shown.url || !!shown.pcKey;
	const id = uid("tab");
	const tab = { id, url, title, canGoBack: false, canGoForward: false, progress: 0, loading: false, lazy: true, pcKey: key };
	let tabs = [...state.browser.tabs, tab];
	// Many pages opened on the PC: the oldest ones that were never looked at here leave.
	const unread = tabs.filter((entry) => entry.lazy && entry.pcKey);
	if (unread.length > PC_TABS_MAX) {
		const drop = new Set(unread.slice(0, unread.length - PC_TABS_MAX).map((entry) => entry.id));
		tabs = tabs.filter((entry) => !drop.has(entry.id));
	}
	state.browser = { ...state.browser, tabs, active: takeOver ? id : state.browser.active, find: takeOver ? null : state.browser.find };
	emit();
	if (takeOver && state.pane === "browser") materialize(id);
}

/** Go to an address or search in the shown tab (a first tab is made when there is none). */
export async function navigate(input, id = state.browser.active) {
	const url = toUrl(input);
	if (!url) return null;
	if (!id || !tabOf(id)) return openTab(url);
	if (tabOf(id).lazy) {
		patchTab(id, { url });
		await materialize(id);
		return id;
	}
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
/** Search the shown page for `query` ("" ends the search); the shell reports the matches as a `find` event. */
export function findInPage(query, { next = false, backwards = false } = {}, id = state.browser.active) {
	if (!id || tabOf(id)?.lazy) return;
	if (!query) {
		state.browser = { ...state.browser, find: null };
		emit();
	} else if (!next) {
		state.browser = { ...state.browser, find: { id, query, active: 0, count: 0, done: false } };
		emit();
	}
	return command("find", { id, query, next, backwards });
}
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

/** A tab the agent wants to work in: one without a web view yet gets it and is waited for. */
async function readyTab(id) {
	const tab = tabOf(id);
	if (!id || !tab) throw new Error("No browser tab is open");
	if (tab.lazy) {
		await materialize(id);
		await waitForLoad(id, 20000);
	}
}

/** The text a tab shows right now (what the user would read), cut to `maxChars`. */
export async function readPage(id = state.browser.active, maxChars = 16000) {
	await readyTab(id);
	const value = await browserCommand("evaluate", { id, script: READ_SCRIPT.replace("LIMIT", String(Math.max(500, Math.min(60000, maxChars)))) });
	const page = typeof value === "string" ? JSON.parse(value) : value;
	if (!page || typeof page !== "object") throw new Error("The page gave nothing to read");
	return page;
}

// What the assistant does in a page, run inside it. A real function (not text in a string), so its regular expressions
// and quotes reach the page as written. It finds elements the way a person names them: by the words on them.
function pageAct(input) {
	var action = input.action;
	var norm = function (value) {
		return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
	};
	var visible = function (node) {
		if (!node || !node.getBoundingClientRect) return false;
		var box = node.getBoundingClientRect();
		if (box.width < 2 || box.height < 2) return false;
		var style = getComputedStyle(node);
		return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.02;
	};
	var nameOf = function (node) {
		var label = "";
		if (node.id) {
			var forLabel = document.querySelector("label[for='" + String(node.id).replace(/'/g, "\\'") + "']");
			if (forLabel) label = forLabel.innerText;
		}
		if (!label && node.closest) {
			var wrap = node.closest("label");
			if (wrap) label = wrap.innerText;
		}
		return [node.getAttribute("aria-label"), label, node.getAttribute("placeholder"), node.getAttribute("title"), node.getAttribute("name"), node.value && node.tagName !== "TEXTAREA" && node.type !== "password" && /^(button|submit|reset)$/.test(node.type || "") ? node.value : "", node.innerText]
			.filter(Boolean)
			.map(norm);
	};
	var find = function (selectors) {
		if (input.selector) {
			var chosen = document.querySelector(input.selector);
			if (!chosen) throw new Error("No element matches the selector " + input.selector);
			return chosen;
		}
		var wanted = norm(input.label);
		if (!wanted) throw new Error("Say which element: its words (label) or a CSS selector.");
		var nodes = document.querySelectorAll(selectors);
		var best = null;
		var bestScore = 0;
		for (var i = 0; i < nodes.length; i++) {
			if (!visible(nodes[i])) continue;
			var names = nameOf(nodes[i]);
			for (var j = 0; j < names.length; j++) {
				var name = names[j];
				if (!name) continue;
				var score = name === wanted ? 100 : name.indexOf(wanted) === 0 ? 70 : name.indexOf(wanted) >= 0 ? 40 - Math.min(30, (name.length - wanted.length) / 4) : 0;
				if (score > bestScore) {
					best = nodes[i];
					bestScore = score;
				}
			}
		}
		if (!best) throw new Error("Nothing on the page is called “" + input.label + "”. Read the page to see what it shows.");
		return best;
	};
	var describe = function (node) {
		return (node.tagName || "").toLowerCase() + " “" + (nameOf(node).filter(Boolean)[0] || "").slice(0, 60) + "”";
	};
	try {
		if (action === "click") {
			var target = find("a, button, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='checkbox'], [role='radio'], input, select, summary, label, [onclick], [tabindex]");
			target.scrollIntoView({ block: "center", inline: "center" });
			var box = target.getBoundingClientRect();
			var point = { bubbles: true, cancelable: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
			["pointerdown", "mousedown", "pointerup", "mouseup"].forEach(function (type) {
				target.dispatchEvent(new MouseEvent(type, point));
			});
			target.click();
			return JSON.stringify({ ok: true, did: "clicked " + describe(target) });
		}
		if (action === "type") {
			var field = find("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']), textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='searchbox'], [role='combobox']");
			field.scrollIntoView({ block: "center" });
			field.focus();
			var text = String(input.text == null ? "" : input.text);
			if (field.isContentEditable) {
				if (input.replace !== false) field.textContent = "";
				document.execCommand("insertText", false, text);
			} else if (field.tagName === "SELECT") {
				var options = field.options;
				var picked = -1;
				for (var k = 0; k < options.length; k++) if (norm(options[k].text) === norm(text) || options[k].value === text) picked = k;
				if (picked < 0) throw new Error("The list has no option “" + text + "”.");
				field.selectedIndex = picked;
			} else {
				var proto = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
				setter.call(field, input.replace === false ? field.value + text : text);
			}
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
			if (input.enter) {
				var key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
				var go = field.dispatchEvent(new KeyboardEvent("keydown", key));
				field.dispatchEvent(new KeyboardEvent("keypress", key));
				field.dispatchEvent(new KeyboardEvent("keyup", key));
				if (go && field.form) {
					if (field.form.requestSubmit) field.form.requestSubmit();
					else field.form.submit();
				}
			}
			return JSON.stringify({ ok: true, did: "typed into " + describe(field) + (input.enter ? " and pressed Enter" : "") });
		}
		if (action === "scroll") {
			var before = window.scrollY;
			if (input.to === "top") window.scrollTo(0, 0);
			else if (input.to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
			else window.scrollBy(0, (input.to === "up" ? -1 : 1) * Math.round(window.innerHeight * 0.85) * Math.max(1, Math.min(10, Number(input.pages) || 1)));
			return JSON.stringify({ ok: true, did: "scrolled", from: Math.round(before), at: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), screen: Math.round(window.innerHeight) });
		}
		throw new Error("Unknown page action " + action);
	} catch (error) {
		return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
	}
}

/**
 * Do one thing in a tab's page for the assistant: `click` an element, `type` into a field, or `scroll`. Elements
 * are named by the words on them (`label`) or a CSS `selector`. Resolves with what was done.
 */
export async function actOnPage(id, input) {
	await readyTab(id);
	const value = await browserCommand("evaluate", { id, script: `(${pageAct.toString()})(${JSON.stringify(input)})` });
	const answer = typeof value === "string" ? JSON.parse(value) : value;
	if (!answer || typeof answer !== "object") throw new Error("The page gave no answer");
	if (!answer.ok) throw new Error(answer.error || "The page refused");
	return answer;
}

export async function screenshotPage(id = state.browser.active, maxWidth = 900) {
	await readyTab(id);
	const shot = await browserCommand("screenshot", { id, maxWidth });
	return { mimeType: shot.mimeType || "image/jpeg", data: shot.data };
}

/**
 * Load an address in a web view that is never shown, run `script` in the loaded page and resolve with its value.
 * The page has the browser's cookies (a search engine sees the same visitor as in the browser pane) and is closed
 * afterwards, whatever happened.
 */
export async function runInHiddenPage(url, script, { signal, timeoutMs = 15000, userAgent = "", fresh = false, ready = null, readyMs = 5000 } = {}) {
	if (!isNative) throw new Error("Pages can only be read inside the app");
	const id = uid(HIDDEN.slice(0, -1));
	let settle;
	const loaded = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	hiddenPages.set(id, (event) => {
		if (event.type === "error") settle.reject(new Error(event.message || "The page did not load"));
		else if (event.type === "state" && !event.loading && event.url && event.url !== "about:blank") settle.resolve();
	});
	// A failure before anyone waits for it (the page is still being made) is reported by the wait below.
	loaded.catch(() => {});
	const timer = setTimeout(() => settle.reject(new Error("timed out")), timeoutMs);
	const stop = () => settle.reject(new DOMException("The request was aborted", "AbortError"));
	signal?.addEventListener("abort", stop);
	try {
		if (signal?.aborted) stop();
		await browserCommand("create", { id, url, activate: false, ...(userAgent ? { userAgent } : {}), ...(fresh ? { fresh: true } : {}) });
		await loaded;
		// What a page fills in after it loaded is there a moment later: it is read again until `ready` accepts it.
		const until = Date.now() + (ready ? readyMs : 0);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, ready ? 400 : 250));
			if (signal?.aborted) stop();
			const value = await browserCommand("evaluate", { id, script });
			let done = !ready;
			try {
				done = done || !!ready(value);
			} catch {
				// Not readable yet.
			}
			if (done || Date.now() >= until) return value;
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
		hiddenPages.delete(id);
		browserCommand("close", { id }).then(applyList, () => {});
	}
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
		if (hiddenPages.has(event.id) && (event.type === "state" || event.type === "error")) return hiddenPages.get(event.id)(event);
		if (String(event.id || "").startsWith(HIDDEN)) return;
		if (event.type === "state") {
			if (!tabOf(event.id)) return;
			patchTab(event.id, { url: event.url, title: event.title, canGoBack: event.canGoBack, canGoForward: event.canGoForward, progress: event.progress, loading: !!event.loading, ...(event.loading ? { error: null } : {}) });
			if (!event.loading && event.url) remember(event.url, event.title);
		} else if (event.type === "find") {
			const find = state.browser.find;
			if (find && find.id === event.id) {
				state.browser = { ...state.browser, find: { ...find, active: event.count ? event.active + 1 : 0, count: event.count, done: !!event.done } };
				emit();
			}
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
