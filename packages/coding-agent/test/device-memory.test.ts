import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMemoryManager, getAutoMemoryPaths } from "../src/agent/runtime/auto-memory.ts";
import { isExplicitMemoryRequest } from "../src/agent/runtime/memory-mode.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { writeMemoryFile } from "../src/session/memory/store.ts";
import type { SessionEntry } from "../src/session/types.ts";
import { createMemoryDeleteToolDefinition, createSessionMemoryManageOperations } from "../src/tools/memory/manage.ts";
import { createSessionMemoryOperations } from "../src/tools/memory/search.ts";
import { createMemoryWriteToolDefinition } from "../src/tools/memory/write.ts";
import { writeFileAtomically } from "../src/utils/atomic-write.ts";
import { createHarness } from "./suite/harness.ts";

const roots: string[] = [];
function root() {
	const dir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "device-memory-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("recognizes explicit memory requests without accepting ordinary or quoted text", () => {
	for (const request of [
		"记一下我的偏好",
		"帮我把这个方案记一下",
		"先帮我查一下记忆里的地址",
		"看看我的记忆",
		"Please note this down",
	]) {
		expect(isExplicitMemoryRequest(request), request).toBe(true);
	}
	for (const request of [
		"忘了说今天休息",
		"Don't forget to call",
		"忘记密码了",
		"更新记忆功能的说明文档",
		"Update the memory docs",
		"Please remember to call tomorrow",
		"Remove the memory leak",
		"> 记住这段\n帮我分析这句话",
		"```\n记住这段\n```摘要一下",
	]) {
		expect(isExplicitMemoryRequest(request), request).toBe(false);
	}
});

it("shares immediate state across chats on one device and persists only its own setting", async () => {
	const dir = root();
	const agent = join(dir, "agent");
	const first = SettingsManager.create(dir, agent);
	const second = SettingsManager.create(join(dir, "other-project"), agent);
	const other = SettingsManager.create(dir, join(dir, "other-pc"));
	const old = second.getDeviceMemorySignal();
	first.setMemoryEnabledOnDevice(false);
	expect(second.isMemoryEnabledOnDevice()).toBe(false);
	expect(old.aborted).toBe(true);
	expect(other.isMemoryEnabledOnDevice()).toBe(true);
	expect(await first.flush()).toEqual([]);
	expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).memoryEnabledOnDevice).toBe(false);
});

it("picks up settings written outside the process-local state without restarting", async () => {
	const dir = root();
	const settings = SettingsManager.create(dir, dir);
	const file = join(dir, "settings.json");
	const enabledGeneration = settings.getDeviceMemorySignal();
	await writeFileAtomically(file, '{"memoryEnabledOnDevice":false}');
	await vi.waitFor(() => expect(settings.isMemoryEnabledOnDevice()).toBe(false), { timeout: 3000 });
	expect(enabledGeneration.aborted).toBe(true);
	const disabledGeneration = settings.getDeviceMemorySignal();
	await writeFileAtomically(file, '{"memoryEnabledOnDevice":true}');
	await vi.waitFor(() => expect(settings.isMemoryEnabledOnDevice()).toBe(true), { timeout: 3000 });
	expect(disabledGeneration.aborted).toBe(true);
});

it("still accepts another instance's switch after a failed local save", async () => {
	let notify!: (enabled: boolean) => void;
	const settings = SettingsManager.fromStorage({
		deviceKey: join(root(), "settings.json"),
		watchDeviceMemory: (listener) => {
			notify = listener;
		},
		withLock: (_scope, read) => {
			read(undefined);
		},
		withLockAsync: async () => {
			throw new Error("test write failure");
		},
	});
	settings.setMemoryEnabledOnDevice(false);
	expect(await settings.flush()).toHaveLength(1);
	expect(settings.isMemoryEnabledOnDevice()).toBe(false);
	notify(true);
	expect(settings.isMemoryEnabledOnDevice()).toBe(true);
	notify(false);
	expect(settings.isMemoryEnabledOnDevice()).toBe(false);
});

