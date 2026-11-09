import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ConversationLinks,
	canResume,
	digest,
	historyDigest,
	historyShape,
} from "../src/providers/claude-code/history.ts";

const homeMock = vi.hoisted(() => {
	let current = "";
	return {
		get: () => current,
		set: (value: string) => {
			current = value;
		},
	};
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: homeMock.get };
});

import {
	DEFAULT_CONTEXT_WINDOW,
	launchEnv,
	parseContextWindow,
	profileDirectory,
	providerDirectory,
	readContextWindow,
	STRIPPED_ENV,
	saveContextWindow,
} from "../src/providers/claude-code/config.ts";

let root = "";
let originalAgentDirectory: string | undefined;
let originalClaudeDirectory: string | undefined;
let fakeHome = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "myharness-claude-config-test-"));
	fakeHome = join(root, "fake-home");
	mkdirSync(fakeHome, { recursive: true });
	homeMock.set(fakeHome);
	originalAgentDirectory = process.env.MYHARNESS_CODING_AGENT_DIR;
	originalClaudeDirectory = process.env.MYHARNESS_CLAUDE_CONFIG_DIR;
	process.env.MYHARNESS_CODING_AGENT_DIR = join(root, "agent-data");
	delete process.env.MYHARNESS_CLAUDE_CONFIG_DIR;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
	else process.env.MYHARNESS_CODING_AGENT_DIR = originalAgentDirectory;
	if (originalClaudeDirectory === undefined) delete process.env.MYHARNESS_CLAUDE_CONFIG_DIR;
	else process.env.MYHARNESS_CLAUDE_CONFIG_DIR = originalClaudeDirectory;
	homeMock.set("");
	const fixture = resolve(root);
	if (
		root &&
		dirname(fixture) === resolve(tmpdir()) &&
		basename(fixture).startsWith("myharness-claude-config-test-") &&
		!lstatSync(fixture).isSymbolicLink()
	) {
		rmSync(fixture, { recursive: true, force: true });
	}
	root = "";
});

