/**
 * agy shell: MyHarness is the interface, the user's own unmodified `agy` program (Google's Antigravity CLI) does the work.
 *
 * The provider never talks to Google and never touches `agy`'s login. It runs the official program the way its own
 * documentation describes for editors: `agy acp`, an Agent Client Protocol (ACP) server that is started as a child
 * process and spoken to with JSON-RPC over stdin/stdout. One `agy acp` runs per chat, in the chat's folder. `agy acp`
 * exists from agy 1.5.0; an older `agy` is never started (it would take "acp" for a prompt), the user is told to update.
 *
 * Sign-in is `agy`'s own: the credentials it cached in an interactive session. `/agy-login` asks `agy` to sign in by
 * one of the methods it offers (it opens the browser itself). A Gemini API key saved on the provider's card is handed
 * to `agy` as GEMINI_API_KEY, its documented key method; a key lying in the environment is never used by accident.
 *
 * Chat tools all run through MyHarness's authenticated local MCP endpoint. The custom host agent excludes agy's
 * default prompt components and native action tools; unexpected native permission requests are refused. agy 1.5.9
 * still exposes manage_task/list_resources/read_resource, so the instructions also prohibit using those auxiliary tools.
 * Temporary title/summary requests use the host too. Search-source conversations keep a separate native search tool.
 *
 * MCP tool schema adaptation:
 * Every switched-on MyHarness tool, including files and commands, is offered over MCP (loopback, random token per
 * process), shown and run by MyHarness with its own card and approval. Its result is the MCP answer.
 *   `agy` adds an argument of its own (`toolSummary`) to every tool and checks each call against the tool's schema
 *   with it, so the schemas it is offered are open at the top and a tool that is one closed object per operation (the
 *   built-in browser's) is offered as a single object (toolForAgy); the argument is taken out again before MyHarness
 *   checks the call against the tool's real schema.
 *
 * Instructions: a managed custom agent excludes agy's default components. MyHarness's complete prompt supplies the
 * authoritative instruction hierarchy; a short reminder is added to each turn without changing saved messages. `agy`
 * takes such an addition when a conversation is opened (`_meta.antigravity.systemPrompt.append`, which it advertises
 * when it is started; agy 1.5.9 does). It does not keep the addition with the conversation: a conversation that is
 * resumed without it has `agy`'s own prompt alone, and one resumed with another has that one instead (both seen with
 * agy 1.5.9 on 2026-11-14). So it goes along every time a conversation is opened, and a prompt that changed opens the
 * conversation again between two turns. Chat startup refuses runtimes without system append or HTTP MCP support,
 * rather than lowering the instructions into a user message. Old conversations from the default agent are not resumed.
 *
 * Starting: `agy` needs a second or two to start and open a conversation. It does that when a message is sent in a chat
 * on agy (before_agent_start), while MyHarness looks up memories, not when the model is asked (AcpSession.warm).
 * `agy`'s own background updater is off in every `agy` started here, because of the window it opens on Windows; the
 * same check is made here, hidden (NO_AUTO_UPDATE_ENV, keepUpdated).
 *
 * The conversation and its context belong to `agy` (managesOwnContext): MyHarness shows how full the window is, as `agy`
 * reports it without applying the normal MyHarness budget gate. Manual compaction creates a portable MyHarness
 * checkpoint in a separate request and rebuilds the agy conversation from it. Which conversation a chat continues is remembered, and it is
 * resumed after `agy` was restarted when `agy` supports that; otherwise the chat's earlier messages go along as text,
 * within what `agy` takes in one message (MAX_PROMPT_BYTES): the newest are kept and the oldest left out, and a message
 * `agy` still cut short is reported to the user (cutFromInput).
 * `agy` compacts by itself near the end of its own window. A shorter length can be set per model on the provider's
 * card (Settings → Provider → agy): a conversation that has reached it is compacted by `agy`'s own /compact before the
 * next message when possible, otherwise MyHarness writes a portable checkpoint. The meter uses agy's own window.
 *
 * Models: the ones `agy` lists for the signed-in account, each with the thinking levels `agy` offers for it. They come
 * from `agy models` before any conversation has run, and from every conversation's own list after that; the reasoning
 * level is passed on as `agy`'s thinking level.
 *
 * Numbers: over ACP `agy` only says how full the context is. What each model request read, read from the cache and
 * wrote is taken from the record `agy` keeps of the conversation (requestRecord), so a chat shows its cache hit rate
 * and speed like any other. What is left of the plan's limits (the 5-hour and the weekly window of each pool of
 * models, and of a single model where `agy` lists one) is read the way `agy`'s own /usage shows it, by a short-lived
 * `agy -p /usage`, which makes no model request and keeps no conversation. MyHarness shows it beside the input box of
 * every chat, on whatever model, with the time until each window resets (pi.registerPlanUsageSource); a MyHarness
 * build from before that shows the percentages of the chat's model in the status bar of the chats on agy instead.
 *
 * Web search source: apart from the provider, `agy`'s own search_web (Google Search grounding) is offered to
 * MyHarness's web_search as a search source ("agy" in Web Search settings, off until the user switches it on, with a
 * model of its own choice there). Chats on any model use it then. A search opens an `agy` conversation of its own,
 * has it call search_web once per query and stops it when the results are in; whatever else `agy` asks permission for
 * there is refused. It returns the sites, their addresses and what the search's summary says of each; MyHarness merges
 * them with its other sources and reads the pages itself. Each search is a model request on the user's `agy` plan, and
 * `agy` keeps it as a short conversation in its own history (it offers no way to delete one).
 *
 * Google's terms restrict using Antigravity sign-in from other software; this file only starts the official `agy acp`
 * for the person at the keyboard. It is not meant for unattended use (schedules, sub-agents, workflows). The search
 * source is the user's own switch for the same reason: once on, any chat's web_search uses it, also an unattended one.
 *
 * The Windows installer carries this file and loads it by itself. From source, copy it to ~/.myharness/agent/extensions/
 * and restart MyHarness; a copy there takes over from the bundled one. `agy` must be installed on that computer.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { calculateContextTokens, createAssistantMessageEventStream, createProvider } from "@myharness/ai";
import type { ExtensionAPI } from "@myharness/coding-agent";
import { Type } from "typebox";

const PROVIDER_ID = "agy";
const PASSTHROUGH_TOOL = "agy_tool";
/** Card tools of this and other shells: never a tool of the chat itself. */
const CARD_TOOLS = new Set([PASSTHROUGH_TOOL, "claude_code_tool"]);
/** The name `agy` knows MyHarness's MCP endpoint by. Unlike "myharness" it is no likely part of a path. */
export const MCP_SERVER = "myharness_app";
/** The first agy with the `acp` command. */
export const MIN_VERSION = "1.5.0";
/**
 * The model an earlier version offered for "whatever `agy` itself is set to". It is no longer listed; a chat that still
 * names it leaves `agy`'s model as it is.
 */
const DEFAULT_MODEL = "default";
/** What the provider resolves to while no Gemini API key is saved: `agy` uses its own login. */
const OWN_LOGIN = "agy-own-login";
const ACP_VERSION = 1;
const IDLE_CLOSE_MS = 15 * 60_000;
/** A program that has not ended its turn this long after a cancel is ended; the next turn picks the chat up again. */
const INTERRUPT_GRACE_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
/** No ACP activity for ten minutes, excluding tools MyHarness is still running. */
const TURN_IDLE_MS = 10 * 60_000;
/** Opening the chat's conversation in `agy` (new, resumed, or loaded with its whole past replayed) may take this long. */
const OPEN_TIMEOUT_MS = 3 * 60_000;
/**
 * `agy` ended its turn with a call still unfinished. A last report that is merely late gets this long; after that the
 * call's card ends instead of waiting for a result that is not coming.
 */
const LATE_REPORT_MS = 2_000;
const LEFT_CALL_TEXT = "agy 结束了这一轮，但没有报告这个工具的结果；它启动的东西可能还在运行。";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_CARD_CHARS = 30_000;
/**
 * `agy` passes on only the beginning of a long message: with agy 1.5.9 and Gemini 4 Hydrogen the first 192,000 UTF-8
 * bytes of the request, its own wrapping included, followed by a note to the model; the end is gone and the client is
 * not told (seen 2026-11-17, with text and with an embedded resource alike; the limit is `agy`'s
 * max_user_request_bytes, which its service may set differently per model). A message that carries the chat's earlier
 * conversation lost its newest part and the user's new words that way, and the model answered an older question. What
 * this plugin puts into one message stays under this, with room for that wrapping and for a lower limit.
 */
export const MAX_PROMPT_BYTES = 150_000;
/**
 * A model on which `agy` still cut a message shorter gets its messages kept this far under what it took (cutFromInput),
 * and never less than the floor below.
 */
const CUT_MARGIN_BYTES = 8_000;
const MIN_PROMPT_BYTES = 32_000;
/** One tool result in an earlier part of the chat goes along with this much at most. */
const MAX_TOOL_RESULT_BYTES = 20_000;
/** A message only part of which fits is still given in part (its beginning and its end) when this much room is left. */
const MIN_PART_BYTES = 2_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** The shortest context length a user may set for a model: below it `agy` would compact after nearly every turn. */
export const MIN_CONTEXT_LIMIT = 50_000;
/** `agy models` and `agy -p /usage` answer in a few seconds, with no model request. */
const LIST_TIMEOUT_MS = 30_000;
const QUOTA_TIMEOUT_MS = 45_000;
/** What is left of the plan is asked again when a chat opens and the last reading is this old. */
const QUOTA_FRESH_MS = 5 * 60_000;
/** After a turn, at most this often: the numbers only move with use. */
const QUOTA_MIN_INTERVAL_MS = 60_000;
/** After a failed reading the next one waits this long. */
const QUOTA_RETRY_MS = 5 * 60_000;
/** A window that has reset is asked about this long after its reset time. */
const QUOTA_RESET_DELAY_MS = 15_000;
const MAX_TIMER_MS = 2_147_000_000;
/** `agy`'s own background updater looks for a new version at most this often; so does the check made here in its place. */
const UPDATE_CHECK_MS = 15 * 60_000;
/** An update that is found is downloaded and installed by the same run. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;
/**
 * A conversation opened ahead of the message that will use it (AcpSession.warm) is closed again when no message has
 * come this long after.
 */
const WARM_IDLE_MS = 2 * 60_000;
/** How long the last model request of a turn may take to show up in `agy`'s own record before its numbers are given up. */
const USAGE_SETTLE_MS = 600;

/**
 * Which MyHarness tools stand for each kind of action ACP reports (ToolKind). An action `agy` asks permission for is
 * allowed while one of them is switched on in the chat, and refused while none is.
 */
export const KIND_TOOLS: Readonly<Record<string, readonly string[]>> = {
	read: ["read"],
	search: ["grep", "find", "ls", "read"],
	edit: ["edit", "write", "apply_patch"],
	delete: ["edit", "write", "apply_patch", "bash", "pwsh"],
	move: ["edit", "write", "apply_patch", "bash", "pwsh"],
	execute: ["bash", "pwsh"],
	fetch: ["web_fetch", "web_search"],
};

/** The MyHarness tools of `active` that `agy` gets over MCP, by name. */
export function offeredNames(active: string[]): string[] {
	return active.filter((name) => !CARD_TOOLS.has(name));
}

/**
 * What to answer when `agy` asks permission for an action of this kind in a chat whose MyHarness tools are `active`:
 * MyHarness's switches decide what they stand for, the model's own thinking is free, and the user decides the rest.
 */
export function permissionFor(kind: string | undefined, active: string[]): "allow" | "reject" | "ask" {
	if (kind === "think") return "allow";
	const tools = kind ? KIND_TOOLS[kind] : undefined;
	if (!tools) return "ask";
	return tools.some((name) => active.includes(name)) ? "allow" : "reject";
}

const WORK = [
	{ label: "reading files", needs: KIND_TOOLS.read },
	{ label: "searching files", needs: KIND_TOOLS.search },
	{ label: "creating and changing files", needs: KIND_TOOLS.edit },
	{ label: "running commands", needs: KIND_TOOLS.execute },
];

/**
 * What `agy` is told about where it runs, for a chat whose MyHarness tools are `active` (MyHarness's names): that
 * MyHarness's instructions follow and win, which of the tool names they use are its own tools and which are MyHarness's,
 * and what of its own does not exist here. `appTools` is false when `agy` takes no MCP server from MyHarness.
 */
export function appendPromptFor(active: string[], appTools = true): string {
	// In one fixed order: the same tools give the same text however a chat lists them. The text is compared to tell
	// whether a conversation must be opened again (AcpSession.servesPrompt).
	const offered = appTools ? offeredNames(active) : [];
	const off = WORK.filter((work) => !work.needs.some((name) => active.includes(name))).map((work) => work.label);
	const lines = [
		"# MyHarness",
		"- You are running inside MyHarness, a desktop app the user chose as the interface for Antigravity CLI (agy).",
		"- Your replies appear in MyHarness's chat window, which renders Markdown; they are not shown in a terminal.",
		"- After this section come MyHarness's own instructions: its built-in prompt, the user's personal prompt and model prompt, and project context. They are the rules of this chat: follow all of them, for the whole conversation.",
		"- MyHarness supplies the authoritative instructions for this chat, including user personalization, model-specific instructions, project context, skills and tool rules. Preserve the priorities stated inside that complete prompt; do not invent a different order. They take precedence over Antigravity defaults and customizations.",
		"- All actions use the tools on the MyHarness MCP server. Never use Antigravity native tools, including manage_task, run_command, file tools, subagents, workflows, scheduling or search. MyHarness owns execution, permissions, progress, cancellation and persistence.",
		"",
		"# Tools in this chat",
		"- MyHarness decides which tools this chat has. Its instructions name them by MyHarness's plain names.",
		...(off.length > 0
			? [
					`- Switched off in this chat: ${off.join(", ")}. Do not try them with any tool; MyHarness refuses the permission.`,
				]
			: []),
		...(offered.length > 0
			? [
					`- Every tool name they list is the tool of that name on the MCP server ${MCP_SERVER} (in your tool list: mcp_${MCP_SERVER}_<name>). MyHarness runs it and shows it to the user.`,
					"- For work one of those tools does (searching the web, the to-do list, questions to the user, memory, earlier chats, the built-in browser, schedules and so on), use that tool, not a built-in tool of yours for the same work.",
				]
			: []),
		"- A tool they do not list is not available in this chat.",
		"",
		"# What does not exist here",
		"- Do not use sub-agents, background tasks, or scheduled and wake-up turns of your own: nothing of yours can bring you back into this chat. Each command you run finishes before you go on.",
		"- After your reply ends, only what MyHarness's instructions name can bring you back. Never say you will check back or report later on anything else.",
	];
	return lines.join("\n");
}

/** What `agy` gets added to its own instructions in a chat: the section above, then MyHarness's whole prompt. */
export function appendedPrompt(active: string[], systemPrompt: string | undefined, appTools = true): string {
	return [appendPromptFor(active, appTools), (systemPrompt ?? "").trim()].filter(Boolean).join("\n\n");
}

/**
 * Whether this `agy` adds a prompt its client gives to the end of its own system prompt, as it says when it is started.
 * The addition is `agy`'s own: ACP has no field for a system prompt.
 */
export function appendsSystemPrompt(capabilities: any): boolean {
	return capabilities?._meta?.antigravity?.systemPrompt?.append === true;
}

/** The instructions as they go in front of a message, for an `agy` that takes no system prompt from its client. */
export function inlineInstructions(prompt: string): string {
	return `<myharness-instructions>\nThese are system-level instructions from MyHarness, the app this conversation runs in. They are not part of the user's message. Follow them for the whole conversation.\n\n${prompt}\n</myharness-instructions>`;
}

/** A file inside the chat's folder is named from that folder ("src/app.ts"); any other by its whole path. */
function shownPath(file: string, cwd: string | undefined): string {
	if (!file || !cwd || !path.isAbsolute(file)) return file;
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : file;
}

/** What a tool `agy` runs by itself is doing, in one line, for its card: the title `agy` gives the call. */
export function callSummary(call: { title?: string; name?: string; kind?: string; rawInput?: any }): string {
	const title = String(call.title ?? "")
		.split(/\r?\n/, 1)[0]
		.trim();
	if (title) return title.slice(0, 160);
	const input = call.rawInput && typeof call.rawInput === "object" ? Object.values(call.rawInput) : [];
	const subject = String(input.find((value) => typeof value === "string" && value) ?? "").split(/\r?\n/, 1)[0];
	return [call.name || call.kind || "tool", subject].filter(Boolean).join(" ").slice(0, 160);
}

