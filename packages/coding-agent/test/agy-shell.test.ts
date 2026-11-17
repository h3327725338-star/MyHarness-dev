import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agyShell, {
	AGY_SUMMARY_ARG,
	acpSupport,
	appendedPrompt,
	appendPromptFor,
	appendsSystemPrompt,
	argumentsForApp,
	callSummary,
	clipBytes,
	contextLimit,
	cutFromInput,
	failureText,
	HOST_TURN_REMINDER,
	inlineInstructions,
	internals,
	KIND_TOOLS,
	launchEnv,
	levelOf,
	listsUpdateCommand,
	MAX_PROMPT_BYTES,
	MCP_SERVER,
	NO_AUTO_UPDATE_ENV,
	namesAppTool,
	offeredNames,
	ownResult,
	parseModelList,
	parseQuota,
	parseTokens,
	permissionFor,
	poolsOf,
	quotaGroups,
	quotaText,
	renderTranscript,
	requestsIn,
	STRIPPED_ENV,
	thoughtValue,
	toolForAgy,
} from "../examples/extensions/agy-shell.ts";
import { createWorkspaceToolDefinition } from "../src/tools/workspace.ts";

const MOCK = fileURLToPath(new URL("./fixtures/mock-acp-agent.mjs", import.meta.url));

describe("agy-shell tools and permissions", () => {
	const coding = ["read", "write", "edit", "bash", "pwsh", "web_search", "todo_write", "ask_user_question"];

	it("offers over MCP the MyHarness tools agy has no tool of its own for", () => {
		expect(offeredNames(coding)).toEqual(coding);
		// The card tools of this and the Claude Code shell are never a chat's own tools.
		expect(offeredNames(["agy_tool", "claude_code_tool", "memory_search"])).toEqual(["memory_search"]);
		expect(offeredNames(["read", "grep", "find", "ls", "apply_patch"])).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"apply_patch",
		]);
	});

	it("lets MyHarness's switches decide what agy asks permission for", () => {
		expect(permissionFor("edit", coding)).toBe("allow");
		expect(permissionFor("execute", coding)).toBe("allow");
		expect(permissionFor("read", coding)).toBe("allow");
		// A chat without file or shell tools refuses them, whichever tool agy would use.
		const chatOnly = ["web_search", "memory_search"];
		expect(permissionFor("edit", chatOnly)).toBe("reject");
		expect(permissionFor("delete", chatOnly)).toBe("reject");
		expect(permissionFor("execute", chatOnly)).toBe("reject");
		expect(permissionFor("read", chatOnly)).toBe("reject");
		expect(permissionFor("fetch", chatOnly)).toBe("allow");
		// Thinking is free; a kind no MyHarness tool stands for is the user's to decide.
		expect(permissionFor("think", [])).toBe("allow");
		expect(permissionFor("other", coding)).toBe("ask");
		expect(permissionFor("switch_mode", coding)).toBe("ask");
		expect(permissionFor(undefined, coding)).toBe("ask");
		for (const tools of Object.values(KIND_TOOLS)) expect(tools.length).toBeGreaterThan(0);
	});

	it("tells agy which names are its own tools, which are MyHarness's and what is switched off", () => {
		const prompt = appendPromptFor(coding);
		expect(prompt).toContain("Never use Antigravity native tools");
		expect(prompt).toContain(`MCP server ${MCP_SERVER}`);
		expect(prompt).toContain("MyHarness supplies the authoritative instructions");
		expect(prompt).not.toContain("Switched off in this chat");
		const readOnly = appendPromptFor(["read", "grep", "web_search"]);
		expect(readOnly).toContain("Switched off in this chat: creating and changing files, running commands.");
		expect(appendPromptFor(["web_search"])).toContain(
			"Switched off in this chat: reading files, searching files, creating and changing files, running commands.",
		);
		// MyHarness's instructions outrank what agy has by itself, and its tools the ones agy has for the same work.
		expect(prompt).toContain("Preserve the priorities stated inside that complete prompt");
		expect(prompt).not.toContain("what the user wrote (<user_personalization>) ranks highest");
		expect(prompt).toContain(`in your tool list: mcp_${MCP_SERVER}_<name>`);
		expect(prompt).toContain("use that tool, not a built-in tool of yours for the same work");
		// The same tools in another order are the same text: a chat is not opened again for the order of a list.
		expect(appendPromptFor([...coding].reverse())).toBe(prompt);
		// An agy that takes no MCP server from MyHarness is not told about one.
		expect(appendPromptFor(coding, false)).not.toContain(MCP_SERVER);
		expect(appendPromptFor(coding, false)).not.toContain("use that tool, not");
		// Only an agy that says so adds a prompt to its system prompt (agy 1.5.9's own words).
		expect(appendsSystemPrompt({ _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } })).toBe(
			true,
		);
		expect(appendsSystemPrompt({ sessionCapabilities: { resume: {} } })).toBe(false);
		expect(appendsSystemPrompt({ _meta: { antigravity: { systemPrompt: {} } } })).toBe(false);
		expect(appendsSystemPrompt(undefined)).toBe(false);
		expect(appendedPrompt(coding, "  BASE PROMPT  ")).toMatch(/^# MyHarness[\s\S]*\n\nBASE PROMPT$/);
		expect(inlineInstructions("X")).toMatch(/^<myharness-instructions>[\s\S]*X\n<\/myharness-instructions>$/);
	});

	it("recognizes a call agy reports as one of MyHarness's tools by the server or the tool's name", () => {
		const offered = ["web_search", "todo_write"];
		expect(namesAppTool({ title: `web_search (${MCP_SERVER} MCP Server)` }, offered)).toBe(true);
		expect(namesAppTool({ name: "mcp_other_todo_write", title: "Update the list" }, [])).toBe(false);
		expect(namesAppTool({ name: `mcp_${MCP_SERVER}_todo_write` }, [])).toBe(true);
		expect(namesAppTool({ title: "Calling web_search" }, offered)).toBe(false);
		// Part of a longer word, or of a path, is not the tool.
		expect(namesAppTool({ title: "Read web_search_notes.md" }, offered)).toBe(false);
		expect(namesAppTool({ title: "Run echo myharness_app", name: "run_command" }, offered)).toBe(false);
		expect(namesAppTool({ title: "Read myweb_searcher.ts" }, offered)).toBe(false);
		expect(namesAppTool({ title: "Read C:/myharness/src/app.ts", name: "read_file" }, offered)).toBe(false);
		expect(namesAppTool({}, offered)).toBe(false);
	});

	it("names a card by agy's own title for the call", () => {
		expect(callSummary({ title: "Read src/app.ts\nsecond line", kind: "read" })).toBe("Read src/app.ts");
		expect(callSummary({ kind: "execute", rawInput: { command: "npm test" } })).toBe("execute npm test");
		expect(callSummary({ name: "run_command" })).toBe("run_command");
		expect(callSummary({})).toBe("tool");
	});

	it("shows what a finished tool of agy's own left", () => {
		const cwd = join(tmpdir(), "project");
		expect(
			ownResult(
				{
					content: [
						{ type: "content", content: { type: "text", text: "out" } },
						{ type: "diff", path: join(cwd, "src", "a.ts"), oldText: "1\n2", newText: "1\n2\n3" },
						{ type: "diff", path: join(cwd, "new.txt"), oldText: null, newText: "x" },
						{ type: "terminal", terminalId: "t1" },
					],
				},
				cwd,
			),
		).toEqual([
			{ type: "text", text: "out" },
			{ type: "text", text: "Changed src/a.ts (2 → 3 lines)" },
			{ type: "text", text: "Created new.txt (1 lines)" },
		]);
		// Without content the raw output stands in.
		expect(ownResult({ content: [], rawOutput: "ran" })).toEqual([{ type: "text", text: "ran" }]);
		expect(ownResult({ content: [], rawOutput: { code: 0 } })[0].text).toContain('"code": 0');
		expect(ownResult({ content: [] })).toEqual([]);
	});
});

/**
 * What agy does with a call before it runs it, as its own errors show ("missing property 'toolSummary'", "additional
 * properties 'toolSummary' not allowed"): its `toolSummary` argument is required, and the arguments are checked, that
 * one included, against the schema the tool was offered with.
 */
function agyAccepts(schema: any, args: Record<string, unknown>): boolean {
	return AGY_SUMMARY_ARG in args && Compile(schema).Check(args);
}

