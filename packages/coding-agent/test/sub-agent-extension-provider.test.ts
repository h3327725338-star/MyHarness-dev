/**
 * Sub-agents on a model that an extension registers, end to end: a real worker process is started from the sources, it
 * loads the provider's extension next to its guard, runs the model's tool call itself and reports back. No model and no
 * network: one provider is scripted in a fixture extension, the other is the Claude Code shell with a stand-in for
 * `claude` (test/fixtures/mock-claude-chat.mjs).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runExploreBatch } from "../src/tools/sub-agent.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const webEntry = resolve(here, "../src/web.ts");
const devLoader = resolve(here, "../../../scripts/dev-fast-loader.mjs");
const claudeCodeShell = resolve(here, "../examples/extensions/claude-code-shell.ts");
const mockClaude = resolve(here, "fixtures/mock-claude-chat.mjs");

/**
 * A provider whose one model reads notes.txt, reports what the tool returned, and, when asked to hand the report in,
 * calls submit_report (it does not do so on its own, like a model that skips the instruction the first time).
 */
const SCRIPTED_PROVIDER = `
import { createAssistantMessageEventStream, createProvider } from "@myharness/ai";

export default function (pi) {
	const stream = (model, context) => {
		const events = createAssistantMessageEventStream();
		const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
		const last = context.messages[context.messages.length - 1];
		setTimeout(() => {
			events.push({ type: "start", partial: output });
			// The request to hand the report in comes after an earlier reply (a time reminder may follow it).
			const lastReply = context.messages.map((message) => message.role).lastIndexOf("assistant");
			const askedForReport =
				lastReply !== -1 &&
				context.messages
					.slice(lastReply + 1)
					.some((message) => message.role === "user" && JSON.stringify(message.content).includes("submit_report"));
			if (askedForReport) {
				// Asked to hand the report in: the text above is the report, so submit_report with an empty report.
				const toolCall = { type: "toolCall", id: "call_scripted_submit", name: "submit_report", arguments: { report: "", questions: [] } };
				output.content.push(toolCall);
				output.stopReason = "toolUse";
				events.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				events.push({ type: "done", reason: "toolUse", message: output });
			} else if (last?.role === "toolResult") {
				const text = "REPORT: " + (last.isError ? "tool failed: " : "") + last.content.map((part) => part.text ?? "").join("").trim() + "\\nFindings: the file above was read in full and no other file was needed to answer the task.";
				output.content.push({ type: "text", text });
				events.push({ type: "text_start", contentIndex: 0, partial: output });
				events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
				events.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				events.push({ type: "done", reason: "stop", message: output });
			} else {
				const toolCall = { type: "toolCall", id: "call_scripted_1", name: "read", arguments: { path: "notes.txt" } };
				output.content.push(toolCall);
				output.stopReason = "toolUse";
				events.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				events.push({ type: "done", reason: "toolUse", message: output });
			}
			events.end();
		}, 0);
		return events;
	};
	pi.registerProvider(
		createProvider({
			id: "scripted",
			name: "Scripted",
			baseUrl: "scripted://local",
			auth: { apiKey: { name: "none", async resolve() { return { auth: { apiKey: "scripted" }, source: "fixture" }; } } },
			models: [{
				id: "scripted-model", name: "Scripted Model", api: "scripted-api", provider: "scripted", baseUrl: "scripted://local",
				reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000, maxTokens: 4000,
			}],
			api: { stream, streamSimple: stream },
		}),
	);
}
`;

