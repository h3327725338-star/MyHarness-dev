import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { InteractiveSession, type InteractiveTerminal } from "../src/providers/claude-code/interactive-session.ts";
import { runWindowsTaskkill } from "../src/utils/child-process.ts";
import { createProcessJob } from "../src/utils/windows-job.ts";

vi.mock("../src/utils/child-process.ts", () => ({ runWindowsTaskkill: vi.fn() }));
vi.mock("../src/utils/windows-job.ts", () => ({ createProcessJob: vi.fn() }));

describe.skipIf(process.platform !== "win32")("Claude Code Windows terminal shutdown", () => {
	let root: string;
	let session: InteractiveSession | undefined;
	let terminal: InteractiveTerminal;
	let onExit: ((event: { exitCode: number }) => void) | undefined;
	let terminate: Mock<() => boolean>;
	let closeJob: Mock<() => void>;

	beforeEach(() => {
		vi.resetAllMocks();
		root = mkdtempSync(join(tmpdir(), "myharness-claude-shutdown-"));
		session = undefined;
		onExit = undefined;
		terminate = vi.fn(() => true);
		closeJob = vi.fn<() => void>();
		vi.mocked(createProcessJob).mockReturnValue({ terminate, close: closeJob });
		vi.mocked(runWindowsTaskkill).mockResolvedValue();
		terminal = {
			pid: 12345,
			write: vi.fn(),
			kill: vi.fn(),
			dispose: vi.fn(),
			onData: vi.fn(() => ({ dispose: vi.fn() })),
			onExit: vi.fn((callback) => {
				onExit = callback;
				return { dispose: vi.fn() };
			}),
		};
	});

	afterEach(async () => {
		await session?.close();
		rmSync(root, { recursive: true, force: true });
	});

	async function start(): Promise<InteractiveSession> {
		const data = join(root, "data");
		mkdirSync(data);
		session = new InteractiveSession({
			pty: (_executable, args) => {
				const sessionId = args[args.indexOf("--session-id") + 1];
				queueMicrotask(() => {
					session!.bridge.events.push({ type: "ready", seq: 1, sessionId, surfaces: ["terminal"] });
				});
				return terminal;
			},
			executable: () => "C:\\fixture\\claude.exe",
			profile: () => join(root, "profile"),
			dataDirectory: () => data,
			startupTimeoutMs: 1000,
		});
		await session.start({ cwd: root, model: "fixture", systemPrompt: "fixture", tools: [], contextWindow: 200_000 });
		return session;
	}

	it("terminates its Job once without forking node-pty's Electron helper", async () => {
		const active = await start();
		await active.close();
		await active.close();
		expect(createProcessJob).toHaveBeenCalledWith(12345);
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(closeJob).toHaveBeenCalledTimes(1);
		expect(runWindowsTaskkill).not.toHaveBeenCalled();
		expect(terminal.kill).not.toHaveBeenCalled();
		expect(terminal.dispose).toHaveBeenCalledOnce();
		expect(active.ready).toBe(false);
		expect(readdirSync(join(root, "data"))).toEqual([]);
		await expect(fetch(active.bridge.url)).rejects.toThrow();
	});

	it("awaits taskkill when the Job could not be created", async () => {
		vi.mocked(createProcessJob).mockReturnValue(undefined);
		const active = await start();
		await active.close();
		expect(runWindowsTaskkill).toHaveBeenCalledExactlyOnceWith(12345);
		expect(terminal.kill).not.toHaveBeenCalled();
		expect(terminal.dispose).toHaveBeenCalledOnce();
	});

	it("falls back to taskkill when Job termination fails", async () => {
		terminate.mockReturnValue(false);
		const active = await start();
		await active.close();
		expect(runWindowsTaskkill).toHaveBeenCalledExactlyOnceWith(12345);
		expect(closeJob).toHaveBeenCalledOnce();
		expect(terminal.kill).not.toHaveBeenCalled();
		expect(terminal.dispose).toHaveBeenCalledOnce();
	});

	it("does not target an exited terminal's potentially recycled pid", async () => {
		const active = await start();
		onExit!({ exitCode: 0 });
		await active.close();
		expect(terminate).not.toHaveBeenCalled();
		expect(runWindowsTaskkill).not.toHaveBeenCalled();
		expect(terminal.kill).not.toHaveBeenCalled();
		expect(terminal.dispose).toHaveBeenCalledOnce();
		expect(closeJob).toHaveBeenCalledOnce();
	});

	it("keeps pid-less test terminal cleanup on its own adapter", async () => {
		terminal.pid = 0;
		const active = await start();
		await active.close();
		expect(createProcessJob).not.toHaveBeenCalled();
		expect(runWindowsTaskkill).not.toHaveBeenCalled();
		expect(terminal.kill).toHaveBeenCalledOnce();
	});
});
