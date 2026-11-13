/**
 * The phone link from outside the local network, for phones signed in with the same Google account.
 *
 * Such a phone left its key in the account's Drive (`MyHarness/phone-v1/phones/`, sync/phone/channel.ts), and the
 * PC took it into the phone link's store (store.ts `syncAccountPhones`). To connect, the phone and the PC meet in the
 * account's Drive, in `MyHarness/phone-v1/link/`:
 *
 * 1. The phone writes an offer `o__<pc id>__<phone id>__<connection>.json`: a WebRTC session description, sealed
 *    with its key (crypto.ts). This PC reads `link/` every few seconds while it has phones of the account.
 * 2. The PC answers in `a__<phone id>__<pc id>__<connection>.json`, sealed the same way, and the two open a direct
 *    WebRTC data channel (werift here, the WebView's own WebRTC on the phone). STUN finds each side's public address;
 *    there is no TURN server, so some networks (mobile carriers in particular) allow no direct path.
 * 3. Without a direct path the phone sends the same messages as files instead: `m__<to>__<from>__<connection>__
 *    <sequence>.json`, each read and then removed by its receiver. That is the slow path ("relay"): a second or two
 *    per message, and Drive is the only thing in between. A small file also carries its text in its properties
 *    (`inlineProperties`), so the receiver has it from the listing without a download.
 *
 * Either way, what travels is the phone link's own protocol (gateway.ts): every request is sealed with the phone's
 * key and checked by `dispatch`, every answer and event is sealed back. A pipe message is one of
 *
 *     phone → PC   { t: "q", i, o: "open" | "call" | "events", e: <sealed envelope> }   a request
 *                  { t: "x", i }                                                       stop event stream i
 *                  { t: "k" }                                                          still here (relay)
 *     PC → phone   { t: "r", i, s: <status>, b: <sealed body or { error }> }           the answer to request i
 *                  { t: "f", i, f: "<nonce>.<ciphertext>" }                            an event of stream i
 *                  { t: "z", i }                                                       stream i ended
 *     both         { t: "bye" }                                                        the connection is closed
 *
 * and on the data channel a message longer than CHUNK_CHARS goes as parts { t: "p", k, j, n, d }.
 */

import type { PhoneDrivePort } from "../../../sync/phone/port.ts";
import { linkAad, open, seal } from "./crypto.ts";
import {
	type FrameProgress,
	type LinkStreamSink,
	type LinkTransport,
	linkErrorStatus,
	type PhoneLinkGateway,
} from "./gateway.ts";
import type { PhoneLinkStore } from "./store.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Phone ids and connection ids: no "__", so a file name splits into its parts. */
const ID = /^[A-Za-z0-9-]{6,64}$/;
export const CHUNK_CHARS = 16_000;
// How often `link/` is looked at. Drive tells nobody about a new file, so this is what a phone waits for before the PC
// sees its offer or its first message; a phone connects in a second or two only if the PC looks often even when no
// phone is connected. Listing a folder is a read, which Drive allows far more of than writes.
const IDLE_POLL_MS = 1_000;
const RELAY_POLL_MS = 500;
// While a phone on the relay is in use (it sent something other than a keep-alive within RELAY_BUSY_MS), `link/` is
// looked at this often: every look the PC skips is time the phone's next message waits.
const RELAY_BUSY_POLL_MS = 250;
const RELAY_BUSY_MS = 60_000;
/** A link file of up to INLINE_PARTS × INLINE_PART characters also rides in its custom properties (`inlineProperties`). */
const INLINE_PART = 100;
const INLINE_PARTS = 25;
const OFFER_MAX_AGE_MS = 2 * 60_000;
const OPEN_TIMEOUT_MS = 30_000;
const GATHER_TIMEOUT_MS = 3_000;
const RELAY_IDLE_MS = 150_000;
const RELAY_LEFTOVER_MS = 2_000;
const CLEANUP_MS = 5 * 60_000;
/**
 * Files from a phone this PC does not know yet wait this long for its registration (it signed in a moment ago and
 * `phones/` is read every few seconds) instead of being removed at once.
 */
const UNKNOWN_PHONE_WAIT_MS = 60_000;
/** Files of a connection nobody read (the other side went away) are removed after this long. */
const STALE_FILE_MS = 10 * 60_000;
/** One relay file stays well under Drive's 5 MB limit for a simple upload. */
const RELAY_FILE_CHARS = 3_000_000;
const RELAY_PART_CHARS = 2_000_000;
const MAX_CONNECTIONS = 8;
export const DEFAULT_ICE_SERVERS = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" },
];

