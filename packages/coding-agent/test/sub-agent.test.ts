import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@myharness/ai/compat";
import { describe, expect, it } from "vitest";
import {
	buildSubAgentArgs,
	collectFinalReasoning,
	createSubAgentToolDefinition,
	evaluateExploreReportCompleteness,
	evaluateSubmittedReport,
	findSubmittedReport,
	getFinalAssistantText,
	hasSuccessfulInvestigationEvidence,
	resolvedTaskTimeoutMs,
	resolveExploreMaxTasks,
	resolveSubAgentRuntimeSettings,
	runExploreBatch,
	truncateSubAgentOutput,
} from "../src/tools/sub-agent.ts";
import { SUBMIT_REPORT_TOOL_NAME } from "../src/tools/submit-report.ts";

describe("sub agent", () => {
	it("refuses to run while disabled", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		await expect(
			tool.execute(
				"test-call",
				{ tasks: [{ description: "Inspect settings", prompt: "Find the settings implementation." }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("Sub Agent is disabled");
	});

	it("requires a configured model and thinking level", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: true }),
		});

		await expect(
			tool.execute(
				"test-call",
				{ tasks: [{ description: "Inspect settings", prompt: "Find the settings implementation." }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("model or thinking level is not configured");
	});

	it("enforces the task limit even when called directly", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false }),
		});

		// No configured cap: the default of 3 applies before the enabled check, returning batch guidance.
		const overDefault = await tool.execute(
			"test-call",
			{
				tasks: Array.from({ length: 4 }, (_, index) => ({
					description: `Task ${index + 1}`,
					prompt: "Inspect one independent area.",
				})),
			},
			undefined,
			undefined,
			undefined as any,
		);
		const overDefaultText = overDefault.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(overDefaultText).toContain("当前单次最多派发 3");
		expect(overDefaultText).toContain("收到 4");
		expect(overDefaultText).toContain("分批");
		expect(overDefault.details).toMatchObject({ completed: 0, total: 4 });

		// A configured cap of 2 returns guidance for a third task instead of throwing.
		const capped = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
				maxTasks: 2,
			}),
		});
		const overCapped = await capped.execute(
			"test-call",
			{
				tasks: Array.from({ length: 3 }, (_, index) => ({
					description: `Task ${index + 1}`,
					prompt: "Inspect one independent area.",
				})),
			},
			undefined,
			undefined,
			undefined as any,
		);
		const overCappedText = overCapped.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(overCappedText).toContain("当前单次最多派发 2");
		expect(overCappedText).toContain("收到 3");
		expect(overCapped.details).toMatchObject({ completed: 0, total: 3 });
	});

	it("clamps the task cap to the protocol range of 1 to 18", () => {
		expect(resolveExploreMaxTasks(undefined)).toBe(3);
		expect(resolveExploreMaxTasks({ maxTasks: 18 })).toBe(18);
		expect(resolveExploreMaxTasks({ maxTasks: 99 })).toBe(18);
		expect(resolveExploreMaxTasks({ maxTasks: 0 })).toBe(1);
		expect(resolveExploreMaxTasks({ maxTasks: Number.NaN })).toBe(3);
	});

	it("advertises the configured task cap in the tool name, snippet and guidelines", () => {
		const capped = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ enabled: false, maxTasks: 7 }),
		});
		expect(capped.description).toContain("Dispatch up to 7 parallel read-only scouts");
		expect(capped.promptSnippet).toContain("Dispatches up to 7 parallel read-only scouts");
		expect(capped.promptGuidelines?.some((line) => line.includes("at most 7 tasks"))).toBe(true);
		const defaulted = createSubAgentToolDefinition(process.cwd());
		expect(defaulted.description).toContain("Dispatch up to 3 parallel read-only scouts");
		expect(defaulted.promptSnippet).toContain("Dispatches up to 3 parallel read-only scouts");
	});

	it("uses no task deadline by default", () => {
		expect(resolvedTaskTimeoutMs(undefined)).toBe(0);
		expect(resolvedTaskTimeoutMs(0)).toBe(0);
		expect(resolvedTaskTimeoutMs(Number.NaN)).toBe(0);
		const settings = resolveSubAgentRuntimeSettings({ enabled: true });
		expect(settings).toMatchObject({
			taskTimeoutMs: 0,
			totalRuntimeLimitMs: 0,
			maxTurns: 0,
			stallTimeoutMs: 600_000,
			noProgressDetection: true,
			repeatedOperationDetection: true,
		});
	});

	it("caps each result before returning it to the main agent", () => {
		const output = truncateSubAgentOutput("x".repeat(30 * 1024));
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(20 * 1024);
	});

	it("starts isolated inspection child sessions without edit, write, or the agent tool", () => {
		const args = buildSubAgentArgs({
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "high",
			contextWindow: 262144,
			systemPromptPath: "explore.md",
			guardPath: "guard.js",
		});

		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-context-files");
		expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--model"))).toEqual([
			"read,grep,find,ls,bash,symbols,web_search,web_fetch,submit_report",
		]);
		expect(args).not.toContain("agent");
		expect(args).toContain("openai/gpt-test");
		expect(args).toContain("high");
		const contextWindowIndex = args.indexOf("--context-window");
		expect(args.slice(contextWindowIndex, contextWindowIndex + 2)).toEqual(["--context-window", "262144"]);
		const roleIndex = args.indexOf("--agent-role");
		expect(args.slice(roleIndex, roleIndex + 2)).toEqual(["--agent-role", "delegated"]);
		// 任务 prompt 不再通过命令行传递（改走 stdin），避免超长命令行触发 ENAMETOOLONG。
		expect(args).not.toContain("Inspect settings.");
	});

	it("executes a configured fixed model through the delegated child", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-fixed-test-"));
		const entryPath = join(tempDir, "success.mjs");
		const argsPath = join(tempDir, "child-args.json");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const successEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "package.json" },
						},
					],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "name\tpi" }],
					isError: false,
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "已完成调查" }],
					timestamp: 3,
					usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
				},
			],
		};
		try {
			await writeFile(
				entryPath,
				[
					'import { writeFileSync } from "node:fs";',
					`writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv));`,
					`process.stdout.write(${JSON.stringify(JSON.stringify(successEvent))} + "\\n");`,
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Fixed path", prompt: "Inspect the project." }],
				settings: {
					provider: "fixed-provider",
					model: "fixed-model",
					thinkingLevel: "high",
					taskTimeoutMs: 2_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "completed",
				model: "fixed-model",
				output: "已完成调查",
				tokens: 155,
				tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
			});
			const childArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
			expect(childArgs).toContain("fixed-provider/fixed-model");
			const thinkingIndex = childArgs.indexOf("--thinking");
			expect(childArgs.slice(thinkingIndex, thinkingIndex + 2)).toEqual(["--thinking", "high"]);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("requires successful read-only investigation evidence", () => {
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "1",
					toolName: "read",
					args: {},
					status: "completed",
				},
			]),
		).toBe(true);
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "2",
					toolName: "symbols",
					args: { operation: "workspace_symbols" },
					status: "completed",
				},
			]),
		).toBe(true);
		expect(
			hasSuccessfulInvestigationEvidence([
				{
					toolCallId: "1",
					toolName: "read",
					args: {},
					status: "failed",
				},
				{
					toolCallId: "2",
					toolName: "write",
					args: {},
					status: "completed",
				},
			]),
		).toBe(false);
	});

	it("times out a delegated child and returns a terminal task snapshot", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-timeout-test-"));
		const entryPath = join(tempDir, "hang.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(entryPath, "process.stdin.resume(); setInterval(() => {}, 1000);\n", "utf8");
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Hang", prompt: "Never finishes" }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					taskTimeoutMs: 50,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "timeout",
				lastToolInfo: "执行超时",
			});
			expect(result.details.results[0]?.error).toContain("timed out");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("names the real cause when the child process never emitted an event", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-silent-test-"));
		const entryPath = join(tempDir, "silent.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			const childSource = ["process.stderr.write('fixture child warning');", "process.exit(0);"].join("\n");
			await writeFile(entryPath, childSource, "utf8");
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Silent child", prompt: "Inspect nothing." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					taskTimeoutMs: 10_000,
				},
			});
			expect(result.details.results[0]).toMatchObject({
				status: "failed",
				stopReason: "runtime_error",
			});
			expect(result.details.results[0]?.error).toContain("未产生任何事件");
			expect(result.details.results[0]?.error).toContain("退出码 0");
			expect(result.details.results[0]?.error).toContain("fixture child warning");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("returns a structured partial result when max turns is reached", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-max-turns-test-"));
		const entryPath = join(tempDir, "loop.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'call-' + turn;",
					"  for (const event of [",
					"    { type: 'turn_start' },",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'file-' + turn + '.ts' } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'evidence-' + turn }] }, isError: false },",
					"    { type: 'turn_end' },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Bounded loop", prompt: "Inspect a bounded scope." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					maxTurns: 2,
					stallTimeoutMs: 0,
					taskTimeoutMs: 0,
				},
			});

			expect(result.details.results[0]).toMatchObject({
				status: "partial",
				stopReason: "max_turns_reached",
				turnCount: 2,
			});
			expect(result.details.results[0]?.evidence?.length).toBeGreaterThan(0);
			expect(result.text).toContain("partial");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("injects a steering reminder on repeated operations instead of hard-stopping", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-repeat-test-"));
		const entryPath = join(tempDir, "repeat.mjs");
		const steerPath = join(tempDir, "stdin.json");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const previousSteerFile = process.env.MYHARNESS_TEST_STEER_FILE;
		const endEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-ok", name: "read", arguments: { path: "package.json" } }],
					timestamp: 10,
				},
				{
					role: "toolResult",
					toolCallId: "call-ok",
					toolName: "read",
					content: [{ type: "text", text: "name: myharness" }],
					isError: false,
					timestamp: 11,
				},
				{ role: "assistant", content: [{ type: "text", text: "已整理证据并输出报告" }], timestamp: 12 },
			],
		};
		try {
			process.env.MYHARNESS_TEST_STEER_FILE = steerPath;
			await writeFile(
				entryPath,
				[
					'import { createInterface } from "node:readline";',
					'import { writeFileSync } from "node:fs";',
					'const steerFile = process.env.MYHARNESS_TEST_STEER_FILE || "";',
					"const received = [];",
					`const endEvent = ${JSON.stringify(endEvent)};`,
					"let finished = false;",
					"function finish() {",
					"  if (finished) return;",
					"  finished = true;",
					"  if (steerFile) writeFileSync(steerFile, JSON.stringify(received));",
					"  console.log(JSON.stringify(endEvent));",
					"  process.exit(0);",
					"}",
					"const rl = createInterface({ input: process.stdin });",
					'rl.on("line", (line) => {',
					"  let input;",
					"  try { input = JSON.parse(line); } catch { return; }",
					"  received.push(input);",
					'  if (input.type === "steer") finish();',
					"});",
					"setTimeout(finish, 4000);",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'call-' + turn;",
					"  for (const event of [",
					"    { type: 'turn_start' },",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'same.ts' } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'same evidence' }] }, isError: false },",
					"    { type: 'turn_end' },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Repeated read", prompt: "Inspect one file." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					stallTimeoutMs: 0,
					taskTimeoutMs: 15_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "completed", stopReason: "completed" });
			expect(result.details.results[0]?.diagnostics?.repeatedOperations).toBeGreaterThanOrEqual(2);
			expect(result.details.results[0]?.evidence).toContain("Read(same.ts)：已读取 1 行");
			const received = JSON.parse(await readFile(steerPath, "utf8")) as Array<{ type: string; text: string }>;
			expect(received[0]).toMatchObject({ type: "prompt" });
			expect(received.some((entry) => entry.type === "steer" && entry.text.includes("收敛提醒"))).toBe(true);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			if (previousSteerFile === undefined) delete process.env.MYHARNESS_TEST_STEER_FILE;
			else process.env.MYHARNESS_TEST_STEER_FILE = previousSteerFile;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses stall time rather than total runtime and keeps evidence", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-stall-test-"));
		const entryPath = join(tempDir, "stall.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		try {
			await writeFile(
				entryPath,
				[
					"process.stdin.resume();",
					"for (const event of [",
					"  { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'evidence.ts' } },",
					"  { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: 'one useful line' }] }, isError: false },",
					"]) console.log(JSON.stringify(event));",
					"setInterval(() => {}, 1000);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Stall", prompt: "Inspect evidence.ts." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					taskTimeoutMs: 0,
					// Allow the child process to start and flush its first event on slower
					// Windows runners before measuring the intentional stall.
					stallTimeoutMs: 1_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "partial", stopReason: "stalled" });
			expect(result.details.results[0]?.evidence).toContain("Read(evidence.ts)：已读取 1 行");
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reminds on consecutive tool failures without hard-stopping by count", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-errors-test-"));
		const entryPath = join(tempDir, "errors.mjs");
		const steerPath = join(tempDir, "stdin.json");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const previousSteerFile = process.env.MYHARNESS_TEST_STEER_FILE;
		const endEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-ok", name: "read", arguments: { path: "README.md" } }],
					timestamp: 10,
				},
				{
					role: "toolResult",
					toolCallId: "call-ok",
					toolName: "read",
					content: [{ type: "text", text: "readme line" }],
					isError: false,
					timestamp: 11,
				},
				{ role: "assistant", content: [{ type: "text", text: "已改用其他工具完成调查" }], timestamp: 12 },
			],
		};
		try {
			process.env.MYHARNESS_TEST_STEER_FILE = steerPath;
			await writeFile(
				entryPath,
				[
					'import { createInterface } from "node:readline";',
					'import { writeFileSync } from "node:fs";',
					'const steerFile = process.env.MYHARNESS_TEST_STEER_FILE || "";',
					"const received = [];",
					`const endEvent = ${JSON.stringify(endEvent)};`,
					"let finished = false;",
					"function finish() {",
					"  if (finished) return;",
					"  finished = true;",
					"  if (steerFile) writeFileSync(steerFile, JSON.stringify(received));",
					"  console.log(JSON.stringify(endEvent));",
					"  process.exit(0);",
					"}",
					"const rl = createInterface({ input: process.stdin });",
					'rl.on("line", (line) => {',
					"  let input;",
					"  try { input = JSON.parse(line); } catch { return; }",
					"  received.push(input);",
					'  if (input.type === "steer") finish();',
					"});",
					"setTimeout(finish, 4000);",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  const id = 'error-' + turn;",
					"  for (const event of [",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'grep', args: { pattern: 'missing-' + turn } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'grep', result: { content: [{ type: 'text', text: 'not found' }] }, isError: true },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Tool errors", prompt: "Find the missing symbol." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					stallTimeoutMs: 0,
					taskTimeoutMs: 15_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "completed", stopReason: "completed" });
			expect(result.details.results[0]?.diagnostics?.consecutiveToolErrors).toBeGreaterThanOrEqual(3);
			const received = JSON.parse(await readFile(steerPath, "utf8")) as Array<{ type: string; text: string }>;
			expect(received.some((entry) => entry.type === "steer" && entry.text.includes("次调查工具调用失败"))).toBe(
				true,
			);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			if (previousSteerFile === undefined) delete process.env.MYHARNESS_TEST_STEER_FILE;
			else process.env.MYHARNESS_TEST_STEER_FILE = previousSteerFile;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count read-only guard blocks as consecutive tool failures", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-guardblock-test-"));
		const entryPath = join(tempDir, "guardblocks.mjs");
		const steerPath = join(tempDir, "stdin.json");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const previousSteerFile = process.env.MYHARNESS_TEST_STEER_FILE;
		const endEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-ok", name: "grep", arguments: { pattern: "guard" } }],
					timestamp: 10,
				},
				{
					role: "toolResult",
					toolCallId: "call-ok",
					toolName: "grep",
					content: [{ type: "text", text: "match line" }],
					isError: false,
					timestamp: 11,
				},
				{ role: "assistant", content: [{ type: "text", text: "已改用 grep 完成调查" }], timestamp: 12 },
			],
		};
		try {
			process.env.MYHARNESS_TEST_STEER_FILE = steerPath;
			await writeFile(
				entryPath,
				[
					'import { createInterface } from "node:readline";',
					'import { writeFileSync } from "node:fs";',
					'const steerFile = process.env.MYHARNESS_TEST_STEER_FILE || "";',
					"const received = [];",
					`const endEvent = ${JSON.stringify(endEvent)};`,
					"let finished = false;",
					"function finish() {",
					"  if (finished) return;",
					"  finished = true;",
					"  if (steerFile) writeFileSync(steerFile, JSON.stringify(received));",
					"  console.log(JSON.stringify(endEvent));",
					"  process.exit(0);",
					"}",
					"const rl = createInterface({ input: process.stdin });",
					'rl.on("line", (line) => {',
					"  let input;",
					"  try { input = JSON.parse(line); } catch { return; }",
					"  received.push(input);",
					"});",
					"let turn = 0;",
					"setInterval(() => {",
					"  turn += 1;",
					"  if (turn > 6) { finish(); return; }",
					"  const id = 'blocked-' + turn;",
					"  const reason = '[read-only-guard] Sub Agent 已拦截命中的修改型 Bash 命令。原因：命令段不是允许的只读检查命令：rm' + turn;",
					"  for (const event of [",
					"    { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'rm x' + turn } },",
					"    { type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [{ type: 'text', text: reason }] }, isError: true },",
					"  ]) console.log(JSON.stringify(event));",
					"}, 5);",
				].join("\n"),
				"utf8",
			);
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			const result = await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Guard blocks", prompt: "Inspect the repository." }],
				settings: {
					provider: "test",
					model: "test",
					thinkingLevel: "high",
					stallTimeoutMs: 0,
					taskTimeoutMs: 15_000,
				},
			});

			expect(result.details.results[0]).toMatchObject({ status: "completed", stopReason: "completed" });
			expect(result.details.results[0]?.diagnostics?.consecutiveToolErrors).toBe(0);
			const received = JSON.parse(await readFile(steerPath, "utf8")) as Array<{ type: string; text: string }>;
			expect(received.some((entry) => entry.type === "steer" && entry.text.includes("工具调用失败"))).toBe(false);
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			if (previousSteerFile === undefined) delete process.env.MYHARNESS_TEST_STEER_FILE;
			else process.env.MYHARNESS_TEST_STEER_FILE = previousSteerFile;
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts background execution while retaining the same task cap", () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
			}),
		});
		expect(tool.parameters.properties).toHaveProperty("run_in_background");
		expect((tool.parameters.properties.tasks as unknown as { maxItems: number }).maxItems).toBe(3);
	});

	describe("report completeness evaluation", () => {
		it("only checks reports of tasks that declare questions", () => {
			expect(evaluateExploreReportCompleteness(undefined, "any report").complete).toBe(true);
			expect(evaluateExploreReportCompleteness([], "any report").complete).toBe(true);
		});

		it("treats a missing checklist as unconfirmed", () => {
			const verdict = evaluateExploreReportCompleteness(["Does X exist?", "Where is Y?"], "X exists in src/a.ts.");
			expect(verdict.complete).toBe(false);
			expect(verdict.unanswered).toEqual(["Does X exist?", "Where is Y?"]);
			expect(verdict.note).toContain("Completion checklist");
		});

		it("honors a clean self-declared checklist", () => {
			const report = "## Completion checklist\n- answered: 2\n- unanswered: none";
			expect(evaluateExploreReportCompleteness(["Does X exist?", "Where is Y?"], report).complete).toBe(true);
			const zh = "## Completion checklist\n- answered: 2\n- unanswered: 无";
			expect(evaluateExploreReportCompleteness(["Does X exist?", "Where is Y?"], zh).complete).toBe(true);
		});

		it("keeps declared unanswered questions visible", () => {
			const report = "## Completion checklist\n- answered: 1\n- unanswered: Where is Y?; 谁调用了 Z";
			const verdict = evaluateExploreReportCompleteness(["Does X exist?", "Where is Y?", "谁调用了 Z"], report);
			expect(verdict.complete).toBe(false);
			expect(verdict.unanswered).toEqual(["Where is Y?", "谁调用了 Z"]);
			expect(verdict.note).toContain("未回答");
		});
	});

	async function runReportWithChecklist(finalText: string, questions: string[]) {
		const tempDir = await mkdtemp(join(tmpdir(), "myharness-sub-agent-checklist-test-"));
		const entryPath = join(tempDir, "report.mjs");
		const previousEntry = process.env.MYHARNESS_CLI_ENTRY;
		const endEvent = {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "name: myharness" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "assistant", content: [{ type: "text", text: finalText }], timestamp: 3 },
			],
		};
		try {
			await writeFile(entryPath, [`console.log(${JSON.stringify(JSON.stringify(endEvent))});`].join("\n"), "utf8");
			process.env.MYHARNESS_CLI_ENTRY = entryPath;
			return await runExploreBatch({
				cwd: tempDir,
				tasks: [{ description: "Checklist task", prompt: "Inspect the project.", questions }],
				settings: { provider: "test", model: "test", thinkingLevel: "high", taskTimeoutMs: 15_000 },
			});
		} finally {
			if (previousEntry === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
			else process.env.MYHARNESS_CLI_ENTRY = previousEntry;
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	it("downgrades a question task whose report lacks the checklist", async () => {
		const result = await runReportWithChecklist("调查完毕，未提供清单。", ["Does the guard allow pipes?"]);
		const taskResult = result.details.results[0];
		expect(taskResult).toMatchObject({ status: "partial", stopReason: "report_not_submitted" });
		expect(taskResult?.reportSubmission).toBe("text");
		expect(taskResult?.output).toContain("调查完毕，未提供清单。");
		expect(taskResult?.output).toContain("[自动检查]");
		expect(taskResult?.unresolved).toContain("问题未逐项回答：Does the guard allow pipes?");
	});

	it("keeps a question task completed when the checklist declares everything answered", async () => {
		const report = "管道与 ; 都是允许的。\n\n## Completion checklist\n- answered: 1\n- unanswered: none";
		const result = await runReportWithChecklist(report, ["Does the guard allow pipes?"]);
		expect(result.details.results[0]).toMatchObject({ status: "completed", stopReason: "completed" });
	});

	it("marks declared unanswered questions as partial with visible items", async () => {
		const report = "第一个问题已回答。\n\n## Completion checklist\n- answered: 1\n- unanswered: Where is Y?";
		const result = await runReportWithChecklist(report, ["Does the guard allow pipes?", "Where is Y?"]);
		const taskResult = result.details.results[0];
		expect(taskResult).toMatchObject({ status: "partial", stopReason: "incomplete_answer" });
		expect(taskResult?.unresolved).toContain("问题未逐项回答：Where is Y?");
	});
});

