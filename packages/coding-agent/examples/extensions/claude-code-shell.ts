/**
 * Claude Code shell: MyHarness is the interface, the user's own unmodified `claude` program does the work.
 *
 * The provider never talks to Anthropic and never touches credentials. It runs the official program the way its own
 * documentation describes (`claude -p` with stream-json on stdin/stdout), so that program's login, memory, skills,
 * connectors and tools all stay as they are.
 *
 * Tool calls take two routes:
 * - Claude Code's own tools run inside `claude`. They show here as `claude_code_tool` cards, which only wait for the
 *   result `claude` reports.
 * - MyHarness's tools are offered to `claude` over a local MCP endpoint (loopback, random token per process). A call
 *   comes back through the provider as an ordinary tool call, so MyHarness runs it with its own approval and cards.
 *
 * Compaction belongs to `claude` as well: its conversation holds the real context, so these models are marked
 * managesOwnContext. MyHarness shows how full the window is and neither gates on it nor compacts. "Compact now" is passed
 * on to `claude`.
 *
 * The Windows installer carries this file and loads it by itself. From source, copy it to ~/.myharness/agent/extensions/
 * and restart MyHarness; a copy there takes over from the bundled one. `claude` must be installed and signed in on that
 * computer. It runs with bypassPermissions, so `claude`'s own tools do not ask before they act.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createAssistantMessageEventStream, createProvider, parseStreamingJson } from "@myharness/ai";
import type { ExtensionAPI } from "@myharness/coding-agent";
import { Type } from "typebox";

const PROVIDER_ID = "claude-code";
const PASSTHROUGH_TOOL = "claude_code_tool";
const MCP_SERVER = "myharness";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
/** MyHarness tools Claude Code has its own version of; offering both only makes it choose at random. */
const OVERLAPPING_TOOLS = new Set([
	PASSTHROUGH_TOOL,
	"read",
	"write",
	"edit",
	"apply_patch",
	"bash",
	"pwsh",
	"grep",
	"find",
	"ls",
	"todo_write",
	"ask_user_question",
	"agent",
	"agent_tasks",
]);
const IDLE_CLOSE_MS = 15 * 60_000;
/** A program that has not stopped this long after an interrupt is ended; the next turn resumes the conversation. */
const INTERRUPT_GRACE_MS = 10_000;
/** MyHarness's tools can wait for the user, such as a sign-in. `claude`'s default gives up on them after 60 s. */
const APP_TOOL_TIMEOUT_MS = 24 * 3600_000;
const MAX_CARD_CHARS = 30_000;
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_TRANSCRIPT_CHARS = 800_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const MIN_CONTEXT_WINDOW = 100_000;
/** Whatever the user's own Claude Code settings say, these chats have no other compaction. */
const AUTO_COMPACT_ON = JSON.stringify({ autoCompactEnabled: true });
/** How MyHarness's checkpoint starts once it is a user message; `claude` already holds its own summary. */
const CHECKPOINT_PREFIX = "The conversation history before this point has been compacted";
const APPEND_PROMPT = [
	"You are running inside MyHarness, a desktop app the user chose as the interface for Claude Code.",
	`The app's own abilities are the ${MCP_PREFIX}* tools; ${MCP_PREFIX}workspace controls the app's built-in browser and right-hand workspace.`,
].join(" ");
/** Variables that would switch `claude` away from the user's own login, or confuse it about where it runs. */
const STRIPPED_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"ELECTRON_RUN_AS_NODE",
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"DISABLE_AUTO_COMPACT",
	"DISABLE_COMPACT",
];

const MODELS = [
	{ id: "claude-opus-5-5", name: "Claude Code · Opus 5.5" },
	{ id: "claude-sonnet-5-5", name: "Claude Code · Sonnet 5.5" },
	{ id: "claude-fable-5-1", name: "Claude Code · Fable 5.1" },
	{ id: "claude-haiku-5-5", name: "Claude Code · Haiku 5.5" },
];

// One registry per process: every chat's extension instance shares the same `claude` children and MCP endpoint.
type Shared = {
	sessions: Map<string, CliSession>;
	contexts: Map<string, any>;
	configFiles: Set<string>;
	/** Chats whose next request is MyHarness's summary, not a turn of the conversation. */
	compacting: Set<string>;
	models?: any[];
	mcp?: McpEndpoint;
};
const SHARED_KEY = Symbol.for("myharness.claude-code-shell");
const shared: Shared = (globalThis as any)[SHARED_KEY] ?? {
	sessions: new Map(),
	contexts: new Map(),
	configFiles: new Set(),
	compacting: new Set(),
};
(globalThis as any)[SHARED_KEY] = shared;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const dataDir = () =>
	path.join(
		process.env.MYHARNESS_CODING_AGENT_DIR || path.join(os.homedir(), ".myharness", "agent"),
		"claude-code-shell",
	);

// ---------------------------------------------------------------------------------------------------------------------
// Locating the program and remembering which Claude Code conversation belongs to which chat
// ---------------------------------------------------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] || 0) - (right[i] || 0);
		if (difference) return difference;
	}
	return 0;
}

