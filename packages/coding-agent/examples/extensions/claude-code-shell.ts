/**
 * Claude Code shell: MyHarness is the agent; the user's own, unmodified `claude` program only carries its requests on
 * the user's Claude subscription.
 *
 * A chat on this provider gets what a chat on any other provider gets: MyHarness's system prompt (built-in prompt, the
 * mode's personal prompt, the model's own prompt, project and workspace context), MyHarness's tools under their own
 * names with MyHarness's cards and approvals, MyHarness's record of the conversation, and MyHarness's compaction.
 * `claude` (run the way its documentation describes, `claude -p` with stream-json on stdin and stdout) adds none of its
 * own:
 * - Its built-in tools are off (`--tools ""`). MyHarness's tools come from an SDK-hosted MCP server that this file
 *   answers over the control channel, under their own names (CLAUDE_AGENT_SDK_MCP_NO_PREFIX). A call comes back through
 *   the provider as an ordinary tool call, so MyHarness runs it with its own approval and card, and the result MyHarness
 *   records is the one `claude` gets.
 * - The system prompt is MyHarness's, given in the initialize request and rendered fresh for every request
 *   (systemPromptSnapshot false). A changed prompt applies from the next turn on: `claude` only reads it when it starts,
 *   and starting it again between two tool rounds would drop the thinking of the turn under way.
 * - The output limit of a request is MyHarness's for the model (maxTokens, CLAUDE_CODE_MAX_OUTPUT_TOKENS), not
 *   `claude`'s own (128K on Opus). A request that reaches it ends the round as cut off ("length") and `claude` is ended:
 *   it would otherwise ask the model by itself to go on, up to three times, each a request as long as the first,
 *   unseen by MyHarness. The task goes on through MyHarness instead, as many times as it takes: tool calls in the cut
 *   response are failed and asked for again, and a cut response without one is followed by a note (OUTPUT_LIMIT_NOTE)
 *   that asks the model to go on more briefly. Each of those requests is a round of its own, with its own usage.
 * - CLAUDE.md files, auto memory, skills and slash commands, settings files (and with them hooks, plugins, output
 *   styles), other MCP servers, claude.ai connectors, tool search and its own compaction are switched off (LAUNCH_ENV,
 *   launchArgs).
 * What stays is what the program does not let go of (seen in its requests and transcripts, version 2.1.317):
 * - the identity line it puts first ("You are a Claude agent, built on Anthropic's Claude Agent SDK."), after a billing
 *   line (`x-anthropic-billing-header: …`);
 * - once per conversation, a block of its own: the environment (working directory, whether it is a Git repository,
 *   platform, shell, OS version, a rule about downloaded files), the model's name and knowledge cutoff, today's date
 *   and, signed in with a Claude account, the account's email address. Only its bare mode leaves these out, and bare
 *   mode cannot use the subscription's login;
 * - its wording around a message the user sends while it works, and what it says when a request fails;
 * - how it sends a request (cache marks, effort, retries).
 *
 * The provider never talks to Anthropic and never touches credentials: `claude` uses its own login.
 *
 * What is left of the subscription's plan limits (the 5-hour and the weekly window) shows in the status bar of every
 * Claude Code chat, the same in all of them: the limits belong to the subscription, not to a chat. Any chat's `claude`
 * reports them with the answers it gets (rate_limit_event), and a chat that opens with none known or only old ones, or a
 * window that resets, has a short-lived `claude` asked for them the way its own /usage does (get_usage, with no model
 * request). The usage endpoint behind it refuses frequent questions, so they are few (LIMITS_*).
 *
 * MyHarness's record is the conversation. `claude` keeps its transcript only as a cache. A chat's `claude` goes on, or is
 * resumed at the end of the last turn that ended cleanly (`--resume-session-at`), only while MyHarness's record still
 * starts with exactly the messages it holds (messageKey); it is then sent only what it has not seen. Otherwise a new
 * `claude` conversation gets the earlier messages as text. A process stays open for an hour after its last turn, the
 * lifetime of the subscription's prompt cache. A side request that shares the chat's history, such as MyHarness's
 * compaction summary, runs in a fork of the chat's `claude` conversation, so it reads the chat's cached prefix.
 *
 * Nothing of `claude` runs after its reply: MyHarness's own tools (background jobs, schedules, sub-agents) are the only
 * ones it has, and MyHarness's system prompt says how they report back.
 *
 * The Windows installer carries this file and loads it by itself. From source, copy it to ~/.myharness/agent/extensions/
 * and restart MyHarness; a copy there takes over from the bundled one. `claude` must be installed and signed in on that
 * computer.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createAssistantMessageEventStream, createProvider, parseStreamingJson } from "@myharness/ai";
import type { ExtensionAPI } from "@myharness/coding-agent";

const PROVIDER_ID = "claude-code";
/** The MCP server that offers MyHarness's tools. `claude` reaches it over the control channel of its stdin and stdout. */
export const MCP_SERVER = "myharness";
/** The note that sends a task on after a response cut off at the output limit with no tool call in it. */
export const OUTPUT_LIMIT_NOTE = "claude-code-output-limit";
/** An idle `claude` closes after this long: the subscription's prompt cache lives an hour. */
export const IDLE_CLOSE_MS = 60 * 60_000;
/** MyHarness's tools can wait for the user, such as a sign-in. */
const APP_TOOL_TIMEOUT_MS = 24 * 3600_000;
/** What `claude` puts in an MCP call's `_meta`: the id of its tool_use, which is also the id of MyHarness's card. */
const TOOL_USE_ID_META = "claudecode/toolUseId";
/** A call MyHarness never saw is answered after this long instead of waiting for a card that never runs. */
const UNSEEN_CALL_MS = 60_000;
const INITIALIZE_TIMEOUT_MS = 60_000;
/** A process that has not ended this long after its input closed is ended. */
const CLOSE_GRACE_MS = 3_000;
const MAX_TOOL_ARGS_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_TRANSCRIPT_CHARS = 800_000;
const MAX_TRANSCRIPT_IMAGES = 20;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const MIN_CONTEXT_WINDOW = 100_000;
/** Links of earlier versions, whose `claude` kept its own prompt and tools, carry no version and are never resumed. */
const LINK_VERSION = 2;
/** A Claude Code chat that opens asks `claude` for the plan limits when the newest reading is older than this. */
const LIMITS_FRESH_MS = 5 * 60_000;
/** At most one such question a minute, and none for ten minutes after one failed: the usage endpoint refuses many. */
const LIMITS_MIN_INTERVAL_MS = 60_000;
const LIMITS_RETRY_MS = 10 * 60_000;
const LIMITS_TIMEOUT_MS = 30_000;
/** A window that reset is asked about this long after its reset time. */
const LIMITS_RESET_DELAY_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Settings `claude` gets on its command line; no settings file is read (`--setting-sources ""`). */
export const FLAG_SETTINGS = { autoCompactEnabled: false, disableAllHooks: true };

/**
 * Every part of Claude Code that would add instructions, tools or context of its own, switched off. The variables are
 * the program's own; one it does not know is ignored.
 */
export const LAUNCH_ENV: Readonly<Record<string, string>> = {
	// No CLAUDE.md of any level (managed, user, project, local, rules, nested), and no auto memory.
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	// None of the user's Claude Code customizations (skills, plugins, hooks, MCP servers, commands, agents, output
	// styles); its sign-in stays.
	CLAUDE_CODE_SAFE_MODE: "1",
	// Nothing it would add to the conversation by itself: files named in a message, reminders, and the
	// "<total_tokens>N tokens left</total_tokens>" note after every message and tool result.
	CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
	CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
	// MyHarness's tools keep the names MyHarness's prompt uses, without the mcp__<server>__ prefix.
	CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1",
	// No connectors of the user's claude.ai account.
	ENABLE_CLAUDEAI_MCP_SERVERS: "false",
	// Every tool's definition is in every request: none is deferred behind a search tool.
	ENABLE_TOOL_SEARCH: "false",
	// MyHarness compacts with its own prompt; `claude` never does, also not when a request is too long.
	DISABLE_AUTO_COMPACT: "1",
	DISABLE_COMPACT: "1",
	// `claude` gives up on an MCP tool after 60 s by default.
	MCP_TOOL_TIMEOUT: String(APP_TOOL_TIMEOUT_MS),
};