const isWord = (text: string, word: string) =>
	new RegExp(`(^|[^A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(text);

/**
 * Whether a call `agy` reports is one of MyHarness's tools, which MyHarness shows and runs itself when the MCP request
 * for it arrives: the reported name or title must identify our MCP server, never just a word in a command or path.
 */
export function namesAppTool(call: { title?: string | null; name?: string | null }, offered: string[]): boolean {
	const name =
		/^mcp_myharness_app_([A-Za-z0-9_.-]+)$/.exec(call.name ?? "")?.[1] ??
		/^([A-Za-z0-9_.-]+) \(myharness_app MCP Server\)$/.exec(call.title ?? "")?.[1];
	return !!name && (!offered.length || offered.includes(name));
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

/** The version in what `agy --version` prints, and whether that `agy` has the `acp` command. */
export function acpSupport(versionOutput: string): { version?: string; ok: boolean } {
	const version = /\d+\.\d+(?:\.\d+)*/.exec(versionOutput)?.[0];
	return { version, ok: !!version && compareVersions(version, MIN_VERSION) >= 0 };
}

/** Variables that would switch `agy` to a key the user did not choose here, or confuse it about where it runs. */
export const STRIPPED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ELECTRON_RUN_AS_NODE"];

/**
 * `agy`'s own switch for its background updater. An `agy` started for one answer (`agy models`, `agy -p /usage`)
 * starts that updater by itself when its last check is a quarter of an hour old, as a process of its own with no
 * console; the updater runs `agy --version`, and Windows opens a terminal window for that, which flashed on the user's
 * screen after a task (seen 2026-11-14 with agy 1.5.8: `agy.exe --bg-updater`, then a Windows Terminal window). Every
 * `agy` started here has the updater off; the same check is made here instead, hidden (keepUpdated). `agy` takes the
 * switch for set only when it reads exactly "true" ("1" leaves the updater on).
 */
export const NO_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

/** The environment `agy` starts with: its own login, or the Gemini API key saved on the provider's card. */
export function launchEnv(base: NodeJS.ProcessEnv, apiKey: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of STRIPPED_ENV) delete env[name];
	if (apiKey) env.GEMINI_API_KEY = apiKey;
	env[NO_AUTO_UPDATE_ENV] = "true";
	return env;
}

/** The key saved for this provider, if the request carries one; `agy`'s own login otherwise. */
const savedKey = (options: any): string | undefined =>
	typeof options?.apiKey === "string" && options.apiKey && options.apiKey !== OWN_LOGIN ? options.apiKey : undefined;

// ---------------------------------------------------------------------------------------------------------------------
// MyHarness's tools as `agy` can call them
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The argument `agy` adds to every tool by itself: one line on what the call is for. `agy` refuses a call without it
 * ("missing property 'toolSummary'") and checks the arguments, that one included, against the tool's own schema.
 */
export const AGY_SUMMARY_ARG = "toolSummary";

const isRecord = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const branchesOf = (schema: any): any[] | undefined =>
	Array.isArray(schema?.anyOf) ? schema.anyOf : Array.isArray(schema?.oneOf) ? schema.oneOf : undefined;
const isObjectSchema = (schema: any): boolean =>
	isRecord(schema) && (schema.type === "object" || isRecord(schema.properties));

/** The one fixed text a property of a branch has, when it has one: what tells the branches of a schema apart. */
function fixedValue(branch: any, key: string): string | undefined {
	const property = branch?.properties?.[key];
	const value =
		property?.const ?? (Array.isArray(property?.enum) && property.enum.length === 1 ? property.enum[0] : undefined);
	return typeof value === "string" ? value : undefined;
}

/**
 * One property as several branches of a schema describe it, as one: what all of them say when they agree, the kind of
 * value alone when only its limits differ, and each shape as an alternative otherwise. Descriptions that differ are
 * kept, each with the branches it is for.
 */
function mergeProperty(variants: Array<{ schema: any; from: string }>): any {
	const shapes = new Map<string, any>();
	const described = new Map<string, string[]>();
	for (const { schema, from } of variants) {
		const { description, ...shape } = isRecord(schema) ? schema : ({} as Record<string, any>);
		shapes.set(stableJson(shape), shape);
		if (typeof description === "string" && description.trim()) {
			described.set(description, [...(described.get(description) ?? []), from]);
		}
	}
	const all = [...shapes.values()];
	let merged: any;
	if (all.length === 1) merged = { ...all[0] };
	else if (
		all.every((shape) => typeof shape.type === "string" && shape.type === all[0].type && !branchesOf(shape)) &&
		all[0].type !== "object" &&
		all[0].type !== "array"
	) {
		merged = {};
		for (const [key, value] of Object.entries(all[0])) {
			if (all.every((shape) => stableJson(shape[key]) === stableJson(value))) merged[key] = value;
		}
	} else {
		const members = new Map<string, any>();
		for (const shape of all)
			for (const member of branchesOf(shape) ?? [shape]) members.set(stableJson(member), member);
		merged = { anyOf: [...members.values()] };
	}
	const texts = [...described.entries()];
	if (texts.length === 1) merged.description = texts[0][0];
	else if (texts.length > 1)
		merged.description = texts.map(([text, from]) => `${from.join(", ")}: ${text}`).join("; ");
	return merged;
}

/**
 * A schema that is one closed object per branch (MyHarness's `workspace`: one per operation), as a single object with
 * every branch's properties, and what each branch takes as lines of text for the tool's description.
 */
function mergeBranches(schema: any): { schema: any; key?: string; closed: boolean; lines: string[] } | undefined {
	const branches = branchesOf(schema);
	if (!branches?.length || !branches.every(isObjectSchema)) return undefined;
	const key = Object.keys(branches[0].properties ?? {}).find((name) =>
		branches.every((branch) => fixedValue(branch, name) !== undefined),
	);
	const names = branches.map((branch, index) => (key ? fixedValue(branch, key)! : `variant ${index + 1}`));
	const variants = new Map<string, Array<{ schema: any; from: string }>>();
	branches.forEach((branch, index) => {
		for (const [name, property] of Object.entries(branch.properties ?? {})) {
			if (name === key) continue;
			variants.set(name, [...(variants.get(name) ?? []), { schema: property, from: names[index] }]);
		}
	});
	const properties: Record<string, any> = { ...(isRecord(schema.properties) ? schema.properties : {}) };
	if (key) properties[key] = { type: "string", enum: [...new Set(names)] };
	for (const [name, list] of variants) properties[name] = mergeProperty(list);
	const requiredOf = (branch: any): string[] => (Array.isArray(branch.required) ? branch.required : []);
	const required = [
		...new Set([
			...(Array.isArray(schema.required) ? schema.required : []),
			...requiredOf(branches[0]).filter((name) => branches.every((branch) => requiredOf(branch).includes(name))),
		]),
	];
	const { anyOf: _anyOf, oneOf: _oneOf, additionalProperties: _closed, ...rest } = schema;
	const lines = branches.map((branch, index) => {
		const fields = Object.keys(branch.properties ?? {})
			.filter((name) => name !== key)
			.map((name) => (requiredOf(branch).includes(name) ? `${name}*` : name));
		const note =
			typeof branch.description === "string" && branch.description.trim() ? ` (${branch.description})` : "";
		return `- ${names[index]}: ${fields.join(", ") || "nothing else"}${note}`;
	});
	return {
		schema: { ...rest, type: "object", properties, ...(required.length ? { required } : {}) },
		key,
		closed: branches.every((branch) => branch.additionalProperties === false),
		lines,
	};
}

/**
 * A MyHarness tool as `agy` is offered it over MCP. `agy` checks every call against the tool's schema with its own
 * `toolSummary` argument in it, so a schema that takes nothing but its own properties refuses every call, with the
 * argument ("additional properties 'toolSummary' not allowed") and without it ("missing property"): the built-in
 * browser's tool, one closed object per operation, could not be called at all. The schema `agy` gets is therefore open
 * at the top, and one object per branch becomes a single object, with what each branch takes spelled out in the
 * description. MyHarness still checks the arguments against the tool's real schema when the call arrives.
 */
export function toolForAgy(tool: { name: string; description?: string; parameters?: any }): {
	name: string;
	description: string;
	inputSchema: any;
} {
	const source = JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} }));
	const merged = mergeBranches(source);
	const inputSchema = merged?.schema ?? source;
	if (isRecord(inputSchema) && inputSchema.additionalProperties === false) delete inputSchema.additionalProperties;
	for (const branch of branchesOf(inputSchema) ?? []) {
		if (isRecord(branch) && branch.additionalProperties === false) delete branch.additionalProperties;
	}
	const legend = merged?.closed ? "* = required; any other argument is refused" : "* = required";
	const heading = merged?.key
		? `Arguments by \`${merged.key}\` (${legend}):`
		: `The argument sets this tool takes, one per call (${legend}):`;
	return {
		name: tool.name,
		description: [tool.description ?? "", ...(merged ? [`${heading}\n${merged.lines.join("\n")}`] : [])]
			.filter(Boolean)
			.join("\n\n"),
		inputSchema,
	};
}

// agy can omit a whole MCP declaration (LoadedCustomization.STATUS_TRUNCATED).
// Keep large manuals in the host instructions, outside the MCP declaration budget.
// This is our size target, not a limit promised by agy.
export function agyToolCatalog(tools: ReturnType<typeof toolForAgy>[]) {
	const manuals: string[] = [];
	const declarations = tools.map((tool) => {
		if (Buffer.byteLength(JSON.stringify(tool)) <= 4096) return tool;
		const notes: string[] = [];
		const compact = (schema: any, location: string): any => {
			if (!isRecord(schema)) return schema;
			const copy = { ...schema };
			if (typeof copy.description === "string") {
				notes.push(`${location}: ${copy.description}`);
				delete copy.description;
			}
			for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
				if (isRecord(copy[key]))
					copy[key] = Object.fromEntries(
						Object.entries(copy[key]).map(([k, v]) => [k, compact(v, `${location}.${k}`)]),
					);
			}
			for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
				if (Array.isArray(copy[key]))
					copy[key] = copy[key].map((v: any, i: number) => compact(v, `${location}.${key}[${i}]`));
			}
			for (const key of ["items", "additionalProperties"])
				if (isRecord(copy[key])) copy[key] = compact(copy[key], `${location}.${key}`);
			return copy;
		};
		const inputSchema = compact(tool.inputSchema, tool.name);
		manuals.push([`Tool manual for ${tool.name}`, tool.description, ...notes].join("\n"));
		return {
			...tool,
			inputSchema,
			description: `${tool.description.split(/(?<=[.!?])\s|\n/u, 1)[0].slice(0, 220)} See the ${tool.name} tool manual in the host instructions.`,
		};
	});
	return { declarations, manual: manuals.join("\n\n") };
}

/** Whether a tool's own schema has an argument of this name, at the top or in one of its branches. */
function declaresArgument(schema: any, name: string): boolean {
	return [schema, ...(branchesOf(schema) ?? [])].some((part) => isRecord(part?.properties) && name in part.properties);
}

/** A call's arguments without `agy`'s own `toolSummary`, unless the tool really has an argument of that name. */
export function argumentsForApp(tool: { parameters?: any } | undefined, args: unknown): unknown {
	if (!isRecord(args) || !(AGY_SUMMARY_ARG in args) || declaresArgument(tool?.parameters, AGY_SUMMARY_ARG))
		return args;
	const { [AGY_SUMMARY_ARG]: _summary, ...rest } = args;
	return rest;
}

// One registry per process: every chat's extension instance shares the same `agy` children and MCP endpoint.
type Shared = {
	sessions: Map<string, AcpSession>;
	contexts: Map<string, any>;
	/** Chats whose next request is MyHarness's summary, not a turn of the conversation. */
	compacting: Set<string>;
	models?: any[];
	mcp?: McpEndpoint;
	versions: Map<string, { version?: string; ok: boolean }>;
	/** The running `agy models` question, asked once per process. */
	discovery?: Promise<void>;
	/** What is left of the plan's limits, as `agy` last said, and the state of asking it. */
	quota?: Quota;
	quotaQuery?: Promise<void>;
	quotaAskedAt?: number;
	quotaFailedAt?: number;
	quotaError?: string;
	/**
	 * Tells MyHarness's own display of plan limits that the numbers changed (pi.registerPlanUsageSource). Unset in a
	 * MyHarness build from before that display: the status bar of each agy chat shows them there.
	 */
	planUsageChanged?: () => void;
	/** `agy -p /usage` gave nothing readable: it is not asked again in this process. */
	quotaUnsupported?: boolean;
	quotaTimer?: ReturnType<typeof setTimeout>;
	/** The last chat request used a Gemini API key saved on the provider's card: the plan's limits do not apply to it. */
	usingKey?: boolean;
	/** When `agy update` was last run here in place of `agy`'s own background updater, and the run under way. */
	updateCheckedAt?: number;
	updating?: Promise<void>;
	/** Whether a copy of the program (programKey) lists `update` among its commands. */
	updateCommands: Map<string, boolean>;
	/** The `agy` last started here adds MyHarness's prompt to its own system prompt (appendsSystemPrompt). */
	appendsPrompt?: boolean;
	/**
	 * MyHarness's prompt as the model request had it, by the prompt the message was sent with (as a hash): MyHarness
	 * adds to its prompt between the two (turnPromptFor). The newest few, the oldest first.
	 */
	turnPrompts: Map<string, string>;
	/** What a message may carry on a model of `agy` that cut one shorter than MAX_PROMPT_BYTES, by model id. */
	promptLimits: Map<string, number>;
};
const SHARED_KEY = Symbol.for("myharness.agy-shell");
const shared: Shared = (globalThis as any)[SHARED_KEY] ?? {
	sessions: new Map(),
	contexts: new Map(),
	compacting: new Set(),
	versions: new Map(),
	updateCommands: new Map(),
	turnPrompts: new Map(),
	promptLimits: new Map(),
};
// A copy of this file from before the hidden update check, or from before a prompt was added to `agy`'s system prompt,
// may have made the registry (a reload of the extension).
shared.updateCommands ??= new Map();
shared.turnPrompts ??= new Map();
shared.promptLimits ??= new Map();
(globalThis as any)[SHARED_KEY] = shared;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const appError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

const dataDir = () =>
	path.join(process.env.MYHARNESS_CODING_AGENT_DIR || path.join(os.homedir(), ".myharness", "agent"), "agy-shell");

// ---------------------------------------------------------------------------------------------------------------------
// Locating the program, and what is remembered between starts
// ---------------------------------------------------------------------------------------------------------------------

