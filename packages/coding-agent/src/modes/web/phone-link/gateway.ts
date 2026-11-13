/**
 * The phone link: a second, small HTTP server that lets a paired phone use this PC's MyHarness.
 *
 * The Web UI server itself listens on 127.0.0.1 only and stays that way. This gateway is off until the user turns it
 * on in Settings; then it listens on the local network and accepts nothing but sealed messages from paired phones
 * (see crypto.ts). What a phone may do is a fixed list (ROUTES below): read the chats, send a message, stop a reply,
 * answer a question, pick a model, upload a file. There is no route to the terminal, to files on disk, to Git, to
 * settings, providers, keys or sync. Each allowed request is forwarded to the Web UI server over the loopback, so it
 * runs through exactly the code a click in the desktop page runs through.
 *
 * A paired phone can make the agent on this PC act (that is what sending it a message means), so pairing a phone
 * trusts it as much as someone sitting at the PC's own MyHarness window.
 *
 * The same sealed messages also arrive from outside the local network (remote.ts): a phone signed in with the same
 * Google account reaches this PC over a direct WebRTC connection, or through files in that account's Drive when no
 * direct path exists. Those transports hand each message to `dispatch()` and `attachStream()` below, so a request
 * is checked, sealed and forwarded exactly as one that came over Wi-Fi; the HTTP server here then need not listen.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { LINK_PROTOCOL, linkAad, newId, open, ReplayWindow, seal } from "./crypto.ts";
import type { PhoneLinkStore } from "./store.ts";

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSIONS_PER_DEVICE = 8;
const KEEPALIVE_MS = 15_000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_LIMIT = 20;
/** A phone stream that is this far behind is closed; the phone reconnects and reads the chat again. */
const MAX_PENDING_FRAMES = 2000;

/** Events of the Web UI server a phone gets. Everything else (terminals, Git, sync, file trees…) stays on the PC. */
const EVENTS = new Set([
	"slots",
	"slot_closed",
	"agent_start",
	"run_state",
	"run_finished",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_appended",
	"prompt_settled",
	"prompt_rejected",
	"queue_update",
	"queue_cleared",
	"dialogs",
	"session_info",
	"usage",
	"notice",
	"thinking_level",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"workspaces_changed",
	"models_changed",
	"shutdown",
]);
/** Progress events: when a phone's connection is slow, only the newest of these is kept. */
const DROPPABLE = new Set(["message_update", "tool_update", "usage"]);
/**
 * What a progress frame shows (each carries the whole of it): `name` is the reply, tool run or usage of one slot.
 * `alone`: nothing else in the chat refers to it (the usage meter), so it may also stand in for an older one that
 * final frames followed; a reply's or a tool's progress may not move past their final frames.
 */
export interface FrameProgress {
	name: string;
	alone: boolean;
}

