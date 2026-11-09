import { describe, expect, it } from "vitest";
import {
	earlierBlocks,
	FLAG_SETTINGS,
	hashKeys,
	initializeRequest,
	isTransient,
	keyedMessages,
	LAUNCH_ENV,
	launchArgs,
	launchEnv,
	limitsFromEvent,
	limitsFromUsage,
	limitsNeedQuery,
	limitsText,
	MCP_SERVER,
	mergeLimits,
	messageKey,
	outputLimitFor,
	outputLimitNote,
	STRIPPED_ENV,
	startsWith,
	toolList,
	turnContent,
} from "../examples/extensions/claude-code-shell.ts";

const user = (text: string, timestamp = 1000, images: string[] = []) => ({
	role: "user",
	content: [{ type: "text", text }, ...images.map((data) => ({ type: "image", data, mimeType: "image/png" }))],
	timestamp,
});
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	timestamp: 2000,
	...extra,
});
const toolResult = (toolCallId: string, text: string) => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 3000,
});

describe("claude-code-shell launch", () => {
	it("starts claude with none of its own tools, settings, MCP servers or slash commands", () => {
		const args = launchArgs({ model: "claude-haiku-5-5", persist: true });
		const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
		expect(args.slice(0, 7)).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
		]);
		expect(flagValue("--model")).toBe("claude-haiku-5-5");
		expect(flagValue("--tools")).toBe("");
		expect(flagValue("--setting-sources")).toBe("");
		expect(JSON.parse(flagValue("--settings"))).toEqual(FLAG_SETTINGS);
		expect(FLAG_SETTINGS).toEqual({ autoCompactEnabled: false, disableAllHooks: true });
		for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-chrome"])
			expect(args).toContain(flag);
		expect(flagValue("--permission-prompt-tool")).toBe("stdio");
		for (const flag of [
			"--effort",
			"--resume",
			"--resume-session-at",
			"--fork-session",
			"--no-session-persistence",
		]) {
			expect(args).not.toContain(flag);
		}
	});

	it("resumes a chat at its last clean turn, forks it for a side request, and keeps nothing of a one-off", () => {
		const resumed = launchArgs({ model: "m", effort: "high", resume: { id: "c1", at: "u9" }, persist: true });
		expect(resumed.slice(-6)).toEqual(["--effort", "high", "--resume", "c1", "--resume-session-at", "u9"]);

		const fork = launchArgs({ model: "m", resume: { id: "c1", at: "u9" }, fork: true, persist: false });
		expect(fork.slice(-6)).toEqual([
			"--resume",
			"c1",
			"--resume-session-at",
			"u9",
			"--fork-session",
			"--no-session-persistence",
		]);

		const oneOff = launchArgs({ model: "m", fork: true, persist: false });
		expect(oneOff.at(-1)).toBe("--no-session-persistence");
		expect(oneOff).not.toContain("--resume");
		expect(oneOff).not.toContain("--fork-session");
	});

	it("switches off every part of Claude Code that adds its own instructions, keeps the login, and leaves the base alone", () => {
		const base: NodeJS.ProcessEnv = {
			PATH: "p",
			ANTHROPIC_API_KEY: "k",
			ANTHROPIC_BASE_URL: "u",
			CLAUDE_CODE_SIMPLE: "1",
		};
		for (const name of STRIPPED_ENV) base[name] ??= "x";
		const env = launchEnv(base, false);
		for (const name of STRIPPED_ENV) expect(env[name]).toBeUndefined();
		expect(env.PATH).toBe("p");
		expect(base.ANTHROPIC_API_KEY).toBe("k");
		for (const [name, value] of Object.entries(LAUNCH_ENV)) expect(env[name]).toBe(value);
		expect(LAUNCH_ENV).toMatchObject({
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
			CLAUDE_CODE_SAFE_MODE: "1",
			CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
			CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
			CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1",
			ENABLE_CLAUDEAI_MCP_SERVERS: "false",
			ENABLE_TOOL_SEARCH: "false",
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
		});
		// A chat keeps the subscription's hour of cache; a request no other request shares writes the cheaper 5 minutes.
		expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
		expect(launchEnv(base, true).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
	});

	it("caps a request's output at MyHarness's limit for the model, over one claude may have inherited", () => {
		expect(outputLimitFor({ maxTokens: 64_000 })).toBe(64_000);
		expect(outputLimitFor({ maxTokens: 0 })).toBeUndefined();
		expect(outputLimitFor({})).toBeUndefined();
		const base: NodeJS.ProcessEnv = { PATH: "p", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000" };
		expect(launchEnv(base, false, 64_000).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
		expect(launchEnv(base, true, 64_000).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
		// Without a limit of MyHarness's, claude's own applies.
		expect(launchEnv({ PATH: "p" }, false).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
	});

	it("sends a task on after a cut-off response: briefer when it only thought, from where it stopped when it wrote", () => {
		const thoughtOnly = { role: "assistant", content: [{ type: "thinking", thinking: "" }], stopReason: "length" };
		const wroteText = {
			...thoughtOnly,
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "Part one" },
			],
		};
		expect(outputLimitNote(thoughtOnly)).toContain("think much more briefly");
		expect(outputLimitNote(wroteText)).toContain("Go on from where it stopped");
		expect(outputLimitNote({ ...thoughtOnly, content: [{ type: "text", text: "  " }] })).toContain("still thinking");
	});

	it("gives claude MyHarness's system prompt, rendered fresh, and MyHarness's MCP server only when there are tools", () => {
		expect(initializeRequest("MH PROMPT", true)).toEqual({
			subtype: "initialize",
			systemPrompt: ["MH PROMPT"],
			systemPromptSnapshot: false,
			sdkMcpServers: [MCP_SERVER],
			sdkMcpServerConfigs: { [MCP_SERVER]: { timeout: 24 * 3600_000 } },
		});
		expect(initializeRequest("MH PROMPT", false)).toEqual({
			subtype: "initialize",
			systemPrompt: ["MH PROMPT"],
			systemPromptSnapshot: false,
		});
	});

	it("lists MyHarness's tools under their own names, as copies", () => {
		const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
		const listed = toolList([{ name: "read", description: "Read a file", parameters }, { name: "todo_write" }]);
		expect(listed).toEqual([
			{ name: "read", description: "Read a file", inputSchema: parameters },
			{ name: "todo_write", description: "", inputSchema: { type: "object", properties: {} } },
		]);
		listed[0].inputSchema.required.push("changed");
		expect(parameters.required).toEqual(["path"]);
	});
});

describe("claude-code-shell record matching", () => {
	it("keys what the model reads: a message rebuilt from the session file with another timestamp keeps its key", () => {
		// MyHarness stamps its local-time note when making it and again when writing it down.
		expect(messageKey(user("[system-reminder] The current local time is …", 1794138024387))).toBe(
			messageKey(user("[system-reminder] The current local time is …", 1794138024404)),
		);
		expect(messageKey(user("a"))).not.toBe(messageKey(user("b")));
		expect(messageKey(user("a", 1000, ["xx"]))).not.toBe(messageKey(user("a", 1000, ["xxxx"])));
		expect(messageKey(assistant("hi", { responseId: "msg_1" }))).toBe("a:msg_1");
		expect(messageKey(assistant("hi"))).toBe(messageKey(assistant("hi")));
		expect(messageKey(toolResult("toolu_1", "out"))).toBe("t:toolu_1");
	});

	it("leaves out what providers leave out of a request: the transient reminder, failed and stopped answers", () => {
		const reminder = user("[system-reminder] Dynamic session context", 0);
		expect(isTransient(reminder)).toBe(true);
		expect(messageKey(reminder)).toBeUndefined();
		expect(messageKey(assistant("", { stopReason: "aborted" }))).toBeUndefined();
		expect(messageKey(assistant("boom", { stopReason: "error", responseId: "msg_2" }))).toBeUndefined();
		const keyed = keyedMessages([reminder, user("one"), assistant("", { stopReason: "aborted" }), user("two")]);
		expect(keyed.map((item) => item.message.content[0].text)).toEqual(["one", "two"]);
	});

	it("goes on only while the record starts with exactly what claude holds", () => {
		const keyed = keyedMessages([user("one"), assistant("ok", { responseId: "msg_1" }), user("two")]);
		const held = keyed.slice(0, 2).map((item) => item.key);
		expect(startsWith(keyed, held)).toBe(true);
		expect(startsWith(keyed, [])).toBe(true);
		expect(startsWith(keyed.slice(0, 1), held)).toBe(false);
		expect(startsWith(keyedMessages([user("one"), assistant("other", { responseId: "msg_9" })]), held)).toBe(false);
		expect(hashKeys(held)).toBe(hashKeys([...held]));
		expect(hashKeys(held)).not.toBe(hashKeys(held.slice(0, 1)));
	});
});

describe("claude-code-shell what is sent", () => {
	it("sends a new user message as it is", () => {
		expect(turnContent([user("hello")])).toEqual([{ type: "text", text: "hello" }]);
		expect(turnContent([user("look", 1000, ["AAAA"])])).toEqual([
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("gives a conversation that starts anew the earlier messages as text, then the new message", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } }],
			stopReason: "toolUse",
			timestamp: 2000,
		};
		const content = turnContent([
			user("first"),
			call,
			toolResult("toolu_1", "file text"),
			assistant("done"),
			user("next"),
		]);
		expect(content).toHaveLength(2);
		expect(content[0].text).toBe(
			'<earlier-conversation>\nMessages of this chat that were not part of this conversation, oldest first:\n\nuser: first\n\nassistant: [called read {"path":"a.txt"}]\n\ntool result (read): file text\n\nassistant: done\n</earlier-conversation>',
		);
		expect(content[1]).toEqual({ type: "text", text: "next" });
	});

	it("asks claude to go on when no new user message came (a turn resumed between two tool rounds)", () => {
		const content = turnContent([assistant("working"), toolResult("toolu_1", "out")]);
		expect(content.at(-1)).toEqual({ type: "text", text: "Continue where you left off." });
		expect(content[0].text).toContain("tool result (read): out");
	});

	it("drops only the oldest messages when the earlier conversation is too long", () => {
		const big = "x".repeat(300_000);
		const blocks = earlierBlocks([user(`a${big}`), user(`b${big}`), user(`c${big}`), user(`d${big}`)]);
		expect(blocks[0].text).toContain("(2 older messages are not included.)");
		expect(blocks[0].text).toContain("user: c");
		expect(blocks[0].text).toContain("user: d");
		expect(blocks[0].text).not.toContain("user: b");
		expect(earlierBlocks([])).toEqual([]);
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
		// The shape `claude` 2.1.317 answered get_usage with, other fields left out.
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
