// The PC side: what the phone types is sent to MyHarness on the user's PC and the reply is shown here as it is
// written. The phone talks to the PC's phone link (packages/coding-agent/src/modes/web/phone-link/gateway.ts); every
// message is sealed with the phone's key (link-crypto.js). The phone is a remote control: the chats, the model, the
// tools and the files are the PC's.
//
// Two kinds of PC: one paired with its QR code (reached on the local network only), and one of the Google account the
// phone is signed in with (account.js), reached from any network: on the local network when the PC listens there,
// else over a direct WebRTC connection, else through files in the account's Drive (link-remote.js). The requests and
// answers are the same sealed messages on every route.
import { t } from "/shared/i18n.js";
import { fileToBase64, UPLOAD_MAX_BYTES } from "./attachments.js";
import { addPending, applyEvent, markDelivered, removePending } from "./live.js";
import { accountLink, onAccountPcs, onAccountView } from "./account.js";
import { importKey, linkAad, open, parsePairing, seal } from "./link-crypto.js";
import { openDirect, openRelay } from "./link-remote.js";
import { httpFetch, nativeInfo, onNative, secretDelete, secretGet, secretSet } from "./native.js";
import { chatModeOf, DEFAULT_KEY, emptyLists, isOpen, pathKey } from "./pc-groups.js";
import { emit, emptyChat, emptyModels, FOLDS_KEY, LIST_MODE_KEY, saveJson, state, toast } from "./store.js";

const LINK_KEY = "myharness.mobile.link";
const SLOT_KEY = "myharness.mobile.link.slot";
const PAGE = 120;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
// Faster routes first: a later one that opens is used instead of a slower one already in use.
const ROUTE_RANK = { lan: 0, direct: 1, relay: 2 };
// How long the PC may take to answer the first request on a route (the relay goes through Drive twice).
const OPEN_WAIT_MS = { direct: 15000, relay: 45000 };
// In the background longer than this, the connection is closed; it opens again when the app comes back.
const HIDDEN_REST_MS = 60000;
const AUTO_OFF_KEY = "myharness.mobile.link.noAuto";
// On the relay, the faster routes are tried again this often (and when the phone's network changes).
const DIRECT_RETRY_MS = 120000;

let config = null; // QR: { name, hosts, port, deviceId }; account: { kind: "account", pcId, name, deviceId, hosts, port }
let transport = null; // a remote pipe (link-remote.js) while the PC is reached that way; null on the local network
let key = null;
let host = "";
let session = "";
let counter = 0;
let opening = null;
let stream = null; // AbortController of the event stream
let retryTimer = 0;
let retries = 0;
let hiddenTimer = 0;
let directTimer = 0;
let directTrying = false;
let generation = 0; // grows with every connect and unpair: late answers of an older link are ignored

const bags = new Map(); // slot id → chat object (store.js: emptyChat) with { slot, loaded, cursor, cwd }
let slots = []; // the PC's open chats (SlotStatus)
let activeSlot = "";

function setLink(patch) {
	state.pc.link = { ...state.pc.link, ...patch };
	emit();
}

class LinkFailure extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

function loadConfig() {
	try {
		const saved = JSON.parse(localStorage.getItem(LINK_KEY) || "null");
		if (saved?.kind === "account" && saved.pcId && saved.deviceId) return { hosts: [], port: 0, ...saved };
		if (saved && Array.isArray(saved.hosts) && saved.deviceId) return saved;
	} catch {
		// No link saved.
	}
	return null;
}

/** The key of the current PC: its QR code's, or the account's (a new one after every sign-in). */
function keyTextOf(saved) {
	return saved?.kind === "account" ? accountLink()?.keyText || "" : secretGet("link.key");
}

function dropTransport() {
	const pipe = transport;
	transport = null;
	try {
		pipe?.close();
	} catch {
		// Already closed.
	}
}

// ---- Sealed requests ---------------------------------------------------------------------------
const base = (address = host) => `http://${address}:${config.port}/link/v1`;

async function envelope(operation, payload) {
	const sealed = await seal(key, linkAad(operation, "req", config.deviceId), payload);
	return { body: { d: config.deviceId, ...sealed }, nonce: sealed.n };
}