function testAssistant(timestamp: number, content: unknown[], extra: Record<string, unknown> = {}): Message {
	return { role: "assistant", content, timestamp, ...extra } as unknown as Message;
}

function testToolResult(timestamp: number, callId: string, toolName: string, isError = false): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp,
	} as unknown as Message;
}

describe("evaluateSubmittedReport", () => {
	const questions = ["守卫在哪？", "测试在哪？"];

	it("marks every question answered as complete", () => {
		const verdict = evaluateSubmittedReport(questions, [
			{ question: "守卫在哪？", status: "answered" },
			{ question: "测试在哪？", status: "answered" },
		]);
		expect(verdict.outcome).toBe("complete");
		expect(verdict.dataGaps).toEqual([]);
		expect(verdict.unfinished).toEqual([]);
	});

	it("reports data gaps for unavailable questions and stays complete otherwise", () => {
		const verdict = evaluateSubmittedReport(questions, [
			{ question: "守卫在哪？", status: "answered" },
			{ question: "测试在哪？", status: "unavailable", note: "登录墙挡住了" },
		]);
		expect(verdict.outcome).toBe("data_gaps");
		expect(verdict.dataGaps).toEqual(["测试在哪？：登录墙挡住了"]);
		expect(verdict.unfinished).toEqual([]);
	});

	it("reports a task incomplete when a question is partial or not done", () => {
		for (const status of ["partial", "not_done"] as const) {
			const verdict = evaluateSubmittedReport(questions, [
				{ question: "守卫在哪？", status: "answered" },
				{ question: "测试在哪？", status, note: "说明" },
			]);
			expect(verdict.outcome).toBe("incomplete");
			expect(verdict.unfinished).toEqual([`测试在哪？：说明`]);
		}
	});

	it("lines the statuses up with the task questions by position when the counts match", () => {
		const verdict = evaluateSubmittedReport(questions, [
			{ question: "q1 的意思？", status: "answered" },
			{ question: "q2 的意思？", status: "answered" },
		]);
		expect(verdict.statuses.map((entry) => entry.question)).toEqual(questions);
		expect(verdict.statuses[0].status).toBe("answered");
		expect(verdict.statuses[1].status).toBe("answered");
	});

	it("lines the statuses up by text when the counts differ", () => {
		const verdict = evaluateSubmittedReport(questions, [
			{ question: "测试在哪？", status: "unavailable", note: "找不到" },
		]);
		expect(verdict.statuses[0]).toEqual({
			question: "守卫在哪？",
			status: "not_done",
			note: "提交的报告没有给出这个问题的状态",
		});
		expect(verdict.statuses[1]).toMatchObject({ question: "测试在哪？", status: "unavailable", note: "找不到" });
		expect(verdict.outcome).toBe("incomplete");
	});

	it("counts a question the submission does not cover as not_done", () => {
		const verdict = evaluateSubmittedReport(
			["A", "B", "C"],
			[
				{ question: "a", status: "answered" },
				{ question: "c", status: "answered" },
			],
		);
		expect(verdict.statuses.map((entry) => entry.question)).toEqual(["A", "B", "C"]);
		expect(verdict.statuses[1]).toEqual({
			question: "B",
			status: "not_done",
			note: "提交的报告没有给出这个问题的状态",
		});
		expect(verdict.outcome).toBe("incomplete");
	});

	it("keeps the handed-in statuses unchanged for a task without Questions", () => {
		const submitted = [{ question: "q", status: "answered" as const }];
		expect(evaluateSubmittedReport(undefined, submitted).statuses).toEqual(submitted);
		expect(evaluateSubmittedReport([], submitted).outcome).toBe("complete");
	});

	it("normalizes question text when matching by key", () => {
		const verdict = evaluateSubmittedReport(
			["Where is the guard (path)?"],
			[{ question: "where is the guard path", status: "answered" }],
		);
		expect(verdict.outcome).toBe("complete");
		expect(verdict.statuses[0].question).toBe("Where is the guard (path)?");
	});
});