/** The newest copy the desktop app keeps, or one on PATH. The app's copy moves on every update, so this runs per start. */
function findClaude(): string | undefined {
	const override = process.env.MYHARNESS_CLAUDE_BIN;
	if (override && fs.existsSync(override)) return override;
	const root = process.env.APPDATA ? path.join(process.env.APPDATA, "Claude", "claude-code") : undefined;
	if (root && fs.existsSync(root)) {
		const versions = fs
			.readdirSync(root)
			.filter((name) => /^\d+(\.\d+)*$/.test(name))
			.sort(compareVersions)
			.reverse();
		for (const version of versions) {
			for (const build of fs.readdirSync(path.join(root, version))) {
				const candidate = path.join(root, version, build, "claude.exe");
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	try {
		const found = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
			encoding: "utf8",
			windowsHide: true,
		});
		return found
			.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim();
	} catch {
		return undefined;
	}
}

type LinkEntry = { claudeSessionId: string; cwd: string };
const linksFile = () => path.join(dataDir(), "sessions.json");
function readLinks(): Record<string, LinkEntry> {
	try {
		return JSON.parse(fs.readFileSync(linksFile(), "utf8"));
	} catch {
		return {};
	}
}
function writeLink(sessionId: string, entry: LinkEntry | undefined): void {
	const links = readLinks();
	if (entry) links[sessionId] = entry;
	else delete links[sessionId];
	fs.mkdirSync(dataDir(), { recursive: true });
	const temporary = `${linksFile()}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(links, null, "\t"));
	fs.renameSync(temporary, linksFile());
}

const settingsFile = () => path.join(dataDir(), "settings.json");
function saveContextWindow(tokens: number): void {
	fs.mkdirSync(dataDir(), { recursive: true });
	fs.writeFileSync(settingsFile(), JSON.stringify({ contextWindow: tokens }, null, "\t"));
	// The same objects every open chat holds, so they all follow at once.
	for (const model of shared.models ?? []) model.contextWindow = tokens;
}

function readContextWindow(): number {
	try {
		const value = JSON.parse(fs.readFileSync(settingsFile(), "utf8")).contextWindow;
		return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
	} catch {
		return DEFAULT_CONTEXT_WINDOW;
	}
}

/** "300k", "1m" or a plain count. A number up to 1000 means thousands, the way MyHarness's own K fields read. */
function parseContextWindow(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim().replace(/[,_]/g, ""));
	if (!match) return undefined;
	const unit = match[2].toLowerCase();
	const value = Number(match[1]);
	const tokens = Math.round(unit === "m" ? value * 1_000_000 : unit === "k" || value <= 1000 ? value * 1000 : value);
	return tokens >= MIN_CONTEXT_WINDOW && tokens <= DEFAULT_CONTEXT_WINDOW ? tokens : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Local MCP endpoint offering MyHarness's tools to `claude`
// ---------------------------------------------------------------------------------------------------------------------

type McpEndpoint = { server: Server; port: number; token: string };

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as object)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function ensureMcp(): Promise<McpEndpoint> {
	if (shared.mcp) return Promise.resolve(shared.mcp);
	const token = randomBytes(32).toString("hex");
	const server = createServer((request, response) => {
		const match = /^\/mcp\/([^/?]+)/.exec(request.url ?? "");
		if (request.method !== "POST" || !match || request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(request.headers.authorization === `Bearer ${token}` ? 405 : 401).end();
			return;
		}
		const session = shared.sessions.get(decodeURIComponent(match[1]));
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", async () => {
			let message: any;
			try {
				message = JSON.parse(body);
			} catch {
				response.writeHead(400).end();
				return;
			}
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const reply = (payload: object) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
			};
			if (message.method === "initialize") {
				reply({
					result: {
						protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: MCP_SERVER, version: "1.0.0" },
					},
				});
			} else if (message.method === "ping") {
				reply({ result: {} });
			} else if (message.method === "tools/list") {
				reply({ result: { tools: session?.offeredTools() ?? [] } });
			} else if (message.method === "tools/call" && session) {
				reply({ result: await session.waitForAppTool(message.params?.name, message.params?.arguments ?? {}) });
			} else {
				reply({ error: { code: -32601, message: `Unsupported method: ${message.method}` } });
			}
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.unref();
			const address = server.address();
			shared.mcp = { server, port: typeof address === "object" && address ? address.port : 0, token };
			resolve(shared.mcp);
		});
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// One running `claude` per chat
// ---------------------------------------------------------------------------------------------------------------------

function userContent(message: any): any[] {
	const parts =
		typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
	return parts.map((part: any) =>
		part.type === "image"
			? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
			: { type: "text", text: part.text ?? "" },
	);
}

function plainText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return "";
			if (part.type === "toolCall") return `[tool ${part.name}: ${JSON.stringify(part.arguments).slice(0, 300)}]`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** What an earlier part of a chat said, for a Claude Code conversation that did not see it happen. */
function renderTranscript(messages: any[]): string {
	const lines: string[] = [];
	let total = 0;
	// Newest first, so a limit only ever costs the oldest messages. A compacted chat is far below it, summary included.
	for (let i = messages.length - 1; i >= 0 && total < MAX_TRANSCRIPT_CHARS; i--) {
		const message = messages[i];
		const text = plainText(message.content);
		if (!text) continue;
		const isTool = message.role === "toolResult";
		const clipped =
			isTool && text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)} ...` : text;
		lines.unshift(`${isTool ? `tool result (${message.toolName})` : message.role}: ${clipped}`);
		total += clipped.length;
	}
	return lines.join("\n\n");
}