/** One sealed `open` or `call`, on the current route or on the one given. Resolves with `{ status, body, nonce }`. */
async function exchange(operation, payload, { address, pipe = transport, timeoutMs } = {}) {
	const { body, nonce } = await envelope(operation, payload);
	if (pipe && !address) {
		const answer = await pipe.request(operation, body, timeoutMs);
		return { status: answer.status, body: answer.body, nonce };
	}
	const response = await httpFetch(`${base(address)}/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	let json = null;
	try {
		json = JSON.parse(await response.text());
	} catch {
		json = null;
	}
	return { status: response.status, body: json, nonce };
}

function failure(status, body) {
	const reason = body?.error || "";
	if (status === 403) return new LinkFailure(config?.kind === "account" ? t("The PC does not accept this phone right now. On the PC, check Settings → Phone: remote connections must be on and this phone must not be removed.") : t("The PC no longer accepts this phone. Pair again from Settings on the PC."), 403);
	if (status === 429) return new LinkFailure(t("The PC refused several attempts in a row. Wait a few minutes and try again."), 429);
	return new LinkFailure(reason || `HTTP ${status}`, status);
}

async function probe(address) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	try {
		const response = await httpFetch(`${base(address)}/ping`, { signal: controller.signal });
		return response.ok && (await response.json()).ok === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** The local network address an account PC listens on now (it may change while the phone is connected). */
function freshLan() {
	if (config?.kind !== "account") return;
	const presence = (state.account?.pcs || []).find((entry) => entry.id === config.pcId);
	if (presence?.lan) config = { ...config, hosts: presence.lan.addresses, port: presence.lan.port };
	else if (presence) config = { ...config, hosts: [], port: 0 };
}

/** The PC's local network address that answers, or "". All are tried at once (Wi-Fi, cable, virtual adapters). */
async function findLan() {
	const candidates = config.port ? [...new Set([state.pc.link.host, ...config.hosts].filter(Boolean))] : [];
	let found = "";
	await Promise.all(
		candidates.map(async (address) => {
			if ((await probe(address)) && !found) found = address;
		}),
	);
	return found;
}

/** The `open` request on one route (`{ address }` or `{ pipe, timeoutMs }`): resolves with the PC's opened answer. */
async function openOn(route) {
	const opened = await exchange("open", { name: nativeInfo.device || "Phone", app: nativeInfo.version }, route);
	if (opened.status !== 200) throw failure(opened.status, opened.body);
	return open(key, linkAad("open", "res", config.deviceId, opened.nonce), opened.body);
}

async function openPipe(route, pipe) {
	try {
		return { route, host: "", pipe, answer: await openOn({ pipe, timeoutMs: OPEN_WAIT_MS[route] }) };
	} catch (error) {
		pipe.close();
		throw error;
	}
}

function watchPipe(pipe) {
	pipe.onClose(() => {
		if (transport !== pipe) return;
		transport = null;
		session = "";
	});
}

/**
 * Every route to a PC of the account at once: its local network address, a direct WebRTC connection and the relay
 * through Drive. The first that opens a session is used; a faster one that opens later takes over (`upgrade`), a
 * slower one is closed. Waiting for the direct connection to fail before trying the relay took half a minute on mobile
 * data, where a direct path rarely exists without a TURN server. Resolves with `{ route, host, pipe, answer }`.
 */
function raceRoutes(mine) {
	const link = accountLink();
	if (!link) return Promise.reject(new LinkFailure(t("Sign in with Google first."), 0));
	const since = Date.now();
	const trying = new Set();
	const show = () => {
		if (mine === generation && state.pc.link.status === "connecting") setLink({ trying: [...trying], since });
	};
	const stopDirect = new AbortController();
	const target = { drive: link.drive, pcId: config.pcId, phoneId: config.deviceId };
	// Drive's folders are found once per app start; both remote routes need them.
	const ready = link.drive.ready();
	let relayPipe = null;
	const routes = [];
	if (config.port && (config.hosts.length || state.pc.link.host))
		routes.push([
			"lan",
			async () => {
				const found = await findLan();
				if (!found) throw new LinkFailure(t("Not on the PC's local network."), 0);
				return { route: "lan", host: found, pipe: null, answer: await openOn({ address: found }) };
			},
		]);
	if (typeof globalThis.RTCPeerConnection === "function")
		routes.push([
			"direct",
			async () => {
				await ready;
				let pipe;
				try {
					pipe = await openDirect({ ...target, key, RTCPeerConnection: globalThis.RTCPeerConnection, signal: stopDirect.signal });
				} catch (error) {
					if (mine === generation) noteDirect(error);
					throw error;
				}
				noteDirect(null);
				return openPipe("direct", pipe);
			},
		]);
	routes.push([
		"relay",
		async () => {
			await ready;
			relayPipe = openRelay(target);
			return openPipe("relay", relayPipe);
		},
	]);
	return new Promise((resolve, reject) => {
		let winner = null;
		let settled = 0;
		let reason = null;
		const done = (route) => {
			trying.delete(route);
			settled += 1;
			show();
			if (settled === routes.length && !winner) reject(reason || new LinkFailure(t("The PC cannot be reached."), 0));
		};
		for (const [route, run] of routes) {
			trying.add(route);
			run().then(
				(result) => {
					if (!winner && mine === generation) {
						winner = result;
						// A faster route won: the slower attempts stop (the direct one only loses to the local network).
						if (route !== "relay") relayPipe?.close();
						if (route === "lan") stopDirect.abort();
						resolve(result);
					} else if (winner && ROUTE_RANK[route] < ROUTE_RANK[winner.route] && mine === generation && session === winner.answer.s) {
						winner = result;
						upgrade(result);
					} else result.pipe?.close();
					done(route);
				},
				(error) => {
					// The relay's reason counts most (it works whenever Drive does); a refusal by the PC counts above all.
					if (!reason || route === "relay" || error?.status === 403 || error?.status === 429) {
						if (!(reason?.status === 403 || reason?.status === 429)) reason = error;
					}
					done(route);
				},
			);
		}
		show();
	});
}

/** Use the route a session was opened on. */
function adopt(result, mine) {
	if (mine !== generation) {
		if (result.pipe && result.pipe !== transport) result.pipe.close();
		throw new LinkFailure("superseded", 0);
	}
	if (result.pipe !== transport) {
		dropTransport();
		transport = result.pipe;
		if (transport) watchPipe(transport);
	}
	host = result.host || "";
	session = result.answer.s;
	counter = 0;
	const answer = result.answer;
	if (answer.pc?.name && answer.pc.name !== config.name) {
		config = { ...config, name: answer.pc.name };
		localStorage.setItem(LINK_KEY, JSON.stringify(config));
	}
	setLink({ route: result.route, trying: [], paired: config, host, pcVersion: answer.pc?.version || "" });
	if (result.route === "relay") scheduleFaster();
	else clearTimeout(directTimer);
}

/** A faster route opened after the PC was reached another way: requests and events move to it. */
function upgrade(result) {
	const old = transport;
	generation++;
	const mine = generation;
	stream?.abort();
	stream = null;
	transport = result.pipe;
	if (transport) watchPipe(transport);
	host = result.host || "";
	session = result.answer.s;
	counter = 0;
	setLink({ route: result.route, host });
	if (result.route !== "relay") clearTimeout(directTimer);
	runStream(mine, { moved: true });
	// Requests still on their way over the old route finish there; it is closed once they had the time to.
	if (old && old !== transport) setTimeout(() => old.close(), 20000);
}

/**
 * What the last direct attempt found, for Settings → PC connection (`link.direct`): null when it opened, else the error
 * of openDirect, whose `direct` part says how far it got and which kinds of addresses each side offered.
 */
function noteDirect(error) {
	if (error?.message === "Cancelled.") return;
	setLink({ direct: { at: Date.now(), ok: !error, reason: error ? directReason(error) : "" } });
}

function directReason(error) {
	const info = error?.direct;
	if (!info || info.stage === "offer" || info.stage === "answer") return t(error?.message || "The PC cannot be reached.");
	if (info.phone && !info.phone.ipv6) return t("No direct path: this phone's network gave it no IPv6 address, and over IPv4 the address sharing of the carrier or router blocks it.");
	if (info.pc && !info.pc.ipv6) return t("No direct path: the PC's network gave it no IPv6 address, and over IPv4 the address sharing on the way blocks it.");
	return t("No direct path: both sides have IPv6, but a firewall on the way (router or carrier) blocked it.");
}

function scheduleFaster(delay = DIRECT_RETRY_MS) {
	clearTimeout(directTimer);
	directTimer = setTimeout(tryFaster, delay);
}

/**
 * On the relay, the local network and a direct connection are tried again; when one opens, requests and events move
 * to it (`upgrade`). A phone on mobile data that walks into the PC's Wi-Fi, or gets IPv6, gets the faster route.
 */
async function tryFaster() {
	const link = accountLink();
	const usable = () => config?.kind === "account" && key && state.pc.link.route === "relay" && state.pc.link.status === "online" && document.visibilityState === "visible";
	if (directTrying || !link || !usable()) return;
	directTrying = true;
	const mine = generation;
	try {
		freshLan();
		const found = config.port ? await findLan() : "";
		if (found && mine === generation && usable()) {
			const answer = await openOn({ address: found });
			if (mine === generation && usable()) upgrade({ route: "lan", host: found, pipe: null, answer });
			return;
		}
		if (typeof globalThis.RTCPeerConnection !== "function") return;
		await link.drive.ready();
		let pipe;
		try {
			pipe = await openDirect({ drive: link.drive, pcId: config.pcId, phoneId: config.deviceId, key, RTCPeerConnection: globalThis.RTCPeerConnection });
		} catch (error) {
			if (mine === generation) noteDirect(error);
			return;
		}
		noteDirect(null);
		const result = await openPipe("direct", pipe);
		if (mine === generation && usable()) upgrade(result);
		else result.pipe.close();
	} catch {
		// The relay goes on; the next try is in a while.
	} finally {
		directTrying = false;
		if (mine === generation && state.pc.link.route === "relay") scheduleFaster();
	}
}

/** Find a route to the PC that answers and open a session there. */
async function openSession() {
	opening ??= (async () => {
		const mine = generation;
		freshLan();
		let result;
		if (transport) result = { route: transport.transport, host: "", pipe: transport, answer: await openOn({ pipe: transport }) };
		else if (config.kind === "account") result = await raceRoutes(mine);
		else {
			const found = await findLan();
			if (mine !== generation) throw new LinkFailure("superseded", 0);
			if (!found) throw new LinkFailure(t("The PC cannot be reached. Is it on, with MyHarness open and the phone link turned on, on the same network?"), 0);
			result = { route: "lan", host: found, pipe: null, answer: await openOn({ address: found }) };
		}
		adopt(result, mine);
	})().finally(() => {
		opening = null;
	});
	return opening;
}

/** One request to the PC's MyHarness (a route of its Web UI server that the phone link allows). Resolves with the JSON answer. */
async function call(method, path, body, slot = activeSlot, { raw = false } = {}) {
	if (!config) throw new LinkFailure(t("No PC is paired yet."), 0);
	for (let attempt = 0; ; attempt++) {
		if (!session) await openSession();
		const reply = await exchange("call", { s: session, q: ++counter, m: method, p: path, slot: slot || undefined, b: body });
		if (reply.status === 401 && attempt === 0) {
			// The PC restarted or the session aged out: a new one is opened once.
			session = "";
			continue;
		}
		if (reply.status !== 200) throw failure(reply.status, reply.body);
		const answer = await open(key, linkAad("call", "res", config.deviceId, reply.nonce), reply.body);
		if (raw) return answer;
		if (answer.status >= 400) throw new LinkFailure(answer.json?.error || `HTTP ${answer.status}`, answer.status);
		return answer.json;
	}
}

// ---- Chats -------------------------------------------------------------------------------------
function bagFor(slot) {
	let bag = bags.get(slot);
	if (!bag) {
		bag = emptyChat();
		bag.id = slot;
		bag.slot = slot;
		bag.loaded = false;
		bags.set(slot, bag);
	}
	return bag;
}

const slotTitle = (status) => status.name || (status.firstMessage || "").split("\n")[0].slice(0, 60) || t("New chat");

/** The PC's open chats changed (or a list): the drawer draws the groups again (pc-groups.js). */
function publishChats() {
	state.pc.slots = slots;
	state.pc.chatsLoaded = state.pc.lists[state.pc.listMode].loaded;
	emit();
}

// ---- The PC's chat lists, grouped as its sidebar groups them ---------------------------------------------------
// One mode at a time is read (the one the drawer shows): its Workspaces, its chats without a Workspace ("Default"), the
// chats scheduled tasks started, and the chats of each Workspace whose group is open. A Workspace's chats are read when
// its group is opened; more rows when the user asks for them.
const LIST_PAGE = 60;
const LIST_MAX = 200;
let searching = false;

const withoutKey = (record, key) => {
	const next = { ...record };
	delete next[key];
	return next;
};

function patchLists(mode, patch) {
	state.pc.lists = { ...state.pc.lists, [mode]: { ...state.pc.lists[mode], ...patch } };
}

/** The Workspace of the chat on screen, when it is of that mode. */
function currentRoot(mode) {
	const bag = state.pc.chat;
	return bag && chatModeOf(bag.mode) === mode ? bag.root || "" : "";
}

function wantsSessions(mode, root) {
	return searching || isOpen(state.pc.folds[mode], root, { current: !!root && pathKey(currentRoot(mode)) === pathKey(root) });
}

/** Rows of one more page, without the ones already there (a chat that moved up between two pages). */
function merged(before, more) {
	const known = new Set((before || []).map((row) => pathKey(row.path)));
	return [...(before || []), ...(more || []).filter((row) => !known.has(pathKey(row.path)))];
}

async function loadLists(mode = state.pc.listMode) {
	const mine = generation;
	const before = state.pc.lists[mode];
	const failed = (error) => ({ failed: error?.message || String(error) });
	const [workspaces, unbound, scheduled] = await Promise.all([
		call("GET", `/api/workspaces?mode=${mode}`).catch(failed),
		call("GET", `/api/sessions/unbound?mode=${mode}&limit=${Math.min(LIST_MAX, Math.max(LIST_PAGE, before.unbound?.length || 0))}`).catch(failed),
		// A PC from before phones could read this list refuses it: its scheduled chats then stay in their groups.
		call("GET", `/api/sessions/scheduled?mode=${mode}`).catch((error) => (error?.status === 403 ? { refused: true } : failed(error))),
	]);
	if (mine !== generation) return;
	const errors = { ...before.errors };
	const patch = { loaded: true, error: workspaces.failed || "" };
	if (!workspaces.failed) patch.workspaces = (workspaces.workspaces || []).map((entry) => ({ name: entry.name, rootPath: entry.rootPath, missing: !!entry.missing }));
	if (unbound.failed) errors[DEFAULT_KEY] = unbound.failed;
	else {
		delete errors[DEFAULT_KEY];
		patch.unbound = unbound.sessions || [];
		patch.unboundTotal = typeof unbound.total === "number" ? unbound.total : patch.unbound.length;
	}
	if (scheduled.refused) patch.scheduled = null;
	else if (!scheduled.failed) patch.scheduled = scheduled.sessions || [];
	// Workspace lists read before are kept for the open groups (read again below) and dropped for the others (read when
	// opened), so a folded group does not show an old list.
	const roots = (patch.workspaces || before.workspaces).map((entry) => entry.rootPath);
	const sessions = {};
	const totals = {};
	for (const root of roots)
		if (before.sessions[root] !== undefined && wantsSessions(mode, root)) {
			sessions[root] = before.sessions[root];
			totals[root] = before.totals[root];
		}
	patchLists(mode, { ...patch, errors, sessions, totals });
	publishChats();
	await Promise.all(roots.filter((root) => wantsSessions(mode, root)).map((root) => loadWorkspace(mode, root)));
}

async function loadWorkspace(mode, root, { more = false } = {}) {
	const mine = generation;
	const have = state.pc.lists[mode].sessions[root];
	const offset = more && have ? have.length : 0;
	const limit = more ? LIST_PAGE : Math.min(LIST_MAX, Math.max(LIST_PAGE, have?.length || 0));
	try {
		const answer = await call("GET", `/api/workspaces/sessions?path=${encodeURIComponent(root)}&mode=${mode}&limit=${limit}&offset=${offset}`);
		if (mine !== generation) return;
		const now = state.pc.lists[mode];
		const rows = more ? merged(now.sessions[root], answer.sessions) : answer.sessions || [];
		patchLists(mode, { sessions: { ...now.sessions, [root]: rows }, totals: { ...now.totals, [root]: typeof answer.total === "number" ? answer.total : rows.length }, errors: withoutKey(now.errors, root) });
	} catch (error) {
		if (mine !== generation) return;
		patchLists(mode, { errors: { ...state.pc.lists[mode].errors, [root]: error?.message || String(error) } });
	}
	publishChats();
}

async function loadMoreDefault(mode) {
	const mine = generation;
	const have = state.pc.lists[mode].unbound || [];
	try {
		const answer = await call("GET", `/api/sessions/unbound?mode=${mode}&limit=${LIST_PAGE}&offset=${have.length}`);
		if (mine !== generation) return;
		const now = state.pc.lists[mode];
		const rows = merged(now.unbound, answer.sessions);
		patchLists(mode, { unbound: rows, unboundTotal: typeof answer.total === "number" ? answer.total : rows.length });
	} catch (error) {
		toast(error?.message || String(error), "error");
	}
	publishChats();
}

let listsTimer = 0;
/** Something changed on the PC (a reply ended, a Workspace was added): the lists are read again in a moment. */
function refreshListsSoon(delay = 800) {
	clearTimeout(listsTimer);
	listsTimer = setTimeout(() => {
		const shown = state.pc.listMode;
		const other = shown === "general" ? "coding" : "general";
		// The mode not shown is read again when it is shown.
		if (state.pc.lists[other].loaded) patchLists(other, { loaded: false });
		loadLists(shown).catch(() => {});
	}, delay);
}

function resetLists() {
	clearTimeout(listsTimer);
	searching = false;
	state.pc.lists = { general: emptyLists(), coding: emptyLists() };
	state.pc.slots = [];
}

function applySnapshot(bag, snap) {
	bag.title = snap.session?.name || "";
	bag.cwd = snap.cwd;
	bag.mode = snap.mode;
	bag.place = snap.workspace?.name || "";
	bag.root = snap.workspace?.rootPath || "";
	bag.file = snap.session?.file || "";
	bag.run = snap.run;
	bag.running = !!snap.active;
	bag.activity = snap.run?.activity || "";
	bag.runStartedAt = snap.active ? snap.run?.turnStartedAt || snap.run?.startedAt || bag.runStartedAt || Date.now() : 0;
	bag.dialogs = Array.isArray(snap.dialogs) ? snap.dialogs : [];
	bag.queue = [...(snap.queue?.steering || []).map((text) => ({ text, mode: "steer" })), ...(snap.queue?.followUp || []).map((text) => ({ text, mode: "followUp" }))];
	bag.snap = { model: snap.model, thinking: snap.thinking };
}

function publishModels(bag, list) {
	if (list) bag.modelList = list;
	const snap = bag.snap || {};
	const providers = (bag.modelList?.providers || []).map((provider) => ({
		id: provider.id,
		name: provider.name,
		models: provider.models.map((model) => ({ id: model.id, name: model.name || model.id, reasoning: model.reasoning, vision: (model.input || []).includes("image") })),
	}));
	const model = snap.model;
	const levels = snap.thinking?.supported ? snap.thinking.levels || [] : [];
	if (state.pc.chat !== bag) return;
	state.pc.models = {
		loaded: true,
		providers,
		current: model ? { provider: model.provider, providerName: providers.find((provider) => provider.id === model.provider)?.name || model.provider, id: model.id, name: model.name || model.id, reasoning: model.reasoning, vision: (model.input || []).includes("image") } : null,
		efforts: levels.length > 1 ? levels : [],
		effort: snap.thinking?.level || "off",
	};
	emit();
}

/** Pictures the PC lists by address (large ones) are fetched through the link and put into the items as data. */
async function hydrateImages(bag) {
	const mine = generation;
	const wanted = [];
	bag.items.forEach((item) => (item.images || []).forEach((image, index) => image.src && !image.data && wanted.push({ id: item.id, index, src: image.src })));
	for (const entry of wanted.slice(-24)) {
		try {
			const answer = await call("GET", entry.src, undefined, bag.slot, { raw: true });
			if (mine !== generation || answer.status !== 200 || !answer.b64) continue;
			bag.items = bag.items.map((item) => (item.id === entry.id ? { ...item, images: item.images.map((image, index) => (index === entry.index ? { mimeType: answer.type || image.mimeType, data: answer.b64 } : image)) } : item));
			if (state.pc.chat === bag) emit();
		} catch {
			// The picture stays a placeholder.
		}
	}
}

async function loadChat(bag, { quiet = false } = {}) {
	const mine = generation;
	if (!quiet) {
		bag.loading = true;
		if (state.pc.chat === bag) emit();
	}
	try {
		const [snap, page] = await Promise.all([call("GET", "/api/state", undefined, bag.slot), call("GET", `/api/transcript?limit=${PAGE}&images=ref`, undefined, bag.slot)]);
		if (mine !== generation) return;
		applySnapshot(bag, snap);
		// Messages still on their way (sent from this phone, not yet confirmed) stay after what the PC has saved.
		const pending = bag.items.filter((item) => item.pending);
		bag.items = [...(page.items || []), ...pending];
		bag.toolRuns = {};
		bag.hasMore = !!page.hasMore;
		bag.cursor = page.nextCursor || null;
		bag.loaded = true;
		publishModels(bag);
		hydrateImages(bag);
	} finally {
		bag.loading = false;
		if (state.pc.chat === bag) emit();
	}
}

async function loadModels(bag) {
	try {
		publishModels(bag, await call("GET", "/api/models", undefined, bag.slot));
	} catch {
		// The chip keeps the model named by the chat's state.
	}
}

async function showSlot(slot, { reload = false } = {}) {
	activeSlot = slot;
	try {
		localStorage.setItem(SLOT_KEY, slot);
	} catch {
		// Remembered until the app closes.
	}
	const bag = bagFor(slot);
	state.pc.chat = bag;
	state.pc.models = emptyModels();
	publishModels(bag);
	publishChats();
	emit();
	if (!bag.loaded || reload) await loadChat(bag);
	loadModels(bag);
	if (document.visibilityState === "visible") call("POST", "/api/seen", {}, slot).catch(() => {});
}

// ---- Events ------------------------------------------------------------------------------------
const refreshTimers = new Map();
function refreshSoon(slot, delay = 400) {
	clearTimeout(refreshTimers.get(slot));
	refreshTimers.set(
		slot,
		setTimeout(() => {
			const bag = bags.get(slot);
			if (bag?.loaded) loadChat(bag, { quiet: true }).catch(() => {});
		}, delay),
	);
}

function onEvent(name, data) {
	if (name === "slots") {
		slots = Array.isArray(data.slots) ? data.slots : [];
		for (const id of [...bags.keys()]) if (!slots.some((status) => status.slot === id)) bags.delete(id);
		if (!slots.some((status) => status.slot === activeSlot) && slots.length) showSlot(slots[0].slot).catch(() => {});
		else publishChats();
		return;
	}
	if (name === "slot_closed") return;
	if (name === "notice") {
		if (!data.slot || data.slot === activeSlot) toast(data.message, data.type === "error" ? "error" : data.type === "warning" ? "warning" : "info");
		return;
	}
	if (name === "shutdown") {
		setLink({ status: "offline", error: t("MyHarness on the PC was closed.") });
		return;
	}
	if (name === "workspaces_changed") {
		refreshListsSoon();
		return;
	}
	const slot = data?.slot;
	if (!slot) return;
	const bag = bagFor(slot);
	if (name === "thinking_level") {
		if (bag.snap) bag.snap = { ...bag.snap, thinking: { ...bag.snap.thinking, level: data.level } };
		publishModels(bag);
		return;
	}
	if (name === "models_changed" || name === "compaction_end") {
		refreshSoon(slot, 200);
		return;
	}
	// A chat that is not on the page yet has nothing to update; its state is read when it is opened.
	if (!bag.loaded && name !== "run_state" && name !== "run_finished") return;
	const changed = applyEvent(bag, name, data);
	if (name === "run_finished") {
		refreshSoon(slot);
		refreshListsSoon();
	}
	if (name === "prompt_rejected" && state.pc.chat === bag) toast(t("The PC did not take the message. Try again."), "error");
	if (changed && state.pc.chat === bag) emit();
}

async function runStream(mine, { moved = false } = {}) {
	const controller = new AbortController();
	stream = controller;
	let last = 0;
	let announced = false;
	// Requests work as soon as a session is open: the PC shows as connected then, while its event stream is still being
	// set up (one more round through Drive on the relay). When the stream's first frame comes, what changed meanwhile
	// is read again.
	const announce = () => {
		if (announced || mine !== generation) return;
		announced = true;
		retries = 0;
		setLink({ status: "online", error: "", trying: [] });
		if (moved) catchUp();
		else onConnected(mine).catch((error) => console.warn("link refresh failed", error));
	};
	try {
		if (!session) await openSession();
		if (mine !== generation) return;
		announce();
		const aad = linkAad("events", "evt", config.deviceId, session);
		// Frames are opened one after another, in the order the PC numbered them.
		let chain = Promise.resolve();
		const onFrame = (text) => {
			chain = chain.then(async () => {
				const [n, c] = text.split(".");
				const message = await open(key, aad, { n, c });
				// Frames are numbered by the PC: one that is not newer than the last was replayed or reordered.
				if (mine !== generation || !(message.i > last)) return;
				last = message.i;
				if (message.e === "link") catchUp();
				else onEvent(message.e, message.d || {});
			});
		};
		const { body } = await envelope("events", { s: session, q: ++counter });
		if (transport) {
			try {
				await transport.events(body, onFrame, controller.signal);
			} catch (error) {
				if (error?.status === 401) session = "";
				throw error?.status ? failure(error.status, { error: error.message }) : error;
			}
		} else {
			const response = await httpFetch(`${base()}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
			if (response.status === 401) {
				session = "";
				throw new LinkFailure("session expired", 401);
			}
			if (!response.ok) {
				let reason = null;
				try {
					reason = JSON.parse(await response.text());
				} catch {
					reason = null;
				}
				throw failure(response.status, reason);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let at;
				while ((at = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, at);
					buffer = buffer.slice(at + 2);
					if (frame.startsWith("data: ")) onFrame(frame.slice(6));
				}
			}
		}
		await chain;
		throw new LinkFailure(t("The connection to the PC ended."), 0);
	} catch (error) {
		if (mine !== generation || controller.signal.aborted) return;
		stream = null;
		// A remote route that failed is opened again on the next try (perhaps another one).
		if (transport && error?.status !== 401) dropTransport();
		const fatal = error?.status === 403;
		setLink({ status: "offline", error: error?.status === 401 || error?.message === "superseded" ? "" : error?.message || String(error) });
		if (fatal) return;
		const delay = RETRY_DELAYS[Math.min(retries++, RETRY_DELAYS.length - 1)];
		clearTimeout(retryTimer);
		retryTimer = setTimeout(() => mine === generation && document.visibilityState === "visible" && connect(), delay);
	}
}