/**
 * Variables that would switch `claude` away from the user's own login (or to API-key-only bare mode), or confuse it
 * about where it runs.
 */
export const STRIPPED_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_SIMPLE",
	"ELECTRON_RUN_AS_NODE",
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
];

const MODELS = [
	{ id: "claude-opus-5-5", name: "Claude Code · Opus 5.5" },
	{ id: "claude-sonnet-5-5", name: "Claude Code · Sonnet 5.5" },
	{ id: "claude-fable-5-1", name: "Claude Code · Fable 5.1" },
	{ id: "claude-haiku-5-5", name: "Claude Code · Haiku 5.5" },
];

// One registry per process: every chat's extension instance shares the same `claude` children.
type Shared = {
	chats: Map<string, Chat>;
	contexts: Map<string, any>;
	/** Chats whose next request is MyHarness's compaction summary, not a turn of the conversation. */
	compacting: Set<string>;
	runs: Set<ClaudeRun>;
	models?: any[];
	exitHook?: boolean;
	/** The subscription's plan limits as seen last by any chat, shown in every Claude Code chat. */
	limits?: Limits;
	/** The get_usage question under way, when the last one was asked, and when one failed last. */
	limitsQuery?: Promise<void>;
	limitsQueriedAt?: number;
	limitsFailedAt?: number;
	/** Fires when the next window resets. */
	limitsTimer?: ReturnType<typeof setTimeout>;
};
const SHARED_KEY = Symbol.for("myharness.claude-code-shell.v2");
const shared: Shared = (globalThis as any)[SHARED_KEY] ?? {
	chats: new Map(),
	contexts: new Map(),
	compacting: new Set(),
	runs: new Set(),
};
(globalThis as any)[SHARED_KEY] = shared;

const dataDir = () =>
	path.join(
		process.env.MYHARNESS_CODING_AGENT_DIR || path.join(os.homedir(), ".myharness", "agent"),
		"claude-code-shell",
	);

/** One JSON line per decision when MYHARNESS_CLAUDE_SHELL_TRACE names a file (labs and diagnosis). */
function trace(record: Record<string, unknown>): void {
	const file = process.env.MYHARNESS_CLAUDE_SHELL_TRACE;
	if (!file) return;
	try {
		fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
	} catch {}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------------------------------
// How `claude` is started
// ---------------------------------------------------------------------------------------------------------------------

export type LaunchOptions = {
	model: string;
	effort?: string;
	/** `claude`'s conversation to continue, and the message of it to continue after. */
	resume?: { id: string; at?: string };
	/** A side request: a new conversation that starts as a copy of `resume`. */
	fork?: boolean;
	/** Whether `claude` keeps a transcript of this conversation (only a chat's own conversation does). */
	persist: boolean;
};

export function launchArgs(options: LaunchOptions): string[] {
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		options.model,
		// None of Claude Code's own tools, no settings files, only MyHarness's MCP server, no skills or slash commands.
		"--tools",
		"",
		"--setting-sources",
		"",
		"--settings",
		JSON.stringify(FLAG_SETTINGS),
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--no-chrome",
		// MyHarness applies its own approval when a call comes back through the provider.
		"--permission-mode",
		"bypassPermissions",
		"--permission-prompt-tool",
		"stdio",
	];
	if (options.effort) args.push("--effort", options.effort);
	if (options.resume) {
		args.push("--resume", options.resume.id);
		if (options.resume.at) args.push("--resume-session-at", options.resume.at);
		if (options.fork) args.push("--fork-session");
	}
	if (!options.persist) args.push("--no-session-persistence");
	return args;
}

export function launchEnv(base: NodeJS.ProcessEnv, oneShot: boolean, maxOutputTokens?: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of STRIPPED_ENV) delete env[name];
	Object.assign(env, LAUNCH_ENV);
	// A request whose prefix no other request shares is not worth an hour of cache.
	if (oneShot) env.CLAUDE_CODE_PROMPT_CACHE_TTL = "5m";
	// MyHarness's output limit for the model in place of `claude`'s own: it bounds a request whose thinking runs on.
	if (maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
	return env;
}

/**
 * What the model reads before it goes on after a response cut off at the output limit with no tool call in it. The
 * thinking of a cut-off request is gone (`claude` keeps none of it either), so a response that wrote nothing is asked
 * to go on more briefly, and one that wrote text to go on from where it stopped.
 */
export function outputLimitNote(message: any): string {
	const wrote = partsOf(message).some((part) => part.type === "text" && String(part.text ?? "").trim());
	return wrote
		? "[system-reminder] Your last response was cut off at the output limit. Go on from where it stopped, without repeating what it already wrote, and keep each response well within the limit: split large work into smaller steps."
		: "[system-reminder] Your last response reached the output limit while still thinking, before it wrote any text or tool call, and that thinking is lost. Go on with the task from the conversation above: think much more briefly, and write your answer or next tool call well within the limit, splitting large work into smaller steps.";
}

/**
 * The most a request may write, thinking included: the model's maxTokens, as on MyHarness's own Anthropic requests. A
 * smaller cap a caller asks for is not passed on, because `claude` cannot switch thinking off and would spend it all on
 * thinking; and the cap stays the same for every request of a chat, because `claude` only reads it when it starts.
 */
export function outputLimitFor(model: any): number | undefined {
	const limit = Math.floor(Number(model?.maxTokens));
	return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

/** The first line `claude` reads: MyHarness's system prompt in place of Claude Code's, and MyHarness's MCP server. */
export function initializeRequest(systemPrompt: string, withTools: boolean): Record<string, unknown> {
	return {
		subtype: "initialize",
		systemPrompt: [systemPrompt],
		systemPromptSnapshot: false,
		...(withTools
			? {
					sdkMcpServers: [MCP_SERVER],
					sdkMcpServerConfigs: { [MCP_SERVER]: { timeout: APP_TOOL_TIMEOUT_MS } },
				}
			: {}),
	};
}

/** MyHarness's tools as `tools/list` returns them. */
export function toolList(tools: any[]): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		inputSchema: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })),
	}));
}

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

// ---------------------------------------------------------------------------------------------------------------------
// MyHarness's record and the conversation `claude` holds
// ---------------------------------------------------------------------------------------------------------------------

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function partsOf(message: any): any[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
}