class CliSession {
	child?: ChildProcess;
	signature = "";
	/** A turn was sent and its `result` has not arrived. */
	turnActive = false;
	/** An interrupted turn's leftovers still to be thrown away. */
	draining = false;
	lastUserTimestamp?: number;
	tools: any[] = [];
	alwaysAllowed = new Set<string>();
	private queue: any[] = [];
	private waiter?: (event: any) => void;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private interruptTimer?: ReturnType<typeof setTimeout>;
	private stderr = "";
	private gotInit = false;
	private resumedFrom?: string;
	/** Results of Claude Code's own tools, by tool_use id. */
	private toolResults = new Map<string, Deferred<any>>();
	/** Arguments of app tools by call id, and the MCP requests and results still to be paired up. */
	private appCalls = new Map<string, { name: string; key: string }>();
	private appWaiters: { name: string; key: string; done: (result: any) => void }[] = [];
	private appResults: { name: string; key: string; result: any }[] = [];
	private seenMessageIds = new Set<string>();
	private limitsText?: string;
	private compactingNow = false;
	/** A boundary was reported; the next user message is the summary `claude` continues from. */
	private summaryPending = false;
	private lastCompaction?: { summary: string; tokensBefore: number };
	/** "Compact now" is running: its `result` belongs to this and not to any turn. */
	private compactDone?: (result: { summary: string; tokensBefore: number } | undefined) => void;

	readonly sessionId: string;
	readonly ephemeral: boolean;

	constructor(sessionId: string, ephemeral = false) {
		this.sessionId = sessionId;
		this.ephemeral = ephemeral;
	}

	get cwd(): string {
		return shared.contexts.get(this.sessionId)?.cwd ?? process.cwd();
	}

