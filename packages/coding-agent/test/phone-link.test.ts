import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromBase64Url, linkAad, open, ReplayWindow, seal } from "../src/modes/web/phone-link/crypto.ts";
import { PhoneLinkGateway, pairingUri } from "../src/modes/web/phone-link/gateway.ts";
import { PAIRING_TTL_MS, PhoneLinkStore } from "../src/modes/web/phone-link/store.ts";

describe("phone link crypto", () => {
	const key = Buffer.alloc(32, 7);

	it("opens what it sealed and nothing else", () => {
		const aad = linkAad("call", "req", "device-1");
		const sealed = seal(key, aad, { hello: "世界", n: 1 });
		expect(open(key, aad, sealed)).toEqual({ hello: "世界", n: 1 });
		// Another key, another operation, another direction, another device, or one changed character: all refused.
		expect(() => open(Buffer.alloc(32, 8), aad, sealed)).toThrow();
		expect(() => open(key, linkAad("open", "req", "device-1"), sealed)).toThrow();
		expect(() => open(key, linkAad("call", "res", "device-1"), sealed)).toThrow();
		expect(() => open(key, linkAad("call", "req", "device-2"), sealed)).toThrow();
		// (The first character: all of its bits are part of the message; the last one may carry unused padding bits.)
		const flipped = (sealed.c.startsWith("A") ? "B" : "A") + sealed.c.slice(1);
		expect(() => open(key, aad, { n: sealed.n, c: flipped })).toThrow();
	});

	it("uses a fresh nonce for every message", () => {
		const aad = linkAad("call", "req", "d");
		const nonces = new Set(Array.from({ length: 200 }, () => seal(key, aad, {}).n));
		expect(nonces.size).toBe(200);
	});

	it("accepts each counter once, in any order inside the window", () => {
		const replay = new ReplayWindow(8);
		expect(replay.accept(3)).toBe(true);
		expect(replay.accept(1)).toBe(true);
		expect(replay.accept(3)).toBe(false);
		expect(replay.accept(20)).toBe(true);
		expect(replay.accept(12)).toBe(false); // older than the window
		expect(replay.accept(13)).toBe(true);
		expect(replay.accept(0)).toBe(false);
		expect(replay.accept(1.5)).toBe(false);
		expect(replay.accept("4")).toBe(false);
	});
});

describe("phone link store", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mh-phone-link-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is off by default and keeps what was set", () => {
		const store = new PhoneLinkStore(dir);
		expect(store.enabled).toBe(false);
		store.setEnabled(true, 50123);
		const again = new PhoneLinkStore(dir);
		expect(again.enabled).toBe(true);
		expect(again.port).toBe(50123);
		expect(() => again.setEnabled(true, 80)).toThrow();
	});

	it("turns a QR code into a paired phone when the phone connects, and drops unused codes", () => {
		let now = 1_000_000;
		const store = new PhoneLinkStore(dir, () => now);
		const first = store.createPairing();
		expect(store.keyOf(first.id)?.length).toBe(32);
		// A second code replaces the one still waiting.
		const second = store.createPairing();
		expect(store.keyOf(first.id)).toBeUndefined();
		expect(store.markSeen(second.id, "Pixel 9")).toBe(true);
		expect(store.markSeen(second.id, "Pixel 9")).toBe(false);
		const third = store.createPairing();
		now += PAIRING_TTL_MS + 1;
		expect(store.keyOf(third.id)).toBeUndefined();
		expect(store.devices().map((device) => device.id)).toEqual([second.id]);
		expect(store.devices()[0]).toMatchObject({ name: "Pixel 9", pairedAt: 1_000_000 });
		expect(store.remove(second.id)).toBe(true);
		expect(store.keyOf(second.id)).toBeUndefined();
	});

	it("leaves an unreadable file alone", () => {
		writeFileSync(join(dir, "phone-link.json"), "{ not json", "utf8");
		const store = new PhoneLinkStore(dir);
		expect(store.loadError).toBeTruthy();
		expect(() => store.setEnabled(true)).toThrow();
		expect(readFileSync(join(dir, "phone-link.json"), "utf8")).toBe("{ not json");
	});
});

