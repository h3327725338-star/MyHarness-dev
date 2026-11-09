import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, ToolResultMessage } from "@myharness/ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@myharness/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/agent/runtime/session-runtime.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebHostHub } from "../src/modes/web/hub.ts";
import { registerScheduleRoutes } from "../src/modes/web/routes-schedules.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { setActiveScheduleService } from "../src/schedules/service.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { backgroundJobManager } from "../src/tools/shell/job-manager.ts";

// A real background process and two real chats run through the agent loop; Windows needs the time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

// A task that ends may show the system popup (WebHost.announceTaskEnd); here it is only recorded.
vi.mock("../src/utils/popup-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/popup-notification.ts")>();
	return { ...actual, showPopupNotification: vi.fn(() => true) };
});

const textOf = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** The text of the latest tool result the model was sent. */
const lastToolResult = (context: Context): string => {
	const results = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
	const last = results.at(-1);
	return last ? textOf(last) : "";
};

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out");
}

// A chat starts a background command, then schedules an Agent task to look at it later. The task runs in a new chat
// (schedules/service.ts → routes-schedules.ts createRunner), and that chat is the one that calls job_output.
describe("a scheduled Agent task and the background jobs of the chat that scheduled it", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let previousAgentDir: string | undefined;

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
	});

	function tempDir(prefix: string): string {
		const dir = join(
			process.env.MYHARNESS_TEMP_DIR ?? tmpdir(),
			`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		});
		return dir;
	}

	/** A hub whose primary chat is in a workspace folder, with the clock of scheduled tasks (it fires only by hand). */
	async function start() {
		const project = tempDir("myharness-schedule-jobs-project");
		const agentDir = tempDir("myharness-schedule-jobs-agent");
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir,
				modelRuntime,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
				cwd,
			});
			// Only the two chats may use the scripted answers.
			services.settingsManager.setConversationNamingSettings({ enabled: false });
			services.settingsManager.setAutoMemorySettings({ enabled: false });
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: project,
			agentDir,
			sessionManager: SessionManager.create(project),
		});
		const server = new WebHttpServer();
		const hub = new WebHostHub({ server, version: "test", onShutdown: () => {} });
		const primary = await hub.addPrimary(runtimeHost, new WebDialogBridge());
		const schedules = registerScheduleRoutes(server, hub, { agentDir, fire: false });
		cleanups.push(async () => {
			schedules.dispose();
			setActiveScheduleService(undefined);
			await backgroundJobManager.cancelAll();
			backgroundJobManager.clearRecords();
			await hub.dispose();
			await server.close();
			faux.unregister();
		});
		return { hub, primary, schedules, faux };
	}

	it("lets the new chat read the job that the scheduling chat started", async () => {
		const { hub, primary, schedules, faux } = await start();
		let taskId = "";
		faux.setResponses([
			fauxAssistantMessage(
				// It runs until the cleanup stops it: its end never starts anything in the chats while the test looks at them.
				fauxToolCall("bash", {
					command: `node -e "console.log('build step 1 done'); setInterval(() => {}, 1000)"`,
					run_in_background: true,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				taskId = /Started background job (job-[a-f0-9]+)/.exec(lastToolResult(context))?.[1] ?? "";
				return fauxAssistantMessage(
					fauxToolCall("schedule", {
						action: "create",
						kind: "agent",
						title: "Check the build",
						text: `Call job_output {"taskId": "${taskId}"} and tell me what the build printed.`,
						repeat: { type: "once", at: new Date(Date.now() + 10 * 60_000).toISOString() },
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxText("The build runs in the background; a check is scheduled in 10 minutes.")),
		]);
		await primary.submit("Start the build in the background and check on it in 10 minutes.");
		await waitUntil(() => primary.session.isIdle && faux.getPendingResponseCount() === 0);
		await primary.waitForCompletion();
		expect(taskId).toMatch(/^job-[a-f0-9]+$/);
		const task = schedules.snapshot().schedules.find((item) => item.kind === "agent");
		expect(task?.text).toContain(taskId);
		// The build is still running and has written its first line when the check runs.
		await waitUntil(
			async () => (await backgroundJobManager.readTail(taskId))?.text.includes("build step 1 done") ?? false,
		);
		expect(backgroundJobManager.get(taskId)?.status).toBe("running");

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("job_output", { taskId }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("The build printed its first step.")),
		]);
		const notice = await schedules.runNow(task!.id);
		const scheduled = hub.get(notice!.slot!)!;
		expect(scheduled.session.sessionId).not.toBe(primary.session.sessionId);
		const jobOutputResult = () =>
			scheduled.session.messages.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolName === "job_output",
			);
		await waitUntil(() => jobOutputResult() !== undefined);
		const result = jobOutputResult()!;
		expect({ isError: result.isError, text: textOf(result) }).toMatchObject({
			isError: false,
			text: expect.stringContaining("build step 1 done"),
		});
		expect(textOf(result)).toContain(`Job ${taskId} (started by another session; read-only here) — Status: running`);
		// The check did not use up the scheduling chat's unread output: its own job_output still gets all of it.
		const own = await backgroundJobManager.readOutput(taskId, undefined, primary.backgroundJobKey());
		expect(own?.increment).toContain("build step 1 done");
		// The new chat still lists only its own jobs (none).
		expect(backgroundJobManager.list(scheduled.backgroundJobKey())).toEqual([]);
	});
});
