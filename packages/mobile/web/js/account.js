// The phone signed in with the user's Google account: what it reads from the account's Drive and what it leaves
// there (layout in drive.js, the PC's side in packages/coding-agent/src/sync/phone/).
//
// - It registers itself (`phones/<phoneId>.json`: its name and the key its link to a PC is sealed with), so every PC
//   of the account accepts it without a QR code.
// - It lists the PCs that are on (`pcs/`), for the PC side's connection list.
// - It reads what the PCs prepared for phones (`views/`): chats, Providers with their keys, the default model, browser
//   bookmarks, and memories. backend-local.js and browser.js take them from `onAccountView`.
// - It leaves changes made on the phone in `outbox/` (chat lines, Provider edits). A PC applies each file to its own
//   files and removes it; the PCs' ordinary sync then carries the change to every PC.
import { t } from "/shared/i18n.js";
import { listPcs, mergeViews, pickMemories } from "./account-view.js";
import * as db from "./db.js";
import { bytesToText, DriveError, gunzip, PhoneDrive } from "./drive.js";
import { googleAccount, signInWithGoogle, signOutOfGoogle } from "./google.js";
import { toBase64Url } from "./link-crypto.js";
import { isNative, nativeInfo, onNative, secretDelete, secretGet, secretSet } from "./native.js";
import { emit, state } from "./store.js";

const PHONE_ID_KEY = "myharness.mobile.phoneId";
const SKIP_KEY = "myharness.mobile.signInSkipped";
const LINK_SECRET = "account.link.key";
const REFRESH_MS = 30000;
const OUTBOX_FILE_CHARS = 3000000;

export const drive = new PhoneDrive();
const viewListeners = new Set();
const pcsListeners = new Set();
const presences = new Map(); // file name → { modifiedTime, value }
const views = new Map(); // file name → { modifiedTime, value }
const memoryPacks = new Map();
let refreshing = null;
let timer = 0;
let registeredKey = "";
let flushTimer = 0;
let lastView = null;
let lastMemories = [];

function setAccount(patch) {
	state.account = { ...state.account, ...patch };
	emit();
}

/** This phone's id towards the PCs: random, kept until the app's data is cleared. */
export function phoneId() {
	let id = localStorage.getItem(PHONE_ID_KEY) || "";
	if (!/^[a-z0-9]{12}$/.test(id)) {
		id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
		localStorage.setItem(PHONE_ID_KEY, id);
	}
	return id;
}

/** The key the phone's link to the account's PCs is sealed with (a new one after every sign-in). */
function linkKeyText() {
	let key = secretGet(LINK_SECRET);
	if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
		key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		if (!secretSet(LINK_SECRET, key)) throw new Error(t("The key could not be stored on this phone."));
	}
	return key;
}

/** What backend-remote.js needs to reach a PC of the account. */
export function accountLink() {
	if (!googleAccount()) return null;
	return { phoneId: phoneId(), keyText: linkKeyText(), drive };
}

export const signedIn = () => !!googleAccount();

/** Called with `(view, memories)` whenever either changes; `view` null after signing out. */
export function onAccountView(listener) {
	viewListeners.add(listener);
	if (lastView) listener(lastView, lastMemories);
	return () => viewListeners.delete(listener);
}

/** Called with the account's PCs (account-view.js listPcs) after every read of the account's Drive. */
export function onAccountPcs(listener) {
	pcsListeners.add(listener);
	return () => pcsListeners.delete(listener);
}

function publish() {
	for (const listener of [...viewListeners]) {
		try {
			listener(lastView, lastMemories);
		} catch (error) {
			console.error("account view listener failed", error);
		}
	}
}

async function readChanged(folder, files, cache, decode) {
	let changed = false;
	const names = new Set(files.map((file) => file.name));
	for (const name of [...cache.keys()]) if (!names.has(name)) cache.delete(name), (changed = true);
	for (const file of files) {
		if (cache.get(file.name)?.modifiedTime === file.modifiedTime) continue;
		const data = await drive.phoneRead(folder, file.name);
		if (!data) continue;
		try {
			cache.set(file.name, { modifiedTime: file.modifiedTime, value: JSON.parse(bytesToText(await decode(data))) });
			changed = true;
		} catch (error) {
			console.warn(`unreadable ${folder}/${file.name}`, error);
		}
	}
	return changed;
}

async function register() {
	const key = linkKeyText();
	if (registeredKey === key) return;
	const id = phoneId();
	await drive.phoneWrite("phones", `${id}.json`, JSON.stringify({ phoneId: id, name: nativeInfo.device || "Phone", key, createdAt: new Date().toISOString() }));
	registeredKey = key;
}

