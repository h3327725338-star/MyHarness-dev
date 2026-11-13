/**
 * The phone channel's place in Google Drive: `MyHarness/phone-v1/`, beside the sync space `sync-v1/`.
 *
 * Phones never write into `sync-v1`: its batches, version vectors and snapshots belong to the computers. A phone
 * reads what a computer prepared for it here (`views/`), reads content from `sync-v1/objects/` by hash, and leaves
 * its own changes in `outbox/`, which a computer applies to its files; the computer's ordinary sync then carries
 * them to every other computer.
 *
 * | Folder | Written by | Holds |
 * | --- | --- | --- |
 * | `views/` | each computer | `<deviceId>.json.gz`: chats, Providers and keys, web search sources and keys, bookmarks, as a phone shows them; `<deviceId>.memories.json.gz`: memories; `<deviceId>.dial.json.gz`: the shortcuts of the browser's new-tab page |
 * | `pcs/` | each computer | `<deviceId>.json`: which computer, whether it is on now, how a phone reaches it |
 * | `phones/` | each phone | `<phoneId>.json`: the phone's name and the key its link to a computer is sealed with |
 * | `outbox/` | phones | `<phoneId>__<time base 36>__<random>.json`: changes a computer applies and then removes |
 * | `link/` | both | connection offers and answers, and the relayed messages of a link that has no direct path |
 */

import type { RemoteFile } from "../types.ts";

export type PhoneFolder = "views" | "pcs" | "phones" | "outbox" | "link";
export const PHONE_FOLDERS: readonly PhoneFolder[] = ["views", "pcs", "phones", "outbox", "link"];

export interface PhoneDrivePort {
	/** Create the folders if needed (and find the sync space they sit beside). */
	ensurePhoneSpace(): Promise<void>;
	phoneList(folder: PhoneFolder, options?: { createdAfter?: string }): Promise<RemoteFile[]>;
	phoneRead(folder: PhoneFolder, name: string): Promise<Uint8Array | undefined>;
	/** Create the file, or replace the content of the one with that name. */
	phoneWrite(folder: PhoneFolder, name: string, data: Uint8Array): Promise<void>;
	/**
	 * Create a new file without looking for one of that name first (names that are used once: relay messages).
	 * `properties` are stored with it and come back in `phoneList` (Drive: 30 per file, 124 bytes each with the key).
	 */
	phoneCreate(
		folder: PhoneFolder,
		name: string,
		data: Uint8Array,
		options?: { properties?: Record<string, string> },
	): Promise<void>;
	phoneDelete(folder: PhoneFolder, name: string): Promise<void>;
}

/** An in-memory phone channel for tests: the same answers Drive gives, created times included. */
export class MemoryPhonePort implements PhoneDrivePort {
	readonly folders = new Map<
		PhoneFolder,
		Map<string, { data: Uint8Array; createdTime: string; modifiedTime: string; properties?: Record<string, string> }>
	>();
	private clock = Date.now();
	calls = 0;

	private folder(folder: PhoneFolder) {
		let found = this.folders.get(folder);
		if (!found) {
			found = new Map();
			this.folders.set(folder, found);
		}
		return found;
	}

	/** Strictly increasing times, so "created after" listings behave as on Drive. */
	private now(): string {
		this.clock = Math.max(this.clock + 1, Date.now());
		return new Date(this.clock).toISOString();
	}

	async ensurePhoneSpace(): Promise<void> {
		this.calls += 1;
		for (const folder of PHONE_FOLDERS) this.folder(folder);
	}

	async phoneList(folder: PhoneFolder, options: { createdAfter?: string } = {}): Promise<RemoteFile[]> {
		this.calls += 1;
		const after = options.createdAfter ? Date.parse(options.createdAfter) : Number.NEGATIVE_INFINITY;
		return [...this.folder(folder).entries()]
			.filter(([, file]) => Date.parse(file.createdTime) > after)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, file]) => ({
				id: `${folder}/${name}`,
				name,
				size: file.data.byteLength,
				createdTime: file.createdTime,
				modifiedTime: file.modifiedTime,
				...(file.properties ? { properties: { ...file.properties } } : {}),
			}));
	}

	async phoneRead(folder: PhoneFolder, name: string): Promise<Uint8Array | undefined> {
		this.calls += 1;
		const file = this.folder(folder).get(name);
		return file ? new Uint8Array(file.data) : undefined;
	}

	async phoneWrite(folder: PhoneFolder, name: string, data: Uint8Array): Promise<void> {
		this.calls += 1;
		const existing = this.folder(folder).get(name);
		const time = this.now();
		this.folder(folder).set(name, {
			data: new Uint8Array(data),
			createdTime: existing?.createdTime ?? time,
			modifiedTime: time,
		});
	}

	async phoneCreate(
		folder: PhoneFolder,
		name: string,
		data: Uint8Array,
		options: { properties?: Record<string, string> } = {},
	): Promise<void> {
		const properties = options.properties;
		if (properties) {
			// Drive's limits for custom properties: refused as Drive refuses them.
			if (Object.keys(properties).length > 30) throw new Error("Too many properties.");
			for (const [key, value] of Object.entries(properties))
				if (Buffer.byteLength(key + value, "utf8") > 124) throw new Error(`Property ${key} is too large.`);
		}
		await this.phoneWrite(folder, name, data);
		const file = this.folder(folder).get(name);
		if (file && properties) file.properties = { ...properties };
	}

	async phoneDelete(folder: PhoneFolder, name: string): Promise<void> {
		this.calls += 1;
		this.folder(folder).delete(name);
	}
}
