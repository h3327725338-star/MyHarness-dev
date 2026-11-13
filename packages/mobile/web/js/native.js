// The one place that talks to the Android shell (`window.MyHarnessNative`, see MainActivity.java). In a desktop browser
// (dev-server.mjs) every call has the closest stand-in a web page allows, so the page can be worked on without a phone.

const bridge = globalThis.MyHarnessNative || null;
export const isNative = !!bridge;

export const nativeInfo = globalThis.__MH_NATIVE_INFO__ || {
	version: "dev",
	versionCode: 0,
	debug: true,
	sdk: 0,
	android: "",
	device: "Browser",
	language: navigator.language,
	systemDark: globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
	insets: { top: 0, bottom: 0, left: 0, right: 0, keyboard: 0 },
};

// ---- Events from the shell ---------------------------------------------------------------------
const listeners = new Map();

/** Listen to one channel of shell events (`http`, `browser`, `insets`, `scan`, `share`, `lifecycle`, `openUrl`). */
export function onNative(channel, fn) {
	let set = listeners.get(channel);
	if (!set) listeners.set(channel, (set = new Set()));
	set.add(fn);
	return () => set.delete(fn);
}

function dispatch(channel, payload) {
	const set = listeners.get(channel);
	if (!set) return;
	for (const fn of [...set]) {
		try {
			fn(payload);
		} catch (error) {
			console.error(`native event ${channel} failed`, error);
		}
	}
}
globalThis.__mhNativeEvent = dispatch;
/** Lets the dev stand-ins (and tests) raise an event as the shell would. */
export const emitNative = dispatch;

// ---- Insets ------------------------------------------------------------------------------------
export const insets = { top: 0, bottom: 0, left: 0, right: 0, keyboard: 0, ...(nativeInfo.insets || {}) };
const insetListeners = new Set();
export function onInsets(fn) {
	insetListeners.add(fn);
	return () => insetListeners.delete(fn);
}
const written = {};
function applyInsets(next) {
	Object.assign(insets, next);
	const style = document.documentElement.style;
	const put = (name, px) => {
		const value = `${px}px`;
		if (written[name] === value) return false;
		written[name] = value;
		style.setProperty(name, value);
		return true;
	};
	let changed = false;
	for (const side of ["top", "bottom", "left", "right"]) changed = put(`--inset-${side}`, Number(insets[side]) || 0) || changed;
	// Whole pixels: a fraction of a pixel per frame would lay the page out again for nothing that can be seen.
	changed = put("--kb", Math.round(Math.max(0, Number(insets.keyboard) || 0))) || changed;
	if (!changed) return;
	document.documentElement.classList.toggle("kb-open", (Number(insets.keyboard) || 0) > 40);
	for (const fn of [...insetListeners]) fn(insets);
}
onNative("insets", applyInsets);
if (!isNative && globalThis.visualViewport) {
	// A desktop browser has no system bars; an on-screen keyboard (a phone's browser) shows as a shorter visual viewport.
	const sync = () => applyInsets({ keyboard: Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) });
	visualViewport.addEventListener("resize", sync);
}

// ---- Back key ----------------------------------------------------------------------------------
const backStack = [];
/** While registered, the system back key calls `fn` instead of what is below it. Returns the function that removes it. */
export function pushBack(fn) {
	const entry = { fn };
	backStack.push(entry);
	return () => {
		const at = backStack.indexOf(entry);
		if (at >= 0) backStack.splice(at, 1);
	};
}
globalThis.__mhBack = () => {
	for (let i = backStack.length - 1; i >= 0; i--) {
		try {
			if (backStack[i].fn() !== false) return true;
		} catch (error) {
			console.error("back handler failed", error);
		}
	}
	return false;
};
if (!isNative) {
	addEventListener("keydown", (event) => {
		if (event.key === "Escape" && globalThis.__mhBack()) event.preventDefault();
	});
}

// ---- HTTP through the shell --------------------------------------------------------------------
// Pages inside a WebView cannot call other sites (CORS, and this page's own Content-Security-Policy). The shell makes
// the request with its HTTP client and streams the answer back; the page sees an ordinary `Response`.
const originalFetch = globalThis.fetch.bind(globalThis);
const httpPending = new Map();
let httpSeq = 0;

function bytesToBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}
export function base64ToBytes(text) {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
export { bytesToBase64 };

async function normalizeRequest(input, init = {}) {
	const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
	const url = request ? request.url : String(input);
	const method = String(init.method || request?.method || "GET").toUpperCase();
	const headers = {};
	const take = (source) => {
		if (!source) return;
		if (source instanceof Headers) source.forEach((value, name) => (headers[name] = value));
		else if (Array.isArray(source)) for (const [name, value] of source) headers[String(name).toLowerCase()] = String(value);
		else for (const [name, value] of Object.entries(source)) if (value != null) headers[name.toLowerCase()] = String(value);
	};
	take(request?.headers);
	take(init.headers);
	let bodyText = null;
	let bodyBase64 = null;
	let body = init.body;
	if (body == null && request && method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();
	if (body != null) {
		if (typeof body === "string") bodyText = body;
		else if (body instanceof URLSearchParams) {
			bodyText = body.toString();
			headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
		} else if (body instanceof ArrayBuffer) bodyBase64 = bytesToBase64(new Uint8Array(body));
		else if (ArrayBuffer.isView(body)) bodyBase64 = bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
		else if (body instanceof Blob) {
			bodyBase64 = bytesToBase64(new Uint8Array(await body.arrayBuffer()));
			if (body.type) headers["content-type"] ??= body.type;
		} else throw new TypeError("This request body type is not supported");
	}
	return { url, method, headers, bodyText, bodyBase64, signal: init.signal || request?.signal };
}

function abortError() {
	return new DOMException("The request was aborted", "AbortError");
}

function makeResponse(stream, { status, statusText, headers, url }) {
	const nullBody = status === 204 || status === 205 || status === 304 || status < 200;
	const response = new Response(nullBody ? null : stream, { status: status >= 200 && status <= 599 ? status : 502, statusText: statusText || "", headers });
	try {
		Object.defineProperty(response, "url", { value: url || "" });
	} catch {
		// The address stays empty; nothing here depends on it.
	}
	return response;
}

function nativeHttp(request) {
	return new Promise((resolve, reject) => {
		if (request.signal?.aborted) return reject(abortError());
		const id = `h${++httpSeq}`;
		let controller;
		let settled = false;
		let finished = false;
		const stream = new ReadableStream({
			start(c) {
				controller = c;
			},
			cancel() {
				finish();
				bridge.httpAbort(id);
			},
		});
		const finish = () => {
			finished = true;
			httpPending.delete(id);
			request.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			if (finished) return;
			bridge.httpAbort(id);
			finish();
			if (!settled) {
				settled = true;
				reject(abortError());
			} else {
				try {
					controller.error(abortError());
				} catch {
					// Already closed.
				}
			}
		};
		request.signal?.addEventListener("abort", onAbort);
		httpPending.set(id, (message) => {
			if (finished) return;
			if (message.type === "head") {
				settled = true;
				resolve(makeResponse(stream, message));
			} else if (message.type === "chunk") {
				try {
					controller.enqueue(base64ToBytes(message.data));
				} catch {
					// The reader went away.
				}
			} else if (message.type === "end") {
				finish();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			} else if (message.type === "error") {
				finish();
				const error = new TypeError(message.message || "Network request failed");
				error.kind = message.kind;
				if (!settled) {
					settled = true;
					reject(error);
				} else {
					try {
						controller.error(error);
					} catch {
						// Already closed.
					}
				}
			}
		});
		bridge.httpStart(id, request.method, request.url, JSON.stringify(request.headers), request.bodyText, request.bodyBase64);
	});
}
onNative("http", (message) => httpPending.get(message.id)?.(message));

async function devHttp(request) {
	const answer = await originalFetch("/__native/http", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ method: request.method, url: request.url, headers: request.headers, bodyText: request.bodyText, bodyBase64: request.bodyBase64 }),
		signal: request.signal,
	});
	const failure = answer.headers.get("x-mh-error");
	if (failure) throw new TypeError(decodeURIComponent(failure));
	if (!answer.ok && !answer.headers.get("x-mh-status")) throw new TypeError(`The preview server refused the request (${answer.status})`);
	let headers = [];
	try {
		headers = JSON.parse(new TextDecoder().decode(base64ToBytes(answer.headers.get("x-mh-headers") || "W10=")));
	} catch {
		headers = [];
	}
	return makeResponse(answer.body, { status: Number(answer.headers.get("x-mh-status")) || 502, statusText: "", headers, url: decodeURIComponent(answer.headers.get("x-mh-url") || request.url) });
}

/** `fetch` for any address on the internet or the local network, made by the app itself (no CORS). */
export async function httpFetch(input, init) {
	const request = await normalizeRequest(input, init);
	return isNative ? nativeHttp(request) : devHttp(request);
}

