import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoMemoryManager, type AutoMemoryModelRunner, getAutoMemoryPaths } from "../src/agent/runtime/auto-memory.ts";
import type { MemoryPickerSettings } from "../src/config/settings/index.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./suite/harness.ts";

const testRoot = join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-memory-picker-tests");
const dataRoot = join(testRoot, "data");
const agentDir = join(testRoot, "agent");
const projectDir = join(testRoot, "project");
const location = { dataRoot, workspaceId: "ws", sessionId: "session-one" };
const PICKER = { enabled: true, provider: "test", model: "picker-model" } as const;

const managers: AutoMemoryManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function memoryFile(id: string, name: string, body: string, createdAt: string): string {
	return [
		"---",
		`id: ${id}`,
		`name: ${name}`,
		`description: ${name} 相关时`,
		"type: feedback",
		`scope: ${id.split("/")[0]}`,
		`createdAt: ${createdAt}`,
		`updatedAt: ${createdAt}`,
		"---",
		"",
		body,
		"",
	].join("\n");
}

function writeMemories(memories: Array<[name: string, body: string]>): void {
	mkdirSync(projectDir, { recursive: true });
	const { globalDir } = getAutoMemoryPaths(projectDir, agentDir, location);
	mkdirSync(globalDir, { recursive: true });
	memories.forEach(([name, body], index) => {
		const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
		writeFileSync(join(globalDir, `${name}.md`), memoryFile(`global/${name}`, name, body, createdAt));
	});
}

function manager(
	picker: MemoryPickerSettings | undefined,
	modelRunner?: AutoMemoryModelRunner,
	onError?: (operation: string) => void,
) {
	const instance = new AutoMemoryManager({
		cwd: projectDir,
		sessionId: location.sessionId,
		dataRoot,
		workspaceId: location.workspaceId,
		settingsManager: SettingsManager.inMemory({
			autoMemory: { enabled: true, provider: "test", model: "memory-model", thinkingLevel: "high" },
			memoryPicker: picker,
		}),
		persisted: true,
		agentDir,
		modelRunner,
		onError,
	});
	managers.push(instance);
	return instance;
}

const cardsOf = (recalled: { details?: unknown } | undefined) =>
	(recalled?.details as { ids: string[] } | undefined)?.ids;

const THREE: Array<[string, string]> = [
	["喝茶", "每天都要喝茶。"],
	["住址", "住在示例公寓。"],
	["显卡", "显卡是示例型号。"],
];

