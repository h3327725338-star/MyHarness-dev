/**
 * Encryption of the phone link (protocol v1).
 *
 * The phone and this PC share one 256-bit key per paired phone, shown once as a QR code on the PC's own screen.
 * Every message between them is sealed with AES-256-GCM under that key: a fresh 96-bit nonce per message, and
 * "additional data" that names the protocol, the operation, the direction and the device, so a sealed message
 * cannot be replayed as another kind of message or towards the other side. The link itself is plain HTTP on the
 * local network; nothing readable crosses it except the device id and the operation name.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const LINK_PROTOCOL = "mh-link-v1";
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Buffer {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
	return Buffer.from(text, "base64url");
}

export function newKey(): Buffer {
	return randomBytes(KEY_BYTES);
}

export function newId(bytes = 9): string {
	return toBase64Url(randomBytes(bytes));
}

/** The "additional data" of one message: what it is, which way it travels and between whom. */
export function linkAad(operation: string, direction: "req" | "res" | "evt", deviceId: string, binding = ""): Buffer {
	return Buffer.from(`${LINK_PROTOCOL}|${operation}|${direction}|${deviceId}|${binding}`, "utf8");
}

export interface SealedMessage {
	/** Nonce, base64url. */
	n: string;
	/** Ciphertext followed by the 16-byte tag, base64url. */
	c: string;
}

export function seal(key: Uint8Array, aad: Uint8Array, value: unknown): SealedMessage {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(aad);
	const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
	return { n: toBase64Url(nonce), c: toBase64Url(body) };
}

/** Open a sealed message. Throws when the key, the additional data or a single bit of the message is wrong. */
export function open(key: Uint8Array, aad: Uint8Array, message: SealedMessage): unknown {
	const nonce = fromBase64Url(message.n);
	const body = fromBase64Url(message.c);
	if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) throw new Error("Malformed message");
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAAD(aad);
	decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
	const text = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString(
		"utf8",
	);
	return JSON.parse(text);
}

/**
 * Remembers which message counters of one link session were used. A phone sends several requests at once, so they
 * may arrive out of order: any counter not seen before is accepted while it is within `window` of the highest one.
 */
export class ReplayWindow {
	private highest = 0;
	private readonly seen = new Set<number>();
	private readonly window: number;

	constructor(window = 4096) {
		this.window = window;
	}

	accept(counter: unknown): boolean {
		if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter <= 0) return false;
		if (counter <= this.highest - this.window || this.seen.has(counter)) return false;
		this.seen.add(counter);
		if (counter > this.highest) {
			this.highest = counter;
			if (this.seen.size > this.window * 2) {
				for (const value of this.seen) if (value <= this.highest - this.window) this.seen.delete(value);
			}
		}
		return true;
	}
}
