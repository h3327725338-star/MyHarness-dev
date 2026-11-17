import { afterEach, describe, expect, it } from "vitest";
import {
	createDelegatedWriteGuardExtensionSource,
	DELEGATED_READ_ROOTS_ENV,
	evaluateDelegatedWriteToolCall,
	WRITE_GUARD_BLOCK_MARKER,
} from "../src/tools/shell/delegated-write-guard.ts";

const ROOT = "C:/work/jail";
const READ_ROOT = "C:/data/readonly";

function call(
	toolName: string,
	input: Record<string, unknown>,
	readRoots?: readonly string[],
	origin?: string,
): string | undefined {
	return evaluateDelegatedWriteToolCall(toolName, input, ROOT, origin, readRoots);
}

describe("evaluateDelegatedWriteToolCall: read roots", () => {
	it("lets the read-only file tools use an absolute path inside a read root", () => {
		const readRoots = [READ_ROOT];
		expect(call("read", { path: `${READ_ROOT}/log.txt` }, readRoots)).toBeUndefined();
		expect(call("grep", { query: "x", path: READ_ROOT }, readRoots)).toBeUndefined();
		expect(call("find", { path: READ_ROOT, pattern: "*.log" }, readRoots)).toBeUndefined();
		expect(call("ls", { path: READ_ROOT }, readRoots)).toBeUndefined();
		expect(call("ls", { path: `${READ_ROOT}/nested/deep` }, readRoots)).toBeUndefined();
	});

	it("keeps the read-only tools jailed without read roots", () => {
		expect(call("read", { path: `${READ_ROOT}/log.txt` })).toBeDefined();
		expect(call("read", { path: `${READ_ROOT}/log.txt` }, [])).toBeDefined();
	});

	it("blocks write and edit inside a read root", () => {
		const readRoots = [READ_ROOT];
		expect(call("write", { path: `${READ_ROOT}/evil.txt`, content: "x" }, readRoots)).toContain(
			"越出本任务 worktree",
		);
		expect(call("edit", { path: `${READ_ROOT}/log.txt`, edits: [] }, readRoots)).toContain("越出本任务 worktree");
	});

	it("still blocks any shell reference to a read root", () => {
		const readRoots = [READ_ROOT];
		expect(call("bash", { command: `cat ${READ_ROOT}/log.txt` }, readRoots)).toContain("绝对路径越出");
		expect(call("pwsh", { command: `Get-Content ${READ_ROOT}/log.txt` }, readRoots)).toContain("绝对路径越出");
	});

	it("never resolves a relative path into a read root", () => {
		const readRoots = [READ_ROOT];
		// A relative path always resolves against the worker's own copy, so one that points upward is blocked...
		expect(call("read", { path: "../../data/readonly/log.txt" }, readRoots)).toBeDefined();
		// ...and one inside the copy stays allowed, whatever its name: the read root is only reachable by absolute path.
		expect(call("read", { path: "data/readonly/log.txt" }, readRoots)).toBeUndefined();
		expect(call("read", { path: "./readonly/x" }, readRoots)).toBeUndefined();
	});

	it("blocks a read root sibling that only shares a prefix", () => {
		expect(call("read", { path: `${READ_ROOT}-evil/x` }, [READ_ROOT])).toBeDefined();
	});

	it("falls back to the environment variable when no explicit roots are given", () => {
		const previous = process.env[DELEGATED_READ_ROOTS_ENV];
		process.env[DELEGATED_READ_ROOTS_ENV] = JSON.stringify([READ_ROOT]);
		try {
			expect(call("read", { path: `${READ_ROOT}/log.txt` })).toBeUndefined();
			expect(call("write", { path: `${READ_ROOT}/evil.txt`, content: "x" })).toBeDefined();
			expect(call("bash", { command: `cat ${READ_ROOT}/log.txt` })).toBeDefined();
			// Explicit roots override the environment.
			expect(call("read", { path: `${READ_ROOT}/log.txt` }, [])).toBeDefined();
		} finally {
			if (previous === undefined) delete process.env[DELEGATED_READ_ROOTS_ENV];
			else process.env[DELEGATED_READ_ROOTS_ENV] = previous;
		}
	});

	it("treats a malformed environment value as no read roots", () => {
		const previous = process.env[DELEGATED_READ_ROOTS_ENV];
		process.env[DELEGATED_READ_ROOTS_ENV] = "not json";
		try {
			expect(call("read", { path: `${READ_ROOT}/log.txt` })).toBeDefined();
		} finally {
			if (previous === undefined) delete process.env[DELEGATED_READ_ROOTS_ENV];
			else process.env[DELEGATED_READ_ROOTS_ENV] = previous;
		}
	});

	it("rejects tilde entries in the environment value", () => {
		const previous = process.env[DELEGATED_READ_ROOTS_ENV];
		process.env[DELEGATED_READ_ROOTS_ENV] = JSON.stringify(["~/secret"]);
		try {
			expect(call("read", { path: "~/secret/log.txt" })).toBeDefined();
		} finally {
			if (previous === undefined) delete process.env[DELEGATED_READ_ROOTS_ENV];
			else process.env[DELEGATED_READ_ROOTS_ENV] = previous;
		}
	});

	it("rejects a file: URL even when it names a location inside a read root", () => {
		const readRoots = [READ_ROOT];
		// The tools resolve a file: URL via normalizePath (fileURLToPath) to an absolute path; the lexical check on
		// the raw value would read it as a relative name inside the copy. Fail closed instead.
		expect(call("read", { path: `file://${READ_ROOT}/log.txt` }, readRoots)).toContain("越出本任务 worktree");
		expect(call("read", { path: `FILE://${READ_ROOT}/log.txt` }, readRoots)).toContain("越出本任务 worktree");
		expect(call("grep", { query: "x", path: `file://${READ_ROOT}` }, readRoots)).toContain("越出本任务 worktree");
		expect(call("find", { path: `file://${READ_ROOT}`, pattern: "*.log" }, readRoots)).toContain(
			"越出本任务 worktree",
		);
		expect(call("ls", { path: `file://${READ_ROOT}` }, readRoots)).toContain("越出本任务 worktree");
		// The plain absolute spelling of the same location stays allowed.
		expect(call("read", { path: `${READ_ROOT}/log.txt` }, readRoots)).toBeUndefined();
	});

	it("lets the symbols tool read from a read root like the other read-only tools", () => {
		const readRoots = [READ_ROOT];
		expect(call("symbols", { path: READ_ROOT }, readRoots)).toBeUndefined();
		expect(call("symbols", { path: `${READ_ROOT}/nested` }, readRoots)).toBeUndefined();
		expect(call("symbols", { path: READ_ROOT })).toBeDefined();
		expect(call("symbols", { path: "C:/Windows" }, readRoots)).toContain("越出本任务 worktree");
	});
});