describe("findSubmittedReport", () => {
	function submitCall(timestamp: number, callId: string, args: Record<string, unknown>): Message {
		return testAssistant(timestamp, [
			{ type: "text", text: "交报告。" },
			{ type: "toolCall", id: callId, name: SUBMIT_REPORT_TOOL_NAME, arguments: args },
		]);
	}

	it("reads the accepted call arguments by toolCallId", () => {
		const report = "# 报告\n## Completion checklist\n- answered: 1\n- unanswered: none";
		const questions = [{ question: "守卫在哪？", status: "answered" }];
		const messages = [
			submitCall(1, "call-a", { report, questions }),
			testToolResult(2, "call-a", SUBMIT_REPORT_TOOL_NAME),
		];
		const found = findSubmittedReport(messages);
		expect(found).toBeDefined();
		expect(found?.report).toBe(report);
		expect(found?.questions).toEqual(questions);
		expect(found?.messageText).toBe("交报告。");
	});

	it("ignores a failed submit_report call and reads the accepted one", () => {
		const messages = [
			submitCall(1, "call-bad", { report: "缺条目的报告", questions: [{ question: "q", status: "wrong" }] }),
			testToolResult(2, "call-bad", SUBMIT_REPORT_TOOL_NAME, true),
			submitCall(3, "call-good", { report: "好的报告", questions: [{ question: "q", status: "answered" }] }),
			testToolResult(4, "call-good", SUBMIT_REPORT_TOOL_NAME),
		];
		expect(findSubmittedReport(messages)?.report).toBe("好的报告");
	});

	it("returns undefined when every submit_report call failed", () => {
		const messages = [
			submitCall(1, "call-bad", { report: "x", questions: [] }),
			testToolResult(2, "call-bad", SUBMIT_REPORT_TOOL_NAME, true),
		];
		expect(findSubmittedReport(messages)).toBeUndefined();
	});

	it("returns undefined without any submit_report call", () => {
		expect(findSubmittedReport([testAssistant(1, [{ type: "text", text: "正文" }])])).toBeUndefined();
	});

	it("prefers the last accepted submission", () => {
		const messages = [
			submitCall(1, "call-1", { report: "第一版", questions: [] }),
			testToolResult(2, "call-1", SUBMIT_REPORT_TOOL_NAME),
			submitCall(3, "call-2", { report: "第二版", questions: [] }),
			testToolResult(4, "call-2", SUBMIT_REPORT_TOOL_NAME),
		];
		expect(findSubmittedReport(messages)?.report).toBe("第二版");
	});

	it("keeps entries with known statuses when the stored arguments are incomplete", () => {
		const messages = [
			submitCall(1, "call-1", {
				report: "报告",
				questions: [
					{ question: "q1", status: "answered", note: "x" },
					{ question: "q2", status: "未来状态" },
				],
			}),
			testToolResult(2, "call-1", SUBMIT_REPORT_TOOL_NAME),
		];
		const found = findSubmittedReport(messages);
		expect(found?.questions).toEqual([{ question: "q1", status: "answered", note: "x" }]);
	});
});