/** The parts of WebRTC this file uses; werift by default, a fake in tests. */
export interface RtcChannel {
	readyState: string;
	bufferedAmount: number;
	bufferedAmountLowThreshold: number;
	send(data: string): void;
	close(): void;
	onMessage: { subscribe(listener: (data: string | Uint8Array) => void): unknown };
	stateChanged: { subscribe(listener: (state: string) => void): unknown };
	bufferedAmountLow: { subscribe(listener: () => void): unknown };
}

export interface RtcPeer {
	onDataChannel: { subscribe(listener: (channel: RtcChannel) => void): unknown };
	connectionStateChange: { subscribe(listener: (state: string) => void): unknown };
	iceGatheringState: string;
	iceGatheringStateChange: { subscribe(listener: (state: string) => void): unknown };
	localDescription: { sdp: string; type: string } | null;
	setRemoteDescription(description: { type: "offer"; sdp: string }): Promise<void>;
	createAnswer(): Promise<{ sdp: string; type: string }>;
	setLocalDescription(description: { sdp: string; type: string }): Promise<unknown>;
	close(): Promise<void>;
}

export type RtcFactory = (config: { iceServers: Array<{ urls: string }> }) => RtcPeer;

async function weriftFactory(): Promise<RtcFactory> {
	// Loaded on first use: most PCs never get a remote connection, and the library is large.
	const werift = await import("werift");
	return (config) => new werift.RTCPeerConnection(config) as unknown as RtcPeer;
}

export function offerName(pcId: string, phoneId: string, conn: string): string {
	return `o__${pcId}__${phoneId}__${conn}.json`;
}

export function answerName(phoneId: string, pcId: string, conn: string): string {
	return `a__${phoneId}__${pcId}__${conn}.json`;
}

export function relayName(to: string, from: string, conn: string, seq: number): string {
	return `m__${to}__${from}__${conn}__${seq.toString(36).padStart(8, "0")}.json`;
}

/**
 * A small link file's text, also put in the file's custom properties (`n`: how many parts, `c0`, `c1`…: the text in
 * parts of 100 characters), so the other side has it from the listing it makes anyway and skips one download per
 * message. Only printable ASCII (sealed JSON is) and at most 25 parts: Drive keeps 30 properties of 124 bytes per file.
 */
export function inlineProperties(text: string): Record<string, string> | undefined {
	if (!text || text.length > INLINE_PART * INLINE_PARTS || !/^[ -~]*$/.test(text)) return undefined;
	const properties: Record<string, string> = {};
	let count = 0;
	for (let at = 0; at < text.length; at += INLINE_PART) properties[`c${count++}`] = text.slice(at, at + INLINE_PART);
	properties.n = String(count);
	return properties;
}

/** The text a listing carries for a file (`inlineProperties`); undefined when it does not, or it is not the whole file. */
export function inlineText(file: { size?: number | string; properties?: Record<string, string> }): string | undefined {
	const properties = file.properties;
	const count = Number(properties?.n);
	if (!properties || !Number.isInteger(count) || count < 1 || count > INLINE_PARTS) return undefined;
	let text = "";
	for (let index = 0; index < count; index++) {
		const part = properties[`c${index}`];
		if (typeof part !== "string") return undefined;
		text += part;
	}
	return Number(file.size) === text.length ? text : undefined;
}

export function signalAad(kind: "rtc-offer" | "rtc-answer", phoneId: string, pcId: string, conn: string): Buffer {
	return linkAad(kind, kind === "rtc-offer" ? "req" : "res", phoneId, `${pcId}/${conn}`);
}

type ParsedName =
	| { kind: "offer"; to: string; from: string; conn: string }
	| { kind: "answer"; to: string; from: string; conn: string }
	| { kind: "relay"; to: string; from: string; conn: string; seq: number };

export function parseLinkName(name: string): ParsedName | undefined {
	const match = /^([oam])__(.+)\.json$/.exec(name);
	if (!match) return undefined;
	const parts = match[2]!.split("__");
	const valid = (id: string | undefined) => !!id && /^[A-Za-z0-9-]{1,64}$/.test(id);
	if (match[1] === "m") {
		if (parts.length !== 4 || !parts.slice(0, 3).every(valid) || !/^[0-9a-z]{1,12}$/.test(parts[3]!))
			return undefined;
		return { kind: "relay", to: parts[0]!, from: parts[1]!, conn: parts[2]!, seq: Number.parseInt(parts[3]!, 36) };
	}
	if (parts.length !== 3 || !parts.every(valid)) return undefined;
	return { kind: match[1] === "o" ? "offer" : "answer", to: parts[0]!, from: parts[1]!, conn: parts[2]! };
}

