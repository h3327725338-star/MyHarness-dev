import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import type { Tool } from "@myharness/ai";
import { runWindowsTaskkill } from "../../utils/child-process.ts";
import { createProcessJob, type WindowsProcessJob } from "../../utils/windows-job.ts";
import { BRIDGE_PLUGIN_HOOKS, BRIDGE_PLUGIN_MANIFEST, createBridgePluginSource } from "./bridge-plugin.ts";
import { findClaude, interactiveArguments, launchEnv, profileDirectory, providerDirectory } from "./config.ts";
import { type BridgeEvent, LocalBridge } from "./local-bridge.ts";

export interface InteractiveTerminal {
	pid: number;
	write(data: string): void;
	kill(): void;
	/** Release native terminal handles after the owned process tree has ended. */
	dispose?(): void;
	onData(callback: (data: string) => void): { dispose(): void };
	onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export type PtyFactory = (
	executable: string,
	args: string[],
	options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
) => InteractiveTerminal;

export function officialPty(
	executable: string,
	args: string[],
	options: Parameters<PtyFactory>[2],
): InteractiveTerminal {
	try {
		const pty = createRequire(import.meta.url)("@lydell/node-pty") as { spawn: PtyFactory };
		const terminal = pty.spawn(executable, args, options);
		let disposed = false;
		return {
			pid: terminal.pid,
			write: (data) => terminal.write(data),
			kill: () => terminal.kill(),
			dispose: () => {
				if (disposed) return;
				disposed = true;
				if (process.platform === "win32") {
					// @lydell/node-pty 1.1.0 has no separate native-resource disposer.
					// The owner has already ended the process tree, so its console-list
					// helper is both redundant and racy. Override only this PTY's lookup;
					// keep the library's native-handle, socket and worker cleanup intact.
					const agent = (
						terminal as InteractiveTerminal & {
							_agent?: { _getConsoleProcessList?: () => Promise<number[]> };
						}
					)._agent;
					if (typeof agent?._getConsoleProcessList === "function")
						agent._getConsoleProcessList = () => Promise.resolve([]);
				}
				terminal.kill();
			},
			onData: (callback) => terminal.onData(callback),
			onExit: (callback) => terminal.onExit(callback),
		};
	} catch (error) {
		throw new Error(
			`Claude Code 交互终端启动失败，请检查 @lydell/node-pty 和官方原生程序。${error instanceof Error ? ` ${error.message}` : ""}`,
		);
	}
}

export interface StartInteractiveSession {
	cwd: string;
	model: string;
	effort?: string;
	systemPrompt: string;
	tools: Tool[];
	contextWindow: number;
	maxOutputTokens?: number;
	sessionId?: string;
	resume?: boolean;
	signal?: AbortSignal;
}

/** Test seams do not accept credentials through stream options or rewrite any CLI request identity. */
export interface InteractiveDependencies {
	pty?: PtyFactory;
	bridge?: () => LocalBridge;
	executable?: () => string | undefined;
	profile?: () => string;
	dataDirectory?: () => string;
	environment?: (base: Record<string, string>) => Record<string, string>;
	startupTimeoutMs?: number;
}

export class InteractiveSession {
	readonly bridge: LocalBridge;
	readonly profile: string;
	claudeSessionId: string;
	cwd = "";
	signature = "";
	turnId?: string;
	ready = false;
	private terminal?: InteractiveTerminal;
	private terminalExited = false;
	private job?: WindowsProcessJob;
	private runDirectory?: string;
	private dataSubscription?: { dispose(): void };
	private exitSubscription?: { dispose(): void };
	private closed = false;
	private deadline?: ReturnType<typeof setTimeout>;
	private submitTimer?: ReturnType<typeof setTimeout>;
	private win32Input = false;
	private terminalTail = "";

	private readonly dependencies: InteractiveDependencies;
	constructor(dependencies: InteractiveDependencies = {}) {
		this.dependencies = dependencies;
		this.bridge = dependencies.bridge?.() || new LocalBridge();
		this.profile = dependencies.profile?.() || profileDirectory();
		this.claudeSessionId = randomUUID();
	}

