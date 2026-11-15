import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkerModelSupport } from "../src/agent/delegation/worker-model.ts";
import { loadExtensions } from "../src/extensions/loader/index.ts";
import { ExtensionRunner } from "../src/extensions/runtime/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/extensions/runtime/types.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import {
	buildSubAgentArgs,
	createSubAgentToolDefinition,
	resolveSubAgentRuntimeSettings,
} from "../src/tools/sub-agent.ts";
import { createWorkflowToolDefinition } from "../src/workflow/engine.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("which model a sub-agent's worker can run on", () => {
	const extension = (extensionPath: string, providers: string[]) => ({
		path: extensionPath,
		resolvedPath: path.resolve(extensionPath),
		providers: new Set(providers),
	});

	it("needs nothing extra for a model of the saved providers", () => {
		expect(
			resolveWorkerModelSupport({
				provider: "command-code",
				modelId: "z-ai/glm-5.3-flash",
				model: { name: "GLM 5.3 Flash" },
				providerEnabled: true,
				extensions: [extension("/ext/claude-code-shell.ts", ["claude-code"])],
			}),
		).toEqual({});
	});

	it("hands the worker the extension that registered the model's provider", () => {
		expect(
			resolveWorkerModelSupport({
				provider: "claude-code",
				modelId: "claude-sonnet-5-5",
				model: { name: "Claude Code · Sonnet 5.5", runsOwnTools: true, delegatedHostTools: true },
				providerEnabled: true,
				extensions: [
					extension("/ext/agy-shell.ts", ["agy"]),
					extension("/ext/claude-code-shell.ts", ["claude-code"]),
				],
			}),
		).toEqual({ providerExtensionPath: path.resolve("/ext/claude-code-shell.ts") });
	});

	it("refuses a model whose program runs tools by itself and cannot leave them to MyHarness", () => {
		const support = resolveWorkerModelSupport({
			provider: "agy",
			modelId: "gemini-3.8-flash",
			model: { name: "agy · Gemini 3.8 Flash", runsOwnTools: true },
			providerEnabled: true,
			extensions: [extension("/ext/agy-shell.ts", ["agy"])],
		});
		expect(support.providerExtensionPath).toBeUndefined();
		expect(support.unavailableReason).toContain("agy · Gemini 3.8 Flash");
		expect(support.unavailableReason).toContain("由它自己的程序执行工具");
	});

	it("refuses a model of a provider that is switched off, naming the model by its id when it has no name", () => {
		const support = resolveWorkerModelSupport({
			provider: "sudocode",
			modelId: "custom-id",
			model: undefined,
			providerEnabled: false,
			extensions: [],
		});
		expect(support.unavailableReason).toContain("sudocode/custom-id");
		expect(support.unavailableReason).toContain("已停用");
	});

	it("refuses a model from an extension built into the host process, which has no file to load", () => {
		const support = resolveWorkerModelSupport({
			provider: "inline-provider",
			modelId: "m",
			model: { name: "Inline Model" },
			providerEnabled: true,
			extensions: [{ path: "<inline:1>", resolvedPath: "<inline:1>", providers: new Set(["inline-provider"]) }],
		});
		expect(support.unavailableReason).toContain("内嵌扩展");
	});
});

