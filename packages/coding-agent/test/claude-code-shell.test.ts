import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import claudeCodeShell, {
	appendedPrompt,
	appendPromptFor,
	bashMaxTimeout,
	CUT_CALLS_NOTE,
	callSummary,
	ENTRYPOINT,
	internals,
	launchEnv,
	limitsFromEvent,
	limitsFromUsage,
	limitsNeedQuery,
	limitsText,
	mergeLimits,
	OUTPUT_LIMIT_NOTE,
	OWN_TOOLS_FOR,
	offeredNames,
	outputLimitFor,
	outputLimitNote,
	ownToolLimit,
	ownToolsFor,
	planUsageGroups,
	STRIPPED_ENV,
	STUCK_TOOL_NOTE,
} from "../examples/extensions/claude-code-shell.ts";

describe("claude-code-shell tools", () => {
	const coding = [
		"read",
		"write",
		"edit",
		"bash",
		"pwsh",
		"web_search",
		"todo_write",
		"ask_user_question",
		"job_output",
	];

	it("gives claude one of its own tools only while the MyHarness tool it stands in for is switched on", () => {
		expect(ownToolsFor(coding)).toEqual(["Bash", "Edit", "Read", "Write"]);
		// A chat without file or shell tools gets none of Claude Code's.
		expect(ownToolsFor(["web_search", "memory_search", "todo_write"])).toEqual([]);
		expect(ownToolsFor([])).toEqual([]);
		expect(ownToolsFor(["grep", "find", "ls"])).toEqual(["Glob", "Grep"]);
		// Either shell is Claude Code's one Bash; a patch tool both edits and creates files.
		expect(ownToolsFor(["pwsh"])).toEqual(["Bash"]);
		expect(ownToolsFor(["apply_patch"])).toEqual(["Edit", "Write"]);
		// Nothing of Claude Code's that stands in for no MyHarness tool is ever in the list.
		const everything = ownToolsFor([
			...Object.keys(OWN_TOOLS_FOR),
			"agent",
			"agent_tasks",
			"web_search",
			"web_fetch",
		]);
		for (const name of ["Agent", "Task", "Skill", "WebSearch", "WebFetch", "NotebookEdit", "AskUserQuestion"])
			expect(everything).not.toContain(name);
	});

	it("offers over MCP every other MyHarness tool that is on, and its shells for background jobs", () => {
		expect(offeredNames(coding)).toEqual([
			"bash",
			"pwsh",
			"web_search",
			"todo_write",
			"ask_user_question",
			"job_output",
		]);
		// MyHarness's own sub-agents, to-do list and questions are MyHarness's to run, with its own cards and settings.
		expect(offeredNames(["agent", "agent_tasks", "read", "claude_code_tool"])).toEqual(["agent", "agent_tasks"]);
		expect(offeredNames(["read", "write", "edit", "apply_patch", "grep", "find", "ls"])).toEqual([]);
	});

	it("summarizes a call of claude's own tool in one line for its card", () => {
		expect(callSummary("Read", { file_path: "C:/p/src/app.ts", limit: 20 })).toBe("Read C:/p/src/app.ts");
		expect(callSummary("Bash", { command: "npm test\nnpm run lint", description: "run tests" })).toBe(
			"Bash npm test",
		);
		expect(callSummary("Grep", { pattern: "TODO", path: "src" })).toBe("Grep TODO · src");
		expect(callSummary("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
		expect(callSummary("Edit", {})).toBe("Edit");
		// While the arguments are still arriving there may be nothing to show yet.
		expect(callSummary("Write", undefined)).toBe("Write");
		expect(callSummary("Bash", { command: "x".repeat(500) })).toHaveLength("Bash ".length + 160);
	});

	it("names a file inside the chat's folder from that folder, and any other by its whole path", () => {
		const cwd = join(tmpdir(), "chat-folder");
		const inside = join(cwd, "src", "app.ts");
		const outside = join(tmpdir(), "elsewhere", "notes.md");
		expect(callSummary("Read", { file_path: inside }, cwd)).toBe("Read src/app.ts");
		expect(callSummary("Edit", { file_path: inside.replace(/\\/g, "/") }, cwd)).toBe("Edit src/app.ts");
		expect(callSummary("Grep", { pattern: "TODO", path: join(cwd, "src") }, cwd)).toBe("Grep TODO · src");
		expect(callSummary("Write", { file_path: outside }, cwd)).toBe(`Write ${outside}`);
		// A path that is already relative, the folder itself and a command are left as they are.
		expect(callSummary("Read", { file_path: "src/app.ts" }, cwd)).toBe("Read src/app.ts");
		expect(callSummary("Glob", { pattern: "*.ts", path: cwd }, cwd)).toBe(`Glob *.ts · ${cwd}`);
		expect(callSummary("Bash", { command: `ls ${inside}` }, cwd)).toBe(`Bash ls ${inside}`);
	});
});

describe("claude-code-shell prompt", () => {
	it("appends MyHarness's whole prompt after the section on where claude runs and how tool names map", () => {
		const systemPrompt =
			'<user_personalization priority="highest">\nPERSONAL_PROMPT_MARKER\n</user_personalization>\n\n# Coding mode\nMYHARNESS_BUILT_IN\n\n<model_instructions priority="highest">\nMODEL_PROMPT\n</model_instructions>';
		const active = ["read", "edit", "apply_patch", "bash", "schedule", "job_output", "memory_search"];
		const text = appendedPrompt(active, systemPrompt);
		const section = appendPromptFor(active);
		expect(text.startsWith(section)).toBe(true);
		// Every part of MyHarness's prompt arrives, unchanged and in MyHarness's order, with the model's own prompt last.
		expect(text.endsWith(systemPrompt)).toBe(true);
		expect(text.trimEnd().endsWith("</model_instructions>")).toBe(true);
		expect(section).toContain("MyHarness's instructions win");
		expect(section).toContain("read → Read, edit → Edit, apply_patch → Edit and Write, bash → Bash.");
		// Two MyHarness tools that one tool of claude's does are named together.
		expect(appendPromptFor(["bash", "pwsh", "find", "ls"])).toContain("bash and pwsh → Bash, find and ls → Glob.");
		expect(section).toContain("mcp__myharness__<name>");
		expect(section).toContain("mcp__myharness__bash");
		expect(section).toContain("A tool they do not list is not available in this chat.");
		// Without a prompt of MyHarness's only the section is appended.
		expect(appendedPrompt(active, undefined)).toBe(section);
		expect(appendedPrompt(active, "  ")).toBe(section);
	});

	it("names only the tools the chat really has, and leaves what comes back after a reply to MyHarness's prompt", () => {
		const chatOnly = appendPromptFor(["web_search", "memory_search"]);
		expect(chatOnly).not.toContain("→");
		expect(chatOnly).not.toContain("mcp__myharness__bash");
		expect(chatOnly).toContain("mcp__myharness__<name>");
		const none = appendPromptFor([]);
		expect(none).not.toContain("mcp__myharness__");
		expect(none).toContain("A tool they do not list is not available in this chat.");
		// Claude Code's own later turns do not exist; MyHarness's job reports and schedules are not denied here.
		for (const section of [chatOnly, none, appendPromptFor(["bash", "job_output"])]) {
			expect(section).toContain("Claude Code's own wake-ups");
			expect(section).not.toContain("never reports back");
			expect(section).not.toMatch(/Agent|TodoWrite|AskUserQuestion/);
		}
	});
});

describe("claude-code-shell in a sub-agent", () => {
	const worker = ["read", "grep", "find", "ls", "bash", "symbols", "web_search", "web_fetch", "edit", "write", "pwsh"];
	const model = { id: "claude-sonnet-5-5", api: "claude-code-cli", provider: "claude-code" };

	// A sub-agent's session reads its data folder (context length); these never touch the user's.
	let dataRoot: string;
	let previousRoot: string | undefined;
	beforeAll(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "claude-code-shell-worker-test-"));
		previousRoot = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = dataRoot;
	});
	afterAll(() => {
		if (previousRoot === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousRoot;
		rmSync(dataRoot, { recursive: true, force: true });
	});

	/** Loads the extension with a stand-in for MyHarness and starts one session of the given role. */
	async function startSession(sessionId: string, agentRole: "main" | "delegated") {
		const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
		const pi: any = {
			on: (event: string, handler: (event: any, ctx: any) => unknown) =>
				handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerProvider: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerWebSearchSource: vi.fn(),
			getActiveTools: () => worker,
			setActiveTools: vi.fn(),
			sendMessage: vi.fn(),
		};
		claudeCodeShell(pi);
		const ctx = {
			agentRole,
			cwd: dataRoot,
			// Not a Claude Code model: a main session on one would ask the real program for the plan limits.
			model: { provider: "other" },
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
			ui: { setStatus: vi.fn(), notify: vi.fn() },
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
		const end = async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
		};
		return { pi, end };
	}

	it("gives a sub-agent none of claude's own tools and every MyHarness tool of its role over MCP", () => {
		expect(ownToolsFor(worker, true)).toEqual([]);
		expect(offeredNames(worker, true)).toEqual(worker);
		// The card for a tool claude runs by itself is never a tool of the chat.
		expect(offeredNames([...worker, "claude_code_tool"], true)).toEqual(worker);
		const section = appendPromptFor(worker, true);
		expect(section).toContain("as one of its sub-agents");
		expect(section).toContain("mcp__myharness__<name>");
		expect(section).toContain("You have no tools of your own here");
		expect(section).not.toContain("→");
		expect(section).not.toContain("your own Bash");
		// One text for every sub-agent, whatever its tools: MyHarness's own instructions name them.
		expect(appendPromptFor([], true)).toBe(section);
		expect(appendedPrompt(worker, "ROLE PROMPT", true)).toBe(`${section}\n\nROLE PROMPT`);
		// A chat is told as before.
		expect(appendPromptFor(worker)).toContain("read → Read");
	});

	it("says to MyHarness that its models leave every tool to it in a sub-agent", async () => {
		const { pi, end } = await startSession("role-models", "main");
		const provider = pi.registerProvider.mock.calls[0][0];
		const models = provider.models ?? provider.getModels?.() ?? [];
		expect(models.length).toBeGreaterThan(0);
		for (const entry of models) expect(entry).toMatchObject({ runsOwnTools: true, delegatedHostTools: true });
		await end();
	});

	it("treats a session as a sub-agent's by the role MyHarness gives it, and only then", async () => {
		const tools = worker.map((name) => ({ name, description: `MyHarness ${name}`, parameters: { type: "object" } }));
		const delegated = await startSession("role-delegated", "delegated");
		const sub: any = new internals.CliSession("role-delegated");
		sub.tools = tools;
		expect(sub.hostOnly).toBe(true);
		expect(sub.ownTools()).toEqual([]);
		expect(sub.offeredTools().map((tool: any) => tool.name)).toEqual(worker);
		// MyHarness's own shell with its own arguments, not the background-job stand-in a chat gets.
		expect(sub.offeredTools().find((tool: any) => tool.name === "bash").description).toBe("MyHarness bash");
		expect(sub.appendPrompt("ROLE")).toBe(appendedPrompt(worker, "ROLE", true));
		// The card tool does not exist there, so nothing tries to switch it on.
		expect(delegated.pi.setActiveTools).not.toHaveBeenCalled();

		const main = await startSession("role-main", "main");
		const chat: any = new internals.CliSession("role-main");
		chat.tools = tools;
		expect(chat.hostOnly).toBe(false);
		expect(chat.ownTools()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
		expect(chat.offeredTools().map((tool: any) => tool.name)).toEqual([
			"bash",
			"symbols",
			"web_search",
			"web_fetch",
			"pwsh",
		]);
		expect(chat.offeredTools().find((tool: any) => tool.name === "bash").description).toContain("background");

		// Once the sub-agent's session is over, its id means nothing any more.
		await delegated.end();
		expect(sub.hostOnly).toBe(false);
		await main.end();
	});

	it("gives a program started again the sub-agent's earlier messages as text, and a running one nothing twice", async () => {
		const { end } = await startSession("role-restart", "delegated");
		const session: any = new internals.CliSession("role-restart");
		const written: any[] = [];
		const state = { starts: 0 };
		session.start = async () => {
			state.starts++;
			session.child = { stdin: { write: (line: string) => written.push(JSON.parse(line)), end() {} }, exitCode: 0 };
			// What the real start does for a program that has seen nothing of the chat yet.
			session.conversationHere = false;
		};
		const texts = () =>
			written
				.filter((message) => message.type === "user")
				.map((message) => message.message.content.map((part: any) => part.text).join("\n"));
		const collect = () => ({ push() {}, end() {} });
		const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
		try {
			const context: any = { messages: [{ role: "user", content: "the task", timestamp: 1 }], tools };
			void internals.runTurn(collect(), session, model, context, {});
			await settle();
			expect(state.starts).toBe(1);
			expect(texts()).toEqual(["the task"]);

			// The round was cut off and its turn ended, the program still runs: it holds the conversation.
			session.turnActive = false;
			session.cutOff = true;
			context.messages.push(
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] },
				{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "A" }] },
			);
			void internals.runTurn(collect(), session, model, context, {});
			await settle();
			expect(state.starts).toBe(1);
			expect(texts()[1]).toBe(CUT_CALLS_NOTE);

			// The program is gone (it keeps no conversation for a sub-agent): the next one gets the messages as text.
			session.child = undefined;
			session.turnActive = false;
			void internals.runTurn(collect(), session, model, context, {});
			await settle();
			expect(state.starts).toBe(2);
			expect(texts()[2]).toContain("<earlier-conversation>");
			expect(texts()[2]).toContain("the task");
		} finally {
			session.child = undefined;
			session.close();
			await end();
		}
	});
});

