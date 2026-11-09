import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model, Tool, ToolCall, ToolResultMessage } from "@myharness/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InteractiveTerminal, PtyFactory } from "../src/providers/claude-code/interactive-session.ts";
import type { BridgeEvent } from "../src/providers/claude-code/local-bridge.ts";
import { LocalBridge } from "../src/providers/claude-code/local-bridge.ts";
import { ClaudeCodeRuntime } from "../src/providers/claude-code/runtime.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { createWriteToolDefinition } from "../src/tools/files/write.ts";
import { createPwshToolDefinition } from "../src/tools/shell/pwsh.ts";
import { createSubAgentToolDefinition } from "../src/tools/sub-agent.ts";

const MODEL: Model<any> = {
	id: "claude-sonnet-fixture",
	name: "Claude Code fixture",
	api: "claude-code-cli",
	provider: "claude-code",
	baseUrl: "claude-code://interactive",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 300_000,
	maxTokens: 1_000,
};

function hostTools(cwd: string): Tool[] {
	return [
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createSubAgentToolDefinition(cwd),
		createPwshToolDefinition(cwd),
	].map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

function userTextBlock(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

interface FakePlan {
	kind?: "basic" | "multi" | "mcp-image" | "mcp-cancel" | "mcp-overlap" | "helper" | "max-tokens";
	failResume?: boolean;
	onInput?: (text: string) => void;
	win32Input?: boolean;
}

interface FakeRequest {
	method: string;
	url: string;
	body?: unknown;
	status?: number;
}

class FakeInstance implements InteractiveTerminal {
	readonly pid = 0;
	readonly args: string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly promptFile: string;
	readonly mcpFile: string;
	readonly pluginDirectory: string;
	readonly prompt: string;
	readonly mcpConfig: any;
	readonly settings: any;
	readonly resume: boolean;
	readonly sessionArgument: string;
	readonly bridgeUrl: string;
	readonly token: string;
	readonly plan: FakePlan;
	readonly inputs: string[] = [];
	readonly requests: FakeRequest[] = [];
	readonly mcpResponses: any[] = [];
	readonly sentEvents: BridgeEvent[] = [];
	readonly errors: unknown[] = [];
	killed = false;
	started = false;
	cancelled = false;
	private sequence = 0;
	private nonce = "";
	private pendingInput = "";
	private turnId = "";
	private readonly exitCallbacks = new Set<(event: { exitCode: number; signal?: number }) => void>();
	private readonly dataCallbacks = new Set<(data: string) => void>();
	private readonly pollAbort = new AbortController();
	private readonly harness: FakePtyHarness;

	constructor(
		harness: FakePtyHarness,
		executable: string,
		args: string[],
		options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
		plan: FakePlan,
	) {
		this.harness = harness;
		this.args = [executable, ...args];
		this.cwd = options.cwd;
		this.env = options.env;
		this.plan = plan;
		this.promptFile = this.value("--system-prompt-file");
		this.mcpFile = this.value("--mcp-config");
		this.pluginDirectory = this.value("--plugin-dir");
		this.prompt = readFileSync(this.promptFile, "utf8");
		this.mcpConfig = JSON.parse(readFileSync(this.mcpFile, "utf8"));
		this.settings = JSON.parse(readFileSync(this.value("--settings"), "utf8"));
		this.resume = this.args.includes("--resume");
		this.sessionArgument = this.resume ? this.value("--resume") : this.value("--session-id");
		const source = readFileSync(join(this.pluginDirectory, "hooks", "register.js"), "utf8");
		const match = /^const CONFIG = (.*);$/m.exec(source);
		if (!match) throw new Error("Fake PTY could not read bridge plugin config");
		const config = JSON.parse(match[1]) as { url: string; token: string };
		this.bridgeUrl = config.url;
		this.token = config.token;
		this.harness.instances.push(this);
		queueMicrotask(() => void this.start().catch((error) => this.errors.push(error)));
	}

	private value(name: string): string {
		const index = this.args.indexOf(name);
		return index >= 0 ? this.args[index + 1] || "" : "";
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
	}

	private async start(): Promise<void> {
		if (this.plan.failResume && this.resume) {
			queueMicrotask(() => {
				this.exitCallbacks.forEach((callback) => {
					callback({ exitCode: 17 });
				});
			});
			return;
		}
		this.started = true;
		if (this.plan.win32Input)
			this.dataCallbacks.forEach((callback) => {
				callback("\u001b[?9001h");
			});
		await this.send({ type: "ready", sessionId: this.sessionArgument, surfaces: ["terminal"] });
		void this.poll();
	}

	private async poll(): Promise<void> {
		while (!this.killed) {
			try {
				const response = await fetch(`${this.bridgeUrl}/commands`, {
					headers: this.headers(),
					signal: this.pollAbort.signal,
				});
				if (response.status === 204) continue;
				if (!response.ok) return;
				const body = (await response.json()) as { commands?: { id: string; type: string; turnId?: string }[] };
				for (const command of body.commands || []) {
					if (command.type === "cancel") {
						this.cancelled = true;
						await this.send({ type: "control_result", id: command.id, result: {} });
					}
				}
			} catch {
				return;
			}
		}
	}

	private async request(path: string, init: RequestInit): Promise<any> {
		const response = await fetch(`${this.bridgeUrl}${path}`, init);
		let body: unknown;
		const text = await response.text();
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = text;
		}
		this.requests.push({ method: init.method || "GET", url: path, body, status: response.status });
		return { response, body };
	}

	async mcpRequest(method: string, params: unknown): Promise<any> {
		const result = await this.request("/mcp", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ jsonrpc: "2.0", id: this.requests.length + 1, method, params }),
		});
		return result.body;
	}

	async send(event: Omit<BridgeEvent, "seq"> & { seq?: number }): Promise<void> {
		const next = this.sequence + 1;
		const seq = event.seq ?? next;
		this.sequence = next;
		const message = { ...event, seq } as BridgeEvent;
		this.sentEvents.push(message);
		const result = await this.request("", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(message),
		});
		if (result.response.status >= 400) throw new Error(`Bridge event status ${result.response.status}`);
	}

	private async accepted(): Promise<void> {
		await this.send({ type: "prompt_accepted", nonce: this.nonce, turnId: this.turnId });
	}

	private async standard(steps: { thinking?: string; text?: string }[]): Promise<void> {
		this.turnId = `${this.sessionArgument}-turn-${this.inputs.length}`;
		await this.accepted();
		await this.send({ type: "turn_start", turnId: this.turnId });
		for (const [index, step] of steps.entries()) {
			await this.send({ type: "step_start", turnId: this.turnId, index });
			if (step.thinking)
				await this.send({
					type: "chunk",
					turnId: this.turnId,
					index,
					chunk: { kind: "thinking", index: 0, text: step.thinking },
				});
			if (step.text)
				await this.send({
					type: "chunk",
					turnId: this.turnId,
					index,
					chunk: { kind: "text", index: 0, text: step.text },
				});
			await this.send({
				type: "step_end",
				turnId: this.turnId,
				index,
				result: { stopReason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } },
			});
		}
		await this.send({ type: "turn_end", turnId: this.turnId, reason: "answer", isAborted: false });
	}

	private async mcpTurn(cancel: boolean): Promise<void> {
		this.turnId = `${this.sessionArgument}-mcp-${this.inputs.length}`;
		await this.accepted();
		await this.send({ type: "turn_start", turnId: this.turnId });
		await this.send({ type: "step_start", turnId: this.turnId, index: 0 });
		const initialize = await this.mcpRequest("initialize", { protocolVersion: "2024-11-05" });
		const listed = await this.mcpRequest("tools/list", {});
		this.mcpResponses.push({ initialize, listed });
		const callId = `${this.sessionArgument}-call-${this.inputs.length}`;
		await this.send({
			type: "tool_start",
			event: { id: callId, name: "mcp__myharness__read", input: { path: "fixture" } },
		});
		const call = await this.mcpRequest("tools/call", {
			name: "read",
			arguments: { path: "fixture" },
			_meta: { "claudecode/toolUseId": callId },
		});
		this.mcpResponses.push({ call });
		if (cancel) return;
		await this.send({
			type: "tool_end",
			event: { id: callId, name: "mcp__myharness__read", input: { path: "fixture" }, result: call },
		});
		await this.send({
			type: "chunk",
			turnId: this.turnId,
			index: 0,
			chunk: { kind: "text", index: 0, text: "tool complete" },
		});
		await this.send({
			type: "step_end",
			turnId: this.turnId,
			index: 0,
			result: { stopReason: "end_turn", usage: { input_tokens: 4, output_tokens: 4 } },
		});
		await this.send({ type: "turn_end", turnId: this.turnId, reason: "answer", isAborted: false });
	}

	private async mcpOverlapTurn(): Promise<void> {
		this.turnId = `${this.sessionArgument}-overlap-${this.inputs.length}`;
		await this.accepted();
		await this.send({ type: "turn_start", turnId: this.turnId });
		await this.send({ type: "step_start", turnId: this.turnId, index: 0 });
		const callA = `${this.sessionArgument}-same-a`;
		const callB = `${this.sessionArgument}-same-b`;
		await this.send({ type: "tool_start", event: { id: callA, name: "mcp__myharness__read", input: { path: "A" } } });
		await this.send({ type: "tool_start", event: { id: callB, name: "mcp__myharness__read", input: { path: "B" } } });
		const [a, b] = await Promise.all([
			this.mcpRequest("tools/call", {
				name: "read",
				arguments: { path: "A" },
				_meta: { "claudecode/toolUseId": callA },
			}),
			this.mcpRequest("tools/call", { name: "read", arguments: { path: "B" } }),
		]);
		this.mcpResponses.push({ overlap: [a, b] });
		await this.send({
			type: "step_end",
			turnId: this.turnId,
			index: 0,
			result: { stopReason: "end_turn", usage: { input_tokens: 2, output_tokens: 2 } },
		});
		await this.send({ type: "turn_end", turnId: this.turnId, reason: "answer", isAborted: false });
	}

	private async respond(text: string): Promise<void> {
		switch (this.plan.kind || "basic") {
			case "multi":
				return this.standard([
					{ thinking: "first thought", text: "hello " },
					{ thinking: "second thought", text },
				]);
			case "mcp-image":
				return this.mcpTurn(false);
			case "mcp-cancel":
				return this.mcpTurn(true);
			case "mcp-overlap":
				return this.mcpOverlapTurn();
			case "helper":
				this.turnId = `${this.sessionArgument}-helper-${this.inputs.length}`;
				await this.accepted();
				await this.send({ type: "turn_start", turnId: this.turnId });
				await this.send({ type: "step_start", turnId: this.turnId, index: 0, agentId: "native-helper" });
				await this.send({
					type: "chunk",
					turnId: this.turnId,
					index: 0,
					agentId: "native-helper",
					chunk: { kind: "text", index: 0, text: "helper leak" },
				});
				await this.send({
					type: "step_end",
					turnId: this.turnId,
					index: 0,
					agentId: "native-helper",
					result: { usage: { input_tokens: 99 } },
				});
				await this.send({ type: "step_start", turnId: this.turnId, index: 1 });
				await this.send({ type: "chunk", turnId: this.turnId, index: 1, chunk: { kind: "text", index: 0, text } });
				await this.send({
					type: "step_end",
					turnId: this.turnId,
					index: 1,
					result: { stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
				});
				return this.send({ type: "turn_end", turnId: this.turnId, reason: "answer", isAborted: false });
			case "max-tokens":
				this.turnId = `${this.sessionArgument}-length-${this.inputs.length}`;
				await this.accepted();
				await this.send({ type: "turn_start", turnId: this.turnId });
				await this.send({ type: "step_start", turnId: this.turnId, index: 0 });
				await this.send({
					type: "chunk",
					turnId: this.turnId,
					index: 0,
					chunk: { kind: "stop", stopReason: "max_tokens", usage: { input_tokens: 2, output_tokens: 2 } },
				});
				return;
			default:
				return this.standard([{ text }]);
		}
	}

	write(data: string): void {
		if (!this.pendingInput) {
			const match = /^MYHARNESS_INPUT_([0-9a-f]{32})$/.exec(data);
			if (!match) throw new Error(`Unexpected PTY input ${JSON.stringify(data)}`);
			this.pendingInput = match[1];
			return;
		}
		const expectedEnter = this.plan.win32Input ? "\u001b[13;28;13;1;0;1_\u001b[13;28;13;0;0;1_" : "\r";
		if (data !== expectedEnter) throw new Error(`Unexpected PTY enter ${JSON.stringify(data)}`);
		this.nonce = this.pendingInput;
		this.pendingInput = "";
		void (async () => {
			const result = await this.request(`/input/${this.nonce}`, { method: "GET", headers: this.headers() });
			if (!result.response.ok || typeof result.body?.text !== "string")
				throw new Error("Fake PTY did not receive complete input");
			this.inputs.push(result.body.text);
			this.plan.onInput?.(result.body.text);
			await this.respond(result.body.text);
		})().catch((error) => {
			this.errors.push(error);
		});
	}

	kill(): void {
		this.killed = true;
		this.pollAbort.abort();
	}

	onData(callback: (data: string) => void): { dispose(): void } {
		this.dataCallbacks.add(callback);
		return { dispose: () => this.dataCallbacks.delete(callback) };
	}

	onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
		this.exitCallbacks.add(callback);
		return { dispose: () => this.exitCallbacks.delete(callback) };
	}
}

