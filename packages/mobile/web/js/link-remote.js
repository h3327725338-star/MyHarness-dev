// The phone link from any network, for a PC signed in with the same Google account as this phone. The PC's half and
// the whole protocol are described in packages/coding-agent/src/modes/web/phone-link/remote.ts: the two meet in the
// account's Drive (`MyHarness/phone-v1/link/`) and either open a direct WebRTC data channel or pass the same messages
// as files in Drive ("relay"); backend-remote.js tries both at once and keeps the first that works. The messages are
// the phone link's own sealed requests, answers and events, so nothing here changes what the PC checks or what a phone
// may ask.
//
// Written without page globals (the Drive client, WebRTC and the time come in as arguments), so the tests run it in
// Node against the PC's code.
import { linkAad, open, seal } from "./link-crypto.js";

export const CHUNK_CHARS = 16000;
const RELAY_FILE_CHARS = 3000000;
const RELAY_PART_CHARS = 2000000;
const GATHER_MS = 3000;
const ANSWER_WAIT_MS = 25000;
const ANSWER_POLL_MS = 400;
const OPEN_WAIT_MS = 12000;
// Drive tells nobody about a new file: the PC's answers are seen only when the phone looks. Listing a folder is a read,
// which Drive allows far more of than writes. While the connection is in use (a request waits for its answer, or
// something other than a keep-alive went either way within RELAY_BUSY_MS) the phone looks more often, and the next look
// does not wait for the files of the last one to be read.
const RELAY_POLL_MS = 500;
const RELAY_BUSY_POLL_MS = 250;
const RELAY_BUSY_MS = 60000;
const RELAY_LOOKS_AT_ONCE = 2;
const RELAY_KEEPALIVE_MS = 45000;
// A link file of up to INLINE_PARTS x INLINE_PART characters also rides in its custom properties (inlineProperties).
const INLINE_PART = 100;
const INLINE_PARTS = 25;
const REQUEST_TIMEOUT_MS = 180000;
// One exchange with Drive for a connection file: a request that hangs (a connection that died when the phone changed
// networks) is given up after this long and the next look tries again.
const LINK_DRIVE_MS = 10000;
const linkWriteMs = (chars) => LINK_DRIVE_MS + Math.ceil(chars / 50000) * 1000;
export const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

export const offerName = (pcId, phoneId, conn) => `o__${pcId}__${phoneId}__${conn}.json`;
export const answerName = (phoneId, pcId, conn) => `a__${phoneId}__${pcId}__${conn}.json`;
export const relayName = (to, from, conn, seq) => `m__${to}__${from}__${conn}__${seq.toString(36).padStart(8, "0")}.json`;
const signalAad = (kind, phoneId, pcId, conn) => linkAad(kind, kind === "rtc-offer" ? "req" : "res", phoneId, `${pcId}/${conn}`);

export function newConnectionId() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteLinkError extends Error {
	constructor(message, status = 0) {
		super(message);
		this.status = status;
	}
}

/** Split a long message for the data channel; each part is itself a message. */
export function chunkMessage(text, key, size = CHUNK_CHARS) {
	if (text.length <= size) return [text];
	const count = Math.ceil(text.length / size);
	const parts = [];
	for (let index = 0; index < count; index++) parts.push(JSON.stringify({ t: "p", k: key, j: index, n: count, d: text.slice(index * size, (index + 1) * size) }));
	return parts;
}

export class PartAssembler {
	constructor() {
		this.pending = new Map();
	}

	take(message) {
		const { k: key, j: index, n: count, d: data } = message;
		if (typeof key !== "string" || typeof index !== "number" || typeof count !== "number" || typeof data !== "string") return undefined;
		if (count < 1 || count > 4096 || index < 0 || index >= count) return undefined;
		let entry = this.pending.get(key);
		if (!entry) {
			if (this.pending.size > 64) this.pending.clear();
			entry = { parts: new Array(count), count, got: 0 };
			this.pending.set(key, entry);
		}
		if (entry.count !== count || entry.parts[index] !== undefined) return undefined;
		entry.parts[index] = data;
		entry.got += 1;
		if (entry.got < count) return undefined;
		this.pending.delete(key);
		return entry.parts.join("");
	}
}