describe("Claude Code config and history boundaries", () => {
	it("rejects the fake personal profile root and descendants while allowing an isolated profile", () => {
		const personal = join(fakeHome, ".claude");
		mkdirSync(personal, { recursive: true });
		process.env.MYHARNESS_CLAUDE_CONFIG_DIR = personal;
		expect(() => profileDirectory()).toThrow(/独立的 Claude Code 配置目录/);

		process.env.MYHARNESS_CLAUDE_CONFIG_DIR = join(personal, "projects", "nested-profile");
		expect(() => profileDirectory()).toThrow(/独立的 Claude Code 配置目录/);

		process.env.MYHARNESS_CLAUDE_CONFIG_DIR = join(root, "isolated-profile");
		expect(profileDirectory()).toBe(join(root, "isolated-profile"));
	});

	it("resolves a directory alias to the fake personal profile before accepting it", ({ skip }) => {
		const personal = join(fakeHome, ".claude");
		mkdirSync(personal, { recursive: true });
		const alias = join(root, "profile-alias");
		try {
			symlinkSync(personal, alias, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip();
			throw error;
		}
		process.env.MYHARNESS_CLAUDE_CONFIG_DIR = join(alias, "nested");
		expect(() => profileDirectory()).toThrow(/独立的 Claude Code 配置目录/);
	});

	it("strips inherited credentials case-insensitively and replaces config overrides", () => {
		const inherited: NodeJS.ProcessEnv = {
			Path: "fixture-path",
			ANTHROPIC_API_KEY: "not-a-real-key",
			anthropic_api_key: "duplicate-case",
			ANTHROPIC_OAUTH_TOKEN: "fixture-oauth",
			anthropic_custom_headers: "fixture-header",
			CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-token",
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "777",
			mcp_tool_timeout: "12",
			claude_config_dir: "inherited-profile",
			claude_code_max_output_tokens: "inherited-limit",
		};
		const original = { ...inherited };
		const env = launchEnv(inherited, 64_000, 300_000, join(root, "isolated-profile"));
		const stripped = new Set<string>(STRIPPED_ENV.filter((name) => name !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
		for (const name of Object.keys(env)) expect(stripped.has(name.toUpperCase())).toBe(false);
		for (const name of [
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW",
			"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
			"MCP_TOOL_TIMEOUT",
		]) {
			expect(Object.keys(env).filter((key) => key.toUpperCase() === name)).toEqual([name]);
		}
		expect(env).toMatchObject({
			Path: "fixture-path",
			CLAUDE_CONFIG_DIR: join(root, "isolated-profile"),
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000",
			MCP_TOOL_TIMEOUT: expect.any(String),
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
		});
		expect(inherited).toEqual(original);
	});

	it("prefers interactive settings, falls back to the legacy settings file, and defaults on invalid values", () => {
		const directory = providerDirectory();
		mkdirSync(directory, { recursive: true });
		const current = join(directory, "interactive-settings.json");
		const legacy = join(directory, "settings.json");
		writeFileSync(legacy, JSON.stringify({ contextWindow: "300k" }));
		writeFileSync(current, JSON.stringify({ contextWindow: "500,000" }));
		expect(readContextWindow()).toBe(500_000);

		writeFileSync(current, JSON.stringify({ contextWindow: "99k" }));
		expect(readContextWindow()).toBe(300_000);

		writeFileSync(current, "not-json");
		writeFileSync(legacy, JSON.stringify({ contextWindow: "not-a-window" }));
		expect(readContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("parses supported context window units and exact lower and upper boundaries", () => {
		for (const [text, expected] of [
			["300", 300_000],
			["300k", 300_000],
			["1M", 1_000_000],
			["100,000", 100_000],
			["99k", undefined],
			["1,000,001", undefined],
		] as const) {
			expect(parseContextWindow(text), text).toBe(expected);
		}
	});

	it("writes the current setting without changing legacy settings", () => {
		const directory = providerDirectory();
		mkdirSync(directory, { recursive: true });
		const legacy = join(directory, "settings.json");
		writeFileSync(legacy, JSON.stringify({ contextWindow: "300k", keep: true }));
		const originalLegacy = readFileSync(legacy, "utf8");
		saveContextWindow(750_000);
		expect(readContextWindow()).toBe(750_000);
		expect(readFileSync(legacy, "utf8")).toBe(originalLegacy);
	});

	it("normalizes user string and text-block history to the same semantic hash", () => {
		const stringMessage = { role: "user", content: "same request" } as const;
		const blockMessage = { role: "user", content: [{ type: "text", text: "same request" }] } as const;
		expect(historyShape(stringMessage as any)).toEqual(historyShape(blockMessage as any));
		expect(historyDigest([stringMessage as any])).toBe(historyDigest([blockMessage as any]));
	});

	it("returns undefined for corrupt and structurally invalid conversation checkpoints", () => {
		const directory = join(root, "links");
		const sessionId = "host-session-fixture";
		const path = join(directory, "interactive-links", `${digest(sessionId)}.json`);
		mkdirSync(join(directory, "interactive-links"), { recursive: true });
		const malformed = [
			"{truncated",
			"null",
			"[]",
			JSON.stringify({ version: 2 }),
			JSON.stringify({
				version: 1,
				claudeSessionId: "bad",
				historyCount: 0,
				historyDigest: "0".repeat(64),
				cwd: "x",
				profile: "y",
			}),
			JSON.stringify({
				version: 1,
				claudeSessionId: "00000000-0000-0000-0000-000000000001",
				historyCount: -1,
				historyDigest: "0".repeat(64),
				cwd: "x",
				profile: "y",
			}),
			JSON.stringify({
				version: 1,
				claudeSessionId: "00000000-0000-0000-0000-000000000001",
				historyCount: 0,
				historyDigest: "invalid",
				cwd: "x",
				profile: "y",
			}),
		];
		const links = new ConversationLinks(directory);
		for (const content of malformed) {
			writeFileSync(path, content);
			expect(links.read(sessionId)).toBeUndefined();
		}
	});

	it("resumes only the matching cwd, profile and complete checkpoint prefix", () => {
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			{ role: "user", content: "later" },
		] as any[];
		const link = {
			version: 1 as const,
			claudeSessionId: "00000000-0000-0000-0000-000000000001",
			cwd: join(root, "workspace"),
			profile: join(root, "profile"),
			historyCount: 2,
			historyDigest: historyDigest(messages.slice(0, 2)),
		};
		const prefixAndAppend = [...messages, { role: "user", content: "next turn" }];
		expect(canResume(link, link.cwd, link.profile, prefixAndAppend)).toBe(true);
		expect(canResume(link, join(root, "other-workspace"), link.profile, prefixAndAppend)).toBe(false);
		expect(canResume(link, link.cwd, join(root, "other-profile"), prefixAndAppend)).toBe(false);
		expect(
			canResume(link, link.cwd, link.profile, [{ ...messages[0], content: "edited" }, ...messages.slice(1)]),
		).toBe(false);
	});
});