class FakePtyHarness {
	readonly instances: FakeInstance[] = [];
	private readonly plans: FakePlan[];
	readonly pty: PtyFactory;

	constructor(plans: FakePlan[] = []) {
		this.plans = [...plans];
		this.pty = (executable, args, options) =>
			new FakeInstance(this, executable, args, options, this.plans.shift() || {});
	}
}

async function collect(stream: ReturnType<ClaudeCodeRuntime["stream"]>) {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(predicate()).toBe(true);
}

async function postRaw(url: string, token: string, body: unknown, headers: Record<string, string> = {}) {
	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return response.status;
}

function resultWithImage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "unused",
		toolName: "read",
		content: [
			{ type: "text", text: "fixture text" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	};
}

describe.sequential("Claude Code official interactive runtime", () => {
	let root = "";
	let projectA = "";
	let projectB = "";
	let data = "";
	let profile = "";
	let originalAgentDir: string | undefined;
	let TOOLS: Tool[];
	let runtimes: ClaudeCodeRuntime[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "myharness-claude-interactive-"));
		projectA = join(root, "project-a");
		projectB = join(root, "project-b");
		data = join(root, "data");
		profile = join(root, "profile");
		for (const directory of [projectA, projectB, data, profile]) mkdirSync(directory, { recursive: true });
		originalAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = join(root, "agent");
		TOOLS = hostTools(projectA);
		runtimes = [];
	});

	afterEach(async () => {
		await Promise.all(runtimes.map((runtime) => runtime.close()));
		if (originalAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = originalAgentDir;
		const names = readdirSync(root).sort();
		expect(names).toEqual(["data", "profile", "project-a", "project-b"].sort());
		rmSync(root, { recursive: true, force: true });
	});

	function runtimeFor(
		harness: FakePtyHarness,
		cwd: (sessionId?: string) => string = () => projectA,
	): ClaudeCodeRuntime {
		const runtime = new ClaudeCodeRuntime({
			pty: harness.pty,
			profile: () => profile,
			dataDirectory: () => data,
			cwd,
			environment: (environment) => ({ ...environment, MYHARNESS_FAKE_PTY: "1" }),
			executable: () => "C:\\fixture\\claude.exe",
			startupTimeoutMs: 1_000,
		});
		runtimes.push(runtime);
		return runtime;
	}

	function options(chat = "chat", handler?: (call: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>) {
		return {
			sessionId: chat,
			toolCallHandler: handler || (async (call) => ({ ...resultWithImage(), toolCallId: call.id })),
		};
	}

	it("launches the official interactive argv, exact prompt/settings, and real MCP initialize/list/call", async () => {
		const harness = new FakePtyHarness([{ kind: "mcp-image", win32Input: true }]);
		const runtime = runtimeFor(harness);
		const systemPrompt = "EXACT HOST SYSTEM\nsecond line";
		const context: Context = { systemPrompt, messages: [user("read fixture")], tools: TOOLS };
		const seen: ToolCall[] = [];
		const hostMessages: Message[] = [];
		const response = await collect(
			runtime.stream(MODEL, context, {
				...options("mcp", async (call) => {
					seen.push(call);
					const result = { ...resultWithImage(), toolCallId: call.id };
					hostMessages.push(
						{
							role: "assistant",
							api: MODEL.api,
							provider: MODEL.provider,
							model: MODEL.id,
							content: [call],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						},
						result,
					);
					return result;
				}),
			}),
		);
		const instance = harness.instances[0];
		expect(response.result.stopReason).toBe("stop");
		expect(seen[0]).toMatchObject({ name: "read", arguments: { path: "fixture" } });
		expect(instance.prompt).toBe(systemPrompt);
		expect(instance.args).not.toContain("-p");
		expect(instance.args).not.toContain("--print");
		expect(instance.args).not.toContain("--sdk");
		expect(instance.args[instance.args.indexOf("--tools") + 1]).toBe("");
		expect(instance.args[instance.args.indexOf("--setting-sources") + 1]).toBe("project");
		expect(instance.args).toContain("--restricted");
		expect(instance.mcpConfig.mcpServers.myharness.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bridge\/.+\/mcp$/);
		expect(instance.mcpConfig.mcpServers.myharness.headers.Authorization).toBe(`Bearer ${instance.token}`);
		expect(instance.settings).toMatchObject({
			autoMemoryEnabled: false,
			disableBundledSkills: true,
			permissions: { allow: TOOLS.map((tool) => `mcp__myharness__${tool.name}`) },
		});
		expect(instance.mcpResponses[0].initialize.jsonrpc).toBe("2.0");
		expect(instance.mcpResponses[0].listed.result.tools.map((tool: any) => tool.name)).toEqual(
			TOOLS.map((tool) => tool.name),
		);
		expect(instance.mcpResponses[0].listed.result.tools.map((tool: any) => tool.inputSchema)).toEqual(
			TOOLS.map((tool) => tool.parameters),
		);
		expect(
			instance.mcpResponses[0].listed.result.tools.find((tool: any) => tool.name === "agent").inputSchema.properties
				.run_in_background,
		).toBeDefined();
		expect(
			instance.mcpResponses[0].listed.result.tools.find((tool: any) => tool.name === "pwsh").inputSchema.properties
				.run_in_background,
		).toBeDefined();
		expect(instance.mcpResponses.at(-1).call.result.content).toEqual([
			{ type: "text", text: "fixture text" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		const next = await collect(
			runtime.stream(
				MODEL,
				{
					systemPrompt,
					tools: TOOLS,
					messages: [...context.messages, ...hostMessages, response.result, userTextBlock("after host image")],
				},
				options("mcp"),
			),
		);
		expect(next.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(1);
		expect(instance.inputs[1]).toBe("after host image");
	});

	it("keeps multi-step text and thinking blocks to one start/end pair and filters helper output", async () => {
		const harness = new FakePtyHarness([{ kind: "multi" }]);
		const runtime = runtimeFor(harness);
		const response = await collect(
			runtime.stream(MODEL, { systemPrompt: "sys", messages: [user("go")], tools: [] }, options("multi")),
		);
		expect(response.result.content).toEqual([
			{ type: "thinking", thinking: "first thought" },
			{ type: "text", text: "hello " },
			{ type: "thinking", thinking: "second thought" },
			{ type: "text", text: "go" },
		]);
		expect(response.events.filter((event) => event.type === "thinking_start")).toHaveLength(2);
		expect(response.events.filter((event) => event.type === "thinking_end")).toHaveLength(2);
		expect(response.events.filter((event) => event.type === "text_start")).toHaveLength(2);
		expect(response.events.filter((event) => event.type === "text_end")).toHaveLength(2);

		const helperHarness = new FakePtyHarness([{ kind: "helper" }]);
		const helperRuntime = runtimeFor(helperHarness);
		const helper = await collect(
			helperRuntime.stream(MODEL, { messages: [user("helper")], tools: [] }, options("helper")),
		);
		expect(helper.result.content).toEqual([{ type: "text", text: "helper" }]);
	});

	it("passes MCP image results and cancels a pending host tool through the same HTTP bridge", async () => {
		const cancellation = {
			resolve: undefined as (() => void) | undefined,
			promise: undefined as Promise<void> | undefined,
		};
		cancellation.promise = new Promise<void>((resolve) => {
			cancellation.resolve = resolve;
		});
		let handlerStarted: (() => void) | undefined;
		const handlerReady = new Promise<void>((resolve) => {
			handlerStarted = resolve;
		});
		const harness = new FakePtyHarness([{ kind: "mcp-cancel" }]);
		const runtime = runtimeFor(harness);
		const controller = new AbortController();
		const stream = runtime.stream(
			MODEL,
			{ messages: [user("cancel")], tools: [TOOLS[0]] },
			{
				...options("cancel", async (_call, signal) => {
					handlerStarted?.();
					await Promise.race([
						cancellation.promise!,
						new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
					]);
					if (signal?.aborted) throw new Error("cancelled");
					return resultWithImage();
				}),
				signal: controller.signal,
			},
		);
		await handlerReady;
		controller.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(harness.instances[0].killed).toBe(true);
		cancellation.resolve?.();
	});

	it("resumes the same chat with full history, then restarts with --resume after signature changes", async () => {
		const reminder = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
		const firstUser = user("one");
		const firstContext: Context = {
			systemPrompt: "sys",
			messages: [reminder("cwd reminder one"), firstUser],
			tools: [TOOLS[0]],
		};
		const harness = new FakePtyHarness([
			{
				kind: "basic",
				onInput: () => {
					// Core can append to this same array while the provider is still streaming.
					firstContext.messages.push(user("a late mutation that is not part of the request"));
				},
			},
			{ kind: "basic" },
		]);
		const runtime = runtimeFor(harness);
		const firstStream = runtime.stream(MODEL, firstContext, options("resume"));
		const first = await collect(firstStream);
		const history: Message[] = [firstUser, first.result];
		const secondUser = userTextBlock("two");
		const second = await collect(
			runtime.stream(
				MODEL,
				{
					systemPrompt: "sys",
					messages: [...history, reminder("cwd reminder two"), secondUser],
					tools: [TOOLS[0]],
				},
				options("resume"),
			),
		);
		expect(second.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(1);
		expect(harness.instances[0].resume).toBe(false);
		expect(harness.instances[0].sessionArgument).toBeTruthy();
		expect(harness.instances[0].inputs).toEqual(["cwd reminder one\n\none", "cwd reminder two\n\ntwo"]);
		const secondHistory: Message[] = [...history, secondUser, second.result];
		const changed = await collect(
			runtime.stream(
				MODEL,
				{ systemPrompt: "changed", messages: [...secondHistory, user("three")], tools: [TOOLS[0], TOOLS[1]] },
				options("resume"),
			),
		);
		expect(changed.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(2);
		expect(harness.instances[1].resume).toBe(true);
		expect(harness.instances[1].sessionArgument).toBe(harness.instances[0].sessionArgument);
		expect(harness.instances[1].inputs).toEqual(["three"]);
	});

	it("rebuilds full structured history on cwd, branch, and provider switches without helper pollution", async () => {
		let cwd = projectA;
		const harness = new FakePtyHarness([{ kind: "basic" }, { kind: "basic" }, { kind: "basic" }, { kind: "basic" }]);
		const runtime = runtimeFor(harness, () => cwd);
		const firstContext: Context = { systemPrompt: "sys", messages: [user("base")], tools: [] };
		const first = await collect(runtime.stream(MODEL, firstContext, options("rebuild")));
		const history = [...firstContext.messages, first.result];
		cwd = projectB;
		const second = await collect(
			runtime.stream(
				MODEL,
				{ systemPrompt: "sys", messages: [...history, user("cwd changed")], tools: [] },
				options("rebuild"),
			),
		);
		expect(second.result.stopReason).toBe("stop");
		expect(harness.instances[1].resume).toBe(false);
		const branchMessages = [
			...history,
			user("cwd changed"),
			second.result,
			{
				role: "assistant",
				api: "other",
				provider: "other",
				model: "other",
				content: [{ type: "text", text: "branch" }],
				usage: first.result.usage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as Message,
			user("branch request"),
		];
		const third = await collect(
			runtime.stream(MODEL, { systemPrompt: "sys", messages: branchMessages, tools: [] }, options("rebuild")),
		);
		expect(third.result.stopReason).toBe("stop");
		expect(harness.instances[2].resume).toBe(false);
		expect(harness.instances[2].inputs[0]).toContain('<myharness-conversation format="json">');
		await runtime.reset("rebuild");
		const fourth = await collect(
			runtime.stream(
				MODEL,
				{ systemPrompt: "sys", messages: [...branchMessages, third.result, user("provider switched")], tools: [] },
				options("rebuild"),
			),
		);
		expect(fourth.result.stopReason).toBe("stop");
		expect(harness.instances[3].resume).toBe(false);
	});

	it("uses a new no-handler helper session without changing the chat checkpoint", async () => {
		const harness = new FakePtyHarness([{ kind: "basic" }, { kind: "basic" }]);
		const runtime = runtimeFor(harness, (id) => (id ? projectA : projectB));
		const firstUser = user("chat turn");
		const first = await collect(runtime.stream(MODEL, { messages: [firstUser], tools: TOOLS }, options("shared-id")));
		const links = join(data, "interactive-links");
		const checkpoint = readFileSync(join(links, readdirSync(links)[0]), "utf8");
		const helper = await collect(
			runtime.stream(MODEL, { messages: [user("private helper")], tools: TOOLS }, { sessionId: "shared-id" }),
		);
		expect(helper.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(2);
		expect(harness.instances[1].sessionArgument).not.toBe(harness.instances[0].sessionArgument);
		expect(harness.instances[0].cwd).toBe(projectA);
		expect(harness.instances[1].cwd).toBe(projectB);
		expect(harness.instances[1].killed).toBe(true);
		expect(harness.instances[1].settings.permissions.allow).toEqual([]);
		expect(readFileSync(join(links, readdirSync(links)[0]), "utf8")).toBe(checkpoint);
		const resumed = await collect(
			runtime.stream(
				MODEL,
				{ messages: [firstUser, first.result, user("next chat turn")], tools: TOOLS },
				options("shared-id"),
			),
		);
		expect(resumed.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(2);
		expect(harness.instances[0].inputs).toEqual(["chat turn", "next chat turn"]);
	});

	it("returns length and discards the native checkpoint at max_tokens", async () => {
		const harness = new FakePtyHarness([{ kind: "max-tokens" }, { kind: "basic" }]);
		const runtime = runtimeFor(harness);
		const firstUser = user("limited turn");
		const first = await collect(runtime.stream(MODEL, { messages: [firstUser], tools: [] }, options("length")));
		expect(first.result.stopReason).toBe("length");
		expect(first.events.at(-1)).toMatchObject({ type: "done", reason: "length" });
		expect(harness.instances[0].killed).toBe(true);
		const next = await collect(
			runtime.stream(MODEL, { messages: [firstUser, first.result, user("continue")], tools: [] }, options("length")),
		);
		expect(next.result.stopReason).toBe("stop");
		expect(harness.instances[1].resume).toBe(false);
		expect(harness.instances[1].inputs[0]).toContain("limited turn");
		expect(harness.instances[1].inputs[0]).toContain("continue");
	});

	it("keeps concurrent chats isolated and never shares their PTY, input, or MCP identity", async () => {
		const harness = new FakePtyHarness([{ kind: "basic" }, { kind: "basic" }]);
		const runtime = runtimeFor(harness);
		const [left, right] = await Promise.all([
			collect(runtime.stream(MODEL, { messages: [user("left")], tools: [] }, options("left"))),
			collect(runtime.stream(MODEL, { messages: [user("right")], tools: [] }, options("right"))),
		]);
		expect(harness.instances).toHaveLength(2);
		expect(harness.instances.map((instance) => instance.inputs[0]).sort()).toEqual(["left", "right"]);
		expect(left.result.content).toEqual([{ type: "text", text: "left" }]);
		expect(right.result.content).toEqual([{ type: "text", text: "right" }]);
		expect(new Set(harness.instances.map((instance) => instance.bridgeUrl)).size).toBe(2);
	});

	it("closes PTY and bridge on abort, and launches no PTY when already aborted", async () => {
		const harness = new FakePtyHarness([{ kind: "mcp-cancel" }]);
		const runtime = runtimeFor(harness);
		const controller = new AbortController();
		const stream = runtime.stream(
			MODEL,
			{ messages: [user("abort")], tools: [TOOLS[0]] },
			{ ...options("abort"), signal: controller.signal },
		);
		await waitFor(() => harness.instances.length === 1 && harness.instances[0].started);
		controller.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(harness.instances[0].killed).toBe(true);
		const bridgeUrl = harness.instances[0].bridgeUrl;
		await expect(
			fetch(bridgeUrl, { headers: { Authorization: `Bearer ${harness.instances[0].token}` } }),
		).rejects.toThrow();

		const preAborted = new AbortController();
		preAborted.abort();
		const before = harness.instances.length;
		const pre = await collect(
			runtime.stream(
				MODEL,
				{ messages: [user("pre")], tools: [] },
				{ ...options("pre"), signal: preAborted.signal },
			),
		);
		expect(pre.result.stopReason).toBe("aborted");
		expect(harness.instances).toHaveLength(before);
	});

	it("rejects unauthenticated/origin/discontinuous/duplicate HTTP bridge traffic", async () => {
		const bridge = new LocalBridge();
		await bridge.listen();
		const base = bridge.url;
		try {
			expect(await postRaw(base, "wrong", { type: "ready", seq: 1 })).toBe(403);
			expect(await postRaw(base, bridge.token, { type: "ready", seq: 1 }, { Origin: "http://evil.test" })).toBe(403);
			expect(await postRaw(base, bridge.token, { type: "ready", seq: 2 })).toBe(400);
			expect(
				await postRaw(base, bridge.token, {
					type: "tool_start",
					seq: 1,
					event: { id: "dup", name: "mcp__myharness__read", input: {} },
				}),
			).toBe(200);
			// The discontinuity failed the queue, so duplicate identity is checked on a fresh bridge.
			await bridge.close();
			const duplicate = new LocalBridge();
			await duplicate.listen();
			try {
				expect(
					await postRaw(duplicate.url, duplicate.token, {
						type: "tool_start",
						seq: 1,
						event: { id: "dup", name: "mcp__myharness__read", input: {} },
					}),
				).toBe(200);
				expect(
					await postRaw(duplicate.url, duplicate.token, {
						type: "tool_start",
						seq: 2,
						event: { id: "dup", name: "mcp__myharness__read", input: {} },
					}),
				).toBe(400);
			} finally {
				await duplicate.close();
			}
		} finally {
			await bridge.close();
		}
	});

	it("matches concurrent same-name MCP calls by exact metadata or arguments", async () => {
		const harness = new FakePtyHarness([{ kind: "mcp-overlap" }]);
		const runtime = runtimeFor(harness);
		const calls: ToolCall[] = [];
		const response = await collect(
			runtime.stream(
				MODEL,
				{ messages: [user("overlap")], tools: [TOOLS[0]] },
				options("overlap", async (call) => {
					calls.push(call);
					return { ...resultWithImage(), toolCallId: call.id };
				}),
			),
		);
		expect(response.result.stopReason).toBe("stop");
		expect(calls.map((call) => call.arguments.path).sort()).toEqual(["A", "B"]);
		expect(harness.instances[0].mcpResponses[0].overlap.every((reply: any) => reply.result?.content)).toBe(true);
	});

	it("rebuilds once after a failed --resume before sending any prompt", async () => {
		const harness = new FakePtyHarness([{ kind: "basic" }, { kind: "basic", failResume: true }, { kind: "basic" }]);
		const runtime = runtimeFor(harness);
		const firstContext: Context = { messages: [user("first")], tools: [] };
		const first = await collect(runtime.stream(MODEL, firstContext, options("retry")));
		const history = [...firstContext.messages, first.result];
		await runtime.reset("retry", false);
		const second = await collect(
			runtime.stream(MODEL, { messages: [...history, user("second")], tools: [] }, options("retry")),
		);
		expect(second.result.stopReason).toBe("stop");
		expect(harness.instances).toHaveLength(3);
		expect(harness.instances[1].resume).toBe(true);
		expect(harness.instances[1].inputs).toEqual([]);
		expect(harness.instances[2].resume).toBe(false);
		expect(harness.instances[2].inputs[0]).toContain('<myharness-conversation format="json">');
		expect(harness.instances[2].inputs[0]).toContain("second");
	});
});
