import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeCodeShell, { internals } from "../examples/extensions/claude-code-shell.ts";

const MOCK = fileURLToPath(new URL("./fixtures/mock-claude-usage.mjs", import.meta.url));

// What claude 2.1.325 answered get_usage with on a Max plan (2026-11-14), other fields left out and the resets moved
// far ahead so no window of the test is ever past its reset.
const ANSWER = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 7, resets_at: "2099-01-01T05:00:00+00:00" },
		seven_day: { utilization: 26, resets_at: "2099-01-08T00:00:00+00:00" },
		limits: [
			{ kind: "session", group: "session", percent: 7, resets_at: "2099-01-01T05:00:00+00:00", scope: null },
			{ kind: "weekly_all", group: "weekly", percent: 26, resets_at: "2099-01-08T00:00:00+00:00", scope: null },
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 21,
				resets_at: "2099-01-08T00:00:00+00:00",
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
			},
		],
	},
};

describe("claude-code-shell plan limits for MyHarness's own display", () => {
	const STATE = [
		"limits",
		"limitsQuery",
		"limitsQueriedAt",
		"limitsFailedAt",
		"limitsError",
		"planUsageChanged",
	] as const;
	const saved: Record<string, string | undefined> = {};
	const setEnv = (name: string, value: string | undefined) => {
		if (!(name in saved)) saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	let dir: string;
	let log: string;
	const logged = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const starts = () => logged().filter((entry) => entry.start);
	const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	/** Loads the plugin with a stand-in for MyHarness that keeps the source it registers and what each change showed. */
	function register() {
		let source: any;
		const seen: boolean[] = [];
		const pi: any = new Proxy(
			{},
			{
				get: (_target, name) =>
					name === "registerPlanUsageSource"
						? (given: any) => {
								source = given;
								// What the display would read at every change: whether a reading is under way.
								return () => seen.push(!!given.snapshot().refreshing);
							}
						: name === "getActiveTools"
							? () => []
							: () => {},
			},
		);
		claudeCodeShell(pi);
		return { source, seen };
	}

	beforeEach(() => {
		dir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "claude-plan-"));
		log = join(dir, "claude.log");
		setEnv("MYHARNESS_CLAUDE_BIN", MOCK);
		setEnv("MYHARNESS_CODING_AGENT_DIR", join(dir, "agent"));
		setEnv("MOCK_CLAUDE_LOG", log);
		setEnv("MOCK_CLAUDE_USAGE", JSON.stringify(ANSWER));
		for (const name of STATE) (internals.shared as any)[name] = undefined;
	});
	afterEach(async () => {
		if (internals.shared.limitsTimer) clearTimeout(internals.shared.limitsTimer);
		internals.shared.limitsTimer = undefined;
		for (const name of STATE) (internals.shared as any)[name] = undefined;
		internals.shared.contexts.delete("plan-claude");
		// The stand-ins end when their input closes; their files are free after that.
		await settle(150);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("reads the limits from a short-lived claude and hands over the plan's windows and each model's weekly limit", async () => {
		const { source, seen } = register();
		expect({ id: source.id, label: source.label }).toEqual({ id: "claude-code", label: "Claude" });
		expect(source.snapshot()).toMatchObject({ groups: [], refreshing: false });
		const shown = new Map<string, string | undefined>();
		internals.shared.contexts.set("plan-claude", {
			model: { provider: "claude-code", id: "claude-fable-5-2" },
			ui: { setStatus: (key: string, text: string | undefined) => shown.set(key, text) },
		});

		await source.refresh({ maxAgeMs: 0 });
		// No model request: a claude without tools, settings or a kept conversation is asked get_usage and ends.
		expect(starts()).toHaveLength(1);
		const args: string[] = starts()[0].start;
		expect(args[0]).toBe("-p");
		expect(args).toContain("--no-session-persistence");
		expect(logged().flatMap((entry) => (entry.request ? [entry.request.subtype] : []))).toEqual([
			"initialize",
			"get_usage",
		]);
		const snapshot = source.snapshot();
		expect(snapshot.groups).toEqual([
			{
				label: "",
				windows: [
					{ kind: "five_hour", leftPercent: 93, resetsAt: Date.parse("2099-01-01T05:00:00Z") },
					{ kind: "weekly", leftPercent: 74, resetsAt: Date.parse("2099-01-08T00:00:00Z") },
				],
			},
			{
				label: "Fable",
				modelIds: ["claude-fable-5-2", "claude-fable-5-1"],
				windows: [{ kind: "weekly", leftPercent: 79, resetsAt: Date.parse("2099-01-08T00:00:00Z") }],
			},
		]);
		expect(snapshot.refreshing).toBe(false);
		expect(snapshot.error).toBeUndefined();
		expect(Date.now() - snapshot.observedAt).toBeLessThan(60_000);
		// The display heard that the reading began and how it ended.
		expect(seen[0]).toBe(true);
		expect(seen[seen.length - 1]).toBe(false);
		// The numbers are in MyHarness's display: the chat's status line does not say them a second time.
		expect(shown.get("claude-code")).toBeUndefined();

		// Not twice a minute, whoever asks, and the display is told until when; a young reading is not asked for again.
		expect(snapshot.nextRefreshAt).toBeGreaterThan(Date.now());
		await source.refresh({ maxAgeMs: 0 });
		internals.shared.limitsQueriedAt = undefined;
		await source.refresh({ maxAgeMs: 600_000 });
		await source.refresh();
		expect(starts()).toHaveLength(1);
		// The user's own request reads again once the minute is over.
		await source.refresh({ maxAgeMs: 0 });
		expect(starts()).toHaveLength(2);
	});

	it("says why there are no numbers, waits before it tries by itself, and tries at once when the user asks", async () => {
		setEnv("MOCK_CLAUDE_USAGE", "error");
		const { source } = register();
		await source.refresh({ maxAgeMs: 0 });
		expect(source.snapshot()).toMatchObject({ groups: [], refreshing: false, error: "Not logged in" });
		expect(starts()).toHaveLength(1);
		// The page's own refresh a minute later does not start claude again so soon after a failure.
		internals.shared.limitsQueriedAt = undefined;
		await source.refresh({ maxAgeMs: 600_000 });
		expect(starts()).toHaveLength(1);
		// The user's press of the refresh button does, and a good answer clears the error.
		setEnv("MOCK_CLAUDE_USAGE", JSON.stringify(ANSWER));
		await source.refresh({ maxAgeMs: 0 });
		expect(starts()).toHaveLength(2);
		const snapshot = source.snapshot();
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.groups[0].windows.map((window: any) => window.leftPercent)).toEqual([93, 74]);
	});

	it("takes a reset time that had passed when the window was read as no reset time, and asks no more for it", async () => {
		// A plan nothing was used of since its windows reset: the program may still name the old reset times.
		setEnv(
			"MOCK_CLAUDE_USAGE",
			JSON.stringify({
				rate_limits: {
					five_hour: { utilization: 0, resets_at: "2020-01-01T05:00:00+00:00" },
					seven_day: { utilization: 3, resets_at: "2020-01-08T00:00:00+00:00" },
				},
			}),
		);
		const { source } = register();
		await source.refresh({ maxAgeMs: 0 });
		expect(source.snapshot().groups).toEqual([
			{
				label: "",
				windows: [
					{ kind: "five_hour", leftPercent: 100, resetsAt: undefined },
					{ kind: "weekly", leftPercent: 97, resetsAt: undefined },
				],
			},
		]);
		// The reading is the current one: the page's refresh does not start claude again for a "window that has reset".
		internals.shared.limitsQueriedAt = undefined;
		await source.refresh({ maxAgeMs: 600_000 });
		expect(starts()).toHaveLength(1);
	});
});
