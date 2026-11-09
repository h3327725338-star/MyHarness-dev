/**
 * Claude Code shell: MyHarness is the interface, the user's own unmodified `claude` program does the work.
 *
 * The provider never talks to Anthropic and never touches credentials. It runs the official program the way its own
 * documentation describes (`claude -p` with stream-json on stdin/stdout), with that program's own login and its own
 * system prompt; its CLAUDE.md files and auto memory are left out (see Instructions below).
 *
 * Which tools a chat has is MyHarness's decision, as on every other provider: the tools switched on in that chat (its
 * mode, the user's switches, the sub-agent setting). Tool calls take two routes:
 * - Reading, writing, editing, searching files and running commands is done by Claude Code's own tools (Read, Write,
 *   Edit, Grep, Glob, Bash), inside `claude`. Each is offered only while the MyHarness tool it stands in for is switched
 *   on (OWN_TOOLS_FOR, `--tools`). A call shows here as a `claude_code_tool` card with a one-line summary, which waits
 *   for the result `claude` reports.
 * - Every other MyHarness tool that is switched on (web search, memory, earlier chats, schedules, background jobs, the
 *   to-do list, questions to the user, sub-agents, mail, the built-in browser) is offered to `claude` over a local MCP
 *   endpoint (loopback, random token per process), all of them in every request (ENABLE_TOOL_SEARCH=false: none sits
 *   behind a search tool that costs a request of its own). A call comes back through the provider as an ordinary tool
 *   call, so MyHarness runs it with its own approval and cards.
 * Nothing else is offered: none of Claude Code's other tools (its sub-agents, skills, web search and fetch, notebooks,
 * worktrees, monitors), no MCP server of the user's own Claude Code setup (`--strict-mcp-config`) and no connector of
 * their claude.ai account (ENABLE_CLAUDEAI_MCP_SERVERS=false). A change of the chat's tools applies from the next
 * turn: `claude` reads its tool list when it starts, so it is started again between turns.
 *
 * What is left of the subscription's plan limits (the 5-hour and the weekly window) shows in the status bar of every
 * Claude Code chat, the same in all of them: the limits belong to the subscription, not to a chat. Any chat's `claude`
 * reports them with the answers it gets (rate_limit_event), and a chat that opens with none known or only old ones, or a
 * window that resets, has a short-lived `claude` asked for them the way its own /usage does (get_usage, with no model
 * request). The usage endpoint behind it refuses frequent questions, so they are few (LIMITS_*).
 *
 * Compaction belongs to `claude` as well: its conversation holds the real context, so these models are marked
 * managesOwnContext. MyHarness shows how full the window is and neither gates on it nor compacts. "Compact now" is passed
 * on to `claude`.
 *
 * Instructions: Claude Code's own system prompt stays, and MyHarness's whole system prompt (its built-in prompt, the
 * mode's personal prompt, the model's own prompt, project and workspace context) is appended after a short section on
 * how MyHarness's tool names map to this chat's tools; where the two differ, MyHarness's instructions win. No CLAUDE.md
 * of any level and no auto memory files are loaded (CLAUDE_CODE_DISABLE_CLAUDE_MDS). The appended prompt is read again
 * for every request (`--system-prompt-snapshot off`), and a changed one restarts `claude` between turns, never in one.
 *
 * Output limit: a request may write at most the model's maxTokens (CLAUDE_CODE_MAX_OUTPUT_TOKENS), not `claude`'s own
 * 128K. A request that reaches it ends the round as cut off ("length") and the turn in `claude` is interrupted at once:
 * it would otherwise ask the model by itself to go on, up to three times, each a request as long as the first. The task
 * goes on through MyHarness instead, as often as it takes: tool calls in the cut response are failed and asked for
 * again (CUT_CALLS_NOTE), and a cut response without one is followed by a hidden note (OUTPUT_LIMIT_NOTE) asking the
 * model to go on more briefly.
 *
 * Nothing of `claude` may count on a later turn it starts by itself: its background tasks, scheduled and wake-up turns
 * and monitors would report back into a turn that never comes, and it would promise the user to "check back later".
 * Those are switched off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, CLAUDE_CODE_DISABLE_CRON, and the tools are not in
 * `--tools`), and its own Bash runs each command until it finishes. A process that has to keep running goes through
 * MyHarness's bash/pwsh (the Background panel). What MyHarness itself brings back in a new turn (a background job that
 * ends, a sub-agent, a scheduled task) is described by MyHarness's own prompt, and the appended section only says what
 * of Claude Code does not exist here.
 *
 * Client name: `claude` reports MyHarness as the program that started it (ENTRYPOINT, in its billing line, User-Agent
 * and transcript) instead of `claude -p`'s own `sdk-cli`. It is MyHarness's own name, never one of Anthropic's clients.
 * Anthropic's servers accept it for this shape of request (Claude Code's own prompt and tools); a request that carries
 * only another app's prompt and tools under such a name is refused as a third-party app.
 *
 * The Windows installer carries this file and loads it by itself. From source, copy it to ~/.myharness/agent/extensions/
 * and restart MyHarness; a copy there takes over from the bundled one. `claude` must be installed and signed in on that
 * computer. It runs with bypassPermissions, so `claude`'s own tools do not ask before they act.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
/**
 * Which tools a chat has is MyHarness's decision (the mode, the user's switches, the sub-agent setting): `claude` gets
 * one of its own tools only while the MyHarness tool it stands in for is switched on in that chat, and every other
 * MyHarness tool over MCP. These are the MyHarness tools whose work Claude Code's own tool does, by MyHarness's name.
 * Claude Code tools that stand in for none (its sub-agents, skills, web search and fetch, notebooks, worktrees,
 * monitors, wake-ups) are never offered: MyHarness's own sub-agents, search and schedules are, when they are on.
 */
