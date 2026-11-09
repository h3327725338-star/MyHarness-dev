import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const MCP_PREFIX = "mcp__myharness__";
export const OUTPUT_LIMIT_NOTE = "claude-code-output-limit";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const APP_TOOL_TIMEOUT_MS = 24 * 3_600_000;

export function providerDirectory(): string {
	return join(process.env.MYHARNESS_CODING_AGENT_DIR || join(homedir(), ".myharness", "agent"), "claude-code-shell");
}

function realTarget(path: string): string {
	const suffix: string[] = [];
	let parent = resolve(path);
	while (!existsSync(parent) && dirname(parent) !== parent) {
		suffix.unshift(basename(parent));
		parent = dirname(parent);
	}
	return resolve(realpathSync(parent), ...suffix).toLowerCase();
}

export function profileDirectory(): string {
	const profile = resolve(process.env.MYHARNESS_CLAUDE_CONFIG_DIR || join(providerDirectory(), "interactive-profile"));
	const target = realTarget(profile);
	const personal = realTarget(join(homedir(), ".claude"));
	if (target === personal || target.startsWith(`${personal}${sep}`) || target === realTarget(homedir())) {
		throw new Error("请选择独立的 Claude Code 配置目录；当前目录保留给个人 Claude Code。");
	}
	// An independent directory must not link its account/configuration files back to another profile.
	for (const name of [".credentials.json", ".claude.json", "settings.json"]) {
		const file = join(profile, name);
		try {
			if (lstatSync(file).isSymbolicLink()) throw new Error("Claude Code 独立配置中的账户和设置文件应为普通文件。");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return profile;
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const delta = (a[index] || 0) - (b[index] || 0);
		if (delta) return delta;
	}
	return 0;
}

/** Locates the official executable without launching a shell or reading any account data. */
export function findClaude(): string | undefined {
	const override = process.env.MYHARNESS_CLAUDE_BIN;
	if (override) {
		if (!isAbsolute(override) || !existsSync(override))
			throw new Error("MYHARNESS_CLAUDE_BIN 应指向现有程序的绝对路径。");
		return override;
	}
	const root = process.env.APPDATA && join(process.env.APPDATA, "Claude", "claude-code");
	if (root && existsSync(root)) {
		for (const version of readdirSync(root)
			.filter((name) => /^\d+(\.\d+)*$/.test(name))
			.sort(compareVersions)
			.reverse()) {
			for (const build of readdirSync(join(root, version))) {
				const executable = join(root, version, build, "claude.exe");
				if (existsSync(executable)) return executable;
			}
		}
	}
	for (const directory of [join(homedir(), ".local", "bin"), ...(process.env.PATH || "").split(delimiter)]) {
		if (!directory) continue;
		const executable = join(directory, process.platform === "win32" ? "claude.exe" : "claude");
		if (existsSync(executable)) return executable;
	}
	return undefined;
}

export const STRIPPED_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ELECTRON_RUN_AS_NODE",
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SIMPLE",
	"CLAUDE_CODE_SAFE_MODE",
	"DISABLE_AUTO_COMPACT",
	"DISABLE_COMPACT",
	"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
	"CLAUDE_CODE_PLUGIN_DIRS",
	"CLAUDE_CODE_IGNORE_PERSISTED_TRUST",
] as const;

/** No entrypoint/identity override: the executable decides it is interactive from its real TTY. */
export function launchEnv(
	base: NodeJS.ProcessEnv,
	maxOutputTokens: number | undefined,
	contextWindow: number,
	profile = profileDirectory(),
): Record<string, string> {
	const env: Record<string, string> = {};
	const stripped = new Set<string>(STRIPPED_ENV);
	const overridden = new Set([
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW",
		"MCP_TOOL_TIMEOUT",
		"CLAUDE_CODE_DISABLE_CLAUDE_MDS",
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY",
		"CLAUDE_CODE_DISABLE_BUNDLED_SKILLS",
		"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
		"CLAUDE_CODE_DISABLE_CRON",
		"CLAUDE_CODE_DISABLE_AGENT_VIEW",
		"TERM",
		"COLORTERM",
	]);
	// Environment names are case-insensitive on Windows, including when the parent is Electron.
	for (const [key, value] of Object.entries(base))
		if (value !== undefined && !stripped.has(key.toUpperCase()) && !overridden.has(key.toUpperCase()))
			env[key] = value;
	env.CLAUDE_CONFIG_DIR = profile;
	env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
	env.MCP_TOOL_TIMEOUT = String(APP_TOOL_TIMEOUT_MS);
	env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
	env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
	env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
	env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
	env.CLAUDE_CODE_DISABLE_CRON = "1";
	env.CLAUDE_CODE_DISABLE_AGENT_VIEW = "1";
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	if (maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
	return env;
}

export function parseContextWindow(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.trim().replace(/[,_]/g, ""));
	if (!match) return undefined;
	const number = Number(match[1]);
	const tokens = Math.round(
		number * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] || number <= 1000 ? 1000 : 1),
	);
	return tokens >= 100_000 && tokens <= 1_000_000 ? tokens : undefined;
}

export function readContextWindow(): number {
	for (const name of ["interactive-settings.json", "settings.json"]) {
		try {
			const parsed = parseContextWindow(
				String(JSON.parse(readFileSync(join(providerDirectory(), name), "utf8")).contextWindow),
			);
			if (parsed) return parsed;
		} catch {
			/* Older host context-length settings remain readable without changing them. */
		}
	}
	return DEFAULT_CONTEXT_WINDOW;
}

export function saveContextWindow(value: number): void {
	const file = join(providerDirectory(), "interactive-settings.json");
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify({ contextWindow: value }), { mode: 0o600 });
	renameSync(temporary, file);
}

export function outputLimitFor(model: { maxTokens?: number }, requested?: number): number | undefined {
	const values = [model.maxTokens, requested].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
	return values.length ? Math.floor(Math.min(...values)) : undefined;
}

export function outputLimitNote(message: { content?: { type: string; text?: string }[] }): string {
	return message.content?.some((part) => part.type === "text" && part.text?.trim())
		? "[system-reminder] MyHarness stopped the previous response at its output limit, not the user. Go on from where it stopped without repeating it; keep each response within the limit."
		: "[system-reminder] MyHarness stopped the previous response at its output limit, not the user. Go on with the task; think much more briefly and keep each response within the limit.";
}

export interface InteractiveLaunch {
	model: string;
	promptFile: string;
	mcpFile: string;
	settingsFile: string;
	pluginDirectory: string;
	contextWindow: number;
	sessionId: string;
	resume?: boolean;
	effort?: string;
}

export function interactiveArguments(options: InteractiveLaunch): string[] {
	return [
		"--model",
		options.model,
		"--system-prompt-file",
		options.promptFile,
		"--system-prompt-snapshot",
		"off",
		"--restricted",
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		options.mcpFile,
		// Including project preserves official workspace-trust records. --restricted still ignores
		// user/project/local settings files; only managed policy and our explicit --settings apply.
		"--setting-sources",
		"project",
		"--settings",
		options.settingsFile,
		"--disable-slash-commands",
		"--plugin-dir",
		options.pluginDirectory,
		"--autocompact",
		String(options.contextWindow),
		...(options.effort ? ["--effort", options.effort] : []),
		...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
	];
}

/** Compatibility helper for old extensions/tests; this is not sent using the headless control protocol. */
export function initializeRequest(systemPrompt: string, _withTools: boolean): { systemPrompt: string[] } {
	return { systemPrompt: [systemPrompt] };
}
