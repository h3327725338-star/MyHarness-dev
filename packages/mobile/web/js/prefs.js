// What the user chose on this phone (appearance, language, last used model…). Kept in localStorage so the page can
// read it before the first paint (boot-theme.js); secrets never go here (native.js keeps those).
import { setLang } from "/shared/lang.js";
import { nativeInfo, onNative, setChrome, setHaptics } from "./native.js";

const KEY = "myharness.mobile.prefs";

const DEFAULTS = {
	theme: "system", // system | dark | light
	colorTheme: "classic", // the one scheme of the first versions; read once for colorThemes
	colorThemes: null, // { coding, general }: classic | forest | amber, one per chat mode as on the desktop
	fontScale: "normal", // small | normal | large | xlarge
	lang: "", // "" = the phone's language
	motion: true,
	haptics: true,
	mode: "local", // local | pc: which side new messages go to
	model: "", // "<providerId>/<modelId>" of the phone's own agent
	effort: "medium",
	titleModel: "", // "" = the chat's own model
	searchEngine: "auto", // auto (the PC's sources, else Google and Tavily) | google | tavily | bing | duckduckgo
	personalPrompt: "",
	notifyDone: true,
	desktopSite: false,
	browserSearch: "google", // google | bing | duckduckgo | baidu
	prefsVersion: 2,
	sendOnEnter: false,
};

function read() {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
		// Every save writes all values, so a phone that saved anything before version 2 holds that version's defaults as if
		// they were choices: the address field's Bing was the default then, and Google is now.
		if (!(saved.prefsVersion >= 2) && saved.browserSearch === "bing") delete saved.browserSearch;
		return { ...DEFAULTS, ...saved, prefsVersion: DEFAULTS.prefsVersion };
	} catch {
		return { ...DEFAULTS };
	}
}

export const prefs = read();
const listeners = new Set();

export function onPrefs(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function setPrefs(patch) {
	Object.assign(prefs, patch);
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		// Storage is full or blocked: the choice still holds until the app closes.
	}
	if ("theme" in patch || "colorThemes" in patch || "fontScale" in patch || "motion" in patch || "lang" in patch || "haptics" in patch) applyAppearance();
	for (const fn of [...listeners]) fn(prefs, patch);
}

let systemDark = !!nativeInfo.systemDark;
onNative("lifecycle", (event) => {
	if (typeof event.systemDark === "boolean" && event.systemDark !== systemDark) {
		systemDark = event.systemDark;
		applyAppearance();
		for (const fn of [...listeners]) fn(prefs, { theme: prefs.theme });
	}
});
globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", (event) => {
	if (globalThis.MyHarnessNative) return;
	systemDark = event.matches;
	applyAppearance();
});

export function resolvedTheme() {
	return prefs.theme === "dark" || prefs.theme === "light" ? prefs.theme : systemDark ? "dark" : "light";
}

const SCHEMES = ["classic", "forest", "amber"];
const schemeOf = (value, fallback) => (SCHEMES.includes(value) ? value : fallback);
/** As on the desktop: Coding opens in Classic Charcoal, General in Quiet Forest, until another scheme is picked for that mode. */
export const DEFAULT_COLOR_THEMES = { coding: "classic", general: "forest" };

/** The colour scheme of each chat mode. A scheme picked before there were two (`colorTheme`) counts for both. */
export function colorThemes() {
	const one = prefs.colorTheme && prefs.colorTheme !== "classic" ? prefs.colorTheme : undefined;
	return {
		coding: schemeOf(prefs.colorThemes?.coding ?? one, DEFAULT_COLOR_THEMES.coding),
		general: schemeOf(prefs.colorThemes?.general ?? one, DEFAULT_COLOR_THEMES.general),
	};
}

// The chat mode on screen: Coding or General on the PC side, General for the phone's own assistant.
let shownMode = (() => {
	// What boot-theme.js put on the page before the first paint; main.js follows the state from then on.
	try {
		return prefs.mode === "pc" && localStorage.getItem("myharness.mobile.link") && JSON.parse(localStorage.getItem("myharness.mobile.pc.listMode") || "null") === "coding" ? "coding" : "general";
	} catch {
		return "general";
	}
})();
export const shownChatMode = () => shownMode;

/**
 * Show the colours of a chat mode. `change` is what makes that mode the one on screen (it moves the switch, swaps the
 * list); with `origin` (the point on screen where the switch was tapped) the new colours spread from there in one
 * growing circle, as the desktop's switch does, and `change` runs inside that transition so the old picture is whole.
 * Without an origin, or when both modes wear the same scheme, the change is simply made.
 */
export function setShownMode(mode, { origin = null, change = null } = {}) {
	const next = mode === "coding" ? "coding" : "general";
	const run = () => {
		change?.();
		if (next === shownMode) return;
		shownMode = next;
		applyAppearance();
	};
	const differs = next !== shownMode && colorThemes()[next] !== colorThemes()[shownMode];
	if (!differs || !origin || prefs.motion === false || typeof document.startViewTransition !== "function" || document.visibilityState !== "visible") return run();
	const root = document.documentElement;
	root.style.setProperty("--wipe-x", `${Math.round(origin.x)}px`);
	root.style.setProperty("--wipe-y", `${Math.round(origin.y)}px`);
	root.classList.add("mode-wipe");
	let ran = false;
	let transition;
	try {
		transition = document.startViewTransition(async () => {
			ran = true;
			run();
			// The page draws the change (the state tells the components in a microtask, they render in the next) before
			// the new picture is taken.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	} catch {
		root.classList.remove("mode-wipe");
		if (!ran) run();
		return;
	}
	transition.finished.catch(() => {}).finally(() => root.classList.remove("mode-wipe"));
}

export function resolvedLang() {
	const value = prefs.lang || nativeInfo.language || navigator.language || "en";
	return /^zh/i.test(value) ? "zh-CN" : "en";
}

/** Put the saved appearance on the page and tell the shell which colour the system bars sit on. */
export function applyAppearance() {
	const root = document.documentElement;
	const theme = resolvedTheme();
	root.dataset.theme = theme;
	const schemes = colorThemes();
	root.dataset.colorTheme = schemes[shownMode];
	// Each side of the Coding / General switch wears its own mode's colour, whichever mode is on screen (tokens.css).
	root.dataset.codingColorTheme = schemes.coding;
	root.dataset.generalColorTheme = schemes.general;
	if (prefs.fontScale && prefs.fontScale !== "normal") root.dataset.fontScale = prefs.fontScale;
	else delete root.dataset.fontScale;
	if (prefs.motion === false) root.dataset.motion = "off";
	else delete root.dataset.motion;
	setLang(resolvedLang());
	setHaptics(prefs.haptics);
	requestAnimationFrame(() => {
		const background = getComputedStyle(root).getPropertyValue("--bg").trim() || (theme === "dark" ? "#141515" : "#ffffff");
		setChrome(theme === "dark", background);
	});
}