describe("evaluateExploreReportCompleteness: free-text fallback leniency", () => {
	const questions = ["Q1", "Q2"];

	it("accepts `unanswered: none` with a remark in parentheses", () => {
		for (const line of [
			"- unanswered: none（均已回答）",
			"unanswered: none (all four answered above)",
			"- unanswered: 无（见上文说明）",
		]) {
			const verdict = evaluateExploreReportCompleteness(questions, `正文\n\n## Completion checklist\n${line}`);
			expect(verdict, line).toMatchObject({ complete: true, unanswered: [], checklistFound: true });
		}
	});

	it("accepts the Chinese `未回答：无` wording", () => {
		const verdict = evaluateExploreReportCompleteness(questions, "结论。\n\n未回答：无");
		expect(verdict).toMatchObject({ complete: true, unanswered: [], checklistFound: true });
	});

	it("accepts the bold `**Unanswered questions: None.**` wording", () => {
		const verdict = evaluateExploreReportCompleteness(questions, "结论。\n**Unanswered questions: None.**");
		expect(verdict).toMatchObject({ complete: true, unanswered: [], checklistFound: true });
	});

	it("still lists declared real unanswered items", () => {
		const verdict = evaluateExploreReportCompleteness(
			questions,
			"结论。\n- unanswered: 未能确认 provider 版本；缺少 usage 日志",
		);
		expect(verdict.complete).toBe(false);
		expect(verdict.checklistFound).toBe(true);
		expect(verdict.unanswered).toEqual(["未能确认 provider 版本", "缺少 usage 日志"]);
		expect(verdict.note).toContain("未回答");
	});

	it("marks a report without any checklist as not complete", () => {
		const verdict = evaluateExploreReportCompleteness(questions, "只有正文。");
		expect(verdict).toMatchObject({ complete: false, checklistFound: false });
		expect(verdict.unanswered).toEqual(questions);
	});

	it("is complete without questions", () => {
		expect(evaluateExploreReportCompleteness(undefined, "正文")).toMatchObject({
			complete: true,
			checklistFound: true,
		});
	});
});

