import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendedPrompt,
	appendPromptFor,
	CUT_CALLS_NOTE,
	callSummary,
	ENTRYPOINT,
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
	ownToolsFor,
	STRIPPED_ENV,
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
