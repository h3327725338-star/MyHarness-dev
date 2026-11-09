import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
	BRIDGE_PLUGIN_HOOKS,
	BRIDGE_PLUGIN_MANIFEST,
	createBridgePluginSource,
} from "../src/providers/claude-code/bridge-plugin.ts";

const URL = "http://127.0.0.1:34567/bridge/test-instance";
const TOKEN = 'instance-token-"\\quoted';
type Hook = (...args: any[]) => any;
interface Timer {
	ms: number;
	callback: Hook;
	cancelled: boolean;
}

function fixture(token = TOKEN) {
	const hooks = new Map<string, Hook>();
	const catches = new Map<string, Hook>();
	const timers: Timer[] = [];
	const requests: { url: string; init: any }[] = [];
	let responder = async (_url: string, _init: any): Promise<any> => ({
		ok: true,
		status: 204,
		text: "",
		headers: {},
	});
	const $ = {
		http: {
			fetch: vi.fn(async (url: string, init: any) => {
				requests.push({ url, init });
				return responder(url, init);
			}),
		},
		clock: {
			after: vi.fn((ms: number, callback: Hook) => {
				const timer = { ms, callback, cancelled: false };
				timers.push(timer);
				return {
					cancel: () => {
						timer.cancelled = true;
					},
				};
			}),
		},
		session: {
			id: vi.fn(async () => "real-cli-session-id"),
			version: vi.fn(async () => ({ version: "2.1.317" })),
			surfaces: vi.fn(async () => ["terminal"]),
			compact: vi.fn(async (_input: unknown) => ({ messages: [], tokensBefore: 100, tokensAfter: 10 })),
		},
		turn: { abort: vi.fn(async (_input: unknown) => {}) },
		ui: { log: vi.fn() },
	};
	const source = createBridgePluginSource({ url: URL, token });
	const register = runInNewContext(`${source.replace("export function register", "function register")}\nregister`, {});
	register((name: string, hook: Hook) => {
		hooks.set(name, hook);
		return { catch: (handler: Hook) => catches.set(name, handler) };
	});
	return {
		$,
		hooks,
		catches,
		requests,
		timers,
		source,
		respond(fn: typeof responder) {
			responder = fn;
		},
		events(): any[] {
			return requests
				.filter(({ init }) => init.method === "POST")
				.flatMap(({ init }) => {
					const message = JSON.parse(init.body);
					return message.type === "batch" ? message.events : [message];
				});
		},
		async timer(ms: number) {
			const index = timers.findIndex((timer) => !timer.cancelled && timer.ms === ms);
			expect(index).toBeGreaterThanOrEqual(0);
			const timer = timers.splice(index, 1)[0];
			await timer.callback();
		},
		async start() {
			const input = { cwd: "C:\\fixture", surface: "terminal", isInteractive: true };
			const result = { cwd: input.cwd };
			expect(await hooks.get("session.start")!($, input, async () => result)).toBe(result);
			await this.timer(0);
		},
	};
}

function stream(chunks: readonly unknown[], result: unknown) {
	const iterator = (async function* () {
		for (const chunk of chunks) yield chunk;
		return result;
	})();
	return Object.assign(iterator, { result: Promise.resolve(result) });
}

async function collect(iterator: AsyncGenerator<unknown, unknown>) {
	const chunks: unknown[] = [];
	for (;;) {
		const item = await iterator.next();
		if (item.done) return { chunks, result: item.value };
		chunks.push(item.value);
	}
}

const step = { turnId: "turn-1", index: 0, model: "fixture", messageCount: 1 };
const result = { turnId: step.turnId, index: 0, answer: "ok", toolUses: [], stopReason: "end_turn", usage: null };