	async start(options: StartInteractiveSession): Promise<void> {
		if (this.closed) throw new Error("Claude Code session is closed");
		const executable = this.dependencies.executable?.() || findClaude();
		if (!executable) throw new Error("未找到 Claude Code 原生程序；可用 MYHARNESS_CLAUDE_BIN 指定绝对路径。");
		if (options.signal?.aborted) throw new Error("Operation aborted");
		this.cwd = resolve(options.cwd);
		this.claudeSessionId = options.sessionId || randomUUID();
		const directory = this.dependencies.dataDirectory?.() || providerDirectory();
		mkdirSync(directory, { recursive: true });
		mkdirSync(this.profile, { recursive: true });
		this.runDirectory = mkdtempSync(join(directory, "interactive-run-"));
		const plugin = join(this.runDirectory, "plugin");
		mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
		mkdirSync(join(plugin, "hooks"), { recursive: true });
		this.bridge.configureTools(options.tools);
		await this.bridge.listen();
		const write = (file: string, value: string) => writeFileSync(file, value, { mode: 0o600 });
		write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify(BRIDGE_PLUGIN_MANIFEST));
		write(join(plugin, "hooks", "hooks.json"), JSON.stringify(BRIDGE_PLUGIN_HOOKS));
		write(
			join(plugin, "hooks", "register.js"),
			createBridgePluginSource({ url: this.bridge.url, token: this.bridge.token }),
		);
		const promptFile = join(this.runDirectory, "system.txt");
		const mcpFile = join(this.runDirectory, "mcp.json");
		const settingsFile = join(this.runDirectory, "settings.json");
		// Exact host system text. No Claude default/append prompt and no bridge prose is prepended here.
		write(promptFile, options.systemPrompt);
		write(
			mcpFile,
			JSON.stringify({
				mcpServers: options.tools.length
					? {
							myharness: {
								type: "http",
								url: `${this.bridge.url}/mcp`,
								headers: { Authorization: `Bearer ${this.bridge.token}` },
							},
						}
					: {},
			}),
		);
		write(
			settingsFile,
			JSON.stringify({
				autoCompactEnabled: true,
				autoMemoryEnabled: false,
				disableBundledSkills: true,
				promptSuggestionEnabled: false,
				syncClaudeAiPlugins: false,
				enabledPlugins: {},
				permissions: { allow: options.tools.map((tool) => `mcp__myharness__${tool.name}`) },
			}),
		);
		const args = interactiveArguments({
			...options,
			promptFile,
			mcpFile,
			settingsFile,
			pluginDirectory: plugin,
			sessionId: this.claudeSessionId,
		});
		const env = launchEnv(process.env, options.maxOutputTokens, options.contextWindow, this.profile);
		this.terminal = (this.dependencies.pty || officialPty)(executable, args, {
			cwd: this.cwd,
			env: this.dependencies.environment?.(env) || env,
			cols: 120,
			rows: 40,
			name: "xterm-256color",
		});
		this.job = this.terminal.pid > 0 ? createProcessJob(this.terminal.pid) : undefined;
		// Read only standard terminal control sequences. Model output, usage and readiness come from the Mod.
		this.dataSubscription = this.terminal.onData((data) => {
			this.terminalTail = `${this.terminalTail}${data}`.slice(-64);
			for (const match of this.terminalTail.matchAll(/\u001b\[\?9001([hl])/g)) this.win32Input = match[1] === "h";
			if (this.terminalTail.includes("\u001b[6n")) {
				this.terminal?.write("\u001b[1;1R");
				this.terminalTail = "";
			}
		});
		this.exitSubscription = this.terminal.onExit((event) => {
			this.terminalExited = true;
			this.ready = false;
			this.job?.close();
			this.job = undefined;
			if (!this.closed)
				this.bridge.events.fail(
					new Error(
						`Claude Code exited before the bridge completed (code ${event.exitCode}). Check login/onboarding in the isolated profile.`,
					),
				);
		});
		const deadline = Date.now() + (this.dependencies.startupTimeoutMs || 45_000);
		while (Date.now() < deadline) {
			let event: BridgeEvent;
			try {
				event = await this.bridge.events.next(options.signal, Math.max(1, deadline - Date.now()));
			} catch (error) {
				if (!options.signal?.aborted && (error as Error).message.includes("timed out"))
					throw new Error(
						"Claude Code 尚未就绪：请先在独立配置目录中完成官方登录、当前项目的信任确认，并确认 CLI 支持且允许加载 Mod。",
					);
				throw error;
			}
			if (event.type === "fatal" || event.type === "bridge_error")
				throw new Error("Claude Code Mod bridge failed during startup");
			if (event.type !== "ready") continue;
			if (
				typeof event.sessionId !== "string" ||
				event.sessionId !== this.claudeSessionId ||
				!Array.isArray(event.surfaces) ||
				!event.surfaces.includes("terminal")
			)
				throw new Error("Claude Code did not report the expected interactive terminal session");
			this.ready = true;
			return;
		}
		throw new Error(
			"Claude Code Mod bridge is unavailable. Use the isolated profile to finish official login/onboarding; a Mod-capable CLI with permitted plugin execution is required.",
		);
	}