describe("getFinalAssistantText: truncated reply continuation", () => {
	it("joins a reply cut off by the output limit with the following continuation", () => {
		const first = testAssistant(1, [{ type: "text", text: "报告第一段" }], { stopReason: "length" });
		const second = testAssistant(2, [{ type: "text", text: "报告第二段" }], { stopReason: "stop" });
		expect(getFinalAssistantText([first, second])).toBe("报告第一段报告第二段");
	});

	it("joins several continuations into one report", () => {
		const messages = [
			testAssistant(1, [{ type: "text", text: "A" }], { stopReason: "length" }),
			testAssistant(2, [{ type: "text", text: "B" }], { stopReason: "length" }),
			testAssistant(3, [{ type: "text", text: "C" }], { stopReason: "stop" }),
		];
		expect(getFinalAssistantText(messages)).toBe("ABC");
	});

	it("stops joining at a reply that carries a tool call", () => {
		const messages = [
			testAssistant(1, [{ type: "text", text: "第一段" }], { stopReason: "length" }),
			testAssistant(
				2,
				[
					{ type: "text", text: "备注。" },
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
				],
				{ stopReason: "length" },
			),
			testAssistant(3, [{ type: "text", text: "最终报告" }]),
		];
		expect(getFinalAssistantText(messages)).toBe("最终报告");
	});

	it("does not join when the cut-off reply carries no text", () => {
		const messages = [
			testAssistant(1, [], { stopReason: "length" }),
			testAssistant(2, [{ type: "text", text: "报告" }]),
		];
		expect(getFinalAssistantText(messages)).toBe("报告");
	});
});