/**
 * Requests, answers and event streams over one transport (`send` passes a message object on). Shared by the direct
 * and the relay transport.
 */
class PipeClient {
	constructor(send) {
		this.send = send;
		this.next = 0;
		this.pending = new Map();
		this.streams = new Map();
		this.closed = false;
		this.closeListeners = [];
	}

	receive(message) {
		if (!message || typeof message !== "object") return;
		if (message.t === "bye") {
			this.close(new RemoteLinkError("The PC closed the connection."));
			return;
		}
		if (message.t === "r") {
			const request = this.pending.get(message.i);
			if (request) {
				this.pending.delete(message.i);
				clearTimeout(request.timer);
				request.resolve({ status: message.s, body: message.b });
			}
			return;
		}
		const stream = this.streams.get(message.i);
		if (!stream) return;
		if (message.t === "f" && typeof message.f === "string") stream.onFrame(message.f);
		else if (message.t === "z") {
			this.streams.delete(message.i);
			stream.resolve();
		}
	}

	/** One sealed request (`open` or `call`): resolves with `{ status, body }`, the body being the sealed answer. */
	request(operation, envelope, timeoutMs = REQUEST_TIMEOUT_MS) {
		if (this.closed) return Promise.reject(new RemoteLinkError("The connection to the PC ended."));
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RemoteLinkError("The PC did not answer in time."));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ t: "q", i: id, o: operation, e: envelope });
		});
	}

	/**
	 * The event stream of a session: `onFrame` gets each sealed frame. Resolves when the PC ends the stream, rejects
	 * when it refuses it or the connection ends; `signal` stops it.
	 */
	async events(envelope, onFrame, signal) {
		if (this.closed) throw new RemoteLinkError("The connection to the PC ended.");
		const id = ++this.next;
		const ended = new Promise((resolve, reject) => this.streams.set(id, { onFrame, resolve, reject }));
		const stop = () => {
			const stream = this.streams.get(id);
			if (!stream) return;
			this.streams.delete(id);
			if (!this.closed) this.send({ t: "x", i: id });
			stream.resolve();
		};
		signal?.addEventListener("abort", stop, { once: true });
		const answer = await new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, timer: 0 });
			this.send({ t: "q", i: id, o: "events", e: envelope });
		}).catch((error) => {
			this.streams.delete(id);
			throw error;
		});
		if (answer.status !== 200) {
			this.streams.delete(id);
			throw new RemoteLinkError(answer.body?.error || `HTTP ${answer.status}`, answer.status);
		}
		try {
			await ended;
		} finally {
			signal?.removeEventListener("abort", stop);
		}
	}

	close(error = new RemoteLinkError("The connection to the PC ended."), sayBye = false) {
		if (this.closed) return;
		if (sayBye) {
			try {
				this.send({ t: "bye" });
			} catch {
				// Already gone.
			}
		}
		this.closed = true;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		for (const stream of this.streams.values()) stream.reject(error);
		this.streams.clear();
		for (const listener of this.closeListeners) listener(error);
	}

	onClose(listener) {
		this.closeListeners.push(listener);
	}
}

/**
 * A small link file's text, also put in the file's custom properties (`n`: how many parts, `c0`, `c1`...: the text in
 * parts of 100 characters), so the other side has it from the listing it makes anyway and skips one download per
 * message. Only printable ASCII (sealed JSON is) and at most 25 parts: Drive keeps 30 properties of 124 bytes per file.
 * The PC writes and reads the same (phone-link/remote.ts).
 */
export function inlineProperties(text) {
	if (!text || text.length > INLINE_PART * INLINE_PARTS || !/^[ -~]*$/.test(text)) return undefined;
	const properties = {};
	let count = 0;
	for (let at = 0; at < text.length; at += INLINE_PART) properties[`c${count++}`] = text.slice(at, at + INLINE_PART);
	properties.n = String(count);
	return properties;
}