describe("generated write-guard extension source: read roots", () => {
	const saved: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			delete saved[key];
		}
	});

	function useEnv(key: string, value: string | undefined): void {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	it("reads MYHARNESS_INTERNAL_DELEGATED_READ_ROOTS from the worker environment", async () => {
		const source = createDelegatedWriteGuardExtensionSource();
		expect(source).toContain(DELEGATED_READ_ROOTS_ENV);

		// Evaluate the generated source the way the worker loader would (a stub pi object).
		const handlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>> = [];
		const stubPi = {
			on: (_event: string, handler: (typeof handlers)[number]) => {
				handlers.push(handler);
			},
		};
		const evaluated = source.replace("export default function (pi) {", "function guard(pi) {");
		new Function("pi", `${evaluated}\nguard(pi);`)(stubPi);
		expect(handlers.length).toBe(1);

		useEnv("MYHARNESS_INTERNAL_DELEGATED_WORKTREE", ROOT);
		useEnv(DELEGATED_READ_ROOTS_ENV, JSON.stringify([READ_ROOT]));

		const read = await handlers[0]({ toolName: "read", input: { path: `${READ_ROOT}/log.txt` } });
		expect(read).toBeUndefined();
		const write = await handlers[0]({ toolName: "write", input: { path: `${READ_ROOT}/evil.txt`, content: "x" } });
		expect(write).toMatchObject({ block: true });
		expect((write as { reason: string }).reason).toContain(WRITE_GUARD_BLOCK_MARKER);
		const shellRead = await handlers[0]({ toolName: "bash", input: { command: `cat ${READ_ROOT}/log.txt` } });
		expect(shellRead).toMatchObject({ block: true });
	});

	it("blocks a file: URL read of a read root in the generated guard too", async () => {
		const source = createDelegatedWriteGuardExtensionSource();
		const handlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>> = [];
		const stubPi = {
			on: (_event: string, handler: (typeof handlers)[number]) => {
				handlers.push(handler);
			},
		};
		const evaluated = source.replace("export default function (pi) {", "function guard(pi) {");
		new Function("pi", `${evaluated}\nguard(pi);`)(stubPi);
		useEnv("MYHARNESS_INTERNAL_DELEGATED_WORKTREE", ROOT);
		useEnv(DELEGATED_READ_ROOTS_ENV, JSON.stringify([READ_ROOT]));
		const fileUrl = await handlers[0]({ toolName: "read", input: { path: `file://${READ_ROOT}/log.txt` } });
		expect(fileUrl).toMatchObject({ block: true });
		expect((fileUrl as { reason: string }).reason).toContain(WRITE_GUARD_BLOCK_MARKER);
		const plain = await handlers[0]({ toolName: "read", input: { path: `${READ_ROOT}/log.txt` } });
		expect(plain).toBeUndefined();
	});
});