describe("claude-code-shell launch", () => {
	it("loads no CLAUDE.md, caps a request at MyHarness's limit, keeps the user's login and puts no tool behind a search", () => {
		const base: NodeJS.ProcessEnv = { PATH: "p", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000" };
		for (const name of STRIPPED_ENV) base[name] ??= "x";
		const env = launchEnv(base, 64_000, 300_000);
		for (const name of STRIPPED_ENV.filter(
			(name) => name !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS" && name !== "CLAUDE_CODE_ENTRYPOINT",
		))
			expect(env[name]).toBeUndefined();
		expect(env).toMatchObject({
			PATH: "p",
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000",
			CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
			CLAUDE_CODE_DISABLE_CRON: "1",
			ENABLE_TOOL_SEARCH: "false",
			ENABLE_CLAUDEAI_MCP_SERVERS: "false",
			// A MyHarness tool's result is not cut or moved to a file at claude's own 25,000 tokens.
			MAX_MCP_OUTPUT_TOKENS: "125000",
		});
		// An inherited cap never outlives a model without a limit of its own, and the base is left alone.
		expect(launchEnv(base, undefined, 300_000).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
		expect(base.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("128000");
		// A chat's program is started as before; only a sub-agent's has no memory folder of Claude Code's.
		expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
		expect(launchEnv(base, 64_000, 300_000, true).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
	});

	it("names MyHarness as the client, over a name inherited from a Claude Code or Agent SDK session", () => {
		expect(ENTRYPOINT).toBe("myharness");
		expect(["cli", "claude-desktop", "claude-vscode"]).not.toContain(ENTRYPOINT);
		expect(ENTRYPOINT.startsWith("sdk-")).toBe(false);
		for (const inherited of [undefined, "sdk-cli", "sdk-ts", "cli"]) {
			const base: NodeJS.ProcessEnv = { PATH: "p", CLAUDE_CODE_ENTRYPOINT: inherited };
			expect(launchEnv(base, undefined, 300_000).CLAUDE_CODE_ENTRYPOINT).toBe(ENTRYPOINT);
			expect(base.CLAUDE_CODE_ENTRYPOINT).toBe(inherited);
		}
	});

	it("takes the output limit from the model and words the note by what the cut response wrote", () => {
		expect(outputLimitFor({ maxTokens: 64_000 })).toBe(64_000);
		expect(outputLimitFor({ maxTokens: 0 })).toBeUndefined();
		expect(outputLimitFor({})).toBeUndefined();
		expect(OUTPUT_LIMIT_NOTE).toBe("claude-code-output-limit");
		const thinkingOnly = outputLimitNote({ content: [{ type: "thinking", thinking: "" }] });
		expect(thinkingOnly).toContain("think much more briefly");
		const wrote = outputLimitNote({ content: [{ type: "text", text: "half an answer" }] });
		expect(wrote).toContain("Go on from where it stopped");
		// `claude` shows the stopped request as the user's interruption; each note says it was not.
		for (const text of [thinkingOnly, wrote, CUT_CALLS_NOTE]) expect(text).toContain("not from the user");
		expect(CUT_CALLS_NOTE).toContain("make the calls again");
	});
});

describe("claude-code-shell plan limits", () => {
	const hour = 3_600_000;
	const now = Date.parse("2026-11-09T03:00:00Z");

	it("reads a rate_limit_event (fractions, reset in seconds) and a get_usage answer (percentages, ISO reset) alike", () => {
		const fromEvent = limitsFromEvent(
			{
				status: "allowed",
				unifiedWindows: {
					five_hour: { utilization: 0.25, resetsAt: Date.parse("2026-11-09T06:00:00Z") / 1000 },
					seven_day: { utilization: 0.54, resetsAt: Date.parse("2026-11-12T15:00:00Z") / 1000 },
				},
			},
			now,
		);
		// The shape `claude` answered get_usage with, other fields left out.
		const fromUsage = limitsFromUsage(
			{
				subscription_type: "max",
				rate_limits_available: true,
				rate_limits: {
					five_hour: { utilization: 25, resets_at: "2026-11-09T06:00:00.196457+00:00" },
					seven_day: { utilization: 54, resets_at: "2026-11-12T15:00:00.196473+00:00" },
					seven_day_opus: null,
				},
			},
			now,
		);
		for (const limits of [fromEvent, fromUsage]) {
			expect(limits.five_hour?.used).toBeCloseTo(25);
			expect(limits.seven_day?.used).toBeCloseTo(54);
			expect(Math.floor((limits.five_hour?.resetsAt ?? 0) / 1000)).toBe(Date.parse("2026-11-09T06:00:00Z") / 1000);
			expect(limitsText(limits, now)).toBe("Claude 额度剩余 5h 75% · 7d 46%");
		}
		expect(limitsFromEvent({ status: "allowed", utilization: 0.5 }, now)).toEqual({});
		expect(limitsFromUsage({ rate_limits_available: false, rate_limits: null }, now)).toEqual({});
		expect(limitsFromUsage({ rate_limits: { five_hour: { utilization: null, resets_at: null } } }, now)).toEqual({});
	});

	it("keeps each window as seen last, whichever chat or question saw it", () => {
		const seen = (used: number, observedAt: number) => ({ used, resetsAt: now + hour, observedAt });
		const held = { five_hour: seen(30, now), seven_day: seen(50, now) };
		// A get_usage answer asked before the event that was noted meanwhile does not take it back.
		expect(mergeLimits(held, { five_hour: seen(20, now - 1000), seven_day: seen(49, now - 1000) })).toEqual(held);
		expect(mergeLimits(held, { five_hour: seen(31, now + 1000) })).toEqual({
			five_hour: seen(31, now + 1000),
			seven_day: seen(50, now),
		});
	});

	it("shows what is left, and no number for a window known only from before it reset", () => {
		const limits = {
			five_hour: { used: 82, resetsAt: now - 1000, observedAt: now - 3 * hour },
			seven_day: { used: 21.4, resetsAt: now + 72 * hour, observedAt: now - 3 * hour },
		};
		expect(limitsText(limits, now)).toBe("Claude 额度剩余 5h - · 7d 79%");
		expect(limitsText({ seven_day: { used: 104, observedAt: now } }, now)).toBe("Claude 额度剩余 5h - · 7d 0%");
		expect(limitsText({}, now)).toBeUndefined();
	});

	it("reads a single model's weekly limit from a get_usage answer and keeps the newest list of them", () => {
		// The shape claude 2.1.325 answered with on a Max plan (2026-11-14), other fields left out.
		const answer = {
			rate_limits: {
				five_hour: { utilization: 7, resets_at: "2026-11-09T06:00:00+00:00" },
				seven_day: { utilization: 26, resets_at: "2026-11-12T15:00:00+00:00" },
				limits: [
					{ kind: "session", group: "session", percent: 7, resets_at: "2026-11-09T06:00:00+00:00", scope: null },
					{
						kind: "weekly_all",
						group: "weekly",
						percent: 26,
						resets_at: "2026-11-12T15:00:00+00:00",
						scope: null,
					},
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 21,
						resets_at: "2026-11-12T15:00:00+00:00",
						scope: { model: { id: null, display_name: "Fable" }, surface: null },
					},
					{ kind: "weekly_scoped", percent: null, scope: { model: { display_name: "Opus" } } },
				],
			},
		};
		const limits = limitsFromUsage(answer, now);
		expect(limits.models).toEqual([{ label: "Fable", used: 21, resetsAt: Date.parse("2026-11-12T15:00:00Z") }]);
		expect(limits.modelsAt).toBe(now);
		// An answer of get_usage always lists all of them: a later one without the model's limit takes it away, an
		// earlier one (a slow answer) and an answer's event (which tells none) leave the list as it is.
		const later = limitsFromUsage({ rate_limits: { ...answer.rate_limits, limits: [] } }, now + 1000);
		expect(mergeLimits(limits, later).models).toEqual([]);
		expect(mergeLimits(later, limits).models).toEqual([]);
		expect(mergeLimits(limits, { five_hour: { used: 8, observedAt: now + 2000 } }).models).toEqual(limits.models);
	});

	it("gives MyHarness's display what is left of each limit, and which models a single model's limit is for", () => {
		const models = [
			{ id: "claude-opus-5-5", name: "Claude Code · Opus 5.5" },
			{ id: "claude-fable-5-2", name: "Claude Code · Fable 5.2" },
			{ id: "claude-fable-5-1", name: "Claude Code · Fable 5.1" },
		];
		const limits = {
			five_hour: { used: 7, resetsAt: now + hour, observedAt: now },
			// A window that has not started counting has no reset time.
			seven_day: { used: 0, observedAt: now },
			models: [{ label: "Fable", used: 21.4, resetsAt: now + 72 * hour }],
			modelsAt: now,
		};
		expect(planUsageGroups(limits, models)).toEqual([
			{
				label: "",
				windows: [
					{ kind: "five_hour", leftPercent: 93, resetsAt: now + hour },
					{ kind: "weekly", leftPercent: 100, resetsAt: undefined },
				],
			},
			{
				label: "Fable",
				modelIds: ["claude-fable-5-2", "claude-fable-5-1"],
				windows: [{ kind: "weekly", leftPercent: 78.6, resetsAt: now + 72 * hour }],
			},
		]);
		// More than the whole window used is nothing left, and nothing known is nothing shown.
		expect(planUsageGroups({ seven_day: { used: 104, observedAt: now } }, models)).toEqual([
			{ label: "", windows: [{ kind: "weekly", leftPercent: 0, resetsAt: undefined }] },
		]);
		expect(planUsageGroups({}, models)).toEqual([]);
	});

	it("asks claude when a chat opens with nothing known, a window that reset, or only readings older than 5 minutes", () => {
		const window = (observedAt: number, resetsAt = now + hour) => ({ used: 10, resetsAt, observedAt });
		expect(limitsNeedQuery({}, now)).toBe(true);
		expect(limitsNeedQuery({ five_hour: window(now - 60_000), seven_day: window(now - 60_000) }, now)).toBe(false);
		expect(limitsNeedQuery({ five_hour: window(now - 5 * 60_000), seven_day: window(now - 6 * 60_000) }, now)).toBe(
			true,
		);
		expect(limitsNeedQuery({ five_hour: window(now - 60_000, now - 1), seven_day: window(now - 60_000) }, now)).toBe(
			true,
		);
	});
});

describe("claude-code-shell turn", () => {
	/** The events `claude` writes for one streamed answer: every piece, the whole text again, then the turn's end. */
	const answerEvents = (id: string, text: string) => [
		{ type: "stream_event", event: { type: "message_start", message: { id, usage: {} } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "assistant", message: { id, usage: {}, content: [{ type: "text", text }] } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "result", subtype: "success", is_error: false },
	];

	/** Reads one turn from events fed by hand. `claude` is never started: the turn is already under way. */
	async function readTurn(feed: (session: any) => Promise<void> | void): Promise<any> {
		const session: any = new internals.CliSession("turn-test", true);
		session.child = { stdin: { write() {}, end() {} }, exitCode: 0 };
		session.start = async () => {
			throw new Error("a test must not start claude");
		};
		session.turnActive = true;
		session.lastUserTimestamp = 1;
		const events: any[] = [];
		const stream = { push: (event: any) => events.push(event), end() {} };
		const model = { id: "claude-opus-5-5", api: "claude-code-cli", provider: "claude-code" };
		const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] };
		const turn = internals.runTurn(stream, session, model, context, {});
		try {
			await feed(session);
			await turn;
		} finally {
			session.child = undefined;
			session.close();
		}
		return events[events.length - 1];
	}
	/** Lets the provider read everything that has arrived so far. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	it("keeps one copy of an answer whose whole text and turn end arrive in one read", async () => {
		const events = answerEvents("msg_1", "The answer.");
		const done = await readTurn(async (session) => {
			// The pieces so far are read as they come; the last read holds the whole message and the turn's end together.
			for (const event of events.slice(0, 3)) session.onEvent(event);
			await settle();
			for (const event of events.slice(3)) session.onEvent(event);
		});
		expect(done.type).toBe("done");
		expect(done.message.content).toEqual([{ type: "text", text: "The answer." }]);
	});

	it("still takes the whole message as the only copy when nothing was streamed", async () => {
		const done = await readTurn((session) => {
			for (const event of answerEvents("msg_2", "Whole.").filter((event) => event.type !== "stream_event"))
				session.onEvent(event);
		});
		expect(done.message.content).toEqual([{ type: "text", text: "Whole." }]);
	});

	// The pieces `claude` writes while it streams a response.
	const piece = (event: any) => ({ type: "stream_event", event });
	const responseStart = (id: string) => piece({ type: "message_start", message: { id, usage: {} } });
	const toolStart = (index: number, id: string, name: string) =>
		piece({ type: "content_block_start", index, content_block: { type: "tool_use", id, name } });
	const toolJson = (index: number, json: string) =>
		piece({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
	const textStart = (index: number) => piece({ type: "content_block_start", index, content_block: { type: "text" } });
	const textPiece = (index: number, text: string) =>
		piece({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
	const blockStop = (index: number) => piece({ type: "content_block_stop", index });
	const responseEnd = (reason: string) => [
		piece({ type: "message_delta", delta: { stop_reason: reason }, usage: {} }),
		piece({ type: "message_stop" }),
	];
	const whole = (id: string, ...content: any[]) => ({ type: "assistant", message: { id, usage: {}, content } });
	const bashCall = (id: string, input: object = { command: "ls" }) => ({ type: "tool_use", id, name: "Bash", input });
	const turnEnd = { type: "result", subtype: "success", is_error: false };

	it("takes back what a request that broke off had begun when claude asks again", async () => {
		// 2026-11-14: the connection dropped after a tool call had started; `claude` asked again and ran the new call,
		// while the card of the dead one waited fifteen minutes for a result nobody would send.
		const done = await readTurn((session) => {
			for (const event of [
				responseStart("msg_dead"),
				textStart(0),
				textPiece(0, "Let me"),
				toolStart(1, "toolu_dead", "Bash"),
				toolJson(1, '{"comm'),
				responseStart("msg_again"),
				toolStart(0, "toolu_live", "Bash"),
				toolJson(0, '{"command":"ls"}'),
				blockStop(0),
				whole("msg_again", bashCall("toolu_live")),
				...responseEnd("tool_use"),
			])
				session.onEvent(event);
			// Nothing waits for the dead call any more; the live one is still expected.
			expect(session.takeToolResult("toolu_dead")).toBeUndefined();
			expect(session.takeToolResult("toolu_live")).toBeDefined();
		});
		expect(done).toMatchObject({ type: "done", reason: "toolUse" });
		expect(done.message.responseId).toBe("msg_again");
		expect(done.message.content.map((part: any) => part.id)).toEqual(["toolu_live"]);
		expect(done.message.content[0].arguments).toMatchObject({ tool: "Bash", input: { command: "ls" } });
	});

	it("takes it back as well when the new attempt comes whole, with nothing streamed", async () => {
		const done = await readTurn((session) => {
			for (const event of [
				responseStart("msg_dead"),
				toolStart(0, "toolu_dead", "Bash"),
				whole("msg_whole", { type: "text", text: "Here." }),
				whole("msg_whole", bashCall("toolu_live")),
			])
				session.onEvent(event);
			expect(session.takeToolResult("toolu_dead")).toBeUndefined();
		});
		expect(done).toMatchObject({ type: "done", reason: "toolUse" });
		expect(done.message.content.map((part: any) => part.id ?? part.text)).toEqual(["Here.", "toolu_live"]);
	});

	it("keeps a finished response when another one follows it in the same turn", async () => {
		const done = await readTurn((session) => {
			for (const event of [
				responseStart("msg_first"),
				textStart(0),
				textPiece(0, "One."),
				blockStop(0),
				...responseEnd("end_turn"),
				responseStart("msg_second"),
				textStart(0),
				textPiece(0, "Two."),
				blockStop(0),
				...responseEnd("end_turn"),
				turnEnd,
			])
				session.onEvent(event);
		});
		expect(done.message.content.map((part: any) => part.text)).toEqual(["One.", "Two."]);
	});

	it("ends the card of a call that has no result by the time claude asks the model again", async () => {
		let late: any;
		const done = await readTurn(async (session) => {
			for (const event of [
				responseStart("msg_round"),
				toolStart(0, "toolu_lost", "Bash"),
				toolJson(0, '{"command":"ls"}'),
				blockStop(0),
				...responseEnd("tool_use"),
			])
				session.onEvent(event);
			const waiting = session.takeToolResult("toolu_lost");
			session.onEvent(responseStart("msg_next"));
			late = await waiting;
		});
		expect(done).toMatchObject({ type: "done", reason: "toolUse" });
		expect(late).toMatchObject({ is_error: true });
	});

	it("does not end a call whose result came in time", async () => {
		let result: any;
		await readTurn(async (session) => {
			for (const event of [
				responseStart("msg_round"),
				toolStart(0, "toolu_fast", "Bash"),
				toolJson(0, '{"command":"ls"}'),
				blockStop(0),
				...responseEnd("tool_use"),
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "toolu_fast", content: "a.txt" }],
					},
				},
				responseStart("msg_next"),
			])
				session.onEvent(event);
			result = await session.takeToolResult("toolu_fast");
		});
		expect(result).toMatchObject({ tool_use_id: "toolu_fast", content: "a.txt" });
	});
});

describe("claude-code-shell stuck tools", () => {
	// A chat's own session reads its data folder (links, context length); these never touch the user's.
	let dataRoot: string;
	let previousRoot: string | undefined;
	beforeAll(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "claude-code-shell-test-"));
		previousRoot = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = dataRoot;
	});
	afterAll(() => {
		if (previousRoot === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousRoot;
		rmSync(dataRoot, { recursive: true, force: true });
	});

	const model = { id: "claude-opus-5-5", api: "claude-code-cli", provider: "claude-code" };
	const answer = (id: string, text: string) => [
		{ type: "stream_event", event: { type: "message_start", message: { id, usage: {} } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "result", subtype: "success", is_error: false },
	];

	/** A chat's session whose `claude` is a stand-in: what is written to it is kept, and starting it counts. */
	function chatSession(name: string) {
		const session: any = new internals.CliSession(`${name}-${Date.now()}`);
		const written: any[] = [];
		const child = { stdin: { write: (line: string) => written.push(JSON.parse(line)), end() {} }, exitCode: 0 };
		const state = { starts: 0 };
		session.start = async () => {
			state.starts++;
			session.child = child;
		};
		const texts = () =>
			written
				.filter((message) => message.type === "user")
				.map((message) => message.message.content.at(-1).text as string);
		const interrupts = () => written.filter((message) => message.request?.subtype === "interrupt").length;
		const end = () => {
			session.child = undefined;
			session.close();
		};
		return { session, state, texts, interrupts, end };
	}
	const collect = () => {
		const events: any[] = [];
		return { events, stream: { push: (event: any) => events.push(event), end() {} } };
	};
	const bash = (id: string, input: object) => ({
		type: "assistant",
		message: { id: `msg_${id}`, usage: {}, content: [{ type: "tool_use", id, name: "Bash", input }] },
	});
	/** Looks at the tools every 15 s, as the timer does, for the minutes from `from` to `to` after `t0`. */
	const look = (session: any, t0: number, from: number, to: number) => {
		for (let ms = from * 60_000 + 15_000; ms <= to * 60_000; ms += 15_000) session.checkOwnTools(t0 + ms);
	};

	it("takes a Bash call's own limit, claude's longest when it names none, and ten minutes for any other tool", () => {
		expect(ownToolLimit("Bash", { command: "npm test", timeout: 120_000 }, 600_000)).toBe(120_000);
		expect(ownToolLimit("Bash", { command: "npm test" }, 600_000)).toBe(600_000);
		expect(ownToolLimit("Bash", undefined, 600_000)).toBe(600_000);
		expect(ownToolLimit("Bash", { timeout: 3_600_000 }, 600_000)).toBe(600_000);
		expect(ownToolLimit("Read", { file_path: "a.txt" }, 600_000)).toBe(600_000);
		expect(ownToolLimit("Grep", {}, 1_800_000)).toBe(600_000);
	});

	it("reads a longer Bash limit from the environment and the Claude Code settings, as claude does", () => {
		const settings = join(dataRoot, "settings.json");
		writeFileSync(settings, JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "1800000" } }));
		expect(bashMaxTimeout({}, [])).toBe(600_000);
		expect(bashMaxTimeout({ BASH_DEFAULT_TIMEOUT_MS: "900000" }, [])).toBe(900_000);
		expect(bashMaxTimeout({}, [join(dataRoot, "missing.json"), settings])).toBe(1_800_000);
		expect(bashMaxTimeout({ BASH_MAX_TIMEOUT_MS: "60000" }, [])).toBe(600_000);
	});

	it("stops a request whose own tool is silent long after its limit, ends its card and goes on with the task", async () => {
		const { session, texts, interrupts, end } = chatSession("stuck");
		try {
			// A first request, so the session has its program and a turn under way.
			const first = collect();
			const context: any = { messages: [{ role: "user", content: "clean up", timestamp: 1 }], tools: [] };
			const turn = internals.runTurn(first.stream, session, model, context, {});
			await vi.waitFor(() => expect(texts()).toHaveLength(1));
			for (const event of [
				{ type: "stream_event", event: { type: "message_start", message: { id: "msg_slow", usage: {} } } },
				{
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_slow", name: "Bash" },
					},
				},
				{
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"command":"rm -rf lab","timeout":120000}' },
					},
				},
				{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
				bash("toolu_slow", { command: "rm -rf lab", timeout: 120_000 }),
				{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } },
				{ type: "stream_event", event: { type: "message_stop" } },
			])
				session.onEvent(event);
			await turn;
			expect(first.events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });

			const card = session.takeToolResult("toolu_slow");
			const t0 = Date.now();
			// Two minutes are the call's own limit and five more are allowed after it.
			look(session, t0, 0, 6.5);
			expect(session.stuck).toBe(false);
			expect(interrupts()).toBe(0);
			look(session, t0, 6.5, 8);
			expect(session.stuck).toBe(true);
			expect(interrupts()).toBe(1);
			expect(await card).toMatchObject({ is_error: true });
			expect(session.turnActive).toBe(false);

			// MyHarness asks the provider to go on with the failed card's result: the model is told what happened.
			context.messages.push(
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_slow", name: "claude_code_tool", arguments: {} }],
				},
				{
					role: "toolResult",
					toolCallId: "toolu_slow",
					content: [{ type: "text", text: "stopped" }],
					isError: true,
				},
			);
			const second = collect();
			const next = internals.runTurn(second.stream, session, model, context, {});
			await vi.waitFor(() => expect(texts()).toHaveLength(2));
			expect(texts()[1]).toContain(STUCK_TOOL_NOTE);
			expect(session.stuck).toBe(false);
			// The stopped turn's end arrives, then the answer to the note.
			session.onEvent({ type: "result", subtype: "error_during_execution", is_error: true });
			for (const event of answer("msg_after", "Checked.")) session.onEvent(event);
			await next;
			expect(second.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
			expect(second.events.at(-1).message.content).toEqual([{ type: "text", text: "Checked." }]);
		} finally {
			end();
		}
	});

	it("does not count time claude waits for a MyHarness tool or for the user, nor time the computer slept", async () => {
		const { session, interrupts, end } = chatSession("patient");
		try {
			session.child = { stdin: { write() {}, end() {} }, exitCode: 0 };
			session.turnActive = true;
			session.onEvent(bash("toolu_wait", { command: "npm test", timeout: 60_000 }));
			const t0 = Date.now();
			// `claude` runs a response's tools in order: this one may not even have started while a card is open.
			session.noteAppCall("toolu_app", "ask_user_question", { question: "?" });
			look(session, t0, 0, 30);
			expect(session.stuck).toBe(false);
			session.deliverAppResult({ toolCallId: "toolu_app", content: [{ type: "text", text: "yes" }] });
			// A permission question of claude's own is open.
			session.openPrompts = 1;
			look(session, t0, 30, 60);
			expect(session.stuck).toBe(false);
			session.openPrompts = 0;
			// The lid was closed for ten hours: one look later, almost no working time has passed.
			session.checkOwnTools(t0 + 11 * 3600_000);
			expect(session.stuck).toBe(false);
			// Any result that comes back starts the wait afresh.
			look(session, t0 + 11 * 3600_000, 0, 5);
			session.onEvent({
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "ok" }] },
			});
			look(session, t0 + 11 * 3600_000, 5, 10);
			expect(session.stuck).toBe(false);
			expect(interrupts()).toBe(0);
			// Six minutes of real silence: one for the call's limit and five after it.
			look(session, t0 + 11 * 3600_000, 10, 17);
			expect(session.stuck).toBe(true);
		} finally {
			end();
		}
	});

	it("starts claude again and sends the turn once more when it does not stop after an interrupt", async () => {
		vi.useFakeTimers();
		const { session, state, texts, end } = chatSession("restart");
		try {
			const first = collect();
			const context: any = { messages: [{ role: "user", content: "first", timestamp: 1 }], tools: [] };
			const turn = internals.runTurn(first.stream, session, model, context, {});
			await vi.advanceTimersByTimeAsync(20);
			expect(state.starts).toBe(1);
			for (const event of answer("msg_one", "One.").slice(0, 4)) session.onEvent(event);
			// Stop: the program is told to, and from here it says nothing more (it is stuck in a tool, say).
			session.interrupt();
			await vi.advanceTimersByTimeAsync(20);
			void turn;

			// The user's next message goes to that same program, behind the interrupt.
			context.messages.push(
				{ role: "assistant", content: [{ type: "text", text: "One." }], stopReason: "aborted" },
				{ role: "user", content: "second", timestamp: 2 },
			);
			const second = collect();
			const next = internals.runTurn(second.stream, session, model, context, {});
			await vi.advanceTimersByTimeAsync(20);
			expect(texts()).toEqual(["first", "second"]);
			expect(state.starts).toBe(1);

			// Ten seconds on, the program has still not stopped: it is ended. The turn is not left waiting in it.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(state.starts).toBe(2);
			expect(texts()).toEqual(["first", "second", "second"]);
			for (const event of answer("msg_two", "Two.")) session.onEvent(event);
			await vi.advanceTimersByTimeAsync(20);
			await next;
			expect(second.events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
			expect(second.events.at(-1).message.content).toEqual([{ type: "text", text: "Two." }]);
		} finally {
			end();
			vi.useRealTimers();
		}
	});
});