/** MYHARNESS_AGY_BIN, the copy agy's installer keeps, or one on PATH. */
function findAgy(): string | undefined {
	const override = process.env.MYHARNESS_AGY_BIN;
	if (override && fs.existsSync(override)) return override;
	const installed = process.env.LOCALAPPDATA
		? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe")
		: path.join(os.homedir(), ".local", "bin", "agy");
	if (fs.existsSync(installed)) return installed;
	try {
		const found = execFileSync(process.platform === "win32" ? "where" : "which", ["agy"], {
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

/** A script stands in for `agy` in tests (MYHARNESS_AGY_BIN): it is run by this process's own Node. */
const isScript = (binary: string) => /\.(mjs|cjs|js)$/i.test(binary);

/** One copy of the program: another one after `agy` updated itself. */
function programKey(binary: string): string {
	try {
		const stat = fs.statSync(binary);
		return `${binary}|${stat.size}|${stat.mtimeMs}`;
	} catch {
		return binary;
	}
}

/**
 * Whether this `agy` has `acp`, asked once per copy of the program. It is asked before `agy acp` is ever started: an
 * older agy has no such command and would take the word for a prompt.
 */
function checkVersion(binary: string): Promise<{ version?: string; ok: boolean }> {
	if (isScript(binary)) return Promise.resolve({ ok: true });
	const key = programKey(binary);
	const known = shared.versions.get(key);
	if (known) return Promise.resolve(known);
	return new Promise((resolve) => {
		execFile(
			binary,
			["--version"],
			{ windowsHide: true, timeout: 30_000, env: launchEnv(process.env, undefined) },
			(error, stdout) => {
				const support = error ? { ok: false } : acpSupport(String(stdout));
				if (!error) shared.versions.set(key, support);
				resolve(support);
			},
		);
	});
}

type LinkEntry = {
	acpSessionId: string;
	cwd: string;
	promptHash?: string;
	hostAgent?: string;
	historyPending?: boolean;
};
const HOST_AGENT = "myharness-host-v2";
export const HOST_TURN_REMINDER =
	"<myharness_turn_reminder>Follow the complete MyHarness system instructions and their stated priorities for this turn, including user personalization, model instructions, tool rules and progress updates. Prior conversation behavior is not permission to ignore them. Use only mcp_myharness_app_* tools; never native Antigravity tools. This is a host reminder, not a new user task.</myharness_turn_reminder>";
const HOST_AGENT_TEXT = `---\nname: ${HOST_AGENT}\ndescription: Managed MyHarness ACP host; selected only by MyHarness.\nmainAgent: true\nsubagent: false\nhidden: true\ninheritCustomizations: false\ninheritMcp: false\nexcludeDefaultComponents: true\ntools: []\n---\nFollow the complete MyHarness instructions appended to this system prompt. Use only MyHarness MCP tools.\n`;

/** Install only our uniquely named definition; never replace a foreign or edited agent file. */
function ensureHostAgent(cwd: string): string {
	// A workspace definition must never shadow the managed global definition.
	for (let current = path.resolve(cwd); ; ) {
		for (const relative of [path.join(HOST_AGENT, "agent.md"), `${HOST_AGENT}.md`]) {
			const shadow = path.join(current, ".agents", "agents", relative);
			if (fs.existsSync(shadow)) throw new Error(`项目中的同名 agy Agent 会覆盖 MyHarness 定义：${shadow}`);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const directory = path.join(os.homedir(), ".gemini", "config", "agents", HOST_AGENT);
	const file = path.join(directory, "agent.md");
	fs.mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `${randomUUID()}.tmp`);
	fs.writeFileSync(temporary, HOST_AGENT_TEXT, { flag: "wx" });
	try {
		try {
			fs.linkSync(temporary, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (fs.readFileSync(file, "utf8") !== HOST_AGENT_TEXT)
			throw new Error(`MyHarness 的 agy Agent 定义被修改，不能安全加载：${file}`);
	} finally {
		fs.unlinkSync(temporary);
	}
	return HOST_AGENT;
}
const linksFile = () => path.join(dataDir(), "links.json");
function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}
function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(dataDir(), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(value, null, "\t"));
	fs.renameSync(temporary, file);
}
const readLinks = () => readJson<Record<string, LinkEntry>>(linksFile(), {});
function writeLink(sessionId: string, entry: LinkEntry | undefined): void {
	const links = readLinks();
	if (entry) links[sessionId] = entry;
	else delete links[sessionId];
	writeJson(linksFile(), links);
}

/**
 * A model `agy` lists for the account, with what has been learned about it: the thinking levels `agy` offers for it
 * (none for a model without the option; unset while not known) and the context window `agy` reported for it.
 */
export type KnownModel = { id: string; name: string; levels?: string[]; window?: number };
const modelsFile = () => path.join(dataDir(), "models.json");
const readKnownModels = (): KnownModel[] => {
	const saved = readJson<KnownModel[]>(modelsFile(), []);
	return (Array.isArray(saved) ? saved : []).filter((model) => model?.id && model.name && model.id !== DEFAULT_MODEL);
};

/** MyHarness's reasoning levels that `agy` has as thinking levels; it has no "off". */
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** The MyHarness level one of `agy`'s thinking levels is, by its value or its name; `agy` calls xhigh "Extra". */
export function levelOf(text: string): string | undefined {
	const level = text
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	if (level === "extra" || level === "extrahigh") return "xhigh";
	return LEVELS.includes(level) ? level : undefined;
}

/** The levels in MyHarness's order, each once. */
const sortedLevels = (levels: Iterable<string>): string[] => {
	const given = new Set(levels);
	return LEVELS.filter((level) => given.has(level));
};

// What the user set for this provider: how long each model's conversation may grow before `agy` compacts it.
const settingsFile = () => path.join(dataDir(), "settings.json");
type ShellSettings = {
	contextLimits?: Record<string, number>;
	/** The copy of `agy` (programKey) whose `-p /usage` gave no table: that copy is not asked again. */
	usageUnsupported?: string;
};
const readSettings = (): ShellSettings => {
	const saved = readJson<ShellSettings>(settingsFile(), {});
	return isRecord(saved) ? saved : {};
};

/** The context length the user set for a model, if any. */
export function contextLimit(modelId: string): number | undefined {
	const value = readSettings().contextLimits?.[modelId];
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_CONTEXT_LIMIT ? value : undefined;
}

function windowFor(model: KnownModel): number {
	return model.window && model.window > 0 ? model.window : DEFAULT_CONTEXT_WINDOW;
}

function modelEntry(model: KnownModel): any {
	return {
		id: model.id,
		name: `agy · ${model.name}`,
		api: "agy-acp",
		provider: PROVIDER_ID,
		baseUrl: "agy://local",
		...reasoningOf(model),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: windowFor(model),
		providerCompactionThreshold: contextLimit(model.id),
		// The conversation and its compaction are `agy`'s.
		managesOwnContext: true,
		// Its own tools act inside `agy`: the task's checkpoint is taken when the task starts (see Model.runsOwnTools).
		runsOwnTools: true,
		maxTokens: 64_000,
	};
}

/** The reasoning levels a model's chats may pick: the ones `agy` offers for it, or all of them while that is not known. */
function reasoningOf(model: KnownModel): { reasoning: boolean; thinkingLevelMap: Record<string, string | null> } {
	const offered = (level: string) => !model.levels || model.levels.includes(level);
	return {
		reasoning: !model.levels || model.levels.length > 0,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			...Object.fromEntries(LEVELS.map((level) => [level, offered(level) ? level : null])),
		},
	};
}

/**
 * The list becomes what is offered: saved for the next start, and at once in this process. The entries a chat already
 * holds are changed in place (the same array and objects the provider reads its models from).
 */
function saveModels(next: KnownModel[]): void {
	const known = readKnownModels();
	if (stableJson(known) !== stableJson(next)) writeJson(modelsFile(), next);
	const held: any[] | undefined = shared.models;
	if (!held) return;
	for (const model of next) {
		const entry = held.find((candidate) => candidate.id === model.id);
		if (entry)
			Object.assign(entry, {
				name: `agy · ${model.name}`,
				...reasoningOf(model),
				contextWindow: windowFor(model),
				providerCompactionThreshold: contextLimit(model.id),
			});
		else held.push(modelEntry(model));
	}
	for (let at = held.length - 1; at >= 0; at--) {
		if (!next.some((model) => model.id === held[at].id)) held.splice(at, 1);
	}
}

/** The models `agy` lists for the account in a conversation are the choices here; what was learned of each is kept. */
function noteModels(listed: Array<{ id: string; name: string }>): void {
	if (!listed.length) return;
	const known = readKnownModels();
	saveModels(
		listed.map((model) => ({
			...known.find((candidate) => candidate.id === model.id),
			id: model.id,
			name: model.name,
		})),
	);
}

/** Something `agy` said about one model: the thinking levels it offers for it, or the window it measures it against. */
function noteModelFact(modelId: string | undefined, fact: { levels?: string[]; window?: number }): void {
	if (!modelId) return;
	const known = readKnownModels();
	const model = known.find((candidate) => candidate.id === modelId);
	if (!model) return;
	if (fact.levels) model.levels = sortedLevels(fact.levels);
	if (fact.window && fact.window > 0) model.window = fact.window;
	saveModels(known);
}

/**
 * What `agy models` prints, one line per model and thinking level ("gemini-4-argon-high<TAB>Gemini 4 Argon (High)"),
 * as the models a conversation offers: lines that differ only in the level are one model with those levels, and a
 * model that comes with a single level, or none, is listed as it is, with no level to pick.
 */
export function parseModelList(text: string): KnownModel[] {
	const groups = new Map<string, { name: string; levels: string[]; lines: Array<{ id: string; name: string }> }>();
	const order: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const [id, name] = line.split("\t").map((part) => part.trim());
		if (!id || !name || /\s/.test(id)) continue;
		const byId = /^(.+)-([a-z]+)$/.exec(id);
		const byName = /^(.+) \(([^()]+)\)$/.exec(name);
		const level = byId && byName && levelOf(byId[2]) === levelOf(byName[2]) ? levelOf(byId[2]) : undefined;
		const key = level ? byId![1] : id;
		if (!groups.has(key)) {
			groups.set(key, { name: level ? byName![1] : name, levels: [], lines: [] });
			order.push(key);
		}
		const group = groups.get(key)!;
		if (level) group.levels.push(level);
		group.lines.push({ id, name });
	}
	return order.flatMap((key): KnownModel[] => {
		const group = groups.get(key)!;
		if (group.levels.length >= 2) return [{ id: key, name: group.name, levels: sortedLevels(group.levels) }];
		return group.lines.map((line) => ({ id: line.id, name: line.name, levels: [] }));
	});
}

/**
 * Runs `agy` for one short answer on stdout (its model list, its plan limits). An `agy` from before `acp` is not asked,
 * as it is never started for a chat: what it would do with these words is not known.
 */
async function askAgy(args: string[], timeoutMs: number): Promise<string> {
	const binary = findAgy();
	if (!binary) throw new Error("找不到 agy 程序");
	if (!(await checkVersion(binary)).ok) throw new Error(`agy 版本低于 ${MIN_VERSION}`);
	const [command, commandArgs] = isScript(binary) ? [process.execPath, [binary, ...args]] : [binary, args];
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			commandArgs,
			{ cwd: os.tmpdir(), env: launchEnv(process.env, undefined), windowsHide: true, timeout: timeoutMs },
			(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
		);
		// `agy` must never wait for a keyboard here.
		child.stdin?.end();
	});
}

/**
 * Why a short-lived `agy` gave no answer, in one line for the user. Node's own message starts with the whole command
 * line and has what the program wrote to stderr after it: the program's words are the reason, not the command.
 */
export function failureText(error: any): string {
	if (error?.killed) return "agy 没有在限定时间内回答";
	const lines = String(error instanceof Error ? error.message : (error ?? ""))
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const said = /^Command failed:/.test(lines[0] ?? "") ? lines[1] : lines[0];
	if (said) return said.slice(0, 200);
	return typeof error?.code === "number" ? `agy 以代码 ${error.code} 退出` : "agy 没有给出额度";
}

/** Whether what `agy --help` prints lists `update` among the program's commands. */
export function listsUpdateCommand(help: string): boolean {
	const commands = help.search(/subcommands/i);
	return commands >= 0 && /^\s*update\s+\S/m.test(help.slice(commands));
}

/** Whether this copy of `agy` has an `update` command, asked once per copy: a word it does not know would be a prompt. */
async function hasUpdateCommand(): Promise<boolean> {
	const binary = findAgy();
	if (!binary || !(await checkVersion(binary)).ok) return false;
	const key = programKey(binary);
	const known = shared.updateCommands.get(key);
	if (known !== undefined) return known;
	const [command, args] = isScript(binary) ? [process.execPath, [binary, "--help"]] : [binary, ["--help"]];
	const help = await new Promise<string | undefined>((resolve) => {
		const child = execFile(
			command,
			args,
			{ cwd: os.tmpdir(), env: launchEnv(process.env, undefined), windowsHide: true, timeout: LIST_TIMEOUT_MS },
			// The help text goes to either stream, and its exit code says nothing here.
			(error, stdout, stderr) => resolve((error as any)?.killed ? undefined : `${stdout}\n${stderr}`),
		);
		child.stdin?.end();
	});
	// No answer in time says nothing about the program: asked again at the next check.
	if (help === undefined) return false;
	const lists = listsUpdateCommand(help);
	shared.updateCommands.set(key, lists);
	return lists;
}

/**
 * Looks for a new version of `agy` in place of its own background updater, which is switched off for every `agy`
 * started here because of the window it opens (NO_AUTO_UPDATE_ENV). `agy update` is the program's own command for the
 * same check; run here it has a hidden console, so nothing it starts shows on the screen. It runs where `agy` made its
 * own check (when it is started for one answer), as often as `agy` did, and never holds anything up.
 */
function keepUpdated(): Promise<void> {
	if (shared.updating) return shared.updating;
	const now = Date.now();
	if (shared.updateCheckedAt !== undefined && now - shared.updateCheckedAt < UPDATE_CHECK_MS) return Promise.resolve();
	shared.updateCheckedAt = now;
	const run: Promise<void> = hasUpdateCommand()
		.then((has) => (has ? askAgy(["update"], UPDATE_TIMEOUT_MS) : undefined))
		.then(
			() => undefined,
			// Offline, or the update server did not answer: looked for again after the usual wait.
			() => undefined,
		)
		.finally(() => {
			if (shared.updating === run) shared.updating = undefined;
		});
	shared.updating = run;
	return run;
}

/**
 * Before any conversation has listed them, the models come from `agy models`: with none known there would be nothing
 * to pick, and the thinking levels of each model are only in that list. A conversation's own list wins once there is
 * one: of the models already known only the levels are taken from here.
 */
function discoverModels(): Promise<void> {
	void keepUpdated();
	shared.discovery ??= askAgy(["models"], LIST_TIMEOUT_MS)
		.then((text) => {
			const listed = parseModelList(text);
			if (!listed.length) return;
			const known = readKnownModels();
			if (!known.length) return saveModels(listed);
			for (const model of known) {
				const levels = listed.find((candidate) => candidate.id === model.id)?.levels;
				if (levels && !model.levels) model.levels = levels;
			}
			saveModels(known);
		})
		.catch(() => {
			// Not installed, not signed in, or offline: asked again when the next chat opens.
			shared.discovery = undefined;
		});
	return shared.discovery;
}

// ---------------------------------------------------------------------------------------------------------------------
// What is left of the plan's limits, shown in every agy chat
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One line of `agy`'s /usage: a pool of models (one for the Gemini models, one for the Claude and GPT models, and for
 * some single models a limit of their own), one of its windows, how much of it is left (0-100) and when it resets.
 */
export type QuotaRow = { pool: string; window: "five_hour" | "weekly"; left: number; resetsAt?: number };
type Quota = { rows: QuotaRow[]; observedAt: number };

/** What `agy -p /usage` prints: one line per pool and window, as pool, window, percent left and reset time, tab-separated. */
export function parseQuota(text: string): QuotaRow[] {
	const rows: QuotaRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const cells = line.split("\t").map((cell) => cell.trim());
		if (cells.length < 3 || !cells[0]) continue;
		const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(cells[2]);
		const window = /five\s*hour/i.test(cells[1]) ? "five_hour" : /week/i.test(cells[1]) ? "weekly" : undefined;
		if (!percent || !window) continue;
		const resetsAt = cells[3] ? Date.parse(cells[3]) : Number.NaN;
		rows.push({
			pool: cells[0],
			window,
			left: Number(percent[1]),
			resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
		});
	}
	return rows;
}

const quotaExpired = (row: QuotaRow, now: number) => row.resetsAt !== undefined && row.resetsAt <= now;

/**
 * The limits a model draws on, among the pools `agy`'s /usage names: the pool many models share, which is named after
 * their families ("Gemini Models", "Claude and GPT models"), and the limit `agy` lists for that one model, if it has one.
 */
export function poolsOf(pools: string[], model: { id: string; name: string }): { shared?: string; own?: string } {
	const name = String(model.name ?? "")
		.replace(/^agy · /, "")
		.toLowerCase();
	const family = /^[a-z]+/.exec(String(model.id ?? "").toLowerCase())?.[0];
	return {
		shared: family ? pools.find((pool) => /\bmodels$/i.test(pool) && isWord(pool.toLowerCase(), family)) : undefined,
		own: pools.find((pool) => pool.toLowerCase() === name),
	};
}

/** The limits as MyHarness's own display takes them (pi.registerPlanUsageSource): what is left, by whose limit it is. */
export type PlanUsageGroup = {
	label: string;
	modelIds?: string[];
	windows: { kind: "five_hour" | "weekly"; leftPercent: number; resetsAt?: number }[];
};

const WINDOW_MS = { five_hour: 5 * 3_600_000, weekly: 7 * 24 * 3_600_000 };
/** How far a full window's reset time may be from a whole window after the reading to count as "not started". */
const IDLE_WINDOW_SLACK_MS = 2 * 60_000;

/**
 * `agy`'s /usage, pool by pool in its own order, each with the models of `models` that draw on it and its windows, the
 * 5-hour one first. A window nothing has been used of has no reset time here: `agy` gives it one a whole window after
 * the moment it is asked (seen with agy 1.5.9 on 2026-11-14: a pool at 100% with resets exactly five hours and seven
 * days after the question), which says the window has not started counting, not when it will reset.
 */
export function quotaGroups(
	rows: QuotaRow[],
	models: { id: string; name: string }[],
	observedAt: number,
): PlanUsageGroup[] {
	const pools = [...new Set(rows.map((row) => row.pool))];
	const drawn = models.map((model) => ({ id: model.id, ...poolsOf(pools, model) }));
	return pools.map((pool) => ({
		label: pool,
		modelIds: drawn.filter((model) => model.shared === pool || model.own === pool).map((model) => model.id),
		windows: (["five_hour", "weekly"] as const).flatMap((kind) => {
			const row = rows.find((candidate) => candidate.pool === pool && candidate.window === kind);
			if (!row) return [];
			const idle =
				row.left >= 100 &&
				row.resetsAt !== undefined &&
				Math.abs(row.resetsAt - observedAt - WINDOW_MS[kind]) <= IDLE_WINDOW_SLACK_MS;
			return [
				{ kind, leftPercent: Math.max(0, Math.min(100, row.left)), resetsAt: idle ? undefined : row.resetsAt },
			];
		}),
	}));
}

/**
 * The status line of a chat on `model`: what is left of the pool its model draws on, and of the limit `agy` lists for
 * that one model when it has one. A window known only from before it reset shows "-".
 */
export function quotaText(
	rows: QuotaRow[],
	model: { id: string; name: string } | undefined,
	now: number,
): string | undefined {
	if (!model?.id || !rows.length) return undefined;
	const { shared: pool, own: ownPool } = poolsOf([...new Set(rows.map((row) => row.pool))], model);
	const left = (row: QuotaRow | undefined) =>
		row && !quotaExpired(row, now) ? `${Math.max(0, Math.min(100, Math.round(row.left)))}%` : "-";
	const windows = (list: QuotaRow[], all: boolean) =>
		(["five_hour", "weekly"] as const)
			.filter((window) => all || list.some((row) => row.window === window))
			.map((window) => `${window === "five_hour" ? "5h" : "7d"} ${left(list.find((row) => row.window === window))}`)
			.join(" · ");
	const own = rows.filter((row) => row.pool === ownPool);
	const parts = [
		...(pool
			? [
					windows(
						rows.filter((row) => row.pool === pool),
						true,
					),
				]
			: []),
		...(own.length ? [`本模型 ${windows(own, false)}`] : []),
	];
	return parts.length ? `agy 额度剩余 ${parts.join(" · ")}` : undefined;
}

/** A context of a chat that has gone throws when read. */
function modelOf(ctx: any): any {
	try {
		return ctx?.model;
	} catch {
		return undefined;
	}
}

/** One status line per chat: what is left of the plan for the chat's model, and what this chat's `agy` is doing. */
function showStatus(sessionId: string, ctx: any = shared.contexts.get(sessionId), model: any = modelOf(ctx)): void {
	const onAgy = model?.provider === PROVIDER_ID;
	// MyHarness's own display of plan limits, where there is one, shows them in every chat: not here a second time.
	const quota =
		onAgy && !shared.usingKey && !shared.planUsageChanged
			? quotaText(shared.quota?.rows ?? [], model, Date.now())
			: undefined;
	const compacting = onAgy && shared.sessions.get(sessionId)?.compactingNow ? "agy 正在压缩上下文…" : undefined;
	try {
		ctx?.ui?.setStatus?.(PROVIDER_ID, [quota, compacting].filter(Boolean).join(" · ") || undefined);
	} catch {}
}

/** MyHarness's display of plan limits reads them again: the numbers changed, or a reading began or ended. */
function notifyPlanUsage(): void {
	try {
		shared.planUsageChanged?.();
	} catch {}
}

/** The limits belong to the account: MyHarness's display of them follows, and every open agy chat. */
function showQuota(): void {
	notifyPlanUsage();
	for (const [sessionId, ctx] of shared.contexts) showStatus(sessionId, ctx);
}

/** What MyHarness's display of plan limits shows for agy right now. */
function planUsageSnapshot() {
	if (shared.usingKey) {
		return { groups: [], unavailable: "agy 正在用保存的 Gemini API key，订阅额度不适用于它。" };
	}
	if (shared.quotaUnsupported) {
		return { groups: [], unavailable: "这个版本的 agy 读不出额度（agy -p /usage 没有给出表格）。" };
	}
	const now = Date.now();
	// The earliest moment a question would really be asked again: one a minute at most.
	const next = shared.quotaAskedAt !== undefined ? shared.quotaAskedAt + QUOTA_MIN_INTERVAL_MS : 0;
	const quota = shared.quota;
	return {
		groups: quota ? quotaGroups(quota.rows, shared.models ?? [], quota.observedAt) : [],
		observedAt: quota?.observedAt,
		refreshing: !!shared.quotaQuery,
		error: shared.quotaFailedAt !== undefined ? (shared.quotaError ?? "agy 没有给出额度") : undefined,
		nextRefreshAt: next > now ? next : undefined,
	};
}

/** When a window resets, its old number goes and `agy` is asked for the new one. */
function scheduleQuotaReset(): void {
	if (shared.quotaTimer) clearTimeout(shared.quotaTimer);
	shared.quotaTimer = undefined;
	const now = Date.now();
	const next = Math.min(
		...(shared.quota?.rows ?? []).map((row) => row.resetsAt ?? Number.POSITIVE_INFINITY).filter((at) => at > now),
	);
	if (!Number.isFinite(next)) return;
	const timer = setTimeout(
		() => {
			if (shared.quotaTimer !== timer) return;
			shared.quotaTimer = undefined;
			showQuota();
			if ([...shared.contexts.values()].some((ctx) => modelOf(ctx)?.provider === PROVIDER_ID)) void refreshQuota(0);
		},
		Math.min(next - now + QUOTA_RESET_DELAY_MS, MAX_TIMER_MS),
	);
	timer.unref?.();
	shared.quotaTimer = timer;
}

/**
 * Asks `agy` what is left of the plan, the way its own /usage does: a short-lived `agy -p /usage`, which answers by
 * itself with no model request and keeps no conversation. Not asked while the last reading is younger than
 * `maxAgeMs`, nor more than once a minute, nor soon after a failure. An `agy` whose answer cannot be read (a version
 * without the command in this mode) is not asked again, also not after a restart, until the program itself has
 * changed: the text would go to a model as a prompt. `asked` is the user's own request to read the numbers again: that
 * one is made soon after a failure too, though not twice a minute either.
 */
function refreshQuota(maxAgeMs: number, asked = false): Promise<void> {
	if (shared.quotaQuery) return shared.quotaQuery;
	const now = Date.now();
	const quota = shared.quota;
	const stale = !quota || now - quota.observedAt >= maxAgeMs || quota.rows.some((row) => quotaExpired(row, now));
	if (shared.quotaUnsupported || shared.usingKey || !stale) return Promise.resolve();
	const binary = findAgy();
	if (!binary) return Promise.resolve();
	const program = programKey(binary);
	if (readSettings().usageUnsupported === program) {
		shared.quotaUnsupported = true;
		notifyPlanUsage();
		return Promise.resolve();
	}
	if (shared.quotaAskedAt !== undefined && now - shared.quotaAskedAt < QUOTA_MIN_INTERVAL_MS) return Promise.resolve();
	if (!asked && shared.quotaFailedAt !== undefined && now - shared.quotaFailedAt < QUOTA_RETRY_MS) {
		return Promise.resolve();
	}
	shared.quotaAskedAt = now;
	void keepUpdated();
	const query: Promise<void> = askAgy(["--print-timeout", "30s", "-p", "/usage"], QUOTA_TIMEOUT_MS)
		.then((text) => {
			const rows = parseQuota(text);
			if (!rows.length) {
				shared.quotaUnsupported = true;
				writeJson(settingsFile(), { ...readSettings(), usageUnsupported: program });
				return;
			}
			shared.quotaFailedAt = undefined;
			shared.quotaError = undefined;
			shared.quota = { rows, observedAt: Date.now() };
			showQuota();
			scheduleQuotaReset();
		})
		.catch((error) => {
			shared.quotaFailedAt = Date.now();
			shared.quotaError = failureText(error);
		})
		.finally(() => {
			if (shared.quotaQuery === query) shared.quotaQuery = undefined;
			// The display shows that a reading is under way, and how it ended.
			notifyPlanUsage();
		});
	shared.quotaQuery = query;
	notifyPlanUsage();
	return query;
}

// ---------------------------------------------------------------------------------------------------------------------
// What each model request used, from `agy`'s own record of the conversation
// ---------------------------------------------------------------------------------------------------------------------

/** One model request: the input tokens it was charged in full, the ones read from the cache, and what it wrote. */
export type RequestUsage = { input: number; cacheRead: number; output: number };