	offeredTools(): any[] {
		return this.tools
			.filter((tool) => !OVERLAPPING_TOOLS.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })),
			}));
	}

	async start(model: any, effort: string | undefined, systemPrompt?: string): Promise<void> {
		const binary = findClaude();
		if (!binary) throw new Error("找不到 claude 程序。请先安装 Claude Code，或设置 MYHARNESS_CLAUDE_BIN。");
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			model.id,
			"--settings",
			AUTO_COMPACT_ON,
		];
		if (effort) args.push("--effort", effort);
		if (this.ephemeral) {
			args.push("--no-session-persistence", "--tools", "");
			if (systemPrompt) args.push("--system-prompt", systemPrompt);
		} else {
			// No permission prompts for `claude`'s own tools. The prompt tool stays for questions it still has to put to the user.
			args.push(
				"--permission-mode",
				"bypassPermissions",
				"--permission-prompt-tool",
				"stdio",
				"--append-system-prompt",
				APPEND_PROMPT,
			);
			if (this.offeredTools().length > 0) {
				const mcp = await ensureMcp();
				fs.mkdirSync(dataDir(), { recursive: true });
				const configFile = path.join(dataDir(), `mcp-${process.pid}-${encodeURIComponent(this.sessionId)}.json`);
				const config = {
					mcpServers: {
						[MCP_SERVER]: {
							type: "http",
							url: `http://127.0.0.1:${mcp.port}/mcp/${encodeURIComponent(this.sessionId)}`,
							headers: { Authorization: `Bearer ${mcp.token}` },
						},
					},
				};
				fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
				if (!shared.configFiles.size) {
					process.once("exit", () => {
						for (const file of shared.configFiles) fs.rmSync(file, { force: true });
					});
				}
				shared.configFiles.add(configFile);
				args.push("--mcp-config", configFile);
			}
			const link = readLinks()[this.sessionId];
			if (link && path.resolve(link.cwd) === path.resolve(this.cwd)) {
				args.push("--resume", link.claudeSessionId);
				this.resumedFrom = link.claudeSessionId;
			} else {
				this.resumedFrom = undefined;
			}
		}
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const name of STRIPPED_ENV) delete env[name];
		env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(readContextWindow());
		env.MCP_TOOL_TIMEOUT = String(APP_TOOL_TIMEOUT_MS);
		const child = spawn(binary, args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		this.gotInit = false;
		this.stderr = "";
		child.stderr?.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-2000);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.finishChild(child, error.message));
		child.on("exit", (code) => this.finishChild(child, code ? `claude 退出，代码 ${code}` : undefined));
		createInterface({ input: child.stdout! }).on("line", (line) => {
			if (this.child !== child) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			this.onEvent(event);
		});
	}

	private finishChild(child: ChildProcess, problem: string | undefined): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.releaseWaiting(problem ?? "claude 已退出");
		this.push({
			type: "__exit",
			problem: problem && this.stderr ? `${problem}\n${this.stderr}` : problem,
			gotInit: this.gotInit,
			resumedFrom: this.resumedFrom,
		});
	}

	/** Nothing may keep waiting on a process or turn that is gone. */
	private releaseWaiting(reason: string): void {
		for (const [id, waiting] of this.toolResults) {
			waiting.resolve({ is_error: true, content: reason });
			this.toolResults.delete(id);
		}
		for (const waiter of this.appWaiters.splice(0)) {
			waiter.done({ content: [{ type: "text", text: reason }], isError: true });
		}
		this.appResults.length = 0;
		this.appCalls.clear();
		this.compactDone?.(undefined);
		this.compactDone = undefined;
		if (this.compactingNow) {
			this.compactingNow = false;
			this.showStatus();
		}
	}

	private push(event: any): void {
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter(event);
		} else {
			this.queue.push(event);
		}
	}

	next(): Promise<any> {
		const event = this.queue.shift();
		if (event) return Promise.resolve(event);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	send(value: unknown): void {
		this.child?.stdin?.write(`${JSON.stringify(value)}\n`);
	}

	sendUser(content: any[]): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		// Nothing left over may be taken for this turn's answer.
		if (!this.turnActive) this.queue.length = 0;
		this.turnActive = true;
		this.send({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } });
	}

	interrupt(): void {
		if (!this.turnActive) return;
		this.turnActive = false;
		this.draining = true;
		this.queue.length = 0;
		this.send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
		this.releaseWaiting("已中断");
		if (this.interruptTimer) clearTimeout(this.interruptTimer);
		this.interruptTimer = setTimeout(() => {
			if (this.draining) this.close();
		}, INTERRUPT_GRACE_MS);
		this.interruptTimer.unref();
	}

	close(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.interruptTimer) clearTimeout(this.interruptTimer);
		const child = this.child;
		this.child = undefined;
		this.turnActive = false;
		this.draining = false;
		this.queue.length = 0;
		this.releaseWaiting("已关闭");
		if (child) {
			child.stdin?.end();
			setTimeout(() => {
				if (child.exitCode === null) child.kill();
			}, 3000).unref();
		}
	}

	private onEvent(event: any): void {
		if (event.type === "control_request") {
			void this.onControlRequest(event);
			return;
		}
		if (event.type === "system" && event.subtype === "init") {
			this.gotInit = true;
			if (!this.ephemeral) writeLink(this.sessionId, { claudeSessionId: event.session_id, cwd: this.cwd });
			if (event.apiKeySource && event.apiKeySource !== "none") {
				shared.contexts
					.get(this.sessionId)
					?.ui?.notify(`Claude Code 正在使用 ${event.apiKeySource} 的 API key，会按用量计费。`, "warning");
			}
		}
		if (event.type === "rate_limit_event") this.showLimits(event.rate_limit_info);
		if (this.draining) {
			if (event.type === "result") {
				this.draining = false;
				if (this.interruptTimer) clearTimeout(this.interruptTimer);
			}
			return;
		}
		if (event.type === "system" && event.subtype === "status") {
			this.compactingNow = event.status === "compacting";
			this.showStatus();
		}
		if (event.type === "system" && event.subtype === "compact_boundary")
			this.onCompactBoundary(event.compact_metadata);
		if (event.type === "user" && this.summaryPending && !event.parent_tool_use_id) {
			this.summaryPending = false;
			if (this.lastCompaction) this.lastCompaction.summary = plainText(event.message?.content);
			return;
		}
		if (!event.parent_tool_use_id) this.expectOwnTools(event);
		// Results come whether or not the provider is reading right now: tool cards are waiting for them.
		if (event.type === "user" && Array.isArray(event.message?.content) && !event.parent_tool_use_id) {
			for (const block of event.message.content) {
				if (block.type !== "tool_result") continue;
				// The entry stays: a fast tool can finish before its card starts waiting. takeToolResult removes it.
				this.toolResults.get(block.tool_use_id)?.resolve(block);
			}
			return;
		}
		if (event.type === "result") {
			this.turnActive = false;
			this.seenMessageIds.clear();
			if (this.idleTimer) clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
			this.idleTimer.unref();
			if (this.compactDone) {
				this.compactDone(event.is_error ? undefined : this.lastCompaction);
				this.compactDone = undefined;
				return;
			}
		}
		if (this.compactDone) return;
		if (event.type === "stream_event" || event.type === "assistant" || event.type === "result") this.push(event);
	}

	private showLimits(info: any): void {
		const windows = info?.unifiedWindows;
		if (!windows) return;
		const remaining = (window: any) =>
			window ? `${Math.max(0, Math.min(100, Math.round((1 - (window.utilization ?? 0)) * 100)))}%` : "-";
		this.limitsText = `Claude 额度剩余 5h ${remaining(windows.five_hour)} · 7d ${remaining(windows.seven_day)}`;
		this.showStatus();
	}

	private showStatus(): void {
		const text = [this.limitsText, this.compactingNow ? "Claude Code 正在压缩上下文…" : undefined]
			.filter(Boolean)
			.join(" · ");
		if (text) shared.contexts.get(this.sessionId)?.ui?.setStatus?.(PROVIDER_ID, text);
	}

	private onCompactBoundary(metadata: any): void {
		this.summaryPending = true;
		this.lastCompaction = { summary: "", tokensBefore: metadata?.pre_tokens ?? 0 };
		this.compactingNow = false;
		this.showStatus();
		if (metadata?.trigger === "auto") {
			shared.contexts
				.get(this.sessionId)
				?.ui?.notify(
					`Claude Code 压缩了上下文：${formatTokens(metadata.pre_tokens ?? 0)} → ${formatTokens(metadata.post_tokens ?? 0)}`,
					"info",
				);
		}
	}

	/** `claude`'s own /compact. A program started only for this has none of the chat's tools, so it does not stay. */
	async compact(
		model: any,
		instructions: string | undefined,
		signal: AbortSignal,
	): Promise<{ summary: string; tokensBefore: number } | undefined> {
		const startedHere = !this.child;
		if (startedHere) await this.start(model, undefined);
		// A turn still going would run first, and its `result` would be taken for this one's.
		this.interrupt();
		this.lastCompaction = undefined;
		const done = new Promise<{ summary: string; tokensBefore: number } | undefined>((resolve) => {
			this.compactDone = resolve;
		});
		const onAbort = () => this.interrupt();
		signal.addEventListener("abort", onAbort, { once: true });
		this.sendUser([{ type: "text", text: instructions ? `/compact ${instructions}` : "/compact" }]);
		try {
			return await done;
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (startedHere) this.close();
		}
	}

	private async onControlRequest(event: any): Promise<void> {
		const respond = (response: object) =>
			this.send({
				type: "control_response",
				response: { subtype: "success", request_id: event.request_id, response },
			});
		const request = event.request ?? {};
		if (request.subtype !== "can_use_tool") {
			this.send({
				type: "control_response",
				response: { subtype: "error", request_id: event.request_id, error: `Unsupported: ${request.subtype}` },
			});
			return;
		}
		const allow = (updatedPermissions?: unknown) =>
			respond({
				behavior: "allow",
				updatedInput: request.input,
				...(updatedPermissions ? { updatedPermissions } : {}),
			});
		const name: string = request.tool_name ?? "";
		// MyHarness applies its own approval when the call comes back through the provider.
		if (name.startsWith(MCP_PREFIX) || this.alwaysAllowed.has(name)) {
			allow();
			return;
		}
		const ui = shared.contexts.get(this.sessionId)?.hasUI ? shared.contexts.get(this.sessionId).ui : undefined;
		if (!ui) {
			respond({ behavior: "deny", message: "No interface is available to approve this tool." });
			return;
		}
		try {
			if (name === "AskUserQuestion" && Array.isArray(request.input?.questions)) {
				const answers: Record<string, string> = {};
				for (const question of request.input.questions) {
					const labels = (question.options ?? []).map((option: any) => option.label);
					const answer = await ui.select(question.question, labels);
					if (answer === undefined) {
						respond({ behavior: "deny", message: "The user dismissed the question." });
						return;
					}
					answers[question.question] = answer;
				}
				respond({ behavior: "allow", updatedInput: { ...request.input, answers } });
				return;
			}
			const summary = request.description ?? request.title ?? JSON.stringify(request.input ?? {}).slice(0, 400);
			const onceLabel = "允许这一次";
			const alwaysLabel = `这个对话里都允许 ${name}`;
			const choice = await ui.select(`Claude Code 想使用 ${name}\n${summary}`, [onceLabel, alwaysLabel, "拒绝"]);
			if (choice === onceLabel) {
				allow();
			} else if (choice === alwaysLabel) {
				this.alwaysAllowed.add(name);
				allow();
			} else {
				respond({ behavior: "deny", message: "The user denied this tool." });
			}
		} catch (error) {
			respond({ behavior: "deny", message: error instanceof Error ? error.message : String(error) });
		}
	}

	// Pairing app tool calls with the MCP requests `claude` makes for them

	/**
	 * ToolSearch answers about 2 ms after it is asked for, which can be in the same read and before the provider has got as
	 * far as the call. A result with nothing waiting for it is lost and its card never ends, so the wait starts here.
	 */
	private expectOwnTools(event: any): void {
		const blocks =
			event.type === "assistant"
				? event.message?.content
				: event.type === "stream_event" && event.event?.type === "content_block_start"
					? [event.event.content_block]
					: [];
		for (const block of blocks ?? []) {
			if (block?.type !== "tool_use" || block.name?.startsWith(MCP_PREFIX) || this.toolResults.has(block.id))
				continue;
			this.toolResults.set(block.id, deferred());
		}
	}

	takeToolResult(id: string): Promise<any> | undefined {
		const waiting = this.toolResults.get(id);
		// Stays listed until it settles, so an interrupt or a dead process can still release it.
		void waiting?.promise.then(() => this.toolResults.delete(id));
		return waiting?.promise;
	}

	noteAppCall(id: string, name: string, args: unknown): void {
		this.appCalls.set(id, { name, key: stableJson(args) });
	}

	deliverAppResult(message: any): void {
		const call = this.appCalls.get(message.toolCallId);
		if (!call) return;
		this.appCalls.delete(message.toolCallId);
		const result = {
			content: (message.content ?? []).map((part: any) =>
				part.type === "image"
					? { type: "image", data: part.data, mimeType: part.mimeType }
					: { type: "text", text: part.text ?? "" },
			),
			isError: !!message.isError,
		};
		const index = this.appWaiters.findIndex((waiter) => waiter.name === call.name && waiter.key === call.key);
		const fallback = index >= 0 ? index : this.appWaiters.findIndex((waiter) => waiter.name === call.name);
		if (fallback >= 0) this.appWaiters.splice(fallback, 1)[0].done(result);
		else this.appResults.push({ ...call, result });
	}

	waitForAppTool(name: string, args: unknown): Promise<any> {
		const key = stableJson(args);
		const index = this.appResults.findIndex((entry) => entry.name === name && entry.key === key);
		if (index >= 0) return Promise.resolve(this.appResults.splice(index, 1)[0].result);
		return new Promise((done) => this.appWaiters.push({ name, key, done }));
	}

	alreadySeen(messageId: string): boolean {
		return this.seenMessageIds.has(messageId);
	}

	markSeen(messageId: string): void {
		this.seenMessageIds.add(messageId);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider: turns the program's events into one assistant message per tool round
// ---------------------------------------------------------------------------------------------------------------------

function zeroUsage(): any {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	return `${tokens < 10_000 ? Math.round(tokens / 100) / 10 : Math.round(tokens / 1000)}K`;
}

function applyUsage(target: any, usage: any): void {
	if (!usage) return;
	if (usage.input_tokens !== undefined) target.input = usage.input_tokens;
	if (usage.output_tokens !== undefined) target.output = usage.output_tokens;
	if (usage.cache_read_input_tokens !== undefined) target.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens !== undefined) target.cacheWrite = usage.cache_creation_input_tokens;
	target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
}