describe("collectFinalReasoning", () => {
	const toolResult = testToolResult(2, "r1", "read");

	it("keeps only the thinking produced after the last tool result", () => {
		const messages = [
			testAssistant(1, [{ type: "thinking", thinking: "调查中的想法。" }]),
			toolResult,
			testAssistant(3, [{ type: "thinking", thinking: "报告还没写。" }]),
			testAssistant(4, [{ type: "thinking", thinking: "要收尾了。" }]),
		];
		const reasoning = collectFinalReasoning(messages);
		expect(reasoning).toContain("报告还没写。");
		expect(reasoning).toContain("要收尾了。");
		expect(reasoning).not.toContain("调查中的想法。");
		expect(reasoning).toContain("---");
	});

	it("stops at the last tool result even when an earlier turn had thinking", () => {
		const messages = [
			testAssistant(1, [{ type: "thinking", thinking: "早的想法。" }]),
			toolResult,
			testAssistant(3, [{ type: "text", text: "没有思考只有正文。" }]),
		];
		expect(collectFinalReasoning(messages)).toBe("");
	});

	it("skips redacted thinking parts", () => {
		const messages = [
			testAssistant(1, [
				{ type: "thinking", redacted: true, encrypted_content: "secret" },
				{ type: "thinking", thinking: "可见的想法。" },
			]),
		];
		const reasoning = collectFinalReasoning(messages);
		expect(reasoning).toBe("可见的想法。");
		expect(reasoning).not.toContain("secret");
	});

	it("keeps the tail of the reasoning when it is over the byte cap", () => {
		const head = Array.from({ length: 30 }, (_value, index) => `开头第${index + 1}段思考。`).join("");
		const tail = "结尾最接近报告的想法。";
		const messages = [testAssistant(1, [{ type: "thinking", thinking: `${head}\n${tail}` }])];
		const reasoning = collectFinalReasoning(messages, 64);
		expect(reasoning).toContain("[前面部分已省略]");
		expect(reasoning.endsWith(tail)).toBe(true);
		// Only the final segments survive the cap.
		expect(reasoning).not.toContain("开头第1段");
		expect(reasoning).toContain("开头第30段");
		// The tail never cuts inside a UTF-8 codepoint.
		expect(reasoning).not.toContain("\uFFFD");
	});

	it("returns the whole reasoning when it fits the cap", () => {
		const messages = [testAssistant(1, [{ type: "thinking", thinking: "短的想法。" }])];
		expect(collectFinalReasoning(messages, 4096)).toBe("短的想法。");
	});
});