describe("Memory picker", () => {
	it("sends only what the model picked, best first, with the directory it was shown", async () => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => '{"ids":[2,1]}');
		const recalled = await manager(PICKER, runner).recall("bolt 在我住的地方打得到车吗");
		expect(cardsOf(recalled)).toEqual(["global/住址", "global/喝茶"]);
		expect(String(recalled?.content)).toContain("住在示例公寓。");
		expect(String(recalled?.content)).not.toContain("显卡是示例型号。");
		const request = runner.mock.calls[0][0];
		expect(request.settings).toEqual({ provider: "test", model: "picker-model", thinkingLevel: "low" });
		// Oldest first, so a new memory leaves the long start of the request unchanged for the prompt cache.
		expect(request.task).toContain("1 | 喝茶 | 喝茶 相关时\n2 | 住址 | 住址 相关时\n3 | 显卡 | 显卡 相关时");
		expect(request.task).toContain("User's message:\nbolt 在我住的地方打得到车吗");
		expect(request.urgent?.timeoutMs).toBe(5000);
	});

	it("uses the thinking level the user chose", async () => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => '{"ids":[]}');
		await manager({ ...PICKER, thinkingLevel: "high" }, runner).recall("随便问问");
		expect(runner.mock.calls[0][0].settings.thinkingLevel).toBe("high");
	});

	it("sends no card when the model answers with an empty list", async () => {
		writeMemories(THREE);
		const recalled = await manager(PICKER, async () => '```json\n{"ids":[]}\n```').recall("显卡是什么");
		expect(cardsOf(recalled)).toEqual([]);
		expect(String(recalled?.content)).toContain("global/显卡"); // the directory stays
		expect(String(recalled?.content)).not.toContain("显卡是示例型号。");
	});

	it("ignores numbers that point at nothing, repeats, and anything over five", async () => {
		const many = Array.from({ length: 8 }, (_, index): [string, string] => [
			`记忆${index + 1}`,
			`正文 ${index + 1}。`,
		]);
		writeMemories(many);
		const recalled = await manager(PICKER, async () => '{"ids":[99,0,"x",1,1,2,3,4,5,6]}').recall("随便问问");
		expect(cardsOf(recalled)).toEqual([
			"global/记忆1",
			"global/记忆2",
			"global/记忆3",
			"global/记忆4",
			"global/记忆5",
		]);
	});

	it.each([
		["switched off", { ...PICKER, enabled: false }],
		["never set", undefined],
		["on with no model", { enabled: true }],
	])("does not call any model when it is %s, and the keyword ranking still works", async (_name, picker) => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => '{"ids":[3]}');
		const recalled = await manager(picker as MemoryPickerSettings | undefined, runner).recall("我每天怎么喝茶");
		expect(runner).not.toHaveBeenCalled();
		expect(cardsOf(recalled)).toEqual(["global/喝茶"]);
	});

	it("falls back to the keyword ranking, says so once, and stops waiting after two failures in a row", async () => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => {
			throw new Error("401 bad key");
		});
		const errors: string[] = [];
		const instance = manager(PICKER, runner, (operation) => errors.push(operation));
		for (let turn = 0; turn < 4; turn++) {
			expect(cardsOf(await instance.recall("我每天怎么喝茶"))).toEqual(["global/喝茶"]);
		}
		expect(runner).toHaveBeenCalledTimes(2);
		expect(errors).toEqual(["pick"]);
	});

	it("treats an answer without a list as a failure", async () => {
		writeMemories(THREE);
		const errors: string[] = [];
		const recalled = await manager(
			PICKER,
			async () => "我觉得第一条有用",
			(operation) => errors.push(operation),
		).recall("怎么喝茶");
		expect(cardsOf(recalled)).toEqual(["global/喝茶"]);
		expect(errors).toEqual(["pick"]);
	});

	it("gives up after five seconds on a model that never answers", { timeout: 15_000 }, async () => {
		writeMemories(THREE);
		const errors: string[] = [];
		const instance = manager(
			PICKER,
			() => new Promise<string>(() => {}),
			(operation) => errors.push(operation),
		);
		const started = Date.now();
		const recalled = await instance.recall("怎么喝茶");
		expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
		expect(Date.now() - started).toBeLessThan(8000);
		expect(cardsOf(recalled)).toEqual(["global/喝茶"]);
		expect(errors).toEqual([]); // a slow answer now and then is not worth a warning
	});

	it("ends the wait at once when the signal fires, without counting a failure", async () => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(() => new Promise<string>(() => {}));
		const errors: string[] = [];
		const instance = manager(PICKER, runner, (operation) => errors.push(operation));
		const controller = new AbortController();
		const started = Date.now();
		const recalling = instance.recall("怎么喝茶", undefined, controller.signal);
		await vi.waitFor(() => expect(runner).toHaveBeenCalled());
		controller.abort();
		await recalling;
		expect(Date.now() - started).toBeLessThan(2000);
		expect(errors).toEqual([]);
	});

	it("removes secrets from the message, and keeps a message with a private key on this computer", async () => {
		writeMemories(THREE);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => '{"ids":[1]}');
		const instance = manager(PICKER, runner);
		await instance.recall("api_key = sk-very-secret 这个能用吗");
		expect(runner.mock.calls[0][0].task).not.toContain("sk-very-secret");
		runner.mockClear();
		// Put together here, so the release audit does not read the fixture as real key material.
		await instance.recall(`${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nabc`);
		expect(runner).not.toHaveBeenCalled();
	});

	it("leaves the resident profile out of the list and still sends it", async () => {
		writeMemories([...THREE, ["用户画像", "画像正文。"]]);
		const runner = vi.fn<AutoMemoryModelRunner>(async () => '{"ids":[1]}');
		const recalled = await manager(PICKER, runner).recall("随便问问");
		expect(runner.mock.calls[0][0].task).not.toContain("用户画像");
		expect(String(recalled?.content)).toContain("画像正文。");
		expect(cardsOf(recalled)).toEqual(["global/用户画像", "global/喝茶"]);
	});

	it("sends the picked cards even when the profile and the directory use up the total budget", async () => {
		const filler: Array<[string, string]> = Array.from({ length: 200 }, (_, index) => [
			`很长的名字用来占满目录位置${index}`,
			"正文",
		]);
		writeMemories([...filler, ["用户画像", "画".repeat(3400)], ["被选中的", "被选中的正文。"]]);
		const recalled = await manager(PICKER, async () => '{"ids":[201]}').recall("随便问问");
		expect(String(recalled?.content)).toContain("被选中的正文。");
	});
});