function sameOrigin(input) {
	try {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
		return url.origin === location.origin || url.protocol === "blob:" || url.protocol === "data:";
	} catch {
		return true;
	}
}
// The model SDKs call the global `fetch`: requests to other sites take the shell's route, the page's own files do not.
globalThis.fetch = (input, init) => (sameOrigin(input) ? originalFetch(input, init) : httpFetch(input instanceof URL ? input.href : input, init));

// ---- Secrets -----------------------------------------------------------------------------------
// API keys and the PC link key. In the app they are encrypted with a key held by the Android Keystore; the browser
// preview only has localStorage.
const SECRET_PREFIX = "myharness.mobile.secret.";
export function secretGet(name) {
	try {
		return (isNative ? bridge.secretGet(name) : localStorage.getItem(SECRET_PREFIX + name)) || "";
	} catch {
		return "";
	}
}
export function secretSet(name, value) {
	if (!value) return secretDelete(name), true;
	try {
		if (isNative) return !!bridge.secretSet(name, String(value));
		localStorage.setItem(SECRET_PREFIX + name, String(value));
		return true;
	} catch {
		return false;
	}
}
export function secretDelete(name) {
	try {
		if (isNative) bridge.secretDelete(name);
		else localStorage.removeItem(SECRET_PREFIX + name);
	} catch {
		// Nothing was stored.
	}
}

// ---- Built-in browser --------------------------------------------------------------------------
const browserPending = new Map();
let browserSeq = 0;
const devTabs = new Map();
let devActive = null;

function devTabState(id) {
	const tab = devTabs.get(id);
	return { id, url: tab.url, title: tab.title, canGoBack: tab.at > 0, canGoForward: tab.at < tab.history.length - 1, progress: 100 };
}
function devList() {
	return { tabs: [...devTabs.keys()].map(devTabState), active: devActive };
}
/** The browser preview has no web views: tabs only remember their address, so the pane's controls can be worked on. */
function devBrowser(input) {
	const { action, id } = input;
	const tab = devTabs.get(id);
	const announce = (tabId, loading = false) => setTimeout(() => devTabs.has(tabId) && dispatch("browser", { type: "state", ...devTabState(tabId), loading }), 30);
	const go = (target, url) => {
		target.history = target.history.slice(0, target.at + 1).concat(url);
		target.at = target.history.length - 1;
		target.url = url;
		try {
			target.title = new URL(url).hostname;
		} catch {
			target.title = url;
		}
	};
	if (action === "create") {
		const created = { url: "", title: "", history: [], at: -1 };
		devTabs.set(id, created);
		if (input.url) go(created, input.url);
		if (input.activate !== false) devActive = id;
		announce(id);
	} else if (action === "close") {
		devTabs.delete(id);
		if (devActive === id) devActive = [...devTabs.keys()].pop() ?? null;
	} else if (action === "activate") devActive = devTabs.has(id) ? id : devActive;
	else if (action === "load" && tab) {
		go(tab, input.url);
		announce(id);
	} else if ((action === "back" || action === "forward") && tab) {
		tab.at = Math.max(0, Math.min(tab.history.length - 1, tab.at + (action === "back" ? -1 : 1)));
		tab.url = tab.history[tab.at] || "";
		announce(id);
	} else if (action === "reload" && tab) announce(id);
	else if (action === "evaluate") {
		setTimeout(() => dispatch("browser", { type: "evaluate", request: input.request, id, error: "The browser preview cannot read pages; this works in the app." }), 20);
	} else if (action === "screenshot") {
		setTimeout(() => dispatch("browser", { type: "screenshot", request: input.request, id, error: "The browser preview cannot capture pages; this works in the app." }), 20);
	} else if (action === "clearData") devTabs.forEach((value) => Object.assign(value, { history: value.url ? [value.url] : [], at: value.url ? 0 : -1 }));
	return devList();
}

/**
 * One command for the built-in browser (BrowserController.java). Resolves with `{tabs, active}`; `evaluate` resolves
 * with the script's value (parsed from JSON) and `screenshot` with `{mimeType, data}`.
 */
