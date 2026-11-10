import { execFile } from "node:child_process";
import type { Model, Provider } from "@myharness/ai";
import { createProvider } from "@myharness/ai";
import type { ExtensionAPI, ExtensionContext } from "../../extensions/runtime/types.ts";
import {
	CLAUDE_CODE_PROVIDER_ID,
	findClaude,
	launchEnv,
	OUTPUT_LIMIT_NOTE,
	outputLimitNote,
	parseContextWindow,
	profileDirectory,
	readContextWindow,
	STRIPPED_ENV,
	saveContextWindow,
} from "./config.ts";
import { ClaudeCodeRuntime } from "./runtime.ts";

/** Auth stays inside the official isolated CLI profile; no token is read, copied or stored by MyHarness. */
export async function isolatedLoginAvailable(): Promise<boolean> {
	const executable = findClaude();
	if (!executable) return false;
	return new Promise((resolve) => {
		execFile(
			executable,
			["auth", "status", "--json"],
			{
				env: launchEnv(process.env, undefined, readContextWindow()),
				timeout: 10_000,
				windowsHide: true,
				maxBuffer: 32_768,
			},
			(error, stdout) => {
				if (error) {
					resolve(false);
					return;
				}
				try {
					resolve(JSON.parse(stdout).loggedIn === true);
				} catch {
					resolve(false);
				}
			},
		);
	});
}

export function isolatedSetupCommand(): string {
	const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
	// Start-Process passes this native argument string unchanged on Windows PowerShell 5.1 too.
	// Calling & with '' directly drops the empty --tools argument and removes JSON quotes there.
	const args =
		'--restricted --setting-sources project --tools "" --strict-mcp-config --mcp-config "{\\"mcpServers\\":{}}"';
	// Keep terminal setup as isolated as inference, without changing the caller's terminal environment.
	const env = launchEnv({}, undefined, readContextWindow());
	const names = [...new Set([...STRIPPED_ENV, ...Object.keys(env)])].map(quote).join(",");
	const set = Object.entries(env)
		.map(([name, value]) => `$env:${name}=${quote(value)}`)
		.join("; ");
	return `& { $names=@(${names}); $saved=@{}; foreach ($name in $names) { $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }; try { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }; ${set}; Start-Process -FilePath ${quote(findClaude() || "claude.exe")} -ArgumentList ${quote(args)} -NoNewWindow -Wait } finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') } } }`;
}

const MODEL_CHOICES = [
	{ id: "claude-opus-5-5", name: "Claude Code · Opus 5.5" },
	{ id: "claude-sonnet-5-5", name: "Claude Code · Sonnet 5.5" },
	{ id: "claude-fable-5-2", name: "Claude Code · Fable 5.2" },
	{ id: "claude-fable-5-1", name: "Claude Code · Fable 5.1" },
	{ id: "claude-haiku-5-5", name: "Claude Code · Haiku 5.5" },
];

interface SharedRuntime {
	runtime: ClaudeCodeRuntime;
	contexts: Map<string, ExtensionContext>;
}
const SHARED_KEY = Symbol.for("myharness.claude-code-interactive.v1");
function sharedRuntime(): SharedRuntime {
	const registry = globalThis as typeof globalThis & { [SHARED_KEY]?: SharedRuntime };
	if (!registry[SHARED_KEY]) {
		const contexts = new Map<string, ExtensionContext>();
		const runtime = new ClaudeCodeRuntime({
			cwd: (id) => (id ? contexts.get(id)?.cwd : undefined) || process.cwd(),
			onMeasure: (id, event) => {
				const limits = event.rateLimits as { kind?: string; percentUsed?: number }[] | undefined;
				const text = limits
					?.filter((entry) => typeof entry.percentUsed === "number")
					.map((entry) => `${entry.kind || "额度"} ${entry.percentUsed}%`)
					.join(" · ");
				contexts.get(id)?.ui.setStatus("claude-code-quota", text || undefined);
			},
		});
		registry[SHARED_KEY] = { runtime, contexts };
	}
	return registry[SHARED_KEY]!;
}

