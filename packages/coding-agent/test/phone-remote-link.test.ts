import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newKey, toBase64Url } from "../src/modes/web/phone-link/crypto.ts";
import { PhoneLinkGateway } from "../src/modes/web/phone-link/gateway.ts";
import {
	inlineProperties,
	inlineText,
	offerName,
	PhoneRemoteLink,
	parseLinkName,
} from "../src/modes/web/phone-link/remote.ts";
import { PhoneLinkStore } from "../src/modes/web/phone-link/store.ts";
import { MemoryPhonePort } from "../src/sync/phone/port.ts";

// The phone's own code (packages/mobile), run here against the PC's: the relay and the direct connection end to end.
// (Plain JavaScript without type declarations: the parts used here are typed by hand.)
type Sealed = { n: string; c: string };
type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
interface PhonePipe {
	transport: "direct" | "relay";
	request(operation: string, envelope: Record<string, unknown>): Promise<{ status: number; body: Sealed }>;
	events(envelope: Record<string, unknown>, onFrame: (frame: string) => void, signal?: AbortSignal): Promise<void>;
	close(): void;
}
interface PhoneRemote {
	openRelay(options: Record<string, unknown>): PhonePipe;
	openDirect(options: Record<string, unknown>): Promise<PhonePipe>;
	inlineProperties(text: string): Record<string, string> | undefined;
	inlineText(file: { size?: number | string; properties?: Record<string, string> }): string | undefined;
}
interface PhoneCrypto {
	importKey(text: string): Promise<CryptoKey>;
	seal(key: CryptoKey, aad: Uint8Array, value: unknown): Promise<Sealed>;
	open(key: CryptoKey, aad: Uint8Array, message: Sealed): Promise<Record<string, unknown> & { e: string; d: unknown }>;
	linkAad(operation: string, direction: string, deviceId: string, binding?: string): Uint8Array;
}
const phoneRemote = (await import("../../mobile/web/js/link-remote.js" as string)) as PhoneRemote;
const phoneCrypto = (await import("../../mobile/web/js/link-crypto.js" as string)) as PhoneCrypto;

const PC_ID = "4f1c2b7e-0000-4000-8000-00000000abcd";
const PHONE_ID = "phonetest01";

/** werift behind the browser's RTCPeerConnection surface, the part the phone's code uses (a WebView has the real one). */
async function domPeerClass() {
	const werift = await import("werift");
	type Listener = (event?: unknown) => void;
	class Emitter {
		private readonly listeners = new Map<string, Set<Listener>>();
		addEventListener(type: string, listener: Listener) {
			const set = this.listeners.get(type) ?? new Set<Listener>();
			set.add(listener);
			this.listeners.set(type, set);
		}
		fire(type: string, event?: unknown) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	type Channel = ReturnType<InstanceType<typeof werift.RTCPeerConnection>["createDataChannel"]>;
	class DomChannel extends Emitter {
		readonly channel: Channel;
		constructor(channel: Channel) {
			super();
			this.channel = channel;
			channel.stateChanged.subscribe((state: string) => {
				if (state === "open") this.fire("open");
				if (state === "closed") this.fire("close");
			});
			channel.onMessage.subscribe((data: string | Buffer) =>
				this.fire("message", { data: typeof data === "string" ? data : new Uint8Array(data) }),
			);
		}
		get readyState() {
			return this.channel.readyState;
		}
		send(data: string) {
			this.channel.send(data);
		}
		close() {
			this.channel.close();
		}
	}
	return class DomPeer extends Emitter {
		private readonly peer: InstanceType<typeof werift.RTCPeerConnection>;
		constructor(config: { iceServers: Array<{ urls: string }> }) {
			super();
			this.peer = new werift.RTCPeerConnection(config);
			this.peer.iceGatheringStateChange.subscribe(() => this.fire("icegatheringstatechange"));
			this.peer.connectionStateChange.subscribe(() => this.fire("connectionstatechange"));
		}
		get iceGatheringState() {
			return this.peer.iceGatheringState;
		}
		get connectionState() {
			return this.peer.connectionState;
		}
		get localDescription() {
			return this.peer.localDescription;
		}
		createDataChannel(label: string, options: Record<string, unknown>) {
			return new DomChannel(this.peer.createDataChannel(label, options));
		}
		createOffer() {
			return this.peer.createOffer();
		}
		setLocalDescription(description: { type: "offer" | "answer"; sdp: string }) {
			return this.peer.setLocalDescription(description);
		}
		setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }) {
			return this.peer.setRemoteDescription(description);
		}
		close() {
			void this.peer.close();
		}
	};
}