describe("worker arguments and dispatch for a model from an extension", () => {
	const base = {
		provider: "claude-code",
		model: "claude-sonnet-5-5",
		thinkingLevel: "high" as const,
		systemPromptPath: "explore.md",
		guardPath: "guard.js",
	};

	it("loads the provider's extension right after the guard, still with every other extension off", () => {
		const args = buildSubAgentArgs({ ...base, providerExtensionPath: "C:/ext/claude-code-shell.ts" });
		expect(args).toContain("--no-extensions");
		const guardIndex = args.indexOf("guard.js");
		expect(args.slice(guardIndex - 1, guardIndex + 3)).toEqual([
			"--extension",
			"guard.js",
			"--extension",
			"C:/ext/claude-code-shell.ts",
		]);
		expect(args).toContain("claude-code/claude-sonnet-5-5");
	});

	it("names only the guard when the model needs no extension", () => {
		const args = buildSubAgentArgs(base);
		expect(args.filter((arg) => arg === "--extension")).toHaveLength(1);
	});

	it("keeps the extension path through settings resolution", () => {
		expect(
			resolveSubAgentRuntimeSettings({ ...base, enabled: true, providerExtensionPath: "C:/ext/provider.ts" })
				.providerExtensionPath,
		).toBe("C:/ext/provider.ts");
	});

	it("refuses the agent tool before anything starts, with the reason in the user's words", async () => {
		const tool = createSubAgentToolDefinition(process.cwd(), {
			getSettings: () => ({ ...base, enabled: true, unavailableReason: "子智能体模型“X”不能用作子智能体模型。" }),
		});
		await expect(
			tool.execute(
				"call",
				{ tasks: [{ description: "Inspect", prompt: "Find it." }] },
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("子智能体模型“X”不能用作子智能体模型。");
	});

	it("refuses a workflow the same way", async () => {
		const tool = createWorkflowToolDefinition(process.cwd(), {
			getSettings: () => ({ ...base, enabled: true, unavailableReason: "子智能体模型“X”不能用作子智能体模型。" }),
			runBatch: async () => {
				throw new Error("must not run");
			},
		});
		await expect(
			tool.execute(
				"call",
				{
					name: "Check",
					phases: [{ name: "One", tasks: [{ description: "Inspect", prompt: "Find it." }] }],
				} as any,
				undefined,
				undefined,
				undefined as any,
			),
		).rejects.toThrow("子智能体模型“X”不能用作子智能体模型。");
	});
});

describe("what an extension tells MyHarness, and what MyHarness tells an extension, for sub-agents", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myharness-worker-model-test-"));
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModel = {
		id: "ext-model",
		name: "Ext Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_000,
	};

	it("records which providers each extension registered, and forgets one it took back", async () => {
		const providerPath = path.join(tempDir, "provider.ts");
		fs.writeFileSync(
			providerPath,
			`export default function (pi) {
				const config = { baseUrl: "https://example.test/v1", apiKey: "TEST_KEY", api: "openai-completions", models: [${JSON.stringify(providerModel)}] };
				pi.registerProvider("ext-one", config);
				pi.registerProvider("ext-two", config);
				pi.unregisterProvider("ext-two");
			}`,
		);
		const plainPath = path.join(tempDir, "plain.ts");
		fs.writeFileSync(plainPath, "export default function (pi) { pi.on('turn_end', () => {}); }");

		const result = await loadExtensions([providerPath, plainPath], tempDir);
		expect(result.errors).toEqual([]);
		const [provider, plain] = result.extensions;
		expect([...(provider.providers ?? [])]).toEqual(["ext-one"]);
		expect(plain.providers).toBeUndefined();
		expect(
			resolveWorkerModelSupport({
				provider: "ext-one",
				modelId: "ext-model",
				model: providerModel,
				providerEnabled: true,
				extensions: result.extensions,
			}),
		).toEqual({ providerExtensionPath: provider.resolvedPath });
	});

	it("gives an extension the session's role, a main session unless the host says otherwise", async () => {
		const result = await loadExtensions([], tempDir);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createModelRegistry(AuthStorage.create(path.join(tempDir, "auth.json")));
		const actions = {} as ExtensionActions;
		const contextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		} satisfies ExtensionContextActions;

		const main = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		main.bindCore(actions, contextActions);
		expect(main.createContext().agentRole).toBe("main");

		const delegated = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		delegated.bindCore(actions, { ...contextActions, getAgentRole: () => "delegated" });
		expect(delegated.createContext().agentRole).toBe("delegated");
	});
});