describe("agy-shell tool schemas", () => {
	const workspace = createWorkspaceToolDefinition();
	const branches: any[] = (workspace.parameters as any).anyOf;
	const summary = { [AGY_SUMMARY_ARG]: "List the open tabs" };

	it("reproduces why agy could not call the built-in browser's tool at all", () => {
		const offeredBefore = JSON.parse(JSON.stringify(workspace.parameters));
		// With agy's own argument every closed branch refuses the call; without it agy refuses the call itself.
		expect(agyAccepts(offeredBefore, { operation: "tabs", ...summary })).toBe(false);
		expect(agyAccepts(offeredBefore, { operation: "tabs" })).toBe(false);
	});

	it("offers one object per operation as a single open object agy's own argument passes", () => {
		const offered = toolForAgy(workspace);
		expect(offered.name).toBe("workspace");
		expect(offered.inputSchema.anyOf).toBeUndefined();
		expect(offered.inputSchema.additionalProperties).toBeUndefined();
		expect(offered.inputSchema.type).toBe("object");
		expect(offered.inputSchema.required).toEqual(["operation"]);
		const operations: string[] = branches.map((branch) => branch.properties.operation.const);
		expect(offered.inputSchema.properties.operation).toEqual({ type: "string", enum: operations });
		// Every argument of every operation is still there.
		for (const branch of branches) {
			for (const name of Object.keys(branch.properties)) expect(offered.inputSchema.properties).toHaveProperty(name);
		}
		const accepts = (args: Record<string, unknown>) => agyAccepts(offered.inputSchema, { ...args, ...summary });
		expect(accepts({ operation: "tabs" })).toBe(true);
		expect(accepts({ operation: "status" })).toBe(true);
		expect(accepts({ operation: "open", url: "https://example.com", background: true })).toBe(true);
		expect(accepts({ operation: "scroll", tabId: "t1", deltaY: "page", until: "End" })).toBe(true);
		expect(accepts({ operation: "scroll", tabId: "t1", deltaY: 400 })).toBe(true);
		// What is plainly wrong is still refused before it reaches MyHarness.
		expect(accepts({ operation: "no-such-operation" })).toBe(false);
		expect(accepts({})).toBe(false);
		expect(accepts({ operation: "open", url: 5 })).toBe(false);
		// The tool's own schema is not touched.
		expect(branches[0].additionalProperties).toBe(false);
	});

	it("says in the description what each operation takes, since the single object no longer does", () => {
		const offered = toolForAgy(workspace);
		expect(offered.description.startsWith(workspace.description)).toBe(true);
		const [, table] = offered.description.split(
			"\n\nArguments by `operation` (* = required; any other argument is refused):\n",
		);
		const lines = table.split("\n");
		// One line per operation.
		expect(lines).toHaveLength(branches.length);
		expect(lines).toContain("- status: nothing else");
		expect(lines).toContain("- navigate: url*, tabId, onUserTab, timeoutMs, screenshot");
		expect(lines).toContain("- bookmark_note: bookmark*, note*");
		expect(lines.find((line) => line.startsWith("- wait: "))).toMatch(
			/^- wait: tabId, selector, text, label, gone, timeoutMs, screenshot \(Without selector/,
		);
	});

	it("keeps an argument's own words where operations describe it differently", () => {
		const { properties } = toolForAgy(workspace).inputSchema;
		// The same text everywhere stays as it is.
		expect(properties.onUserTab.description).toMatch(/^Act on the user's own tab/);
		// Different texts name the operations they are for.
		expect(properties.url.description).toContain("open: http(s) URL for type=browser");
		// Limits that differ between operations are left to MyHarness's own check; the kind of value stays.
		expect(properties.timeoutMs.type).toBe("integer");
		expect(properties.timeoutMs.minimum).toBeUndefined();
		// Different kinds of value are all allowed.
		expect(properties.deltaY.anyOf).toEqual([{ type: "number" }, { const: "page", type: "string" }]);
	});

	it("opens a closed schema that has no branches, and leaves an open one as it is", () => {
		const closed = {
			type: "object",
			properties: { planId: { type: "string" } },
			required: ["planId"],
			additionalProperties: false,
		};
		const offered = toolForAgy({ name: "apply_rename", description: "Apply", parameters: closed });
		expect(offered.description).toBe("Apply");
		expect(offered.inputSchema.additionalProperties).toBeUndefined();
		expect(agyAccepts(offered.inputSchema, { planId: "p1", ...summary })).toBe(true);
		expect(agyAccepts(closed, { planId: "p1", ...summary })).toBe(false);
		expect(closed.additionalProperties).toBe(false);
		const open = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
		expect(toolForAgy({ name: "memory_search", description: "Search", parameters: open })).toEqual({
			name: "memory_search",
			description: "Search",
			inputSchema: open,
		});
		expect(toolForAgy({ name: "bare" }).inputSchema).toEqual({ type: "object", properties: {} });
	});

	it("merges branches that no property tells apart, and opens branches it cannot merge", () => {
		const offered = toolForAgy({
			name: "pick",
			description: "Pick",
			parameters: {
				oneOf: [
					{
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
						additionalProperties: false,
					},
					{ type: "object", properties: { name: { type: "string" } }, required: ["name"] },
				],
			},
		});
		expect(offered.inputSchema).toEqual({
			type: "object",
			properties: { id: { type: "string" }, name: { type: "string" } },
		});
		expect(offered.description).toBe(
			"Pick\n\nThe argument sets this tool takes, one per call (* = required):\n- variant 1: id*\n- variant 2: name*",
		);
		const mixed = toolForAgy({
			name: "mixed",
			parameters: { anyOf: [{ type: "string" }, { type: "object", properties: {}, additionalProperties: false }] },
		});
		expect(mixed.inputSchema.anyOf).toEqual([{ type: "string" }, { type: "object", properties: {} }]);
	});

	it("takes agy's own argument out of a call before MyHarness checks it", () => {
		expect(argumentsForApp(workspace, { operation: "tabs", ...summary })).toEqual({ operation: "tabs" });
		expect(argumentsForApp(workspace, { operation: "tabs" })).toEqual({ operation: "tabs" });
		// A tool that really has an argument of that name keeps it.
		const own = { parameters: { type: "object", properties: { toolSummary: { type: "string" } } } };
		expect(argumentsForApp(own, { toolSummary: "x" })).toEqual({ toolSummary: "x" });
		const branch = { parameters: { anyOf: [{ type: "object", properties: { toolSummary: { type: "string" } } }] } };
		expect(argumentsForApp(branch, { toolSummary: "x" })).toEqual({ toolSummary: "x" });
		expect(argumentsForApp(undefined, "text")).toBe("text");
	});
});

describe("agy-shell program and sign-in", () => {
	it("starts only an agy that has the acp command", () => {
		expect(acpSupport("1.3.3")).toEqual({ version: "1.3.3", ok: false });
		expect(acpSupport("1.4.9\n")).toEqual({ version: "1.4.9", ok: false });
		expect(acpSupport("agy version 1.5.0")).toEqual({ version: "1.5.0", ok: true });
		expect(acpSupport("1.12.1")).toEqual({ version: "1.12.1", ok: true });
		expect(acpSupport("2.0")).toEqual({ version: "2.0", ok: true });
		// Whatever cannot be read is not started.
		expect(acpSupport("unknown")).toEqual({ version: undefined, ok: false });
	});

	it("gives agy a key only when one is saved for this provider", () => {
		const base = { PATH: "p", GEMINI_API_KEY: "stray", GOOGLE_API_KEY: "stray", ELECTRON_RUN_AS_NODE: "1" };
		const own = launchEnv(base, undefined);
		for (const name of STRIPPED_ENV) expect(own[name]).toBeUndefined();
		expect(own.PATH).toBe("p");
		expect(launchEnv(base, "saved").GEMINI_API_KEY).toBe("saved");
		expect(base.GEMINI_API_KEY).toBe("stray");
	});

	it("starts every agy with its background updater off, the way agy reads that switch", () => {
		// agy takes the switch for set only when it is exactly "true"; with "1" its updater ran and opened a window.
		expect(launchEnv({ PATH: "p" }, undefined)[NO_AUTO_UPDATE_ENV]).toBe("true");
		expect(launchEnv({ PATH: "p", [NO_AUTO_UPDATE_ENV]: "1" }, "saved")[NO_AUTO_UPDATE_ENV]).toBe("true");
	});

	it("runs `agy update` only on an agy whose help lists that command", () => {
		const help = [
			"usage: agy [flags] [prompt]",
			"  --update-channel string   Release channel",
			"",
			"subcommands:",
			"  acp             Start the Agent Client Protocol (ACP) stdio server",
			"  models          List available models",
			"  update          Update CLI",
		].join("\n");
		expect(listsUpdateCommand(help)).toBe(true);
		expect(listsUpdateCommand(help.replace(/^ {2}update .*$/m, "  updates         Show release notes"))).toBe(false);
		// A flag or a word of the usage line is no command.
		expect(listsUpdateCommand("usage: agy [flags]\n  update   something\n")).toBe(false);
		expect(listsUpdateCommand("")).toBe(false);
	});

	it("maps MyHarness's reasoning levels to agy's thinking levels", () => {
		const levels = ["Low", "Medium", "High", "Extra", "Max"].map((name) => ({ value: name.toLowerCase(), name }));
		expect(thoughtValue(levels, "low")).toBe("low");
		expect(thoughtValue(levels, "high")).toBe("high");
		expect(thoughtValue(levels, "xhigh")).toBe("extra");
		expect(thoughtValue(levels, "max")).toBe("max");
		expect(thoughtValue([{ value: "lvl-2", name: "Medium" }], "medium")).toBe("lvl-2");
		expect(thoughtValue(levels, "minimal")).toBeUndefined();
	});
});

describe("agy-shell models, plan limits and usage numbers", () => {
	// What `agy models` printed on 2026-11-14 (agy 1.5.8).
	const LISTED = [
		"gemini-4-argon-medium\tGemini 4 Argon (Medium)",
		"gemini-4-argon-high\tGemini 4 Argon (High)",
		"gemini-4-argon-low\tGemini 4 Argon (Low)",
		"gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
		"gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
		"gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
		"gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
		"gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)",
		"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
		"gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
		"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
		"claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
		"claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)",
		"claude-opus-5-5-high\tClaude Opus 5.5 (High)",
		"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
		"",
	].join("\n");
	// What `agy -p /usage` printed that day.
	const USAGE = [
		"Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-20T22:59:13Z",
		"Gemini Models\tFive Hour Limit Remaining\t92%\t2026-11-14T06:12:40Z",
		"Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-21T01:30:00Z",
		"Claude and GPT models\tFive Hour Limit Remaining\t71.6%\t2026-11-14T06:30:00Z",
		"Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t99%\t2026-11-20T22:59:13Z",
	].join("\r\n");
	const NOW = Date.parse("2026-11-14T02:00:00Z");

	it("reads agy's thinking levels by value or name, xhigh under its own names too", () => {
		expect(["low", "Medium", "HIGH", "max"].map(levelOf)).toEqual(["low", "medium", "high", "max"]);
		expect(["extra", "Extra", "XHigh", "extra-high", "Extra High"].map(levelOf)).toEqual(Array(5).fill("xhigh"));
		expect(["pro", "argon", "", "none"].map(levelOf)).toEqual(Array(4).fill(undefined));
	});

	it("turns the lines of `agy models` into the models a conversation offers, each with its thinking levels", () => {
		expect(parseModelList(LISTED)).toEqual([
			{ id: "gemini-4-argon", name: "Gemini 4 Argon", levels: ["low", "medium", "high"] },
			{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", levels: ["low", "medium", "high", "xhigh"] },
			// "(Argon)" is no thinking level: the model is listed as it is.
			{ id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)", levels: [] },
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "medium", "high"] },
			{ id: "claude-opus-5-5", name: "Claude Opus 5.5", levels: ["low", "medium", "high"] },
			// A model that comes with one level has no level to pick: its id keeps the level, the way agy names it.
			{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", levels: [] },
		]);
		// Whatever is no model line (a notice, an error) is left out.
		expect(parseModelList("Fetching available models...\nerror: not signed in\n")).toEqual([]);
	});

	it("reads what is left of the plan from agy's /usage", () => {
		const rows = parseQuota(USAGE);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toEqual({
			pool: "Gemini Models",
			window: "weekly",
			left: 98,
			resetsAt: Date.parse("2026-11-20T22:59:13Z"),
		});
		expect(rows[3]).toMatchObject({ pool: "Claude and GPT models", window: "five_hour", left: 71.6 });
		// An answer that is not this table (a model's reply to the text, an error) gives nothing to show.
		expect(parseQuota("I can't run /usage here.\nUsage: agy [options]")).toEqual([]);
	});

	it("shows a chat the pool its model draws on, and the model's own limit when it has one", () => {
		const rows = parseQuota(USAGE);
		expect(quotaText(rows, { id: "gemini-4-argon", name: "agy · Gemini 4 Argon" }, NOW)).toBe(
			"agy 额度剩余 5h 92% · 7d 98% · 本模型 7d 99%",
		);
		expect(quotaText(rows, { id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" }, NOW)).toBe(
			"agy 额度剩余 5h 92% · 7d 98%",
		);
		expect(quotaText(rows, { id: "claude-opus-5-5", name: "agy · Claude Opus 5.5" }, NOW)).toBe(
			"agy 额度剩余 5h 72% · 7d 100%",
		);
		expect(quotaText(rows, { id: "gpt-oss-120b-medium", name: "agy · GPT-OSS 120B (Medium)" }, NOW)).toBe(
			"agy 额度剩余 5h 72% · 7d 100%",
		);
		// A window known only from before it reset has no number.
		const later = Date.parse("2026-11-14T07:00:00Z");
		expect(quotaText(rows, { id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" }, later)).toBe(
			"agy 额度剩余 5h - · 7d 98%",
		);
		// A model of a family no pool is named after, and no reading at all: nothing is shown rather than a guess.
		expect(quotaText(rows, { id: "llama-9", name: "agy · Llama 9" }, NOW)).toBeUndefined();
		expect(quotaText([], { id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" }, NOW)).toBeUndefined();
	});

	it("gives MyHarness's display each pool with its windows, and the models that draw on it", () => {
		const models = [
			{ id: "gemini-4-argon", name: "agy · Gemini 4 Argon" },
			{ id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" },
			{ id: "claude-opus-5-5", name: "agy · Claude Opus 5.5" },
			{ id: "gpt-oss-120b-medium", name: "agy · GPT-OSS 120B (Medium)" },
			{ id: "llama-9", name: "agy · Llama 9" },
		];
		expect(poolsOf(["Gemini Models", "Gemini 4 Argon"], models[0])).toEqual({
			shared: "Gemini Models",
			own: "Gemini 4 Argon",
		});
		expect(poolsOf(["Gemini Models", "Gemini 4 Argon"], models[4])).toEqual({ shared: undefined, own: undefined });
		const groups = quotaGroups(parseQuota(USAGE), models, NOW);
		expect(groups.map((group) => [group.label, group.modelIds])).toEqual([
			["Gemini Models", ["gemini-4-argon", "gemini-3.8-flash"]],
			["Claude and GPT models", ["claude-opus-5-5", "gpt-oss-120b-medium"]],
			["Gemini 4 Argon", ["gemini-4-argon"]],
		]);
		// The 5-hour window first, whatever order agy lists them in; a limit of one model has the window it has.
		expect(groups[0].windows).toEqual([
			{ kind: "five_hour", leftPercent: 92, resetsAt: Date.parse("2026-11-14T06:12:40Z") },
			{ kind: "weekly", leftPercent: 98, resetsAt: Date.parse("2026-11-20T22:59:13Z") },
		]);
		expect(groups[2].windows.map((window) => window.kind)).toEqual(["weekly"]);
		// A window nothing was used of: agy names a reset one whole window after the question, which is no reset time.
		const asked = Date.parse("2026-11-14T08:52:22Z");
		const untouched = quotaGroups(
			parseQuota(
				[
					"Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-21T08:52:22Z",
					"Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-14T13:52:22Z",
					// Full, but counting: its reset is not a whole window away.
					"Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-14T10:00:00Z",
				].join("\n"),
			),
			models,
			asked + 3000,
		);
		expect(untouched[0].windows).toEqual([
			{ kind: "five_hour", leftPercent: 100, resetsAt: undefined },
			{ kind: "weekly", leftPercent: 100, resetsAt: undefined },
		]);
		expect(untouched[1].windows).toEqual([
			{ kind: "five_hour", leftPercent: 100, resetsAt: Date.parse("2026-11-14T10:00:00Z") },
		]);
	});

	it("finds the model requests in agy's record of a conversation", () => {
		const record = [
			JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "hi" }),
			JSON.stringify({ step_index: 2, input_tokens: 46802, cache_read_tokens: 0, output_tokens: 1380 }),
			JSON.stringify({ step_index: 3, type: "GENERIC", content: 'mentions "output_tokens" in a tool result' }),
			JSON.stringify({ step_index: 4, input_tokens: 14696, cache_read_tokens: 46803, output_tokens: 554 }),
			'{"step_index":5,"output_tokens":',
		].join("\n");
		expect(requestsIn(record)).toEqual([
			{ input: 46802, cacheRead: 0, output: 1380 },
			{ input: 14696, cacheRead: 46803, output: 554 },
		]);
	});

	it("reads a context length the way it is typed", () => {
		expect(parseTokens("300k")).toBe(300_000);
		expect(parseTokens(" 1M ")).toBe(1_000_000);
		expect(parseTokens("0.5m")).toBe(500_000);
		expect(parseTokens("200")).toBe(200_000);
		expect(parseTokens("262,144")).toBe(262_144);
		expect(parseTokens("many")).toBeUndefined();
		expect(parseTokens("0")).toBeUndefined();
	});
});

// The real path, with a stand-in for `agy acp` that has no model behind it: the provider starts it, speaks ACP to it
// over stdin/stdout, and it calls MyHarness's MCP endpoint. Each prompt says what the stand-in does in that turn.
describe("agy-shell with a stand-in agy", () => {
	const saved: Record<string, string | undefined> = {};
	const setEnv = (name: string, value: string | undefined) => {
		if (!(name in saved)) saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	let dir = "";
	let project = "";
	let log = "";
	let sessions: any[] = [];
	let chatNumber = 0;
	let held: Partial<typeof internals.shared> = {};
	const STATE = [
		"models",
		"discovery",
		"quota",
		"quotaQuery",
		"quotaAskedAt",
		"quotaFailedAt",
		"quotaError",
		"planUsageChanged",
		"quotaUnsupported",
		"quotaTimer",
		"usingKey",
		"appendsPrompt",
		"updateCheckedAt",
		"updating",
	] as const;
	const CODING_TOOLS = ["read", "write", "edit", "bash"].map((name) => ({ name, description: name, parameters: {} }));
	/** An agy from before it took a prompt from its client: it can resume a conversation, and that is all. */
	const NO_SYSTEM_PROMPT = { sessionCapabilities: { resume: {} }, _meta: {} };
	const WEB_SEARCH = {
		name: "web_search",
		description: "Search the web.",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	};
	const model = () => ({
		id: "default",
		api: "agy-acp",
		provider: "agy",
		contextWindow: 1_000_000,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	});

	beforeEach(() => {
		dir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "agy-shell-"));
		project = join(dir, "project");
		log = join(dir, "acp.log");
		setEnv("MYHARNESS_AGY_BIN", MOCK);
		setEnv("MYHARNESS_CODING_AGENT_DIR", join(dir, "agent"));
		setEnv("MOCK_ACP_LOG", log);
		setEnv("MOCK_ACP_STATE", join(dir, "state.json"));
		setEnv("MOCK_ACP_CAPS", undefined);
		setEnv("MOCK_ACP_NEEDS_AUTH", undefined);
		setEnv("MOCK_ACP_HANG", undefined);
		setEnv("GEMINI_API_KEY", undefined);
		// agy's record of a conversation is looked for under the home folder: never the real one.
		setEnv("USERPROFILE", join(dir, "home"));
		setEnv("HOME", join(dir, "home"));
		for (const name of ["LEVELS", "COMMANDS", "COMPACT_TO", "STRICT_TOOLS"]) setEnv(`MOCK_ACP_${name}`, undefined);
		setEnv("MOCK_AGY_MODELS", undefined);
		setEnv("MOCK_AGY_USAGE", undefined);
		setEnv("MOCK_AGY_HELP", undefined);
		sessions = [];
		held = { ...internals.shared };
		// A new version of agy was looked for a moment ago, so no test starts `agy update` unless it is about that.
		internals.shared.updateCheckedAt = Date.now();
		internals.shared.updating = undefined;
		internals.shared.updateCommands.clear();
		// What an earlier test's requests carried says nothing about this one's.
		internals.shared.appendsPrompt = undefined;
		internals.shared.turnPrompts.clear();
		internals.shared.promptLimits.clear();
	});
	afterEach(async () => {
		for (const session of sessions) {
			session.close();
			internals.shared.sessions.delete(session.sessionId);
			internals.shared.contexts.delete(session.sessionId);
		}
		// What a test set of the process-wide state (the models offered, the plan's limits) goes with it.
		if (internals.shared.quotaTimer) clearTimeout(internals.shared.quotaTimer);
		for (const name of STATE) (internals.shared as any)[name] = (held as any)[name];
		// The stand-ins end when their input closes; their files are free after that.
		await new Promise((resolve) => setTimeout(resolve, 150));
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	type Chat = {
		session: any;
		messages: any[];
		asked: string[];
		/** Sends a message and plays MyHarness's part until the task ends: runs each round's cards, then asks to go on. */
		send: (text: string, options?: any) => Promise<any>;
		rounds: any[][];
	};
	function openChat(
		tools: any[] = CODING_TOOLS,
		settings: { systemPrompt?: string; choose?: string; model?: any; runApp?: (call: any) => string } = {},
	): Chat {
		const sessionId = `chat-${++chatNumber}-${Date.now()}`;
		const session: any = new internals.AcpSession(sessionId);
		const asked: string[] = [];
		const cwd = mkdtempSync(join(dir, "project-"));
		project = cwd;
		internals.shared.sessions.set(sessionId, session);
		internals.shared.contexts.set(sessionId, {
			cwd,
			hasUI: true,
			ui: {
				notify() {},
				select: async (title: string) => {
					asked.push(title);
					return settings.choose;
				},
			},
		});
		sessions.push(session);
		const messages: any[] = [];
		const rounds: any[][] = [];
		const chatModel = settings.model ?? model();
		// The card tool is active in every chat that runs on this provider.
		const context = () => ({
			messages,
			tools: [...tools, { name: "agy_tool", description: "", parameters: {} }],
			systemPrompt: settings.systemPrompt ?? "BASE PROMPT",
		});
		const send = async (text: string, options: any = {}) => {
			messages.push({ role: "user", content: text, timestamp: Date.now() + messages.length });
			let said = "";
			const textIn = (message: any) =>
				(message?.content ?? [])
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("");
			for (;;) {
				const events: any[] = [];
				await internals.runTurn(
					{ push: (event: any) => events.push(event), end() {} },
					session,
					chatModel,
					context(),
					options,
				);
				const final = events[events.length - 1];
				said += textIn(final.message ?? final.error);
				if (final.type === "done") messages.push(final.message);
				// Everything the task wrote, across its tool rounds.
				if (final.type !== "done" || final.reason !== "toolUse") return { ...final, text: said };
				const calls = final.message.content.filter((part: any) => part.type === "toolCall");
				rounds.push(calls);
				for (const call of calls) {
					let content: any[];
					let isError = false;
					if (call.name === "agy_tool") {
						const finished = await session.ownCall(call.id).done.promise;
						content = ownResult(finished, cwd);
						isError = finished.failed;
					} else {
						content = [{ type: "text", text: settings.runApp ? settings.runApp(call) : `ran ${call.name}` }];
						// What the extension does when MyHarness reports the end of a tool.
						session.deliverAppResult({ toolCallId: call.id, content, isError });
					}
					messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError });
				}
			}
		};
		return { session, messages, asked, send, rounds };
	}
	const textOf = (final: any): string => final.text;
	const savedModels = () => JSON.parse(readFileSync(join(dir, "agent", "agy-shell", "models.json"), "utf8"));
	const requests = () =>
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

	it("starts agy acp, reads its thinking and its answer, and learns the account's models", async () => {
		const chat = openChat();
		const final = await chat.send("think hmm ;; say Hello ;; say  there");
		expect(final.type).toBe("done");
		expect(final.message.stopReason).toBe("stop");
		expect(final.message.content).toEqual([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "Hello there" },
		]);
		const seen = requests();
		expect(seen[0]).toEqual({
			start: [
				"acp",
				"--process-per-session",
				"--include-default-customizations=false",
				"--agent",
				"myharness-host-v2",
			],
		});
		expect(
			readFileSync(join(dir, "home", ".gemini", "config", "agents", "myharness-host-v2", "agent.md"), "utf8"),
		).toContain("excludeDefaultComponents: true");
		expect(seen.map((entry) => entry.method).filter(Boolean)).toEqual([
			"initialize",
			"session/new",
			"session/prompt",
		]);
		// File and shell tools now use the same MyHarness MCP path as every other tool.
		expect(seen[2].mcp).toEqual([MCP_SERVER]);
		// The models of the account, and the thinking levels of the one the conversation is on.
		expect(savedModels()).toEqual([
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "medium", "high", "xhigh", "max"] },
			{ id: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
		]);
	});

	it("keeps zero-tool chats on the managed host", async () => {
		const chat = openChat([]);
		expect(textOf(await chat.send("echo"))).toContain(HOST_TURN_REMINDER);
		expect(starts()[0].start).toContain("myharness-host-v2");
	});

	it("uses the managed host for temporary title and summary requests too", async () => {
		const session = new internals.AcpSession("temporary-host-test", true);
		sessions.push(session);
		await session.start(model(), undefined, "TITLE RULES");
		expect(starts()[0].start).toContain("myharness-host-v2");
		expect(requests().find((entry) => entry.method === "session/new").systemPrompt).toBe("append");
	});

	it("rejects an edited managed definition without overwriting it", async () => {
		const chat = openChat();
		await chat.send("say ready");
		chat.session.close();
		const file = join(dir, "home", ".gemini", "config", "agents", "myharness-host-v2", "agent.md");
		writeFileSync(file, "foreign definition");
		await expect(chat.send("say unsafe")).rejects.toThrow("定义被修改");
		expect(readFileSync(file, "utf8")).toBe("foreign definition");
	});

	it("reports and refuses an unexpected native file write", async () => {
		const chat = openChat();
		const final = await chat.send("say Writing. ;; write notes.txt hello ;; say done");
		expect(final.message.stopReason).toBe("stop");
		expect(textOf(final)).toBe("Writing.could not write notes.txt. done");
		expect(existsSync(join(project, "notes.txt"))).toBe(false);
		expect(chat.rounds.flat().map((card) => card.name)).toEqual(["agy_tool"]);
		expect(chat.messages.find((message) => message.role === "toolResult").isError).toBe(true);
		expect(chat.asked).toEqual([]);
	});

	it("refuses what agy asks to do with a tool that is switched off in the chat", async () => {
		const chat = openChat([{ name: "read", description: "read", parameters: {} }]);
		const final = await chat.send("write blocked.txt x ;; run npm test");
		expect(textOf(final)).toBe("could not write blocked.txt. refused npm test. ");
		expect(existsSync(join(project, "blocked.txt"))).toBe(false);
		const results = chat.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => result.isError)).toEqual([true, true]);
		expect(chat.asked).toEqual([]);
	});

	it("rejects unexpected native actions even when the matching MyHarness tool is enabled", async () => {
		const chat = openChat([...CODING_TOOLS, WEB_SEARCH], { choose: "允许这一次" });
		expect(textOf(await chat.send("other deploy ;; run npm test ;; run echo myharness_app ;; run web_search"))).toBe(
			"refused deploy. refused npm test. refused echo myharness_app. refused web_search. ",
		);
		expect(chat.asked).toEqual([]);
	});

	it("runs a MyHarness tool agy calls over MCP as the chat's own tool call, with no second card", async () => {
		const chat = openChat([...CODING_TOOLS, WEB_SEARCH], { runApp: (call) => `found ${call.arguments.query}` });
		const final = await chat.send('tools ;; app web_search {"query":"acp"} ;; say .');
		expect(textOf(final)).toBe("TOOLS:read,write,edit,bash,web_search" + "RESULT:found acp.");
		const cards = chat.rounds.flat();
		expect(cards.map((card) => card.name)).toEqual(["web_search"]);
		expect(cards[0].arguments).toEqual({ query: "acp" });
		expect(chat.asked).toEqual([]);
		// The MCP server is named when the conversation is opened.
		expect(requests().find((entry) => entry.method === "session/new").mcp).toEqual([MCP_SERVER]);
	});

	it("ends the card of a call that turns out to be a MyHarness tool instead of waiting on it", async () => {
		const chat = openChat([...CODING_TOOLS, WEB_SEARCH], { runApp: () => "found" });
		const final = await chat.send('appquiet web_search {"query":"quiet"}');
		expect(textOf(final)).toBe("RESULT:found");
		const cards = chat.rounds.flat();
		expect(cards.map((card) => card.name).sort()).toEqual(["agy_tool", "web_search"]);
		const note = chat.messages.find((message) => message.role === "toolResult" && message.toolName === "agy_tool");
		expect(note.content[0].text).toContain("MyHarness");
	});

	it("gives agy MyHarness's prompt as an appended system prompt when it takes one", async () => {
		const chat = openChat(CODING_TOOLS, { systemPrompt: "BASE PROMPT of the chat" });
		const text = textOf(await chat.send("system"));
		expect(text).toMatch(/^SYSTEM:# MyHarness/);
		expect(text).toContain("BASE PROMPT of the chat");
		expect(requests().find((entry) => entry.method === "session/new").systemPrompt).toBe("append");
	});

	it("gives the prompt again whenever the conversation is opened: agy does not keep it with the conversation", async () => {
		const settings = { systemPrompt: "FIRST PROMPT" };
		const chat = openChat(CODING_TOOLS, settings);
		expect(textOf(await chat.send("system"))).toContain("FIRST PROMPT");
		// agy ended (unused for a while, or MyHarness was restarted): the resumed conversation gets the prompt again.
		chat.session.close();
		expect(textOf(await chat.send("system"))).toContain("FIRST PROMPT");
		// A prompt that changed opens the conversation again between two turns, with the new one alone.
		settings.systemPrompt = "SECOND PROMPT";
		const changed = textOf(await chat.send("system"));
		expect(changed).toContain("SECOND PROMPT");
		expect(changed).not.toContain("FIRST PROMPT");
		// The same prompt again: agy goes on running.
		expect(textOf(await chat.send("system"))).toContain("SECOND PROMPT");
		const opened = requests().filter(
			(entry) => entry.method?.startsWith("session/") && entry.method !== "session/prompt",
		);
		expect(opened.map((entry) => [entry.method, entry.systemPrompt])).toEqual([
			["session/new", "append"],
			["session/resume", "append"],
			["session/resume", "append"],
		]);
		// The complete prompt stays in system; only the short reminder travels with a message.
		expect(textOf(await chat.send("echo"))).toBe(`PROMPT:echo\n${HOST_TURN_REMINDER}`);
	});

	it("refuses a resumed runtime that loses system instruction support", async () => {
		const chat = openChat();
		await chat.send("say Hello");
		chat.session.close();
		setEnv("MOCK_ACP_CAPS", JSON.stringify(NO_SYSTEM_PROMPT));
		await expect(chat.send("say unsafe")).rejects.toThrow("不支持 MyHarness 系统指令或工具接管");
	});

	it("refuses missing system support instead of silently lowering instructions into a user message", async () => {
		setEnv("MOCK_ACP_CAPS", JSON.stringify(NO_SYSTEM_PROMPT));
		const chat = openChat();
		await expect(chat.send("say unsafe")).rejects.toThrow("不支持 MyHarness 系统指令或工具接管");
		expect(requests().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	const WITH_CARD = [...CODING_TOOLS, { name: "agy_tool", description: "", parameters: {} }];
	const sessionMethods = () =>
		requests()
			.map((entry) => entry.method)
			.filter((method) => method?.startsWith("session/"));
	const starts = () => requests().filter((entry) => entry.start);

	it("opens a conversation ahead with the prompt the request will carry, once a message has shown which that is", async () => {
		// MyHarness's prompt when a message is sent ("EARLY PROMPT") is not yet what the request carries ("BASE PROMPT").
		const chat = openChat();
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		// Not known yet: nothing is started ahead, and the request opens the conversation.
		expect(chat.session.warming).toBeUndefined();
		expect(chat.session.running).toBe(false);
		expect(textOf(await chat.send("system"))).toContain("BASE PROMPT");
		expect(sessionMethods()).toEqual(["session/new", "session/prompt"]);
		// agy has ended (unused for a while). The next message starts it ahead, with the prompt the last request had.
		chat.session.close();
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		// Asked twice (two events for one message): one start.
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		await chat.session.warming;
		expect(chat.session.running).toBe(true);
		expect(chat.session.warming).toBeUndefined();
		const text = textOf(await chat.send("system"));
		expect(text).toContain("BASE PROMPT");
		expect(text).not.toContain("EARLY PROMPT");
		// The request went on in the conversation opened ahead: agy was not started a third time.
		expect(starts()).toHaveLength(2);
		expect(sessionMethods()).toEqual(["session/new", "session/prompt", "session/resume", "session/prompt"]);
		// While agy runs there is nothing to start ahead.
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		expect(chat.session.warming).toBeUndefined();
		// Another chat whose message is sent with the same prompt is opened ahead at its first message.
		const other = openChat();
		other.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		await other.session.warming;
		expect(other.session.running).toBe(true);
		expect(textOf(await other.send("system"))).toContain("BASE PROMPT");
		expect(starts()).toHaveLength(3);
	});

	it("does not leave an unsupported prewarmed runtime running", async () => {
		setEnv("MOCK_ACP_CAPS", JSON.stringify(NO_SYSTEM_PROMPT));
		internals.shared.appendsPrompt = false;
		const chat = openChat();
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		await chat.session.warming;
		expect(chat.session.running).toBe(false);
		await expect(chat.send("say unsafe")).rejects.toThrow("不支持 MyHarness 系统指令或工具接管");
	});

	it("starts agy for a chat on it as soon as a message is sent, before the model is asked", async () => {
		const handlers = new Map<string, (event: any, ctx: any) => any>();
		const pi: any = {
			registerProvider() {},
			registerTool() {},
			registerCommand() {},
			on: (name: string, handler: any) => handlers.set(name, handler),
			getActiveTools: () => WITH_CARD.map((tool) => tool.name),
			setActiveTools() {},
			getAllTools: () => [...WITH_CARD, WEB_SEARCH],
			getThinkingLevel: () => "off",
		};
		agyShell(pi);
		const sent = (chat: Chat, chatModel: any) =>
			handlers.get("before_agent_start")!(
				{ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE PROMPT" },
				{
					...internals.shared.contexts.get(chat.session.sessionId),
					model: chatModel,
					sessionManager: { getSessionId: () => chat.session.sessionId },
				},
			);
		const acpStarts = () => starts().filter((entry) => entry.start[0] === "acp");
		const chat = openChat();
		// The message itself is not touched, and nothing is added to the chat. The first message sent with a prompt
		// shows what the request carries; from the next one on agy is started as soon as the message is sent.
		expect(await sent(chat, model())).toBeUndefined();
		expect(chat.session.warming).toBeUndefined();
		expect(textOf(await chat.send("say Hello"))).toBe("Hello");
		chat.session.close();
		expect(await sent(chat, model())).toBeUndefined();
		await chat.session.warming;
		expect(chat.session.running).toBe(true);
		expect(textOf(await chat.send("say Hello"))).toBe("Hello");
		expect(acpStarts()).toHaveLength(2);
		expect(sessionMethods()).toEqual(["session/new", "session/prompt", "session/resume", "session/prompt"]);
		// A chat on another model starts nothing, nor does one whose agy runs on a saved key (the request brings the key).
		const elsewhere = openChat();
		await sent(elsewhere, { provider: "openai", id: "gpt" });
		expect(elsewhere.session.warming).toBeUndefined();
		internals.shared.usingKey = true;
		await sent(elsewhere, model());
		expect(elsewhere.session.warming).toBeUndefined();
		expect(acpStarts()).toHaveLength(2);
	});

	it("waits for a start that is still under way instead of starting agy a second time", async () => {
		const chat = openChat();
		internals.knowTurnPrompt("BASE PROMPT", "BASE PROMPT");
		chat.session.warm(model(), undefined, "BASE PROMPT", WITH_CARD);
		expect(chat.session.warming).toBeDefined();
		expect(textOf(await chat.send("say Hello"))).toBe("Hello");
		expect(starts()).toHaveLength(1);
		expect(sessionMethods()).toEqual(["session/new", "session/prompt"]);
	});

	it("starts agy again when a system prompt it was opened with is not the request's", async () => {
		const chat = openChat();
		// What the last request carried is no longer what this one does (a setting was changed in between).
		internals.knowTurnPrompt("EARLY PROMPT", "ANOTHER PROMPT");
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		await chat.session.warming;
		expect(chat.session.running).toBe(true);
		const text = textOf(await chat.send("system"));
		expect(text).toContain("BASE PROMPT");
		expect(text).not.toContain("ANOTHER PROMPT");
		// The conversation opened ahead is the one that goes on: no second one is left in agy's history.
		expect(sessionMethods()).toEqual(["session/new", "session/resume", "session/prompt"]);
		// And the next conversation is opened ahead with the prompt this request had.
		chat.session.close();
		chat.session.warm(model(), undefined, "EARLY PROMPT", WITH_CARD);
		await chat.session.warming;
		expect(textOf(await chat.send("system"))).toContain("BASE PROMPT");
		expect(starts()).toHaveLength(3);
	});

	it("leaves the request to report what went wrong with a start made ahead", async () => {
		setEnv("MOCK_ACP_NEEDS_AUTH", "1");
		const chat = openChat();
		internals.knowTurnPrompt("BASE PROMPT", "BASE PROMPT");
		chat.session.warm(model(), undefined, "BASE PROMPT", WITH_CARD);
		expect(chat.session.warming).toBeDefined();
		await chat.session.warming;
		expect(chat.session.running).toBe(false);
		await expect(chat.send("say Hello")).rejects.toThrow(/agy 还没有登录/);
		// A chat on a saved key starts agy with it, whatever was started ahead on agy's own login.
		const withKey = openChat();
		withKey.session.warm(model(), undefined, "BASE PROMPT", WITH_CARD);
		expect(withKey.session.warming).toBeDefined();
		expect(textOf(await withKey.send("env", { apiKey: "saved-key" }))).toBe("KEY:yes AUTH:yes");
	});

	it("refuses missing HTTP MCP support instead of using native tools", async () => {
		setEnv("MOCK_ACP_CAPS", JSON.stringify({ mcpCapabilities: {} }));
		const chat = openChat();
		await expect(chat.send("say unsafe")).rejects.toThrow("不支持 MyHarness 系统指令或工具接管");
		expect(requests().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("retains host reminders on every user turn, also after reopening", async () => {
		const chat = openChat();
		expect(textOf(await chat.send("echo"))).toBe(`PROMPT:echo\n${HOST_TURN_REMINDER}`);
		chat.session.close();
		expect(textOf(await chat.send("echo"))).toBe(`PROMPT:echo\n${HOST_TURN_REMINDER}`);
	});

	it("looks for a new agy itself, hidden, in place of agy's own background updater", async () => {
		setEnv(
			"MOCK_AGY_HELP",
			"usage: agy [flags]\n\nsubcommands:\n  models   List available models\n  update   Update CLI\n",
		);
		setEnv("MOCK_AGY_MODELS", "gemini-3.8-flash\tGemini 3.8 Flash\n");
		internals.shared.updateCheckedAt = undefined;
		await internals.keepUpdated();
		expect(requests()).toEqual([
			{ start: ["--help"], noAutoUpdate: "true" },
			{ start: ["update"], noAutoUpdate: "true" },
		]);
		// Looked for a moment ago: not again, whoever asks.
		await internals.keepUpdated();
		await internals.discoverModels();
		expect(requests().map((entry) => entry.start?.[0])).toEqual(["--help", "update", "models"]);
		// A quarter of an hour later it is looked for again, and the program is not asked for its commands twice.
		internals.shared.updateCheckedAt = Date.now() - 16 * 60_000;
		await internals.keepUpdated();
		expect(requests().map((entry) => entry.start?.[0])).toEqual(["--help", "update", "models", "update"]);
	});

	it("never says `update` to an agy that lists no such command: it would be taken for a prompt", async () => {
		setEnv("MOCK_AGY_HELP", "usage: agy [flags]\n\nsubcommands:\n  models   List available models\n");
		internals.shared.updateCheckedAt = undefined;
		await internals.keepUpdated();
		internals.shared.updateCheckedAt = undefined;
		await internals.keepUpdated();
		expect(requests()).toEqual([{ start: ["--help"], noAutoUpdate: "true" }]);
	});

	it("resumes the chat's conversation in a new agy, or hands a new one the chat as text", async () => {
		const chat = openChat();
		await chat.send("say first answer");
		chat.session.close();
		expect(textOf(await chat.send("echo"))).toBe(`PROMPT:echo\n${HOST_TURN_REMINDER}`);
		const methods = requests()
			.map((entry) => entry.method)
			.filter(Boolean);
		expect(methods.filter((method) => method.startsWith("session/"))).toEqual([
			"session/new",
			"session/prompt",
			"session/resume",
			"session/prompt",
		]);
		// An agy that cannot resume starts a new conversation, which gets what was said before.
		chat.session.close();
		setEnv("MOCK_ACP_CAPS", JSON.stringify({ sessionCapabilities: {} }));
		const text = textOf(await chat.send("echo"));
		expect(text).toContain("<earlier-conversation>");
		expect(text).toContain("assistant: first answer");
		expect(text.trim().endsWith(HOST_TURN_REMINDER)).toBe(true);
	});

	it("stops agy's turn on Stop and goes on with the next message", async () => {
		const chat = openChat();
		const controller = new AbortController();
		const stopped = chat.send("say started ;; wait", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();
		const final = await stopped;
		expect(final.type).toBe("error");
		expect(final.reason).toBe("aborted");
		expect(textOf(await chat.send("say again"))).toBe("again");
		expect(requests().some((entry) => entry.method === "session/cancel")).toBe(true);
		// The same agy went on: no second start.
		expect(requests().filter((entry) => entry.start).length).toBe(1);
	});

	it("ends the card of a call agy left unfinished when its turn ended, and reads the rest of the turn", async () => {
		const chat = openChat();
		// The card used to wait for a result that never came, and the whole chat with it.
		const final = await chat.send("leave dev-server ;; say Started it.");
		expect(final.type).toBe("done");
		expect(textOf(final)).toBe("Started it.");
		const cards = chat.rounds.flat();
		expect(cards.map((card) => [card.name, card.arguments.summary])).toEqual([["agy_tool", "Run dev-server"]]);
		const result = chat.messages.find((message) => message.role === "toolResult");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("没有报告这个工具的结果");
		// The chat goes on in the same agy.
		expect(textOf(await chat.send("say next"))).toBe("next");
		expect(requests().filter((entry) => entry.start).length).toBe(1);
	});

	it("stops on Stop while agy hangs opening the conversation, and starts it again for the next message", async () => {
		setEnv("MOCK_ACP_HANG", "session/new");
		const chat = openChat();
		const controller = new AbortController();
		const stopped = chat.send("say never", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(requests().some((entry) => entry.method === "session/new")).toBe(true);
		controller.abort();
		const final = await stopped;
		expect(final).toMatchObject({ type: "error", reason: "aborted" });
		expect(chat.session.running).toBe(false);
		setEnv("MOCK_ACP_HANG", undefined);
		expect(textOf(await chat.send("say again"))).toBe("again");
		expect(requests().filter((entry) => entry.start).length).toBe(2);
	});

	it("leaves one listener on the Stop signal however much agy writes", async () => {
		const chat = openChat();
		const controller = new AbortController();
		let most = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		let held = 0;
		controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
			most = Math.max(most, ++held);
			return add(...args);
		}) as typeof add;
		controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
			held--;
			return remove(...args);
		}) as typeof remove;
		const steps = Array.from({ length: 40 }, (_, index) => `say ${index}`).join(" ;; ");
		const final = await chat.send(steps, { signal: controller.signal });
		expect(final.type).toBe("done");
		// The provider's own two (Stop interrupts agy; Stop ends the wait), not one more for every piece read.
		expect(most).toBeLessThanOrEqual(2);
		expect(held).toBe(0);
	});

	it("passes the chat's model and reasoning level on as agy's own session options", async () => {
		const chat = openChat(CODING_TOOLS, { model: { ...model(), id: "gemini-3.8-pro" } });
		expect(textOf(await chat.send("model", { reasoning: "xhigh" }))).toBe("MODEL:gemini-3.8-pro LEVEL:extra");
		// The default model is whatever agy itself is set to.
		const plain = openChat();
		expect(textOf(await plain.send("model"))).toBe("MODEL:gemini-3.8-flash LEVEL:medium");
		const unknown = openChat(CODING_TOOLS, { model: { ...model(), id: "gone-model" } });
		await expect(unknown.send("model")).rejects.toThrow(/没有模型 gone-model/);
	});

	it("isolates a title request with the main session id while its turn is still running", async () => {
		const chat = openChat();
		await chat.send("say ready");
		const id = chat.session.acpSessionId;
		const controller = new AbortController();
		const running = chat.send("wait", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const side = internals.streamSimple(
			model(),
			{
				systemPrompt: "TITLE ONLY",
				messages: [{ role: "user", content: "\nsay title", timestamp: Date.now() }],
			},
			{ sessionId: chat.session.sessionId },
		);
		const result = await side.result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "title" }]);
		expect(chat.session.acpSessionId).toBe(id);
		expect(chat.session.turnActive).toBe(true);
		controller.abort();
		await running;
	});

	it("retains old history in long side requests and ignores native tool cards there", async () => {
		const result = await internals
			.streamSimple(
				model(),
				{
					messages: [
						{ role: "user", content: `EARLY CHECKPOINT ${"x".repeat(410_000)}`, timestamp: 1 },
						{ role: "user", content: "\nrun unsafe ;; echo", timestamp: 2 },
					],
				},
				{},
			)
			.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.some((part: any) => part.type === "toolCall")).toBe(false);
		expect(result.content.map((part: any) => part.text).join("")).toContain("EARLY CHECKPOINT");
	});

	it("uses portable compaction and rebuilds history after compaction or switching away", async () => {
		const handlers = new Map<string, any>();
		const sent: any[] = [];
		agyShell({
			registerProvider() {},
			registerTool() {},
			registerCommand() {},
			on: (name: string, handler: any) => handlers.set(name, handler),
			getActiveTools: () => [],
			setActiveTools() {},
			sendMessage: (...args: any[]) => sent.push(args),
		} as any);
		const chat = openChat();
		await chat.send("say original");
		const ctx = { model: model(), sessionManager: { getSessionId: () => chat.session.sessionId } };
		expect(
			await handlers.get("session_before_compact")({ reason: "manual", customInstructions: "retain goal" }, ctx),
		).toBeUndefined();
		expect(internals.shared.compacting.has(chat.session.sessionId)).toBe(true);
		await handlers.get("session_compact")({}, ctx);
		expect(internals.shared.sessions.has(chat.session.sessionId)).toBe(false);
		expect(chat.session.running).toBe(false);
		const rebuilt = new internals.AcpSession(chat.session.sessionId);
		sessions.push(rebuilt);
		internals.shared.sessions.set(chat.session.sessionId, rebuilt);
		await rebuilt.start(model(), undefined, "BASE PROMPT");
		expect(rebuilt.needsHistory).toBe(true);
		await handlers.get("model_select")({ previousModel: model(), model: { provider: "other" } }, ctx);
		expect(rebuilt.running).toBe(false);
		expect(internals.shared.sessions.has(chat.session.sessionId)).toBe(false);
		await handlers.get("turn_end")({
			message: { role: "assistant", provider: "agy", stopReason: "length", content: [] },
		});
		expect(sent[0][1]).toEqual({ deliverAs: "followUp" });
	});

	it("keeps history pending across a prewarm or failed first prompt", async () => {
		const chat = openChat();
		chat.messages.push({ role: "assistant", content: [{ type: "text", text: "OLD CONTEXT" }], timestamp: 1 });
		await chat.send("stop refusal");
		expect(chat.session.needsHistory).toBe(true);
		chat.session.close();
		expect(textOf(await chat.send("echo"))).toContain("OLD CONTEXT");
		expect(chat.session.needsHistory).toBe(false);
	});

	it("times out idle turns, pauses for host tools, and never arms for silent compaction", async () => {
		const chat = openChat();
		await chat.send("say ready");
		const session = chat.session;
		vi.useFakeTimers();
		try {
			session.turnActive = true;
			session.turnOpen = true;
			session.touchActivity();
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(session.turnOpen).toBe(false);
			expect((await session.next()).message).toContain("10 分钟");
			session.settleDraining();
			session.turnOpen = true;
			session.appCalls.set("host", { result: undefined, waiters: [] });
			session.touchActivity();
			expect(session.activityTimer).toBeUndefined();
			session.appCalls.clear();
			session.silent = true;
			session.touchActivity();
			expect(session.activityTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
			session.close();
		}
	});

	it("restarts agy after rotating a saved API key", async () => {
		const chat = openChat();
		await chat.send("env", { apiKey: "first-test-key" });
		await chat.send("env", { apiKey: "second-test-key" });
		expect(starts()).toHaveLength(2);
		expect(sessionMethods()).toContain("session/resume");
	});

	it("resolves a fixed-level CLI model against separate ACP model and thinking options", async () => {
		const chat = openChat(CODING_TOOLS, { model: { ...model(), id: "gemini-3.8-pro-high" } });
		expect(textOf(await chat.send("model"))).toBe("MODEL:gemini-3.8-pro LEVEL:high");
	});

	it("reports request limits and unknown stop reasons instead of claiming completion", async () => {
		const chat = openChat();
		for (const stop of ["max_turn_requests", "future_reason"]) {
			const final = await chat.send(`say partial ;; stop ${stop}`);
			expect(final.type).toBe("error");
			expect(final.error.content).toEqual([{ type: "text", text: "partial" }]);
		}
		expect((await chat.send("say clipped ;; stop max_tokens")).reason).toBe("length");
	});

	it("accounts failed-turn usage in that turn, never the following request", async () => {
		const chat = openChat();
		const failed = await chat.send("tokens 100 200 30 ;; stop refusal");
		expect(failed.error.usage).toMatchObject({ input: 100, cacheRead: 200, output: 30 });
		const next = await chat.send("tokens 10 20 3 ;; say next");
		expect(next.message.usage).toMatchObject({ input: 10, cacheRead: 20, output: 3 });
	});

	it("fails explicitly when an image cannot be sent", async () => {
		setEnv("MOCK_ACP_CAPS", JSON.stringify({ promptCapabilities: { image: false } }));
		const chat = openChat();
		chat.messages.push({
			role: "user",
			content: [{ type: "image", data: "dGVzdA==", mimeType: "image/png" }],
			timestamp: 1,
		});
		await expect(chat.send("say inspect")).rejects.toThrow("不支持图片");
		expect(requests().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("uses agy's own sign-in unless a key is saved, and says how to sign in when nobody is", async () => {
		setEnv("MOCK_ACP_NEEDS_AUTH", "1");
		// A key lying in the environment is not handed to agy.
		setEnv("GEMINI_API_KEY", "stray-key");
		const chat = openChat();
		await expect(chat.send("env")).rejects.toThrow(/agy 还没有登录/);
		const withKey = openChat();
		expect(textOf(await withKey.send("env", { apiKey: "saved-key" }))).toBe("KEY:yes AUTH:yes");
		setEnv("MOCK_ACP_NEEDS_AUTH", undefined);
		const ownLogin = openChat();
		expect(textOf(await ownLogin.send("env", { apiKey: "agy-own-login" }))).toBe("KEY:no AUTH:no");
	});

	it("reports how full agy says its context is", async () => {
		const chatModel = model();
		const chat = openChat(CODING_TOOLS, { model: chatModel });
		const final = await chat.send("usage 1234 200000 ;; say x");
		expect(final.message.usage.totalTokens).toBe(1234);
		expect(chatModel.contextWindow).toBe(200000);
		// No record of the conversation where agy keeps it: nothing is made up for the cache hit rate or the speed.
		expect(final.message.usage.reported).toBeUndefined();
	});

	it("offers each model the thinking levels agy has for it, none for a model without the option, and no default model", async () => {
		setEnv(
			"MOCK_ACP_LEVELS",
			JSON.stringify({ "gemini-3.8-flash": ["Low", "Medium", "High", "Extra"], "gemini-3.8-pro": [] }),
		);
		internals.shared.models = [];
		const chat = openChat(CODING_TOOLS, { model: { ...model(), id: "gemini-3.8-pro" } });
		// The level asked for means nothing to this model: agy is not asked to set one.
		expect(textOf(await chat.send("model", { reasoning: "high" }))).toBe("MODEL:gemini-3.8-pro LEVEL:medium");
		expect(savedModels()).toEqual([
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "medium", "high", "xhigh"] },
			{ id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", levels: [] },
		]);
		const offered = internals.shared.models!;
		expect(offered.map((entry) => [entry.id, entry.name, entry.reasoning])).toEqual([
			["gemini-3.8-flash", "agy · Gemini 3.8 Flash", true],
			["gemini-3.8-pro", "agy · Gemini 3.8 Pro", false],
		]);
		expect(offered[0].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
	});

	it("asks `agy models` for the models before any conversation has listed them", async () => {
		setEnv(
			"MOCK_AGY_MODELS",
			[
				"gemini-4-argon-medium\tGemini 4 Argon (Medium)",
				"gemini-4-argon-high\tGemini 4 Argon (High)",
				"gemini-4-argon-low\tGemini 4 Argon (Low)",
				"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
				"",
			].join("\n"),
		);
		internals.shared.models = [];
		internals.shared.discovery = undefined;
		await internals.discoverModels();
		expect(requests()).toEqual([{ start: ["models"] }]);
		expect(savedModels()).toEqual([
			{ id: "gemini-4-argon", name: "Gemini 4 Argon", levels: ["low", "medium", "high"] },
			{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", levels: [] },
		]);
		expect(internals.shared.models!.map((entry) => [entry.id, entry.reasoning])).toEqual([
			["gemini-4-argon", true],
			["gpt-oss-120b-medium", false],
		]);
		// Asked once per process.
		await internals.discoverModels();
		expect(requests()).toHaveLength(1);
	});

	it("keeps the models a conversation listed, takes only their thinking levels from `agy models`, and drops the old default entry", async () => {
		mkdirSync(join(dir, "agent", "agy-shell"), { recursive: true });
		writeFileSync(
			join(dir, "agent", "agy-shell", "models.json"),
			JSON.stringify([
				{ id: "default", name: "Default" },
				{ id: "gemini-4-argon", name: "Gemini 4 Argon" },
				{ id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", levels: ["low"] },
			]),
		);
		expect(internals.readKnownModels().map((entry) => entry.id)).toEqual(["gemini-4-argon", "gemini-3.8-pro"]);
		setEnv(
			"MOCK_AGY_MODELS",
			"gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\nother-9\tOther 9\n",
		);
		internals.shared.models = [];
		internals.shared.discovery = undefined;
		await internals.discoverModels();
		expect(savedModels()).toEqual([
			{ id: "gemini-4-argon", name: "Gemini 4 Argon", levels: ["low", "high"] },
			{ id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", levels: ["low"] },
		]);
	});

	it("reports what each round read in full, read from the cache and wrote, from agy's record of the conversation", async () => {
		const chat = openChat([...CODING_TOOLS, WEB_SEARCH], { runApp: () => "found" });
		const final = await chat.send(
			'tokens 46802 0 1380 ;; usage 48182 1048576 ;; app web_search {"query":"x"} ;; note searched ;; tokens 14696 46803 554 ;; usage 62053 1048576 ;; say done',
		);
		expect(textOf(final)).toBe("RESULT:founddone");
		const reported = { input: true, output: true, cacheRead: true, cacheWrite: true };
		const replies = chat.messages.filter((message) => message.role === "assistant");
		expect(replies.map((reply) => reply.usage)).toMatchObject([
			{ input: 46802, cacheRead: 0, cacheWrite: 0, output: 1380, totalTokens: 48182, reported },
			{ input: 14696, cacheRead: 46803, cacheWrite: 0, output: 554, totalTokens: 62053, reported },
		]);
		// The next turn counts only its own requests, and two requests of one round are that round's use.
		const next = await chat.send("tokens 100 62000 10 ;; tokens 200 62100 20 ;; usage 62320 1048576 ;; say more");
		expect(next.message.usage).toMatchObject({ input: 300, cacheRead: 124100, output: 30, totalTokens: 62320 });
	});

	it("waits a moment for the request that wrote a turn's last words to reach the record", async () => {
		const chat = openChat();
		const final = await chat.send("note started ;; latetokens 500 100 20 ;; say done");
		expect(final.message.usage).toMatchObject({ input: 500, cacheRead: 100, output: 20 });
		// A record with nothing new for the turn: no numbers are invented, and the turn still ends.
		const quiet = await chat.send("say again");
		expect(quiet.message.usage).toMatchObject({ input: 0, cacheRead: 0, output: 0 });
	});

	it("counts nothing agy recorded before the conversation was picked up again", async () => {
		const first = openChat();
		await first.send("tokens 900 0 90 ;; say one");
		const sessionId = first.session.sessionId;
		first.session.close();
		await new Promise((resolve) => setTimeout(resolve, 150));
		// A new agy for the same chat resumes the conversation, whose record already holds the first turn.
		const again: any = new internals.AcpSession(sessionId);
		internals.shared.sessions.set(sessionId, again);
		sessions.push(again);
		const events: any[] = [];
		const messages = [
			...first.messages,
			{ role: "user", content: "tokens 50 900 5 ;; say two", timestamp: Date.now() },
		];
		await internals.runTurn(
			{ push: (event: any) => events.push(event), end() {} },
			again,
			model(),
			{ messages, tools: CODING_TOOLS, systemPrompt: "BASE PROMPT" },
			{},
		);
		const final = events[events.length - 1];
		expect(final.type).toBe("done");
		expect(requests().some((entry) => entry.method === "session/resume")).toBe(true);
		expect(final.message.usage).toMatchObject({ input: 50, cacheRead: 900, output: 5 });
	});

	it("lets the user set a model's context length, and has agy compact a conversation that reached it", async () => {
		setEnv("MOCK_ACP_COMMANDS", "compact");
		setEnv("MOCK_ACP_COMPACT_TO", "20000");
		internals.shared.models = [];
		const chatModel = { ...model(), id: "gemini-3.8-flash" };
		const chat = openChat(CODING_TOOLS, { model: chatModel });
		await chat.send("usage 120000 1000000 ;; say one");
		expect(chatModel.contextWindow).toBe(1_000_000);
		const compactions = () => requests().filter((entry) => entry.compact).length;

		// One setting per model on the provider's card.
		const settings = internals.contextSettings();
		expect(settings.map((entry) => [entry.id, entry.model, entry.label])).toEqual([
			["context-length:gemini-3.8-flash", "gemini-3.8-flash", "上下文长度"],
			["context-length:gemini-3.8-pro", "gemini-3.8-pro", "上下文长度"],
		]);
		const setting = settings[0];
		expect(setting.get()).toBe("");
		expect(setting.placeholder).toBe("1M");
		expect(() => setting.set("10k")).toThrow(/50K 到 1M 之间/);
		expect(() => setting.set("2m")).toThrow(/50K 到 1M 之间/);
		expect(() => setting.set("lots")).toThrow(/50K 到 1M 之间/);
		expect(contextLimit("gemini-3.8-flash")).toBeUndefined();
		setting.set("100k");
		expect(setting.get()).toBe("100K");
		expect(contextLimit("gemini-3.8-flash")).toBe(100_000);
		// Chats on the model are measured against the new length at once; the other model keeps its own.
		expect(internals.shared.models!.map((entry) => entry.contextWindow)).toEqual([100_000, 1_000_000]);

		// The conversation stands at 120K: agy compacts it before the next message goes in.
		const final = await chat.send("say two");
		expect(textOf(final)).toBe("two");
		expect(compactions()).toBe(1);
		expect(final.message.usage.totalTokens).toBe(20_000);
		expect(chatModel.contextWindow).toBe(100_000);
		// Under the length again: nothing is compacted.
		await chat.send("say three");
		expect(compactions()).toBe(1);

		// Cleared: agy's own window again.
		setting.set("");
		expect(contextLimit("gemini-3.8-flash")).toBeUndefined();
		expect(internals.shared.models![0].contextWindow).toBe(1_000_000);
	});

	it("asks agy what is left of the plan without a model request, and shows it in the chats that are on agy", async () => {
		setEnv(
			"MOCK_AGY_USAGE",
			[
				"Gemini Models\tWeekly Limit Remaining\t98%\t2099-01-08T00:00:00Z",
				"Gemini Models\tFive Hour Limit Remaining\t92%\t2099-01-01T05:00:00Z",
				"",
			].join("\n"),
		);
		const shown = new Map<string, string | undefined>();
		const open = (id: string, chatModel: any) => {
			internals.shared.contexts.set(id, {
				model: chatModel,
				ui: { setStatus: (key: string, text: string | undefined) => shown.set(`${id}:${key}`, text) },
			});
			sessions.push({ sessionId: id, close() {} });
		};
		open("quota-agy", { provider: "agy", id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" });
		open("quota-other", { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek" });
		for (const name of ["quota", "quotaAskedAt", "quotaFailedAt", "quotaUnsupported", "usingKey"] as const) {
			internals.shared[name] = undefined;
		}
		await internals.refreshQuota(0);
		expect(requests()).toEqual([{ start: ["--print-timeout", "30s", "-p", "/usage"] }]);
		expect(shown.get("quota-agy:agy")).toBe("agy 额度剩余 5h 92% · 7d 98%");
		expect(shown.get("quota-other:agy")).toBeUndefined();
		// Not asked again within the minute.
		await internals.refreshQuota(0);
		expect(requests()).toHaveLength(1);
		// A chat that runs on a saved Gemini API key does not draw on the plan: its limits are not asked for.
		internals.shared.usingKey = true;
		internals.shared.quotaAskedAt = undefined;
		await internals.refreshQuota(0);
		expect(requests()).toHaveLength(1);
	});

	it("gives the plan's numbers to MyHarness's own display, and then leaves them out of the chat's status", async () => {
		setEnv(
			"MOCK_AGY_USAGE",
			[
				"Gemini Models\tWeekly Limit Remaining\t98%\t2099-01-08T00:00:00Z",
				"Gemini Models\tFive Hour Limit Remaining\t92%\t2099-01-01T05:00:00Z",
				"",
			].join("\n"),
		);
		for (const name of ["quota", "quotaAskedAt", "quotaFailedAt", "quotaUnsupported", "usingKey"] as const) {
			internals.shared[name] = undefined;
		}
		let source: any;
		const seen: boolean[] = [];
		const pi: any = {
			registerProvider() {},
			registerTool() {},
			registerCommand() {},
			on() {},
			getActiveTools: () => [],
			setActiveTools() {},
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			registerPlanUsageSource: (given: any) => {
				source = given;
				// What the display would read at every change: whether a reading is under way.
				return () => seen.push(!!given.snapshot().refreshing);
			},
		};
		agyShell(pi);
		// Loading the plugin also asks agy for its models; only the questions about the plan count here.
		const asked = () => requests().filter((entry: any) => entry.start?.includes("/usage"));
		expect({ id: source.id, label: source.label }).toEqual({ id: "agy", label: "agy" });
		const shown = new Map<string, string | undefined>();
		internals.shared.contexts.set("plan-agy", {
			model: { provider: "agy", id: "gemini-3.8-flash", name: "agy · Gemini 3.8 Flash" },
			ui: { setStatus: (key: string, text: string | undefined) => shown.set(key, text) },
		});
		sessions.push({ sessionId: "plan-agy", close() {} });
		expect(source.snapshot()).toMatchObject({ groups: [], refreshing: false });

		// The display's refresh button: asked at once, and the display hears that the reading began and how it ended.
		await source.refresh({ maxAgeMs: 0 });
		expect(asked()).toEqual([{ start: ["--print-timeout", "30s", "-p", "/usage"] }]);
		const snapshot = source.snapshot();
		expect(snapshot.groups.map((group: any) => ({ label: group.label, windows: group.windows }))).toEqual([
			{
				label: "Gemini Models",
				windows: [
					{ kind: "five_hour", leftPercent: 92, resetsAt: Date.parse("2099-01-01T05:00:00Z") },
					{ kind: "weekly", leftPercent: 98, resetsAt: Date.parse("2099-01-08T00:00:00Z") },
				],
			},
		]);
		expect(snapshot.refreshing).toBe(false);
		expect(snapshot.error).toBeUndefined();
		expect(Date.now() - snapshot.observedAt).toBeLessThan(60_000);
		// Not twice a minute, and the display is told until when.
		expect(snapshot.nextRefreshAt).toBeGreaterThan(Date.now());
		expect(seen[0]).toBe(true);
		expect(seen[seen.length - 1]).toBe(false);
		// The numbers are in MyHarness's display: the chat's status line does not say them a second time.
		expect(shown.get("agy")).toBeUndefined();
		await source.refresh({ maxAgeMs: 0 });
		await source.refresh();
		expect(asked()).toHaveLength(1);

		// A failed reading keeps the last numbers and says why.
		internals.shared.quotaFailedAt = Date.now();
		internals.shared.quotaError = "not signed in";
		expect(source.snapshot()).toMatchObject({ error: "not signed in", groups: [{ label: "Gemini Models" }] });
		// On a saved API key the plan's numbers do not apply.
		internals.shared.usingKey = true;
		expect(source.snapshot()).toEqual({ groups: [], unavailable: expect.stringContaining("API key") });
	});

	it("says in one line why agy gave no numbers", () => {
		const failed = Object.assign(
			new Error(
				"Command failed: C:/Users/user/agy.exe --print-timeout 30s -p /usage\nError: not signed in\n  at x\n",
			),
			{ code: 1, killed: false },
		);
		expect(failureText(failed)).toBe("Error: not signed in");
		expect(failureText(Object.assign(new Error("Command failed: agy -p /usage\n"), { killed: true }))).toBe(
			"agy 没有在限定时间内回答",
		);
		expect(failureText(Object.assign(new Error("Command failed: agy -p /usage\n"), { code: 3 }))).toBe(
			"agy 以代码 3 退出",
		);
		expect(failureText(new Error("找不到 agy 程序"))).toBe("找不到 agy 程序");
		expect(failureText(undefined)).toBe("agy 没有给出额度");
	});

	it("never asks again an agy whose /usage gives no table", async () => {
		setEnv("MOCK_AGY_USAGE", "I can't run that command here.\n");
		for (const name of ["quota", "quotaAskedAt", "quotaFailedAt", "quotaUnsupported", "usingKey"] as const) {
			internals.shared[name] = undefined;
		}
		await internals.refreshQuota(0);
		expect(internals.shared.quota).toBeUndefined();
		expect(internals.shared.quotaUnsupported).toBe(true);
		internals.shared.quotaAskedAt = undefined;
		await internals.refreshQuota(0);
		expect(requests()).toHaveLength(1);
		// Nor after a restart of MyHarness, while the program is the same copy: the words would go to a model each time.
		internals.shared.quotaUnsupported = undefined;
		internals.shared.quotaAskedAt = undefined;
		await internals.refreshQuota(0);
		expect(requests()).toHaveLength(1);
		expect(internals.shared.quotaUnsupported).toBe(true);
		const saved = JSON.parse(readFileSync(join(dir, "agent", "agy-shell", "settings.json"), "utf8"));
		expect(saved.usageUnsupported).toContain("mock-acp-agent.mjs|");
	});

	it("gets a call of the built-in browser's tool through agy's own check, and hands MyHarness the call without agy's argument", async () => {
		const workspace = createWorkspaceToolDefinition();
		const call = { operation: "navigate", url: "https://example.com/" };
		const withSummary = JSON.stringify({ ...call, [AGY_SUMMARY_ARG]: "Open the page" });
		for (const mode of ["1", "keep"]) {
			// "keep": an agy that passes its own argument on to the tool.
			setEnv("MOCK_ACP_STRICT_TOOLS", mode);
			const chat = openChat([...CODING_TOOLS, workspace as any], {
				runApp: (made) => JSON.stringify(made.arguments),
			});
			const final = await chat.send(`app workspace ${withSummary} ;; say .`);
			expect(textOf(final)).toBe(`RESULT:${JSON.stringify(call)}.`);
			expect(chat.rounds.flat().map((card) => [card.name, card.arguments])).toEqual([["workspace", call]]);
			// What agy refuses by its own rule it still refuses: the model always sends the argument.
			const refused = await chat.send(`app workspace ${JSON.stringify(call)} ;; say .`);
			expect(textOf(refused)).toContain(
				"INVALID:invalid tool call: invalid arguments: missing property 'toolSummary'",
			);
		}
	});

	/** Chinese text of about `bytes` UTF-8 bytes, so that characters and bytes differ (three bytes a character). */
	const chineseOf = (bytes: number, seed: string) => {
		const sentence = `${seed}模型读取配置并运行测试，把失败用例的堆栈整理成报告，最后写出下一步的计划。`;
		return sentence.repeat(Math.max(1, Math.ceil(bytes / Buffer.byteLength(sentence, "utf8"))));
	};
	/** The text the plugin put in session/prompt, as the stand-in echoed it. */
	const sentPrompt = (final: any): string => {
		const text = textOf(final);
		expect(text.startsWith("PROMPT:")).toBe(true);
		return text.slice("PROMPT:".length);
	};
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");

	// agy keeps only the beginning of a long message (192,000 bytes with agy 1.5.9, seen 2026-11-17). A chat's history
	// that went along whole lost its newest part and the user's new words, and the model answered an older question.
	it("keeps a rebuilt conversation's history within what agy takes in one message, newest first", async () => {
		const chat = openChat();
		for (const seed of ["最早的消息", "较早的消息", "中间的消息", "又一段消息"]) {
			chat.messages.push({ role: "user", content: `问题：${seed}`, timestamp: Date.now() });
			chat.messages.push({
				role: "assistant",
				content: [{ type: "text", text: chineseOf(64_000, seed) }],
				timestamp: Date.now(),
			});
		}
		chat.messages.push({ role: "user", content: "最新的问题：去掉第二行的final", timestamp: Date.now() });
		chat.messages.push({
			role: "assistant",
			content: [{ type: "text", text: `${chineseOf(20_000, "最新的回答")}NEWEST-ANSWER-END` }],
			timestamp: Date.now(),
		});
		setEnv("MOCK_ACP_CAPS", JSON.stringify({ sessionCapabilities: {} }));
		const current = "现在请批改我的答案。";
		const sent = sentPrompt(await chat.send(`${current}\necho`));
		expect(bytes(sent)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
		expect(sent).toContain("最新的问题：去掉第二行的final");
		expect(sent).toContain("NEWEST-ANSWER-END");
		expect(sent).toContain(current);
		expect(sent).not.toContain("问题：最早的消息");
		expect(sent).toMatch(/earlier messages? (is|are) left out here/);
		expect(sent.trim().endsWith(HOST_TURN_REMINDER)).toBe(true);
	});

	// A request of MyHarness's own (a summary, a title) goes as one text: its instruction at the end stays.
	it("keeps a long side request within what agy takes in one message, with its instruction", async () => {
		const instruction = "请只用一句话总结上面的会议记录。最近一条决议：下个版本先修复并发写入的问题。";
		const message = `${chineseOf(300_000, "会议记录")}\n${instruction}\necho`;
		const result = await internals
			.streamSimple(model(), { messages: [{ role: "user", content: message, timestamp: 1 }] }, {})
			.result();
		expect(result.stopReason).toBe("stop");
		const sent = sentPrompt({ text: result.content.map((part: any) => part.text ?? "").join("") });
		expect(bytes(sent)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
		expect(sent).toContain(message.slice(-2_000));
		expect(sent).toContain(message.slice(0, 200));
		expect(sent).toMatch(/\[\.\.\. \d+ bytes left out \.\.\.\]/);
	});

	// agy cut a message all the same (a lower limit, or a message too long by itself): the user is told, and a
	// conversation that lost the newest part of its history is not continued; a new one gets it within the lower limit.
	it("tells the user when agy cut a message, and starts over a conversation whose history was cut", async () => {
		const chat = openChat();
		const notes: [string, string][] = [];
		internals.shared.contexts.get(chat.session.sessionId).ui.notify = (text: string, kind: string) =>
			notes.push([text, kind]);
		await chat.send("cut 300 ;; tokens 10 0 5 ;; say short");
		expect(notes).toHaveLength(1);
		expect(notes[0][1]).toBe("warning");
		expect(notes[0][0]).toContain("截掉");
		expect(chat.session.startOver).toBe(false);
		// A short message that was cut is no length to keep under.
		expect(internals.shared.promptLimits.size).toBe(0);

		for (const seed of ["第一段", "第二段", "第三段"]) {
			chat.messages.push({
				role: "assistant",
				content: [{ type: "text", text: chineseOf(60_000, seed) }],
				timestamp: Date.now(),
			});
		}
		chat.session.close();
		setEnv("MOCK_ACP_CAPS", JSON.stringify({ sessionCapabilities: {} }));
		const first = sentPrompt(await chat.send("cut 60000 ;; tokens 10 0 5 ;; echo"));
		expect(first).toContain("<earlier-conversation>");
		expect(notes).toHaveLength(2);
		expect(notes[1][0]).toContain("之前的对话记录");
		expect(chat.session.startOver).toBe(true);
		const limit = internals.shared.promptLimits.get(model().id);
		expect(limit).toBeLessThanOrEqual(bytes(first) - 60_000);

		const conversations = () => requests().filter((entry) => entry.method === "session/new").length;
		const before = conversations();
		const again = sentPrompt(await chat.send("echo"));
		expect(conversations()).toBe(before + 1);
		expect(again).toContain("<earlier-conversation>");
		expect(bytes(again)).toBeLessThanOrEqual(limit!);
		expect(chat.session.startOver).toBe(false);
	});
});

describe("agy-shell earlier conversation within what agy takes", () => {
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");

	it("cuts a text to a number of UTF-8 bytes without halving a character, keeping its beginning and end", () => {
		const text = `开头${"中文和English混合🙂".repeat(5_000)}结尾`;
		for (const limit of [3_000, 3_001, 3_002, 50_000]) {
			const cut = clipBytes(text, limit);
			expect(bytes(cut)).toBeLessThanOrEqual(limit);
			expect(cut).not.toContain("�");
			expect(cut.startsWith("开头")).toBe(true);
			expect(cut.endsWith("结尾")).toBe(true);
			expect(cut).toMatch(/\[\.\.\. \d+ bytes left out \.\.\.\]/);
		}
		expect(clipBytes("短", 100)).toBe("短");
	});

	it("gives what was said first and fills the rest with the newest tool results", () => {
		const messages: any[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push({ role: "user", content: `question ${i}` });
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: `file-${i}.txt` } }],
			});
			messages.push({
				role: "toolResult",
				toolName: "read",
				content: [{ type: "text", text: `result ${i} ${"内容".repeat(4_000)}` }],
			});
			messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
		}
		const text = renderTranscript(messages, 60_000);
		expect(bytes(text)).toBeLessThanOrEqual(60_000);
		// Every question and answer is there, the oldest included.
		for (let i = 0; i < 12; i++) {
			expect(text).toContain(`user: question ${i}\n`);
			expect(text).toContain(`assistant: answer ${i}`);
		}
		// The newest tool results are given, the oldest only named with their size.
		expect(text).toContain("tool result (read): result 11 ");
		expect(text).toContain("tool result (read): [left out, ");
		expect(text).not.toContain("result 0 内容");
		expect(text.indexOf("question 0")).toBeLessThan(text.indexOf("question 11"));
		expect(text).not.toContain("left out here");
	});

	it("leaves out the oldest messages first and says so", () => {
		const messages = Array.from({ length: 40 }, (_, i) => ({
			role: i % 2 ? "assistant" : "user",
			content: `message ${i} ${"字".repeat(1_000)}`,
		}));
		const text = renderTranscript(messages, 20_000);
		expect(bytes(text)).toBeLessThanOrEqual(20_000);
		expect(text).toContain("message 39 ");
		expect(text).not.toContain("message 0 ");
		expect(text.startsWith("(")).toBe(true);
		expect(text.split("\n")[0]).toMatch(/^\(\d+ earlier messages are left out here/);
		expect(renderTranscript(messages, 100)).toBe("");
	});

	it("reads a message agy cut from its record, and not the record's own shortening", () => {
		const note =
			"NOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range to get the information you need.";
		const step = (content: string, type = "USER_INPUT") => JSON.stringify({ step_index: 0, type, content });
		const cut = step(`<USER_REQUEST>\nhead\n<truncated 188066 bytes>\nmiddle\n<truncated 129557 bytes>\n\n${note}`);
		const shortened = step("<USER_REQUEST>\nhead\n<truncated 13001 bytes>\ntail of the message</USER_REQUEST>");
		const quoted = step(
			`<USER_REQUEST>\nthe log said <truncated 5 bytes>\n\n${note}\nwhat does it mean?</USER_REQUEST>`,
		);
		expect(cutFromInput([shortened, cut].join("\n"))).toBe(129_557);
		expect(cutFromInput(shortened)).toBeUndefined();
		expect(cutFromInput(quoted)).toBeUndefined();
		expect(cutFromInput(step(`<truncated 9 bytes>\n\n${note}`, "GENERIC"))).toBeUndefined();
		expect(
			cutFromInput("not json USER_INPUT NOTE: The output was truncated because it was too long."),
		).toBeUndefined();
	});
});