function progressOf(event: string, data: unknown): FrameProgress {
	const fields = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
	const part = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
	return {
		name: `${event}|${part(fields.slot)}|${part(fields.liveId ?? fields.toolCallId)}`,
		alone: event === "usage",
	};
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const pick = (input: unknown, keys: string[]): Json => {
	const out: Json = {};
	if (isObject(input)) for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
	return out;
};

interface Route {
	method: "GET" | "POST";
	path: string;
	/** Query parameters that are passed on; any other is dropped. */
	query?: string[];
	/** The body that is passed on, rebuilt from the fields a phone may set. */
	body?: (input: unknown) => Json;
	/** The answer is a file (a picture), sent to the phone as base64. */
	binary?: boolean;
	/**
	 * Checks the rebuilt body against what the Web UI server reports (`get` reads one of its routes); returns the reason
	 * to refuse, or undefined.
	 */
	verify?: (body: Json, get: (path: string) => Promise<unknown>) => Promise<string | undefined>;
}

/** Everything a paired phone can ask this PC to do. */
const ROUTES: Route[] = [
	{ method: "GET", path: "/api/state" },
	{ method: "GET", path: "/api/slots" },
	{ method: "GET", path: "/api/transcript", query: ["limit", "before", "images"] },
	{ method: "GET", path: "/api/transcript/image", query: ["entry", "index"], binary: true },
	{ method: "GET", path: "/api/workspaces", query: ["mode"] },
	{ method: "GET", path: "/api/workspaces/sessions", query: ["path", "mode", "limit", "offset"] },
	{ method: "GET", path: "/api/sessions/unbound", query: ["mode", "limit", "offset"] },
	{ method: "GET", path: "/api/sessions/scheduled", query: ["mode"] },
	{ method: "GET", path: "/api/models" },
	{
		method: "POST",
		path: "/api/prompt",
		body: (input) => pick(input, ["text", "images", "attachments", "mode", "clientMessageId"]),
	},
	{ method: "POST", path: "/api/abort", body: () => ({}) },
	{ method: "POST", path: "/api/queue/clear", body: () => ({}) },
	{ method: "POST", path: "/api/seen", body: () => ({}) },
	{ method: "POST", path: "/api/ui/respond", body: (input) => pick(input, ["id", "value"]) },
	{ method: "POST", path: "/api/model", body: (input) => pick(input, ["provider", "id", "thinkingLevel"]) },
	{ method: "POST", path: "/api/thinking", body: (input) => pick(input, ["level"]) },
	{ method: "POST", path: "/api/files/upload", body: (input) => pick(input, ["name", "data"]) },
	// A new chat starts unbound, where the PC would start one (its current place), or in one of the Workspaces the PC
	// lists for that mode; a phone names no other folder.
	{
		method: "POST",
		path: "/api/sessions/new",
		body: (input) => pick(input, ["unbound", "mode", "rootPath"]),
		verify: async (body, get) => {
			if (body.rootPath === undefined) return undefined;
			if (typeof body.rootPath !== "string" || !body.rootPath) return "Not a workspace";
			// The Workspaces of a mode are checked, so the mode must be named (without it the PC uses its current one).
			if (body.mode !== "coding" && body.mode !== "general") return "Not a workspace";
			const listed = await get(`/api/workspaces?mode=${body.mode}`);
			const roots =
				isObject(listed) && Array.isArray(listed.workspaces)
					? listed.workspaces.map((entry) => (isObject(entry) ? entry.rootPath : undefined))
					: [];
			return roots.includes(body.rootPath) ? undefined : "Not a workspace";
		},
	},
	{
		method: "POST",
		path: "/api/sessions/open",
		body: (input) => {
			const path = isObject(input) && typeof input.path === "string" ? input.path : "";
			// Only a saved chat (the paths the chat lists hand out) can be opened.
			if (!/\.jsonl$/i.test(path)) throw new LinkError(400, "Not a chat");
			return { path };
		},
	},
];

class LinkError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface LinkSession {
	id: string;
	deviceId: string;
	replay: ReplayWindow;
	lastUsed: number;
}

/**
 * Where the sealed event frames of one phone stream go: an HTTP response (Server-Sent Events) on the local network,
 * or a remote transport. `send` returns false while the transport is backed up; it then calls the drain listener.
 */
export interface LinkStreamSink {
	/**
	 * One sealed frame (`<nonce>.<ciphertext>`), or "" for a keep-alive. `progress` names what a progress frame shows
	 * (a reply's text so far, a tool's output so far, a slot's usage): it shows all of an older frame of that name, so a
	 * transport that is still gathering frames into one write may drop the older one.
	 */
	send(frame: string, progress?: FrameProgress): boolean;
	end(): void;
	/** Close at once: the stream is too far behind. */
	destroy(): void;
	onDrain(listener: () => void): void;
	onClose(listener: () => void): void;
}

/** How a phone reached this PC: the local network, a direct WebRTC connection, or files in Drive. */
export type LinkTransport = "lan" | "direct" | "relay";

export type DispatchResult =
	| { kind: "json"; body: Json }
	| { kind: "stream"; session: { id: string; deviceId: string }; key: Buffer };

interface PhoneStream {
	sink: LinkStreamSink;
	transport: LinkTransport;
	deviceId: string;
	sessionId: string;
	key: Buffer;
	seq: number;
	backedUp: boolean;
	pendingFinal: string[];
	pendingDrop: { frame: string; progress: FrameProgress } | null;
}

export interface PhoneLinkGatewayOptions {
	store: PhoneLinkStore;
	/** Origin of the loopback Web UI server, such as `http://127.0.0.1:8787`. */
	upstream: () => string;
	/** Subscribe to the events the Web UI server sends to its pages; returns the function that unsubscribes. */
	tap: (listener: (event: string, data: unknown) => void) => () => void;
	/** How this PC names itself to a phone. */
	info: () => { name: string; version: string };
	/** A phone was paired, connected or went away: the settings page should read the status again. */
	onChange?: () => void;
	/**
	 * Interface to listen on; default every interface (0.0.0.0), so a phone on the local network reaches it.
	 * `MYHARNESS_PHONE_LINK_BIND` sets it to one address of this PC (web-mode.ts); tests pass 127.0.0.1.
	 */
	bindHost?: string;
	/** Port to listen on instead of the stored one (tests pass 0 for any free port). */
	port?: number;
	now?: () => number;
}

export interface PhoneLinkStatus {
	enabled: boolean;
	listening: boolean;
	port: number;
	error: string | null;
	/** This PC's addresses on its networks, as a phone would reach them. */
	addresses: string[];
	/** Whether phones signed in with the same Google account may connect from any network. */
	remote: boolean;
	/** Whether the remote transports are running (the switch is on and this PC is signed in). */
	remoteActive: boolean;
	devices: Array<{
		id: string;
		name: string;
		pairedAt: number | null;
		lastSeenAt: number | null;
		connected: boolean;
		/** How each open stream of this phone arrived. */
		transports: LinkTransport[];
		/** A QR code that no phone has used yet. */
		pending: boolean;
		/** Paired with a QR code, or signed in with this PC's Google account. */
		source: "qr" | "google";
	}>;
}

/** Turns an HTTP response into a stream sink (Server-Sent Events). */
function httpSink(res: ServerResponse): LinkStreamSink {
	return {
		send: (frame) => res.write(frame ? `data: ${frame}\n\n` : ": k\n\n"),
		end: () => res.end(),
		destroy: () => res.destroy(),
		onDrain: (listener) => res.on("drain", listener),
		onClose: (listener) => res.once("close", listener),
	};
}

/** The HTTP status of an error a dispatch threw. */
export function linkErrorStatus(error: unknown): { status: number; message: string } {
	return error instanceof LinkError
		? { status: error.status, message: error.message }
		: { status: 500, message: "Internal error" };
}

/** This PC's IPv4 addresses on real networks (no loopback, no link-local). */
export function lanAddresses(): string[] {
	const found: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const entry of list ?? []) {
			if (entry.internal || entry.family !== "IPv4" || entry.address.startsWith("169.254.")) continue;
			found.push(entry.address);
		}
	}
	// Home and office ranges first: they are what a phone on the same Wi-Fi reaches.
	const rank = (address: string) => (address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : 2);
	return [...new Set(found)].sort((a, b) => rank(a) - rank(b)).slice(0, 6);
}