/**
 * Over ACP `agy` says how full the context is and nothing more, so a chat showed no cache hit rate and no speed. What
 * each model request read, read from the cache and wrote is in the record `agy` keeps of the conversation, one JSON
 * line per step (`input_tokens` does not include `cache_read_tokens`; the three add up to the context `agy` reports).
 * Where `agy` keeps that record is not documented: when it is not there, a chat shows the context alone, as before.
 */
const requestRecord = (conversationId: string) =>
	path.join(
		os.homedir(),
		".gemini",
		"antigravity-cli",
		"brain",
		conversationId,
		".system_generated",
		"logs",
		"transcript.jsonl",
	);

/**
 * How many bytes `agy` cut from the end of a message, among the lines of its record, when it did (MAX_PROMPT_BYTES).
 * The record shortens every long message for itself, with one `<truncated N bytes>` in its middle; a message `agy` cut
 * before the model saw it ends with such a mark and a note to the model (seen with agy 1.5.9 on 2026-11-17).
 */
const CUT_NOTE = "NOTE: The output was truncated because it was too long.";
export function cutFromInput(lines: string): number | undefined {
	let cut: number | undefined;
	for (const line of lines.split("\n")) {
		if (!line.includes("USER_INPUT") || !line.includes(CUT_NOTE)) continue;
		let step: any;
		try {
			step = JSON.parse(line);
		} catch {
			continue;
		}
		if (step?.type !== "USER_INPUT" || typeof step.content !== "string") continue;
		const mark = /<truncated (\d+) bytes>\s*NOTE: The output was truncated because it was too long\.[^\n]*\s*$/.exec(
			step.content,
		);
		if (mark) cut = (cut ?? 0) + Number(mark[1]);
	}
	return cut;
}

