import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { STRIPPED_ENV } from "../src/providers/claude-code/config.ts";
import { isolatedSetupCommand } from "../src/providers/claude-code/register.ts";

let root = "";
afterEach(() => {
	vi.unstubAllEnvs();
	if (root && !lstatSync(root).isSymbolicLink()) rmSync(root, { recursive: true, force: true });
	root = "";
});

it.skipIf(process.platform !== "win32")(
	"preserves native empty/JSON arguments and restores terminal credentials in Windows PowerShell and pwsh",
	() => {
		const temporary =
			process.env.MYHARNESS_TEMP_DIR ||
			(process.env.MYHARNESS_ARTIFACTS_DIR ? join(process.env.MYHARNESS_ARTIFACTS_DIR, "temporary") : tmpdir());
		mkdirSync(temporary, { recursive: true });
		root = mkdtempSync(join(temporary, "claude-login-command-"));
		const profile = join(root, "fixture profile's independent data");
		vi.stubEnv("MYHARNESS_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("MYHARNESS_CLAUDE_CONFIG_DIR", profile);
		vi.stubEnv("MYHARNESS_CLAUDE_BIN", process.execPath);
		const command = isolatedSetupCommand();
		const probe = join(root, "argv probe.cjs");
		writeFileSync(
			probe,
			`require('node:fs').writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({argv:process.argv.slice(2),profile:process.env.CLAUDE_CONFIG_DIR,stripped:${JSON.stringify(STRIPPED_ENV)}.filter(name=>process.env[name]),mds:process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS}));`,
		);
		const prefix = `"${probe}" `.replace(/'/g, "''");
		const instrumented = command.replace("-ArgumentList '", `-ArgumentList '${prefix}`);
		expect(instrumented).not.toBe(command);
		const windowsPowerShell = join(
			process.env.SystemRoot!,
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		const pwsh = join(process.env.ProgramFiles!, "PowerShell", "7", "pwsh.exe");
		const shells = [windowsPowerShell, ...(existsSync(pwsh) ? [pwsh] : [])];
		for (const [index, shell] of shells.entries()) {
			const output = join(root, `argv-${index}.json`);
			const script = join(root, `run-${index}.ps1`);
			const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_OUTPUT: output };
			for (const name of STRIPPED_ENV) env[name] = "fixture-inherited";
			env.CLAUDE_CONFIG_DIR = "fixture-inherited-profile";
			writeFileSync(
				script,
				`\uFEFF$ErrorActionPreference='Stop'\n${instrumented}\nif ($env:ANTHROPIC_API_KEY -ne 'fixture-inherited') { throw 'Terminal credential not restored' }\nif ($env:CLAUDE_CONFIG_DIR -ne 'fixture-inherited-profile') { throw 'Terminal profile not restored' }\nWrite-Output 'fixture-passed'\n`,
			);
			expect(
				execFileSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
					env,
					encoding: "utf8",
					timeout: 20000,
					windowsHide: true,
				}),
			).toContain("fixture-passed");
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
				argv: [
					"--restricted",
					"--setting-sources",
					"project",
					"--tools",
					"",
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
				],
				profile,
				stripped: [],
				mds: "1",
			});
		}
		expect(dirname(resolve(root))).toBe(resolve(temporary));
	},
	60000,
);