/** Read the account's Drive once: PCs, views, memories; and send what waits in the outbox. */
export function refreshAccount() {
	if (!googleAccount()) return Promise.resolve();
	refreshing ??= (async () => {
		try {
			await drive.ready();
			await register();
			await flushOutbox();
			const pcFiles = (await drive.phoneList("pcs")).filter((file) => file.name.endsWith(".json"));
			await readChanged("pcs", pcFiles, presences, async (data) => data);
			const viewFiles = await drive.phoneList("views");
			const changedViews = await readChanged(
				"views",
				viewFiles.filter((file) => file.name.endsWith(".json.gz") && !file.name.endsWith(".memories.json.gz")),
				views,
				gunzip,
			);
			const changedMemories = await readChanged(
				"views",
				viewFiles.filter((file) => file.name.endsWith(".memories.json.gz")),
				memoryPacks,
				gunzip,
			);
			if (changedViews || changedMemories || !lastView) {
				lastView = mergeViews([...views.values()].map((entry) => entry.value));
				lastMemories = pickMemories([...memoryPacks.values()].map((entry) => entry.value));
				await db.kvSet("account-view", lastView).catch(() => {});
				await db.kvSet("account-memories", lastMemories).catch(() => {});
				publish();
			}
			setAccount({ status: "ready", error: "", pcs: listPcs([...presences.values()].map((entry) => entry.value)), syncedAt: Date.now() });
			for (const listener of [...pcsListeners]) {
				try {
					listener(state.account.pcs);
				} catch (error) {
					console.error("account PC listener failed", error);
				}
			}
		} catch (error) {
			if (error?.signedOut) {
				await forget();
				setAccount({ status: "signedOut", error: error.message });
			} else if (error instanceof DriveError && error.code === "no-space") setAccount({ status: "noSpace", error: "" });
			else setAccount({ status: state.account.status === "loading" ? "error" : state.account.status, error: error?.message || String(error) });
		}
	})().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

function startLoop() {
	clearInterval(timer);
	timer = setInterval(() => {
		if (document.visibilityState === "visible") refreshAccount();
	}, REFRESH_MS);
	refreshAccount();
}

// The queue is read and written by one step at a time: adding to it and removing what was sent never interleave.
let queueLock = Promise.resolve();
function withQueue(work) {
	const next = queueLock.then(work, work);
	queueLock = next.catch(() => {});
	return next;
}

/** Changes for the PCs (`chat.append`, `provider.save`, `provider.remove`), kept until a PC can be told. */
export async function queueOps(ops) {
	if (!googleAccount() || !ops.length) return;
	await withQueue(async () => db.kvSet("outbox-queue", [...((await db.kvGet("outbox-queue", [])) || []), ...ops]));
	clearTimeout(flushTimer);
	flushTimer = setTimeout(() => flushOutbox().catch(() => {}), 1500);
}

let flushing = null;
export function flushOutbox() {
	flushing ??= (async () => {
		const queue = (await db.kvGet("outbox-queue", [])) || [];
		if (!queue.length || !googleAccount()) return;
		await drive.ready();
		const id = phoneId();
		const files = [];
		let current = [];
		let size = 0;
		for (const op of queue) {
			const length = JSON.stringify(op).length;
			if (current.length && size + length > OUTBOX_FILE_CHARS) {
				files.push(current);
				current = [];
				size = 0;
			}
			current.push(op);
			size += length;
		}
		if (current.length) files.push(current);
		for (const ops of files) {
			const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("");
			const name = `${id}__${Date.now().toString(36)}__${random}.json`;
			await drive.phoneCreate("outbox", name, JSON.stringify({ version: 1, phoneId: id, phoneName: nativeInfo.device || "Phone", createdAt: new Date().toISOString(), ops }));
			// What reached Drive leaves the queue at once (from its front: ops queued meanwhile were added at the end),
			// so a later failure does not send it twice.
			await withQueue(async () => db.kvSet("outbox-queue", ((await db.kvGet("outbox-queue", [])) || []).slice(ops.length)));
		}
	})().finally(() => {
		flushing = null;
	});
	return flushing;
}

async function forget() {
	clearInterval(timer);
	registeredKey = "";
	presences.clear();
	views.clear();
	memoryPacks.clear();
	lastView = null;
	lastMemories = [];
	await db.kvSet("account-view", null).catch(() => {});
	await db.kvSet("account-memories", []).catch(() => {});
	publish();
}

export const account = {
	async init() {
		const signed = googleAccount();
		const skipped = !isNative && localStorage.getItem(SKIP_KEY) === "1";
		state.account = { status: signed ? "loading" : "signedOut", email: signed?.email || "", name: signed?.name || "", pcs: [], error: "", syncedAt: 0, skipped };
		if (!signed) return;
		// What was read last time, so Providers and chats are there before Drive answers (or without a network).
		lastView = await db.kvGet("account-view", null).catch(() => null);
		lastMemories = (await db.kvGet("account-memories", [])) || [];
		if (lastView) publish();
		onNative("lifecycle", (event) => {
			if (event.state === "resume") refreshAccount();
		});
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") refreshAccount();
		});
		startLoop();
	},

	async signIn() {
		setAccount({ status: "signingIn", error: "" });
		try {
			const signed = await signInWithGoogle();
			setAccount({ status: "loading", email: signed.email, name: signed.name, error: "" });
			startLoop();
			await refreshing;
		} catch (error) {
			setAccount({ status: "signedOut", error: error?.message || String(error) });
			throw error;
		}
	},

	/** Preview only (a desktop browser cannot sign in): use the page without an account. */
	skip() {
		localStorage.setItem(SKIP_KEY, "1");
		setAccount({ skipped: true });
	},

	async signOut() {
		// The PCs forget this phone: its registration goes, and the next sign-in brings a new key.
		try {
			await flushOutbox();
			await drive.ready();
			await drive.phoneDelete("phones", `${phoneId()}.json`);
		} catch (error) {
			console.warn("could not remove the phone's registration", error);
		}
		await db.kvSet("outbox-queue", []).catch(() => {});
		await signOutOfGoogle();
		secretDelete(LINK_SECRET);
		await forget();
		setAccount({ status: "signedOut", email: "", name: "", pcs: [], error: "" });
	},

	refresh: refreshAccount,
	readChat: async (hash) => {
		await drive.ready();
		const data = await drive.readObject(hash);
		return data ? bytesToText(await gunzip(data)) : undefined;
	},
};