describe("Memory picker inside a run", () => {
	const harnesses: Harness[] = [];
	const sharedDataRoot = process.env.MYHARNESS_DATA_ROOT;

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		delete process.env[ENV_AGENT_DIR];
		if (sharedDataRoot === undefined) delete process.env.MYHARNESS_DATA_ROOT;
		else process.env.MYHARNESS_DATA_ROOT = sharedDataRoot;
		vi.restoreAllMocks();
	});

	async function pickerHarness(tools?: AgentTool[]): Promise<Harness> {
		// Tests in a file share one data folder by default, and memories moved into it would pile up from test to test.
		process.env.MYHARNESS_DATA_ROOT = join(testRoot, "run-data");
		const harness = await createHarness({ persisted: true, tools });
		harnesses.push(harness);
		process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
		const model = harness.getModel();
		harness.settingsManager.setAutoMemorySettings({
			enabled: true,
			provider: model.provider,
			model: model.id,
			thinkingLevel: "high",
		});
		harness.settingsManager.setMemoryPickerSettings({ enabled: true, provider: model.provider, model: model.id });
		const memoryDir = join(harness.tempDir, "agent", "memory", "global");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(
			join(memoryDir, "source-first.md"),
			memoryFile("global/source-first", "source-first", "先检查真实源码。", "2025-01-01T00:00:00.000Z"),
		);
		return harness;
	}

	/** The picker's request stays open until `answer` is called or the run is stopped. */
	function holdPicker(harness: Harness) {
		let answer: (text: string) => void = () => {};
		let started: () => void = () => {};
		const asked = new Promise<void>((resolve) => {
			started = resolve;
		});
		const spy = vi.spyOn(harness.session.modelRuntime, "completeSimple").mockImplementation(
			(_model, _context, options) =>
				new Promise((resolve) => {
					answer = (text) => resolve(fauxAssistantMessage(text));
					options?.signal?.addEventListener("abort", () =>
						resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					);
					started();
				}),
		);
		return { asked, spy, answer: (text: string) => answer(text) };
	}

	it("acknowledges the message and shows a running task while the picker is still working", async () => {
		const harness = await pickerHarness();
		const picker = holdPicker(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);
		const acknowledged = vi.fn();
		const prompting = harness.session.prompt("检查真实源码", { preflightResult: acknowledged });
		await picker.asked;
		expect(acknowledged).toHaveBeenCalledWith(true);
		expect(harness.session.isStreaming).toBe(true);
		picker.answer('{"ids":[1]}');
		await prompting;
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("puts the memories right after the user's message, where they always were", async () => {
		const harness = await pickerHarness();
		const picker = holdPicker(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);
		const prompting = harness.session.prompt("检查真实源码");
		await picker.asked;
		picker.answer('{"ids":[1]}');
		await prompting;
		const kinds = harness.session.messages.map((message) =>
			message.role === "custom" ? message.customType : message.role,
		);
		expect(kinds.indexOf("auto-memory-recall")).toBe(kinds.indexOf("user") + 1);
		expect(kinds.indexOf("assistant")).toBeGreaterThan(kinds.indexOf("auto-memory-recall"));
		const recall = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "auto-memory-recall",
		);
		expect(JSON.stringify(recall)).toContain("先检查真实源码。");
	});

	it("keeps the message and ends the run at once when Stop is pressed during the pick", async () => {
		const harness = await pickerHarness();
		const picker = holdPicker(harness);
		harness.setResponses([fauxAssistantMessage("must not be sent")]);
		const prompting = harness.session.prompt("检查真实源码");
		await picker.asked;
		await harness.session.abort();
		await prompting;
		expect(getUserTexts(harness)).toEqual(["检查真实源码"]);
		expect(getAssistantTexts(harness).join("")).not.toContain("must not be sent");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(harness.session.isStreaming).toBe(false);

		// The next message starts normally.
		picker.spy.mockImplementation(async () => fauxAssistantMessage('{"ids":[]}'));
		harness.setResponses([fauxAssistantMessage("second reply")]);
		await harness.session.prompt("下一条");
		expect(getUserTexts(harness)).toEqual(["检查真实源码", "下一条"]);
		expect(getAssistantTexts(harness).join("")).toContain("second reply");
	});

	it("delivers a message sent during the pick after the first one", async () => {
		const harness = await pickerHarness();
		const picker = holdPicker(harness);
		harness.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);
		const prompting = harness.session.prompt("检查真实源码");
		await picker.asked;
		await harness.session.prompt("第二条", { streamingBehavior: "steer" });
		picker.answer('{"ids":[1]}');
		// The second message is delivered next and gets its own pick.
		await vi.waitFor(() => expect(picker.spy).toHaveBeenCalledTimes(2));
		picker.answer('{"ids":[]}');
		await prompting;
		expect(getUserTexts(harness)).toEqual(["检查真实源码", "第二条"]);
	});

	describe("messages sent while a task runs", () => {
		const addMemory = (harness: Harness, name: string, body: string) =>
			writeFileSync(
				join(harness.tempDir, "agent", "memory", "global", `${name}.md`),
				memoryFile(`global/${name}`, name, body, "2025-01-02T00:00:00.000Z"),
			);

		/** The picker answers by looking at the message it was given, so each message's own text decides the cards. */
		function pickerByMessage(harness: Harness) {
			const questions: string[] = [];
			const spy = vi
				.spyOn(harness.session.modelRuntime, "completeSimple")
				.mockImplementation(async (_model, context) => {
					if (!context.systemPrompt?.includes("You choose which saved memories"))
						return fauxAssistantMessage("{}");
					const task = JSON.stringify(context.messages);
					const question = task.slice(task.indexOf("User's message:"));
					questions.push(question);
					const row = (name: string) => new RegExp(`(\\d+) \\| ${name} \\|`).exec(task)?.[1];
					const ids = ["source-first", "umbrella"].filter((name) => question.includes(name)).map(row);
					return fauxAssistantMessage(JSON.stringify({ ids: ids.map(Number) }));
				});
			return { spy, questions };
		}

		const kinds = (harness: Harness) =>
			harness.session.messages.map((message) => {
				if (message.role === "custom") return message.customType === "auto-memory-recall" ? "recall" : "other";
				return message.role === "user" ? `user:${getText(message)}` : message.role;
			});
		const getText = (message: { content: unknown }) =>
			typeof message.content === "string"
				? message.content
				: (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
		const recalls = (harness: Harness) =>
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "auto-memory-recall",
			);
		const fileOrder = (harness: Harness) =>
			harness.sessionManager.getEntries().flatMap((entry) => {
				if (entry.type === "custom_message" && entry.customType === "auto-memory-recall") return ["recall"];
				if (entry.type === "message" && entry.message.role === "user") return [`user:${getText(entry.message)}`];
				return [];
			});

		it("looks up memories for a queued message by its own text and has them in its request", async () => {
			const harness = await pickerHarness();
			addMemory(harness, "umbrella", "雨伞在第二个柜子里。");
			const picker = pickerByMessage(harness);
			let releaseFirst: () => void = () => {};
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let secondRequest: string | undefined;
			harness.setResponses([
				async () => {
					await firstHeld;
					return fauxAssistantMessage("first reply");
				},
				(context) => {
					secondRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("second reply");
				},
			]);
			const prompting = harness.session.prompt("source-first 怎么做");
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			await harness.session.prompt("umbrella 放在哪", { streamingBehavior: "followUp" });
			releaseFirst();
			await prompting;

			expect(picker.questions.at(-1)).toContain("umbrella 放在哪");
			expect(kinds(harness)).toEqual(
				expect.arrayContaining(["user:source-first 怎么做", "recall", "user:umbrella 放在哪"]),
			);
			const list = kinds(harness);
			expect(list[list.indexOf("user:umbrella 放在哪") + 1]).toBe("recall");
			expect(secondRequest).toContain("雨伞在第二个柜子里。");
			// In the file too, in the same order, so a reopened chat has it.
			const entries = fileOrder(harness);
			expect(entries[entries.indexOf("user:umbrella 放在哪") + 1]).toBe("recall");
		});

		it("looks up memories for a steering message before the next request of the run", async () => {
			let releaseTool: () => void = () => {};
			const toolHeld = new Promise<void>((resolve) => {
				releaseTool = resolve;
			});
			const harness = await pickerHarness([
				{
					name: "wait_tool",
					label: "wait",
					description: "waits",
					parameters: Type.Object({}),
					execute: async () => {
						await toolHeld;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			]);
			addMemory(harness, "umbrella", "雨伞在第二个柜子里。");
			const picker = pickerByMessage(harness);
			let afterSteer: string | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait_tool", {}), { stopReason: "toolUse" }),
				(context) => {
					afterSteer = JSON.stringify(context.messages);
					return fauxAssistantMessage("after steer");
				},
			]);
			const prompting = harness.session.prompt("source-first 开始");
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			await harness.session.prompt("umbrella 也看一下", { streamingBehavior: "steer" });
			releaseTool();
			await prompting;

			expect(picker.questions.at(-1)).toContain("umbrella 也看一下");
			const list = kinds(harness);
			expect(list[list.indexOf("user:umbrella 也看一下") + 1]).toBe("recall");
			expect(afterSteer).toContain("雨伞在第二个柜子里。");
		});

		it("shows the message before the wait, and Stop during that wait sends nothing more", async () => {
			const harness = await pickerHarness();
			const picker = holdPicker(harness);
			let releaseFirst: () => void = () => {};
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			harness.setResponses([
				async () => {
					await firstHeld;
					return fauxAssistantMessage("first reply");
				},
				fauxAssistantMessage("must not be sent"),
			]);
			const prompting = harness.session.prompt("检查真实源码");
			await picker.asked;
			picker.answer('{"ids":[1]}');
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			await harness.session.prompt("第二条", { streamingBehavior: "followUp" });
			releaseFirst();
			// The second pick is running and has not answered: the message is already in the chat and out of the queue.
			await vi.waitFor(() => expect(picker.spy).toHaveBeenCalledTimes(2));
			expect(getUserTexts(harness)).toEqual(["检查真实源码", "第二条"]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);

			const recallsBefore = recalls(harness).length;
			const started = Date.now();
			await harness.session.abort();
			await prompting;
			expect(Date.now() - started).toBeLessThan(2000);
			expect(recalls(harness).length).toBe(recallsBefore);
			expect(getAssistantTexts(harness).join("")).not.toContain("must not be sent");
			expect(harness.session.isStreaming).toBe(false);
		});

		it("adds nothing when the cards are already in the conversation, and leaves earlier messages as they were", async () => {
			const harness = await pickerHarness();
			pickerByMessage(harness);
			let firstRequest: unknown[] = [];
			let secondRequest: unknown[] = [];
			let releaseFirst: () => void = () => {};
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			harness.setResponses([
				async (context) => {
					firstRequest = [...context.messages];
					await firstHeld;
					return fauxAssistantMessage("first reply");
				},
				(context) => {
					secondRequest = [...context.messages];
					return fauxAssistantMessage("second reply");
				},
			]);
			const prompting = harness.session.prompt("source-first 第一次");
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			await harness.session.prompt("source-first 第二次", { streamingBehavior: "followUp" });
			releaseFirst();
			await prompting;

			expect(recalls(harness)).toHaveLength(1);
			expect(JSON.stringify(secondRequest.slice(0, firstRequest.length))).toBe(JSON.stringify(firstRequest));
		});

		it("looks up once for messages delivered together, with both texts", async () => {
			const harness = await pickerHarness();
			addMemory(harness, "umbrella", "雨伞在第二个柜子里。");
			const picker = pickerByMessage(harness);
			harness.session.agent.followUpMode = "all";
			let releaseFirst: () => void = () => {};
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			harness.setResponses([
				async () => {
					await firstHeld;
					return fauxAssistantMessage("first reply");
				},
				fauxAssistantMessage("second reply"),
			]);
			const prompting = harness.session.prompt("随便聊聊");
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			const picksBefore = picker.questions.length;
			await harness.session.prompt("source-first 怎么做", { streamingBehavior: "followUp" });
			await harness.session.prompt("umbrella 放在哪", { streamingBehavior: "followUp" });
			releaseFirst();
			await prompting;

			expect(picker.questions.length).toBe(picksBefore + 1);
			expect(picker.questions.at(-1)).toContain("source-first 怎么做");
			expect(picker.questions.at(-1)).toContain("umbrella 放在哪");
		});

		it("does not look up again when a request is retried", async () => {
			const harness = await pickerHarness();
			const picker = pickerByMessage(harness);
			harness.settingsManager.applyOverrides({
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			});
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("reply"),
			]);
			await harness.session.prompt("source-first 怎么做");
			expect(picker.questions).toHaveLength(1);
			expect(recalls(harness)).toHaveLength(1);
			expect(getAssistantTexts(harness).join("")).toContain("reply");
		});

		it("still answers a queued message when the picker fails", async () => {
			const harness = await pickerHarness();
			let releaseFirst: () => void = () => {};
			const firstHeld = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			vi.spyOn(harness.session.modelRuntime, "completeSimple").mockRejectedValue(new Error("network down"));
			harness.setResponses([
				async () => {
					await firstHeld;
					return fauxAssistantMessage("first reply");
				},
				fauxAssistantMessage("second reply"),
			]);
			const prompting = harness.session.prompt("随便聊聊");
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
			await harness.session.prompt("第二条", { streamingBehavior: "followUp" });
			releaseFirst();
			await prompting;
			expect(getAssistantTexts(harness).join("")).toContain("second reply");
		});
	});

	it("still answers when the picker fails", async () => {
		const harness = await pickerHarness();
		vi.spyOn(harness.session.modelRuntime, "completeSimple").mockRejectedValue(new Error("network down"));
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.prompt("检查真实源码");
		expect(harness.getPendingResponseCount()).toBe(0);
		const recall = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "auto-memory-recall",
		);
		expect(JSON.stringify(recall)).toContain("先检查真实源码。");
	});
});