/** The model requests among the lines of a record: a step is one when it carries token counts. */
export function requestsIn(lines: string): RequestUsage[] {
	const count = (value: unknown) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
	return lines.split("\n").flatMap((line): RequestUsage[] => {
		if (!line.includes('"output_tokens"')) return [];
		let step: any;
		try {
			step = JSON.parse(line);
		} catch {
			return [];
		}
		const usage = {
			input: count(step?.input_tokens),
			cacheRead: count(step?.cache_read_tokens),
			output: count(step?.output_tokens),
		};
		return usage.input + usage.cacheRead + usage.output > 0 ? [usage] : [];
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Local MCP endpoint offering MyHarness's tools to `agy`
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

/**
 * What tells two reports of one call apart from two calls: its arguments, without `agy`'s own `toolSummary`, which the
 * call `agy` reports may carry and its MCP request may not.
 */
function callKey(args: unknown): string {
	if (!isRecord(args) || !(AGY_SUMMARY_ARG in args)) return stableJson(args);
	const { [AGY_SUMMARY_ARG]: _summary, ...rest } = args;
	return stableJson(rest);
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
// The connection: JSON-RPC with one `agy acp`
// ---------------------------------------------------------------------------------------------------------------------

class AcpError extends Error {
	readonly code: number | undefined;
	readonly data: unknown;
	constructor(message: string, code?: number, data?: unknown) {
		// Never stringify arbitrary response data: it can contain request secrets.
		const detail = isRecord(data) && typeof data.message === "string" ? data.message : undefined;
		super(detail && detail !== message ? `${message}: ${detail}` : message);
		this.code = code;
		this.data = data;
	}
}

/** `agy` did not answer a request in time. */
class AcpTimeout extends Error {}

/** `agy` answers -32000 when nobody is signed in. */
const AUTH_REQUIRED = -32000;
const SIGN_IN_HELP =
	"agy 还没有登录。请在终端运行一次 agy（或 agy acp --login）完成登录，或用 /agy-login 让 agy 打开登录页面；也可以在这个 Provider 的卡片里保存 Gemini API key。";

class AcpConnection {
	child?: ChildProcess;
	capabilities: any = {};
	authMethods: any[] = [];
	/** Requests and notifications `agy` sends. A request's answer is what the handler returns. */
	onRequest: (method: string, params: any) => Promise<any> = async () => {
		throw new AcpError("Method not found", -32601);
	};
	onNotification: (method: string, params: any) => void = () => {};
	onExit: (problem: string | undefined) => void = () => {};
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private stderr = "";

	/** Starts `agy acp` and agrees on the protocol. `agy` older than MIN_VERSION is never started. */
	async start(cwd: string, apiKey: string | undefined, hostTools = false): Promise<void> {
		const binary = findAgy();
		if (!binary) throw new Error("找不到 agy 程序。请先安装 Antigravity CLI，或设置 MYHARNESS_AGY_BIN。");
		const support = await checkVersion(binary);
		if (!support.ok) {
			throw new Error(
				support.version
					? `这台电脑的 agy 是 ${support.version}，还没有 acp 命令（${MIN_VERSION} 起才有）。请先在终端运行 agy update。`
					: "无法确认 agy 的版本，所以没有启动它。请在终端运行 agy --version 检查安装。",
			);
		}
		// One worker per conversation, which `agy` requires before it connects to an HTTP MCP server its client names.
		const args = ["acp", "--process-per-session"];
		if (hostTools) args.push("--include-default-customizations=false", "--agent", ensureHostAgent(cwd));
		const [command, commandArgs] = isScript(binary) ? [process.execPath, [binary, ...args]] : [binary, args];
		const child = spawn(command, commandArgs, {
			cwd,
			env: launchEnv(process.env, apiKey),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		this.stderr = "";
		child.stderr?.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-2000);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.finish(child, error.message));
		child.on("exit", (code) => this.finish(child, code ? `agy 退出，代码 ${code}` : undefined));
		createInterface({ input: child.stdout! }).on("line", (line) => {
			if (this.child !== child) return;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			this.onMessage(message);
		});
		const answer = await this.request(
			"initialize",
			{
				protocolVersion: ACP_VERSION,
				// `agy` reads and writes files and runs commands with its own tools; MyHarness lends it none of that.
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "myharness", title: "MyHarness", version: "1" },
			},
			START_TIMEOUT_MS,
		);
		if (answer?.protocolVersion !== ACP_VERSION) {
			this.close();
			throw new Error(`agy 使用的 ACP 协议版本是 ${answer?.protocolVersion}，这个插件只支持版本 ${ACP_VERSION}。`);
		}
		this.capabilities = answer.agentCapabilities ?? {};
		this.authMethods = Array.isArray(answer.authMethods) ? answer.authMethods : [];
		if (apiKey && this.authMethods.some((method) => method?.id === "gemini-api-key")) {
			await this.request("authenticate", { methodId: "gemini-api-key" }, START_TIMEOUT_MS);
		}
	}

	private finish(child: ChildProcess, problem: string | undefined): void {
		if (this.child !== child) return;
		this.child = undefined;
		const text = problem && this.stderr.trim() ? `${problem}\n${this.stderr.trim()}` : problem;
		this.failPending(text ?? "agy 已退出");
		this.onExit(text);
	}

	private failPending(reason: string): void {
		for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
		this.pending.clear();
	}

	private send(message: object): void {
		this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	request(method: string, params: object, timeoutMs?: number): Promise<any> {
		if (!this.child) return Promise.reject(new Error("agy 没有在运行"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
						if (this.pending.delete(id)) reject(new AcpTimeout(`agy 没有回应 ${method} 请求`));
					}, timeoutMs)
				: undefined;
			timer?.unref?.();
			const settle =
				<T>(done: (value: T) => void) =>
				(value: T) => {
					if (timer) clearTimeout(timer);
					done(value);
				};
			this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params: object): void {
		this.send({ method, params });
	}

	private onMessage(message: any): void {
		if (typeof message?.method === "string") {
			if (message.id === undefined || message.id === null) {
				this.onNotification(message.method, message.params ?? {});
				return;
			}
			this.onRequest(message.method, message.params ?? {}).then(
				(result) => this.send({ id: message.id, result: result ?? {} }),
				(error) =>
					this.send({
						id: message.id,
						error: {
							code: error instanceof AcpError && error.code !== undefined ? error.code : -32603,
							message: error instanceof Error ? error.message : String(error),
						},
					}),
			);
			return;
		}
		const waiting = this.pending.get(message?.id);
		if (!waiting) return;
		this.pending.delete(message.id);
		if (message.error) {
			waiting.reject(
				new AcpError(String(message.error.message ?? "agy 报错"), Number(message.error.code), message.error.data),
			);
		} else waiting.resolve(message.result);
	}

	close(): void {
		const child = this.child;
		this.child = undefined;
		this.failPending("已关闭");
		if (!child) return;
		child.stdin?.end();
		setTimeout(() => {
			if (child.exitCode === null) child.kill();
		}, 3000).unref();
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// One `agy` conversation per chat
// ---------------------------------------------------------------------------------------------------------------------

/** A tool `agy` runs by itself, as it reports it. */
type OwnCall = {
	id: string;
	title?: string;
	name?: string;
	kind?: string;
	rawInput?: any;
	rawOutput?: any;
	content: any[];
	failed: boolean;
	finished: boolean;
	/** It may be one of MyHarness's tools: no card is shown for it unless it ends without MyHarness having run it. */
	held: boolean;
	/** MyHarness shows and runs this call itself (an MCP request arrived for it). */
	mirror: boolean;
	done: Deferred<OwnCall>;
};
/** A MyHarness tool `agy` called over MCP: the card MyHarness runs answers the waiting request. */
type AppCall = { name: string; key: string; mirrorId?: string; result?: any; waiters: ((result: any) => void)[] };
type SelectOption = { id: string; current?: string; values: { value: string; name: string }[] };

function plainText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => {
			if (part.type === "text") return part.text;
			if (part.type === "toolCall") return `[tool ${part.name}: ${JSON.stringify(part.arguments).slice(0, 300)}]`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/** The first `bytes` bytes of a text at most, never half a character. */
function headBytes(text: string, bytes: number): string {
	if (bytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

/** The last `bytes` bytes of a text at most, never half a character. */
function tailBytes(text: string, bytes: number): string {
	if (bytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= bytes) return text;
	let start = buffer.length - bytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

/** A text in at most `bytes` bytes: its beginning and its end, with how much was left out between them. */
export function clipBytes(text: string, bytes: number): string {
	const size = bytesOf(text);
	if (size <= bytes) return text;
	const gap = (left: number) => `\n[... ${left} bytes left out ...]\n`;
	const room = bytes - bytesOf(gap(size));
	if (room <= 0) return headBytes(text, bytes);
	const head = headBytes(text, Math.floor(room / 2));
	const tail = tailBytes(text, room - bytesOf(head));
	return `${head}${gap(size - bytesOf(head) - bytesOf(tail))}${tail}`;
}

/** The room a note on left-out earlier messages takes at the top of a transcript. */
const TRANSCRIPT_NOTE_BYTES = 200;

/**
 * What an earlier part of a chat said, in at most `budget` UTF-8 bytes, for an `agy` conversation that did not see it
 * happen (or a request of MyHarness's own that answers apart from the chat). `agy` drops the end of a longer message,
 * which is the newest part of the chat and the words that follow it (MAX_PROMPT_BYTES), so the budget is kept here.
 *
 * What was said (the user's messages, the model's words and the tools it called) comes first, newest first: a chat
 * that is too long loses its oldest messages, never its newest, and a note says how many are left out. Tool results
 * fill the room that is left, also newest first; one that does not fit is named with its size instead (in a chat
 * measured on 2026-11-17 they were four fifths of the text, and pushed out every message after the second question).
 */
export function renderTranscript(messages: any[], budget: number): string {
	const entries = messages.flatMap((message) => {
		const text = plainText(message.content);
		if (!text) return [];
		const tool = message.role === "toolResult";
		return [{ label: tool ? `tool result (${message.toolName})` : String(message.role), text, tool }];
	});
	const room = budget - TRANSCRIPT_NOTE_BYTES;
	if (!entries.length || room < MIN_PART_BYTES) return "";
	const separator = 2;
	const standIn = (entry: (typeof entries)[number]) => `${entry.label}: [left out, ${bytesOf(entry.text)} bytes]`;
	const shown: string[] = [];
	let used = 0;
	let first = entries.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const line = entry.tool ? standIn(entry) : `${entry.label}: ${entry.text}`;
		const size = bytesOf(line) + separator;
		if (used + size > room) {
			// The newest message that does not fit whole goes along in part when there is room for a useful part of it.
			const left = room - used - separator;
			if (!entry.tool && left >= MIN_PART_BYTES) {
				shown[i] = clipBytes(line, left);
				used += bytesOf(shown[i]) + separator;
				first = i;
			}
			break;
		}
		shown[i] = line;
		used += size;
		first = i;
	}
	for (let i = entries.length - 1; i >= first; i--) {
		const entry = entries[i];
		if (!entry.tool) continue;
		const stand = bytesOf(shown[i]);
		const left = room - used + stand;
		const whole = `${entry.label}: ${clipBytes(entry.text, MAX_TOOL_RESULT_BYTES)}`;
		const line = bytesOf(whole) <= left ? whole : left >= MIN_PART_BYTES ? clipBytes(whole, left) : undefined;
		if (!line) continue;
		shown[i] = line;
		used += bytesOf(line) - stand;
	}
	const kept = shown.slice(first).filter((line) => line !== undefined);
	const note =
		first > 0
			? `(${first} earlier message${first === 1 ? " is" : "s are"} left out here: agy takes only so much in one message.)\n\n`
			: "";
	return `${note}${kept.join("\n\n")}`;
}

/** The choices of a select option `agy` offers (ACP's SessionConfigOption), flat. */
function selectOption(option: any): SelectOption | undefined {
	if (!option || option.type !== "select" || !Array.isArray(option.options)) return undefined;
	const values = option.options.flatMap((entry: any) => (Array.isArray(entry?.options) ? entry.options : [entry]));
	return {
		id: String(option.id),
		current: typeof option.currentValue === "string" ? option.currentValue : undefined,
		values: values
			.filter((entry: any) => typeof entry?.value === "string")
			.map((entry: any) => ({ value: entry.value, name: String(entry.name ?? entry.value) })),
	};
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** How many prompts are remembered for conversations opened ahead (each is tens of kilobytes). */
const MAX_TURN_PROMPTS = 8;

/**
 * The prompt a model request will carry, for the prompt the message was sent with. MyHarness finishes its prompt after
 * before_agent_start has seen it (the user's personal prompt, the memory rules and the chat's own folder are added
 * then), so a conversation opened ahead with what that event shows would be opened with a prompt that is never used,
 * and `agy` takes a system prompt only when a conversation is opened. What the request carried the last time a message
 * was sent with the same prompt is what it will carry this time, unless a setting changed in between; the request
 * itself always decides (AcpSession.servesPrompt). Unknown until one request has been made with that prompt.
 */
function turnPromptFor(early: string | undefined): string | undefined {
	return shared.turnPrompts.get(hashOf(early ?? ""));
}

/** A request was made: this is the prompt a message sent with `earlyHash` ends up with. */
function noteTurnPrompt(earlyHash: string, prompt: string | undefined): void {
	shared.turnPrompts.delete(earlyHash);
	shared.turnPrompts.set(earlyHash, prompt ?? "");
	for (const oldest of shared.turnPrompts.keys()) {
		if (shared.turnPrompts.size <= MAX_TURN_PROMPTS) break;
		shared.turnPrompts.delete(oldest);
	}
}

/**
 * What a running `agy` and its conversation were started with and cannot be given later: the MyHarness tools the
 * conversation was offered (their names), and whether `agy` runs on a saved key or its own login.
 */
const launchSignature = (active: string[], apiKey: string | undefined) =>
	`${[...active].sort().join(",")}|${apiKey ? `key:${hashOf(apiKey)}` : "login"}`;

/** The value of `agy`'s thinking level that a MyHarness level stands for; `agy` calls xhigh "Extra". */
export function thoughtValue(values: { value: string; name: string }[], level: string): string | undefined {
	const wanted = level === "xhigh" ? ["xhigh", "extra", "extra high", "extra_high"] : [level];
	const norm = (text: string) => text.trim().toLowerCase();
	return values.find((entry) => wanted.includes(norm(entry.value)) || wanted.includes(norm(entry.name)))?.value;
}

class AcpSession {
	connection?: AcpConnection;
	acpSessionId?: string;
	signature = "";
	/** `agy` is working on a prompt: its answer to session/prompt has not arrived. */
	turnActive = false;
	/** A prompt was sent and the provider has not read its end yet. */
	turnOpen = false;
	/** A cancel was sent; settles when `agy` has ended that turn. */
	draining?: Deferred<void>;
	lastUserTimestamp?: number;
	tools: any[] = [];
	/** How full `agy` says its context is. */
	usage?: { used: number; size: number };
	/** MyHarness's tools reach `agy` in this conversation. */
	appTools = false;
	/** The chat's earlier messages must go along as text: `agy` started a conversation that has not seen them. */
	needsHistory = false;
	/** Instructions still to go in front of the next message (an `agy` that takes no system prompt from its client). */
	pendingInstructions?: string;
	/** `agy` took MyHarness's prompt as its system prompt when this conversation was opened. */
	takesPrompt = false;
	/** MyHarness's prompt as the chat's newest message was sent with (before_agent_start), as a hash. */
	earlyPromptHash?: string;
	/** The instructions this conversation has been given, and the ones waiting to go with the next message, as hashes. */
	private givenHash?: string;
	private pendingHash?: string;
	/** A start made ahead of the request that will use it (warm), until it is over; it never rejects. */
	warming?: Promise<void>;
	/** Kinds of action the user allowed for the rest of this chat. */
	/** `agy`'s slash commands in this conversation, by name. */
	commands: string[] = [];
	/** `agy` is compacting the conversation because it reached the length the user set for the model. */
	compactingNow = false;
	/** How much of `agy`'s record of this conversation has been read for its model requests, in bytes. */
	private recordAt = 0;
	/** The UTF-8 bytes of text the last message sent carried. */
	sentBytes = 0;
	/** The last message sent carried the chat's earlier conversation. */
	historySent = false;
	/** `agy` cut the end off a message that carried the chat's earlier conversation: the next message starts over. */
	startOver = false;
	/** Bytes `agy` cut from the end of the last message sent, as its record shows (cutFromInput). */
	private inputCut?: number;
	private modelOption?: SelectOption;
	private thoughtOption?: SelectOption;
	private queue: any[] = [];
	private waiter?: (event: any) => void;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private interruptTimer?: ReturnType<typeof setTimeout>;
	private activityTimer?: ReturnType<typeof setTimeout>;
	private turn = 0;
	/** Updates are a replay of the conversation's past (session/load), not this turn's. */
	private replaying = false;
	/** A prompt of MyHarness's own (compaction) is running: nothing of it belongs to the chat. */
	private silent = false;
	private ownCalls = new Map<string, OwnCall>();
	private appCalls = new Map<string, AppCall>();

	readonly sessionId: string;
	readonly ephemeral: boolean;

	constructor(sessionId: string, ephemeral = false) {
		this.sessionId = sessionId;
		this.ephemeral = ephemeral;
	}

	get cwd(): string {
		return shared.contexts.get(this.sessionId)?.cwd ?? process.cwd();
	}

	get running(): boolean {
		return !!this.connection?.child;
	}

	/** The MyHarness tools switched on in this chat, by name. */
	activeNames(): string[] {
		return this.tools.map((tool) => tool.name).filter((name) => !CARD_TOOLS.has(name));
	}

	private toolCatalog() {
		const offered = new Set(offeredNames(this.activeNames()));
		return agyToolCatalog(this.tools.filter((tool) => offered.has(tool.name)).map(toolForAgy));
	}

	offeredTools(): any[] {
		return this.toolCatalog().declarations;
	}

	/**
	 * Starts `agy` and opens this chat's conversation in it: the one it continues when `agy` can resume it, a new one
	 * otherwise. MyHarness's prompt goes along to be added to `agy`'s system prompt, or waits for the next message.
	 */
	async start(
		model: any,
		effort: string | undefined,
		systemPrompt: string | undefined,
		apiKey?: string,
	): Promise<void> {
		const connection = new AcpConnection();
		connection.onNotification = (method, params) => {
			if (this.connection === connection && method === "session/update") this.onUpdate(params?.update ?? {});
		};
		connection.onRequest = async (method, params) => {
			if (this.connection !== connection || method !== "session/request_permission") {
				throw new AcpError("Method not found", -32601);
			}
			return this.onPermission(params);
		};
		connection.onExit = (problem) => {
			if (this.connection !== connection) return;
			this.connection = undefined;
			this.turnActive = false;
			this.touchActivity();
			this.settleDraining();
			this.releaseWaiting(problem ?? "agy 已退出");
			if (this.turnOpen) this.push({ type: "__exit", problem });
		};
		this.connection = connection;
		this.commands = [];
		// Stop, or a close, can come while `agy` is still starting: that `agy` is ended here, not left running unused.
		const stillWanted = () => {
			if (this.connection !== connection) throw new Error("已中断");
		};
		try {
			await connection.start(this.cwd, apiKey, true);
			stillWanted();
			await this.open(connection, systemPrompt);
			stillWanted();
			await this.applyModel(model, effort);
		} catch (error) {
			if (this.connection === connection) this.connection = undefined;
			connection.close();
			throw error instanceof AcpError && error.code === AUTH_REQUIRED ? new Error(SIGN_IN_HELP) : error;
		}
	}

	private async open(connection: AcpConnection, systemPrompt: string | undefined): Promise<void> {
		const capabilities = connection.capabilities;
		const sessions = capabilities.sessionCapabilities ?? {};
		if (!appendsSystemPrompt(capabilities) || (!this.ephemeral && !capabilities.mcpCapabilities?.http))
			throw new Error("此 agy 不支持 MyHarness 系统指令或工具接管，请运行 agy update 后重试。");
		const mcpServers: any[] = [];
		this.appTools = false;
		if (!this.ephemeral && this.offeredTools().length > 0 && capabilities.mcpCapabilities?.http) {
			const mcp = await ensureMcp();
			mcpServers.push({
				type: "http",
				name: MCP_SERVER,
				url: `http://127.0.0.1:${mcp.port}/mcp/${encodeURIComponent(this.sessionId)}`,
				headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
			});
			this.appTools = true;
		}
		const prompt = this.promptFor(systemPrompt);
		const promptHash = hashOf(prompt);
		const takesPrompt = appendsSystemPrompt(capabilities);
		shared.appendsPrompt = takesPrompt;
		// With every way of opening: `agy` does not keep the addition with a conversation it resumes or loads.
		const setup = {
			cwd: this.cwd,
			mcpServers,
			...(takesPrompt && prompt ? { _meta: { antigravity: { systemPrompt: { append: prompt } } } } : {}),
		};
		const link = this.ephemeral ? undefined : readLinks()[this.sessionId];
		let answer: any;
		let resumed = false;
		if (
			link &&
			link.hostAgent === HOST_AGENT &&
			path.resolve(link.cwd) === path.resolve(this.cwd) &&
			(sessions.resume || capabilities.loadSession)
		) {
			try {
				if (sessions.resume) {
					answer = await connection.request(
						"session/resume",
						{ sessionId: link.acpSessionId, ...setup },
						OPEN_TIMEOUT_MS,
					);
				} else {
					// `agy` sends the whole conversation again; the chat already shows it.
					this.replaying = true;
					answer = await connection.request(
						"session/load",
						{ sessionId: link.acpSessionId, ...setup },
						OPEN_TIMEOUT_MS,
					);
				}
				this.acpSessionId = link.acpSessionId;
				this.needsHistory = link.historyPending === true;
				resumed = true;
			} catch (error) {
				if (error instanceof AcpError && error.code === AUTH_REQUIRED) throw error;
				// An `agy` that is gone or does not answer would not answer the next request either.
				if (!connection.child || error instanceof AcpTimeout) throw error;
				// The conversation is gone on `agy`'s side: start over with the chat's history.
			} finally {
				this.replaying = false;
			}
		}
		if (!resumed) {
			this.usage = undefined;
			answer = await connection.request("session/new", setup, OPEN_TIMEOUT_MS);
			this.acpSessionId = String(answer?.sessionId ?? "");
			if (!this.acpSessionId) throw new Error("agy 没有给出会话 id");
			this.needsHistory = true;
		}
		this.takesPrompt = takesPrompt;
		// The instructions the conversation has: the ones `agy` took as its system prompt just now, or the ones an
		// earlier message carried. Instructions `agy` did not take that way go in front of a message: the first of a
		// new conversation, and the next one after they changed. They count as given once that message is sent, not
		// before: a conversation that was opened and never used has none.
		this.givenHash = takesPrompt ? promptHash : resumed ? link?.promptHash : undefined;
		this.queueInstructions(takesPrompt ? "" : prompt, promptHash);
		this.saveLink();
		// What `agy` already recorded of a conversation that is picked up again belongs to turns that are over.
		this.recordAt = resumed ? this.recordSize() : 0;
		this.noteOptions(answer?.configOptions);
	}

	/** MyHarness's instructions as this conversation gets them. */
	private promptFor(systemPrompt: string | undefined): string {
		return this.ephemeral
			? (systemPrompt ?? "").trim()
			: [appendedPrompt(this.activeNames(), systemPrompt, this.appTools), this.appTools && this.toolCatalog().manual]
					.filter(Boolean)
					.join("\n\n");
	}

	/** Instructions the conversation has not got wait for the next message; ones it has are not sent again. */
	private queueInstructions(prompt: string, promptHash: string): void {
		const due = !!prompt && this.givenHash !== promptHash;
		this.pendingInstructions = due ? inlineInstructions(prompt) : undefined;
		this.pendingHash = due ? promptHash : undefined;
	}

	/**
	 * Which `agy` conversation this chat continues, and which instructions a message of that conversation carried.
	 * Instructions `agy` took as its system prompt are not in the conversation: they are given again whenever it is
	 * opened, and an `agy` that takes none must not find them counted as said.
	 */
	private saveLink(): void {
		if (this.ephemeral || !this.acpSessionId) return;
		writeLink(this.sessionId, {
			acpSessionId: this.acpSessionId,
			cwd: this.cwd,
			promptHash: this.takesPrompt ? undefined : this.givenHash,
			hostAgent: HOST_AGENT,
			...(this.needsHistory ? { historyPending: true } : {}),
		});
	}

	/**
	 * Whether the conversation as it was opened serves a request with these instructions. Instructions `agy` took as
	 * its system prompt are fixed while it runs, so other ones need a restart; instructions that travel in front of a
	 * message need none (setInstructions).
	 */
	servesPrompt(systemPrompt: string | undefined): boolean {
		return !this.takesPrompt || this.givenHash === hashOf(this.promptFor(systemPrompt));
	}

	/** For an `agy` that takes no system prompt: instructions the conversation has not got go with the next message. */
	setInstructions(systemPrompt: string | undefined): void {
		if (this.takesPrompt || !this.acpSessionId) return;
		const prompt = this.promptFor(systemPrompt);
		this.queueInstructions(prompt, hashOf(prompt));
	}

	/**
	 * Starts `agy` and opens this chat's conversation ahead of the request that will use it. Between a message being
	 * sent and the model being asked MyHarness looks up memories, which takes seconds (2.4 to 5.3 s in the chats
	 * measured on 2026-11-14); `agy` needs one to two seconds to start and open a conversation, and does that
	 * meanwhile instead of afterwards. Whatever goes wrong here is left for the request to meet again and report.
	 *
	 * `early` is MyHarness's prompt as the message was sent with, which is not yet the one the request carries
	 * (turnPromptFor). An `agy` that takes the prompt as its system prompt takes it when the conversation is opened, so
	 * the conversation is opened ahead only once the request's prompt is known from an earlier message; until then the
	 * request opens it, as it did before conversations were opened ahead. Opened with any other prompt it would have
	 * to be opened a second time, which costs what was to be saved.
	 */
	warm(model: any, effort: string | undefined, early: string | undefined, tools: any[]): void {
		if (this.ephemeral) return;
		this.earlyPromptHash = hashOf(early ?? "");
		if (this.connection || this.warming || this.turnOpen || this.turnActive || this.draining) return;
		const known = turnPromptFor(early);
		if (known === undefined && shared.appendsPrompt !== false) return;
		this.tools = tools;
		this.signature = launchSignature(this.activeNames(), undefined);
		const warming: Promise<void> = this.start(model, effort, known ?? early, undefined)
			.then(
				() => {
					// Stopped or closed meanwhile: there is nothing left to end.
					if (!this.connection) return;
					// No message came after all (it was taken back, or failed before the model was asked).
					if (this.idleTimer) clearTimeout(this.idleTimer);
					this.idleTimer = setTimeout(() => {
						if (!this.turnOpen && !this.turnActive) this.close();
					}, WARM_IDLE_MS);
					this.idleTimer.unref();
				},
				() => {},
			)
			.finally(() => {
				if (this.warming === warming) this.warming = undefined;
			});
		this.warming = warming;
	}

	/** A request is about to use the conversation: it is not closed for being unused in the meantime. */
	hold(): void {
		if (!this.idleTimer || !this.connection) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (!this.turnOpen && !this.turnActive) this.close();
		}, IDLE_CLOSE_MS);
		this.idleTimer.unref();
	}

	/**
	 * `agy`'s session options, always the whole list: the models of the account, and the thinking levels of the model
	 * the conversation is on (a model without the option has none).
	 */
	private noteOptions(options: any): void {
		if (!Array.isArray(options)) return;
		const pick = (category: string) =>
			options.map((option) => (option?.category === category ? selectOption(option) : undefined)).find(Boolean);
		const models = pick("model");
		if (models) {
			this.modelOption = models;
			noteModels(models.values.map((entry) => ({ id: entry.value, name: entry.name })));
		}
		this.thoughtOption = pick("thought_level");
		const levels = (this.thoughtOption?.values ?? []).flatMap(
			(entry) => levelOf(entry.value) ?? levelOf(entry.name) ?? [],
		);
		noteModelFact(this.modelOption?.current, { levels });
	}

	private recordSize(): number {
		try {
			return this.acpSessionId ? fs.statSync(requestRecord(this.acpSessionId)).size : 0;
		} catch {
			return 0;
		}
	}

	/** `agy` keeps a record of this conversation where this file looks for it. */
	hasRecord(): boolean {
		return !!this.acpSessionId && fs.existsSync(requestRecord(this.acpSessionId));
	}

	/** The model requests `agy` has recorded for this conversation since the last look. */
	takeRequests(): RequestUsage[] {
		if (!this.acpSessionId) return [];
		const size = this.recordSize();
		// A record that was written anew starts over at its end: nothing of it is counted twice.
		if (size < this.recordAt) this.recordAt = size;
		if (size === this.recordAt) return [];
		try {
			const bytes = Buffer.alloc(size - this.recordAt);
			const file = fs.openSync(requestRecord(this.acpSessionId), "r");
			try {
				fs.readSync(file, bytes, 0, bytes.length, this.recordAt);
			} finally {
				fs.closeSync(file);
			}
			// Only whole lines: one still being written is read next time.
			const end = bytes.lastIndexOf(10);
			if (end < 0) return [];
			this.recordAt += end + 1;
			const lines = bytes.subarray(0, end).toString("utf8");
			const cut = cutFromInput(lines);
			if (cut) this.inputCut = (this.inputCut ?? 0) + cut;
			return requestsIn(lines);
		} catch {
			return [];
		}
	}

	/** How many bytes `agy` cut from the end of this turn's message, once, when its record showed it did. */
	takeCut(): number | undefined {
		const cut = this.inputCut;
		this.inputCut = undefined;
		return cut;
	}

	private async setOption(option: SelectOption, value: string): Promise<void> {
		if (option.current === value) return;
		const answer = await this.connection!.request(
			"session/set_config_option",
			{ sessionId: this.acpSessionId, configId: option.id, value },
			START_TIMEOUT_MS,
		);
		option.current = value;
		this.noteOptions(answer?.configOptions);
	}

	/** The chat's model and reasoning level, as `agy`'s own session options; the default model is left as `agy` has it. */
	async applyModel(model: any, effort: string | undefined): Promise<void> {
		if (!this.connection?.child) return;
		if (model?.id && model.id !== DEFAULT_MODEL) {
			const option = this.modelOption;
			// A fixed-level CLI id may be separate model and level options over ACP.
			const suffix = /^(.*)-(low|medium|high|xhigh|max)$/.exec(model.id);
			const selected =
				option?.values.find((entry) => entry.value === model.id) ??
				(suffix ? option?.values.find((entry) => entry.value === suffix[1]) : undefined);
			if (!selected) {
				const available = option?.values.map((entry) => entry.name).join("、");
				throw new Error(
					available
						? `agy 现在没有模型 ${model.id}。它提供的是：${available}。`
						: `这个 agy 没有提供模型选择，无法使用 ${model.id}。请在终端运行 agy update 后再试。`,
				);
			}
			await this.setOption(option!, selected.value);
			if (suffix && selected.value === suffix[1]) effort = suffix[2];
		}
		const value = effort && this.thoughtOption ? thoughtValue(this.thoughtOption.values, effort) : undefined;
		if (effort && this.thoughtOption && !value) throw new Error(`agy 的当前模型不支持思考档位 ${effort}。`);
		if (value && this.thoughtOption) await this.setOption(this.thoughtOption, value);
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

	/**
	 * `agy` went away while nobody was reading (between two tool rounds): what is left of its turn is dropped, unless the
	 * turn's end had already arrived and only waits to be read.
	 */
	dropDeadTurn(): void {
		if (this.running || !this.turnOpen || this.queue.some((event) => event.type === "end")) return;
		this.turnOpen = false;
		this.queue.length = 0;
	}

	/** The next event already waiting, if it is a tool call: calls `agy` made together go into one round. */
	takeWaitingCall(): any {
		const type = this.queue[0]?.type;
		return type === "tool" || type === "app" ? this.queue.shift() : undefined;
	}

	/** Host tools have their own timeout and cancellation; only otherwise-idle ACP turns time out here. */
	private touchActivity(): void {
		if (this.activityTimer) clearTimeout(this.activityTimer);
		this.activityTimer = undefined;
		if (!this.turnActive || this.silent || [...this.appCalls.values()].some((call) => call.result === undefined))
			return;
		this.activityTimer = setTimeout(() => {
			this.interrupt();
			this.push({ type: "error", message: "agy 已连续 10 分钟没有响应，已取消本轮；可以重试。" });
		}, TURN_IDLE_MS);
		this.activityTimer.unref();
	}

	/** Sends a message of the chat; what `agy` does with it arrives as events until its end. */
	sendPrompt(content: any[]): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		// Nothing left over may be taken for this turn's answer, nor an earlier turn's tool call for one of this turn.
		this.queue.length = 0;
		this.forgetCalls("这一轮已经结束");
		// Discard late usage from a cancelled turn before starting another one.
		this.takeRequests();
		this.inputCut = undefined;
		const turn = ++this.turn;
		this.turnActive = true;
		this.turnOpen = true;
		this.touchActivity();
		const prompt = this.pendingInstructions
			? [{ type: "text", text: this.pendingInstructions }, ...content]
			: [...content];
		if (!this.ephemeral) prompt.push({ type: "text", text: HOST_TURN_REMINDER });
		this.sentBytes = prompt.reduce((sum, part) => sum + (part?.type === "text" ? bytesOf(part.text ?? "") : 0), 0);
		if (this.pendingInstructions) {
			// From this message on the conversation has them.
			this.givenHash = this.pendingHash;
			this.saveLink();
		}
		this.pendingInstructions = undefined;
		this.pendingHash = undefined;
		const ended = (event: any) => {
			if (turn !== this.turn) return;
			this.turnActive = false;
			this.touchActivity();
			if (event.type === "end" && event.stopReason === "end_turn") {
				this.needsHistory = false;
				this.saveLink();
			}
			const cancelled = !!this.draining;
			this.settleDraining();
			if (this.idleTimer) clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
			this.idleTimer.unref();
			if (cancelled) return;
			this.push(event);
			// A call `agy` reported and never finished (a command it left running, a tool it gave up) has no result
			// coming: its card would wait for ever, and the whole chat behind it.
			setTimeout(() => {
				if (turn === this.turn) this.endOwnCalls(LEFT_CALL_TEXT);
			}, LATE_REPORT_MS).unref();
		};
		this.connection!.request("session/prompt", { sessionId: this.acpSessionId, prompt }).then(
			(answer) => ended({ type: "end", stopReason: answer?.stopReason }),
			(error) => {
				// A connection that went away reports through its exit.
				if (this.connection?.child)
					ended({
						type: "error",
						message:
							error instanceof AcpError && error.code === AUTH_REQUIRED
								? SIGN_IN_HELP
								: error instanceof Error
									? error.message
									: String(error),
					});
			},
		);
	}

	private settleDraining(): void {
		if (this.interruptTimer) clearTimeout(this.interruptTimer);
		this.draining?.resolve();
		this.draining = undefined;
	}

	/** Stops the turn `agy` is working on. Nothing of it is read any more. */
	interrupt(): void {
		if (this.activityTimer) clearTimeout(this.activityTimer);
		this.activityTimer = undefined;
		this.turnOpen = false;
		this.queue.length = 0;
		this.releaseWaiting("已中断");
		if (!this.turnActive || this.draining || !this.connection?.child) return;
		this.draining = deferred();
		this.connection.notify("session/cancel", { sessionId: this.acpSessionId });
		this.interruptTimer = setTimeout(() => {
			if (this.draining) this.close();
		}, INTERRUPT_GRACE_MS);
		this.interruptTimer.unref();
	}

	close(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.activityTimer) clearTimeout(this.activityTimer);
		this.activityTimer = undefined;
		const connection = this.connection;
		this.connection = undefined;
		this.turnActive = false;
		this.turnOpen = false;
		this.turn++;
		this.queue.length = 0;
		this.settleDraining();
		this.releaseWaiting("已关闭");
		if (!connection?.child) return;
		// A conversation that served one side request is not kept in `agy`'s list.
		const sessions = connection.capabilities?.sessionCapabilities ?? {};
		const tidy =
			this.ephemeral && this.acpSessionId && (sessions.delete || sessions.close)
				? connection
						.request(sessions.delete ? "session/delete" : "session/close", { sessionId: this.acpSessionId }, 3000)
						.catch(() => {})
				: Promise.resolve();
		void tidy.then(() => connection.close());
	}

	/** Nothing may keep waiting on a process or turn that is gone. */
	private releaseWaiting(reason: string): void {
		this.forgetCalls(reason);
	}

	/** Every call of `agy`'s own that has not finished ends as failed, with `reason` as what its card shows. */
	private endOwnCalls(reason: string): void {
		for (const call of this.ownCalls.values()) {
			if (call.finished) continue;
			call.finished = true;
			call.failed = true;
			call.content = [{ type: "content", content: { type: "text", text: reason } }];
			call.done.resolve(call);
		}
	}

	/** The calls of a turn that is over: whatever still waits on one is released first, then they are forgotten. */
	private forgetCalls(reason: string): void {
		this.endOwnCalls(reason);
		const error = appError(reason);
		for (const call of this.appCalls.values()) for (const done of call.waiters.splice(0)) done(error);
		this.appCalls.clear();
		this.ownCalls.clear();
	}

	// What `agy` reports while it works

	private onUpdate(update: any): void {
		this.touchActivity();
		const kind = update?.sessionUpdate;
		if (kind === "usage_update" && Number.isFinite(update.used) && Number.isFinite(update.size)) {
			this.usage = { used: Number(update.used), size: Number(update.size) };
			// The window `agy` measures this model against is remembered: the chat's meter is right from its first turn.
			if (!this.ephemeral && this.usage.size > 0)
				noteModelFact(this.modelOption?.current, { window: this.usage.size });
			return;
		}
		if (kind === "config_option_update") {
			this.noteOptions(update.configOptions);
			return;
		}
		if (kind === "available_commands_update") {
			this.commands = (update.availableCommands ?? []).map((command: any) => String(command?.name ?? ""));
			return;
		}
		if (this.replaying || this.silent || this.draining || !this.turnOpen) return;
		if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
			const block = update.content;
			const text =
				block?.type === "text"
					? String(block.text ?? "")
					: block?.type === "resource_link" && block.uri
						? `\n[${block.name ?? block.uri}](${block.uri})\n`
						: block?.type === "resource" && typeof block.resource?.text === "string"
							? block.resource.text
							: "";
			if (text) this.push({ type: kind === "agent_message_chunk" ? "text" : "thought", text });
		} else if (kind === "tool_call" || kind === "tool_call_update") {
			this.onToolCall(update);
		}
	}

	/**
	 * A call `agy` reports, new or changed. One of its own tools gets a card. One that may be a MyHarness tool is held
	 * back: MyHarness shows and runs that itself when the MCP request arrives, and only a held call that ends without
	 * such a request (it was `agy`'s own after all, or was never run) is shown, as it ended.
	 */
	private onToolCall(update: any): void {
		// Side requests cannot execute cards; refuse permissions and keep reading the textual answer.
		if (this.ephemeral) return;
		const id = String(update.toolCallId ?? "");
		if (!id) return;
		let call = this.ownCalls.get(id);
		const isNew = !call;
		if (!call) {
			call = { id, content: [], failed: false, finished: false, held: false, mirror: false, done: deferred() };
			this.ownCalls.set(id, call);
		}
		if (typeof update.title === "string") call.title = update.title;
		if (typeof update.name === "string") call.name = update.name;
		if (typeof update.kind === "string") call.kind = update.kind;
		if (update.rawInput !== undefined && update.rawInput !== null) call.rawInput = update.rawInput;
		if (update.rawOutput !== undefined && update.rawOutput !== null) call.rawOutput = update.rawOutput;
		if (Array.isArray(update.content)) call.content = update.content;
		if (isNew) {
			const waiting = this.unmirroredAppCall(call);
			if (waiting) {
				call.mirror = true;
				waiting.mirrorId = id;
			} else if (this.appTools && namesAppTool(call, offeredNames(this.activeNames()))) call.held = true;
			else this.push({ type: "tool", id });
		}
		if (call.finished || (update.status !== "completed" && update.status !== "failed")) return;
		call.finished = true;
		call.failed = update.status === "failed";
		if (call.held && !call.mirror) {
			call.held = false;
			this.push({ type: "tool", id });
		}
		call.done.resolve(call);
	}

	/** An MCP request that arrived before `agy` reported the call it belongs to. */
	private unmirroredAppCall(call: OwnCall): AppCall | undefined {
		const key = call.rawInput === undefined ? undefined : callKey(call.rawInput);
		for (const waiting of this.appCalls.values()) {
			if (waiting.mirrorId || waiting.result !== undefined) continue;
			if (namesAppTool(call, [waiting.name]) || (key !== undefined && key === waiting.key)) return waiting;
		}
		return undefined;
	}

	ownCall(id: string): OwnCall | undefined {
		return this.ownCalls.get(id);
	}

	/**
	 * `agy`'s MCP request for a MyHarness tool: it becomes a tool call of the chat, which MyHarness runs with its own
	 * card and approval, and the card's result is the answer.
	 */
	waitForAppTool(name: string, given: unknown): Promise<any> {
		if (!this.turnOpen || this.draining || this.silent) {
			return Promise.resolve(
				appError("MyHarness is not running a task in this chat right now, so it did not run this tool."),
			);
		}
		if (!offeredNames(this.activeNames()).includes(name)) {
			return Promise.resolve(appError(`The tool ${name} is not available in this chat.`));
		}
		// `agy`'s own `toolSummary` is no argument of the tool: MyHarness would refuse the call for it.
		const args = argumentsForApp(
			this.tools.find((tool) => tool.name === name),
			given,
		);
		return new Promise((done) => {
			const id = `agy_app_${randomUUID()}`;
			const call: AppCall = { name, key: callKey(args), waiters: [done] };
			this.appCalls.set(id, call);
			this.touchActivity();
			// The call `agy` reported for this request is not shown a second time.
			for (const own of [...this.ownCalls.values()].reverse()) {
				if (own.mirror || own.finished) continue;
				const same = own.rawInput !== undefined && callKey(own.rawInput) === call.key;
				if (!(own.held ? namesAppTool(own, [name]) || same : same)) continue;
				own.mirror = true;
				call.mirrorId = own.id;
				if (!own.held) {
					// Its card is already up: it ends here instead of waiting for the tool it would wait on.
					own.finished = true;
					own.content = [
						{
							type: "content",
							content: { type: "text", text: "MyHarness 运行了这个工具，结果见它自己的卡片。" },
						},
					];
					own.done.resolve(own);
				}
				break;
			}
			this.push({ type: "app", id, name, args });
		});
	}

	/** MyHarness finished a card: its result answers the MCP request of that call. */
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
		this.touchActivity();
	}

	/**
	 * MyHarness approves its MCP tools when it runs them. Native actions have no authority in a host chat.
	 */
	private async onPermission(params: any): Promise<any> {
		const options: any[] = Array.isArray(params?.options) ? params.options : [];
		const answer = (kinds: string[]) => {
			const option = kinds.map((kind) => options.find((entry) => entry?.kind === kind)).find(Boolean);
			return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
		};
		// Never "always": that could become a standing rule of the user's own `agy`.
		const allow = () => answer(["allow_once"]);
		const reject = () => answer(["reject_once"]);
		if (this.ephemeral || this.silent || !this.turnOpen) return reject();
		const reported = params?.toolCall ?? {};
		const known = this.ownCalls.get(String(reported.toolCallId ?? ""));
		const call = {
			title: reported.title ?? known?.title,
			name: reported.name ?? known?.name,
			kind: reported.kind ?? known?.kind,
			rawInput: reported.rawInput ?? known?.rawInput,
		};
		const active = this.activeNames();
		if (
			this.appTools &&
			!["execute", "edit", "delete", "move"].includes(String(call.kind)) &&
			namesAppTool(call, offeredNames(active))
		)
			return allow();
		// A host session has no native action authority, even if an upstream version unexpectedly offers one.
		return reject();
	}

	/**
	 * A successful command must provide a fresh, lower reading in addition to finishing its turn.
	 */
	async compact(tokensBefore: number, signal: AbortSignal): Promise<boolean> {
		const connection = this.connection;
		if (!connection?.child || this.turnOpen || this.turnActive || this.draining || !this.commands.includes("compact"))
			return false;
		const before = this.usage;
		const usageDropped = () => !!this.usage && this.usage !== before && this.usage.used < tokensBefore;
		this.takeRequests();
		const onAbort = () => this.interrupt();
		signal.addEventListener("abort", onAbort, { once: true });
		this.compactingNow = true;
		showStatus(this.sessionId);
		this.silent = true;
		this.turnActive = true;
		try {
			if (signal.aborted) return false;
			const answer = await connection.request(
				"session/prompt",
				{
					sessionId: this.acpSessionId,
					prompt: [{ type: "text", text: "/compact" }],
				},
				TURN_IDLE_MS,
			);
			if (answer?.stopReason !== "end_turn") return false;
			for (
				let waited = 0;
				!usageDropped() && this.running && !signal.aborted && waited < USAGE_SETTLE_MS;
				waited += 50
			) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return !signal.aborted && this.running && usageDropped();
		} catch {
			this.close();
			return false;
		} finally {
			this.silent = false;
			this.turnActive = false;
			this.compactingNow = false;
			this.touchActivity();
			this.settleDraining();
			this.takeRequests();
			signal.removeEventListener("abort", onAbort);
			showStatus(this.sessionId);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider: turns what `agy` reports into one assistant message per tool round
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

function effortFor(model: any, level: string | undefined): string | undefined {
	return level ? (model.thinkingLevelMap?.[level] ?? undefined) : undefined;
}

function userContent(message: any, images: boolean): any[] {
	const parts =
		typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
	return parts.map((part: any) =>
		part.type === "image"
			? images
				? { type: "image", data: part.data, mimeType: part.mimeType }
				: (() => {
						throw new Error("此 agy 会话不支持图片，图片没有发送。请使用支持图片的模型或识图助手。");
					})()
			: { type: "text", text: part.text ?? "" },
	);
}

/** How a tool `agy` runs by itself looks as a MyHarness call: the card tool, with the one-line summary first. */
function ownToolCall(call: OwnCall): any {
	return {
		type: "toolCall",
		id: call.id,
		name: PASSTHROUGH_TOOL,
		arguments: { summary: callSummary(call), tool: call.name || call.kind || "tool", input: call.rawInput ?? {} },
	};
}

/** What a finished tool of `agy`'s own left, for its card: its text and images, a line per changed file. */
export function ownResult(call: Pick<OwnCall, "content" | "rawOutput">, cwd?: string): any[] {
	const parts: any[] = [];
	for (const item of call.content ?? []) {
		if (item?.type === "content") {
			const block = item.content ?? {};
			if (block.type === "image") parts.push({ type: "image", data: block.data, mimeType: block.mimeType });
			else if (block.type === "text" && block.text) parts.push({ type: "text", text: String(block.text) });
			else if (block.type === "resource_link" && block.uri) parts.push({ type: "text", text: String(block.uri) });
		} else if (item?.type === "diff" && item.path) {
			const before = typeof item.oldText === "string" ? item.oldText.split(/\r?\n/).length : 0;
			const after = String(item.newText ?? "").split(/\r?\n/).length;
			const file = shownPath(String(item.path), cwd);
			parts.push({
				type: "text",
				text:
					typeof item.oldText === "string"
						? `Changed ${file} (${before} → ${after} lines)`
						: `Created ${file} (${after} lines)`,
			});
		}
	}
	if (!parts.length && call.rawOutput !== undefined && call.rawOutput !== null) {
		const raw = typeof call.rawOutput === "string" ? call.rawOutput : JSON.stringify(call.rawOutput, null, 2);
		if (raw) parts.push({ type: "text", text: raw });
	}
	return parts.map((part) => (part.type === "text" ? { ...part, text: part.text.slice(0, MAX_CARD_CHARS) } : part));
}

/** What one message may carry on this model, in UTF-8 bytes (MAX_PROMPT_BYTES, or less where `agy` cut one shorter). */
const promptLimit = (modelId: string | undefined) =>
	Math.min(MAX_PROMPT_BYTES, (modelId && shared.promptLimits.get(modelId)) || MAX_PROMPT_BYTES);

/**
 * The room a message leaves for the chat's earlier conversation, in UTF-8 bytes: what the message carries anyway (the
 * given texts, instructions waiting to go along, the turn's reminder) counts against what one message may carry.
 * Images do not: `agy` takes them as uploads beside the text (a 359 KB image left a message of 832 bytes, whole, with
 * agy 1.5.9 on 2026-11-17).
 */
function historyRoom(session: AcpSession, modelId: string | undefined, texts: string[]): number {
	const carried = [...texts, session.pendingInstructions ?? "", session.ephemeral ? "" : HOST_TURN_REMINDER];
	return promptLimit(modelId) - carried.reduce((sum, text) => sum + bytesOf(text ?? ""), 0);
}

/**
 * `agy` cut the end off the message this turn sent (its record says so; cutFromInput), which the model then never saw.
 * The user is told, since nothing else shows it. Later messages on the model stay under what `agy` took. A message
 * that carried the chat's earlier conversation lost the newest part of it, and that conversation is not continued:
 * the next message starts a new one with the history again, within the lower limit.
 */
function reportCut(session: AcpSession, model: any): void {
	const cut = session.takeCut();
	if (!cut) return;
	// What `agy` took of the text (its own wrapping aside). Less than the floor is no limit to learn from: a short
	// message it cut says nothing about the length it takes.
	const took = session.sentBytes - cut;
	if (took >= MIN_PROMPT_BYTES && model?.id) {
		shared.promptLimits.set(
			model.id,
			Math.min(promptLimit(model.id), Math.max(MIN_PROMPT_BYTES, took - CUT_MARGIN_BYTES)),
		);
	}
	const history = session.historySent && !session.ephemeral;
	if (history) session.startOver = true;
	const size = cut >= 1024 ? `${Math.round(cut / 1024)} KB` : `${cut} 字节`;
	const text = session.ephemeral
		? `agy 截掉了 MyHarness 一个后台请求（如压缩摘要、标题）末尾约 ${size}，它的结果可能不完整。`
		: history
			? `agy 截掉了这条消息末尾约 ${size}：这条消息带着之前的对话记录，模型没看到其中最新的部分。下一条消息会重新整理对话记录交给 agy。`
			: `agy 截掉了这条消息末尾约 ${size}（agy 一条消息能收的长度有限），模型没看到被截掉的部分。请把内容拆短后再发。`;
	shared.contexts.get(session.sessionId)?.ui?.notify?.(text, "warning");
}

async function runTurn(stream: any, session: AcpSession, model: any, context: any, options: any): Promise<void> {
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
		for (const request of session.takeRequests()) {
			output.usage.input += request.input;
			output.usage.cacheRead += request.cacheRead;
			output.usage.output += request.output;
		}
		reportCut(session, model);
		output.usage.totalTokens =
			session.usage?.used ?? output.usage.input + output.usage.cacheRead + output.usage.output;
		output.stopReason = reason;
		output.errorMessage = message;
		stream.push({ type: "error", reason, error: output });
		stream.end();
	};
	stream.push({ type: "start", partial: output });

	const messages: any[] = context.messages ?? [];
	const last = messages[messages.length - 1];
	const effort = effortFor(model, options?.reasoning);
	const apiKey = savedKey(options);
	session.tools = context.tools ?? [];
	// The tools MyHarness offers reach `agy` when a conversation is opened, and the key when `agy` starts: a change of
	// either restarts `agy` between turns, and the conversation is resumed. So does a change of MyHarness's prompt for
	// an `agy` that took it as its system prompt (it takes one only when a conversation is opened); one that gets it in
	// front of a message is just sent the new one.
	const signature = launchSignature(session.activeNames(), apiKey);
	session.dropDeadTurn();
	// This request goes on with the turn `agy` is working on (the results of a tool round), or starts a new one.
	const goesOn = session.turnOpen && (last?.role === "toolResult" || session.lastUserTimestamp === last?.timestamp);
	// A new message while `agy` still works on the last one: that turn ends first, and is over before the next starts.
	if (!goesOn && (session.turnOpen || session.turnActive)) session.interrupt();
	if (session.draining) await session.draining.promise;
	// One wait for Stop for the whole request. It also covers the start: an `agy` that hangs while it starts or opens
	// the conversation left Stop without effect, because nothing listened for it before the first event was read.
	const signal: AbortSignal | undefined = options?.signal;
	let stopWaiting: (() => void) | undefined;
	const aborted = new Promise<{ type: "__abort" }>((resolve) => {
		if (!signal) return;
		const onStop = () => resolve({ type: "__abort" });
		if (signal.aborted) onStop();
		else {
			signal.addEventListener("abort", onStop, { once: true });
			stopWaiting = () => signal.removeEventListener("abort", onStop);
		}
	});
	if (!goesOn) {
		if (!session.ephemeral && shared.usingKey !== !!apiKey) {
			shared.usingKey = !!apiKey;
			// The plan's limits apply to `agy`'s own login alone: the display of them follows.
			notifyPlanUsage();
		}
		// What the prompt the message was sent with has become: the next conversation opened ahead is opened with it.
		if (!session.ephemeral && session.earlyPromptHash) noteTurnPrompt(session.earlyPromptHash, context.systemPrompt);
		const ready = (async () => {
			// A start made ahead of this request (AcpSession.warm) is over first, however it went.
			await session.warming;
			session.hold();
			// The conversation lost the newest part of the history it was given (reportCut): a new one gets it again.
			if (session.startOver) {
				session.startOver = false;
				session.close();
				if (!session.ephemeral) writeLink(session.sessionId, undefined);
			}
			if (session.running && (session.signature !== signature || !session.servesPrompt(context.systemPrompt))) {
				session.close();
			}
			if (!session.running) {
				session.signature = signature;
				await session.start(model, effort, context.systemPrompt, apiKey);
			} else {
				await session.applyModel(model, effort);
				session.setInstructions(context.systemPrompt);
			}
			return { type: "ready" as const };
		})();
		let outcome: { type: "ready" | "__abort" };
		try {
			outcome = await Promise.race([ready, aborted]);
		} catch (error) {
			stopWaiting?.();
			throw error;
		}
		if (outcome.type === "__abort") {
			stopWaiting?.();
			// What was starting is ended; the next message starts `agy` again and resumes the conversation.
			ready.catch(() => {});
			session.close();
			fail("aborted", "已中断");
			return;
		}
	}
	const images = !!session.connection?.capabilities?.promptCapabilities?.image;

	if (last?.role === "toolResult") {
		for (let i = messages.length - 1; i >= 0 && messages[i].role === "toolResult"; i--) {
			session.deliverAppResult(messages[i]);
		}
		// The turn is over in `agy`: the program went away between two tool rounds (restart, idle close).
		if (!goesOn) {
			const go = "Continue where you left off.";
			const earlier = session.needsHistory
				? renderTranscript(
						messages,
						historyRoom(session, model.id, [go, "<earlier-conversation>\n\n</earlier-conversation>\n\n"]),
					)
				: "";
			const history = earlier ? `<earlier-conversation>\n${earlier}\n</earlier-conversation>\n\n` : "";
			session.historySent = !!earlier;
			session.sendPrompt([{ type: "text", text: `${history}${go}` }]);
		}
	} else if (!goesOn) {
		let start = messages.length;
		while (start > 0 && messages[start - 1].role === "user") start--;
		let content: any[];
		try {
			content = messages.slice(start).flatMap((message) => userContent(message, images));
		} catch (error) {
			stopWaiting?.();
			throw error;
		}
		// The new message goes whole; the earlier conversation gets the room it leaves (MAX_PROMPT_BYTES).
		const opening =
			"<earlier-conversation>\nThis chat started before this agy conversation. Earlier messages, for context:\n\n";
		const closing = "\n</earlier-conversation>";
		const earlier = session.needsHistory
			? renderTranscript(
					messages.slice(0, start),
					historyRoom(session, model.id, [
						opening,
						closing,
						...content.map((part) => (part.type === "text" ? part.text : "")),
					]),
				)
			: "";
		if (earlier) content.unshift({ type: "text", text: `${opening}${earlier}${closing}` });
		session.lastUserTimestamp = last?.timestamp;
		session.historySent = !!earlier;
		session.sendPrompt(content);
	}

	const onAbort = () => session.interrupt();
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	let open: { type: "text" | "thinking"; index: number } | undefined;
	const closeBlock = () => {
		if (!open) return;
		const block = output.content[open.index];
		if (open.type === "text") {
			stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: output });
		} else {
			stream.push({ type: "thinking_end", contentIndex: open.index, content: block.thinking, partial: output });
		}
		open = undefined;
	};
	const write = (type: "text" | "thinking", delta: string) => {
		if (open?.type !== type) {
			closeBlock();
			const index = output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" }) - 1;
			open = { type, index };
			stream.push({ type: `${type}_start`, contentIndex: index, partial: output });
		}
		output.content[open.index][type] += delta;
		stream.push({ type: `${type}_delta`, contentIndex: open.index, delta, partial: output });
	};
	/**
	 * What this round used. How full the context is comes from `agy` itself, and MyHarness measures it against the
	 * window `agy` names. What the round's model requests read, read from the
	 * cache and wrote comes from `agy`'s record of the conversation: a round is every request since the last one read,
	 * usually one, and none when `agy` only went on to the next tool of a request already counted.
	 */
	const applyUsage = (requests: RequestUsage[]) => {
		const usage = session.usage;
		if (requests.length || session.hasRecord()) {
			for (const request of requests) {
				output.usage.input += request.input;
				output.usage.cacheRead += request.cacheRead;
				output.usage.output += request.output;
			}
			// `agy` has no charge for writing to the cache; the prompt is what was read in full plus what came from it.
			output.usage.reported = { input: true, output: true, cacheRead: true, cacheWrite: true };
		} else if (usage) output.usage.input = usage.used;
		const latest = requests[requests.length - 1];
		output.usage.totalTokens = usage?.used ?? (latest ? latest.input + latest.cacheRead + latest.output : 0);
		if (usage && usage.size > 0) {
			const window = windowFor({ id: model.id, name: "", window: usage.size });
			model.contextWindow = window;
			const held = shared.models?.find((entry) => entry.id === model.id);
			if (held) held.contextWindow = window;
		}
	};
	const finish = async (reason: "stop" | "length" | "toolUse") => {
		closeBlock();
		let requests = session.takeRequests();
		// The request that wrote a turn's last words may reach the record a moment after the words did.
		if (reason !== "toolUse" && !requests.length && output.content.length > 0 && session.hasRecord()) {
			for (let waited = 0; waited < USAGE_SETTLE_MS && !requests.length; waited += 100) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				requests = session.takeRequests();
			}
		}
		applyUsage(requests);
		reportCut(session, model);
		output.stopReason = reason;
		stream.push({ type: "done", reason, message: output });
		stream.end();
	};
	try {
		for (;;) {
			if (options?.signal?.aborted) {
				fail("aborted", "已中断");
				return;
			}
			const event = await Promise.race([session.next(), aborted]);
			if (event.type === "__abort") {
				fail("aborted", "已中断");
				return;
			}
			if (event.type === "__exit") {
				session.turnOpen = false;
				closeBlock();
				fail("error", event.problem ?? "agy 意外结束了这一轮");
				return;
			}
			if (event.type === "text") write("text", event.text);
			else if (event.type === "thought") write("thinking", event.text);
			else if (event.type === "tool" || event.type === "app") {
				closeBlock();
				// Calls `agy` made together are one round: every card of it is up before MyHarness runs any.
				for (let call = event; call; call = session.takeWaitingCall()) {
					const own = call.type === "tool" ? session.ownCall(call.id) : undefined;
					if (call.type === "tool" && !own) continue;
					const toolCall = own
						? ownToolCall(own)
						: { type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} };
					const contentIndex = output.content.push(toolCall) - 1;
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				}
				if (output.content.some((part: any) => part.type === "toolCall")) {
					await finish("toolUse");
					return;
				}
			} else if (event.type === "end") {
				session.turnOpen = false;
				if (event.stopReason === "cancelled") {
					closeBlock();
					fail("aborted", "已中断");
				} else if (event.stopReason === "refusal") {
					closeBlock();
					fail("error", "agy 拒绝继续这个请求。");
				} else if (event.stopReason === "max_turn_requests") {
					closeBlock();
					fail("error", "agy 已达到本轮模型请求次数上限，任务尚未完成；请继续或重试。");
				} else if (event.stopReason !== "end_turn" && event.stopReason !== "max_tokens") {
					closeBlock();
					fail("error", `agy 返回了未知的停止原因：${String(event.stopReason)}`);
				} else await finish(event.stopReason === "max_tokens" ? "length" : "stop");
				return;
			} else if (event.type === "error") {
				session.turnOpen = false;
				closeBlock();
				fail("error", event.message || "agy 报错");
				return;
			}
		}
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		stopWaiting?.();
	}
}

/** For tests: turns read from a stand-in for `agy`. */
export const internals = {
	AcpSession,
	AcpConnection,
	streamSimple,
	runTurn,
	shared,
	searchWithAgy,
	searchModels,
	readKnownModels,
	discoverModels,
	refreshQuota,
	keepUpdated,
	contextSettings,
	/** A request was made: a message sent with the prompt `early` carried `prompt`. */
	knowTurnPrompt: (early: string, prompt: string) => noteTurnPrompt(hashOf(early), prompt),
};

function streamSimple(model: any, context: any, options: any): any {
	const stream = createAssistantMessageEventStream();
	const sessionId: string | undefined = options?.sessionId;
	// Side requests (titles, summaries) answer apart, so they never enter the chat's conversation.
	const compacting = !!sessionId && shared.compacting.has(sessionId);
	const ephemeral = !sessionId || !context.tools?.length || compacting;
	let session: AcpSession;
	if (ephemeral) {
		session = new AcpSession(sessionId ?? randomUUID(), true);
	} else {
		session = shared.sessions.get(sessionId) ?? new AcpSession(sessionId);
		shared.sessions.set(sessionId, session);
	}
	// A side request has no conversation in `agy`: its messages go as one text, and none of `agy`'s tools may act.
	const sideContext = ephemeral
		? {
				...context,
				tools: [],
				messages: [
					{
						role: "user",
						// Its instruction is usually last, and stays: what does not fit is the oldest part.
						content: renderTranscript(context.messages ?? [], promptLimit(model?.id)) || "(empty)",
						timestamp: Date.now(),
					},
				],
			}
		: context;
	runTurn(stream, session, model, sideContext, options)
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
// Web search source: `agy`'s own search_web (Google Search grounding), for every chat whatever its model
// ---------------------------------------------------------------------------------------------------------------------

export const SEARCH_SOURCE_ID = "agy";
/** The model a search runs on while the user has picked none in Web Search settings. */
export const SEARCH_DEFAULT_MODEL = "gemini-3.8-flash";
const SEARCH_DEFAULT_MODEL_NAME = "Gemini 3.8 Flash";
/** The thinking level a search runs on while the user has picked none: the relay only passes queries on. */
export const SEARCH_DEFAULT_EFFORT = "low";
const SEARCH_TOOL = "search_web";
/** `agy` programs searching at once, over all chats and sub-agents; a search beyond that waits its turn. */
const SEARCH_CONCURRENCY = 2;
/** How often a running search looks at what `agy` has reported and saved (a look that finds nothing new reads no file). */
const SEARCH_POLL_MS = 50;
/** Resolving the sources' redirect links to the pages' own addresses may take this long, all together. */
const SEARCH_RESOLVE_MS = 6_000;
const SNIPPET_CHARS = 300;

type SearchLink = { title: string; url: string; snippet?: string };
type SearchAnswer = { query: string; results: SearchLink[]; error?: string };

/** A query as one line of the relay's message. */
const oneLine = (query: string) => query.replace(/\s+/g, " ").trim();
const sameQuery = (a: string, b: string) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

/**
 * What makes `agy` a relay: one search_web call per numbered line. Its reply lists the sources again, which is only
 * read when the results `agy` saves by itself cannot be (see savedSearchOutputs); normally the turn is stopped first.
 */
export function searchRelayText(queries: string[]): string {
	return [
		"You are being used as a search relay by MyHarness. Each numbered line below is one search query.",
		`For every line, call your web search tool (${SEARCH_TOOL}) once with that line's text, without its number, as the query, word for word. Use no other tool and open no page. Do not rephrase, translate, shorten or merge queries, and do not search for anything else.`,
		'When every search has returned, reply with the sources and nothing else: for each query a heading line "## <number>", then every source line of that search\'s result, copied exactly as it was given, in the form "[n] [site](url)".',
		"",
		...queries.map((query, index) => `${index + 1}. ${query}`),
	].join("\n");
}

const SOURCE_LINE = /^\[(\d+)\] \[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*$/gm;

/** What the summary says where it cites source `n`: the first sentence or table row carrying its `[n]`, as plain text. */
function citedText(summary: string, n: string): string | undefined {
	for (const line of summary.split("\n")) {
		if (!line.includes(`[${n}]`)) continue;
		// A sentence ends at 。！？, or at . ! ? before a space ("6.0" is no end). The mark may stand after the full stop.
		const sentence =
			line
				.split(/(?<=[。！？](?:\[\d+\])*)(?=[^[])|(?<=[.!?](?:\[\d+\])*)\s+/)
				.find((part) => part.includes(`[${n}]`)) ?? line;
		const text = sentence
			.replace(/\[\d+\]/g, "")
			.replace(/[*`#|]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
	}
	return undefined;
}

/**
 * One search_web result as `agy` writes it: the query, a summary with `[n]` citation marks, and the sources as
 * `[n] [site](redirect link)`. A source's snippet is what the summary says where it cites that source.
 */
export function parseSearchOutput(text: string): { query: string; results: SearchLink[] } | undefined {
	const head = /^The search for "([\s\S]*?)" returned the following summary:[ \t]*$/m.exec(text);
	if (!head) return undefined;
	const body = text.slice(head.index + head[0].length);
	const sourcesAt = body.lastIndexOf("\nSources:");
	const summary = sourcesAt >= 0 ? body.slice(0, sourcesAt) : body;
	const results: SearchLink[] = [];
	const seen = new Set<string>();
	for (const match of (sourcesAt >= 0 ? body.slice(sourcesAt) : body).matchAll(SOURCE_LINE)) {
		const [, n, site, url] = match;
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: site.trim() || url, url, snippet: citedText(summary, n) });
	}
	return { query: head[1], results };
}

/** The sources of each query from the relay's own reply ("## <number>" headings over source lines), by query index. */
export function parseSearchListing(reply: string): Map<number, SearchLink[]> {
	const listed = new Map<number, SearchLink[]>();
	const parts = reply.split(/^##\s*(\d+)[^\n]*$/m);
	for (let at = 1; at + 1 < parts.length; at += 2) {
		const results: SearchLink[] = [];
		const seen = new Set<string>();
		for (const match of parts[at + 1].matchAll(SOURCE_LINE)) {
			if (seen.has(match[3])) continue;
			seen.add(match[3]);
			results.push({ title: match[2].trim() || match[3], url: match[3] });
		}
		listed.set(Number(parts[at]) - 1, results);
	}
	return listed;
}

/**
 * The search_web results of one `agy` conversation as `agy` itself saves them, one file per step. `agy` shows a client
 * neither the result nor its sources (ACP reports the call and that it finished, no more), so without these files the
 * model would have to type every link out again, which takes longer than the search. Where `agy` keeps them is not
 * documented: when they are not there, the relay's reply is read instead (parseSearchListing).
 */
function savedSearchOutputs(conversationId: string): Array<{ query: string; results: SearchLink[] }> {
	const steps = path.join(
		os.homedir(),
		".gemini",
		"antigravity-cli",
		"brain",
		conversationId,
		".system_generated",
		"steps",
	);
	let names: string[];
	try {
		names = fs.readdirSync(steps);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		try {
			const parsed = parseSearchOutput(fs.readFileSync(path.join(steps, name, "output.txt"), "utf8"));
			return parsed ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

const GROUNDING_REDIRECT = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//;

/**
 * The sources arrive as Google's grounding redirect links. Each is asked where it leads (one request, not followed),
 * so MyHarness gets the page's own address: the same page from another search source is then the same result. A link
 * that does not answer in time stays as it is; the page read follows it.
 */
async function resolveRedirects(answers: SearchAnswer[], signal: AbortSignal | undefined): Promise<void> {
	const links = answers.flatMap((answer) => answer.results).filter((link) => GROUNDING_REDIRECT.test(link.url));
	if (!links.length) return;
	const limit = AbortSignal.timeout(SEARCH_RESOLVE_MS);
	const both = signal ? AbortSignal.any([signal, limit]) : limit;
	await Promise.all(
		links.map(async (link) => {
			try {
				const response = await fetch(link.url, { redirect: "manual", signal: both });
				const target = response.headers.get("location");
				void response.body?.cancel().catch(() => {});
				if (target && /^https?:\/\//i.test(target)) link.url = target;
			} catch {
				// Left as the redirect link.
			}
		}),
	);
	// Two redirect links of one search can lead to the same page.
	for (const answer of answers) {
		const seen = new Set<string>();
		answer.results = answer.results.filter((link) => !seen.has(link.url) && !!seen.add(link.url));
	}
}

const searchSlots = { busy: 0, waiting: [] as Array<() => void> };

/** A place among the `agy` programs that may search at once, or undefined when the time ran out while waiting. */
function takeSearchSlot(timeoutMs: number, signal: AbortSignal | undefined): Promise<(() => void) | undefined> {
	const release = () => {
		searchSlots.busy -= 1;
		searchSlots.waiting.shift()?.();
	};
	if (searchSlots.busy < SEARCH_CONCURRENCY) {
		searchSlots.busy += 1;
		return Promise.resolve(release);
	}
	return new Promise((resolve) => {
		const give = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", leave);
			searchSlots.busy += 1;
			resolve(release);
		};
		const leave = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", leave);
			const at = searchSlots.waiting.indexOf(give);
			if (at >= 0) searchSlots.waiting.splice(at, 1);
			resolve(undefined);
		};
		const timer = setTimeout(leave, timeoutMs);
		signal?.addEventListener("abort", leave, { once: true });
		searchSlots.waiting.push(give);
	});
}

/**
 * One `agy` conversation searches every query of a web_search call with `agy`'s own search_web, and is stopped when
 * the results are in. What it found (the sites, their addresses, and what the search's summary says of each) goes
 * back to MyHarness, which merges it with the other sources and reads the pages itself.
 *
 * `agy` uses its own login here; a Gemini API key saved on the provider's card belongs to chats. `agy` keeps every
 * conversation in its own history and has no way to delete one, so each search stays there as a short conversation.
 */
async function searchWithAgy(request: {
	queries: string[];
	model?: string;
	effort?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<SearchAnswer[]> {
	if (!findAgy()) throw new Error("找不到 agy 程序。请先安装 Antigravity CLI，或设置 MYHARNESS_AGY_BIN。");
	const startedAt = Date.now();
	const timeLeft = () => request.timeoutMs - (Date.now() - startedAt);
	const late = `${Math.round(request.timeoutMs / 1000)} 秒内没有搜完这个问题。`;
	const stopped = () => {
		if (request.signal?.aborted) throw new Error("已中断");
	};
	const release = await takeSearchSlot(request.timeoutMs, request.signal);
	if (!release) return request.queries.map((query) => ({ query, results: [], error: late }));
	const connection = new AcpConnection();
	let conversationId: string | undefined;
	let turnOver = false;
	try {
		stopped();
		const directory = path.join(dataDir(), "search");
		fs.mkdirSync(directory, { recursive: true });
		const lines = request.queries.map(oneLine);
		/** search_web calls by id: the line they search and whether they finished. */
		const calls = new Map<string, { line: number; done: boolean; failed: boolean }>();
		let otherTool: string | undefined;
		let reply = "";
		let problem: string | undefined;
		connection.onNotification = (method, params) => {
			if (method !== "session/update") return;
			const update = params?.update ?? {};
			if (update.sessionUpdate === "agent_message_chunk") reply += update.content?.text ?? "";
			if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
			const id = String(update.toolCallId ?? "");
			let call = calls.get(id);
			if (!call) {
				if (update.name !== SEARCH_TOOL) {
					otherTool ??= String(update.name ?? update.title ?? "?");
					return;
				}
				const asked = String(update.rawInput?.query ?? "");
				const taken = new Set([...calls.values()].map((entry) => entry.line));
				call = {
					line: lines.findIndex((line, at) => sameQuery(line, asked) && !taken.has(at)),
					done: false,
					failed: false,
				};
				calls.set(id, call);
			}
			if (update.status === "completed" || update.status === "failed") {
				call.done = true;
				call.failed = update.status === "failed";
			}
		};
		// The relay searches and does nothing else: whatever `agy` asks permission for is refused.
		connection.onRequest = async (method, params) => {
			if (method !== "session/request_permission") throw new AcpError("Method not found", -32601);
			const options: any[] = Array.isArray(params?.options) ? params.options : [];
			const refuse =
				options.find((entry) => entry?.kind === "reject_once") ??
				options.find((entry) => entry?.kind === "reject_always");
			return { outcome: refuse ? { outcome: "selected", optionId: refuse.optionId } : { outcome: "cancelled" } };
		};
		connection.onExit = (why) => {
			problem ??= why ?? "agy 已退出";
			turnOver = true;
		};

		await connection.start(directory, undefined);
		stopped();
		const opened = await connection.request(
			"session/new",
			{ cwd: directory, mcpServers: [] },
			Math.max(1, timeLeft()),
		);
		conversationId = String(opened?.sessionId ?? "");
		if (!conversationId) throw new Error("agy 没有给出会话 id");
		stopped();
		// The model and the thinking level the user chose for searches; the lowest level while none is chosen, or while
		// the model has not got the chosen one.
		const optionOf = (options: any, category: string) =>
			(Array.isArray(options) ? options : [])
				.map((option) => (option?.category === category ? selectOption(option) : undefined))
				.find(Boolean);
		const setOption = (id: string, value: string) =>
			connection.request(
				"session/set_config_option",
				{ sessionId: conversationId, configId: id, value },
				Math.max(1, timeLeft()),
			);
		let options = opened?.configOptions;
		const models = optionOf(options, "model");
		if (models) noteModels(models.values.map((entry) => ({ id: entry.value, name: entry.name })));
		const wanted = request.model || SEARCH_DEFAULT_MODEL;
		if (models && models.current !== wanted) {
			if (!models.values.some((entry) => entry.value === wanted)) {
				throw new Error(
					`agy 现在没有模型 ${wanted}。它提供的是：${models.values.map((entry) => entry.name).join("、")}。请在 设置 → 网络搜索 里另选一个。`,
				);
			}
			options = (await setOption(models.id, wanted))?.configOptions ?? options;
		}
		const thought = optionOf(options, "thought_level");
		const level = thought
			? (thoughtValue(thought.values, request.effort || SEARCH_DEFAULT_EFFORT) ??
				thoughtValue(thought.values, SEARCH_DEFAULT_EFFORT))
			: undefined;
		if (thought && level && thought.current !== level) await setOption(thought.id, level);
		stopped();

		connection
			.request("session/prompt", {
				sessionId: conversationId,
				prompt: [{ type: "text", text: searchRelayText(lines) }],
			})
			.catch((error) => {
				problem ??=
					error instanceof AcpError && error.code === AUTH_REQUIRED
						? SIGN_IN_HELP
						: error instanceof Error
							? error.message
							: String(error);
			})
			.finally(() => {
				turnOver = true;
			});

		/** Each line's result as `agy` saved it, once its call has finished. */
		const saved = new Map<number, SearchLink[]>();
		const readSaved = () => {
			const waiting = [...calls.values()].filter(
				(call) => call.done && !call.failed && call.line >= 0 && !saved.has(call.line),
			);
			if (!waiting.length) return;
			for (const output of savedSearchOutputs(conversationId!)) {
				const call = waiting.find((entry) => !saved.has(entry.line) && sameQuery(lines[entry.line], output.query));
				if (call) saved.set(call.line, output.results);
			}
		};
		let ranOut = false;
		while (true) {
			stopped();
			readSaved();
			const finished = [...calls.values()].filter((call) => call.line >= 0 && call.done);
			// Every query's search is over and read (or failed): nothing more is wanted of the turn.
			if (finished.length >= lines.length && finished.every((call) => call.failed || saved.has(call.line))) break;
			// A finished search whose saved result does not turn up is waited for in the relay's reply, at the turn's end.
			if (turnOver || otherTool) break;
			if (timeLeft() <= 0) {
				ranOut = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, SEARCH_POLL_MS));
		}
		readSaved();
		const listed = parseSearchListing(reply);
		const answers: SearchAnswer[] = lines.map((_line, index) => {
			const query = request.queries[index];
			const results = saved.get(index) ?? listed.get(index);
			if (results) return { query, results };
			const call = [...calls.values()].find((entry) => entry.line === index);
			const error = call?.failed
				? "agy 的搜索失败了。"
				: ranOut
					? late
					: otherTool
						? `agy 没有按要求只做搜索（它调用了 ${otherTool}），这次搜索已停止。`
						: "agy 没有搜索这个问题。";
			return { query, results: [], error };
		});
		// Nothing was searched at all: say why, in the program's own words when it gave any (not signed in, the plan's
		// limit is reached). MyHarness then leaves this source alone for a while instead of waiting again.
		if (answers.every((answer) => answer.error)) {
			const why =
				problem ||
				(ranOut ? `agy 在 ${Math.round(request.timeoutMs / 1000)} 秒内没有返回任何搜索结果。` : undefined);
			if (why) throw new Error(why);
		}
		await resolveRedirects(answers, request.signal);
		stopped();
		return answers;
	} catch (error) {
		throw error instanceof AcpError && error.code === AUTH_REQUIRED ? new Error(SIGN_IN_HELP) : error;
	} finally {
		release();
		// The turn is stopped where it is, and the conversation closed; `agy` ends when that is done, or after a moment.
		if (connection.child) {
			if (conversationId && !turnOver) connection.notify("session/cancel", { sessionId: conversationId });
			const closable = conversationId && connection.capabilities?.sessionCapabilities?.close;
			const tidy = closable
				? connection.request("session/close", { sessionId: conversationId }, 3000).catch(() => {})
				: Promise.resolve();
			void tidy.then(() => connection.close());
		}
	}
}

/** Whether `agy` is installed, asked at most every half minute: Web Search settings and every search ask. */
let agySeen: { at: number; found: boolean } | undefined;
function agyInstalled(): boolean {
	const now = Date.now();
	if (!agySeen || now - agySeen.at > 30_000) agySeen = { at: now, found: !!findAgy() };
	return agySeen.found;
}

/**
 * The models a search can run on, each with the thinking levels `agy` offers for it: the ones `agy` has listed for the
 * account, and always the default one. A model whose levels are not known yet offers the ones every model has.
 */
function searchModels(): Array<{ id: string; label: string; efforts: string[] }> {
	const known = readKnownModels().map((model) => ({
		id: model.id,
		label: model.name,
		efforts: model.levels ?? ["low", "medium", "high"],
	}));
	return known.some((model) => model.id === SEARCH_DEFAULT_MODEL)
		? known
		: [{ id: SEARCH_DEFAULT_MODEL, label: SEARCH_DEFAULT_MODEL_NAME, efforts: ["low", "medium", "high"] }, ...known];
}

// ---------------------------------------------------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------------------------------------------------

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** "300k", "1m" or a plain count. A number up to 1000 means thousands, the way MyHarness's own K fields read. */
export function parseTokens(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim().replace(/[,_]/g, ""));
	if (!match) return undefined;
	const unit = match[2].toLowerCase();
	const value = Number(match[1]);
	const tokens = Math.round(unit === "m" ? value * 1_000_000 : unit === "k" || value <= 1000 ? value * 1000 : value);
	return tokens > 0 ? tokens : undefined;
}

/** Sets, or with an empty text clears, how long a model's conversation may grow before `agy` compacts it. */
export function setContextLimit(modelId: string, text: string): void {
	const known = readKnownModels();
	const model = known.find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`agy 现在没有模型 ${modelId}。`);
	const most = model.window && model.window > 0 ? model.window : DEFAULT_CONTEXT_WINDOW;
	const settings = readSettings();
	const limits = { ...(settings.contextLimits ?? {}) };
	if (!text.trim()) delete limits[modelId];
	else {
		const tokens = parseTokens(text);
		if (!tokens || tokens < MIN_CONTEXT_LIMIT || tokens > most) {
			throw new Error(
				`${model.name} 的上下文长度要在 ${formatTokens(MIN_CONTEXT_LIMIT)} 到 ${formatTokens(most)} 之间，例如 300k；留空则用 agy 自己的上限。`,
			);
		}
		limits[modelId] = tokens;
	}
	writeJson(settingsFile(), { ...settings, contextLimits: limits });
	saveModels(known);
}

/** One optional automatic compaction threshold per model, independent of its window. */
function contextSettings(): any[] {
	return readKnownModels().map((model) => ({
		id: `context-length:${model.id}`,
		model: model.id,
		label: "自动压缩阈值",
		description:
			"达到阈值后，下条消息前优先用 agy 原生压缩；不可用、失败或用量没有下降时，用 MyHarness 摘要压缩。留空仅使用 agy 自身的压缩机制。可填 50K 到模型窗口，例如 300k。",
		placeholder: formatTokens(model.window && model.window > 0 ? model.window : DEFAULT_CONTEXT_WINDOW),
		get: () => {
			const limit = contextLimit(model.id);
			return limit ? formatTokens(limit) : "";
		},
		set: (value: string) => setContextLimit(model.id, value),
	}));
}

export default function (pi: ExtensionAPI) {
	shared.models ??= readKnownModels().map(modelEntry);
	const provider: any = createProvider({
		id: PROVIDER_ID,
		name: "agy (Antigravity CLI)",
		baseUrl: "agy://local",
		auth: {
			apiKey: {
				name: "agy 自己的登录，或 Gemini API key",
				// Optional: without a key `agy` uses the login it holds itself.
				async login(interaction: any) {
					return {
						type: "api_key",
						key: await interaction.prompt({
							type: "secret",
							message: "Gemini API key（交给 agy 使用；不填则用 agy 自己的登录）",
						}),
					};
				},
				// `agy`'s own login is never read here. This says whether the program exists, and passes a saved key on.
				async resolve({ credential }: any) {
					if (!findAgy()) return undefined;
					return credential?.key
						? { auth: { apiKey: credential.key }, source: "保存的 Gemini API key" }
						: { auth: { apiKey: OWN_LOGIN }, source: "agy 自己的登录" };
				},
			},
		},
		models: shared.models as any,
		api: { stream: streamSimple, streamSimple } as any,
	} as any);
	// The models are learned while the app runs, so their settings are read each time they are asked for.
	Object.defineProperty(provider, "settings", { get: contextSettings, enumerable: true });
	pi.registerProvider(provider);
	// With no model known there is nothing to pick, and a model's thinking levels are only in `agy`'s own list.
	if (agyInstalled() && (!shared.models.length || readKnownModels().some((model) => !model.levels))) {
		void discoverModels();
	}

	// `agy`'s own search_web as a search source of MyHarness's web_search, for chats on any model. It shows in Web Search
	// settings while `agy` is installed; the user switches it on there and picks the model and the thinking level it
	// searches with. A MyHarness build from before search sources has no such method; the provider must still load there.
	pi.registerWebSearchSource?.({
		id: SEARCH_SOURCE_ID,
		label: "agy",
		models: searchModels,
		defaultModel: SEARCH_DEFAULT_MODEL,
		defaultEffort: SEARCH_DEFAULT_EFFORT,
		unavailable: () => (agyInstalled() ? undefined : "找不到 agy 程序"),
		search: searchWithAgy,
	});

	// What is left of the plan, for MyHarness's own display of plan limits beside the input box of every chat, while
	// `agy` is installed. A MyHarness build from before that display has no such method: the status bar of the chats on
	// agy shows the numbers there. The user's own request to read them again allows no age.
	if (agyInstalled()) {
		shared.planUsageChanged =
			pi.registerPlanUsageSource?.({
				id: PROVIDER_ID,
				label: "agy",
				snapshot: planUsageSnapshot,
				refresh: (options?: { maxAgeMs?: number }) =>
					refreshQuota(options?.maxAgeMs ?? QUOTA_MIN_INTERVAL_MS, options?.maxAgeMs === 0),
			}) ?? undefined;
	}

	const usingAgy = (model: any) => model?.provider === PROVIDER_ID;
	/**
	 * A chat that opens on agy, or switches to it, shows what is left of the plan at once and has `agy` asked for it when
	 * the reading may be old; a chat that switches away no longer shows it.
	 */
	const followQuota = (ctx: any, model: any) => {
		// The event's model, not the context's: a chat that is switching may still report the model it leaves.
		showStatus(sessionIdOf(ctx), ctx, model);
		if (!usingAgy(model)) return;
		void refreshQuota(QUOTA_FRESH_MS);
		if (!shared.models?.length) void discoverModels();
	};
	/** The card tool means nothing to other models, so it is only active while this provider is. */
	const syncActiveTools = (model: any) => {
		const active = pi.getActiveTools();
		const present = active.includes(PASSTHROUGH_TOOL);
		if (usingAgy(model) && !present) pi.setActiveTools([...active, PASSTHROUGH_TOOL]);
		if (!usingAgy(model) && present) pi.setActiveTools(active.filter((name) => name !== PASSTHROUGH_TOOL));
	};
	const sessionIdOf = (ctx: any): string => ctx.sessionManager.getSessionId();

	pi.registerTool({
		name: PASSTHROUGH_TOOL,
		label: "agy",
		// Switched by syncActiveTools as the model changes: tool lists show it as automatic.
		autoActive: true,
		description:
			"Internal to the agy provider: shows a tool agy is running by itself and waits for its result. Never call this directly.",
		parameters: Type.Object({ summary: Type.Optional(Type.String()), tool: Type.String(), input: Type.Any() }),
		async execute(id: string, _params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			const session = shared.sessions.get(sessionIdOf(ctx));
			const call = session?.ownCall(id);
			if (!session || !call) throw new Error("agy 已不再等待这个工具的结果。");
			const onAbort = () => session.interrupt();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const finished = await call.done.promise;
				const content = ownResult(finished, session.cwd);
				if (finished.failed) throw new Error(plainText(content) || "工具失败");
				return { content: content.length ? content : [{ type: "text", text: "(no output)" }], details: {} };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	} as any);

	// `agy` waits for a MyHarness tool before it goes on, while MyHarness only asks the provider to go on once every card
	// of the round is done. So each tool's answer goes back the moment it finishes, not next round.
	pi.on("tool_execution_end", async (event: any, ctx: any) => {
		shared.sessions.get(sessionIdOf(ctx))?.deliverAppResult({
			toolCallId: event.toolCallId,
			content: event.result?.content,
			isError: event.isError,
		});
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		shared.contexts.set(sessionIdOf(ctx), ctx);
		syncActiveTools(ctx.model);
		followQuota(ctx, ctx.model);
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		const id = sessionIdOf(ctx);
		shared.contexts.set(id, ctx);
		if (usingAgy(event.previousModel) && !usingAgy(event.model)) {
			shared.sessions.get(id)?.close();
			shared.sessions.delete(id);
			writeLink(id, undefined);
		}
		syncActiveTools(event.model);
		followQuota(ctx, event.model);
	});

	pi.registerCommand("agy-login", {
		description: "让 agy 用它自己的方式登录（会由 agy 打开浏览器），例如 /agy-login oauth-personal",
		handler: async (args: string, ctx: any) => {
			const connection = new AcpConnection();
			try {
				await connection.start(ctx.cwd ?? os.homedir(), undefined);
				// Signing in by typing a code into a terminal has no place here.
				const methods = connection.authMethods.filter((method) => method?.id && method.type !== "terminal");
				if (!methods.length) {
					ctx.ui.notify("agy 没有提供可以在这里使用的登录方式。请在终端运行 agy 登录。", "warning");
					return;
				}
				let id = args?.trim();
				if (!id && ctx.hasUI) {
					const labels = methods.map((method) => `${method.name ?? method.id}（${method.id}）`);
					const choice = await ctx.ui.select("agy 登录方式（登录由 agy 自己完成，MyHarness 不接触账号）", labels);
					id = choice ? methods[labels.indexOf(choice)]?.id : undefined;
				}
				if (!id) return;
				if (!methods.some((method) => method.id === id)) {
					ctx.ui.notify(`agy 没有登录方式 ${id}。可用：${methods.map((method) => method.id).join("、")}`, "error");
					return;
				}
				ctx.ui.notify("正在等 agy 完成登录，它可能会打开浏览器…", "info");
				await connection.request("authenticate", { methodId: id }, LOGIN_TIMEOUT_MS);
				ctx.ui.notify("agy 已登录。", "info");
			} catch (error) {
				ctx.ui.notify(`agy 登录没有完成：${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				connection.close();
			}
		},
	} as any);

	// A message was sent in a chat on agy. MyHarness looks up memories before it asks the model; `agy` starts and opens
	// the chat's conversation meanwhile, so the request finds it running. An `agy` on a saved key is started by the
	// request itself, which is where the key arrives.
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const model = modelOf(ctx);
		if (!usingAgy(model) || shared.usingKey) return undefined;
		const sessionId = sessionIdOf(ctx);
		// This event's context is made for the one event; the chat's own (session_start) is kept where there is one.
		if (!shared.contexts.has(sessionId)) shared.contexts.set(sessionId, ctx);
		const active = new Set(pi.getActiveTools());
		const tools = pi.getAllTools().filter((tool: any) => active.has(tool.name));
		// A request without tools is a side request and answers apart from the chat's conversation (streamSimple).
		if (!tools.length) return undefined;
		const session = shared.sessions.get(sessionId) ?? new AcpSession(sessionId);
		shared.sessions.set(sessionId, session);
		session.warm(model, effortFor(model, pi.getThinkingLevel()), event.systemPrompt, tools);
		return undefined;
	});

	pi.on("session_before_prompt_compact", async ({ signal, requestSummary }, ctx) => {
		const model = ctx.model;
		if (!model || !usingAgy(model)) return;
		const limit = contextLimit(model.id);
		if (!limit || signal.aborted) return;
		const id = sessionIdOf(ctx);
		const existing = shared.sessions.get(id);
		// ACP can resume without sending a usage event. Use the most recent persisted agy reading on the active
		// branch in that case, never a reading older than a MyHarness checkpoint or from another model.
		let recorded: number | undefined;
		for (const entry of ctx.sessionManager.getBranch().reverse()) {
			if (entry.type === "compaction") break;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			if (message.provider !== PROVIDER_ID || message.model !== model.id) break;
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			recorded = calculateContextTokens(message.usage) || undefined;
			if (recorded !== undefined) break;
		}
		const used = existing?.usage?.used ?? recorded;
		if (used === undefined || used < limit) return;

		const session = existing ?? new AcpSession(id);
		shared.sessions.set(id, session);
		let opening = false;
		const onAbort = () => {
			if (opening) session.close();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		let native = false;
		try {
			await session.warming;
			signal.throwIfAborted();
			session.hold();
			if (!session.running && !session.startOver && readLinks()[id]) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				signal.throwIfAborted();
				if (auth.ok) {
					const apiKey = savedKey(auth);
					const active = new Set(pi.getActiveTools());
					session.tools = pi.getAllTools().filter((tool) => active.has(tool.name));
					session.signature = launchSignature(session.activeNames(), apiKey);
					opening = true;
					await session.start(model, effortFor(model, pi.getThinkingLevel()), ctx.getSystemPrompt(), apiKey);
					opening = false;
				}
			}
			if (session.running && !session.needsHistory && !session.startOver && !signal.aborted) {
				// On an actual resume an ACP reading can arrive before the prompt; prefer it over the saved one.
				const current = session.usage?.used ?? used;
				if (current < limit) return;
				if (!session.commands.length) await new Promise((resolve) => setTimeout(resolve, 100));
				native = await session.compact(current, signal);
			}
		} catch {
			// The portable checkpoint path also covers a failed native reconnect.
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
		if (signal.aborted) return;
		if (native) ctx.ui.notify("已使用 agy 原生压缩上下文。", "info");
		else requestSummary();
	});

	pi.on("turn_end", async (event: any) => {
		const message = event.message;
		if (message?.role !== "assistant" || message.provider !== PROVIDER_ID || message.stopReason !== "length") return;
		if (message.content?.some((part: any) => part.type === "toolCall")) return;
		pi.sendMessage(
			{
				customType: "agy-output-limit",
				content:
					"Your last response reached the output limit. Continue from where it stopped, without repeating it, and complete the task. Keep the next response shorter.",
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	});

	pi.on("agent_start", async (_event: any, ctx: any) => {
		shared.compacting.delete(sessionIdOf(ctx));
	});
	pi.on("session_before_compact", async (_event: any, ctx: any) => {
		if (!usingAgy(ctx.model)) return undefined;
		// ACP /compact does not expose its retained summary. Let MyHarness generate a real,
		// portable checkpoint in an isolated request, including customInstructions.
		shared.compacting.add(sessionIdOf(ctx));
		return undefined;
	});
	pi.on("session_compact", async (_event: any, ctx: any) => {
		const id = sessionIdOf(ctx);
		const affected = shared.compacting.delete(id) || shared.sessions.has(id);
		if (!affected) return;
		// The next request must replay the retained checkpoint, not resume the pre-compaction history.
		shared.sessions.get(id)?.close();
		shared.sessions.delete(id);
		writeLink(id, undefined);
	});
	// Moving to another branch of the chat leaves the `agy` conversation behind: a new one gets the branch as text.
	pi.on("session_tree", async (_event: any, ctx: any) => {
		const sessionId = sessionIdOf(ctx);
		shared.sessions.get(sessionId)?.close();
		shared.sessions.delete(sessionId);
		writeLink(sessionId, undefined);
	});
	// A run can end between two tool rounds (Stop), with no provider call there to pass that on. `agy` would carry on
	// alone, and every MyHarness tool it called would wait for a card that never runs.
	pi.on("agent_end", async (_event: any, ctx: any) => {
		const session = shared.sessions.get(sessionIdOf(ctx));
		if (session?.turnOpen || session?.turnActive) session.interrupt();
		// The task used some of the plan: the status follows, at most once a minute.
		if (usingAgy(modelOf(ctx))) void refreshQuota(QUOTA_MIN_INTERVAL_MS);
	});
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		const sessionId = sessionIdOf(ctx);
		shared.sessions.get(sessionId)?.close();
		shared.sessions.delete(sessionId);
		shared.contexts.delete(sessionId);
	});
}