/** Split a long message into parts for the data channel; each part is itself a message. */
export function chunkMessage(text: string, key: string, size = CHUNK_CHARS): string[] {
	if (text.length <= size) return [text];
	const count = Math.ceil(text.length / size);
	const parts: string[] = [];
	for (let index = 0; index < count; index++)
		parts.push(
			JSON.stringify({ t: "p", k: key, j: index, n: count, d: text.slice(index * size, (index + 1) * size) }),
		);
	return parts;
}

/** Puts parts back together; returns a whole message's text, or undefined while parts are missing. */
export class PartAssembler {
	private readonly pending = new Map<string, { parts: string[]; count: number; got: number }>();

	take(message: Json): string | undefined {
		const key = typeof message.k === "string" ? message.k : "";
		const index = message.j;
		const count = message.n;
		if (!key || typeof index !== "number" || typeof count !== "number" || typeof message.d !== "string")
			return undefined;
		if (count < 1 || count > 4096 || index < 0 || index >= count) return undefined;
		let entry = this.pending.get(key);
		if (!entry) {
			if (this.pending.size > 64) this.pending.clear();
			entry = { parts: new Array(count), count, got: 0 };
			this.pending.set(key, entry);
		}
		if (entry.count !== count || entry.parts[index] !== undefined) return undefined;
		entry.parts[index] = message.d;
		entry.got += 1;
		if (entry.got < count) return undefined;
		this.pending.delete(key);
		return entry.parts.join("");
	}
}

/** One way to send pipe messages back to a phone. */
interface PipeOut {
	/** `progress`: what an event frame's progress shows (LinkStreamSink.send), for a transport that gathers frames. */
	send(message: Json, progress?: FrameProgress): void;
	/** Whether the transport is behind (event frames then wait). */
	backedUp(): boolean;
	onDrain(listener: () => void): void;
}

/**
 * One connection of one phone, over either transport: requests go to the gateway, answers and event frames come
 * back in order.
 */
class PipeConnection {
	readonly phoneId: string;
	readonly conn: string;
	readonly transport: Exclude<LinkTransport, "lan">;
	private readonly gateway: PhoneLinkGateway;
	private readonly out: PipeOut;
	private readonly streams = new Map<number, { end: () => void; closeListeners: Array<() => void> }>();
	private readonly drainListeners = new Set<() => void>();
	closed = false;
	lastIn: number;
	/** When the phone last sent something other than a keep-alive (the relay is then looked at more often). */
	lastBusy: number;
	private readonly onClosed: () => void;

	constructor(input: {
		phoneId: string;
		conn: string;
		transport: Exclude<LinkTransport, "lan">;
		gateway: PhoneLinkGateway;
		out: PipeOut;
		now: number;
		onClosed: () => void;
	}) {
		this.phoneId = input.phoneId;
		this.conn = input.conn;
		this.transport = input.transport;
		this.gateway = input.gateway;
		this.out = input.out;
		this.lastIn = input.now;
		this.lastBusy = input.now;
		this.onClosed = input.onClosed;
		this.out.onDrain(() => {
			for (const listener of [...this.drainListeners]) listener();
		});
	}

	async receive(message: unknown, now: number): Promise<void> {
		if (this.closed || !isObject(message)) return;
		this.lastIn = now;
		if (message.t !== "k") this.lastBusy = now;
		if (message.t === "bye") {
			this.close(false);
			return;
		}
		if (message.t === "x" && typeof message.i === "number") {
			this.streams.get(message.i)?.end();
			return;
		}
		if (message.t !== "q" || typeof message.i !== "number") return;
		const id = message.i;
		const operation = message.o;
		if ((operation !== "open" && operation !== "call" && operation !== "events") || !isObject(message.e)) {
			this.out.send({ t: "r", i: id, s: 400, b: { error: "Bad request" } });
			return;
		}
		try {
			const result = await this.gateway.dispatch(operation, message.e, `${this.transport}:${this.phoneId}`);
			if (this.closed) return;
			if (result.kind === "json") {
				this.out.send({ t: "r", i: id, s: 200, b: result.body });
				return;
			}
			this.out.send({ t: "r", i: id, s: 200, b: { stream: true } });
			this.gateway.attachStream(result, this.sink(id), this.transport);
		} catch (error) {
			const { status, message: text } = linkErrorStatus(error);
			if (!this.closed) this.out.send({ t: "r", i: id, s: status, b: { error: text } });
		}
	}