describe("Claude Code Mod bridge source", () => {
	it("exports the minimal official layout and embeds quoted configuration as data", async () => {
		expect(BRIDGE_PLUGIN_MANIFEST.name).toBe("myharness-bridge");
		expect(BRIDGE_PLUGIN_HOOKS).toEqual({ modules: ["./register.js"] });
		const f = fixture();
		await f.start();
		expect(f.requests[0].url).toBe(URL);
		expect(f.requests[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(f.source).not.toMatch(/require\(|process\.|node:|\.llm\./);
		expect(f.source).not.toContain("$.prompt.submit");
	});

	it("rejects non-loopback URLs, extra URL components and malformed tokens", () => {
		for (const url of [
			"https://127.0.0.1:123/bridge/x",
			"http://example.com:123/bridge/x",
			`${URL}?x=1`,
			`${URL}/extra`,
		]) {
			expect(() => createBridgePluginSource({ url, token: TOKEN })).toThrow();
		}
		for (const token of ["", "bad\r\ntoken"]) expect(() => createBridgePluginSource({ url: URL, token })).toThrow();
	});

	it("sends ready only after session.start finishes and reads the real session id", async () => {
		const f = fixture();
		const next = vi.fn(async () => ({ cwd: "fixture" }));
		await f.hooks.get("session.start")!(f.$, {}, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(f.requests).toHaveLength(0);
		await f.timer(0);
		expect(f.events()).toEqual([
			{
				type: "ready",
				sessionId: "real-cli-session-id",
				version: { version: "2.1.317" },
				surfaces: ["terminal"],
				seq: 1,
			},
		]);
	});

	it("preserves chunk identity/order and the final generator result including usage", async () => {
		const f = fixture();
		const chunks = [
			{ kind: "engine", ref: 9 },
			{ kind: "thinking", index: 0, text: "thought" },
			{ kind: "text", index: 1, text: "ok" },
			{ kind: "tool", index: 2, id: "call-1", name: "mcp__myharness__read" },
			{ kind: "input", index: 2, json: '{"path":"file"}' },
			{ kind: "stop", stopReason: "tool_use", usage: { inputTokens: 12 } },
		];
		const final = { ...result, stopReason: "tool_use", usage: { inputTokens: 12, outputTokens: 3 } };
		const next = vi.fn(() => stream(chunks, final));
		const out = await collect(f.hooks.get("turn.step")!(f.$, step, next));
		expect(out.result).toBe(final);
		out.chunks.forEach((chunk, index) => {
			expect(chunk).toBe(chunks[index]);
		});
		expect(next).toHaveBeenCalledWith(step);
		expect(next).toHaveBeenCalledTimes(1);
		expect(f.events().map((event) => event.type)).toEqual(["step_start", ...chunks.map(() => "chunk"), "step_end"]);
		expect(f.events().at(-1).result).toEqual(final);
		expect(f.events().map((event) => event.seq)).toEqual(chunks.map((_, i) => i + 1).concat([7, 8]));
	});

	it("batches tiny chunks with bounded backpressure rather than one POST per character", async () => {
		const f = fixture();
		const chunks = Array.from({ length: 100 }, () => ({ kind: "text", index: 0, text: "x" }));
		await collect(f.hooks.get("turn.step")!(f.$, step, () => stream(chunks, result)));
		expect(f.events()).toHaveLength(102);
		expect(f.requests.length).toBeLessThan(10);
		for (const { init } of f.requests) {
			const message = JSON.parse(init.body);
			if (message.type === "batch") expect(message.events.length).toBeLessThanOrEqual(32);
		}
	});

	it("flushes stop/max_tokens before yielding it or consuming a following item", async () => {
		const f = fixture();
		const stop = { kind: "stop", stopReason: "max_tokens", usage: null };
		const out = f.hooks.get("turn.step")!(f.$, step, () => stream([stop], result));
		const item = await out.next();
		expect(item.value).toBe(stop);
		expect(f.events().at(-1).chunk).toEqual(stop);
		await out.next();
	});

	it("nonce-rewrites text/context but keeps typed origin, attachments and wait untouched", async () => {
		const f = fixture();
		const nonce = "0123456789abcdef0123456789abcdef";
		const text = `prefix\u0003\r\n${"long text".repeat(8000)}`;
		f.respond(async (url) => ({
			ok: true,
			status: 200,
			headers: {},
			text: url.endsWith(`/input/${nonce}`) ? JSON.stringify({ text, context: ["from host"] }) : "{}",
		}));
		const origin = Object.freeze({ kind: "typed" });
		const attachments = Object.freeze([{ type: "image", mediaType: "image/png", filename: "fixture.png" }]);
		const e = Object.freeze({
			text: `MYHARNESS_INPUT_${nonce}`,
			origin,
			attachments,
			wait: false,
			context: ["existing"],
		});
		const next = vi.fn(async (event) => ({ text: event.text, origin: event.origin }));
		await f.hooks.get("prompt.submit")!(f.$, e, next);
		const forwarded = next.mock.calls[0][0];
		expect(forwarded.text).toBe(text);
		expect(forwarded.context).toEqual(["existing", "from host"]);
		expect(forwarded.origin).toBe(origin);
		expect(forwarded.attachments).toBe(attachments);
		expect(forwarded.wait).toBe(false);
		expect(e.text).toBe(`MYHARNESS_INPUT_${nonce}`);
		expect(f.events()).toEqual([{ seq: 1, type: "prompt_accepted", nonce }]);
		expect(
			f.requests.filter(({ init }) => init.method === "POST").every(({ init }) => !init.body.includes("long text")),
		).toBe(true);
	});

	it("passes ordinary typed input unchanged without any fetch", async () => {
		const f = fixture();
		const e = Object.freeze({ text: "ordinary", origin: { kind: "typed" }, wait: false });
		const next = vi.fn(async () => ({ text: e.text }));
		await f.hooks.get("prompt.submit")!(f.$, e, next);
		expect(next).toHaveBeenCalledWith(e);
		expect(f.requests).toHaveLength(0);
	});

	it("normalizes flat MCP arguments, observes exactly once and returns the original result", async () => {
		const f = fixture();
		await f.hooks.get("turn.start")!(f.$, { turnId: "turn-1", text: "hidden" }, async () => ({ turnId: "turn-1" }));
		const e = Object.freeze({
			tool: "mcp__myharness__read",
			tool_use_id: "call-1",
			path: "file",
			input: { nested: true },
		});
		const toolResult = Object.freeze({ ref: 1, result: "content", text: "content" });
		const next = vi.fn(async () => toolResult);
		expect(await f.hooks.get("tool.call")!(f.$, e, next)).toBe(toolResult);
		expect(next).toHaveBeenCalledWith(e);
		expect(next).toHaveBeenCalledTimes(1);
		expect(f.events().find((event) => event.type === "tool_start").event).toEqual({
			id: "call-1",
			name: e.tool,
			turnId: "turn-1",
			input: { path: "file", input: { nested: true } },
		});
		expect(f.events().at(-1).event.result).toEqual(toolResult);
	});

	it("serializes identical parallel tools so each next sees exactly its own observed ID", async () => {
		const f = fixture();
		const hook = f.hooks.get("tool.call")!;
		let releaseFirst!: () => void;
		let firstEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		const firstFinished = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstNext = vi.fn(async () => {
			firstEntered();
			await firstFinished;
			return { result: "first" };
		});
		const secondNext = vi.fn(async () => ({ result: "second" }));
		const first = { tool: "mcp__myharness__read", tool_use_id: "id-1", path: "same" };
		const second = { ...first, tool_use_id: "id-2" };
		const firstCall = hook(f.$, first, firstNext);
		const secondCall = hook(f.$, second, secondNext);
		await entered;
		expect(firstNext).toHaveBeenCalledTimes(1);
		expect(secondNext).not.toHaveBeenCalled();
		expect(f.events().map((event) => [event.type, event.event.id])).toEqual([["tool_start", "id-1"]]);
		releaseFirst();
		expect(await firstCall).toEqual({ result: "first" });
		expect(await secondCall).toEqual({ result: "second" });
		expect(secondNext).toHaveBeenCalledTimes(1);
		expect(f.events().map((event) => [event.type, event.event.id])).toEqual([
			["tool_start", "id-1"],
			["tool_end", "id-1"],
			["tool_start", "id-2"],
			["tool_end", "id-2"],
		]);
	});

	it("releases the serialized queue when a downstream tool throws", async () => {
		const f = fixture();
		const hook = f.hooks.get("tool.call")!;
		let rejectFirst!: (error: Error) => void;
		let firstEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		const pending = new Promise<never>((_, reject) => {
			rejectFirst = reject;
		});
		const firstNext = vi.fn(async () => {
			firstEntered();
			return pending;
		});
		const secondNext = vi.fn(async () => ({ result: "ok" }));
		const first = { tool: "mcp__myharness__read", tool_use_id: "id-1", path: "same" };
		const second = { ...first, tool_use_id: "id-2" };
		const firstCall = hook(f.$, first, firstNext);
		const firstRejection = expect(firstCall).rejects.toThrow("downstream failed");
		const secondCall = hook(f.$, second, secondNext);
		await entered;
		expect(secondNext).not.toHaveBeenCalled();
		rejectFirst(new Error("downstream failed"));
		await firstRejection;
		expect(await secondCall).toEqual({ result: "ok" });
		expect(secondNext).toHaveBeenCalledTimes(1);
	});

	it("stops unsupported native tools but leaves EndConversation lifecycle alone", async () => {
		const f = fixture();
		await f.hooks.get("turn.start")!(f.$, { turnId: "turn-1" }, async () => ({}));
		const next = vi.fn(async () => ({ result: "should not run" }));
		const answer = await f.hooks.get("tool.call")!(f.$, { tool: "Bash", tool_use_id: "id", command: "exit" }, next);
		expect(answer.deny).toContain("MyHarness MCP");
		expect(next).not.toHaveBeenCalled();
		expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: "turn-1" });
		const lifecycle = fixture();
		const end = vi.fn(async () => ({ result: "ended" }));
		await lifecycle.hooks.get("tool.call")!(lifecycle.$, { tool: "EndConversation", tool_use_id: "end" }, end);
		expect(end).toHaveBeenCalledTimes(1);
	});

	it("aborts on HTTP failure and its tool catch never runs the tool as recovery", async () => {
		const f = fixture();
		await f.hooks.get("turn.start")!(f.$, { turnId: "turn-1" }, async () => ({}));
		f.respond(async () => ({ ok: false, status: 503, text: "", headers: {} }));
		const next = vi.fn();
		const e = { tool: "mcp__myharness__read", tool_use_id: "id", path: "file" };
		await expect(f.hooks.get("tool.call")!(f.$, e, next)).rejects.toThrow("503");
		expect(next).not.toHaveBeenCalled();
		expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: "turn-1" });
		const caught = await f.catches.get("tool.call")!(f.$, e, next);
		expect(caught.deny).toContain("bridge failed");
		expect(next).not.toHaveBeenCalled();
	});

	it("fails malformed input closed, without submitting the nonce or replacement text", async () => {
		const f = fixture();
		f.respond(async () => ({ ok: true, status: 200, headers: {}, text: '{"text":1}' }));
		const e = { text: "MYHARNESS_INPUT_0123456789abcdef0123456789abcdef" };
		const next = vi.fn();
		await expect(f.hooks.get("prompt.submit")!(f.$, e, next)).rejects.toThrow("Invalid bridge input");
		const caught = await f.catches.get("prompt.submit")!(f.$, e, next);
		expect(caught.drop).toContain("not submitted");
		expect(next).not.toHaveBeenCalled();
	});

	it("polls controls serially and reports both successful operations and command errors", async () => {
		const f = fixture();
		await f.start();
		f.respond(async (url) => ({
			ok: true,
			status: 200,
			headers: {},
			text: url.endsWith("/commands")
				? JSON.stringify({
						commands: [
							{ id: "cancel", type: "cancel", turnId: "turn-1" },
							{ id: "compact", type: "compact", instructions: "keep paths" },
							{ id: "unknown", type: "prompt", text: "not allowed" },
						],
					})
				: "{}",
		}));
		await f.timer(0);
		expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: "turn-1" });
		expect(f.$.session.compact).toHaveBeenCalledWith({ instructions: "keep paths" });
		const replies = f.events().filter((event) => event.type === "control_result");
		expect(replies.map((event) => event.id)).toEqual(["cancel", "compact", "unknown"]);
		expect(replies[2].error).toContain("Unsupported");
		expect(f.timers.some((timer) => !timer.cancelled && timer.ms >= 250)).toBe(true);
	});

	it("drops engine prose but passes managed-hook and prompt context attachments unchanged", async () => {
		const f = fixture();
		const hook = f.hooks.get("prompt.attachment")!;
		const next = vi.fn(async (event) => ({ text: event.text }));
		const engine = Object.freeze({ type: "todo_reminder", text: "engine", origin: { kind: "engine" } });
		expect(await hook(f.$, engine, next)).toEqual({ text: null });
		expect(next).not.toHaveBeenCalled();
		for (const origin of [
			{ kind: "hook", event: "UserPromptSubmit" },
			{ kind: "plugin", event: "prompt.submit" },
		]) {
			const event = Object.freeze({ type: "instructions", text: "keep", origin });
			expect(await hook(f.$, event, next)).toEqual({ text: "keep" });
			expect(next).toHaveBeenLastCalledWith(event);
		}
	});

	it("reports a failed commands poll once and stops subsequent inputs", async () => {
		const f = fixture();
		await f.start();
		await f.hooks.get("turn.start")!(f.$, { turnId: "turn-1" }, async () => ({}));
		f.respond(async (url) => ({
			ok: !url.endsWith("/commands"),
			status: url.endsWith("/commands") ? 503 : 200,
			text: "{}",
			headers: {},
		}));
		await expect(f.timer(0)).rejects.toThrow("503");
		const errors = f.events().filter((event) => event.type === "bridge_error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ turnId: "turn-1", error: expect.stringContaining("503") });
		expect(f.events().map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(f.$.turn.abort).toHaveBeenCalledWith({ turnId: "turn-1" });
		const next = vi.fn();
		const prompt = { text: "ordinary" };
		await expect(f.hooks.get("prompt.submit")!(f.$, prompt, next)).rejects.toThrow("503");
		await f.catches.get("prompt.submit")!(f.$, prompt, next);
		expect(next).not.toHaveBeenCalled();
		expect(f.events().filter((event) => event.type === "bridge_error")).toHaveLength(1);
	});

	it("reports a failed input GET without including its nonce or prompt text", async () => {
		const f = fixture();
		f.respond(async (url) => ({
			ok: !url.includes("/input/"),
			status: url.includes("/input/") ? 404 : 200,
			text: "{}",
			headers: {},
		}));
		const nonce = "0123456789abcdef0123456789abcdef";
		const next = vi.fn();
		await expect(f.hooks.get("prompt.submit")!(f.$, { text: `MYHARNESS_INPUT_${nonce}` }, next)).rejects.toThrow(
			"404",
		);
		expect(f.events()).toEqual([{ seq: 1, type: "bridge_error", error: expect.stringContaining("404") }]);
		expect(JSON.stringify(f.events())).not.toContain(nonce);
		expect(next).not.toHaveBeenCalled();
	});

	it("forwards turn.complete and session.measure flat and leaves their results untouched", async () => {
		const f = fixture();
		const complete = { turnId: "turn-1", answer: "ok", durationMs: 10, reason: "answer", isAborted: false };
		const measure = { trigger: "turn", tokens: 123 };
		const returned = Object.freeze({ text: "ok" });
		expect(await f.hooks.get("turn.complete")!(f.$, complete, async () => returned)).toBe(returned);
		expect(await f.hooks.get("session.measure")!(f.$, measure, async () => returned)).toBe(returned);
		expect(f.events()).toEqual([
			{ ...complete, type: "turn_end", seq: 1 },
			{ ...measure, type: "measure", seq: 2 },
		]);
	});
});
