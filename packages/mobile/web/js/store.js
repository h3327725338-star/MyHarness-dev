// The page's one state object. Backends (backend-local.js, backend-remote.js) and the panes change it through `set`
// or by assigning and calling `emit`; components read it with `useStore(selector)` and re-render only when what they
// selected changed.
import { useEffect, useRef, useState } from "/shared/ui.js";
import { uid } from "/shared/util.js";
import { emptyLists } from "./pc-groups.js";
import { prefs } from "./prefs.js";

export const LIST_MODE_KEY = "myharness.mobile.pc.listMode";
export const FOLDS_KEY = "myharness.mobile.pc.folds";

function savedJson(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "null");
	} catch {
		return null;
	}
}

/** Keep a small value on the phone; a full or blocked storage only loses it. */
export function saveJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Kept until the app closes.
	}
}

/** A conversation as the chat pane shows it. Both backends fill the same shape (see live.js for the live part). */
export function emptyChat() {
	return {
		id: null,
		title: "",
		items: [], // wire items, the format of the desktop transcript (turns.js builds the turns from them)
		toolRuns: {},
		runs: {},
		running: false,
		runStartedAt: 0,
		activity: "",
		queue: [], // messages waiting for the running reply: [{ text, mode }]
		dialogs: [], // questions the agent asks the user
		hasMore: false,
		loading: false,
		loadingOlder: false,
		usage: null,
	};
}

export function emptyModels() {
	return { providers: [], current: null, effort: "off", efforts: [], loaded: false };
}

export const state = {
	booted: false,
	mode: prefs.mode === "pc" ? "pc" : "local",
	pane: "chat", // drawer | chat | browser
	local: { chats: [], chatsLoaded: false, chat: emptyChat(), models: emptyModels() },
	pc: {
		chats: [],
		chatsLoaded: false,
		// The PC's chats as its sidebar groups them (pc-groups.js): one mode at a time, its Workspaces and "Default".
		listMode: savedJson(LIST_MODE_KEY) === "coding" ? "coding" : "general",
		lists: { general: emptyLists(), coding: emptyLists() },
		// Which groups are open, per mode ({ general: { [key]: bool }, coding: … }); kept on the phone.
		folds: { general: {}, coding: {}, ...(savedJson(FOLDS_KEY) || {}) },
		slots: [], // the PC's open chats (its SlotStatus list)
		chat: emptyChat(),
		models: emptyModels(),
		// paired: { name, hosts, port, deviceId, kind? } | null; status: none | connecting | online | offline;
		// route: lan | direct | relay (how the PC is reached now)
		link: { paired: null, status: "none", error: "", host: "", route: "" },
	},
	// The Google account (account.js). status: signedOut | signingIn | loading | ready | noSpace | error
	account: { status: "signedOut", email: "", name: "", pcs: [], error: "", syncedAt: 0, skipped: false },
	// Bookmarks of the PCs' browser (read only on the phone).
	pcBookmarks: [],
	browser: { tabs: [], active: null, error: null },
	toasts: [],
	layers: [],
	composerInsert: null, // { text, nonce }: text another pane hands to the composer
};

/** The side new messages go to right now. */
export const side = (s = state) => s[s.mode];

const listeners = new Set();
let scheduled = false;

export function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Tell the components that the state changed. Several calls in one task are one notification. */
export function emit() {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		for (const fn of [...listeners]) {
			try {
				fn(state);
			} catch (error) {
				console.error("state listener failed", error);
			}
		}
	});
}

export function set(patch) {
	Object.assign(state, patch);
	emit();
}

function shallowEqual(a, b) {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	for (const key of keys) if (!Object.is(a[key], b[key])) return false;
	return true;
}

/** Read part of the state. The selector may return a fresh object or array: it is compared one level deep. */
export function useStore(selector) {
	const [, force] = useState(0);
	const latest = useRef(null);
	const value = selector(state);
	latest.current = { selector, value };
	useEffect(
		() =>
			subscribe(() => {
				const next = latest.current.selector(state);
				if (!shallowEqual(next, latest.current.value)) force((n) => n + 1);
			}),
		[],
	);
	return value;
}

// ---- Toasts ------------------------------------------------------------------------------------
export function toast(message, kind = "info", ms = kind === "error" ? 6000 : 3200) {
	const id = uid("toast");
	state.toasts = [...state.toasts.slice(-2), { id, message: String(message), kind }];
	emit();
	setTimeout(() => dismissToast(id), ms);
	return id;
}

export function dismissToast(id) {
	const item = state.toasts.find((entry) => entry.id === id);
	if (!item || item.leaving) return;
	state.toasts = state.toasts.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry));
	emit();
	setTimeout(() => {
		state.toasts = state.toasts.filter((entry) => entry.id !== id);
		emit();
	}, 220);
}

/** Run something that may fail and show the reason instead of losing it. Resolves with the result or undefined. */
export async function attempt(work, { quiet = false, prefix = "" } = {}) {
	try {
		return await work();
	} catch (error) {
		console.error(error);
		if (!quiet) toast(`${prefix}${error?.message || error}`, "error");
		return undefined;
	}
}