describe("sub-agent on a model from an extension (real worker process)", () => {
	let root: string;
	let workspace: string;
	let agentDir: string;
	let scriptedExtension: string;
	const saved: Record<string, string | undefined> = {};
	const setEnv = (name: string, value: string | undefined) => {
		if (!(name in saved)) saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "myharness-sub-agent-extension-"));
		workspace = join(root, "workspace");
		agentDir = join(root, "agent");
		mkdirSync(workspace);
		mkdirSync(agentDir);
		writeFileSync(join(workspace, "notes.txt"), "the marker is BLUE-HERON-42\n");
		// A file the mirror of a folder without Git leaves out, so every task has something to report about it.
		writeFileSync(join(workspace, ".env"), "LEFT_OUT=1\n");
		writeFileSync(
			join(agentDir, "settings.json"),
			// A removed setting: its notice must not end up in front of a worker's own error.
			JSON.stringify({ httpIdleTimeoutMs: 15000, webSearch: { enabled: false } }),
		);
		scriptedExtension = join(root, "scripted-provider.ts");
		writeFileSync(scriptedExtension, SCRIPTED_PROVIDER);
		// The worker runs the sources the way a source run of MyHarness does: Node with the dev loader.
		const entry = join(root, "worker-entry.mjs");
		writeFileSync(
			entry,
			`import ${JSON.stringify(pathToFileURL(devLoader).href)};\nawait import(${JSON.stringify(pathToFileURL(webEntry).href)});\n`,
		);
		setEnv("MYHARNESS_PROCESS_ENTRY", entry);
		setEnv("MYHARNESS_CLI_ENTRY", undefined);
		setEnv(ENV_AGENT_DIR, agentDir);
		setEnv("MYHARNESS_OFFLINE", "1");
	});

	afterAll(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const task = {
		description: "Read the notes",
		prompt: "Read notes.txt in the working folder and report the marker it names.",
	};
	const limits = { thinkingLevel: "off" as const, taskTimeoutMs: 90_000 };

	it("loads the extension in the worker, runs the model's tool call itself and returns the report", async () => {
		const result = await runExploreBatch({
			cwd: workspace,
			tasks: [task],
			settings: {
				provider: "scripted",
				model: "scripted-model",
				providerExtensionPath: scriptedExtension,
				...limits,
			},
		});
		const [first] = result.details.results;
		expect(first.error).toBeUndefined();
		// The read, then the report handed in with submit_report once the worker asked for it.
		expect(first).toMatchObject({ status: "completed", toolUseCount: 2, reportSubmission: "tool" });
		expect(first.output).toContain("REPORT:");
		expect(first.output).toContain("BLUE-HERON-42");
		expect(first.transcript[0]).toMatchObject({ toolName: "read", status: "completed" });
		expect(first.transcript[1]).toMatchObject({ toolName: "submit_report", status: "completed" });
		// Whoever reads the report is told what the worker's copy of the folder left out.
		expect((first.unresolved ?? []).some((note) => note.includes("未带入副本") && note.includes(".env"))).toBe(true);
	}, 120_000);

	it("says in one plain line that the model does not exist in the worker when its extension is not handed over", async () => {
		const result = await runExploreBatch({
			cwd: workspace,
			tasks: [task],
			settings: { provider: "scripted", model: "scripted-model", ...limits },
		});
		const [first] = result.details.results;
		expect(first.status).toBe("failed");
		expect(first.error).toContain("子智能体进程里没有模型“scripted/scripted-model”");
		// Neither the removed-setting notice nor the hint at a command-line option the user does not have.
		expect(first.error).not.toContain("httpIdleTimeoutMs");
		expect(first.error).not.toContain("--list-models");
		// A task that failed has no report: the list of left-out files is not hung under its error.
		expect((first.unresolved ?? []).some((note) => note.includes("未带入副本"))).toBe(false);
	}, 120_000);

	it("does not start a worker whose provider extension cannot be loaded", async () => {
		const broken = join(root, "broken-provider.ts");
		writeFileSync(broken, "export default function (pi) { throw new Error('boom at load'); }\n");
		const result = await runExploreBatch({
			cwd: workspace,
			tasks: [task],
			settings: { provider: "scripted", model: "scripted-model", providerExtensionPath: broken, ...limits },
		});
		const [first] = result.details.results;
		expect(first.status).toBe("failed");
		expect(first.error).toContain("子智能体进程未能加载扩展");
		expect(first.error).toContain("boom at load");
	}, 120_000);

	it("runs the Claude Code shell with none of claude's own tools: MyHarness runs every call, and nothing is kept", async () => {
		const log = join(root, "mock-claude.log");
		setEnv("MYHARNESS_CLAUDE_BIN", mockClaude);
		setEnv("MOCK_CLAUDE_LOG", log);
		const result = await runExploreBatch({
			cwd: workspace,
			tasks: [task],
			settings: {
				provider: "claude-code",
				model: "claude-haiku-5-5",
				providerExtensionPath: claudeCodeShell,
				...limits,
			},
		});
		const [first] = result.details.results;
		expect(first.error).toBeUndefined();
		expect(first).toMatchObject({ status: "completed", toolUseCount: 2, reportSubmission: "tool" });
		expect(first.output).toContain("BLUE-HERON-42");
		// Both calls were MyHarness's own tools, which the worker's guards see, not cards for tools claude ran itself: the
		// read, then submit_report once the worker asked for the report.
		expect(first.transcript.map((entry) => entry.toolName)).toEqual(["read", "submit_report"]);

		const entries = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const start = entries.find((entry) => entry.start) as {
			start: string[];
			cwd: string;
			entrypoint: string;
			autoMemoryOff: string | null;
		};
		const offered = (entries.find((entry) => entry.offered) as { offered: string[] }).offered;
		// None of claude's own tools; every tool of the worker's role over MyHarness's endpoint, the file tools too.
		expect(start.start[start.start.indexOf("--tools") + 1]).toBe("");
		expect(offered).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "bash"]));
		expect(offered).not.toContain("claude_code_tool");
		expect(offered).not.toContain("agent");
		// A sub-agent's conversation is not kept in Claude Code's history and leaves no link behind.
		expect(start.start).toContain("--no-session-persistence");
		expect(start.start).not.toContain("--resume");
		expect(start.entrypoint).toBe("myharness");
		// No memory folder of Claude Code's: its path would make every sub-agent's prompt its own (nothing cached shared).
		expect(start.autoMemoryOff).toBe("1");
		expect(existsSync(join(agentDir, "claude-code-shell", "classic-links.json"))).toBe(false);
		// The sub-agent's own section is what is appended in front of MyHarness's prompt.
		const promptFile = start.start[start.start.indexOf("--append-system-prompt-file") + 1];
		expect(promptFile).toBeTruthy();
	}, 120_000);
});
