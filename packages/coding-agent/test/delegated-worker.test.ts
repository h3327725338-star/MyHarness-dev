import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
	prompt: vi.fn(),
	steer: vi.fn(),
	sessionDispose: vi.fn(),
	servicesDispose: vi.fn(),
	bind: vi.fn(),
	subscribe: vi.fn(),
	create: vi.fn(),
	take: vi.fn(),
	write: vi.fn(),
	flush: vi.fn(),
	restore: vi.fn(),
	mute: vi.fn(),
	proxy: vi.fn(),
	dispatcher: vi.fn(),
	shutdown: vi.fn(),
	extensionErrors: [] as Array<{ path: string; error: string }>,
}));
vi.mock("../src/platform/process/output-guard.ts", () => ({
	takeOverStdout: fx.take,
	writeRawStdout: fx.write,
	flushRawStdout: fx.flush,
	restoreStdout: fx.restore,
}));
vi.mock("../src/config/settings/index.ts", () => ({
	muteRemovedSettingNotices: fx.mute,
	SettingsManager: {
		create: vi.fn(() => ({
			getGlobalSettings: () => ({ httpProxy: "http://proxy.test:8080" }),
			getNetworkTimeouts: () => ({
				connectTimeoutMs: 120_000,
				firstByteTimeoutMs: 120_000,
				streamIdleTimeoutMs: 300_000,
			}),
		})),
	},
}));
vi.mock("../src/platform/process/http-dispatcher.ts", () => ({
	applyHttpProxySettings: fx.proxy,
	configureHttpDispatcher: fx.dispatcher,
}));
vi.mock("../src/extensions/runtime/runner.ts", () => ({ emitSessionShutdownEvent: fx.shutdown }));
vi.mock("../src/providers/runtime/model-resolver.ts", () => ({
	resolveCliModel: () => ({ model: { id: "fixture" } }),
}));
vi.mock("../src/session/manager/index.ts", () => ({ SessionManager: { inMemory: () => ({}) } }));
vi.mock("../src/agent/runtime/services.ts", () => ({
	createAgentSessionServices: fx.create,
	createAgentSessionFromServices: async () => ({
		session: {
			messages: [],
			prompt: fx.prompt,
			steer: fx.steer,
			dispose: fx.sessionDispose,
			bindExtensions: fx.bind,
			subscribe: fx.subscribe,
			extensionRunner: { name: "runner" },
		},
	}),
}));

import { parseDelegatedWorkerLine, runDelegatedWorker } from "../src/agent/delegation/worker.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
function prepare(stdinLines: string[]) {
	fx.extensionErrors = [];
	fx.create.mockImplementation(async () => ({
		modelRuntime: {},
		diagnostics: [],
		resourceLoader: { getExtensions: () => ({ errors: fx.extensionErrors }) },
		dispose: fx.servicesDispose,
	}));
	fx.shutdown.mockResolvedValue(true);
	fx.prompt.mockResolvedValue(undefined);
	fx.steer.mockResolvedValue(undefined);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
		for (const line of stdinLines) yield `${line}\n`;
	});
	fx.subscribe.mockImplementation((listener) => listener({ type: "agent_end", messages: [] }));
}
const promptLine = (text: string) => JSON.stringify({ type: "prompt", text });
const steerLine = (text: string) => JSON.stringify({ type: "steer", text });

describe("delegated worker stdin protocol parsing", () => {
	it("accepts prompt and steer lines and ignores anything else", () => {
		expect(parseDelegatedWorkerLine(promptLine("inspect"))).toEqual({ type: "prompt", text: "inspect" });
		expect(parseDelegatedWorkerLine(steerLine("reminder"))).toEqual({ type: "steer", text: "reminder" });
		expect(parseDelegatedWorkerLine("not json")).toBeUndefined();
		expect(parseDelegatedWorkerLine(JSON.stringify({ type: "other", text: "x" }))).toBeUndefined();
		expect(parseDelegatedWorkerLine(JSON.stringify({ type: "prompt", text: "  " }))).toBeUndefined();
		expect(parseDelegatedWorkerLine("")).toBeUndefined();
	});
});

