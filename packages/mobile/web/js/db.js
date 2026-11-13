// The phone's own chats, kept in IndexedDB inside the app's private storage (Android removes it with the app).
//   chats    one row per chat: { id, title, createdAt, updatedAt, model, effort, preview, titled }
//   entries  one row per chat: { chatId, entries: [{ id, ts, message, meta? }] }, the messages exactly as the agent
//            holds them (AgentMessage), so a chat continues where it stopped
//   kv       small named values: providers, browser bookmarks and history
const NAME = "myharness-mobile";
const VERSION = 1;

let opening;
function open() {
	opening ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(NAME, VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
			if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "chatId" });
			if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error("The app's storage could not be opened"));
		request.onblocked = () => reject(new Error("The app's storage is in use by an older copy of the page"));
	});
	return opening;
}

async function run(stores, mode, work) {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(stores, mode);
		let result;
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error || new Error("Storage failed"));
		tx.onabort = () => reject(tx.error || new Error("Storage was interrupted"));
		result = work(tx);
	});
}

const wait = (request) =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

export async function listChats() {
	const db = await open();
	const rows = await wait(db.transaction("chats").objectStore("chats").getAll());
	return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getChat(id) {
	const db = await open();
	return (await wait(db.transaction("chats").objectStore("chats").get(id))) || null;
}

export function putChat(chat) {
	return run(["chats"], "readwrite", (tx) => void tx.objectStore("chats").put(chat));
}

export async function getEntries(chatId) {
	const db = await open();
	return (await wait(db.transaction("entries").objectStore("entries").get(chatId)))?.entries || [];
}

/** Save a chat's row and its messages together, so a chat is never listed without what was said in it. */
export function saveChat(chat, entries) {
	return run(["chats", "entries"], "readwrite", (tx) => {
		tx.objectStore("chats").put(chat);
		tx.objectStore("entries").put({ chatId: chat.id, entries });
	});
}

export function deleteChat(id) {
	return run(["chats", "entries"], "readwrite", (tx) => {
		tx.objectStore("chats").delete(id);
		tx.objectStore("entries").delete(id);
	});
}

export function clearChats() {
	return run(["chats", "entries"], "readwrite", (tx) => {
		tx.objectStore("chats").clear();
		tx.objectStore("entries").clear();
	});
}

export async function kvGet(key, fallback = null) {
	try {
		const db = await open();
		const value = await wait(db.transaction("kv").objectStore("kv").get(key));
		return value === undefined ? fallback : value;
	} catch {
		return fallback;
	}
}

export function kvSet(key, value) {
	return run(["kv"], "readwrite", (tx) => void tx.objectStore("kv").put(value, key));
}

/** How much the app's storage holds, when the browser reports it. */
export async function storageEstimate() {
	try {
		return (await navigator.storage?.estimate?.()) || null;
	} catch {
		return null;
	}
}
