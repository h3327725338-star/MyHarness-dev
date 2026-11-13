// The phone's half of the phone link's encryption (protocol v1). The PC's half and the reasons are in
// packages/coding-agent/src/modes/web/phone-link/crypto.ts: one 256-bit key per paired phone (read from the QR code),
// AES-256-GCM per message with a fresh nonce, and additional data naming the operation, the direction and the device.
// Uses the platform's Web Crypto only; no library.

export const LINK_PROTOCOL = "mh-link-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function linkAad(operation, direction, deviceId, binding = "") {
	return encoder.encode(`${LINK_PROTOCOL}|${operation}|${direction}|${deviceId}|${binding}`);
}

export async function importKey(keyText) {
	const raw = fromBase64Url(keyText);
	if (raw.length !== 32) throw new Error("The pairing key has the wrong length");
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key, aad, value) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, encoder.encode(JSON.stringify(value)));
	return { n: toBase64Url(nonce), c: toBase64Url(new Uint8Array(sealed)) };
}

/** Open a sealed message; rejects when the key, the additional data or any bit of the message is wrong. */
export async function open(key, aad, message) {
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(message.n), additionalData: aad, tagLength: 128 }, key, fromBase64Url(message.c));
	return JSON.parse(decoder.decode(plain));
}

/**
 * Read the text of a pairing QR code (`myharness://link?v=1&h=<hosts>&p=<port>&d=<device>&k=<key>&n=<name>`).
 * Throws with a reason a person can act on.
 */
export function parsePairing(text) {
	let url;
	try {
		url = new URL(String(text || "").trim());
	} catch {
		throw new Error("This is not a MyHarness pairing code.");
	}
	if (url.protocol !== "myharness:" || (url.host || url.pathname.replace(/^\/+/, "")) !== "link") throw new Error("This is not a MyHarness pairing code.");
	const params = url.searchParams;
	if (params.get("v") !== "1") throw new Error("This pairing code is from a newer MyHarness. Update the app.");
	const hosts = (params.get("h") || "")
		.split(",")
		.map((host) => host.trim())
		.filter((host) => /^[A-Za-z0-9.-]{1,253}$/.test(host));
	const port = Number(params.get("p"));
	const deviceId = params.get("d") || "";
	const key = params.get("k") || "";
	if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{6,64}$/.test(deviceId)) throw new Error("This pairing code is incomplete.");
	if (fromBase64Url(key).length !== 32) throw new Error("This pairing code is incomplete.");
	return { hosts, port, deviceId, key, name: (params.get("n") || "PC").slice(0, 40) };
}
