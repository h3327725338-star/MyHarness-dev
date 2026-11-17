import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDelegatedWriteGuardExtensionSource,
	DELEGATED_READ_ROOTS_ENV,
	evaluateDelegatedWriteToolCall,
} from "../src/tools/shell/delegated-write-guard.ts";
import type { ExploreBatchResult, ExploreTaskResult, RunExploreBatchOptions } from "../src/tools/sub-agent.ts";
import { resolveTaskReadRoots } from "../src/tools/sub-agent.ts";
import { createWorkflowToolDefinition } from "../src/workflow/tool.ts";

type ToolCallHandler = (event: {
	toolName: string;
	input: Record<string, unknown>;
}) => Promise<{ block: true; reason: string } | undefined>;

/** The exact guard source a read-write worker loads, with its `tool_call` handler captured. */
function loadGeneratedGuard(): ToolCallHandler {
	const source = createDelegatedWriteGuardExtensionSource().replace(
		"export default function (pi) {",
		"function guard(pi) {",
	);
	let handler: ToolCallHandler | undefined;
	const pi = {
		on(event: string, fn: ToolCallHandler) {
			if (event === "tool_call") handler = fn;
		},
	};
	new Function("pi", `${source}\nguard(pi);`)(pi);
	if (!handler) throw new Error("guard registered no tool_call handler");
	return handler;
}

function completedTask(description: string, prompt: string, output: string): ExploreTaskResult {
	return {
		description,
		prompt,
		status: "completed",
		output,
		toolUseCount: 1,
		tokens: 100,
		lastToolInfo: "完成",
		transcript: [],
	};
}

/**
 * Every path the workflow engine tells a sub-agent to read must pass the sub-agent's own permission check. Before this
 * was tested, phase two was told to read the phase-one results file, and the read-write guard rejected that path
 * because it lies outside the sub-agent's copy.
 */
