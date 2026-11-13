// What the user chose on this phone (appearance, language, last used model…). Kept in localStorage so the page can
// read it before the first paint (boot-theme.js); secrets never go here (native.js keeps those).
import { setLang } from "/shared/lang.js";
import { nativeInfo, onNative, setChrome, setHaptics } from "./native.js";

const KEY = "myharness.mobile.prefs";

const DEFAULTS = {
	theme: "system", // system | dark | light
	colorTheme: "classic", // classic | forest | amber
	fontScale: "normal", // small | normal | large | xlarge
	lang: "", // "" = the phone's language
	motion: true,
	haptics: true,
	mode: "local", // local | pc: which side new messages go to
	model: "", // "<providerId>/<modelId>" of the phone's own agent
	effort: "medium",
	titleModel: "", // "" = the chat's own model
	searchEngine: "auto", // auto | tavily | bing | duckduckgo
	personalPrompt: "",
	notifyDone: true,
	desktopSite: false,
	browserSearch: "bing", // bing | google | duckduckgo | baidu
	sendOnEnter: false,
};

function read() {
	try {
		return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") || {}) };
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
	if ("theme" in patch || "colorTheme" in patch || "fontScale" in patch || "motion" in patch || "lang" in patch || "haptics" in patch) applyAppearance();
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

export function resolvedLang() {
	const value = prefs.lang || nativeInfo.language || navigator.language || "en";
	return /^zh/i.test(value) ? "zh-CN" : "en";
}

/** Put the saved appearance on the page and tell the shell which colour the system bars sit on. */
export function applyAppearance() {
	const root = document.documentElement;
	const theme = resolvedTheme();
	root.dataset.theme = theme;
	root.dataset.colorTheme = prefs.colorTheme === "forest" || prefs.colorTheme === "amber" ? prefs.colorTheme : "classic";
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