it("never writes the result of a job cancelled by a fast off/on cycle", async () => {
	const dir = root();
	const settingsManager = SettingsManager.inMemory({ autoMemory: { provider: "fake", model: "memory" } });
	let answer!: (result: string) => void;
	const modelRunner = vi.fn(
		async (_request: { signal?: AbortSignal }) =>
			new Promise<string>((resolve) => {
				answer = resolve;
			}),
	);
	const options = {
		cwd: dir,
		workspaceId: "ws",
		sessionId: "session",
		dataRoot: join(dir, "data"),
		agentDir: join(dir, "agent"),
		persisted: true,
		settingsManager,
		modelRunner,
	};
	const manager = new AutoMemoryManager(options);
	const entry = {
		type: "message",
		id: "first",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "SYNTHETIC TEST", timestamp: Date.now() },
	} satisfies SessionEntry;
	try {
		const working = manager.runExtraction([entry]);
		await vi.waitFor(() => expect(modelRunner).toHaveBeenCalledOnce());
		settingsManager.setMemoryEnabledOnDevice(false);
		expect(modelRunner.mock.calls[0][0].signal?.aborted).toBe(true);
		expect(await manager.recall("SYNTHETIC TEST")).toBeUndefined();
		settingsManager.setMemoryEnabledOnDevice(true);
		answer(
			JSON.stringify({
				operations: [
					{
						action: "upsert",
						id: "global/stale",
						scope: "global",
						type: "user",
						name: "stale",
						description: "stale",
						content: "stale",
					},
				],
			}),
		);
		expect(await working).toBe(false);
		expect(existsSync(join(getAutoMemoryPaths(dir, options.agentDir, options).globalDir, "stale.md"))).toBe(false);
		modelRunner.mockResolvedValue('{"operations":[]}');
		await expect(
			manager.runExtraction([
				{ ...entry, skipMemoryExtraction: true },
				{ ...entry, id: "next", message: { ...entry.message, content: "AFTER REENABLE" } },
			]),
		).resolves.toBe(true);
		expect(modelRunner.mock.calls.at(-1)?.[0]).toMatchObject({ task: expect.stringContaining("AFTER REENABLE") });
		expect(modelRunner.mock.calls.at(-1)?.[0]).toMatchObject({ task: expect.not.stringContaining("SYNTHETIC TEST") });
	} finally {
		manager.dispose();
	}
});

it("isolates manual writes, reads, and deletes from the normal store", async () => {
	const dataRoot = root();
	const settingsManager = SettingsManager.inMemory();
	const source = {
		settingsManager,
		sessionManager: {
			isPersisted: () => true,
			getDataRoot: () => dataRoot,
			getWorkspaceId: () => "ws",
			getSessionId: () => "session",
		},
	};
	const operations = createSessionMemoryManageOperations(source);
	const read = createSessionMemoryOperations(source);
	const writer = createMemoryWriteToolDefinition(dataRoot, { operations });
	const deleter = createMemoryDeleteToolDefinition(dataRoot, { operations });
	const save = (content: string) =>
		writer.execute(
			"call",
			{ items: [{ name: "Same ID", description: "Test", scope: "global", type: "user", content }] },
			undefined,
			undefined,
			undefined!,
		);
	await save("regular memory");
	settingsManager.setMemoryEnabledOnDevice(false);
	expect(read.loadEntries()).toEqual([]);
	expect((await save("manual memory")).details).toMatchObject({
		returned: 1,
		manualOnly: true,
		ids: ["global/same-id"],
	});
	expect(read.loadEntries()?.map((entry) => entry.content)).toEqual(["manual memory"]);
	expect(existsSync(join(dataRoot, "manual-memory", "memory", "state.json"))).toBe(false);
	settingsManager.setMemoryEnabledOnDevice(true);
	expect(read.loadEntries()?.map((entry) => entry.content)).toEqual(["regular memory"]);
	settingsManager.setMemoryEnabledOnDevice(false);
	expect(
		(await deleter.execute("call", { id: "global/same-id" }, undefined, undefined, undefined!)).details?.returned,
	).toBe(1);
	settingsManager.setMemoryEnabledOnDevice(true);
	expect(read.loadEntries()?.map((entry) => entry.content)).toEqual(["regular memory"]);
});

it("removes old recall from live requests but preserves chat history and restores recall on re-enable", async () => {
	const dataRoot = root();
	vi.stubEnv("MYHARNESS_DATA_ROOT", dataRoot);
	const harness = await createHarness({ persisted: true });
	try {
		const { session } = harness;
		const { agent } = session;
		const loc = {
			dataRoot,
			workspaceId: session.sessionManager.getWorkspaceId() ?? "unbound",
			sessionId: session.sessionManager.getSessionId(),
		};
		const { globalDir } = getAutoMemoryPaths(harness.tempDir, join(harness.tempDir, "agent"), loc);
		await writeMemoryFile(
			join(globalDir, "test.md"),
			"---\nid: global/test\nname: test\ndescription: recall test\ntype: user\nscope: global\n---\n\nSYNTHETIC-RECALL-MARKER\n",
		);
		const requests: string[] = [];
		const original = agent.streamFunction;
		agent.streamFunction = (model, context, opts) => {
			requests.push(JSON.stringify(context));
			return original(model, context, opts);
		};
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await session.prompt("recall test");
		session.settingsManager.setMemoryEnabledOnDevice(false);
		await session.prompt("during off mode");
		session.settingsManager.setMemoryEnabledOnDevice(true);
		await session.prompt("recall test again");
		expect(requests[0]).toContain("SYNTHETIC-RECALL-MARKER");
		expect(requests[1]).not.toContain("SYNTHETIC-RECALL-MARKER");
		expect(requests[1]).toContain("Device memory is off");
		expect(requests[2]).toContain("SYNTHETIC-RECALL-MARKER");
		expect(requests[2]).toContain("during off mode");
		expect(
			session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.skipMemoryExtraction),
		).toHaveLength(2);
	} finally {
		harness.cleanup();
		vi.unstubAllEnvs();
	}
});
