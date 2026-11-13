// The phone's view of the account's Google Drive: only the MyHarness folder the PC created (drive.file shows the app
// nothing else). The layout is the PC's (packages/coding-agent/src/sync/phone/port.ts):
//
//   MyHarness/phone-v1/views/    what each PC prepared for phones (chats, Providers, memories, bookmarks)
//   MyHarness/phone-v1/pcs/      which PCs are on
//   MyHarness/phone-v1/phones/   this phone's registration (its name and link key)
//   MyHarness/phone-v1/outbox/   changes made on this phone, which a PC applies and removes
//   MyHarness/phone-v1/link/     connection offers and relayed messages (link-remote.js)
//   MyHarness/sync-v1/objects/   chat contents by hash, read only
//
// The phone never writes into sync-v1: that is the PCs' sync state.
import { googleFetch } from "./google.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
export const PHONE_FOLDERS = ["views", "pcs", "phones", "outbox", "link"];

export class DriveError extends Error {
	constructor(message, status = 0, code = "") {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const escapeQuery = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const decoder = new TextDecoder();
// How long one exchange with Drive may take (googleFetch's limit covers the body too): the default for lists and
// small requests, more for a download of unknown size, and for an upload a time that grows with its size.
const DOWNLOAD_TIMEOUT_MS = 120000;
const uploadTimeout = (chars) => 30000 + Math.ceil(chars / 50000) * 1000;

async function request(url, init) {
	const response = await googleFetch(url, init);
	if (response.ok) return response;
	let reason = "";
	try {
		reason = (await response.json()).error?.message || "";
	} catch {
		// No reason given.
	}
	throw new DriveError(reason || `Google Drive answered HTTP ${response.status}.`, response.status);
}

async function json(url, init) {
	return (await request(url, init)).json();
}

/** Decompress a gzip file (views are stored compressed). */
export async function gunzip(bytes) {
	if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const bytesToText = (bytes) => decoder.decode(bytes);

export class PhoneDrive {
	constructor() {
		this.folders = {};
		this.objectsId = "";
		this.rootId = "";
		this.ids = new Map(); // `${folder}/${name}` → file id
	}

	/** Find the PC's MyHarness folder. Throws a DriveError with code "no-space" when no PC has made one yet. */
	async ready() {
		if (this.folders.link) return;
		const q = `name='phone-v1' and mimeType='${FOLDER}' and trashed=false`;
		const found = await json(`${DRIVE}/files?${new URLSearchParams({ q, fields: "files(id,parents,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "10", spaces: "drive" })}`);
		const space = found.files?.[0];
		if (!space) throw new DriveError("No PC has prepared this Google account for phones yet.", 404, "no-space");
		this.rootId = space.parents?.[0] || "";
		const children = await this.children(space.id, FOLDER);
		for (const name of PHONE_FOLDERS) this.folders[name] = children.get(name) || (await this.createFolder(name, space.id));
		if (this.rootId) {
			const sync = (await this.children(this.rootId, FOLDER)).get("sync-v1");
			if (sync) this.objectsId = (await this.children(sync, FOLDER)).get("objects") || "";
		}
	}

	async children(parent, mimeType) {
		const q = `'${parent}' in parents and trashed=false${mimeType ? ` and mimeType='${mimeType}'` : ""}`;
		const out = new Map();
		let pageToken = "";
		do {
			const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name)", pageSize: "1000", spaces: "drive" });
			if (pageToken) params.set("pageToken", pageToken);
			const page = await json(`${DRIVE}/files?${params}`);
			for (const file of page.files || []) if (!out.has(file.name)) out.set(file.name, file.id);
			pageToken = page.nextPageToken || "";
		} while (pageToken);
		return out;
	}

	async createFolder(name, parent) {
		const created = await json(`${DRIVE}/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
		return created.id;
	}

	folderId(folder) {
		const id = this.folders[folder];
		if (!id) throw new DriveError("The MyHarness folder is not ready yet.", 503);
		return id;
	}

	/** Files of a phone folder: `{ id, name, size, createdTime, modifiedTime, properties }`. */
	async phoneList(folder, { createdAfter, timeoutMs } = {}) {
		const parent = this.folderId(folder);
		const files = [];
		let pageToken = "";
		do {
			const q = `'${parent}' in parents and trashed=false${createdAfter ? ` and createdTime > '${new Date(createdAfter).toISOString()}'` : ""}`;
			const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,size,createdTime,modifiedTime,properties)", orderBy: "name", pageSize: "1000", spaces: "drive" });
			if (pageToken) params.set("pageToken", pageToken);
			const page = await json(`${DRIVE}/files?${params}`, { timeoutMs });
			for (const file of page.files || []) {
				this.ids.set(`${folder}/${file.name}`, file.id);
				files.push(file);
			}
			pageToken = page.nextPageToken || "";
		} while (pageToken);
		return files;
	}

	async fileId(folder, name, timeoutMs) {
		const known = this.ids.get(`${folder}/${name}`);
		if (known) return known;
		const q = `name='${escapeQuery(name)}' and '${this.folderId(folder)}' in parents and trashed=false`;
		const found = await json(`${DRIVE}/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1", spaces: "drive" })}`, { timeoutMs });
		const id = found.files?.[0]?.id || "";
		if (id) this.ids.set(`${folder}/${name}`, id);
		return id;
	}

	async readId(id, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
		const response = await googleFetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, { timeoutMs });
		if (response.status === 404) return undefined;
		if (!response.ok) throw new DriveError(`Reading from Google Drive failed (HTTP ${response.status}).`, response.status);
		return new Uint8Array(await response.arrayBuffer());
	}

	async phoneRead(folder, name, { timeoutMs } = {}) {
		const id = await this.fileId(folder, name, timeoutMs);
		if (!id) return undefined;
		const data = await this.readId(id, timeoutMs);
		if (data === undefined) this.ids.delete(`${folder}/${name}`);
		return data;
	}

	/** A new file. The phone writes JSON text only. `properties` are kept with it and come back in `phoneList`. */
	async phoneCreate(folder, name, data, { timeoutMs, properties } = {}) {
		const boundary = `mh-${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
		const text = typeof data === "string" ? data : decoder.decode(data);
		const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [this.folderId(folder)], ...(properties ? { properties } : {}) })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--\r\n`;
		const created = await json(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body, timeoutMs: timeoutMs ?? uploadTimeout(body.length) });
		return created.id;
	}

	/** Create the file, or replace the content of the one with that name. */
	async phoneWrite(folder, name, data) {
		const id = await this.fileId(folder, name);
		if (id) {
			const text = typeof data === "string" ? data : decoder.decode(data);
			const response = await googleFetch(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: text, timeoutMs: uploadTimeout(text.length) });
			if (response.ok) return id;
			if (response.status !== 404) throw new DriveError(`Writing to Google Drive failed (HTTP ${response.status}).`, response.status);
			this.ids.delete(`${folder}/${name}`);
		}
		const created = await this.phoneCreate(folder, name, data);
		this.ids.set(`${folder}/${name}`, created);
		return created;
	}

	async phoneDelete(folder, name, { timeoutMs } = {}) {
		const id = await this.fileId(folder, name, timeoutMs);
		if (!id) return;
		const response = await googleFetch(`${DRIVE}/files/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs });
		this.ids.delete(`${folder}/${name}`);
		if (!response.ok && response.status !== 404) throw new DriveError(`Removing from Google Drive failed (HTTP ${response.status}).`, response.status);
	}

	/** A chat's content by its hash, from the PCs' sync space. */
	async readObject(hash) {
		if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
		if (!this.objectsId) throw new DriveError("The PCs' chat store is not in this Drive yet.", 404);
		const q = `name='${hash}' and '${this.objectsId}' in parents and trashed=false`;
		const found = await json(`${DRIVE}/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1", spaces: "drive" })}`);
		const id = found.files?.[0]?.id;
		return id ? this.readId(id) : undefined;
	}
}