	submit(text: string): string {
		if (!this.ready || !this.terminal || this.closed) throw new Error("Claude Code interactive session is not ready");
		const nonce = this.bridge.addInput({ text });
		// A plain short typed token avoids terminal escape sequences, command interpretation and long-paste truncation.
		// The official prompt.submit hook replaces the text, preserving the engine's original input origin.
		this.terminal.write(`MYHARNESS_INPUT_${nonce}`);
		// The Windows CLI requests Win32 input mode (?9001h). A bare CR there can select
		// the wrong dialog item; send an actual Enter key-down/up in that negotiated mode.
		// A short separate press also lets the interactive prompt consume the text before submission.
		this.submitTimer = setTimeout(() => {
			this.submitTimer = undefined;
			if (!this.closed)
				this.terminal?.write(this.win32Input ? "\u001b[13;28;13;1;0;1_\u001b[13;28;13;0;0;1_" : "\r");
		}, 250);
		return nonce;
	}
	next(signal?: AbortSignal, timeoutMs = 60_000): Promise<BridgeEvent> {
		return this.bridge.events.next(signal, timeoutMs);
	}

	interrupt(): void {
		if (this.closed) return;
		if (this.turnId) this.bridge.command("cancel", { turnId: this.turnId });
		if (this.deadline) clearTimeout(this.deadline);
		this.deadline = setTimeout(() => {
			void this.close();
		}, 1500);
		this.deadline.unref();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.ready = false;
		if (this.deadline) clearTimeout(this.deadline);
		if (this.submitTimer) clearTimeout(this.submitTimer);
		this.dataSubscription?.dispose();
		const terminal = this.terminal;
		this.terminal = undefined;
		if (terminal) {
			if (process.platform === "win32" && terminal.pid > 0) {
				if (!this.terminalExited && !this.job?.terminate())
					await runWindowsTaskkill(terminal.pid).catch(() => undefined);
				// Release the ConPTY worker/handles even after a natural CLI exit;
				// this adapter skips the now-redundant console enumeration helper.
				terminal.dispose?.();
			} else if (!this.terminalExited) {
				try {
					terminal.kill();
				} catch {
					/* The PTY may have just exited. */
				}
			}
		}
		this.job?.close();
		this.job = undefined;
		this.exitSubscription?.dispose();
		await this.bridge.close();
		// Only this instance's freshly-created directory is ever removed, never the isolated profile or transcripts.
		if (this.runDirectory) {
			const parent = resolve(this.dependencies.dataDirectory?.() || providerDirectory());
			const target = resolve(this.runDirectory);
			if (target.startsWith(`${parent}${sep}`) && target !== parent)
				rmSync(target, { recursive: true, force: true });
			this.runDirectory = undefined;
		}
	}
}