export function browserCommand(action, params = {}) {
	return new Promise((resolve, reject) => {
		const request = `b${++browserSeq}`;
		const want = action === "evaluate" || action === "screenshot" ? action : "result";
		const timer = setTimeout(() => {
			browserPending.delete(request);
			reject(new Error("The browser did not answer"));
		}, want === "result" ? 8000 : 20000);
		browserPending.set(request, { want, resolve, reject, timer });
		const input = { ...params, action, request };
		if (isNative) bridge.browser(JSON.stringify(input));
		else {
			const answer = devBrowser(input);
			setTimeout(() => dispatch("browser", { ...answer, type: "result", request }), 0);
		}
	});
}
onNative("browser", (message) => {
	const pending = message.request && browserPending.get(message.request);
	if (!pending) return;
	if (message.type === "result" && message.error) {
		clearTimeout(pending.timer);
		browserPending.delete(message.request);
		pending.reject(new Error(message.error));
		return;
	}
	if (message.type !== pending.want) return;
	clearTimeout(pending.timer);
	browserPending.delete(message.request);
	if (message.type === "result") pending.resolve(message);
	else if (message.error) pending.reject(new Error(message.error));
	else if (message.type === "evaluate") {
		let value = message.value;
		try {
			value = JSON.parse(message.value);
		} catch {
			// Not JSON: the text as it is.
		}
		pending.resolve(value);
	} else pending.resolve(message);
});

/** How far the browser pane is slid to the right, in CSS px (0 = fully shown). Called every frame while a finger moves it. */
let sentOffset = null;
export function setBrowserOffset(px) {
	// The drawer's slide calls this for every frame with the same number: the app is only told when it changed.
	const next = Math.round(px * 2) / 2;
	if (next === sentOffset) return;
	sentOffset = next;
	if (isNative) bridge.browserOffset(next);
}
/** Whether the shown tab went back a page (the back key asks this before the page handles it). */
export function browserBack() {
	return isNative ? !!bridge.browserBack() : false;
}

// ---- Small things ------------------------------------------------------------------------------
let hapticsOn = true;
export function setHaptics(on) {
	hapticsOn = on !== false;
}
export function haptic(kind = "tick") {
	if (!hapticsOn) return;
	try {
		if (isNative) bridge.haptic(kind);
	} catch {
		// No vibration on this device.
	}
}
export async function copyText(text) {
	try {
		if (isNative) bridge.copy(String(text));
		else await navigator.clipboard.writeText(String(text));
		return true;
	} catch {
		return false;
	}
}
export function shareText(text) {
	if (isNative) bridge.share(String(text));
	else if (navigator.share) navigator.share({ text: String(text) }).catch(() => {});
	else copyText(text);
}
export function openExternal(url) {
	if (isNative) bridge.openExternal(String(url));
	else globalThis.open(String(url), "_blank", "noopener");
}
/**
 * Start waiting for Google's sign-in page to send the browser back to this phone's loopback address
 * (OAuthLoopback.java). Returns the port, or 0 when it cannot; the answer arrives as an `oauth` event
 * (`{ port, query }` or `{ port, error }`).
 */
export function oauthListen() {
	if (!isNative || typeof bridge.oauthListen !== "function") return 0;
	try {
		return Number(bridge.oauthListen()) || 0;
	} catch {
		return 0;
	}
}
export function oauthStop() {
	try {
		if (isNative && typeof bridge.oauthStop === "function") bridge.oauthStop();
	} catch {
		// Nothing was waiting.
	}
}
/** Opens the camera to read a QR code; the text arrives as a `scan` event (empty when the user backed out). */
export function scanQr() {
	if (isNative) bridge.scanQr();
	else setTimeout(() => dispatch("scan", { text: "" }), 0);
}
export const canScan = isNative;
/** Saves bytes to the phone's Downloads folder; resolves with where it went. */
export async function saveFile(name, mimeType, base64) {
	if (isNative) {
		const path = bridge.saveFile(name, mimeType, base64);
		if (!path) throw new Error("The file could not be saved");
		return path;
	}
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: mimeType }));
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 10000);
	return name;
}
/** While a reply is being written, the app keeps a notification so Android does not stop it in the background. */
const runOwners = new Map(); // who has a reply being written (the phone's own agent, the PC side) → its title
export function runActive(active, title = "", owner = "local") {
	if (active) runOwners.set(owner, String(title));
	else if (!runOwners.delete(owner)) return;
	const titles = [...runOwners.values()];
	if (isNative) bridge.runActive(titles.length > 0, titles[titles.length - 1] || "");
}
export function notifyDone(title, text) {
	if (isNative) bridge.notifyDone(String(title), String(text));
}
/** Colour of the system bars' icons and of the window behind the page. */
export function setChrome(dark, background) {
	if (isNative) bridge.setChrome(JSON.stringify({ dark: !!dark, background }));
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
}
export function leaveApp() {
	if (isNative) bridge.leave();
}
/** Tell the shell the page listens now: it sends the current insets and anything shared to the app while it started. */
export function nativeReady() {
	if (isNative) bridge.ready();
}