describe("phone link from any network", () => {
	let dir: string;
	let upstream: Server;
	let store: PhoneLinkStore;
	let gateway: PhoneLinkGateway;
	let remote: PhoneRemoteLink;
	let drive: MemoryPhonePort;
	let keyText: string;
	let emit: (event: string, data: unknown) => void;
	let bodies: string[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "mh-phone-remote-"));
		bodies = [];
		upstream = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				bodies.push(Buffer.concat(chunks).toString("utf8"));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, path: req.url, size: Buffer.concat(chunks).length }));
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		store = new PhoneLinkStore(dir);
		// The local network server stays off: everything below goes through Drive or WebRTC.
		expect(store.enabled).toBe(false);
		keyText = toBase64Url(newKey());
		expect(store.syncAccountPhones([{ phoneId: PHONE_ID, name: "Pixel", key: keyText }])).toBe(true);
		const taps = new Set<(event: string, data: unknown) => void>();
		emit = (event, data) => {
			for (const tap of taps) tap(event, data);
		};
		gateway = new PhoneLinkGateway({
			store,
			upstream: () => `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
			tap: (listener) => {
				taps.add(listener);
				return () => taps.delete(listener);
			},
			info: () => ({ name: "Test PC", version: "0.0.0" }),
		});
		drive = new MemoryPhonePort();
		remote = new PhoneRemoteLink({
			gateway,
			store,
			port: () => drive,
			deviceId: () => PC_ID,
			allowed: () => true,
			iceServers: [],
			pollMs: { idle: 40, relay: 40 },
		});
		remote.start();
	});

	afterEach(async () => {
		await remote.stop();
		await gateway.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * What backend-remote.js does over any transport: open a session, call a route, read the event stream. `burst`: that
	 * many snapshots of a growing reply are sent at once before the last event.
	 */
	async function useLink(pipe: PhonePipe, uploadBytes = 0, burst = 0) {
		const key = await phoneCrypto.importKey(keyText);
		const sealedOpen = await phoneCrypto.seal(key, phoneCrypto.linkAad("open", "req", PHONE_ID), { name: "Pixel 9" });
		const opened = await pipe.request("open", { d: PHONE_ID, ...sealedOpen });
		expect(opened.status).toBe(200);
		const session = (
			await phoneCrypto.open(key, phoneCrypto.linkAad("open", "res", PHONE_ID, sealedOpen.n), opened.body)
		).s as string;
		expect(session).toBeTruthy();

		const payload = uploadBytes
			? { s: session, q: 1, m: "POST", p: "/api/files/upload", b: { name: "a.bin", data: "x".repeat(uploadBytes) } }
			: { s: session, q: 1, m: "GET", p: "/api/state" };
		const sealedCall = await phoneCrypto.seal(key, phoneCrypto.linkAad("call", "req", PHONE_ID), payload);
		const called = await pipe.request("call", { d: PHONE_ID, ...sealedCall });
		expect(called.status).toBe(200);
		const answer = await phoneCrypto.open(
			key,
			phoneCrypto.linkAad("call", "res", PHONE_ID, sealedCall.n),
			called.body,
		);

		const frames: Array<{ e: string; d: unknown }> = [];
		const aad = phoneCrypto.linkAad("events", "evt", PHONE_ID, session);
		const abort = new AbortController();
		const sealedEvents = await phoneCrypto.seal(key, phoneCrypto.linkAad("events", "req", PHONE_ID), {
			s: session,
			q: 2,
		});
		const streaming = pipe.events(
			{ d: PHONE_ID, ...sealedEvents },
			(frame: string) => {
				const [n, c] = frame.split(".");
				void phoneCrypto.open(key, aad, { n: n!, c: c! }).then((message) => frames.push(message));
			},
			abort.signal,
		);
		await until(() => frames.some((frame) => frame.e === "link"));
		for (let count = 1; count <= burst; count++) {
			emit("message_update", {
				slot: "s1",
				liveId: "live-1",
				item: { kind: "assistant", text: "x".repeat(count * 100) },
			});
			emit("usage", { slot: "s1", tokens: count });
		}
		if (burst) {
			emit("run_state", { slot: "s1", running: false });
			emit("usage", { slot: "s1", tokens: 99 });
		}
		emit("message_update", { slot: "s1", text: "半句" });
		emit("terminal_output", { secret: true }); // not an event a phone gets
		await until(() =>
			frames.some((frame) => frame.e === "message_update" && (frame.d as { text?: string }).text === "半句"),
		);
		abort.abort();
		await streaming;
		return { answer, frames };
	}

	it("carries requests, answers and events through Drive files when there is no direct path", async () => {
		const pipe = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		const { answer, frames } = await useLink(pipe);
		expect(answer).toEqual({ status: 200, json: { ok: true, path: "/api/state", size: 0 } });
		expect(frames.map((frame) => frame.e)).toEqual(["link", "message_update"]);
		expect(frames[1]!.d).toEqual({ slot: "s1", text: "半句" });
		expect(remote.status().connections).toEqual([expect.objectContaining({ phoneId: PHONE_ID, transport: "relay" })]);
		expect(gateway.status().devices[0]).toMatchObject({ id: PHONE_ID, source: "google" });
		pipe.close();
		// Every message file was read and removed by its receiver.
		await until(() => [...(drive.folders.get("link")?.keys() ?? [])].length === 0);
		await until(() => remote.status().connections.length === 0);
	});

	it("hands small message files over in the folder listing, and reads larger ones from Drive", async () => {
		const reads: string[] = [];
		const read = drive.phoneRead.bind(drive);
		drive.phoneRead = async (folder, name) => {
			if (folder === "link") reads.push(name);
			return read(folder, name);
		};
		const small = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		expect((await useLink(small)).answer).toMatchObject({ status: 200 });
		// Neither side downloaded a single message: each came with the listing.
		expect(reads).toEqual([]);
		small.close();
		await until(() => remote.status().connections.length === 0);
		const large = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		expect((await useLink(large, 6000)).answer).toMatchObject({ status: 200, json: { size: expect.any(Number) } });
		expect(JSON.parse(bodies.at(-1)!).data.length).toBe(6000);
		// Only the phone's message that carried the upload was read from its file.
		expect(reads).toHaveLength(1);
		expect(reads[0]).toMatch(new RegExp(`^m__${PC_ID}__${PHONE_ID}__`));
		large.close();
	});

	it("puts one copy of a growing reply in a Drive file, the newest", async () => {
		const pipe = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		const { frames } = await useLink(pipe, 0, 20);
		const updates = frames.filter(
			(frame) => frame.e === "message_update" && (frame.d as { liveId?: string }).liveId === "live-1",
		);
		expect(updates).toHaveLength(1);
		expect((updates[0]!.d as { item: { text: string } }).item.text).toHaveLength(2000);
		// The usage meter keeps only its newest value, even past a final frame; the other events still come, in order.
		expect(frames.map((frame) => frame.e)).toEqual([
			"link",
			"message_update",
			"run_state",
			"usage",
			"message_update",
		]);
		expect(frames.find((frame) => frame.e === "usage")!.d).toEqual({ slot: "s1", tokens: 99 });
		pipe.close();
		await until(() => remote.status().connections.length === 0);
	});

	it("opens a direct WebRTC connection and splits long messages into parts", async () => {
		const RTCPeerConnection = await domPeerClass();
		const pipe = await phoneRemote.openDirect({
			drive,
			pcId: PC_ID,
			phoneId: PHONE_ID,
			key: await phoneCrypto.importKey(keyText),
			RTCPeerConnection,
			iceServers: [],
		});
		expect(pipe.transport).toBe("direct");
		// The offer and the answer were removed once read.
		expect([...(drive.folders.get("link")?.keys() ?? [])]).toEqual([]);
		const { answer, frames } = await useLink(pipe, 200_000);
		expect(answer).toMatchObject({ status: 200, json: { ok: true, path: "/api/files/upload" } });
		expect(JSON.parse(bodies.at(-1)!).data.length).toBe(200_000);
		expect(frames.map((frame) => frame.e)).toEqual(["link", "message_update"]);
		expect(remote.status().connections).toEqual([expect.objectContaining({ transport: "direct" })]);
		pipe.close();
		await until(() => remote.status().connections.length === 0);
	}, 30_000);

	it("ignores offers it cannot open and phones it no longer knows", async () => {
		const stranger = await phoneCrypto.importKey(toBase64Url(newKey()));
		const sealed = await phoneCrypto.seal(
			stranger,
			phoneCrypto.linkAad("rtc-offer", "req", PHONE_ID, `${PC_ID}/abcdef123`),
			{
				sdp: "v=0",
				at: Date.now(),
			},
		);
		await drive.phoneCreate("link", offerName(PC_ID, PHONE_ID, "abcdef123"), Buffer.from(JSON.stringify(sealed)));
		await until(() => !drive.folders.get("link")?.size);
		expect([...(drive.folders.get("link")?.keys() ?? [])].filter((name) => name.startsWith("a__"))).toEqual([]);

		// Removed on the PC: the relay gets no answer, and the phone is not taken back from Drive with the same key.
		expect(store.remove(PHONE_ID)).toBe(true);
		expect(store.syncAccountPhones([{ phoneId: PHONE_ID, name: "Pixel", key: keyText }])).toBe(false);
		expect(store.keyOf(PHONE_ID)).toBeUndefined();
		const pipe = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		const key = await phoneCrypto.importKey(keyText);
		const sealedOpen = await phoneCrypto.seal(key, phoneCrypto.linkAad("open", "req", PHONE_ID), {});
		const answered = await Promise.race([
			pipe.request("open", { d: PHONE_ID, ...sealedOpen }).then(() => "answered"),
			new Promise((resolve) => setTimeout(() => resolve("silent"), 600)),
		]);
		expect(answered).toBe("silent");
		pipe.close();
	});

	it("keeps the first messages of a phone that signed in a moment ago until it knows the phone", async () => {
		// The phone connects right after signing in; this PC reads its registration a few seconds later.
		await remote.stop();
		let unknown = 0;
		remote = new PhoneRemoteLink({
			gateway,
			store,
			port: () => drive,
			deviceId: () => PC_ID,
			allowed: () => true,
			iceServers: [],
			pollMs: { idle: 40, relay: 40 },
			onUnknownPhone: () => {
				unknown += 1;
			},
		});
		remote.start();
		const newcomer = "phonetest02";
		const newcomerKey = toBase64Url(newKey());
		const pipe = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: newcomer, pollMs: 40 });
		const key = await phoneCrypto.importKey(newcomerKey);
		const sealedOpen = await phoneCrypto.seal(key, phoneCrypto.linkAad("open", "req", newcomer), {
			name: "New phone",
		});
		const opening = pipe.request("open", { d: newcomer, ...sealedOpen });
		await until(() => unknown >= 2);
		// Looked at more than once and still there, unanswered.
		expect(
			[...(drive.folders.get("link")?.keys() ?? [])].some((name) => name.startsWith(`m__${PC_ID}__${newcomer}__`)),
		).toBe(true);
		expect(
			store.syncAccountPhones([
				{ phoneId: PHONE_ID, name: "Pixel", key: keyText },
				{ phoneId: newcomer, name: "New phone", key: newcomerKey },
			]),
		).toBe(true);
		const opened = await opening;
		expect(opened.status).toBe(200);
		const answer = await phoneCrypto.open(
			key,
			phoneCrypto.linkAad("open", "res", newcomer, sealedOpen.n),
			opened.body,
		);
		expect(answer.s).toBeTruthy();
		pipe.close();
	});

	it("puts a small file's text in Drive's properties within their limits, and trusts them only whole", () => {
		const text = `{"v":1,"m":[${"x".repeat(2486)}]}`;
		expect(text).toHaveLength(2500);
		const properties = inlineProperties(text)!;
		expect(Object.keys(properties)).toHaveLength(26);
		for (const [key, value] of Object.entries(properties))
			expect(Buffer.byteLength(key + value, "utf8")).toBeLessThanOrEqual(124);
		// The PC's and the phone's code write the same and read each other's.
		expect(phoneRemote.inlineProperties(text)).toEqual(properties);
		expect(inlineText({ size: 2500, properties })).toBe(text);
		expect(phoneRemote.inlineText({ size: "2500", properties })).toBe(text);
		// Not the whole file, or a part missing: read from Drive instead.
		expect(inlineText({ size: 2501, properties })).toBeUndefined();
		const { c3: _, ...missing } = properties;
		expect(inlineText({ size: 2500, properties: missing })).toBeUndefined();
		expect(inlineText({ size: 2500 })).toBeUndefined();
		// Too long, empty, or not plain ASCII: not put in properties at all.
		expect(inlineProperties(`${text}x`)).toBeUndefined();
		expect(inlineProperties("")).toBeUndefined();
		expect(inlineProperties('{"a":"半"}')).toBeUndefined();
		expect(phoneRemote.inlineProperties('{"a":"半"}')).toBeUndefined();
	});

	it("stops taking the account's phones when remote connections are turned off", async () => {
		store.setRemote(false);
		await until(() => !remote.status().active);
		expect(gateway.status().remoteActive).toBe(false);
		expect(store.keyOf(PHONE_ID)).toBeUndefined();
		store.setRemote(true);
		remote.poke();
		await until(() => remote.status().active);
		expect(store.keyOf(PHONE_ID)?.length).toBe(32);
	});

	// Last in this group: after it, the phone's code writes link files without properties for the rest of the file.
	it("goes on without properties when Drive refuses them", async () => {
		const create = drive.phoneCreate.bind(drive);
		let refused = 0;
		drive.phoneCreate = async (folder, name, data, options) => {
			if (options?.properties) {
				refused += 1;
				throw Object.assign(new Error("The limit for property size has been exceeded."), { status: 400 });
			}
			return create(folder, name, data, options);
		};
		const pipe = phoneRemote.openRelay({ drive, pcId: PC_ID, phoneId: PHONE_ID, pollMs: 40 });
		expect((await useLink(pipe)).answer).toMatchObject({ status: 200 });
		// Each side was refused once, then wrote without them.
		expect(refused).toBe(2);
		pipe.close();
	});
});

describe("account phones in the phone link store", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mh-phone-store-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("adds, updates and forgets phones as Drive lists them", () => {
		const store = new PhoneLinkStore(dir);
		const qr = store.createPairing();
		store.markSeen(qr.id, "Old phone");
		const first = toBase64Url(newKey());
		expect(store.syncAccountPhones([{ phoneId: "phone-a1", name: "Pixel\u0007", key: first }])).toBe(true);
		expect(store.syncAccountPhones([{ phoneId: "phone-a1", name: "Pixel", key: first }])).toBe(false);
		expect(new PhoneLinkStore(dir).devices().find((device) => device.id === "phone-a1")).toMatchObject({
			name: "Pixel",
			source: "google",
		});
		const second = toBase64Url(newKey());
		expect(store.syncAccountPhones([{ phoneId: "phone-a1", name: "Pixel", key: second }])).toBe(true);
		expect(store.keyOf("phone-a1")?.equals(Buffer.from(second, "base64url"))).toBe(true);
		// Signed out on the phone: gone here too. The QR-paired phone stays.
		expect(store.syncAccountPhones([])).toBe(true);
		expect(store.devices().map((device) => device.id)).toEqual([qr.id]);
	});

	it("keeps a removed phone out until it signs in again with a new key", () => {
		const store = new PhoneLinkStore(dir);
		const key = toBase64Url(newKey());
		store.syncAccountPhones([{ phoneId: "phone-b1", name: "P", key }]);
		store.remove("phone-b1");
		expect(store.syncAccountPhones([{ phoneId: "phone-b1", name: "P", key }])).toBe(false);
		expect(store.syncAccountPhones([{ phoneId: "phone-b1", name: "P", key: toBase64Url(newKey()) }])).toBe(true);
		expect(store.keyOf("phone-b1")?.length).toBe(32);
	});

	it("reads link file names back", () => {
		expect(parseLinkName(`o__${PC_ID}__${PHONE_ID}__c0nn1d.json`)).toEqual({
			kind: "offer",
			to: PC_ID,
			from: PHONE_ID,
			conn: "c0nn1d",
		});
		expect(parseLinkName(`m__${PHONE_ID}__${PC_ID}__c0nn1d__0000000a.json`)).toMatchObject({
			kind: "relay",
			seq: 10,
		});
		expect(parseLinkName("m__a__b.json")).toBeUndefined();
		expect(parseLinkName(`o__${PC_ID}__x_y__c.json`)).toBeUndefined();
	});
});

async function until(check: () => boolean, timeout = 8000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