/** Read again what may have changed while no event stream was attached (the open chat and the chat list). */
function catchUp() {
	if (activeSlot) refreshSoon(activeSlot, 0);
	loadLists().catch(() => {});
}

/** The app has been in the background for a while: the connection is closed (no more looking at Drive) until it is back. */
function rest() {
	if (document.visibilityState === "visible" || !config) return;
	generation++;
	clearTimeout(retryTimer);
	clearTimeout(directTimer);
	stream?.abort();
	stream = null;
	dropTransport();
	session = "";
	setLink({ status: "offline", error: "", trying: [] });
}

async function onConnected(mine) {
	const answer = await call("GET", "/api/slots", undefined, "");
	if (mine !== generation) return;
	slots = answer.slots || [];
	let wanted = activeSlot;
	if (!slots.some((status) => status.slot === wanted)) {
		let remembered = "";
		try {
			remembered = localStorage.getItem(SLOT_KEY) || "";
		} catch {
			remembered = "";
		}
		wanted = slots.find((status) => status.slot === remembered)?.slot || slots[0]?.slot || "";
	}
	publishChats();
	if (wanted) await showSlot(wanted, { reload: true });
	loadLists().catch(() => {});
}

function connect() {
	if (!config || !key) return;
	clearTimeout(retryTimer);
	clearTimeout(directTimer);
	stream?.abort();
	stream = null;
	const mine = ++generation;
	session = "";
	setLink({ status: "connecting", error: "" });
	runStream(mine);
}

