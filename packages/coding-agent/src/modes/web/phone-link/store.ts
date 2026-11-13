/**
 * What the phone link remembers on this PC: whether it is on, its port, and the phones that were paired.
 *
 * It lives in `<agent dir>/phone-link.json`, a file of its own: it holds each phone's key, belongs to this PC only
 * and is not part of what Google Drive sync carries (the sync scope lists what travels; this file is not in it).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromBase64Url, KEY_BYTES, newId, newKey, toBase64Url } from "./crypto.ts";

export const PHONE_LINK_FILE = "phone-link.json";
export const DEFAULT_PHONE_LINK_PORT = 47821;
/** How long a QR code stays valid before the phone has used it. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 16;

export interface PhoneDevice {
	id: string;
	name: string;
	/** The shared key, base64url. Never leaves this file except inside the QR code shown on this PC. */
	key: string;
	createdAt: number;
	/** Set when the phone first connected with the key; until then the entry is a pending QR code. */
	pairedAt: number | null;
	lastSeenAt: number | null;
	/**
	 * How the phone was paired: a QR code shown on this PC, or signed in with the same Google account (the phone left
	 * its key in the account's Drive, sync/phone/). Older files have no value: a QR code.
	 */
	source?: "qr" | "google";
}

interface PhoneLinkFile {
	version: 1;
	/** Whether the phone link listens on the local network (QR pairing, direct Wi-Fi connections). */
	enabled: boolean;
	port: number;
	devices: PhoneDevice[];
	/** Whether phones signed in with this PC's Google account may connect, from any network. Default on. */
	remote: boolean;
	/**
	 * Phones of the account the user removed here, with the key they had: they are not taken back from Drive. Signing in
	 * on that phone again gives it a new key, which counts as a new phone.
	 */
	blocked: Array<{ id: string; key: string }>;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/;

function cleanDeviceName(name: string): string {
	return name
		.replace(/[\u0000-\u001f]/g, "")
		.trim()
		.slice(0, 80);
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function parse(text: string): PhoneLinkFile {
	const raw = JSON.parse(text) as Partial<PhoneLinkFile>;
	const devices = Array.isArray(raw.devices)
		? raw.devices.filter(
				(device): device is PhoneDevice =>
					!!device &&
					typeof device.id === "string" &&
					/^[A-Za-z0-9_-]{6,64}$/.test(device.id) &&
					typeof device.key === "string" &&
					typeof device.createdAt === "number",
			)
		: [];
	return {
		version: 1,
		enabled: raw.enabled === true,
		port: validPort(raw.port) ? raw.port : DEFAULT_PHONE_LINK_PORT,
		devices: devices.map((device) => ({
			id: device.id,
			name: typeof device.name === "string" ? device.name.slice(0, 80) : "",
			key: device.key,
			createdAt: device.createdAt,
			pairedAt: typeof device.pairedAt === "number" ? device.pairedAt : null,
			lastSeenAt: typeof device.lastSeenAt === "number" ? device.lastSeenAt : null,
			...(device.source === "google" ? { source: "google" as const } : {}),
		})),
		remote: raw.remote !== false,
		blocked: Array.isArray(raw.blocked)
			? raw.blocked
					.filter(
						(entry): entry is { id: string; key: string } =>
							!!entry &&
							typeof entry.id === "string" &&
							DEVICE_ID.test(entry.id) &&
							typeof entry.key === "string",
					)
					.map((entry) => ({ id: entry.id, key: entry.key }))
					.slice(-64)
			: [],
	};
}

export class PhoneLinkStore {
	private data: PhoneLinkFile = {
		version: 1,
		enabled: false,
		port: DEFAULT_PHONE_LINK_PORT,
		devices: [],
		remote: true,
		blocked: [],
	};
	private readonly file: string;
	private readonly now: () => number;
	/** Set when the file exists but cannot be read: it is then left untouched rather than overwritten. */
	loadError: string | undefined;

	constructor(agentDir: string, now: () => number = Date.now) {
		this.file = join(agentDir, PHONE_LINK_FILE);
		this.now = now;
		if (existsSync(this.file)) {
			try {
				this.data = parse(readFileSync(this.file, "utf8"));
			} catch (error) {
				this.loadError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	get enabled(): boolean {
		return this.data.enabled;
	}

	get port(): number {
		return this.data.port;
	}

	/** Whether phones signed in with the same Google account may connect (from any network). */
	get remote(): boolean {
		return this.data.remote;
	}

	setRemote(remote: boolean): void {
		this.data.remote = remote;
		this.save();
	}

	/**
	 * Take the account's phones as Drive lists them (sync/phone/channel.ts): a new one becomes a paired phone, a changed
	 * key replaces the old one, and a phone that signed out (its registration is gone) is forgotten. Phones the user
	 * removed here stay removed. Returns whether anything changed.
	 */
	syncAccountPhones(phones: ReadonlyArray<{ phoneId: string; name: string; key: string }>): boolean {
		if (this.loadError) return false;
		const now = this.now();
		const listed = new Set(phones.map((phone) => phone.phoneId));
		// A removed phone that signed out has nothing left to block.
		const blocked = this.data.blocked.filter((entry) => listed.has(entry.id));
		let changed = blocked.length !== this.data.blocked.length;
		this.data.blocked = blocked;
		const wanted = new Map(
			phones
				.filter((phone) => !blocked.some((entry) => entry.id === phone.phoneId && entry.key === phone.key))
				.map((phone) => [phone.phoneId, phone]),
		);
		const kept: PhoneDevice[] = [];
		for (const device of this.data.devices) {
			if (device.source !== "google") {
				kept.push(device);
				continue;
			}
			const phone = wanted.get(device.id);
			if (!phone) {
				changed = true;
				continue;
			}
			wanted.delete(device.id);
			const name = cleanDeviceName(phone.name);
			if (device.key !== phone.key || (name && device.name !== name)) {
				changed = true;
				kept.push({ ...device, key: phone.key, ...(name ? { name } : {}) });
			} else kept.push(device);
		}
		for (const phone of wanted.values()) {
			if (kept.length >= MAX_DEVICES) break;
			// A QR-paired phone with the same id keeps its pairing.
			if (kept.some((device) => device.id === phone.phoneId)) continue;
			kept.push({
				id: phone.phoneId,
				name: cleanDeviceName(phone.name),
				key: phone.key,
				createdAt: now,
				pairedAt: now,
				lastSeenAt: null,
				source: "google",
			});
			changed = true;
		}
		if (!changed) return false;
		this.data.devices = kept;
		this.save();
		return true;
	}

	private save(): void {
		if (this.loadError)
			throw new Error(`phone-link.json cannot be read (${this.loadError}); fix or remove it first.`);
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.data, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.file);
	}

	setEnabled(enabled: boolean, port?: number): void {
		this.data.enabled = enabled;
		if (port !== undefined) {
			if (!validPort(port)) throw new Error("The port must be a whole number from 1024 to 65535.");
			this.data.port = port;
		}
		this.save();
	}

	/** Drop QR codes that were never used; returns whether anything changed. */
	private dropExpired(): boolean {
		const limit = this.now() - PAIRING_TTL_MS;
		const kept = this.data.devices.filter((device) => device.pairedAt !== null || device.createdAt > limit);
		if (kept.length === this.data.devices.length) return false;
		this.data.devices = kept;
		return true;
	}

	/** Paired phones and QR codes still waiting, newest first. */
	devices(): PhoneDevice[] {
		if (this.dropExpired()) this.save();
		return [...this.data.devices].sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Whether the user removed this phone of the account (it comes back only after signing in again). */
	isBlocked(deviceId: string): boolean {
		return this.data.blocked.some((entry) => entry.id === deviceId);
	}

	/** The key of a device that may connect (paired, or a QR code still valid). */
	keyOf(deviceId: string): Buffer | undefined {
		const device = this.data.devices.find((entry) => entry.id === deviceId);
		if (!device) return undefined;
		if (device.pairedAt === null && device.createdAt <= this.now() - PAIRING_TTL_MS) return undefined;
		// The account's phones connect only while the user allows it (Settings → Phone).
		if (device.source === "google" && !this.data.remote) return undefined;
		try {
			const key = fromBase64Url(device.key);
			return key.length === KEY_BYTES ? key : undefined;
		} catch {
			return undefined;
		}
	}

	/** A new QR code: an entry that becomes a paired phone when a phone connects with its key. One waits at a time. */
	createPairing(): PhoneDevice {
		this.dropExpired();
		this.data.devices = this.data.devices.filter((device) => device.pairedAt !== null);
		if (this.data.devices.length >= MAX_DEVICES) throw new Error("Too many paired phones. Remove one first.");
		const device: PhoneDevice = {
			id: newId(),
			name: "",
			key: toBase64Url(newKey()),
			createdAt: this.now(),
			pairedAt: null,
			lastSeenAt: null,
		};
		this.data.devices.push(device);
		this.save();
		return device;
	}

	/** A phone proved it holds the key. Returns true when this completed a pairing. */
	markSeen(deviceId: string, name?: string): boolean {
		const device = this.data.devices.find((entry) => entry.id === deviceId);
		if (!device) return false;
		const first = device.pairedAt === null;
		const now = this.now();
		const cleanName =
			typeof name === "string"
				? name
						.replace(/[\u0000-\u001f]/g, "")
						.trim()
						.slice(0, 80)
				: "";
		const renamed = cleanName !== "" && cleanName !== device.name;
		// The time of the last connection is saved at most once a minute: a phone reconnects often.
		const stale = device.lastSeenAt === null || now - device.lastSeenAt > 60_000;
		if (first) device.pairedAt = now;
		if (renamed) device.name = cleanName;
		device.lastSeenAt = now;
		if (first || renamed || stale) this.save();
		return first;
	}

	remove(deviceId: string): boolean {
		const removed = this.data.devices.find((device) => device.id === deviceId);
		if (!removed) return false;
		this.data.devices = this.data.devices.filter((device) => device.id !== deviceId);
		// A phone of the account would come back from Drive on the next read: remember that the user removed it.
		if (removed.source === "google")
			this.data.blocked = [
				...this.data.blocked.filter((entry) => entry.id !== deviceId),
				{ id: deviceId, key: removed.key },
			].slice(-64);
		this.save();
		return true;
	}
}