describe("internal delegated worker", () => {
	it("uses shared runtime, delegated role and NDJSON without terminal input prompts", async () => {
		prepare([promptLine("delegated prompt")]);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.create.mock.calls[0][0].resourceLoaderOptions).toMatchObject({
			noExtensions: true,
			noContextFiles: true,
			agentRole: "delegated",
		});
		expect(fx.prompt).toHaveBeenCalledWith("delegated prompt");
		expect(fx.write).toHaveBeenCalledWith('{"type":"agent_end","messages":[]}\n');
		expect(fx.sessionDispose).toHaveBeenCalledOnce();
		expect(fx.servicesDispose).toHaveBeenCalledOnce();
		expect(fx.flush).toHaveBeenCalledOnce();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
	it("delivers steer lines as real steering messages alongside the prompt", async () => {
		prepare([promptLine("inspect the repo"), steerLine("收敛提醒：请换用其他工具")]);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.steer).toHaveBeenCalledWith("收敛提醒：请换用其他工具");
		expect(fx.prompt).toHaveBeenCalledWith("inspect the repo");
	});
	it("falls back to plain pre-protocol task text when no prompt line ever arrives", async () => {
		prepare(["Inspect the project.", "Report the first file."]);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.prompt).toHaveBeenCalledWith("Inspect the project.\nReport the first file.");
	});
	it("does not turn unparseable protocol-looking input into a prompt", async () => {
		prepare(['{"type": "prompt", "text": truncated']);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.prompt).not.toHaveBeenCalled();
	});
	it("releases session/services and output ownership when generation fails", async () => {
		prepare([promptLine("delegated prompt")]);
		fx.prompt.mockRejectedValueOnce(new Error("fixture failure"));
		await expect(runDelegatedWorker(["--model", "fixture"])).rejects.toThrow("fixture failure");
		expect(fx.sessionDispose).toHaveBeenCalledOnce();
		expect(fx.servicesDispose).toHaveBeenCalledOnce();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
	it("loads the extension that registers the model next to its guard, and no other", async () => {
		prepare([promptLine("delegated prompt")]);
		await runDelegatedWorker([
			"--no-extensions",
			"--extension",
			"guard.js",
			"--extension",
			"provider-extension.ts",
			"--model",
			"fixture",
		]);
		expect(fx.create.mock.calls[0][0].resourceLoaderOptions).toMatchObject({
			noExtensions: true,
			additionalExtensionPaths: ["guard.js", "provider-extension.ts"],
		});
	});
	it("does not start when one of its extensions failed to load", async () => {
		prepare([promptLine("delegated prompt")]);
		fx.extensionErrors = [{ path: "guard.js", error: "Failed to load extension: boom" }];
		await expect(runDelegatedWorker(["--extension", "guard.js", "--model", "fixture"])).rejects.toThrow(
			"子智能体进程未能加载扩展：guard.js：Failed to load extension: boom",
		);
		expect(fx.prompt).not.toHaveBeenCalled();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
	it("applies the user's proxy and network time limits and keeps removed-setting notices out of its output", async () => {
		prepare([promptLine("delegated prompt")]);
		await runDelegatedWorker(["--model", "fixture"]);
		expect(fx.mute).toHaveBeenCalledOnce();
		expect(fx.proxy).toHaveBeenCalledWith("http://proxy.test:8080");
		expect(fx.dispatcher).toHaveBeenCalledWith({
			connectTimeoutMs: 120_000,
			firstByteTimeoutMs: 120_000,
			streamIdleTimeoutMs: 300_000,
		});
	});
	it("tells extensions the session is over before it is disposed, also when their handler fails", async () => {
		prepare([promptLine("delegated prompt")]);
		const order: string[] = [];
		fx.shutdown.mockImplementation(async () => {
			order.push("shutdown");
			throw new Error("handler failed");
		});
		fx.sessionDispose.mockImplementation(() => order.push("dispose"));
		await runDelegatedWorker(["--model", "fixture"]);
		expect(fx.shutdown).toHaveBeenCalledWith({ name: "runner" }, { type: "session_shutdown", reason: "quit" });
		expect(order).toEqual(["shutdown", "dispose"]);
	});
});