export function createClaudeCodeProvider(runtime: ClaudeCodeRuntime): Provider {
	const models: Model<any>[] = MODEL_CHOICES.map((choice) => ({
		...choice,
		api: "claude-code-cli",
		provider: CLAUDE_CODE_PROVIDER_ID,
		baseUrl: "claude-code://interactive",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		// The public Mod API has no byte-bearing input attachment field. Do not advertise unverified inline vision.
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: readContextWindow(),
		managesOwnContext: true,
		maxTokens: 64_000,
	}));
	return {
		...createProvider({
			id: CLAUDE_CODE_PROVIDER_ID,
			name: "Claude Code · Interactive",
			baseUrl: "claude-code://interactive",
			auth: {
				apiKey: {
					name: "Claude Code 独立配置中的登录",
					async check() {
						return (await isolatedLoginAvailable())
							? { type: "api_key", source: "Claude Code 独立配置" }
							: undefined;
					},
					async resolve() {
						return (await isolatedLoginAvailable())
							? { auth: { apiKey: "local-claude-code-profile" }, source: "Claude Code 独立配置" }
							: undefined;
					},
					externalLogin: () => ({
						instructions:
							"在项目目录的 PowerShell 中执行下面的命令，按官方终端完成首次设置、登录和该项目的信任确认，然后退出 Claude Code，回到这里点击“检查登录状态”。此配置独立于个人 Claude Code；MyHarness 不保存账户 Token，也无需填写 API Key。",
						command: isolatedSetupCommand(),
					}),
				},
			},
			models,
			api: {
				stream: (model, context, options) => runtime.stream(model, context, options),
				streamSimple: (model, context, options) => runtime.stream(model, context, options),
			},
		}),
		logout: () => runtime.close(),
		getDiagnostics: () => ({
			transport: "official-interactive-conpty-mod",
			ownBusinessTools: false,
			systemPrompt: "host-replacement",
			profile: profileDirectory(),
			subscriptionWeight: "not-measured",
			inlineImageInput: false,
		}),
		settings: [
			{
				id: "context-length",
				label: "上下文长度",
				placeholder: "1M",
				description: "Claude Code 自动压缩的上下文长度，100K 到 1M，下一轮生效。",
				get: () => String(readContextWindow()),
				set: (value) => {
					const tokens = parseContextWindow(value);
					if (!tokens) throw new Error("上下文长度应在 100K 到 1M 之间，例如 300k。");
					saveContextWindow(tokens);
					for (const model of models) model.contextWindow = tokens;
				},
			},
		],
	};
}

export function registerClaudeCodeProvider(pi: ExtensionAPI): void {
	const shared = sharedRuntime();
	pi.registerProvider(createClaudeCodeProvider(shared.runtime));
	const remember = (ctx: ExtensionContext) => {
		shared.contexts.set(ctx.sessionManager.getSessionId(), ctx);
		// Legacy sessions may keep the old passive-card tool enabled. It is not registered or offered anymore.
		const active = pi.getActiveTools();
		if (active.includes("claude_code_tool")) pi.setActiveTools(active.filter((name) => name !== "claude_code_tool"));
	};
	pi.on("session_start", async (_event, ctx) => {
		remember(ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		remember(ctx);
		if (event.model.provider !== CLAUDE_CODE_PROVIDER_ID)
			await shared.runtime.reset(ctx.sessionManager.getSessionId());
	});
	pi.on("session_tree", async (_event, ctx) => {
		await shared.runtime.reset(ctx.sessionManager.getSessionId());
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		await shared.runtime.reset(id, false);
		shared.contexts.delete(id);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.provider !== CLAUDE_CODE_PROVIDER_ID) return undefined;
		const result = await shared.runtime.compact(
			ctx.sessionManager.getSessionId(),
			event.customInstructions,
			event.signal,
		);
		if (!result) return undefined;
		return { compaction: { ...result, firstKeptEntryId: event.preparation.firstKeptEntryId } };
	});
	pi.on("session_compact", async (_event, ctx) => {
		await shared.runtime.reset(ctx.sessionManager.getSessionId());
	});
	pi.on("turn_end", async (event) => {
		const message = event.message;
		if (
			message.role === "assistant" &&
			message.provider === CLAUDE_CODE_PROVIDER_ID &&
			message.stopReason === "length"
		)
			pi.sendMessage(
				{ customType: OUTPUT_LIMIT_NOTE, content: outputLimitNote(message), display: false },
				{ deliverAs: "followUp" },
			);
	});
	pi.registerCommand("context-length", {
		description: "设置 Claude Code 自动压缩长度，例如 /context-length 300k",
		handler: async (args, ctx) => {
			const value = parseContextWindow(args);
			if (!value) {
				ctx.ui.notify(`当前 ${readContextWindow()} token；输入 /context-length 300k 设置，范围 100K–1M。`, "info");
				return;
			}
			saveContextWindow(value);
			ctx.ui.notify(`上下文长度已设为 ${value} token，下一轮生效。`, "info");
		},
	});
}
