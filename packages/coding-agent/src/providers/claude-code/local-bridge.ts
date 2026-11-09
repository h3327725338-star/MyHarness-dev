import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Tool, ToolCall, ToolResultMessage } from "@myharness/ai";
import { APP_TOOL_TIMEOUT_MS } from "./config.ts";
import { stableJson } from "./history.ts";

export interface BridgeEvent {
	type: string;
	seq: number;
	[key: string]: unknown;
}
export interface BridgeCommand {
	id: string;
	type: "cancel" | "compact";
	turnId?: string;
	instructions?: string;
}
export interface PendingInput {
	text: string;
	context?: string[];
}
export type HostToolHandler = (tool: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;

function respond(response: ServerResponse, status: number, value?: unknown): void {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
	response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function readBody(request: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
	const buffers: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += data.length;
		if (bytes > maxBytes) throw new Error("Local bridge body limit exceeded");
		buffers.push(data);
	}
	return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}

export class EventQueue {
	private events: BridgeEvent[] = [];
	private pending?: { resolve: (event: BridgeEvent) => void; reject: (error: Error) => void };
	private failure?: Error;
	push(event: BridgeEvent): void {
		if (this.failure) return;
		if (this.pending) {
			const pending = this.pending;
			this.pending = undefined;
			pending.resolve(event);
		} else if (this.events.length >= 8192) this.fail(new Error("Claude Code bridge event queue overflow"));
		else this.events.push(event);
	}
	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.events = [];
		this.pending?.reject(error);
		this.pending = undefined;
	}
	next(signal?: AbortSignal, timeoutMs = 60_000): Promise<BridgeEvent> {
		if (this.failure) return Promise.reject(this.failure);
		if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
		const event = this.events.shift();
		if (event) return Promise.resolve(event);
		if (this.pending) return Promise.reject(new Error("Bridge queue already has a consumer"));
		return new Promise((resolve, reject) => {
			const finish = (event?: BridgeEvent, error?: Error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.pending = undefined;
				if (error) reject(error);
				else resolve(event!);
			};
			const abort = () => finish(undefined, new Error("Operation aborted"));
			const timer = setTimeout(() => finish(undefined, new Error("Claude Code Mod bridge timed out")), timeoutMs);
			this.pending = { resolve: (value) => finish(value), reject: (error) => finish(undefined, error) };
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
}

/** One listener and one random credential per PTY, never a process-wide tool dispatcher. */
export class LocalBridge {
	readonly events = new EventQueue();
	readonly instance = randomUUID();
	readonly token = randomBytes(32).toString("hex");
	url = "";
	private server?: Server;
	private sequence = 0;
	private commands: BridgeCommand[] = [];
	private poll?: ServerResponse;
	private pollTimer?: ReturnType<typeof setTimeout>;
	private inputs = new Map<string, PendingInput>();
	private calls = new Map<string, { name: string; arguments: Record<string, unknown>; claimed: boolean }>();
	private abort = new AbortController();
	private toolHandler?: HostToolHandler;
	private tools: Tool[] = [];
	private active = false;
	private toolTail: Promise<unknown> = Promise.resolve();
	private connections = new Set<ServerResponse>();

	async drainTools(): Promise<void> {
		await this.toolTail;
	}

	configureTools(tools: Tool[]): void {
		this.tools = tools;
	}
	setTurn(tools: Tool[], handler: HostToolHandler | undefined, signal?: AbortSignal): () => void {
		if (this.active) throw new Error("A Claude Code turn is already active");
		this.active = true;
		this.tools = tools;
		this.toolHandler = handler;
		this.abort = new AbortController();
		this.calls.clear();
		const abort = () => this.abort.abort();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		return () => {
			signal?.removeEventListener("abort", abort);
			this.abort.abort();
			this.active = false;
			this.toolHandler = undefined;
			this.calls.clear();
			this.inputs.clear();
		};
	}
	addInput(input: PendingInput): string {
		const nonce = randomBytes(16).toString("hex");
		this.inputs.set(nonce, input);
		return nonce;
	}
	command(type: BridgeCommand["type"], extra: Omit<BridgeCommand, "id" | "type"> = {}): string {
		const id = randomUUID();
		this.commands.push({ id, type, ...extra });
		this.flushPoll();
		return id;
	}
	private flushPoll(): void {
		if (!this.poll || !this.commands.length) return;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		respond(this.poll, 200, { commands: this.commands.splice(0, 32) });
		this.poll = undefined;
	}
	private receive(event: BridgeEvent): void {
		if (!Number.isSafeInteger(event.seq) || event.seq !== this.sequence + 1 || typeof event.type !== "string") {
			const error = new Error("Claude Code bridge sequence is discontinuous");
			this.events.fail(error);
			this.abort.abort();
			throw error;
		}
		this.sequence = event.seq;
		// tool.call is observed before next(e); its exact identity is available before the MCP POST.
		if (event.type === "tool_start") {
			const input = (event.event || event.input || event) as Record<string, unknown>;
			const id = String(input.tool_use_id || input.toolUseId || input.id || "");
			const name = String(input.tool || input.name || "");
			const args = input.input ?? input.arguments ?? input.params;
			if (id && name && !input.agentId && args && typeof args === "object" && !Array.isArray(args)) {
				if (this.calls.has(id)) throw new Error("Duplicate Claude Code tool call id");
				this.calls.set(id, { name, arguments: args as Record<string, unknown>, claimed: false });
			}
		}
		this.events.push(event);
	}
	async listen(): Promise<void> {
		this.server = createServer((request, response) => {
			this.connections.add(response);
			response.once("close", () => this.connections.delete(response));
			void this.handle(request, response).catch(() =>
				respond(response, 400, { error: "Invalid local bridge request" }),
			);
		});
		this.server.requestTimeout = APP_TOOL_TIMEOUT_MS;
		this.server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(0, "127.0.0.1", () => {
				this.server!.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Local bridge did not bind TCP");
		this.url = `http://127.0.0.1:${address.port}/bridge/${this.instance}`;
		this.server.unref();
	}
	private authenticated(request: IncomingMessage): boolean {
		const supplied = Buffer.from(request.headers.authorization || "");
		const expected = Buffer.from(`Bearer ${this.token}`);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.authenticated(request) || request.headers.origin) {
			respond(response, 403);
			return;
		}
		const address = this.server?.address();
		if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
			respond(response, 403);
			return;
		}
		const base = `/bridge/${this.instance}`;
		const pathname = request.url?.split("?")[0];
		if (request.method === "GET" && pathname === `${base}/commands`) {
			this.events.push({ type: "heartbeat", seq: 0 });
			if (this.poll) {
				respond(response, 409);
				return;
			}
			this.poll = response;
			this.pollTimer = setTimeout(() => {
				if (this.poll === response) this.poll = undefined;
				respond(response, 204);
			}, 18_000);
			response.once("close", () => {
				if (this.poll === response) {
					this.poll = undefined;
					if (this.pollTimer) clearTimeout(this.pollTimer);
				}
			});
			this.flushPoll();
			return;
		}
		if (request.method === "GET" && pathname?.startsWith(`${base}/input/`)) {
			const nonce = pathname.slice(`${base}/input/`.length);
			const input = this.inputs.get(nonce);
			if (!input) {
				respond(response, 404);
				return;
			}
			this.inputs.delete(nonce);
			respond(response, 200, input);
			return;
		}
		if (request.method !== "POST") {
			respond(response, 405);
			return;
		}
		const body = (await readBody(request)) as Record<string, unknown>;
		if (pathname === base) {
			if (body.type === "batch" && Array.isArray(body.events)) {
				if (body.events.length > 256) throw new Error("Event batch too large");
				for (const item of body.events) this.receive(item as BridgeEvent);
			} else this.receive(body as BridgeEvent);
			respond(response, 200, { ok: true });
			return;
		}
		if (pathname !== `${base}/mcp`) {
			respond(response, 404);
			return;
		}
		const id = body.id;
		const reply = (result: unknown) => respond(response, 200, { jsonrpc: "2.0", id, result });
		const rpcError = (code: number, message: string) =>
			respond(response, 200, { jsonrpc: "2.0", id, error: { code, message } });
		if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
			rpcError(-32600, "Invalid request");
			return;
		}
		if (id === undefined) {
			respond(response, 202);
			return;
		}
		if (body.method === "initialize") {
			const params = body.params as Record<string, unknown> | undefined;
			reply({
				protocolVersion: params?.protocolVersion || "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "myharness", version: "1.0.0" },
			});
		} else if (body.method === "ping") reply({});
		else if (body.method === "tools/list")
			reply({
				tools: this.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.parameters,
				})),
			});
		else if (body.method === "tools/call") {
			const params = body.params as Record<string, unknown> | undefined;
			const name = String(params?.name || "");
			const meta = params?._meta as Record<string, unknown> | undefined;
			const callId =
				typeof meta?.["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : undefined;
			const argumentsKey = stableJson(params?.arguments || {});
			const candidates = [...this.calls].filter(
				([key, call]) =>
					(!callId || key === callId) &&
					call.name === `mcp__myharness__${name}` &&
					!call.claimed &&
					(callId || stableJson(call.arguments) === argumentsKey),
			);
			const match = candidates.length === 1 ? candidates[0] : undefined;
			if (match && stableJson(match[1].arguments) !== stableJson(params?.arguments || {})) {
				rpcError(-32602, "Tool arguments differ from the observed Mod call");
				return;
			}
			if (
				!this.active ||
				this.abort.signal.aborted ||
				!this.toolHandler ||
				!this.tools.some((tool) => tool.name === name) ||
				!match
			) {
				reply({
					isError: true,
					content: [
						{ type: "text", text: "Host tool call has no unique active Mod identity, or the turn ended." },
					],
				});
				return;
			}
			const [toolId, call] = match;
			call.claimed = true;
			const signal = this.abort.signal;
			let onAbort: (() => void) | undefined;
			const cancel = new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Host tool cancelled"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});
			const handler = this.toolHandler;
			const execution = this.toolTail.then(async () => {
				if (signal.aborted || !this.active) throw new Error("Host tool cancelled");
				return handler({ type: "toolCall", id: toolId, name, arguments: call.arguments }, signal);
			});
			// Cancellation releases the HTTP response promptly; it does not pretend the host handler has stopped.
			// Keeping the actual execution as the tail preserves host tool serialization through turn boundaries.
			this.toolTail = execution.catch(() => undefined);
			try {
				const result = await Promise.race([execution, cancel]);
				reply({
					isError: result.isError,
					content: result.content.map((part) =>
						part.type === "image"
							? { type: "image", data: part.data, mimeType: part.mimeType }
							: { type: "text", text: part.text },
					),
				});
			} catch {
				reply({
					isError: true,
					content: [
						{ type: "text", text: "Host tool execution failed or was cancelled. See MyHarness tool result." },
					],
				});
			} finally {
				if (onAbort) signal.removeEventListener("abort", onAbort);
			}
		} else rpcError(-32601, "Method not found");
	}
	async close(error = new Error("Claude Code bridge closed")): Promise<void> {
		this.abort.abort();
		this.active = false;
		this.events.fail(error);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		for (const response of this.connections) respond(response, 503);
		const server = this.server;
		this.server = undefined;
		if (server)
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
	}
}