function effortFor(model: any, level: string | undefined): string | undefined {
	return level ? (model.thinkingLevelMap?.[level] ?? undefined) : undefined;
}

/** How a tool `claude` uses looks as a MyHarness call, also while its arguments are still arriving. */
function shapeToolCall(id: string, name: string, input: any): any {
	return name.startsWith(MCP_PREFIX)
		? { type: "toolCall", id, name: name.slice(MCP_PREFIX.length), arguments: input }
		: { type: "toolCall", id, name: PASSTHROUGH_TOOL, arguments: { tool: name, input } };
}

function mapToolCall(session: CliSession, id: string, name: string, input: any): any {
	if (name.startsWith(MCP_PREFIX)) session.noteAppCall(id, name.slice(MCP_PREFIX.length), input);
	return shapeToolCall(id, name, input);
}

async function runTurn(stream: any, session: CliSession, model: any, context: any, options: any): Promise<void> {
	const output: any = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const fail = (reason: "aborted" | "error", message: string) => {
		output.stopReason = reason;
		output.errorMessage = message;
		stream.push({ type: "error", reason, error: output });
		stream.end();
	};
	stream.push({ type: "start", partial: output });

	const messages: any[] = context.messages ?? [];
	const last = messages[messages.length - 1];
	const effort = effortFor(model, options?.reasoning);
	// The length reaches `claude` when it starts, so a new one restarts it (the conversation is resumed).
	const signature = `${model.id}|${effort ?? ""}|${readContextWindow()}`;
	session.tools = context.tools ?? [];

	const prepareUserTurn = async (withHistory: boolean) => {
		let start = messages.length;
		while (start > 0 && messages[start - 1].role === "user") start--;
		const content = messages
			.slice(start)
			.filter((message) => withHistory || !plainText(message.content).startsWith(CHECKPOINT_PREFIX))
			.flatMap(userContent);
		const earlier = withHistory ? renderTranscript(messages.slice(0, start)) : "";
		if (earlier) {
			content.unshift({
				type: "text",
				text: `<earlier-conversation>\nThis chat started before this Claude Code conversation. Earlier messages, for context:\n\n${earlier}\n</earlier-conversation>`,
			});
		}
		session.lastUserTimestamp = last?.timestamp;
		session.sendUser(content);
	};

	if (session.child && session.signature !== signature && !session.turnActive) session.close();
	const fresh = !session.child;
	if (fresh) {
		session.signature = signature;
		await session.start(model, effort, context.systemPrompt);
	}
	const hasLink = !session.ephemeral && !!readLinks()[session.sessionId];
	if (last?.role === "toolResult") {
		for (let i = messages.length - 1; i >= 0 && messages[i].role === "toolResult"; i--) {
			session.deliverAppResult(messages[i]);
		}
		// The program went away between two tool rounds (restart, idle close, a compaction): pick the conversation back up.
		if (fresh) {
			const earlier = hasLink ? "" : renderTranscript(messages);
			const history = earlier ? `<earlier-conversation>\n${earlier}\n</earlier-conversation>\n\n` : "";
			session.sendUser([{ type: "text", text: `${history}Continue where you left off.` }]);
		}
	} else if (!(session.turnActive && session.lastUserTimestamp === last?.timestamp)) {
		await prepareUserTurn(!hasLink);
	}

	const onAbort = () => session.interrupt();
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const blocks = new Map<number, { index: number; json: string; id?: string; name?: string }>();
		let calls = 0;
		let retried = false;
		for (;;) {
			if (options?.signal?.aborted) {
				fail("aborted", "已中断");
				return;
			}
			const abortPromise = new Promise<any>((resolve) => {
				if (options?.signal)
					options.signal.addEventListener("abort", () => resolve({ type: "__abort" }), { once: true });
			});
			const event = await Promise.race([session.next(), abortPromise]);
			if (event.type === "__abort") {
				fail("aborted", "已中断");
				return;
			}
			if (event.type === "__exit") {
				// A remembered conversation that no longer exists: start over with the chat's history.
				if (!event.gotInit && event.resumedFrom && !retried) {
					retried = true;
					writeLink(session.sessionId, undefined);
					await session.start(model, effort, context.systemPrompt);
					await prepareUserTurn(true);
					continue;
				}
				session.turnActive = false;
				fail("error", event.problem ?? "claude 意外结束了这一轮");
				return;
			}
			if (event.parent_tool_use_id) continue;
			if (event.type === "assistant") {
				// Normally already seen piece by piece; without streaming this is the only copy.
				const message = event.message;
				if (!message?.id || session.alreadySeen(message.id)) continue;
				session.markSeen(message.id);
				output.responseId = message.id;
				applyUsage(output.usage, message.usage);
				for (const block of message.content ?? []) {
					if (block.type === "text") {
						const contentIndex = output.content.push({ type: "text", text: block.text }) - 1;
						stream.push({ type: "text_start", contentIndex, partial: output });
						stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
						stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					} else if (block.type === "tool_use") {
						const toolCall = mapToolCall(session, block.id, block.name, block.input ?? {});
						const contentIndex = output.content.push(toolCall) - 1;
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
						calls++;
					}
				}
				if (calls > 0) {
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					return;
				}
				continue;
			}
			if (event.type === "result") {
				// `result` adds up every request of the turn, which is not how full the context is; the last request's own
				// usage, already applied above, is. MyHarness compares that number with the context length.
				if (event.is_error) {
					fail("error", event.result || (event.errors ?? []).join("\n") || `claude 报错：${event.subtype}`);
					return;
				}
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}
			const part = event.event;
			if (part?.type === "message_start") {
				session.markSeen(part.message?.id);
				output.responseId = part.message?.id;
				applyUsage(output.usage, part.message?.usage);
			} else if (part?.type === "message_delta") {
				applyUsage(output.usage, part.usage);
			} else if (part?.type === "content_block_start") {
				const block = part.content_block;
				if (block?.type === "text") {
					const index = output.content.push({ type: "text", text: "" }) - 1;
					blocks.set(part.index, { index, json: "" });
					stream.push({ type: "text_start", contentIndex: index, partial: output });
				} else if (block?.type === "thinking") {
					// Hidden thinking stays an empty block: the page shows "Thinking…" while it is live and nothing afterwards.
					const index = output.content.push({ type: "thinking", thinking: "" }) - 1;
					blocks.set(part.index, { index, json: "" });
					stream.push({ type: "thinking_start", contentIndex: index, partial: output });
				} else if (block?.type === "tool_use") {
					const index = output.content.push(shapeToolCall(block.id, block.name, {})) - 1;
					blocks.set(part.index, { index, json: "", id: block.id, name: block.name });
					stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				}
			} else if (part?.type === "content_block_delta") {
				const delta = part.delta;
				const block = blocks.get(part.index);
				if (!block) continue;
				if (delta?.type === "text_delta") {
					output.content[block.index].text += delta.text;
					stream.push({ type: "text_delta", contentIndex: block.index, delta: delta.text, partial: output });
				} else if (delta?.type === "thinking_delta") {
					output.content[block.index].thinking += delta.thinking;
					stream.push({
						type: "thinking_delta",
						contentIndex: block.index,
						delta: delta.thinking,
						partial: output,
					});
				} else if (delta?.type === "input_json_delta") {
					block.json += delta.partial_json;
					output.content[block.index] = shapeToolCall(
						block.id ?? "",
						block.name ?? "",
						parseStreamingJson(block.json),
					);
					stream.push({
						type: "toolcall_delta",
						contentIndex: block.index,
						delta: delta.partial_json,
						partial: output,
					});
				}
			} else if (part?.type === "content_block_stop") {
				const block = blocks.get(part.index);
				if (!block) continue;
				blocks.delete(part.index);
				const current = output.content[block.index];
				if (current.type === "text") {
					stream.push({ type: "text_end", contentIndex: block.index, content: current.text, partial: output });
				} else if (current.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: block.index,
						content: current.thinking,
						partial: output,
					});
				} else if (block.id) {
					let input: any = {};
					try {
						input = block.json ? JSON.parse(block.json) : {};
					} catch {
						input = { unparsed: block.json };
					}
					const toolCall = mapToolCall(session, block.id, block.name ?? "", input);
					output.content[block.index] = toolCall;
					stream.push({ type: "toolcall_end", contentIndex: block.index, toolCall, partial: output });
					calls++;
				}
			} else if (part?.type === "message_stop" && calls > 0) {
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
				stream.end();
				return;
			}
		}
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
	}
}