function textOf(parts: any[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** A message MyHarness adds anew to every request (the reminder with the working directory and model) and never keeps. */
export const isTransient = (message: any) => message.role === "user" && !message.timestamp;

/**
 * What identifies a message of MyHarness's record, for telling whether `claude`'s conversation still matches it. None
 * for a transient message, and none for an assistant message that ended in an error or was stopped: providers leave
 * those out of a request. A user message is told by what the model reads, not by its timestamp: MyHarness stamps a note
 * it adds (the local time) when making it and again a few milliseconds later when writing it down, and a request built
 * from the session file (after a restart, or for the compaction summary) carries the written stamp.
 */
export function messageKey(message: any): string | undefined {
	if (message.role === "assistant") {
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		if (message.responseId) return `a:${message.responseId}`;
		const calls = partsOf(message)
			.filter((part) => part.type === "toolCall")
			.map((part) => part.id)
			.join(",");
		return `a:${sha(textOf(partsOf(message))).slice(0, 16)}:${calls}`;
	}
	if (message.role === "toolResult") return `t:${message.toolCallId}`;
	if (message.role === "user" && !isTransient(message)) {
		const parts = partsOf(message);
		const images = parts
			.filter((part) => part.type === "image")
			.map((part) => String(part.data ?? "").length)
			.join(",");
		return `u:${sha(textOf(parts)).slice(0, 16)}:${images}`;
	}
	return undefined;
}

export type Keyed = { message: any; key: string };

export function keyedMessages(messages: any[]): Keyed[] {
	const keyed: Keyed[] = [];
	for (const message of messages) {
		const key = messageKey(message);
		if (key) keyed.push({ message, key });
	}
	return keyed;
}

export const hashKeys = (keys: string[]) => sha(keys.join("\n"));

export function startsWith(keyed: Keyed[], keys: string[]): boolean {
	if (keyed.length < keys.length) return false;
	for (let i = 0; i < keys.length; i++) if (keyed[i].key !== keys[i]) return false;
	return true;
}

/** A user message's parts as Anthropic content blocks. */
export function userContent(message: any): any[] {
	return partsOf(message)
		.filter((part) => part.type === "text" || part.type === "image")
		.map((part) =>
			part.type === "image"
				? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
				: { type: "text", text: part.text ?? "" },
		);
}

function transcriptLine(message: any, image: (part: any) => string): string {
	const parts = partsOf(message);
	if (message.role === "toolResult") {
		const text = parts.map((part) => (part.type === "image" ? image(part) : (part.text ?? ""))).join("\n");
		const clipped = text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)} ...` : text;
		return `tool result (${message.toolName}${message.isError ? ", error" : ""}): ${clipped}`;
	}
	const pieces = parts
		.map((part) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "image") return image(part);
			if (part.type === "toolCall") {
				const args = JSON.stringify(part.arguments ?? {});
				return `[called ${part.name} ${args.length > MAX_TOOL_ARGS_CHARS ? `${args.slice(0, MAX_TOOL_ARGS_CHARS)} ...` : args}]`;
			}
			return "";
		})
		.filter(Boolean);
	return pieces.length ? `${message.role}: ${pieces.join("\n")}` : "";
}

/**
 * Messages of MyHarness's record that `claude`'s conversation never held, as one text block (and their newest images),
 * for a conversation that starts anew or missed some messages. Newest first under a size limit, so a limit only ever
 * costs the oldest messages.
 */
export function earlierBlocks(messages: any[]): any[] {
	let first = messages.length;
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const size = transcriptLine(messages[i], () => "[image]").length;
		if (first < messages.length && total + size > MAX_TRANSCRIPT_CHARS) break;
		total += size;
		first = i;
	}
	const included = messages.slice(first);
	const kept = new Set<any>();
	for (let i = included.length - 1; i >= 0 && kept.size < MAX_TRANSCRIPT_IMAGES; i--) {
		const images = partsOf(included[i]).filter((part) => part.type === "image" && part.data);
		for (let j = images.length - 1; j >= 0 && kept.size < MAX_TRANSCRIPT_IMAGES; j--) kept.add(images[j]);
	}
	const attached: any[] = [];
	const lines = included
		.map((message) =>
			transcriptLine(message, (part) => {
				if (!kept.has(part)) return "[image]";
				attached.push(part);
				return `[image ${attached.length}]`;
			}),
		)
		.filter(Boolean);
	if (!lines.length && !attached.length) return [];
	const omitted = first > 0 ? `\n(${first} older messages are not included.)` : "";
	const blocks: any[] = [
		{
			type: "text",
			text: `<earlier-conversation>\nMessages of this chat that were not part of this conversation, oldest first:${omitted}\n\n${lines.join("\n\n")}\n</earlier-conversation>`,
		},
	];
	attached.forEach((part, index) => {
		blocks.push({ type: "text", text: `[image ${index + 1}]` });
		blocks.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
	});
	return blocks;
}

/**
 * What to send `claude` for the messages it has not seen: the earlier ones as text, then the user's newest messages as
 * they are. With no new user message (a turn resumed between two tool rounds), it is asked to go on.
 */
export function turnContent(rest: any[]): any[] {
	let cut = rest.length;
	while (cut > 0 && rest[cut - 1].role === "user") cut--;
	const content = [...earlierBlocks(rest.slice(0, cut)), ...rest.slice(cut).flatMap(userContent)];
	if (cut === rest.length) content.push({ type: "text", text: "Continue where you left off." });
	return content;
}

// Which `claude` conversation belongs to which chat, at the end of its last clean turn

type Link = {
	v: number;
	claudeSessionId: string;
	cwd: string;
	/** How many keyed messages of MyHarness's record the conversation holds, and their hashKeys. */
	count: number;
	hash: string;
	/** `claude`'s last message of that turn, where a resumed conversation continues. */
	uuid?: string;
	/** sha of the transient text the conversation was given last. */
	reminder: string;
};

const linkFile = (sessionId: string) => path.join(dataDir(), "links", `${encodeURIComponent(sessionId)}.json`);

function readLink(sessionId: string): Link | undefined {
	try {
		const link = JSON.parse(fs.readFileSync(linkFile(sessionId), "utf8"));
		return link?.v === LINK_VERSION && typeof link.claudeSessionId === "string" ? link : undefined;
	} catch {
		return undefined;
	}
}

function writeLink(sessionId: string, link: Link | undefined): void {
	const file = linkFile(sessionId);
	try {
		if (!link) {
			fs.rmSync(file, { force: true });
			return;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(link, null, "\t"));
		fs.renameSync(temporary, file);
	} catch {}
}

/** A link fits a request when MyHarness's record still starts with the messages the conversation holds. */
function linkFits(link: Link | undefined, keyed: Keyed[], cwd: string): link is Link {
	return (
		!!link &&
		path.resolve(link.cwd) === path.resolve(cwd) &&
		keyed.length >= link.count &&
		hashKeys(keyed.slice(0, link.count).map((item) => item.key)) === link.hash
	);
}

// Context length, set by the user in Settings → Providers → Claude Code or /context-length

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
// One running `claude`
// ---------------------------------------------------------------------------------------------------------------------

type RunHandlers = {
	onEvent: (event: any) => void;
	onControl: (request: any) => Promise<object>;
	onExit: (problem: string | undefined) => void;
};

class ClaudeRun {
	readonly child: ChildProcess;
	claudeSessionId?: string;
	exited = false;
	private readonly handlers: RunHandlers;
	private stderr = "";
	private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();

	constructor(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, handlers: RunHandlers) {
		this.handlers = handlers;
		const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		shared.runs.add(this);
		child.stderr?.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-2000);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.finish(error.message));
		// "close" comes after the last line of its output has been read, "exit" may come before.
		child.on("close", (code) => this.finish(code ? `claude 退出，代码 ${code}` : undefined));
		createInterface({ input: child.stdout! }).on("line", (line) => {
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			this.onLine(event);
		});
	}

	private onLine(event: any): void {
		if (event.type === "control_response") {
			const response = event.response ?? {};
			const waiting = this.pending.get(response.request_id);
			if (!waiting) return;
			this.pending.delete(response.request_id);
			if (response.subtype === "error") waiting.reject(new Error(response.error || "claude 拒绝了这个请求"));
			else waiting.resolve(response.response ?? {});
			return;
		}
		if (event.type === "control_request") {
			void this.answer(event);
			return;
		}
		if (event.type === "control_cancel_request" || event.type === "keep_alive") return;
		if (event.type === "system" && event.subtype === "init") this.claudeSessionId = event.session_id;
		this.handlers.onEvent(event);
	}

	private async answer(event: any): Promise<void> {
		let response: object;
		try {
			response = {
				subtype: "success",
				request_id: event.request_id,
				response: await this.handlers.onControl(event.request ?? {}),
			};
		} catch (error) {
			response = { subtype: "error", request_id: event.request_id, error: errorText(error) };
		}
		this.send({ type: "control_response", response });
	}

	send(value: unknown): void {
		if (!this.exited) this.child.stdin?.write(`${JSON.stringify(value)}\n`);
	}

	request(body: Record<string, unknown>, timeoutMs: number): Promise<any> {
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			if (this.exited) {
				reject(new Error("claude 已退出"));
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`claude 没有回应 ${body.subtype} 请求`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(requestId, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send({ type: "control_request", request_id: requestId, request: body });
		});
	}

	sendUser(content: any[]): void {
		this.send({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } });
	}

	private finish(problem: string | undefined): void {
		if (this.exited) return;
		this.exited = true;
		shared.runs.delete(this);
		const detail = problem && this.stderr.trim() ? `${problem}\n${this.stderr.trim()}` : problem;
		for (const waiting of this.pending.values()) waiting.reject(new Error(detail ?? "claude 已退出"));
		this.pending.clear();
		this.handlers.onExit(detail);
	}

	/** Ends the program. `now` for a turn that must not go on alone; otherwise it may first finish writing. */
	stop(now: boolean): void {
		if (this.exited) return;
		this.child.stdin?.end();
		if (now) {
			this.child.kill();
			return;
		}
		setTimeout(() => {
			if (!this.exited) this.child.kill();
		}, CLOSE_GRACE_MS).unref();
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The subscription's plan limits, shown in every Claude Code chat
// ---------------------------------------------------------------------------------------------------------------------

/** One plan limit window: how much of it is used (0-100), when it resets and when that was seen (ms since 1970). */
export type LimitWindow = { used: number; resetsAt?: number; observedAt: number };
export type Limits = { five_hour?: LimitWindow; seven_day?: LimitWindow };
const LIMIT_WINDOWS = ["five_hour", "seven_day"] as const;

/** A rate_limit_event, which `claude` sends with an answer when a window's whole percentage or reset time changed. */
export function limitsFromEvent(info: any, observedAt: number): Limits {
	const limits: Limits = {};
	for (const name of LIMIT_WINDOWS) {
		const window = info?.unifiedWindows?.[name];
		// A fraction here, and the reset time in seconds.
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
		const resetsAt = Number(window.resetsAt) * 1000;
		limits[name] = {
			used: window.utilization * 100,
			resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined,
			observedAt,
		};
	}
	return limits;
}

/** `claude`'s answer to get_usage: the numbers of its /usage and of claude.ai's usage page. */
export function limitsFromUsage(answer: any, observedAt: number): Limits {
	const limits: Limits = {};
	for (const name of LIMIT_WINDOWS) {
		const window = answer?.rate_limits?.[name];
		// A percentage here, and the reset time as an ISO time (null for a window that has not started).
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
		const resetsAt = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
		limits[name] = {
			used: window.utilization,
			resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
			observedAt,
		};
	}
	return limits;
}

/** Each window as seen last: a reading older than the one held (a slow get_usage answer) does not replace it. */
export function mergeLimits(current: Limits, next: Limits): Limits {
	const merged: Limits = { ...current };
	for (const name of LIMIT_WINDOWS) {
		const window = next[name];
		const held = current[name];
		if (window && !(held && held.observedAt > window.observedAt)) merged[name] = window;
	}
	return merged;
}

const limitExpired = (window: LimitWindow, now: number) => window.resetsAt !== undefined && window.resetsAt <= now;

/** The status: what is left of each window, or "-" for one not known, or known only from before it reset. */
export function limitsText(limits: Limits, now: number): string | undefined {
	if (!LIMIT_WINDOWS.some((name) => limits[name])) return undefined;
	const left = (window: LimitWindow | undefined) =>
		window && !limitExpired(window, now) ? `${Math.max(0, Math.min(100, Math.round(100 - window.used)))}%` : "-";
	return `Claude 额度剩余 5h ${left(limits.five_hour)} · 7d ${left(limits.seven_day)}`;
}

/** Whether a chat that opens asks `claude`: nothing is known, a window has reset, or the newest reading is old. */
export function limitsNeedQuery(limits: Limits, now: number): boolean {
	const windows = LIMIT_WINDOWS.flatMap((name) => {
		const window = limits[name];
		return window ? [window] : [];
	});
	if (!windows.length || windows.some((window) => limitExpired(window, now))) return true;
	return now - Math.max(...windows.map((window) => window.observedAt)) >= LIMITS_FRESH_MS;
}

/** What get_usage needs of `claude`: none of its tools, settings, MCP servers or slash commands, and no transcript. */
const LIMITS_ARGS = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--tools",
	"",
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-chrome",
	"--no-session-persistence",
];

/** A context of a chat that has gone throws when read. */
function usesClaudeCode(ctx: any): boolean {
	try {
		return ctx?.model?.provider === PROVIDER_ID;
	} catch {
		return false;
	}
}

function setLimitsStatus(ctx: any, text: string | undefined): void {
	try {
		ctx?.ui?.setStatus?.(PROVIDER_ID, text);
	} catch {}
}

/** Every open Claude Code chat shows the same limits. */
function showLimits(): void {
	const text = limitsText(shared.limits ?? {}, Date.now());
	for (const ctx of shared.contexts.values()) if (usesClaudeCode(ctx)) setLimitsStatus(ctx, text);
}

function noteLimits(next: Limits, source: string): void {
	if (!LIMIT_WINDOWS.some((name) => next[name])) return;
	shared.limits = mergeLimits(shared.limits ?? {}, next);
	trace({ event: "limits", source, limits: shared.limits });
	showLimits();
	scheduleLimitsReset();
}

/** When a window resets, its old numbers go and `claude` is asked for the new ones. */
function scheduleLimitsReset(): void {
	if (shared.limitsTimer) clearTimeout(shared.limitsTimer);
	shared.limitsTimer = undefined;
	const now = Date.now();
	const next = Math.min(
		...LIMIT_WINDOWS.map((name) => shared.limits?.[name]?.resetsAt ?? Number.POSITIVE_INFINITY).filter(
			(at) => at > now,
		),
	);
	if (!Number.isFinite(next)) return;
	const timer = setTimeout(
		() => {
			if (shared.limitsTimer !== timer) return;
			shared.limitsTimer = undefined;
			showLimits();
			scheduleLimitsReset();
			if ([...shared.contexts.values()].some(usesClaudeCode)) void refreshLimits();
		},
		Math.min(next - now + LIMITS_RESET_DELAY_MS, MAX_TIMER_MS),
	);
	timer.unref?.();
	shared.limitsTimer = timer;
}

/** Asks `claude` for the plan limits, unless it was asked within the last minute or failed lately. */
function refreshLimits(): Promise<void> {
	if (shared.limitsQuery) return shared.limitsQuery;
	const now = Date.now();
	if (shared.limitsQueriedAt !== undefined && now - shared.limitsQueriedAt < LIMITS_MIN_INTERVAL_MS) {
		return Promise.resolve();
	}
	if (shared.limitsFailedAt !== undefined && now - shared.limitsFailedAt < LIMITS_RETRY_MS) return Promise.resolve();
	shared.limitsQueriedAt = now;
	const query: Promise<void> = queryLimits()
		.then((limits) => {
			shared.limitsFailedAt = undefined;
			noteLimits(limits, "get_usage");
		})
		.catch((error) => {
			shared.limitsFailedAt = Date.now();
			trace({ event: "limits", source: "get_usage", error: errorText(error) });
		})
		.finally(() => {
			if (shared.limitsQuery === query) shared.limitsQuery = undefined;
		});
	shared.limitsQuery = query;
	return query;
}

/**
 * A `claude` of its own answers get_usage and ends: no model request, about a second. It uses the user's login like
 * every other `claude` here; nothing reads it here.
 */
async function queryLimits(): Promise<Limits> {
	const binary = findClaude();
	if (!binary) throw new Error("找不到 claude 程序");
	const observedAt = Date.now();
	const run = new ClaudeRun(binary, LIMITS_ARGS, launchEnv(process.env, false), os.homedir(), {
		onEvent: () => {},
		onControl: async (request) => {
			throw new Error(`Unsupported: ${request.subtype}`);
		},
		onExit: () => {},
	});
	try {
		await run.request({ subtype: "initialize" }, INITIALIZE_TIMEOUT_MS);
		const answer = await run.request({ subtype: "get_usage", skip_behaviors: true }, LIMITS_TIMEOUT_MS);
		const limits = limitsFromUsage(answer, observedAt);
		if (!LIMIT_WINDOWS.some((name) => limits[name])) throw new Error("claude 没有给出额度");
		return limits;
	} finally {
		run.stop(false);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// A chat's conversation with `claude`, and side requests
// ---------------------------------------------------------------------------------------------------------------------

/** An app tool `claude` called: the card MyHarness runs and the MCP request `claude` sends meet here, in either order. */
type AppCall = {
	name: string;
	/** The arguments as stable JSON; unknown while they are still streaming. */
	key?: string;
	/** An MCP request belongs to this call. */
	claimed: boolean;
	result?: any;
	waiters: ((result: any) => void)[];
};
type AppRequest = { name: string; key: string; toolUseId?: string; done: (result: any) => void };
const appError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

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

/** The MyHarness tool a tool_use names. Should a `claude` ignore CLAUDE_AGENT_SDK_MCP_NO_PREFIX, the prefix comes off. */
function appToolName(name: string | undefined): string {
	const prefix = `mcp__${MCP_SERVER}__`;
	return name?.startsWith(prefix) ? name.slice(prefix.length) : (name ?? "");
}

type StartOptions = {
	model: any;
	effort?: string;
	maxOutputTokens?: number;
	systemPrompt: string;
	tools: any[];
	resume?: Link;
	fork?: boolean;
};

/**
 * A chat's conversation with `claude` (side false), or one side request (side true: a fork of the chat's conversation or
 * a one-off conversation, ended after its answer and never kept).
 */
class Chat {
	readonly sessionId: string;
	readonly side: boolean;
	run?: ClaudeRun;
	signature = "";
	/** sha of the system prompt the running `claude` was given. */
	prompt = "";
	/** Keys of the messages of MyHarness's record the conversation holds, in order. */
	synced: string[] = [];
	/** sha of the transient text the conversation was given last. */
	reminder = "";
	/** A turn was sent, and the provider has not yet passed on its end. */
	turnActive = false;
	/** `claude` changed its conversation by itself (it compacted): start again next time. */
	diverged = false;
	/** `claude`'s last assistant message so far, where a resumed conversation continues. */
	private lastUuid?: string;
	private tools: any[] = [];
	private queue: any[] = [];
	private waiter?: (event: any) => void;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private reported = false;
	/** App tool calls of this turn by tool_use id, in the order `claude` made them. */
	private appCalls = new Map<string, AppCall>();
	/** The calls of the round the provider passed on last; MyHarness's next request carries their results. */
	private roundCalls: string[] = [];
	/** MCP requests that arrived before the call they belong to was seen. */
	private unboundRequests: AppRequest[] = [];
	/** API messages of this turn that arrived piece by piece, whose whole copies are left out. */
	private streamed = new Set<string>();

	constructor(sessionId: string, side: boolean) {
		this.sessionId = sessionId;
		this.side = side;
	}

	get cwd(): string {
		return shared.contexts.get(this.sessionId)?.cwd ?? process.cwd();
	}

	async start(options: StartOptions): Promise<void> {
		const binary = findClaude();
		if (!binary) throw new Error("找不到 claude 程序。请先安装 Claude Code，或设置 MYHARNESS_CLAUDE_BIN。");
		this.tools = toolList(options.tools);
		const fork = !!(options.fork && options.resume);
		const args = launchArgs({
			model: options.model.id,
			effort: options.effort,
			resume: options.resume ? { id: options.resume.claudeSessionId, at: options.resume.uuid } : undefined,
			fork,
			persist: !this.side,
		});
		this.queue.length = 0;
		this.lastUuid = options.resume?.uuid;
		this.diverged = false;
		const env = launchEnv(process.env, this.side && !fork, options.maxOutputTokens);
		const run: ClaudeRun = new ClaudeRun(binary, args, env, this.cwd, {
			onEvent: (event) => {
				if (this.run === run) this.onEvent(event);
			},
			onControl: (request) => this.onControl(request),
			onExit: (problem) => {
				if (this.run !== run) return;
				this.run = undefined;
				this.turnActive = false;
				this.forgetAppCalls(problem ?? "claude 已退出");
				this.push({ type: "__exit", problem });
			},
		});
		this.run = run;
		trace({
			event: "start",
			chat: this.sessionId,
			side: this.side,
			args,
			maxOutputTokens: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
		});
		await run.request(initializeRequest(options.systemPrompt, this.tools.length > 0), INITIALIZE_TIMEOUT_MS);
	}

	/** Ends the program; `now` when a turn may still be running in it. */
	close(now = false): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const run = this.run;
		this.run = undefined;
		this.turnActive = false;
		this.synced = [];
		this.queue.length = 0;
		this.forgetAppCalls("已关闭");
		// A provider reading this chat now or next learns that nothing more comes.
		this.push({ type: "__closed" });
		run?.stop(now || this.side);
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

	/** A new turn: nothing left over may be taken for its answer, and no earlier call for one of its calls. */
	sendUser(content: any[]): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.queue.length = 0;
		this.forgetAppCalls("这一轮已经结束");
		this.streamed.clear();
		this.turnActive = true;
		this.run?.sendUser(content);
	}

	/** Between two tool rounds: a message the user wrote meanwhile, which `claude` takes into its next request. */
	sendDuringTurn(content: any[]): void {
		this.run?.sendUser(content);
	}

	/** The provider passed on a round of tool calls; MyHarness runs them and its next request brings the results. */
	endRound(calls: string[]): void {
		this.roundCalls = calls;
	}

	/** The turn ended cleanly: the conversation now holds exactly `synced`, which a later start may resume. */
	endTurn(): void {
		this.turnActive = false;
		this.roundCalls = [];
		if (this.side) return;
		const run = this.run;
		if (run?.claudeSessionId && !this.diverged) {
			writeLink(this.sessionId, {
				v: LINK_VERSION,
				claudeSessionId: run.claudeSessionId,
				cwd: this.cwd,
				count: this.synced.length,
				hash: hashKeys(this.synced),
				uuid: this.lastUuid,
				reminder: this.reminder,
			});
		}
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
		this.idleTimer.unref();
	}

	private onEvent(event: any): void {
		if (event.type === "rate_limit_event") {
			noteLimits(limitsFromEvent(event.rate_limit_info, Date.now()), "rate_limit_event");
		}
		if (event.type === "system" && event.subtype === "init") this.checkInit(event);
		// MyHarness compacts; should `claude` still have changed the conversation, it no longer matches the record.
		if (event.type === "system" && event.subtype === "compact_boundary") this.diverged = true;
		if (event.type === "assistant" && !event.parent_tool_use_id && event.uuid) this.lastUuid = event.uuid;
		this.expectAppCalls(event);
		if (event.type === "stream_event" || event.type === "assistant" || event.type === "result") this.push(event);
	}

	/** `claude` lists what it loaded: anything besides MyHarness's tools, or an API key in place of its login, is reported. */
	private checkInit(event: any): void {
		const offered = new Set(this.tools.map((tool) => tool.name));
		const extra = (event.tools ?? []).filter((name: string) => !offered.has(appToolName(name)));
		trace({ event: "init", chat: this.sessionId, tools: event.tools, extra, apiKeySource: event.apiKeySource });
		if (this.reported) return;
		this.reported = true;
		const ui = shared.contexts.get(this.sessionId)?.ui;
		if (event.apiKeySource && event.apiKeySource !== "none") {
			ui?.notify(`Claude Code 正在使用 ${event.apiKeySource} 的 API key，会按用量计费。`, "warning");
		}
		if (extra.length) ui?.notify(`Claude Code 还带了它自己的工具：${extra.join(", ")}`, "warning");
	}

	private async onControl(request: any): Promise<object> {
		if (request.subtype === "mcp_message") {
			if (request.server_name !== MCP_SERVER) throw new Error(`Unknown MCP server: ${request.server_name}`);
			return { mcp_response: await this.answerMcp(request.message ?? {}) };
		}
		if (request.subtype === "can_use_tool") {
			// Only MyHarness's tools exist here, and MyHarness applies its own approval when the call comes back.
			const known = this.tools.some((tool) => tool.name === appToolName(request.tool_name));
			return known
				? { behavior: "allow", updatedInput: request.input }
				: { behavior: "deny", message: "Only MyHarness's tools run here." };
		}
		throw new Error(`Unsupported: ${request.subtype}`);
	}

	private async answerMcp(message: any): Promise<any> {
		// A notification gets an empty result, the way the SDK's own hosts answer one.
		if (message.id === undefined || message.id === null) return { jsonrpc: "2.0", result: {}, id: 0 };
		const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
		switch (message.method) {
			case "initialize":
				return reply({
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: MCP_SERVER, version: "2.0.0" },
				});
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: this.tools });
			case "tools/call": {
				if (this.side) return reply(appError("MyHarness runs no tools for this request. Answer in text."));
				const toolUseId = message.params?._meta?.[TOOL_USE_ID_META];
				return reply(
					await this.waitForAppTool(
						appToolName(message.params?.name),
						message.params?.arguments ?? {},
						typeof toolUseId === "string" && toolUseId ? toolUseId : undefined,
					),
				);
			}
			default:
				return {
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: `Unsupported method: ${message.method}` },
				};
		}
	}

	// Pairing app tool calls with the MCP requests `claude` makes for them

	/**
	 * Tool calls are noted the moment `claude` reports them, before the provider reads that far: `claude` starts a tool as
	 * soon as its block is complete, so the MCP request can arrive before the provider has mapped the call.
	 */
	private expectAppCalls(event: any): void {
		if (event.parent_tool_use_id) return;
		const assistant = event.type === "assistant";
		const blocks = assistant
			? event.message?.content
			: event.type === "stream_event" && event.event?.type === "content_block_start"
				? [event.event.content_block]
				: [];
		for (const block of blocks ?? []) {
			if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
			// The arguments are complete only in the assistant message; a block that has just started has none yet.
			this.noteAppCall(block.id, appToolName(block.name), assistant ? block.input : undefined);
		}
	}

	/** An app tool call of the main conversation, from the stream or from the provider; the arguments may come later. */
	noteAppCall(id: string, name: string, args?: unknown): void {
		let call = this.appCalls.get(id);
		if (!call) {
			call = { name, claimed: false, waiters: [] };
			this.appCalls.set(id, call);
		}
		if (args !== undefined && call.key === undefined) call.key = stableJson(args);
		this.bindWaitingRequests();
	}

	/** A result of MyHarness's record: it goes to the MCP request of that very call, now or when it arrives. */
	deliverAppResult(message: any): void {
		this.settle(message.toolCallId, {
			content: partsOf(message).map((part: any) =>
				part.type === "image"
					? { type: "image", data: part.data, mimeType: part.mimeType }
					: { type: "text", text: part.text ?? "" },
			),
			isError: !!message.isError,
		});
	}

	/** Every call of the last round has an answer, so `claude` never waits for one MyHarness does not have. */
	settleRound(): void {
		for (const id of this.roundCalls) this.settle(id, appError("MyHarness 没有这次调用的结果。"));
		this.roundCalls = [];
	}

	private settle(id: string, result: any): void {
		const call = this.appCalls.get(id);
		if (!call || call.result !== undefined) return;
		call.result = result;
		for (const done of call.waiters.splice(0)) done(result);
	}

	/**
	 * `claude`'s MCP request for an app tool. It names the tool_use it belongs to (TOOL_USE_ID_META), so it gets exactly
	 * that card's result even when the same tool runs several times in a round.
	 */
	private waitForAppTool(name: string, args: unknown, toolUseId?: string): Promise<any> {
		return new Promise((done) => {
			const request: AppRequest = { name, key: stableJson(args), toolUseId, done };
			// Without streaming, this request is the first sign that the message with the call is complete.
			this.push({ type: "__tool_request" });
			if (this.bindRequest(request)) return;
			this.unboundRequests.push(request);
			setTimeout(() => {
				const index = this.unboundRequests.indexOf(request);
				if (index < 0) return;
				this.unboundRequests.splice(index, 1);
				done(appError("MyHarness 没有在这个对话里看到这次工具调用，所以没有运行它。"));
			}, UNSEEN_CALL_MS).unref();
		});
	}

	private bindRequest(request: AppRequest): boolean {
		const id = this.findAppCall(request);
		if (id === undefined) return false;
		const call = this.appCalls.get(id)!;
		call.claimed = true;
		if (call.result !== undefined) request.done(call.result);
		else call.waiters.push(request.done);
		return true;
	}

	/**
	 * The call a request belongs to: the one with its tool_use id when `claude` sends it. A `claude` that does not send
	 * it asks for one call at a time in the order it made them, so the request takes the first call of that tool no
	 * request has taken yet, preferring one with the same arguments.
	 */
	private findAppCall(request: AppRequest): string | undefined {
		if (request.toolUseId) return this.appCalls.has(request.toolUseId) ? request.toolUseId : undefined;
		let first: string | undefined;
		for (const [id, call] of this.appCalls) {
			if (call.claimed || call.name !== request.name) continue;
			if (call.key === request.key) return id;
			first ??= id;
		}
		return first;
	}

	private bindWaitingRequests(): void {
		for (let index = 0; index < this.unboundRequests.length; ) {
			if (this.bindRequest(this.unboundRequests[index])) this.unboundRequests.splice(index, 1);
			else index++;
		}
	}

	/** A turn ended or the program went away: nothing may stay waiting, and no old call may be paired with a new request. */
	private forgetAppCalls(reason: string): void {
		const error = appError(reason);
		for (const call of this.appCalls.values()) for (const done of call.waiters.splice(0)) done(error);
		for (const request of this.unboundRequests.splice(0)) request.done(error);
		this.appCalls.clear();
		this.roundCalls = [];
	}

	markStreamed(messageId: string | undefined): void {
		if (messageId) this.streamed.add(messageId);
	}

	wasStreamed(messageId: string | undefined): boolean {
		return !!messageId && this.streamed.has(messageId);
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

/** A tool `claude` uses as a MyHarness call, also while its arguments are still arriving. */
function shapeToolCall(id: string, name: string, input: any): any {
	return { type: "toolCall", id, name: appToolName(name), arguments: input };
}

/** What makes `claude` start again: everything it only reads when it starts, but the system prompt (see runTurn). */
function signatureOf(
	model: any,
	effort: string | undefined,
	maxOutputTokens: number | undefined,
	tools: any[],
	cwd: string,
): string {
	return sha(JSON.stringify([model.id, effort ?? "", maxOutputTokens ?? 0, toolList(tools), path.resolve(cwd)]));
}

function newOutput(model: any): any {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type Plan = "live" | "resume" | "fresh" | "fork" | "one-off";
type OpenBlock = { index: number; json: string; id?: string; name?: string };

/**
 * One request. A chat's own turn continues its `claude` conversation (as it is, resumed from the link, or anew); a side
 * request runs in a fork of that conversation when it shares its history, otherwise in a one-off conversation.
 */
async function runTurn(stream: any, chat: Chat, model: any, context: any, options: any): Promise<void> {
	const output = newOutput(model);
	let ended = false;
	const end = (event: any) => {
		if (ended) return;
		ended = true;
		stream.push(event);
		stream.end();
	};
	const fail = (reason: "aborted" | "error", message: string) => {
		output.stopReason = reason;
		output.errorMessage = message;
		end({ type: "error", reason, error: output });
	};
	stream.push({ type: "start", partial: output });
	const signal: AbortSignal | undefined = options?.signal;
	// Stop ends the program at once; the next turn resumes the last turn that ended cleanly.
	const onAbort = () => chat.close(true);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal?.aborted) return fail("aborted", "已中断");
		const messages: any[] = context.messages ?? [];
		const systemPrompt: string = context.systemPrompt ?? "";
		const tools: any[] = context.tools ?? [];
		const effort = effortFor(model, options?.reasoning);
		const maxOutputTokens = outputLimitFor(model);
		const signature = signatureOf(model, effort, maxOutputTokens, tools, chat.cwd);
		const prompt = sha(systemPrompt);
		const keyed = keyedMessages(messages);
		const transient = messages.filter(isTransient);
		const reminder = sha(JSON.stringify(transient.map((message) => partsOf(message))));

		// The conversation `claude` holds must be exactly the start of MyHarness's record, with these tools. A changed
		// system prompt waits for the turn to end: started again between two tool rounds, `claude` would get the turn so
		// far only as text, without its thinking, and the model would think it all over again.
		if (
			chat.run &&
			(chat.diverged ||
				chat.signature !== signature ||
				(chat.prompt !== prompt && !chat.turnActive) ||
				!startsWith(keyed, chat.synced))
		) {
			chat.close(true);
		}
		let plan = "live" as Plan;
		const begin = async (link: Link | undefined) => {
			chat.signature = signature;
			chat.prompt = prompt;
			await chat.start({
				model,
				effort,
				maxOutputTokens,
				systemPrompt,
				tools,
				resume: link,
				fork: chat.side && !!link,
			});
			chat.synced = link ? keyed.slice(0, link.count).map((item) => item.key) : [];
			chat.reminder = link ? link.reminder : "";
		};
		const startOver = async () => {
			chat.close(true);
			if (!chat.side) writeLink(chat.sessionId, undefined);
			plan = chat.side ? "one-off" : "fresh";
			await begin(undefined);
		};
		const openChat = async () => {
			const link = readLink(chat.sessionId);
			const fits = linkFits(link, keyed, chat.cwd) && (!chat.side || tools.length > 0);
			plan = fits ? (chat.side ? "fork" : "resume") : chat.side ? "one-off" : "fresh";
			trace({
				event: "open",
				chat: chat.sessionId,
				side: chat.side,
				plan,
				keyed: keyed.length,
				tools: tools.length,
				link: link && {
					count: link.count,
					cwd: path.resolve(link.cwd) === path.resolve(chat.cwd),
					history:
						keyed.length >= link.count &&
						hashKeys(keyed.slice(0, link.count).map((item) => item.key)) === link.hash,
				},
			});
			try {
				await begin(fits ? link : undefined);
			} catch (error) {
				// A remembered conversation that cannot be opened: start over with the chat's history.
				if (!fits || signal?.aborted) throw error;
				await startOver();
			}
		};
		if (!chat.run) await openChat();

		const send = () => {
			const rest = keyed.slice(chat.synced.length).map((item) => item.message);
			if (chat.turnActive) {
				// Between two tool rounds `claude` waits for the last round's results. A message the user wrote meanwhile goes
				// first, so that `claude` takes it into the same next request as the results.
				const written = rest.filter((message) => message.role === "user");
				if (written.length) chat.sendDuringTurn(written.flatMap(userContent));
				for (const message of rest) if (message.role === "toolResult") chat.deliverAppResult(message);
				chat.settleRound();
			} else {
				chat.sendUser([
					...(reminder !== chat.reminder ? transient.flatMap(userContent) : []),
					...turnContent(rest),
				]);
				chat.reminder = reminder;
			}
			chat.synced = keyed.map((item) => item.key);
			trace({
				event: "send",
				chat: chat.sessionId,
				plan,
				side: chat.side,
				held: chat.synced.length,
				rest: rest.length,
			});
		};
		send();

		const blocks = new Map<number, OpenBlock>();
		const calls: string[] = [];
		let received = false;
		let retried = false;
		/** The message being read arrived piece by piece (it ends with message_stop). */
		let streamedNow = false;
		/** Where the streamed message being read began, while its message_stop has not come. */
		let open: { content: number; calls: number } | undefined;
		/** What `claude` wrote in place of an answer when a request failed. */
		let failure: string | undefined;
		const finishRound = (reason: "toolUse" | "stop") => {
			output.stopReason = reason;
			if (!chat.side) {
				const key = messageKey(output);
				if (key) chat.synced.push(key);
				if (reason === "toolUse") chat.endRound([...calls]);
				else chat.endTurn();
			}
			trace({
				event: "round",
				chat: chat.sessionId,
				plan,
				side: chat.side,
				reason,
				usage: {
					input: output.usage.input,
					cacheRead: output.usage.cacheRead,
					cacheWrite: output.usage.cacheWrite,
				},
			});
			end({ type: "done", reason, message: output });
		};
		/** A whole (not streamed) message that ended at the output limit; more blocks of it may still come. */
		let cutOff: string | undefined;
		/**
		 * The request reached its output limit. `claude` would now ask the model by itself to go on, unseen here. MyHarness
		 * decides what follows a cut-off answer, as on every provider (calls in it are failed, an answer without calls ends
		 * the turn), so the program ends at once and the next request resumes the last turn that ended cleanly.
		 */
		const stopAtLimit = () => {
			chat.close(true);
			output.stopReason = "length";
			if (!chat.side) {
				const written = formatTokens(output.usage.output || maxOutputTokens || 0);
				shared.contexts
					.get(chat.sessionId)
					?.ui?.notify(
						`Claude Code 这一步写到了输出上限（${written} token），这次请求已停下，任务自动接着做。`,
						"warning",
					);
			}
			trace({
				event: "round",
				chat: chat.sessionId,
				plan,
				side: chat.side,
				reason: "length",
				output: output.usage.output,
			});
			end({ type: "done", reason: "length", message: output });
		};
		const addToolCall = (id: string, name: string, input: any, contentIndex?: number) => {
			const toolCall = shapeToolCall(id, name, input);
			chat.noteAppCall(id, toolCall.name, input);
			const index = contentIndex ?? output.content.push(toolCall) - 1;
			output.content[index] = toolCall;
			if (contentIndex === undefined) stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			calls.push(id);
		};
		/** A side request answers with its last message only: its tool calls are refused and it writes again. */
		const startMessage = () => {
			if (!chat.side || !output.content.length) return;
			output.content = [];
			blocks.clear();
		};
		for (;;) {
			const event = await chat.next();
			if (signal?.aborted || event.type === "__closed") return fail("aborted", "已中断");
			// A conversation that went away or could not be opened before it answered is opened once more: resumed from the
			// link, or anew. (`claude` reports a conversation it cannot open as an error result of no turns.)
			const unopened =
				event.type === "__exit" || (event.type === "result" && event.is_error && event.num_turns === 0);
			if (unopened && !received && !retried && plan !== "fresh" && plan !== "one-off") {
				retried = true;
				if (plan === "live") await openChat();
				else await startOver();
				send();
				continue;
			}
			if (event.type === "__exit") {
				return cutOff ? stopAtLimit() : fail("error", event.problem ?? failure ?? "claude 意外结束了这一轮");
			}
			if (event.type === "__tool_request") {
				if (cutOff) return stopAtLimit();
				if (!chat.side && !streamedNow && calls.length) return finishRound("toolUse");
				continue;
			}
			received = true;
			if (event.parent_tool_use_id) continue;
			// Anything after the last block of a whole message cut off at the limit is `claude` going on by itself.
			if (cutOff && !(event.type === "assistant" && event.message?.id === cutOff)) return stopAtLimit();
			if (event.type === "result") {
				if (event.is_error || (failure && !output.content.length)) {
					// The conversation may now hold part of this turn: the next turn starts from the last clean one.
					chat.close(true);
					return fail(
						"error",
						event.result || failure || (event.errors ?? []).join("\n") || `claude 报错：${event.subtype}`,
					);
				}
				return finishRound("stop");
			}
			if (event.type === "assistant") {
				const message = event.message;
				// A request that failed: `claude` writes the error as a message of its own, which is no answer.
				if (message?.model === "<synthetic>") {
					failure = textOf(message.content ?? []) || failure;
					continue;
				}
				// Normally already read piece by piece; without streaming this is the only copy, one block per message.
				if (!message || chat.wasStreamed(message.id)) continue;
				if (output.responseId !== message.id) startMessage();
				output.responseId = message.id;
				streamedNow = false;
				applyUsage(output.usage, message.usage);
				for (const block of message.content ?? []) {
					if (block.type === "text") {
						const contentIndex = output.content.push({ type: "text", text: block.text }) - 1;
						stream.push({ type: "text_start", contentIndex, partial: output });
						stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
						stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					} else if (block.type === "tool_use" && !chat.side) {
						addToolCall(block.id, block.name, block.input ?? {});
					}
				}
				if (message.stop_reason === "max_tokens") cutOff = message.id;
				continue;
			}
			const part = event.event;
			if (part?.type === "message_start") {
				// A message that started and never ended was a failed attempt `claude` makes again: it is dropped.
				if (open) {
					output.content.length = open.content;
					calls.length = open.calls;
					blocks.clear();
				}
				startMessage();
				open = { content: output.content.length, calls: calls.length };
				chat.markStreamed(part.message?.id);
				output.responseId = part.message?.id;
				streamedNow = true;
				applyUsage(output.usage, part.message?.usage);
			} else if (part?.type === "message_delta") {
				applyUsage(output.usage, part.usage);
				// Every block of the message has ended by now.
				if (part.delta?.stop_reason === "max_tokens") return stopAtLimit();
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
				} else if (block?.type === "tool_use" && !chat.side) {
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
					addToolCall(block.id, block.name ?? "", input, block.index);
				}
			} else if (part?.type === "message_stop") {
				open = undefined;
				if (calls.length && !chat.side) return finishRound("toolUse");
			}
		}
	} catch (error) {
		chat.close(true);
		fail(signal?.aborted ? "aborted" : "error", signal?.aborted ? "已中断" : errorText(error));
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (chat.side) chat.close(true);
	}
}

function streamSimple(model: any, context: any, options: any): any {
	const stream = createAssistantMessageEventStream();
	const sessionId: string | undefined = options?.sessionId;
	// Side requests (titles, memory, MyHarness's compaction summary) answer apart, so they never enter the chat's
	// conversation. A chat's own turns always carry its tools; a summary on the chat's own model carries them too, for the
	// cache, so it is told by the flag.
	const side = !sessionId || !context.tools?.length || shared.compacting.has(sessionId);
	let chat: Chat;
	if (side) {
		chat = new Chat(sessionId ?? randomUUID(), true);
	} else {
		chat = shared.chats.get(sessionId) ?? new Chat(sessionId, false);
		shared.chats.set(sessionId, chat);
	}
	void runTurn(stream, chat, model, context, options);
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
		// MyHarness compacts these chats by this length, the way it does on every other provider (see /context-length).
		contextWindow: readContextWindow(),
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
				description: "MyHarness 快到这个长度时按自己的方式压缩对话。可填 100K 到 1M，例如 300k，下一轮生效。",
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
	const sessionIdOf = (ctx: any): string => ctx.sessionManager.getSessionId();

	/**
	 * An early version of this extension recorded the sum of a turn's requests as its usage, which reads as millions of
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

	/**
	 * A chat that opens on Claude Code, or switches to it, shows the plan limits at once and has `claude` asked for them
	 * when they may be old; a chat that switches away no longer shows them.
	 */
	const followLimits = (ctx: any, model: any) => {
		if (!usingClaudeCode(model)) {
			setLimitsStatus(ctx, undefined);
			return;
		}
		const limits = shared.limits ?? {};
		setLimitsStatus(ctx, limitsText(limits, Date.now()));
		if (limitsNeedQuery(limits, Date.now())) void refreshLimits();
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		shared.contexts.set(sessionIdOf(ctx), ctx);
		forgetImpossibleUsage(ctx);
		if (usingClaudeCode(ctx.model)) followLimits(ctx, ctx.model);
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		shared.contexts.set(sessionIdOf(ctx), ctx);
		followLimits(ctx, event.model);
	});
	pi.registerCommand("context-length", {
		description: "设置 Claude Code 对话的上下文长度（MyHarness 按它压缩），例如 /context-length 300k",
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
			ctx.ui.notify(`上下文长度已设为 ${label(tokens)}，MyHarness 下一轮起按它压缩。`, "info");
		},
	} as any);

	pi.on("agent_start", async (_event: any, ctx: any) => {
		shared.compacting.delete(sessionIdOf(ctx));
	});
	// MyHarness's own compaction runs as on any provider; its summary request is a side request (see streamSimple).
	pi.on("session_before_compact", async (_event: any, ctx: any) => {
		if (usingClaudeCode(ctx.model)) shared.compacting.add(sessionIdOf(ctx));
		return undefined;
	});
	// The record now starts with MyHarness's checkpoint, which `claude`'s conversation does not: it starts again.
	pi.on("session_compact", async (_event: any, ctx: any) => {
		const sessionId = sessionIdOf(ctx);
		shared.compacting.delete(sessionId);
		shared.chats.get(sessionId)?.close(true);
	});
	// Another branch of the chat: the next request finds out what of it `claude`'s conversation still holds.
	pi.on("session_tree", async (_event: any, ctx: any) => {
		shared.chats.get(sessionIdOf(ctx))?.close(true);
	});
	// A response cut off at the output limit with no tool call in it would end the task. It goes on instead, in the same
	// run and as often as it takes (Stop ends it); a cut response with tool calls goes on by itself, since MyHarness fails
	// the calls and asks again. Queued here, the note is the run's next input before it would end.
	pi.on("turn_end", async (event: any) => {
		const message = event.message;
		if (message?.role !== "assistant" || message.provider !== PROVIDER_ID || message.stopReason !== "length") return;
		if (partsOf(message).some((part) => part.type === "toolCall")) return;
		pi.sendMessage(
			{ customType: OUTPUT_LIMIT_NOTE, content: outputLimitNote(message), display: false },
			{ deliverAs: "followUp" },
		);
	});
	// A run can end between two tool rounds (Stop, a tool that ends the run), with no provider call there to pass that on.
	// `claude` would wait for results that never come, so it is ended; the next turn resumes the last clean one.
	pi.on("agent_end", async (_event: any, ctx: any) => {
		const chat = shared.chats.get(sessionIdOf(ctx));
		if (chat?.turnActive) chat.close(true);
	});
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = sessionIdOf(ctx);
		shared.chats.get(sessionId)?.close();
		shared.chats.delete(sessionId);
		shared.contexts.delete(sessionId);
	});
	if (!shared.exitHook) {
		shared.exitHook = true;
		// No `claude` may outlive MyHarness: on Windows a child keeps running when its parent ends.
		process.once("exit", () => {
			for (const run of shared.runs) run.stop(true);
		});
	}
}