function clientMessageId() {
	return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const pc = {
	id: "pc",

	async init() {
		config = loadConfig();
		const secret = config ? keyTextOf(config) : "";
		if (config && secret) {
			try {
				key = await importKey(secret);
				setLink({ paired: config, status: "offline", error: "" });
			} catch {
				config = null;
			}
		} else config = null;
		onNative("lifecycle", (event) => {
			if (event.state === "resume" && config && state.pc.link.status !== "online" && state.pc.link.status !== "connecting") connect();
		});
		// The phone moved to another network (Wi-Fi, mobile data): a faster route may exist now.
		const networkChanged = () => {
			if (state.pc.link.route === "relay" && state.pc.link.status === "online") scheduleFaster(1500);
		};
		window.addEventListener("online", networkChanged);
		navigator.connection?.addEventListener?.("change", networkChanged);
		document.addEventListener("visibilitychange", () => {
			clearTimeout(hiddenTimer);
			if (document.visibilityState === "visible") {
				if (config && state.pc.link.status === "offline") connect();
			} else if (config) hiddenTimer = setTimeout(rest, HIDDEN_REST_MS);
		});
		// The PC is connected as soon as the app opens, on either side, so that it is there when the PC side is opened.
		if (config && document.visibilityState === "visible") connect();
		// The first time, the only PC of the account that is on is connected without a tap; not a PC the user disconnected.
		onAccountPcs((pcs) => {
			if (config || localStorage.getItem(AUTO_OFF_KEY)) return;
			const usable = pcs.filter((entry) => entry.online && entry.accepts);
			if (usable.length === 1) pc.connectAccount(usable[0], { auto: true }).catch(() => {});
		});
		// Signed out of Google: a PC of the account is no longer reachable with the account's key.
		onAccountView((view) => {
			if (!view && config?.kind === "account") pc.unpair();
		});
	},

	/** Called when the user switches to the PC side: connects when a PC is paired and the link is down. */
	activate() {
		if (config && state.pc.link.status !== "online" && state.pc.link.status !== "connecting") connect();
	},

	reconnect() {
		retries = 0;
		connect();
	},

	/** Connect to a PC of the Google account (from the list account.js reads); `auto` when the app chose it itself. */
	async connectAccount(target, { auto = false } = {}) {
		const link = accountLink();
		if (!link) throw new Error(t("Sign in with Google first."));
		if (!auto) localStorage.removeItem(AUTO_OFF_KEY);
		const nextKey = await importKey(link.keyText);
		stream?.abort();
		stream = null;
		dropTransport();
		generation++;
		config = { kind: "account", pcId: target.id, name: target.name, deviceId: link.phoneId, hosts: target.lan?.addresses || [], port: target.lan?.port || 0 };
		key = nextKey;
		session = "";
		host = "";
		localStorage.setItem(LINK_KEY, JSON.stringify(config));
		bags.clear();
		slots = [];
		resetLists();
		activeSlot = "";
		state.pc.chat = emptyChat();
		state.pc.chats = [];
		state.pc.chatsLoaded = false;
		setLink({ paired: config, status: "connecting", error: "", host: "", route: "" });
		connect();
		return config;
	},

	/** Pair with the PC named by the text of a QR code. Resolves once the PC accepted this phone. */
	async pair(text) {
		const parsed = parsePairing(text);
		const nextKey = await importKey(parsed.key);
		const before = { config, key, host, session };
		stream?.abort();
		stream = null;
		dropTransport();
		generation++;
		config = { name: parsed.name, hosts: parsed.hosts, port: parsed.port, deviceId: parsed.deviceId };
		key = nextKey;
		session = "";
		setLink({ status: "connecting", error: "", host: "" });
		try {
			await openSession();
		} catch (error) {
			({ config, key, host, session } = before);
			setLink({ paired: config, status: config ? "offline" : "none", error: "" });
			if (config) connect();
			throw error;
		}
		if (!secretSet("link.key", parsed.key)) throw new Error(t("The key could not be stored on this phone."));
		localStorage.setItem(LINK_KEY, JSON.stringify(config));
		bags.clear();
		slots = [];
		resetLists();
		activeSlot = "";
		state.pc.chat = emptyChat();
		state.pc.chats = [];
		state.pc.chatsLoaded = false;
		setLink({ paired: config });
		connect();
		return config;
	},

	/** Forget the PC. `byUser` when the user chose it: the app then no longer connects to a PC of the account by itself. */
	unpair({ byUser = false } = {}) {
		if (byUser && config?.kind === "account") localStorage.setItem(AUTO_OFF_KEY, "1");
		generation++;
		clearTimeout(retryTimer);
		clearTimeout(directTimer);
		stream?.abort();
		stream = null;
		dropTransport();
		const wasAccount = config?.kind === "account";
		config = null;
		key = null;
		session = "";
		host = "";
		// An account PC's key is the account's (account.js): only a QR pairing's own key is forgotten here.
		if (!wasAccount) secretDelete("link.key");
		try {
			localStorage.removeItem(LINK_KEY);
			localStorage.removeItem(SLOT_KEY);
		} catch {
			// Nothing was saved.
		}
		bags.clear();
		slots = [];
		resetLists();
		activeSlot = "";
		state.pc.chat = emptyChat();
		state.pc.chats = [];
		state.pc.chatsLoaded = false;
		state.pc.models = emptyModels();
		setLink({ paired: null, status: "none", error: "", host: "" });
	},

	hasModel: () => !!state.pc.models.current,

	async refreshChats() {
		if (state.pc.link.status === "online") await loadLists();
	},

	/** Show the chats of the other mode (Coding or General), as the desktop's switch does. */
	setListMode(mode) {
		const next = mode === "coding" ? "coding" : "general";
		if (state.pc.listMode === next) return;
		state.pc.listMode = next;
		saveJson(LIST_MODE_KEY, next);
		publishChats();
		if (!state.pc.lists[next].loaded && state.pc.link.status === "online") loadLists(next).catch(() => {});
	},

	/** Open or fold a group; a Workspace's chats are read when its group is first opened. */
	setGroupOpen(key, open) {
		const mode = state.pc.listMode;
		state.pc.folds = { ...state.pc.folds, [mode]: { ...state.pc.folds[mode], [key]: !!open } };
		saveJson(FOLDS_KEY, state.pc.folds);
		emit();
		const lists = state.pc.lists[mode];
		if (open && lists.workspaces.some((entry) => entry.rootPath === key) && lists.sessions[key] === undefined && state.pc.link.status === "online") loadWorkspace(mode, key).catch(() => {});
	},

	/** The next rows of a group the PC has more of. */
	async loadMore(group) {
		const mode = state.pc.listMode;
		if (group.kind === "workspace") await loadWorkspace(mode, group.root, { more: true });
		else if (group.kind === "default") await loadMoreDefault(mode);
	},

	/** While the drawer is searched, every Workspace's chats are read, so the search finds them. */
	setSearching(on) {
		searching = !!on;
		if (!searching || state.pc.link.status !== "online") return;
		const mode = state.pc.listMode;
		const lists = state.pc.lists[mode];
		for (const entry of lists.workspaces) if (lists.sessions[entry.rootPath] === undefined) loadWorkspace(mode, entry.rootPath).catch(() => {});
	},

	/** Whether this PC starts a chat in a Workspace a phone names (older PCs start it where they would themselves). */
	canStartInWorkspace: () => state.pc.lists[state.pc.listMode].scheduled !== null,

	async openChat(id) {
		if (id.startsWith("slot:")) return showSlot(id.slice(5));
		const answer = await call("POST", "/api/sessions/open", { path: id.slice(5) });
		if (answer.cwdMissing) toast(t("This chat's folder is gone on the PC; its history can still be read."), "warning");
		await showSlot(answer.slot, { reload: true });
	},

	/** A new chat of the mode the drawer shows: in "Default", or in the Workspace given (`rootPath`). */
	async newChat({ rootPath } = {}) {
		const mode = state.pc.listMode;
		const previous = activeSlot;
		// The new chat shows at once, without a slot, until the PC has made it (a second or two through Drive): a
		// message typed meanwhile must not go into the chat that was open before.
		const placeholder = { ...emptyChat(), mode, loading: true };
		state.pc.chat = placeholder;
		emit();
		try {
			const answer = await call("POST", "/api/sessions/new", rootPath ? { mode, rootPath } : { mode, unbound: true });
			await showSlot(answer.slot, { reload: true });
		} catch (error) {
			if (state.pc.chat === placeholder && previous) await showSlot(previous).catch(() => {});
			throw error;
		}
	},

	async send({ text, attachments = [] }) {
		if (state.pc.link.status !== "online") throw new Error(t("The PC is not connected."));
		const bag = state.pc.chat;
		const slot = bag.slot;
		if (!slot) throw new Error(t("No chat is open on the PC yet."));
		const images = attachments.filter((entry) => entry.type === "image").map((entry) => ({ mimeType: entry.mimeType, data: entry.data }));
		const files = attachments.filter((entry) => entry.type !== "image");
		const tooLarge = files.find((entry) => entry.size > UPLOAD_MAX_BYTES);
		if (tooLarge) throw new Error(t("“{name}” is larger than 16 MB, the most a phone can send to the PC.", { name: tooLarge.name }));
		// The message shows at once; its files go to the PC first, then the message itself.
		const id = clientMessageId();
		addPending(bag, { clientMessageId: id, text, images, attachments: files.map((entry) => ({ name: entry.name, size: entry.size })) });
		emit();
		try {
			const uploaded = [];
			for (const entry of files) {
				const data = entry.file ? await fileToBase64(entry.file) : btoa(unescape(encodeURIComponent(entry.text || "")));
				const answer = await call("POST", "/api/files/upload", { name: entry.name, data }, slot);
				uploaded.push({ path: answer.path, name: answer.name || entry.name });
			}
			await call("POST", "/api/prompt", { text, images, attachments: uploaded.map((entry) => ({ path: entry.path })), mode: "auto", clientMessageId: id }, slot);
			// The PC took it (its receipt may have said so already).
			if (markDelivered(bag, id) && state.pc.chat === bag) emit();
		} catch (error) {
			removePending(bag, id);
			emit();
			throw error;
		}
	},

	stop() {
		call("POST", "/api/abort", {}).catch((error) => toast(error.message, "error"));
	},

	retry: null,

	async setModel(provider, id) {
		await call("POST", "/api/model", { provider, id });
		const bag = state.pc.chat;
		await loadChat(bag, { quiet: true });
		loadModels(bag);
	},

	async setEffort(level) {
		const answer = await call("POST", "/api/thinking", { level });
		const bag = state.pc.chat;
		if (bag.snap) bag.snap = { ...bag.snap, thinking: { ...bag.snap.thinking, level: answer.level || level } };
		publishModels(bag);
	},

	async respond(id, value) {
		await call("POST", "/api/ui/respond", { id, value });
	},

	async loadOlder() {
		const bag = state.pc.chat;
		if (!bag.hasMore || !bag.cursor || bag.loadingOlder) return;
		bag.loadingOlder = true;
		emit();
		try {
			const page = await call("GET", `/api/transcript?limit=${PAGE}&images=ref&before=${encodeURIComponent(bag.cursor)}`, undefined, bag.slot);
			const known = new Set(bag.items.map((item) => item.id).filter(Boolean));
			bag.items = [...(page.items || []).filter((item) => !item.id || !known.has(item.id)), ...bag.items];
			bag.hasMore = !!page.hasMore;
			bag.cursor = page.nextCursor || null;
			hydrateImages(bag);
		} finally {
			bag.loadingOlder = false;
			emit();
		}
	},

	renameChat: null,
	deleteChat: null,
};