describe("workflow phase handoff paths pass the sub-agent permission check", () => {
	const directories: string[] = [];
	const savedEnv: Record<string, string | undefined> = {};

	function temporary(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
		directories.push(dir);
		return dir;
	}

	function setEnv(name: string, value: string): void {
		if (!(name in savedEnv)) savedEnv[name] = process.env[name];
		process.env[name] = value;
	}

	afterEach(() => {
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
			delete savedEnv[name];
		}
		while (directories.length > 0) {
			const dir = directories.pop();
			if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	it("lets phase two read the phase-one results file and the task's readPaths, and nothing else", async () => {
		const workspace = temporary("myharness-wf-workspace");
		const artifacts = temporary("myharness-wf-artifacts");
		const logs = temporary("myharness-wf-logs");
		const elsewhere = temporary("myharness-wf-elsewhere");
		const copy = temporary("myharness-wf-copy");

		const calls: RunExploreBatchOptions[] = [];
		const runBatch = vi.fn(async (options: RunExploreBatchOptions): Promise<ExploreBatchResult> => {
			calls.push(options);
			const results = options.tasks.map((task) =>
				completedTask(task.description, task.prompt, `第 ${calls.length} 阶段证据`),
			);
			const details = { completed: results.length, total: results.length, results };
			return { text: `第 ${calls.length} 阶段摘要`, fullText: `第 ${calls.length} 阶段完整证据`, details };
		});
		const tool = createWorkflowToolDefinition(workspace, {
			getSettings: () => ({
				enabled: true,
				provider: "openai",
				model: "gpt-test",
				thinkingLevel: "high",
				mode: "read-write",
			}),
			runBatch,
			getArtifactsDir: () => artifacts,
		});

		const result = await tool.execute(
			"test-call",
			{
				name: "交接检查",
				phases: [
					{ name: "调查", tasks: [{ description: "查实现", prompt: "查找实现", access: "read" }] },
					{
						name: "复核",
						tasks: [
							{ description: "改代码", prompt: "按上一阶段结论修改", access: "write", readPaths: [logs] },
							{ description: "找反例", prompt: "尝试推翻前一结论", access: "read" },
						],
					},
				],
			},
			undefined,
			undefined,
			undefined as any,
		);

		expect(runBatch).toHaveBeenCalledTimes(2);
		const phaseTwo = calls[1];
		expect(phaseTwo.tasks.map((task) => task.access)).toEqual(["write", "read"]);

		for (const task of phaseTwo.tasks) {
			const match = task.prompt.match(/<previous_phase_results_file>(.*?)<\/previous_phase_results_file>/);
			expect(match).not.toBeNull();
			const resultsFile = match![1];
			// The handoff file lives in the conversation's artifacts and is kept after the run.
			expect(resultsFile.startsWith(join(artifacts, "workflow-runs"))).toBe(true);
			expect(readFileSync(resultsFile, "utf8")).toBe("第 1 阶段摘要");
			expect(existsSync(join(dirname(resultsFile), "phase-1-full.md"))).toBe(true);
			// The compact summary goes into the prompt as well.
			expect(task.prompt).toContain("Compact summary of that phase");

			const roots = resolveTaskReadRoots(workspace, phaseTwo.extraReadRoots, task.readPaths);
			for (const tool of ["read", "grep", "find", "ls"]) {
				const input = tool === "read" ? { path: resultsFile } : { path: dirname(resultsFile) };
				expect(
					evaluateDelegatedWriteToolCall(tool, input, copy, undefined, roots),
					`${tool} ${input.path}`,
				).toBeUndefined();
			}
			// Read roots never become writable or reachable from the shell.
			expect(
				evaluateDelegatedWriteToolCall("write", { path: resultsFile, content: "x" }, copy, undefined, roots),
			).toBeDefined();
			expect(
				evaluateDelegatedWriteToolCall("edit", { path: resultsFile, edits: [] }, copy, undefined, roots),
			).toBeDefined();
			expect(
				evaluateDelegatedWriteToolCall("bash", { command: `cat "${resultsFile}"` }, copy, undefined, roots),
			).toBeDefined();
			// Without the read roots the same read is refused: the check is real.
			expect(evaluateDelegatedWriteToolCall("read", { path: resultsFile }, copy, undefined, [])).toBeDefined();
			// A folder nobody listed stays unreadable.
			expect(
				evaluateDelegatedWriteToolCall("read", { path: join(elsewhere, "x.txt") }, copy, undefined, roots),
			).toBeDefined();

			// The worker loads the generated guard, which takes the list from its environment.
			setEnv("MYHARNESS_INTERNAL_DELEGATED_WORKTREE", copy);
			setEnv(DELEGATED_READ_ROOTS_ENV, JSON.stringify(roots));
			const guard = loadGeneratedGuard();
			expect(await guard({ toolName: "read", input: { path: resultsFile } })).toBeUndefined();
			expect(await guard({ toolName: "write", input: { path: resultsFile, content: "x" } })).toMatchObject({
				block: true,
			});
			expect(await guard({ toolName: "read", input: { path: join(elsewhere, "x.txt") } })).toMatchObject({
				block: true,
			});
		}

		// The task's own readPaths are readable too, and only for that task.
		const writeTaskRoots = resolveTaskReadRoots(workspace, phaseTwo.extraReadRoots, phaseTwo.tasks[0].readPaths);
		const readTaskRoots = resolveTaskReadRoots(workspace, phaseTwo.extraReadRoots, phaseTwo.tasks[1].readPaths);
		expect(
			evaluateDelegatedWriteToolCall("read", { path: join(logs, "run.log") }, copy, undefined, writeTaskRoots),
		).toBeUndefined();
		expect(
			evaluateDelegatedWriteToolCall("read", { path: join(logs, "run.log") }, copy, undefined, readTaskRoots),
		).toBeDefined();

		// The final result tells the Main Agent where the phase results are kept.
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("Phase results are kept in:");
	});
});