function streamSimple(model: any, context: any, options: any): any {
	const stream = createAssistantMessageEventStream();
	const sessionId: string | undefined = options?.sessionId;
	// Side requests (titles, summaries) answer apart, so they never enter the chat's conversation. Most have no tools;
	// a summary on the chat's own model carries the chat's tools for the provider cache, so it is told by the flag.
	const compacting = !!sessionId && shared.compacting.has(sessionId);
	const ephemeral = !sessionId || !context.tools?.length || compacting;
	let session: CliSession;
	if (ephemeral) {
		session = new CliSession(sessionId ?? randomUUID(), true);
	} else {
		session = shared.sessions.get(sessionId) ?? new CliSession(sessionId);
		shared.sessions.set(sessionId, session);
	}
	runTurn(stream, session, model, context, options)
		.catch((error) => {
			const message: any = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: message });
			stream.end();
		})
		.finally(() => {
			if (ephemeral) session.close();
		});
	return stream;
}

// ---------------------------------------------------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	shared.models ??= MODELS.map((model) => ({
		...model,
		api: "claude-code-cli",
		provider: PROVIDER_ID,
		baseUrl: "claude-code://local",
		reasoning: true,
		// What `claude --effort` accepts. It has no "off" or "minimal", and xhigh/max only appear when listed.
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: readContextWindow(),
		// `claude` decides when to compact, by the same length (see /context-length).
		managesOwnContext: true,
		maxTokens: 64_000,
	}));
	pi.registerProvider({
		...(createProvider({
			id: PROVIDER_ID,
			name: "Claude Code",
			baseUrl: "claude-code://local",
			auth: {
				apiKey: {
					name: "Claude Code 自己的登录",
					// Nothing is read or stored here: `claude` owns its login. This only says whether the program exists.
					async resolve() {
						return findClaude() ? { auth: { apiKey: "claude-code-cli" }, source: "claude 程序" } : undefined;
					},
				},
			},
			models: shared.models as any,
			api: { stream: streamSimple, streamSimple } as any,
		}) as any),
		settings: [
			{
				id: "context-length",
				label: "上下文长度",
				description: "Claude Code 快到这个长度时自己压缩，大约提前 34K。可填 100K 到 1M，例如 300k，下一轮生效。",
				placeholder: "1M",
				get: () => formatTokens(readContextWindow()),
				set: (value: string) => {
					const tokens = parseContextWindow(value);
					if (!tokens) throw new Error("上下文长度要在 100K 到 1M 之间，例如 300k。");
					saveContextWindow(tokens);
				},
			},
		],
	} as any);

	const usingClaudeCode = (model: any) => model?.provider === PROVIDER_ID;
	/** The card tool means nothing to other models, so it is only active while this provider is. */
	const syncActiveTools = (model: any) => {
		const active = pi.getActiveTools();
		const present = active.includes(PASSTHROUGH_TOOL);
		if (usingClaudeCode(model) && !present) pi.setActiveTools([...active, PASSTHROUGH_TOOL]);
		if (!usingClaudeCode(model) && present) pi.setActiveTools(active.filter((name) => name !== PASSTHROUGH_TOOL));
	};

	pi.registerTool({
		name: PASSTHROUGH_TOOL,
		label: "Claude Code",
		description:
			"Internal to the Claude Code provider: shows a tool Claude Code is running by itself and waits for its result. Never call this directly.",
		parameters: Type.Object({ tool: Type.String(), input: Type.Any() }),
		async execute(id: string, _params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			const session = shared.sessions.get(ctx.sessionManager.getSessionId());
			const pending = session?.takeToolResult(id);
			if (!session || !pending) throw new Error("Claude Code 已不再等待这个工具的结果。");
			const onAbort = () => session.interrupt();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const block = await pending;
				const parts =
					typeof block.content === "string" ? [{ type: "text", text: block.content }] : (block.content ?? []);
				const content = parts
					.map((part: any) =>
						part.type === "image"
							? { type: "image", data: part.source?.data, mimeType: part.source?.media_type }
							: { type: "text", text: String(part.text ?? part.tool_name ?? "").slice(0, MAX_CARD_CHARS) },
					)
					.filter((part: any) => part.type === "image" || part.text);
				if (block.is_error) throw new Error(plainText(content) || "工具失败");
				return { content: content.length ? content : [{ type: "text", text: "(no output)" }], details: {} };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	} as any);

	// `claude` may wait for an app tool before starting its own next tool, while MyHarness only asks the provider to go on
	// once every card of the round is done. So each app tool's answer goes back the moment it finishes, not next round.
	pi.on("tool_execution_end", async (event: any, ctx: any) => {
		shared.sessions.get(ctx.sessionManager.getSessionId())?.deliverAppResult({
			toolCallId: event.toolCallId,
			content: event.result?.content,
			isError: event.isError,
		});
	});

	/**
	 * An earlier version of this extension recorded the sum of a turn's requests as its usage, which reads as millions of
	 * tokens and blocks the chat. Such a number cannot be a context's size, so it is dropped here, in memory only; MyHarness
	 * then estimates from the messages until the next real answer. The session file stays as it was.
	 */
	const forgetImpossibleUsage = (ctx: any) => {
		const window = readContextWindow();
		for (const entry of ctx.sessionManager.getBranch()) {
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role !== "assistant" || message.provider !== PROVIDER_ID || !message.usage) continue;
			if (message.usage.totalTokens > window) message.usage = zeroUsage();
		}
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		shared.contexts.set(ctx.sessionManager.getSessionId(), ctx);
		syncActiveTools(ctx.model);
		forgetImpossibleUsage(ctx);
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		shared.contexts.set(ctx.sessionManager.getSessionId(), ctx);
		syncActiveTools(event.model);
	});
	pi.registerCommand("context-length", {
		description: "设置 Claude Code 自动压缩用的上下文长度，例如 /context-length 300k",
		handler: async (args: string, ctx: any) => {
			const current = readContextWindow();
			const label = (tokens: number) =>
				tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`;
			let text = args?.trim();
			if (!text && ctx.hasUI) {
				text = await ctx.ui.select(`上下文长度（现在是 ${label(current)}）`, [
					"200K",
					"400K",
					"600K",
					"800K",
					"1M",
				]);
				if (!text) return;
			}
			const tokens = text ? parseContextWindow(text) : undefined;
			if (!tokens) {
				ctx.ui.notify(
					text ? "上下文长度要在 100K 到 1M 之间，例如 300k。" : `现在的上下文长度是 ${label(current)}。`,
					text ? "error" : "info",
				);
				return;
			}
			saveContextWindow(tokens);
			ctx.ui.notify(`上下文长度已设为 ${label(tokens)}，Claude Code 下一轮起按它自动压缩。`, "info");
		},
	} as any);

	const sessionIdOf = (ctx: any): string => ctx.sessionManager.getSessionId();
	pi.on("agent_start", async (_event: any, ctx: any) => {
		shared.compacting.delete(sessionIdOf(ctx));
	});
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!usingClaudeCode(ctx.model)) return undefined;
		const sessionId = sessionIdOf(ctx);
		// Only moving to a model with a smaller window, or a chat `claude` has not seen, is left to MyHarness's summary.
		if (event.reason !== "manual" || !readLinks()[sessionId]) {
			shared.compacting.add(sessionId);
			return undefined;
		}
		const session = shared.sessions.get(sessionId) ?? new CliSession(sessionId);
		const result = await session.compact(ctx.model, event.customInstructions, event.signal);
		if (!result) {
			ctx.ui.notify("Claude Code 没有完成这次压缩。", "error");
			return { cancel: true };
		}
		return {
			compaction: {
				summary: result.summary || "Claude Code compacted this chat's context.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
			},
		};
	});
	pi.on("session_compact", async (_event: any, ctx: any) => {
		shared.compacting.delete(sessionIdOf(ctx));
	});
	// Moving to another branch of the chat leaves the Claude Code conversation behind: rebuild it from the branch.
	pi.on("session_tree", async (_event: any, ctx: any) => {
		const sessionId = ctx.sessionManager.getSessionId();
		shared.sessions.get(sessionId)?.close();
		shared.sessions.delete(sessionId);
		writeLink(sessionId, undefined);
	});
	// A run can end between two tool rounds (Stop, Compact now), with no provider call there to pass that on. `claude` would
	// carry on alone, and every MyHarness tool it called would wait for a card that never runs.
	pi.on("agent_end", async (_event: any, ctx: any) => {
		shared.sessions.get(ctx.sessionManager.getSessionId())?.interrupt();
	});
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = ctx.sessionManager.getSessionId();
		shared.sessions.get(sessionId)?.close();
		shared.sessions.delete(sessionId);
		shared.contexts.delete(sessionId);
	});
}