export const OWN_TOOLS_FOR: Readonly<Record<string, readonly string[]>> = {
	read: ["Read"],
	write: ["Write"],
	edit: ["Edit"],
	apply_patch: ["Edit", "Write"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["Glob"],
	bash: ["Bash"],
	pwsh: ["Bash"],
};
/**
 * MyHarness's shells, offered only for a process that keeps running after the reply: `claude`'s own Bash runs every
 * other command and, with its background tasks off, cannot leave one running. The call always starts a background job,
 * which the Background panel lists with its output and a stop button.
 */
const BACKGROUND_SHELLS: Record<string, string> = {
	bash: `Start a long-running process (a dev server, a file watcher) in the background of MyHarness and get its job id at once. It keeps running after your reply ends; the user sees it in MyHarness's Background panel with its output and a stop button. Use your own Bash tool for every other command. Read its output with ${MCP_PREFIX}job_output and stop it with ${MCP_PREFIX}job_kill; what MyHarness's instructions say about a background job that ends applies to it.`,
	pwsh: `The same as ${MCP_PREFIX}bash, in PowerShell: start a long-running process in the background of MyHarness and get its job id at once. Use your own Bash tool for every other command.`,
};
/** MyHarness tools `claude` is not offered over MCP: the card tool, and the ones its own tool does the work of. */
const notOffered = (name: string) =>
	name === PASSTHROUGH_TOOL || (name in OWN_TOOLS_FOR && !(name in BACKGROUND_SHELLS));

/** Claude Code's own tools for a chat whose MyHarness tools are `active`: the `--tools` list, sorted, without repeats. */
export function ownToolsFor(active: string[]): string[] {
	return [...new Set(active.flatMap((name) => OWN_TOOLS_FOR[name] ?? []))].sort();
}

/** The MyHarness tools of `active` that `claude` gets over MCP, by name. */
export function offeredNames(active: string[]): string[] {
	return active.filter((name) => !notOffered(name));
}
const BACKGROUND_SHELL_SCHEMA = {
	type: "object",
	properties: {
		command: { type: "string", description: "The command that starts the process." },
		run_in_background: {
			type: "boolean",
			const: true,
			description: "Always true: the process runs in the background.",
		},
	},
	required: ["command", "run_in_background"],
	additionalProperties: false,
};
const IDLE_CLOSE_MS = 15 * 60_000;
/** A Claude Code chat that opens asks `claude` for the plan limits when the newest reading is older than this. */
const LIMITS_FRESH_MS = 5 * 60_000;
/** At most one such question a minute, and none for ten minutes after one failed: the usage endpoint refuses many. */
const LIMITS_MIN_INTERVAL_MS = 60_000;
const LIMITS_RETRY_MS = 10 * 60_000;
const LIMITS_TIMEOUT_MS = 30_000;
/** A window that reset is asked about this long after its reset time. */
const LIMITS_RESET_DELAY_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A program that has not stopped this long after an interrupt is ended; the next turn resumes the conversation. */
const INTERRUPT_GRACE_MS = 10_000;
/**
 * MyHarness's tools can wait for the user, such as a sign-in. `claude` gives up on an MCP tool after 60 s
 * (`MCP_TOOL_TIMEOUT`) and, separately, after 300 s without a reply or a progress message (the server's `timeout`).
 */
const APP_TOOL_TIMEOUT_MS = 24 * 3600_000;
/** What `claude` puts in an MCP call's `_meta`: the id of its tool_use, which is also the id of MyHarness's card. */
const TOOL_USE_ID_META = "claudecode/toolUseId";
/**
 * A call MyHarness never sees in the main conversation, such as one from `claude`'s own sub-agent, is answered after
 * this long instead of waiting for a card that never runs. The tool_use event comes before the call, in milliseconds.
 */
const UNSEEN_CALL_MS = 60_000;
/**
 * MyHarness bounds what its tools return (50 KB by default) and every model gets a result as MyHarness made it. Left
 * alone, `claude` saves an MCP result of over 50,000 characters, or 25,000 tokens, to a file and gives the model the
 * path instead, which a chat without its Read tool could not open. These are the most `claude` lets a tool declare.
 */
const APP_RESULT_META = { "anthropic/maxResultSizeChars": 500_000 };
const APP_RESULT_TOKENS = 125_000;
const MAX_CARD_CHARS = 30_000;
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_TRANSCRIPT_CHARS = 800_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const MIN_CONTEXT_WINDOW = 100_000;
/** Whatever the user's own Claude Code settings say, these chats have no other compaction. */
const AUTO_COMPACT_ON = JSON.stringify({ autoCompactEnabled: true });
/** How MyHarness's checkpoint starts once it is a user message; `claude` already holds its own summary. */
const CHECKPOINT_PREFIX = "The conversation history before this point has been compacted";
/** The hidden message that keeps a task going after a response was cut off at the output limit (see turn_end). */
export const OUTPUT_LIMIT_NOTE = "claude-code-output-limit";
/** "read → Read, edit and apply_patch → Edit": the MyHarness names of `active` that one of Claude Code's own tools does. */
function ownEquivalents(active: string[]): string {
	const byOwn = new Map<string, string[]>();
	for (const name of active) {
		const own = OWN_TOOLS_FOR[name]?.join(" and ");
		if (own) byOwn.set(own, [...(byOwn.get(own) ?? []), name]);
	}
	return [...byOwn].map(([own, names]) => `${names.join(" and ")} → ${own}`).join(", ");
}
/**
 * What `claude` is told about where it runs, for a chat whose MyHarness tools are `active` (MyHarness's names): that
 * MyHarness's instructions follow and win, which of the tool names they use are its own tools and which are app tools,
 * and what of Claude Code does not exist here. What MyHarness itself can bring back after a reply (a background job, a
 * sub-agent, a scheduled task) is left to MyHarness's own instructions, which describe it.
 */
export function appendPromptFor(active: string[]): string {
	const offered = offeredNames(active);
	const tool = (name: string) => `${MCP_PREFIX}${name}`;
	const shells = ["bash", "pwsh"].filter((name) => offered.includes(name)).map(tool);
	const equivalents = ownEquivalents(active);
	const lines = [
		"# MyHarness",
		"- You are running inside MyHarness, a desktop app the user chose as the interface for Claude Code.",
		"- Your replies appear in MyHarness's chat window, which renders Markdown; they are not shown in a terminal.",
		"- After this section come MyHarness's own instructions: its built-in prompt, the user's personal prompt and model prompt, and project context. Follow all of them; where they differ from Claude Code's instructions above, MyHarness's instructions win.",
		"",
		"# Tools in this chat",
		"- MyHarness decides which tools this chat has. Its instructions name them by MyHarness's plain names.",
		...(equivalents
			? [
					`- These names are your own tools: ${equivalents}. Where MyHarness's instructions describe the arguments of such a tool, your own tool's arguments apply; their rules on when to use it and what to check first still hold.`,
				]
			: []),
		...(offered.length > 0
			? [
					`- Every other tool name they list is the ${MCP_PREFIX}<name> tool. MyHarness runs it and shows it to the user.`,
				]
			: []),
		"- A tool they do not list is not available in this chat.",
		...(shells.length > 0
			? [
					`- bash and pwsh: your own Bash runs a command that finishes. Start a process that must keep running after your reply (a dev server, a file watcher) with ${shells.join(" or ")}, which always starts a background job; what MyHarness's instructions say about background jobs applies to it.`,
				]
			: []),
		"",
		"# What does not exist here",
		"- Claude Code's own wake-ups, scheduled turns, loops, monitors, background tasks and task notifications do not exist in this app. Your own Bash commands run in the foreground: each one finishes before you go on.",
		"- After your reply ends, only what MyHarness's instructions name can bring you back. Never say you will check back or report later on anything else.",
	];
	return lines.join("\n");
}
/** What `claude` gets appended to its own system prompt in a chat: the section above, then MyHarness's whole prompt. */
export function appendedPrompt(active: string[], systemPrompt: string | undefined): string {
	return [appendPromptFor(active), (systemPrompt ?? "").trim()].filter(Boolean).join("\n\n");
}

/** A file inside the chat's folder is named from that folder ("src/app.ts"); any other by its whole path. */
function shownPath(file: string, cwd: string | undefined): string {
	if (!file || !cwd || !path.isAbsolute(file)) return file;
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : file;
}

/**
 * What a tool `claude` runs by itself is doing, in one line, for its card: "Read src/app.ts", "Bash npm test". `claude`
 * names files by their whole path; `cwd` is the chat's folder.
 */
export function callSummary(name: string, input: any, cwd?: string): string {
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	const file = (value: unknown) => shownPath(text(value), cwd);
	const subject =
		name === "Bash"
			? text(input?.command)
			: name === "Grep" || name === "Glob"
				? [text(input?.pattern), file(input?.path) || text(input?.glob)].filter(Boolean).join(" · ")
				: file(input?.file_path) || file(input?.path) || text(input?.pattern) || text(input?.command);
	const line = subject.split(/\r?\n/, 1)[0].slice(0, 160);
	return line ? `${name} ${line}` : name;
}

const partsOf = (message: any): any[] => (Array.isArray(message?.content) ? message.content : []);

/**
 * What the model reads before it goes on after a response cut off at the output limit with no tool call in it. The
 * thinking of a cut-off request is not kept, so a response that wrote nothing is asked to go on more briefly, and one
 * that wrote text to go on from where it stopped.
 */
export function outputLimitNote(message: any): string {
	const wrote = partsOf(message).some((part) => part.type === "text" && String(part.text ?? "").trim());
	return wrote
		? `[system-reminder] Your last response was cut off at the output limit. ${STOPPED_BY_APP} Go on from where it stopped, without repeating what it already wrote, and keep each response well within the limit: split large work into smaller steps.`
		: `[system-reminder] Your last response reached the output limit while still thinking, before it wrote any text or tool call, and that thinking is lost. ${STOPPED_BY_APP} Go on with the task from the conversation above: think much more briefly, and write your answer or next tool call well within the limit, splitting large work into smaller steps.`;
}

/** `claude` marks the turn it was told to stop as interrupted by the user, and refuses the calls of a cut response. */
const STOPPED_BY_APP =
	"MyHarness stopped that request there; an interruption or refused tool call shown above comes from that, not from the user.";

/** What `claude` reads after a response cut off at the output limit whose tool calls were therefore never run. */
export const CUT_CALLS_NOTE = `[system-reminder] Your last response was cut off at the output limit, so none of its tool calls ran. ${STOPPED_BY_APP} Go on with the task: make the calls again, and keep each response well within the limit, splitting large work into smaller steps.`;

/**
 * The most a request may write, thinking included: the model's maxTokens, as on MyHarness's own Anthropic requests. A
 * smaller cap a caller asks for is not passed on, because `claude` cannot switch thinking off and would spend it all on
 * thinking; and the cap stays the same for every request of a chat, because `claude` only reads it when it starts.
 */
export function outputLimitFor(model: any): number | undefined {
	const limit = Math.floor(Number(model?.maxTokens));
	return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

/** Variables that would switch `claude` away from the user's own login, or confuse it about where it runs. */
export const STRIPPED_ENV = [
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
	"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
];

/**
 * The client name `claude` reports with every request (`cc_entrypoint` in its billing line, its User-Agent and the
 * transcript's `entrypoint`), set over any inherited one. Left alone, `claude -p` reports `sdk-cli`, and users measured
 * requests under the `sdk-*` names using the subscription's 5-hour window about 1.7 to 2.4 times as fast per token as
 * the same work under a client's own name (anthropics/claude-code#97074; Anthropic has not said whether that is
 * intended, and it was not measured on this account). This names MyHarness itself, never one of Anthropic's own clients
 * (`cli`, `claude-desktop`, `claude-vscode`).
 */
export const ENTRYPOINT = "myharness";

/** The environment `claude` starts with. */
export function launchEnv(
	base: NodeJS.ProcessEnv,
	maxOutputTokens: number | undefined,
	contextWindow: number,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of STRIPPED_ENV) delete env[name];
	env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
	env.MCP_TOOL_TIMEOUT = String(APP_TOOL_TIMEOUT_MS);
	// Nothing of it may wait for a later turn of its own (see the top of this file): its Bash runs in the foreground,
	// and it has no scheduled turns.
	env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
	env.CLAUDE_CODE_DISABLE_CRON = "1";
	// MyHarness's prompt instead: no CLAUDE.md of any level (user, project, local) and no auto memory files.
	env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
	// MyHarness's tools are in every request, not behind a search tool that costs a request of its own to find one;
	// and no tools from the connectors of the user's claude.ai account, which MyHarness does not switch.
	env.ENABLE_TOOL_SEARCH = "false";
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
	// A MyHarness tool's result reaches the model as MyHarness bounded it (see APP_RESULT_META).
	env.MAX_MCP_OUTPUT_TOKENS = String(APP_RESULT_TOKENS);
	env.CLAUDE_CODE_ENTRYPOINT = ENTRYPOINT;
	// What `claude` leaves out by itself only for the `sdk-*` client names, off again: the small-model request that
	// names each conversation, the Artifact feature, and feedback that Claude drafts to Anthropic.
	env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
	env.CLAUDE_CODE_DISABLE_ARTIFACT = "1";
	env.CLAUDE_CODE_SEND_FEEDBACK = "0";
	// MyHarness's output limit for the model in place of `claude`'s own: it bounds a request whose thinking runs on.
	if (maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
	return env;
}

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
	/** The subscription's plan limits as seen last by any chat, shown in every Claude Code chat. */
	limits?: Limits;
	/** The get_usage question under way, when the last one was asked, and when one failed last. */
	limitsQuery?: Promise<void>;
	limitsQueriedAt?: number;
	limitsFailedAt?: number;
	/** Fires when the next window resets. */
	limitsTimer?: ReturnType<typeof setTimeout>;
};
const SHARED_KEY = Symbol.for("myharness.claude-code-shell");
const shared: Shared = (globalThis as any)[SHARED_KEY] ?? {
	sessions: new Map(),
	contexts: new Map(),
	configFiles: new Set(),
	compacting: new Set(),
};
(globalThis as any)[SHARED_KEY] = shared;

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
/**
 * Which Claude Code conversation each chat continues. Not `sessions.json`: a chat this version has not seen may have gone
 * on under the 2026-11-08 version, which kept its own links, so a link from that file can point at a conversation that
 * stops before the chat's latest turns. Such a chat starts a new conversation with its earlier messages as text, once.
 */
const linksFile = () => path.join(dataDir(), "classic-links.json");
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
				const toolUseId = message.params?._meta?.[TOOL_USE_ID_META];
				reply({
					result: await session.waitForAppTool(
						message.params?.name,
						message.params?.arguments ?? {},
						typeof toolUseId === "string" && toolUseId ? toolUseId : undefined,
					),
				});
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

/** One status line per chat: the plan limits, the same in every chat, and what this chat's `claude` is doing. */
function showStatus(
	sessionId: string,
	ctx: any = shared.contexts.get(sessionId),
	onClaudeCode = usesClaudeCode(ctx),
): void {
	const limits = onClaudeCode ? limitsText(shared.limits ?? {}, Date.now()) : undefined;
	const compacting = shared.sessions.get(sessionId)?.compactingNow ? "Claude Code 正在压缩上下文…" : undefined;
	try {
		ctx?.ui?.setStatus?.(PROVIDER_ID, [limits, compacting].filter(Boolean).join(" · ") || undefined);
	} catch {}
}

/** Every open Claude Code chat shows the same limits. */
function showLimits(): void {
	for (const [sessionId, ctx] of shared.contexts) showStatus(sessionId, ctx);
}

function noteLimits(next: Limits): void {
	if (!LIMIT_WINDOWS.some((name) => next[name])) return;
	shared.limits = mergeLimits(shared.limits ?? {}, next);
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
			noteLimits(limits);
		})
		.catch(() => {
			shared.limitsFailedAt = Date.now();
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
function queryLimits(): Promise<Limits> {
	const binary = findClaude();
	if (!binary) return Promise.reject(new Error("找不到 claude 程序"));
	const observedAt = Date.now();
	return new Promise((resolve, reject) => {
		const env = launchEnv(process.env, undefined, readContextWindow());
		const child = spawn(binary, LIMITS_ARGS, {
			cwd: os.homedir(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let settled = false;
		const finish = (problem: string | undefined, limits?: Limits) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin?.end();
			setTimeout(() => {
				if (child.exitCode === null) child.kill();
			}, 3000).unref();
			if (limits) resolve(limits);
			else reject(new Error(problem ?? "claude 没有给出额度"));
		};
		const timer = setTimeout(() => finish("claude 没有回应 get_usage 请求"), LIMITS_TIMEOUT_MS);
		timer.unref?.();
		const ask = (id: string, request: object) =>
			child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
		child.stdin?.on("error", () => {});
		child.on("error", (error) => finish(error.message));
		child.on("close", () => finish("claude 已退出"));
		createInterface({ input: child.stdout! }).on("line", (line) => {
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "control_response") return;
			const response = event.response ?? {};
			if (response.subtype === "error") {
				finish(response.error || "claude 拒绝了这个请求");
			} else if (response.request_id === "limits-initialize") {
				ask("limits-usage", { subtype: "get_usage", skip_behaviors: true });
			} else if (response.request_id === "limits-usage") {
				const limits = limitsFromUsage(response.response ?? {}, observedAt);
				finish(undefined, LIMIT_WINDOWS.some((name) => limits[name]) ? limits : undefined);
			}
		});
		ask("limits-initialize", { subtype: "initialize" });
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
	/** The last round was cut off at the output limit and its turn interrupted; MyHarness has not gone on yet. */
	cutOff = false;
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
	/** App tool calls of this turn by tool_use id, in the order `claude` made them. */
	private appCalls = new Map<string, AppCall>();
	/** MCP requests that arrived before the call they belong to was seen. */
	private unboundRequests: AppRequest[] = [];
	/** Tool_use ids of app tools `claude`'s own sub-agents called; MyHarness never runs those. */
	private sideCalls = new Set<string>();
	private seenMessageIds = new Set<string>();
	private files = new Set<string>();
	/** `claude` is compacting this chat's context right now; part of the chat's status line. */
	compactingNow = false;
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

	/** The MyHarness tools switched on in this chat, by name: what decides which tools `claude` has. */
	activeNames(): string[] {
		return this.tools.map((tool) => tool.name).filter((name) => name !== PASSTHROUGH_TOOL);
	}

	/** Claude Code's own tools this chat gets: the ones a switched-on MyHarness tool stands for. */
	ownTools(): string[] {
		return ownToolsFor(this.activeNames());
	}

	offeredTools(): any[] {
		return this.tools
			.filter((tool) => !notOffered(tool.name))
			.map((tool) =>
				BACKGROUND_SHELLS[tool.name]
					? { name: tool.name, description: BACKGROUND_SHELLS[tool.name], inputSchema: BACKGROUND_SHELL_SCHEMA }
					: {
							name: tool.name,
							description: tool.description,
							inputSchema: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })),
							_meta: APP_RESULT_META,
						},
			);
	}

	/**
	 * What is appended to Claude Code's prompt for the app tools this chat offers now and MyHarness's prompt; a change
	 * restarts `claude` with the new one between turns.
	 */
	appendPrompt(systemPrompt: string | undefined): string {
		return appendedPrompt(this.activeNames(), systemPrompt);
	}

	/** A file of this chat's for `claude` to read when it starts; removed when MyHarness exits (a side request's at close). */
	private privateFile(kind: string, extension: string, content: string): string {
		fs.mkdirSync(dataDir(), { recursive: true });
		// Side requests of one chat can run at the same time, so theirs are told apart.
		const unique = this.ephemeral ? `-${randomUUID().slice(0, 8)}` : "";
		const file = path.join(
			dataDir(),
			`${kind}-${process.pid}-${encodeURIComponent(this.sessionId)}${unique}${extension}`,
		);
		fs.writeFileSync(file, content, { mode: 0o600 });
		this.files.add(file);
		if (!shared.configFiles.size) {
			process.once("exit", () => {
				for (const name of shared.configFiles) fs.rmSync(name, { force: true });
			});
		}
		shared.configFiles.add(file);
		return file;
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
			// Only MyHarness's MCP endpoint: none of the MCP servers of the user's own Claude Code setup.
			"--strict-mcp-config",
		];
		if (effort) args.push("--effort", effort);
		// Prompts go in files: MyHarness's is far longer than a Windows command line may be (32,767 characters).
		if (this.ephemeral) {
			args.push("--no-session-persistence", "--tools", "");
			if (systemPrompt) args.push("--system-prompt-file", this.privateFile("system-prompt", ".md", systemPrompt));
		} else {
			// No permission prompts for `claude`'s own tools. The prompt tool stays for questions it still has to put to the user.
			args.push(
				"--permission-mode",
				"bypassPermissions",
				"--permission-prompt-tool",
				"stdio",
				// Of its own tools, the ones MyHarness has switched on in this chat, and no other.
				"--tools",
				this.ownTools().join(","),
				"--append-system-prompt-file",
				this.privateFile("append-prompt", ".md", this.appendPrompt(systemPrompt)),
				// A resumed conversation would otherwise keep the prompt of its first request until it is compacted.
				"--system-prompt-snapshot",
				"off",
			);
			if (this.offeredTools().length > 0) {
				const mcp = await ensureMcp();
				const config = {
					mcpServers: {
						[MCP_SERVER]: {
							type: "http",
							url: `http://127.0.0.1:${mcp.port}/mcp/${encodeURIComponent(this.sessionId)}`,
							headers: { Authorization: `Bearer ${mcp.token}` },
							// Without it `claude` drops a MyHarness tool that has said nothing for 300 s.
							timeout: APP_TOOL_TIMEOUT_MS,
							// `claude` waits for this endpoint (it is on this computer) before its first request, so the
							// tools are in every request from the first and the cached start of the prompt never changes.
							alwaysLoad: true,
						},
					},
				};
				args.push("--mcp-config", this.privateFile("mcp", ".json", JSON.stringify(config)));
			}
			const link = readLinks()[this.sessionId];
			if (link && path.resolve(link.cwd) === path.resolve(this.cwd)) {
				args.push("--resume", link.claudeSessionId);
				this.resumedFrom = link.claudeSessionId;
			} else {
				this.resumedFrom = undefined;
			}
		}
		const env = launchEnv(process.env, outputLimitFor(model), readContextWindow());
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
		this.forgetAppCalls(reason);
		this.compactDone?.(undefined);
		this.compactDone = undefined;
		if (this.compactingNow) {
			this.compactingNow = false;
			showStatus(this.sessionId);
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
		// Nothing left over may be taken for this turn's answer, nor an earlier turn's tool call for one of this turn.
		if (!this.turnActive) {
			this.queue.length = 0;
			this.forgetAppCalls("这一轮已经结束");
		}
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
		if (this.ephemeral) {
			for (const file of this.files) {
				fs.rmSync(file, { force: true });
				shared.configFiles.delete(file);
			}
			this.files.clear();
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
		if (event.type === "rate_limit_event") noteLimits(limitsFromEvent(event.rate_limit_info, Date.now()));
		if (this.draining) {
			if (event.type === "result") {
				this.draining = false;
				if (this.interruptTimer) clearTimeout(this.interruptTimer);
			}
			return;
		}
		if (event.type === "system" && event.subtype === "status") {
			this.compactingNow = event.status === "compacting";
			showStatus(this.sessionId);
		}
		if (event.type === "system" && event.subtype === "compact_boundary")
			this.onCompactBoundary(event.compact_metadata);
		if (event.type === "user" && this.summaryPending && !event.parent_tool_use_id) {
			this.summaryPending = false;
			if (this.lastCompaction) this.lastCompaction.summary = plainText(event.message?.content);
			return;
		}
		this.expectTools(event);
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

	private onCompactBoundary(metadata: any): void {
		this.summaryPending = true;
		this.lastCompaction = { summary: "", tokensBefore: metadata?.pre_tokens ?? 0 };
		this.compactingNow = false;
		showStatus(this.sessionId);
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
	 * Tool calls are noted the moment `claude` reports them, before the provider reads that far:
	 * - ToolSearch answers about 2 ms after it is asked for, which can be in the same read. A result with nothing waiting
	 *   for it is lost and its card never ends, so the wait for an own tool's result starts here.
	 * - `claude` starts a tool as soon as its block is complete, so the MCP request for an app tool can arrive before the
	 *   provider has mapped the call; noting it here lets the request find its call at once.
	 * Calls `claude`'s own sub-agents make are only remembered, so their MCP requests can be answered (see waitForAppTool).
	 */
	private expectTools(event: any): void {
		const assistant = event.type === "assistant";
		const blocks = assistant
			? event.message?.content
			: event.type === "stream_event" && event.event?.type === "content_block_start"
				? [event.event.content_block]
				: [];
		const side = !!event.parent_tool_use_id;
		for (const block of blocks ?? []) {
			if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
			if (block.name?.startsWith(MCP_PREFIX)) {
				if (side) this.noteSideCall(block.id);
				// The arguments are complete only in the assistant message; a block that has just started has none yet.
				else this.noteAppCall(block.id, block.name.slice(MCP_PREFIX.length), assistant ? block.input : undefined);
				continue;
			}
			if (side || this.toolResults.has(block.id)) continue;
			this.toolResults.set(block.id, deferred());
		}
	}

	takeToolResult(id: string): Promise<any> | undefined {
		const waiting = this.toolResults.get(id);
		// Stays listed until it settles, so an interrupt or a dead process can still release it.
		void waiting?.promise.then(() => this.toolResults.delete(id));
		return waiting?.promise;
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

	private noteSideCall(id: string): void {
		this.sideCalls.add(id);
		this.bindWaitingRequests();
	}

	/** MyHarness finished a card: its result goes to the MCP request of that very call, now or when it arrives. */
	deliverAppResult(message: any): void {
		const call = this.appCalls.get(message.toolCallId);
		if (!call || call.result !== undefined) return;
		call.result = {
			content: (message.content ?? []).map((part: any) =>
				part.type === "image"
					? { type: "image", data: part.data, mimeType: part.mimeType }
					: { type: "text", text: part.text ?? "" },
			),
			isError: !!message.isError,
		};
		for (const done of call.waiters.splice(0)) done(call.result);
	}

	/**
	 * `claude`'s MCP request for an app tool. It names the tool_use it belongs to (TOOL_USE_ID_META), so it gets exactly
	 * that card's result. Pairing by tool and arguments alone, as before, gave one call's result to another when the
	 * same tool ran several times in a round and the cards finished in another order than `claude` asked: one request
	 * was then left with nothing and `claude` sat 300 s on it (seen 2026-11-03 with four session_search calls).
	 */
	waitForAppTool(name: string, args: unknown, toolUseId?: string): Promise<any> {
		return new Promise((done) => {
			const request: AppRequest = { name, key: stableJson(args), toolUseId, done };
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
		if (request.toolUseId && this.sideCalls.has(request.toolUseId)) {
			request.done(
				appError(
					`MyHarness tools only run for the main conversation, where the user sees them; a sub-agent cannot use ${request.name}. Call it from the main conversation instead.`,
				),
			);
			return true;
		}
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
		this.sideCalls.clear();
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

/**
 * How a tool `claude` uses looks as a MyHarness call, also while its arguments are still arriving. MyHarness's shells
 * are offered only to start background jobs (BACKGROUND_SHELLS), so such a call is one whatever its arguments say.
 */
function shapeToolCall(id: string, name: string, input: any, cwd: string): any {
	// The summary comes first: a card shows the first text among a call's arguments.
	if (!name.startsWith(MCP_PREFIX))
		return {
			type: "toolCall",
			id,
			name: PASSTHROUGH_TOOL,
			arguments: { summary: callSummary(name, input, cwd), tool: name, input },
		};
	const appName = name.slice(MCP_PREFIX.length);
	const args =
		BACKGROUND_SHELLS[appName] && input && typeof input === "object" ? { ...input, run_in_background: true } : input;
	return { type: "toolCall", id, name: appName, arguments: args };
}

function mapToolCall(session: CliSession, id: string, name: string, input: any): any {
	if (name.startsWith(MCP_PREFIX)) session.noteAppCall(id, name.slice(MCP_PREFIX.length), input);
	return shapeToolCall(id, name, input, session.cwd);
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
	const maxOutputTokens = outputLimitFor(model);
	session.tools = context.tools ?? [];
	// The length, the output limit and the appended prompt (MyHarness's, and the one about the offered app tools) reach
	// `claude` when it starts, so a new one restarts it between turns (the conversation is resumed).
	const prompt = session.ephemeral ? "" : session.appendPrompt(context.systemPrompt);
	const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
	// So do its own tools (`--tools`) and the app tools it lists once, when it connects to MyHarness's MCP endpoint.
	const toolSet = session.ephemeral
		? ""
		: `${session.ownTools().join(",")}|${offeredNames(session.activeNames()).join(",")}`;
	const signature = `${model.id}|${effort ?? ""}|${readContextWindow()}|${maxOutputTokens ?? ""}|${promptHash}|${toolSet}`;
	/**
	 * The request reached its output limit. `claude` would now ask the model by itself to go on, unseen here. MyHarness
	 * decides what follows a cut-off answer, as on every provider (calls in it are failed, an answer without calls is
	 * followed by OUTPUT_LIMIT_NOTE), so the turn is interrupted at once. Interrupted, not ended: a program ended this
	 * early has not yet written the turn's user message to its transcript, so a resumed conversation would lack it.
	 */
	const stopAtLimit = () => {
		session.cutOff = true;
		session.interrupt();
		output.stopReason = "length";
		if (!session.ephemeral) {
			const written = formatTokens(output.usage.output || maxOutputTokens || 0);
			shared.contexts
				.get(session.sessionId)
				?.ui?.notify(
					`Claude Code 这一步写到了输出上限（${written} token），这次请求已停下，任务自动接着做。`,
					"warning",
				);
		}
		stream.push({ type: "done", reason: "length", message: output });
		stream.end();
	};

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
		session.cutOff = false;
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
		// The turn is over in `claude`: the program went away between two tool rounds (restart, idle close, a compaction),
		// or the round was cut off at the output limit and interrupted. Pick the conversation back up.
		if (!session.turnActive) {
			const earlier = hasLink ? "" : renderTranscript(messages);
			const history = earlier ? `<earlier-conversation>\n${earlier}\n</earlier-conversation>\n\n` : "";
			const goOn = session.cutOff ? CUT_CALLS_NOTE : "Continue where you left off.";
			session.cutOff = false;
			session.sendUser([{ type: "text", text: `${history}${goOn}` }]);
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
				if (message.stop_reason === "max_tokens") {
					stopAtLimit();
					return;
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
				// Every block of the message has ended by now.
				if (part.delta?.stop_reason === "max_tokens") {
					stopAtLimit();
					return;
				}
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
					const index = output.content.push(shapeToolCall(block.id, block.name, {}, session.cwd)) - 1;
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
						session.cwd,
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
		parameters: Type.Object({ summary: Type.Optional(Type.String()), tool: Type.String(), input: Type.Any() }),
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

	/**
	 * A chat that opens on Claude Code, or switches to it, shows the plan limits at once and has `claude` asked for them
	 * when they may be old; a chat that switches away no longer shows them.
	 */
	const followLimits = (ctx: any, model: any) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!usingClaudeCode(model)) {
			try {
				ctx.ui?.setStatus?.(PROVIDER_ID, undefined);
			} catch {}
			return;
		}
		// The event's model, not the context's: a chat that is switching may still report the model it leaves.
		showStatus(sessionId, ctx, true);
		if (limitsNeedQuery(shared.limits ?? {}, Date.now())) void refreshLimits();
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		shared.contexts.set(ctx.sessionManager.getSessionId(), ctx);
		syncActiveTools(ctx.model);
		forgetImpossibleUsage(ctx);
		followLimits(ctx, ctx.model);
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		shared.contexts.set(ctx.sessionManager.getSessionId(), ctx);
		syncActiveTools(event.model);
		followLimits(ctx, event.model);
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