	private sink(id: number): LinkStreamSink {
		const entry = { end: () => {}, closeListeners: [] as Array<() => void> };
		let open = true;
		const finish = (notify: boolean) => {
			if (!open) return;
			open = false;
			this.streams.delete(id);
			if (notify && !this.closed) this.out.send({ t: "z", i: id });
			for (const listener of entry.closeListeners) listener();
		};
		entry.end = () => finish(true);
		this.streams.set(id, entry);
		return {
			send: (frame, progress) => {
				if (!open) return true;
				// Keep-alives are not needed here: the data channel has its own, and Drive is polled.
				if (frame) this.out.send({ t: "f", i: id, f: frame }, progress);
				return !this.out.backedUp();
			},
			end: () => finish(true),
			destroy: () => finish(true),
			onDrain: (listener) => this.drainListeners.add(listener),
			onClose: (listener) => entry.closeListeners.push(listener),
		};
	}

	close(sayBye: boolean): void {
		if (this.closed) return;
		if (sayBye) this.out.send({ t: "bye" });
		this.closed = true;
		for (const stream of [...this.streams.values()]) stream.end();
		this.streams.clear();
		this.drainListeners.clear();
		this.onClosed();
	}
}

export interface PhoneRemoteLinkOptions {
	gateway: PhoneLinkGateway;
	store: PhoneLinkStore;
	/** The Drive of the account this PC is signed in with; null while it is not. */
	port: () => PhoneDrivePort | null;
	/** This PC's sync device id (the name the phones use for it). */
	deviceId: () => string | null;
	/** Whether remote connections are allowed now (besides the store's switch): signed in, sync on. */
	allowed: () => boolean;
	rtc?: () => Promise<RtcFactory>;
	iceServers?: Array<{ urls: string }>;
	now?: () => number;
	/**
	 * How often Drive is read: while only offers can arrive, while a relay connection is open, and while a phone on the
	 * relay is in use (tests set them low; `busy` defaults to the lower of `relay` and 250 ms).
	 */
	pollMs?: { idle: number; relay: number; busy?: number };
	/** Called when a connection starts or ends (the settings page shows them). */
	onChange?: () => void;
	/** A phone this PC does not know yet sent a file: the phones' registrations are worth reading again soon. */
	onUnknownPhone?: () => void;
	log?: (message: string) => void;
}

export interface PhoneRemoteStatus {
	active: boolean;
	error: string | null;
	connections: Array<{ phoneId: string; transport: "direct" | "relay"; since: number }>;
}

export class PhoneRemoteLink {
	private readonly options: PhoneRemoteLinkOptions;
	private readonly now: () => number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = true;
	private active = false;
	private lastError: string | null = null;
	private readonly connections = new Map<
		string,
		{ pipe: PipeConnection; since: number; dispose: () => void; parts: PartAssembler }
	>();
	/** Drive file ids already handled, with when they were seen (a listing overlaps the previous one). */
	private readonly seen = new Map<string, number>();
	private cursor = 0;
	private lastCleanup = 0;
	private rtcFactory: Promise<RtcFactory> | undefined;
	/** Outgoing relay sequence per connection. */
	private readonly relaySeq = new Map<string, number>();
	/**
	 * The files of every look are handled here, in order, one after another; the next look does not wait for them
	 * (reading a file from Drive takes as long as listing the folder).
	 */
	private handling: Promise<void> = Promise.resolve();
	/** Set when Drive refused a file's properties: small link files are then written without them. */
	private inlineOff = false;

	constructor(options: PhoneRemoteLinkOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(0);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.closeAll(true);
		this.setActive(false);
	}

	/** Look at Drive now (a phone was just registered, or the switch changed). */
	poke(): void {
		if (this.stopped) return;
		this.schedule(0);
	}

	status(): PhoneRemoteStatus {
		return {
			active: this.active,
			error: this.lastError,
			connections: [...this.connections.values()].map((entry) => ({
				phoneId: entry.pipe.phoneId,
				transport: entry.pipe.transport,
				since: entry.since,
			})),
		};
	}