/** The text a listing carries for a file (inlineProperties); undefined when it does not, or it is not the whole file. */
export function inlineText(file) {
	const properties = file?.properties;
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

// Set when Drive refused a file's properties: small link files are then written without them.
let inlineOff = false;

async function createLinkFile(drive, name, text) {
	const timeoutMs = linkWriteMs(text.length);
	const properties = inlineOff ? undefined : inlineProperties(text);
	if (!properties) return drive.phoneCreate("link", name, encoder.encode(text), { timeoutMs });
	try {
		return await drive.phoneCreate("link", name, encoder.encode(text), { timeoutMs, properties });
	} catch (error) {
		// Drive refused the request itself (the properties, not the network): small files go without them from now on.
		if (error?.status !== 400) throw error;
		inlineOff = true;
		return drive.phoneCreate("link", name, encoder.encode(text), { timeoutMs });
	}
}

/** A link file as JSON: from the listing when it carries the text, else read from Drive. */
async function readJson(drive, file) {
	let text = inlineText(file);
	if (text === undefined) {
		const data = await drive.phoneRead("link", file.name, { timeoutMs: linkWriteMs(Number(file.size) || 0) });
		if (!data) return undefined;
		text = decoder.decode(data);
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * What kinds of addresses a session description offers: IPv4, IPv6, and names that hide a local address (mDNS, which
 * a browser uses for its local addresses). Only the kinds, never the addresses, leave this function.
 */
export function candidateKinds(sdp) {
	const kinds = { ipv4: false, ipv6: false, hidden: false };
	for (const line of String(sdp || "").split(/\r?\n/)) {
		if (!line.startsWith("a=candidate:")) continue;
		const address = line.split(" ")[4] || "";
		if (address.endsWith(".local")) kinds.hidden = true;
		else if (address.includes(":")) kinds.ipv6 = true;
		else if (address) kinds.ipv4 = true;
	}
	return kinds;
}

function waitForGathering(peer, timeout) {
	if (peer.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeout);
		peer.addEventListener("icegatheringstatechange", () => {
			if (peer.iceGatheringState === "complete") {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}

/**
 * Open a direct WebRTC data channel to the PC. Resolves with a pipe; rejects when no direct path exists (the caller
 * then uses the relay). Both carry `direct`: how far the attempt got (`stage`: offer, answer, path, open) and the kinds
 * of addresses each side offered (`phone`, `pc`: candidateKinds), so the app can say why a direct path was missing.
 */
export async function openDirect({ drive, pcId, phoneId, key, RTCPeerConnection, iceServers = DEFAULT_ICE_SERVERS, now = Date.now, signal }) {
	if (typeof RTCPeerConnection !== "function") throw Object.assign(new RemoteLinkError("This phone has no WebRTC."), { direct: { stage: "offer", phone: null, pc: null } });
	const conn = newConnectionId();
	const peer = new RTCPeerConnection({ iceServers });
	const channel = peer.createDataChannel("link", { ordered: true });
	const report = { stage: "offer", phone: null, pc: null };
	const cleanup = () => {
		try {
			channel.close();
		} catch {
			// Already closed.
		}
		try {
			peer.close();
		} catch {
			// Already closed.
		}
	};
	try {
		await peer.setLocalDescription(await peer.createOffer());
		await waitForGathering(peer, GATHER_MS);
		report.phone = candidateKinds(peer.localDescription.sdp);
		const sealed = await seal(key, signalAad("rtc-offer", phoneId, pcId, conn), { sdp: peer.localDescription.sdp, at: now() });
		const startedAt = now();
		const offer = JSON.stringify({ d: phoneId, ...sealed });
		await createLinkFile(drive, offerName(pcId, phoneId, conn), offer);
		report.stage = "answer";
		const wanted = answerName(phoneId, pcId, conn);
		let answer;
		while (!answer) {
			if (signal?.aborted) throw new RemoteLinkError("Cancelled.");
			if (now() - startedAt > ANSWER_WAIT_MS) throw new RemoteLinkError("The PC did not answer. Is MyHarness open on it?");
			await wait(ANSWER_POLL_MS);
			let body;
			try {
				const files = await drive.phoneList("link", { createdAfter: new Date(startedAt - 60000).toISOString(), timeoutMs: LINK_DRIVE_MS });
				const file = files.find((entry) => entry.name === wanted);
				if (!file) continue;
				body = await readJson(drive, file);
			} catch {
				// Drive did not answer this time; the next look tries again.
				continue;
			}
			drive.phoneDelete("link", wanted, { timeoutMs: LINK_DRIVE_MS }).catch(() => {});
			if (!body) continue;
			answer = await open(key, signalAad("rtc-answer", phoneId, pcId, conn), body);
		}
		// The offer is the PC's to remove; if it never read it (a slow PC), it is left for its cleanup.
		if (answer.error || typeof answer.sdp !== "string") throw new RemoteLinkError(answer.error === "no-webrtc" ? "The PC cannot make direct connections." : "The PC could not answer.");
		report.stage = "path";
		report.pc = candidateKinds(answer.sdp);
		await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
		await new Promise((resolve, reject) => {
			if (channel.readyState === "open") return resolve();
			const timer = setTimeout(() => reject(new RemoteLinkError("No direct path to the PC.")), OPEN_WAIT_MS);
			channel.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			channel.addEventListener("close", () => {
				clearTimeout(timer);
				reject(new RemoteLinkError("No direct path to the PC."));
			});
		});
	} catch (error) {
		cleanup();
		if (error && typeof error === "object") error.direct = report;
		throw error;
	}
	report.stage = "open";
	let counter = 0;
	const client = new PipeClient((message) => {
		if (channel.readyState !== "open") return;
		for (const part of chunkMessage(JSON.stringify(message), `q${++counter}`)) channel.send(part);
	});
	const parts = new PartAssembler();
	channel.addEventListener("message", (event) => {
		const text = typeof event.data === "string" ? event.data : decoder.decode(event.data);
		let message;
		try {
			message = JSON.parse(text);
			if (message?.t === "p") {
				const whole = parts.take(message);
				if (whole === undefined) return;
				message = JSON.parse(whole);
			}
		} catch {
			return;
		}
		client.receive(message);
	});
	const lost = () => client.close(new RemoteLinkError("The direct connection to the PC was lost."));
	channel.addEventListener("close", lost);
	peer.addEventListener("connectionstatechange", () => {
		if (["failed", "closed", "disconnected"].includes(peer.connectionState)) lost();
	});
	client.onClose(cleanup);
	return { transport: "direct", direct: report, request: (op, envelope, timeoutMs) => client.request(op, envelope, timeoutMs), events: (envelope, onFrame, abort) => client.events(envelope, onFrame, abort), close: () => client.close(undefined, true), onClose: (listener) => client.onClose(listener) };
}

/** The slow path: the same messages as files in Drive, read and removed by the other side. */
export function openRelay({ drive, pcId, phoneId, now = Date.now, pollMs = RELAY_POLL_MS, busyPollMs = Math.min(pollMs, RELAY_BUSY_POLL_MS) }) {
	const conn = newConnectionId();
	let seq = 0;
	let queue = [];
	let writing = false;
	let flushTimer = 0;
	let pollTimer = 0;
	let keepAlive = 0;
	let lastSeq = 0;
	let lastBusy = now();
	let looking = 0;
	let reading = false;
	const seen = new Set();
	// Files a look found and not read yet, by Drive id: read in their order, one after another.
	const found = new Map();
	const startedAt = now();
	const parts = new PartAssembler();
	let partCounter = 0;

	const flush = async () => {
		flushTimer = 0;
		if (writing || !queue.length) return;
		writing = true;
		const batch = queue;
		queue = [];
		try {
			const files = [];
			let current = [];
			let size = 0;
			for (const message of batch) {
				for (const part of chunkMessage(JSON.stringify(message), `p${++partCounter}`, RELAY_PART_CHARS)) {
					if (size + part.length > RELAY_FILE_CHARS && current.length) {
						files.push(current);
						current = [];
						size = 0;
					}
					current.push(part);
					size += part.length + 1;
				}
			}
			if (current.length) files.push(current);
			for (const file of files) {
				const text = `{"v":1,"m":[${file.join(",")}]}`;
				await createLinkFile(drive, relayName(pcId, phoneId, conn, ++seq), text);
			}
		} catch (error) {
			client.close(new RemoteLinkError(`Drive refused a message: ${error?.message || error}`));
		} finally {
			writing = false;
			if (queue.length && !client.closed) flushTimer = setTimeout(flush, 100);
		}
	};

	const client = new PipeClient((message) => {
		if (message.t !== "k") lastBusy = now();
		queue.push(message);
		if (message.t === "bye") flush();
		else if (!flushTimer && !writing) flushTimer = setTimeout(flush, 100);
	});

	const prefix = `m__${phoneId}__${pcId}__${conn}__`;
	/** Read the files found so far, lowest sequence first; a file Drive does not hand over waits for the next look. */
	const read = async () => {
		if (reading) return;
		reading = true;
		let failed = false;
		try {
			while (!client.closed) {
				const next = [...found.values()].filter((entry) => entry.seq > lastSeq).sort((a, b) => a.seq - b.seq)[0];
				if (!next) break;
				let body;
				try {
					body = await readJson(drive, next.file);
				} catch {
					// Drive did not answer this time; the next look tries again.
					failed = true;
					break;
				}
				found.delete(next.file.id);
				seen.add(next.file.id);
				// Removed while the message is handled: waiting for the removal would hold every answer back.
				drive.phoneDelete("link", next.file.name, { timeoutMs: LINK_DRIVE_MS }).catch(() => {});
				lastSeq = Math.max(lastSeq, next.seq);
				for (const raw of body?.m || []) {
					let message = raw;
					if (raw?.t === "p") {
						const whole = parts.take(raw);
						if (whole === undefined) continue;
						try {
							message = JSON.parse(whole);
						} catch {
							continue;
						}
					}
					if (message?.t !== "k") lastBusy = now();
					client.receive(message);
				}
			}
		} finally {
			reading = false;
		}
		for (const [id, entry] of found) if (entry.seq <= lastSeq) found.delete(id);
		// A look that found a file while the last one was being read left it to this reader.
		if (!failed && !client.closed && found.size) await read();
	};
	const look = async () => {
		looking += 1;
		try {
			const files = await drive.phoneList("link", { createdAfter: new Date(startedAt - 60000).toISOString(), timeoutMs: LINK_DRIVE_MS });
			for (const file of files) {
				if (!file.name.startsWith(prefix) || seen.has(file.id) || found.has(file.id)) continue;
				const number = Number.parseInt(file.name.slice(prefix.length, -5), 36);
				if (Number.isFinite(number) && number > lastSeq) found.set(file.id, { file, seq: number });
			}
		} catch {
			// Drive did not answer this time; the next look tries again.
		} finally {
			looking -= 1;
		}
		if (!client.closed) await read();
	};
	const poll = () => {
		pollTimer = 0;
		if (client.closed) return;
		const busy = client.pending.size > 0 || now() - lastBusy < RELAY_BUSY_MS;
		// A look that hangs does not hold up the next one; a few at most run at once.
		if (looking < RELAY_LOOKS_AT_ONCE) look();
		pollTimer = setTimeout(poll, busy ? busyPollMs : pollMs);
	};
	pollTimer = setTimeout(poll, pollMs);
	keepAlive = setInterval(() => client.send({ t: "k" }), RELAY_KEEPALIVE_MS);
	client.onClose(() => {
		clearTimeout(pollTimer);
		clearTimeout(flushTimer);
		clearInterval(keepAlive);
	});
	return { transport: "relay", request: (op, envelope, timeoutMs) => client.request(op, envelope, timeoutMs), events: (envelope, onFrame, abort) => client.events(envelope, onFrame, abort), close: () => client.close(undefined, true), onClose: (listener) => client.onClose(listener) };
}