describe("phone link gateway", () => {
	let dir: string;
	let upstream: Server;
	let gateway: PhoneLinkGateway;
	let store: PhoneLinkStore;
	let base: string;
	let seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }>;
	let emit: (event: string, data: unknown) => void;
	let counter: number;
	/** While set, the Web UI server holds its answer to /api/prompt until it settles (an agent still preparing). */
	let promptGate: Promise<void> | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "mh-phone-link-"));
		seen = [];
		counter = 0;
		promptGate = undefined;
		upstream = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", async () => {
				seen.push({
					method: req.method ?? "",
					url: req.url ?? "",
					headers: req.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
				if (req.url?.startsWith("/api/transcript/image")) {
					res.writeHead(200, { "content-type": "image/png" });
					res.end(Buffer.from([1, 2, 3, 4]));
					return;
				}
				if (req.url === "/api/abort") {
					res.writeHead(409, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "nothing runs" }));
					return;
				}
				if (req.url?.startsWith("/api/workspaces?")) {
					res.writeHead(200, { "content-type": "application/json" });
					const mode = new URL(req.url, "http://pc").searchParams.get("mode");
					res.end(
						JSON.stringify({ workspaces: mode === "coding" ? [{ name: "app", rootPath: "C:/Work/app" }] : [] }),
					);
					return;
				}
				if (req.url === "/api/prompt" && promptGate) await promptGate;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, path: req.url }));
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		store = new PhoneLinkStore(dir);
		store.setEnabled(true);
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
			bindHost: "127.0.0.1",
			port: 0,
		});
		await gateway.apply();
		base = `http://127.0.0.1:${gateway.port}`;
	});

	afterEach(async () => {
		await gateway.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	const post = (operation: string, body: unknown) =>
		fetch(`${base}/link/v1/${operation}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	async function pair() {
		const device = store.createPairing();
		const key = fromBase64Url(device.key);
		const request = seal(key, linkAad("open", "req", device.id), { name: "Test phone" });
		const response = await post("open", { d: device.id, ...request });
		expect(response.status).toBe(200);
		const answer = open(
			key,
			linkAad("open", "res", device.id, request.n),
			(await response.json()) as { n: string; c: string },
		) as {
			s: string;
			pc: { name: string };
		};
		return { device, key, session: answer.s, pc: answer.pc };
	}

	async function call(link: Awaited<ReturnType<typeof pair>>, payload: Record<string, unknown>) {
		const request = seal(link.key, linkAad("call", "req", link.device.id), {
			s: link.session,
			q: ++counter,
			...payload,
		});
		const response = await post("call", { d: link.device.id, ...request });
		if (response.status !== 200) return { httpStatus: response.status };
		return open(
			link.key,
			linkAad("call", "res", link.device.id, request.n),
			(await response.json()) as { n: string; c: string },
		) as Record<string, unknown>;
	}

	it("answers a ping and nothing else in the clear", async () => {
		expect(await (await fetch(`${base}/link/v1/ping`)).json()).toEqual({ ok: true, protocol: "mh-link-v1" });
		expect((await fetch(`${base}/api/state`)).status).toBe(404);
		expect((await fetch(`${base}/link/v1/call`)).status).toBe(404);
	});

	it("pairs a phone that holds the key and names the PC", async () => {
		const link = await pair();
		expect(link.pc).toEqual({ name: "Test PC", version: "0.0.0" });
		expect(gateway.status().devices).toMatchObject([{ id: link.device.id, name: "Test phone", pending: false }]);
	});

	it("refuses unknown devices and wrong keys", async () => {
		const device = store.createPairing();
		const wrong = seal(Buffer.alloc(32, 1), linkAad("open", "req", device.id), {});
		expect((await post("open", { d: device.id, ...wrong })).status).toBe(403);
		const real = seal(fromBase64Url(device.key), linkAad("open", "req", device.id), {});
		expect((await post("open", { d: "nobody", ...real })).status).toBe(403);
		// A request sealed for one operation is not accepted as another.
		expect((await post("call", { d: device.id, ...real })).status).toBe(403);
		expect(seen).toHaveLength(0);
	});

	it("forwards allowed requests with the Web UI header, the slot and only the allowed fields", async () => {
		const link = await pair();
		const state = await call(link, { m: "GET", p: "/api/transcript?limit=50&images=ref&secret=1", slot: "slot-2" });
		expect(state).toMatchObject({ status: 200, json: { ok: true, path: "/api/transcript?limit=50&images=ref" } });
		expect(seen[0].headers["x-myharness-web"]).toBe("1");
		expect(seen[0].headers["x-myharness-slot"]).toBe("slot-2");
		await call(link, { m: "POST", p: "/api/prompt", b: { text: "hi", mode: "auto", cwd: "C:/", extra: true } });
		expect(JSON.parse(seen[1].body)).toEqual({ text: "hi", mode: "auto" });
		// A folder the PC does not list as a Workspace is refused before anything reaches the Web UI server.
		expect(
			await call(link, { m: "POST", p: "/api/sessions/new", b: { rootPath: "C:/Windows", unbound: true } }),
		).toMatchObject({ status: 403 });
		await call(link, { m: "POST", p: "/api/sessions/new", b: { unbound: true, mode: "general", cwd: "C:/" } });
		expect(JSON.parse(seen[2].body)).toEqual({ unbound: true, mode: "general" });
		const image = await call(link, { m: "GET", p: "/api/transcript/image?entry=e1&index=0" });
		expect(image).toMatchObject({ status: 200, type: "image/png", b64: "AQIDBA==" });
		// The PC's own refusals reach the phone as they are.
		expect(await call(link, { m: "POST", p: "/api/abort" })).toMatchObject({
			status: 409,
			json: { error: "nothing runs" },
		});
	});

	it("starts a chat in a Workspace the PC lists for that mode, and in no other folder", async () => {
		const link = await pair();
		expect(
			await call(link, { m: "POST", p: "/api/sessions/new", b: { mode: "coding", rootPath: "C:/Work/app" } }),
		).toMatchObject({ status: 200 });
		expect(seen.map((entry) => entry.url)).toEqual(["/api/workspaces?mode=coding", "/api/sessions/new"]);
		expect(JSON.parse(seen[1].body)).toEqual({ mode: "coding", rootPath: "C:/Work/app" });
		// A folder around the Workspace, the Workspace under the other mode, or no mode named: refused.
		for (const b of [
			{ mode: "coding", rootPath: "C:/Work" },
			{ mode: "general", rootPath: "C:/Work/app" },
			{ rootPath: "C:/Work/app" },
			{ mode: "coding", rootPath: 7 },
		])
			expect(await call(link, { m: "POST", p: "/api/sessions/new", b })).toMatchObject({ status: 403 });
		expect(seen.filter((entry) => entry.url === "/api/sessions/new")).toHaveLength(1);
	});

	it("tells the phone's stream that a message arrived before the agent has taken it", async () => {
		const link = await pair();
		const request = seal(link.key, linkAad("events", "req", link.device.id), { s: link.session, q: ++counter });
		const response = await post("events", { d: link.device.id, ...request });
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const next = async () => {
			for (;;) {
				const at = buffer.indexOf("\n\n");
				if (at >= 0) {
					const frame = buffer.slice(0, at);
					buffer = buffer.slice(at + 2);
					if (!frame.startsWith("data: ")) continue;
					const [n, c] = frame.slice(6).split(".");
					return open(link.key, linkAad("events", "evt", link.device.id, link.session), { n, c }) as {
						i: number;
						e: string;
						d: unknown;
					};
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buffer += decoder.decode(value, { stream: true });
			}
		};
		expect(await next()).toMatchObject({ e: "link" });
		let release = () => {};
		promptGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let answered = false;
		const sent = call(link, {
			m: "POST",
			p: "/api/prompt",
			slot: "s2",
			b: { text: "hi", mode: "auto", clientMessageId: "m-abc-1" },
		}).then((answer) => {
			answered = true;
			return answer;
		});
		expect(await next()).toEqual({ i: 2, e: "prompt_received", d: { slot: "s2", clientMessageId: "m-abc-1" } });
		expect(answered).toBe(false);
		release();
		expect(await sent).toMatchObject({ status: 200 });
		// A request that is not a message, or one without an id, says nothing on the stream.
		await call(link, { m: "POST", p: "/api/prompt", b: { text: "no id" } });
		await call(link, { m: "GET", p: "/api/state" });
		emit("run_finished", { runId: 2 });
		expect(await next()).toEqual({ i: 3, e: "run_finished", d: { runId: 2 } });
		await reader.cancel();
	});

	it("does not forward anything outside the list", async () => {
		const link = await pair();
		for (const [m, p] of [
			["POST", "/api/terminal/create"],
			["GET", "/api/files/read?path=C:/secret.txt"],
			["POST", "/api/settings"],
			["GET", "/api/providers"],
			["POST", "/api/phone-link/pair"],
			["GET", "/api/state/../settings"],
			["POST", "/api/state"],
		]) {
			expect(await call(link, { m, p })).toMatchObject({ status: 403 });
		}
		expect(
			await call(link, { m: "POST", p: "/api/sessions/open", b: { path: "C:/Windows/system.ini" } }),
		).toMatchObject({ status: 400 });
		expect(seen).toHaveLength(0);
	});

	it("refuses a repeated request and a request without a session", async () => {
		const link = await pair();
		const request = seal(link.key, linkAad("call", "req", link.device.id), {
			s: link.session,
			q: 1,
			m: "GET",
			p: "/api/state",
		});
		expect((await post("call", { d: link.device.id, ...request })).status).toBe(200);
		expect((await post("call", { d: link.device.id, ...request })).status).toBe(409);
		const stray = seal(link.key, linkAad("call", "req", link.device.id), {
			s: "nope",
			q: 2,
			m: "GET",
			p: "/api/state",
		});
		expect((await post("call", { d: link.device.id, ...stray })).status).toBe(401);
		expect(seen).toHaveLength(1);
	});

	it("stops serving a phone that was removed", async () => {
		const link = await pair();
		gateway.disconnect(link.device.id);
		store.remove(link.device.id);
		expect(await call(link, { m: "GET", p: "/api/state" })).toEqual({ httpStatus: 403 });
	});

	it("relays the chat events, sealed and numbered, and keeps the rest on the PC", async () => {
		const link = await pair();
		const request = seal(link.key, linkAad("events", "req", link.device.id), { s: link.session, q: ++counter });
		const response = await post("events", { d: link.device.id, ...request });
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const next = async () => {
			for (;;) {
				const at = buffer.indexOf("\n\n");
				if (at >= 0) {
					const frame = buffer.slice(0, at);
					buffer = buffer.slice(at + 2);
					if (!frame.startsWith("data: ")) continue;
					const [n, c] = frame.slice(6).split(".");
					return open(link.key, linkAad("events", "evt", link.device.id, link.session), { n, c }) as {
						i: number;
						e: string;
						d: unknown;
					};
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buffer += decoder.decode(value, { stream: true });
			}
		};
		expect(await next()).toEqual({ i: 1, e: "link", d: { ok: true } });
		expect(gateway.status().devices[0].connected).toBe(true);
		emit("terminal_output", { text: "secret" });
		emit("message_update", { slot: "a", liveId: "l1" });
		emit("sync_status", {});
		emit("run_finished", { runId: 1 });
		expect(await next()).toEqual({ i: 2, e: "message_update", d: { slot: "a", liveId: "l1" } });
		expect(await next()).toEqual({ i: 3, e: "run_finished", d: { runId: 1 } });
		await reader.cancel();
	});

	it("blocks an address after repeated failures", async () => {
		const device = store.createPairing();
		const wrong = seal(Buffer.alloc(32, 1), linkAad("open", "req", device.id), {});
		let last = 0;
		for (let i = 0; i < 21; i++) last = (await post("open", { d: device.id, ...wrong })).status;
		expect(last).toBe(429);
	});

	it("writes the QR text a phone parses", () => {
		const uri = pairingUri({
			hosts: ["192.168.1.5", "10.0.0.2"],
			port: 47821,
			deviceId: "dev",
			key: "a_b-c",
			name: "My PC",
		});
		const url = new URL(uri);
		expect(url.protocol).toBe("myharness:");
		expect(url.host).toBe("link");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			v: "1",
			h: "192.168.1.5,10.0.0.2",
			p: "47821",
			d: "dev",
			k: "a_b-c",
			n: "My PC",
		});
	});
});