/** The text of the QR code: where this PC is, which device entry it made, and that entry's key. */
export function pairingUri(input: {
	hosts: string[];
	port: number;
	deviceId: string;
	key: string;
	name: string;
}): string {
	const params = new URLSearchParams({
		v: "1",
		h: input.hosts.join(","),
		p: String(input.port),
		d: input.deviceId,
		k: input.key,
		n: input.name.slice(0, 40),
	});
	return `myharness://link?${params.toString()}`;
}

export class PhoneLinkGateway {
	private server: Server | undefined;
	private listenError: string | null = null;
	private readonly sessions = new Map<string, LinkSession>();
	private readonly streams = new Set<PhoneStream>();
	private readonly failures = new Map<string, number[]>();
	private untap: (() => void) | undefined;
	private keepAlive: ReturnType<typeof setInterval> | undefined;
	/** Whether a remote transport is running; the event tap stays on for it while the LAN server is off. */
	private remoteActive = false;
	private readonly now: () => number;
	private readonly options: PhoneLinkGatewayOptions;

	constructor(options: PhoneLinkGatewayOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	get listening(): boolean {
		return this.server !== undefined;
	}

	/** Called by the remote transports when they start and stop: events are tapped while anyone may stream them. */
	setRemoteActive(active: boolean): void {
		if (this.remoteActive === active) return;
		this.remoteActive = active;
		if (active) this.startCore();
		else {
			for (const stream of [...this.streams]) if (stream.transport !== "lan") stream.sink.end();
			if (!this.server) this.stopCore();
		}
		this.options.onChange?.();
	}

	private startCore(): void {
		if (this.untap) return;
		this.untap = this.options.tap((event, data) => this.relay(event, data));
		this.keepAlive = setInterval(() => this.tick(), KEEPALIVE_MS);
		this.keepAlive.unref();
	}

	private stopCore(): void {
		this.untap?.();
		this.untap = undefined;
		if (this.keepAlive) clearInterval(this.keepAlive);
		this.keepAlive = undefined;
		for (const stream of this.streams) stream.sink.end();
		this.streams.clear();
		this.sessions.clear();
	}

	/** The port in use (differs from the stored one only in tests that ask for port 0). */
	get port(): number {
		const address = this.server?.address();
		return address && typeof address === "object" ? address.port : this.options.store.port;
	}

	status(): PhoneLinkStatus {
		const store = this.options.store;
		const transports = new Map<string, Set<LinkTransport>>();
		for (const stream of this.streams) {
			const found = transports.get(stream.deviceId) ?? new Set<LinkTransport>();
			found.add(stream.transport);
			transports.set(stream.deviceId, found);
		}
		return {
			enabled: store.enabled,
			listening: this.listening,
			port: this.port,
			error: store.loadError ? `phone-link.json: ${store.loadError}` : this.listenError,
			addresses: this.addresses(),
			remote: store.remote,
			remoteActive: this.remoteActive,
			devices: store.devices().map((device) => ({
				id: device.id,
				name: device.name,
				pairedAt: device.pairedAt,
				lastSeenAt: device.lastSeenAt,
				connected: transports.has(device.id),
				transports: [...(transports.get(device.id) ?? [])],
				pending: device.pairedAt === null,
				source: device.source === "google" ? "google" : "qr",
			})),
		};
	}

	/** The addresses a phone can use: the one address this gateway is bound to, or all of this PC's network addresses. */
	addresses(): string[] {
		const bound = this.options.bindHost;
		return bound && bound !== "0.0.0.0" ? [bound] : lanAddresses();
	}

	/** Start or stop listening so that it matches the stored switch. Never throws: a failure is kept for `status()`. */
	async apply(): Promise<void> {
		const store = this.options.store;
		if (!store.enabled) {
			await this.closeServer();
			this.listenError = null;
			return;
		}
		const wanted = this.options.port ?? store.port;
		if (this.server && (wanted === 0 || this.port === wanted)) return;
		await this.closeServer();
		try {
			await this.listen(wanted);
			this.listenError = null;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			this.listenError =
				code === "EADDRINUSE"
					? `Port ${store.port} is already used by another program. Choose another port.`
					: error instanceof Error
						? error.message
						: String(error);
		}
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				this.handle(req, res).catch((error) => this.fail(res, error));
			});
			server.once("error", reject);
			server.listen(port, this.options.bindHost ?? "0.0.0.0", () => {
				server.off("error", reject);
				this.server = server;
				this.startCore();
				resolve();
			});
		});
	}

	/** Stop everything: the LAN server, the event tap, every stream (remote ones included) and session. */
	async stop(): Promise<void> {
		this.remoteActive = false;
		this.stopCore();
		await this.closeServer();
	}

	/** Stop listening on the local network. Remote streams and their sessions go on while remote transports run. */
	private async closeServer(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const stream of [...this.streams]) if (stream.transport === "lan") stream.sink.end();
		if (!this.remoteActive) this.stopCore();
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	/** Forget a phone right now: its streams close and its sessions end (the store entry is removed by the caller). */
	disconnect(deviceId: string): void {
		for (const stream of [...this.streams]) if (stream.deviceId === deviceId) stream.sink.end();
		for (const [id, session] of this.sessions) if (session.deviceId === deviceId) this.sessions.delete(id);
	}

	// ---- Requests ---------------------------------------------------------------------------------

	private fail(res: ServerResponse, error: unknown): void {
		const status = error instanceof LinkError ? error.status : 500;
		const message = error instanceof LinkError ? error.message : "Internal error";
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ error: message }));
	}

	private blocked(address: string): boolean {
		const recent = (this.failures.get(address) ?? []).filter((time) => time > this.now() - FAILURE_WINDOW_MS);
		if (recent.length) this.failures.set(address, recent);
		else this.failures.delete(address);
		return recent.length >= FAILURE_LIMIT;
	}

	private noteFailure(address: string): void {
		const recent = this.failures.get(address) ?? [];
		recent.push(this.now());
		this.failures.set(address, recent.slice(-FAILURE_LIMIT));
	}

	private async readBody(req: IncomingMessage): Promise<Json> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) throw new LinkError(413, "Too large");
			chunks.push(chunk as Buffer);
		}
		try {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (isObject(parsed)) return parsed;
		} catch {
			// Reported below.
		}
		throw new LinkError(400, "Bad request");
	}

	/** Open the sealed body of a request: finds the device by its id and proves the sender holds its key. */
	private unseal(
		operation: string,
		envelope: Json,
		address: string,
	): { deviceId: string; key: Buffer; nonce: string; payload: Json } {
		const deviceId = typeof envelope.d === "string" ? envelope.d : "";
		const key = deviceId ? this.options.store.keyOf(deviceId) : undefined;
		if (!key || typeof envelope.n !== "string" || typeof envelope.c !== "string") {
			this.noteFailure(address);
			throw new LinkError(403, "Not paired");
		}
		let payload: unknown;
		try {
			payload = open(key, linkAad(operation, "req", deviceId), { n: envelope.n, c: envelope.c });
		} catch {
			this.noteFailure(address);
			throw new LinkError(403, "Not paired");
		}
		if (!isObject(payload)) throw new LinkError(400, "Bad request");
		return { deviceId, key, nonce: envelope.n, payload };
	}

	/** Check that a request belongs to an open session of that device and was not sent before. */
	private useSession(deviceId: string, payload: Json): LinkSession {
		const session = typeof payload.s === "string" ? this.sessions.get(payload.s) : undefined;
		if (!session || session.deviceId !== deviceId) throw new LinkError(401, "Session expired");
		if (!session.replay.accept(payload.q)) throw new LinkError(409, "Repeated request");
		session.lastUsed = this.now();
		return session;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const address = req.socket.remoteAddress ?? "";
		const path = new URL(req.url ?? "/", "http://link").pathname;
		if (req.method === "GET" && path === "/link/v1/ping") {
			// Lets a phone find which of the PC's addresses answers; says nothing but that the link is here.
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ ok: true, protocol: LINK_PROTOCOL }));
			return;
		}
		const operation = /^\/link\/v1\/(open|call|events)$/.exec(path)?.[1] as "open" | "call" | "events" | undefined;
		if (req.method !== "POST" || !operation) throw new LinkError(404, "Not found");
		if (this.blocked(address)) throw new LinkError(429, "Too many failed attempts. Try again later.");
		const result = await this.dispatch(operation, await this.readBody(req), address);
		if (result.kind === "json") {
			const body = JSON.stringify(result.body);
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		req.socket.setNoDelay(true);
		this.attachStream(result, httpSink(res), "lan");
	}

	/**
	 * One sealed request, from the LAN server or a remote transport: `open` and `call` answer with a sealed body,
	 * `events` with the session a stream is then attached to (`attachStream`). `source` names the sender for the
	 * limit on failed attempts (an address, or the transport and phone). Throws a LinkError (`linkErrorStatus`).
	 */
	async dispatch(operation: "open" | "call" | "events", envelope: Json, source: string): Promise<DispatchResult> {
		if (this.blocked(source)) throw new LinkError(429, "Too many failed attempts. Try again later.");
		const { deviceId, key, nonce, payload } = this.unseal(operation, envelope, source);

		if (operation === "open") {
			const mine = [...this.sessions.values()]
				.filter((entry) => entry.deviceId === deviceId)
				.sort((a, b) => a.lastUsed - b.lastUsed);
			while (mine.length >= SESSIONS_PER_DEVICE) this.sessions.delete(mine.shift()!.id);
			const session: LinkSession = { id: newId(16), deviceId, replay: new ReplayWindow(), lastUsed: this.now() };
			this.sessions.set(session.id, session);
			const paired = this.options.store.markSeen(
				deviceId,
				typeof payload.name === "string" ? payload.name : undefined,
			);
			if (paired) queueMicrotask(() => this.options.onChange?.());
			const answer = { s: session.id, pc: this.options.info(), now: this.now() };
			return { kind: "json", body: { ...seal(key, linkAad("open", "res", deviceId, nonce), answer) } };
		}

		const session = this.useSession(deviceId, payload);
		if (operation === "call") {
			this.confirmPrompt(session.id, payload);
			const answer = await this.forward(payload);
			return { kind: "json", body: { ...seal(key, linkAad("call", "res", deviceId, nonce), answer) } };
		}
		return { kind: "stream", session: { id: session.id, deviceId }, key };
	}

	/**
	 * A message from the phone reached this PC: the phone's event stream hears so at once (`prompt_received`). The
	 * answer to the request itself comes only once the agent took the message, after its preparation (memory recall
	 * among others), which takes seconds; until the receipt, the phone shows the message as still being sent.
	 */
	private confirmPrompt(sessionId: string, payload: Json): void {
		if (payload.m !== "POST" || typeof payload.p !== "string" || !isObject(payload.b)) return;
		try {
			if (new URL(payload.p, "http://link").pathname !== "/api/prompt") return;
		} catch {
			return;
		}
		const clientMessageId = payload.b.clientMessageId;
		if (typeof clientMessageId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(clientMessageId)) return;
		const slot = typeof payload.slot === "string" ? payload.slot : undefined;
		for (const stream of this.streams)
			if (stream.sessionId === sessionId) this.push(stream, "prompt_received", { slot, clientMessageId }, false);
	}

	/** Read one route of the Web UI server for a check of the gateway's own (not a phone's request). */
	private async read(path: string): Promise<unknown> {
		const response = await fetch(`${this.options.upstream()}${path}`, { headers: { "x-myharness-web": "1" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	}

	/** Pass one allowed request on to the Web UI server and return its answer. */
	private async forward(payload: Json): Promise<Json> {
		const method = payload.m === "POST" ? "POST" : "GET";
		let target: URL;
		try {
			target = new URL(typeof payload.p === "string" ? payload.p : "", "http://link");
		} catch {
			throw new LinkError(400, "Bad request");
		}
		const route = ROUTES.find((entry) => entry.method === method && entry.path === target.pathname);
		if (!route) return { status: 403, json: { error: "This is not available from a phone." } };
		const query = new URLSearchParams();
		for (const name of route.query ?? []) {
			const value = target.searchParams.get(name);
			if (value !== null) query.set(name, value);
		}
		const headers: Record<string, string> = { "x-myharness-web": "1" };
		if (typeof payload.slot === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(payload.slot))
			headers["x-myharness-slot"] = payload.slot;
		let body: string | undefined;
		if (method === "POST") {
			let clean: Json;
			try {
				clean = route.body ? route.body(payload.b) : {};
			} catch (error) {
				if (error instanceof LinkError) return { status: error.status, json: { error: error.message } };
				throw error;
			}
			if (route.verify) {
				let refused: string | undefined;
				try {
					refused = await route.verify(clean, (path) => this.read(path));
				} catch {
					return { status: 502, json: { error: "MyHarness on the PC did not answer." } };
				}
				if (refused) return { status: 403, json: { error: refused } };
			}
			body = JSON.stringify(clean);
			headers["content-type"] = "application/json";
		}
		const search = query.toString();
		let response: Response;
		try {
			response = await fetch(`${this.options.upstream()}${route.path}${search ? `?${search}` : ""}`, {
				method,
				headers,
				body,
			});
		} catch {
			return { status: 502, json: { error: "MyHarness on the PC did not answer." } };
		}
		if (route.binary && response.ok) {
			return {
				status: response.status,
				type: response.headers.get("content-type") ?? "application/octet-stream",
				b64: Buffer.from(await response.arrayBuffer()).toString("base64"),
			};
		}
		const text = await response.text();
		try {
			return { status: response.status, json: text ? JSON.parse(text) : null };
		} catch {
			return { status: response.status, json: { error: text.slice(0, 500) } };
		}
	}

	// ---- Events -----------------------------------------------------------------------------------

	/** Start sending a session's events to a sink (the `events` answer of `dispatch`). */
	attachStream(
		result: Extract<DispatchResult, { kind: "stream" }>,
		sink: LinkStreamSink,
		transport: LinkTransport,
	): void {
		const { session, key } = result;
		if (!this.sessions.has(session.id)) {
			sink.end();
			return;
		}
		const stream: PhoneStream = {
			sink,
			transport,
			deviceId: session.deviceId,
			sessionId: session.id,
			key,
			seq: 0,
			backedUp: false,
			pendingFinal: [],
			pendingDrop: null,
		};
		this.streams.add(stream);
		sink.onDrain(() => this.flush(stream));
		sink.onClose(() => {
			if (this.streams.delete(stream)) this.options.onChange?.();
		});
		this.push(stream, "link", { ok: true }, false);
		this.options.onChange?.();
	}

	private frame(stream: PhoneStream, event: string, data: unknown): string {
		stream.seq += 1;
		const sealed = seal(stream.key, linkAad("events", "evt", stream.deviceId, stream.sessionId), {
			i: stream.seq,
			e: event,
			d: data,
		});
		return `${sealed.n}.${sealed.c}`;
	}

	private push(stream: PhoneStream, event: string, data: unknown, droppable: boolean): void {
		const frame = this.frame(stream, event, data);
		const progress = droppable ? progressOf(event, data) : undefined;
		if (stream.backedUp) {
			if (progress !== undefined) stream.pendingDrop = { frame, progress };
			else {
				// A final frame that follows a kept progress frame makes that progress frame stale.
				stream.pendingDrop = null;
				stream.pendingFinal.push(frame);
				if (stream.pendingFinal.length > MAX_PENDING_FRAMES) stream.sink.destroy();
			}
			return;
		}
		if (stream.sink.send(frame, progress) === false) stream.backedUp = true;
	}

	private flush(stream: PhoneStream): void {
		if (!stream.backedUp) return;
		stream.backedUp = false;
		const pending: Array<{ frame: string; progress?: FrameProgress }> = [
			...stream.pendingFinal.map((frame) => ({ frame })),
			...(stream.pendingDrop ? [stream.pendingDrop] : []),
		];
		stream.pendingFinal = [];
		stream.pendingDrop = null;
		for (let index = 0; index < pending.length; index++) {
			if (stream.sink.send(pending[index]!.frame, pending[index]!.progress) === false) {
				// The rest waits for the next drain, in order.
				stream.backedUp = true;
				stream.pendingFinal = pending.slice(index + 1).map((entry) => entry.frame);
				return;
			}
		}
	}

	private relay(event: string, data: unknown): void {
		if (this.streams.size === 0 || !EVENTS.has(event)) return;
		const droppable = DROPPABLE.has(event);
		for (const stream of this.streams) this.push(stream, event, data, droppable);
	}

	private tick(): void {
		const now = this.now();
		for (const [id, session] of this.sessions) {
			const streaming = [...this.streams].some((stream) => stream.sessionId === id);
			if (!streaming && now - session.lastUsed > SESSION_IDLE_MS) this.sessions.delete(id);
		}
		for (const stream of this.streams) {
			// A phone whose key was removed, or whose session ended, stops receiving at once.
			if (!this.sessions.has(stream.sessionId) || !this.options.store.keyOf(stream.deviceId)) {
				stream.sink.end();
				continue;
			}
			if (!stream.backedUp) stream.sink.send("");
		}
	}
}