	private schedule(delay: number): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.tick(), delay);
		this.timer.unref?.();
	}

	private setActive(active: boolean): void {
		if (this.active === active) return;
		this.active = active;
		this.options.gateway.setRemoteActive(active);
		this.options.onChange?.();
	}

	private accountPhones(): string[] {
		return this.options.store
			.devices()
			.filter((device) => device.source === "google")
			.map((device) => device.id);
	}

	/** One look at `link/`: offers and relay messages for this PC, then old files. */
	async tick(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		const poll = this.options.pollMs ?? { idle: IDLE_POLL_MS, relay: RELAY_POLL_MS };
		const busyPoll = poll.busy ?? Math.min(poll.relay, RELAY_BUSY_POLL_MS);
		let next = poll.idle;
		let handled: Promise<void> | undefined;
		try {
			const port = this.options.port();
			const pcId = this.options.deviceId();
			const phones = this.accountPhones();
			const allowed = !!port && !!pcId && this.options.allowed() && this.options.store.remote && phones.length > 0;
			this.setActive(allowed);
			if (!allowed || !port || !pcId) {
				this.closeAll(true);
				next = 10_000;
				return;
			}
			for (const [key, entry] of this.connections)
				if (!phones.includes(entry.pipe.phoneId) || !this.options.store.keyOf(entry.pipe.phoneId)) {
					entry.pipe.close(true);
					this.connections.delete(key);
				}
			await port.ensurePhoneSpace();
			const now = this.now();
			const cleanup = now - this.lastCleanup > CLEANUP_MS;
			const files = await port.phoneList(
				"link",
				cleanup || !this.cursor ? {} : { createdAfter: new Date(this.cursor - 30_000).toISOString() },
			);
			const incoming: Array<{ id: string; name: string; parsed: ParsedName; created: number; inline?: string }> = [];
			for (const file of files) {
				const created = Date.parse(file.createdTime ?? file.modifiedTime ?? "") || now;
				if (created > this.cursor) this.cursor = created;
				const parsed = parseLinkName(file.name);
				if (!parsed) continue;
				if (parsed.to !== pcId) {
					// Our own files the phone never read, after a while.
					if (cleanup && parsed.from === pcId && now - created > STALE_FILE_MS)
						await port.phoneDelete("link", file.name).catch(() => undefined);
					continue;
				}
				if (this.seen.has(file.id)) continue;
				this.seen.set(file.id, now);
				if (now - created > STALE_FILE_MS) {
					await port.phoneDelete("link", file.name).catch(() => undefined);
					continue;
				}
				incoming.push({ id: file.id, name: file.name, parsed, created, inline: inlineText(file) });
			}
			if (cleanup) this.lastCleanup = now;
			for (const [id, at] of this.seen) if (now - at > STALE_FILE_MS * 2) this.seen.delete(id);
			incoming.sort((a, b) =>
				a.parsed.kind === "relay" && b.parsed.kind === "relay"
					? a.parsed.seq - b.parsed.seq
					: a.created - b.created,
			);
			const handle = async (file: (typeof incoming)[number]) => {
				try {
					await this.handleFile(port, pcId, file);
				} catch (error) {
					// Drive did not hand the file over: the next look takes it again.
					this.seen.delete(file.id);
					this.lastError = error instanceof Error ? error.message : String(error);
				}
			};
			// An offer is answered on its own (gathering addresses takes seconds): relay messages do not wait for it.
			const offers = incoming.filter((file) => file.parsed.kind === "offer").map(handle);
			const messages = incoming.filter((file) => file.parsed.kind !== "offer");
			if (messages.length)
				this.handling = this.handling.then(async () => {
					for (const file of messages) await handle(file);
				});
			if (offers.length || messages.length) handled = Promise.all([this.handling, ...offers]).then(() => undefined);
			for (const [key, entry] of this.connections)
				if (entry.pipe.transport === "relay" && now - entry.pipe.lastIn > RELAY_IDLE_MS) {
					entry.pipe.close(true);
					this.connections.delete(key);
				}
			const relays = [...this.connections.values()].filter((entry) => entry.pipe.transport === "relay");
			// A phone that just sent through the relay (perhaps a connection not made yet) is about to send more.
			const busy =
				messages.some((file) => file.parsed.kind === "relay") ||
				relays.some((entry) => now - entry.pipe.lastBusy < RELAY_BUSY_MS);
			if (busy) next = busyPoll;
			else if (relays.length) next = poll.relay;
			this.lastError = null;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			next = 10_000;
		} finally {
			this.running = false;
			this.schedule(next);
		}
		// The next look is already scheduled; a caller that awaits this one sees its files handled.
		await handled;
	}

	private async handleFile(
		port: PhoneDrivePort,
		pcId: string,
		file: { id: string; name: string; parsed: ParsedName; created: number; inline?: string },
	): Promise<void> {
		const { name, parsed } = file;
		if (parsed.kind === "answer") return;
		const phoneId = parsed.from;
		const key = ID.test(phoneId) && ID.test(parsed.conn) ? this.options.store.keyOf(phoneId) : undefined;
		const device = this.options.store.devices().find((entry) => entry.id === phoneId);
		if (!key || device?.source !== "google") {
			// A phone that has just signed in: its offer or first messages wait for its registration (the next look
			// at `link/` takes them again) rather than being lost and leaving the phone waiting for an answer.
			if (
				!device &&
				ID.test(phoneId) &&
				!this.options.store.isBlocked(phoneId) &&
				this.now() - file.created < UNKNOWN_PHONE_WAIT_MS
			) {
				this.seen.delete(file.id);
				this.options.onUnknownPhone?.();
				return;
			}
			await port.phoneDelete("link", name).catch(() => undefined);
			return;
		}
		const data = file.inline !== undefined ? Buffer.from(file.inline, "utf8") : await port.phoneRead("link", name);
		// Removed while the message is handled: waiting for the removal would hold every answer back by one request.
		void port.phoneDelete("link", name).catch(() => undefined);
		if (!data) return;
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(data).toString("utf8"));
		} catch {
			return;
		}
		if (parsed.kind === "offer") {
			await this.answerOffer(port, pcId, phoneId, parsed.conn, key, body);
			return;
		}
		const connKey = `${phoneId}/${parsed.conn}`;
		let entry = this.connections.get(connKey);
		if (!entry) {
			if (this.connections.size >= MAX_CONNECTIONS) this.closeOldest();
			entry = this.openRelay(port, pcId, phoneId, parsed.conn);
		}
		if (entry.pipe.transport !== "relay" || !isObject(body) || !Array.isArray(body.m)) return;
		for (const raw of body.m) {
			let message: unknown = raw;
			if (isObject(raw) && raw.t === "p") {
				const whole = entry.parts.take(raw);
				if (whole === undefined) continue;
				try {
					message = JSON.parse(whole);
				} catch {
					continue;
				}
			}
			// Requests of one file are answered in order, but a long call does not hold up the others.
			void entry.pipe.receive(message, this.now());
		}
	}

	private closeOldest(): void {
		const oldest = [...this.connections.entries()].sort((a, b) => a[1].since - b[1].since)[0];
		if (!oldest) return;
		oldest[1].pipe.close(true);
		this.connections.delete(oldest[0]);
	}

	private closeAll(sayBye: boolean): void {
		for (const entry of this.connections.values()) entry.pipe.close(sayBye);
		this.connections.clear();
	}

	private register(pipe: PipeConnection, dispose: () => void) {
		const key = `${pipe.phoneId}/${pipe.conn}`;
		this.connections.get(key)?.pipe.close(false);
		const entry = { pipe, since: this.now(), dispose, parts: new PartAssembler() };
		this.connections.set(key, entry);
		this.options.onChange?.();
		return entry;
	}

	private forget(pipe: PipeConnection): void {
		const key = `${pipe.phoneId}/${pipe.conn}`;
		const entry = this.connections.get(key);
		if (entry?.pipe === pipe) {
			this.connections.delete(key);
			entry.dispose();
			this.options.onChange?.();
		}
	}

	// ---- Drive relay ------------------------------------------------------------------------------

	/** Writes a link file, its text in its properties too when it is small (`inlineProperties`). */
	private async createLinkFile(port: PhoneDrivePort, name: string, text: string): Promise<void> {
		const data = Buffer.from(text, "utf8");
		const properties = this.inlineOff ? undefined : inlineProperties(text);
		if (!properties) return port.phoneCreate("link", name, data);
		try {
			await port.phoneCreate("link", name, data, { properties });
		} catch (error) {
			// Drive refused the request itself (the properties, not the network): small files go without them from now on.
			if ((error as { status?: unknown } | null)?.status !== 400) throw error;
			this.inlineOff = true;
			await port.phoneCreate("link", name, data);
		}
	}

	private openRelay(port: PhoneDrivePort, pcId: string, phoneId: string, conn: string) {
		const connKey = `${phoneId}/${conn}`;
		let queue: Json[] = [];
		/** What each progress frame still waiting in `queue` shows. */
		const progressOf = new WeakMap<Json, FrameProgress>();
		let writing = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const drainListeners: Array<() => void> = [];
		const flush = async () => {
			timer = undefined;
			if (writing || queue.length === 0) return;
			writing = true;
			const batch = queue;
			queue = [];
			try {
				for (const file of relayFiles(batch)) {
					const seq = (this.relaySeq.get(connKey) ?? 0) + 1;
					this.relaySeq.set(connKey, seq);
					await this.createLinkFile(port, relayName(phoneId, pcId, conn, seq), file);
				}
			} catch (error) {
				this.options.log?.(`phone relay write failed: ${error instanceof Error ? error.message : String(error)}`);
				pipe.close(false);
			} finally {
				writing = false;
				if (queue.length) scheduleFlush();
				else for (const listener of drainListeners) listener();
			}
		};
		let lastWrite = 0;
		const scheduleFlush = () => {
			if (timer || writing) return;
			// An answer goes out at once, and so do the first frames after a quiet while (the one that tells the phone it
			// is connected); frames that keep coming are gathered into one file a little longer, since Drive slows down
			// an account that writes more than a few files a second.
			const urgent =
				queue.some((message) => message.t === "r" || message.t === "bye") || this.now() - lastWrite > 600;
			timer = setTimeout(
				() => {
					lastWrite = this.now();
					void flush();
				},
				urgent ? 30 : 600,
			);
			timer.unref?.();
		};
		const out: PipeOut = {
			send: (message, progress) => {
				if (progress !== undefined) {
					// A reply's text so far (and the like) that is still waiting here is replaced by the newer one, which
					// shows all of it: a file then carries one copy of a growing reply, not one per 50 ms. Only within the
					// progress frames since that stream's last final frame (the usage meter: anywhere), so what the phone
					// sees comes in the same order.
					for (let index = queue.length - 1; index >= 0; index--) {
						const queued = queue[index]!;
						if (queued.t !== "f" || queued.i !== message.i) continue;
						const found = progressOf.get(queued);
						if (found === undefined) {
							if (progress.alone) continue;
							break;
						}
						if (found.name !== progress.name) continue;
						queue.splice(index, 1);
						break;
					}
					progressOf.set(message, progress);
				}
				queue.push(message);
				if (message.t === "bye") void flush();
				else scheduleFlush();
			},
			backedUp: () => writing,
			onDrain: (listener) => drainListeners.push(listener),
		};
		const pipe: PipeConnection = new PipeConnection({
			phoneId,
			conn,
			transport: "relay",
			gateway: this.options.gateway,
			out,
			now: this.now(),
			onClosed: () => this.forget(pipe),
		});
		return this.register(pipe, () => {
			if (timer) clearTimeout(timer);
			if (queue.length) void flush();
			this.relaySeq.delete(connKey);
			// What the phone did not read before it went away (the last answers, "bye") is removed a little later.
			const leftovers = setTimeout(() => {
				const prefix = `m__${phoneId}__${pcId}__${conn}__`;
				void port
					.phoneList("link")
					.then((files) =>
						Promise.all(
							files
								.filter((file) => file.name.startsWith(prefix))
								.map((file) => port.phoneDelete("link", file.name).catch(() => undefined)),
						),
					)
					.catch(() => undefined);
			}, RELAY_LEFTOVER_MS);
			leftovers.unref?.();
		});
	}

	// ---- WebRTC -----------------------------------------------------------------------------------

	private async answerOffer(
		port: PhoneDrivePort,
		pcId: string,
		phoneId: string,
		conn: string,
		key: Buffer,
		body: unknown,
	): Promise<void> {
		let offer: unknown;
		try {
			if (!isObject(body) || typeof body.n !== "string" || typeof body.c !== "string") return;
			offer = open(key, signalAad("rtc-offer", phoneId, pcId, conn), { n: body.n, c: body.c });
		} catch {
			return;
		}
		if (!isObject(offer) || typeof offer.sdp !== "string" || typeof offer.at !== "number") return;
		if (Math.abs(this.now() - offer.at) > OFFER_MAX_AGE_MS) return;
		const reply = async (value: Json) => {
			const sealed = seal(key, signalAad("rtc-answer", phoneId, pcId, conn), value);
			await this.createLinkFile(port, answerName(phoneId, pcId, conn), JSON.stringify(sealed));
		};
		let peer: RtcPeer;
		try {
			this.rtcFactory ??= (this.options.rtc ?? weriftFactory)();
			const create = await this.rtcFactory;
			peer = create({ iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS });
		} catch (error) {
			this.rtcFactory = undefined;
			this.options.log?.(`WebRTC is not available: ${error instanceof Error ? error.message : String(error)}`);
			await reply({ error: "no-webrtc" }).catch(() => undefined);
			return;
		}
		let settled = false;
		const giveUp = setTimeout(() => {
			if (!settled) void peer.close().catch(() => undefined);
		}, OPEN_TIMEOUT_MS);
		giveUp.unref?.();
		peer.onDataChannel.subscribe((channel) => {
			const ready = () => {
				if (settled) return;
				settled = true;
				clearTimeout(giveUp);
				this.attachChannel(peer, channel, phoneId, conn);
			};
			if (channel.readyState === "open") ready();
			else
				channel.stateChanged.subscribe((state) => {
					if (state === "open") ready();
				});
		});
		try {
			await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
			await peer.setLocalDescription(await peer.createAnswer());
			await waitForGathering(peer, GATHER_TIMEOUT_MS);
			const sdp = peer.localDescription?.sdp;
			if (!sdp) throw new Error("No answer");
			await reply({ sdp });
		} catch (error) {
			clearTimeout(giveUp);
			settled = true;
			void peer.close().catch(() => undefined);
			this.options.log?.(`WebRTC answer failed: ${error instanceof Error ? error.message : String(error)}`);
			await reply({ error: "answer-failed" }).catch(() => undefined);
		}
	}

	private attachChannel(peer: RtcPeer, channel: RtcChannel, phoneId: string, conn: string): void {
		if (this.stopped || !this.active) {
			channel.close();
			void peer.close().catch(() => undefined);
			return;
		}
		if (this.connections.size >= MAX_CONNECTIONS) this.closeOldest();
		const drainListeners: Array<() => void> = [];
		channel.bufferedAmountLowThreshold = 256 * 1024;
		channel.bufferedAmountLow.subscribe(() => {
			for (const listener of drainListeners) listener();
		});
		let counter = 0;
		const out: PipeOut = {
			send: (message) => {
				if (channel.readyState !== "open") return;
				const text = JSON.stringify(message);
				try {
					for (const part of chunkMessage(text, `s${++counter}`)) channel.send(part);
				} catch {
					pipe.close(false);
				}
			},
			backedUp: () => channel.bufferedAmount > 1024 * 1024,
			onDrain: (listener) => drainListeners.push(listener),
		};
		const pipe: PipeConnection = new PipeConnection({
			phoneId,
			conn,
			transport: "direct",
			gateway: this.options.gateway,
			out,
			now: this.now(),
			onClosed: () => this.forget(pipe),
		});
		this.register(pipe, () => {
			try {
				channel.close();
			} catch {
				// Already closed.
			}
			void peer.close().catch(() => undefined);
		});
		const parts = new PartAssembler();
		channel.onMessage.subscribe((data) => {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			let message: unknown;
			try {
				message = JSON.parse(text);
				if (isObject(message) && message.t === "p") {
					const whole = parts.take(message);
					if (whole === undefined) return;
					message = JSON.parse(whole);
				}
			} catch {
				return;
			}
			void pipe.receive(message, this.now());
		});
		channel.stateChanged.subscribe((state) => {
			if (state === "closed" || state === "closing") pipe.close(false);
		});
		peer.connectionStateChange.subscribe((state) => {
			if (state === "failed" || state === "closed" || state === "disconnected") pipe.close(false);
		});
	}
}

/** Pack pipe messages into relay files that each stay under the size limit; long messages become parts. */
function relayFiles(messages: Json[]): string[] {
	const files: string[] = [];
	let current: string[] = [];
	let size = 0;
	let counter = 0;
	const push = (text: string) => {
		if (size + text.length > RELAY_FILE_CHARS && current.length) {
			files.push(`{"v":1,"m":[${current.join(",")}]}`);
			current = [];
			size = 0;
		}
		current.push(text);
		size += text.length + 1;
	};
	for (const message of messages) {
		const text = JSON.stringify(message);
		for (const part of chunkMessage(text, `r${Date.now().toString(36)}${++counter}`, RELAY_PART_CHARS)) push(part);
	}
	if (current.length) files.push(`{"v":1,"m":[${current.join(",")}]}`);
	return files;
}

function waitForGathering(peer: RtcPeer, timeout: number): Promise<void> {
	if (peer.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeout);
		peer.iceGatheringStateChange.subscribe((state) => {
			if (state === "complete") {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}
