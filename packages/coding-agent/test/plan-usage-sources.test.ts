import { afterEach, describe, expect, it, vi } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerPlanUsageRoutes } from "../src/modes/web/routes-plan-usage.ts";
import {
	listPlanUsageSources,
	onPlanUsageChanged,
	type PlanUsageSnapshot,
	type PlanUsageSource,
	planUsageStates,
	refreshPlanUsage,
	registerPlanUsageSource,
	unregisterPlanUsageSource,
} from "../src/providers/plan-usage/sources.ts";

const EMPTY: PlanUsageSnapshot = { groups: [] };

/** A source that reports `snapshot` and records how it was asked to refresh. */
function fakeSource(
	id: string,
	snapshot: PlanUsageSnapshot | (() => PlanUsageSnapshot) = EMPTY,
	refresh: PlanUsageSource["refresh"] = async () => {},
): PlanUsageSource {
	return {
		id,
		label: `Label of ${id}`,
		snapshot: typeof snapshot === "function" ? snapshot : () => snapshot,
		refresh: vi.fn(refresh),
	};
}

describe("plan usage source registry", () => {
	afterEach(() => {
		for (const source of listPlanUsageSources()) unregisterPlanUsageSource(source.id);
	});

	it("refuses ids that are not plain names and sources that lack a label, snapshot or refresh", () => {
		for (const id of ["", "Has Space", "UPPER", "-lead", "a".repeat(41)]) {
			expect(() => registerPlanUsageSource(fakeSource(id)), id).toThrow(/Invalid plan usage source id/);
		}
		expect(() =>
			registerPlanUsageSource({ ...fakeSource("x"), id: undefined } as unknown as PlanUsageSource),
		).toThrow(/Invalid plan usage source id/);
		expect(() => registerPlanUsageSource({ ...fakeSource("no-label"), label: " " })).toThrow(/needs a label/);
		expect(() =>
			registerPlanUsageSource({
				id: "no-snapshot",
				label: "x",
				refresh: async () => {},
			} as unknown as PlanUsageSource),
		).toThrow(/needs a label, a snapshot function and a refresh function/);
		expect(() =>
			registerPlanUsageSource({ id: "no-refresh", label: "x", snapshot: () => EMPTY } as unknown as PlanUsageSource),
		).toThrow(/needs a label, a snapshot function and a refresh function/);
		expect(listPlanUsageSources()).toEqual([]);
		// Lowercase letters, digits and dashes, as the web search sources.
		expect(() => registerPlanUsageSource(fakeSource("claude-code"))).not.toThrow();
		expect(() => registerPlanUsageSource(fakeSource("0-agy"))).not.toThrow();
	});

	it("keeps one source per id, the latest registration, in the order of first registration", () => {
		const first = fakeSource("my-plan");
		const second = fakeSource("my-plan");
		registerPlanUsageSource(first);
		registerPlanUsageSource(fakeSource("other"));
		registerPlanUsageSource(second);
		expect(listPlanUsageSources()).toHaveLength(2);
		expect(listPlanUsageSources().map((source) => source.id)).toEqual(["my-plan", "other"]);
		expect(listPlanUsageSources()[0]).toBe(second);
		unregisterPlanUsageSource("my-plan");
		expect(listPlanUsageSources().map((source) => source.id)).toEqual(["other"]);
	});

	it("tells listeners about a registration, a removal and the notifier, until they unsubscribe", () => {
		const heard = vi.fn();
		const stop = onPlanUsageChanged(heard);
		const changed = registerPlanUsageSource(fakeSource("one"));
		expect(heard).toHaveBeenCalledTimes(1);
		changed();
		expect(heard).toHaveBeenCalledTimes(2);
		unregisterPlanUsageSource("one");
		expect(heard).toHaveBeenCalledTimes(3);
		// The notifier does not depend on the registration that handed it out.
		changed();
		expect(heard).toHaveBeenCalledTimes(4);
		stop();
		changed();
		registerPlanUsageSource(fakeSource("two"));
		expect(heard).toHaveBeenCalledTimes(4);
	});

	it("does not let a throwing listener keep the others from hearing", () => {
		const before = vi.fn();
		const after = vi.fn();
		const stops = [
			onPlanUsageChanged(before),
			onPlanUsageChanged(() => {
				throw new Error("broken listener");
			}),
			onPlanUsageChanged(after),
		];
		const changed = registerPlanUsageSource(fakeSource("loud"));
		expect(() => changed()).not.toThrow();
		expect(before).toHaveBeenCalledTimes(2);
		expect(after).toHaveBeenCalledTimes(2);
		for (const stop of stops) stop();
	});

	it("hands out the snapshot with the id and label, copied and in the order of registration", () => {
		const snapshot: PlanUsageSnapshot = {
			groups: [
				{ label: "", windows: [{ kind: "five_hour", leftPercent: 40, resetsAt: 1_900_000_000_000 }] },
				{
					label: "Sonnet",
					modelIds: ["claude-sonnet-5-5"],
					windows: [{ kind: "weekly", leftPercent: 90 }],
				},
			],
			observedAt: 1_800_000_000_000,
			refreshing: true,
			nextRefreshAt: 1_800_000_060_000,
		};
		registerPlanUsageSource(fakeSource("claude-code", snapshot));
		registerPlanUsageSource(fakeSource("agy", { groups: [], unavailable: "agy is not installed" }));
		const states = planUsageStates();
		expect(states.map((state) => state.id)).toEqual(["claude-code", "agy"]);
		expect(states[0]).toEqual({ id: "claude-code", label: "Label of claude-code", ...snapshot });
		expect(states[0].groups).not.toBe(snapshot.groups);
		expect(states[1]).toEqual({ id: "agy", label: "Label of agy", groups: [], unavailable: "agy is not installed" });
		// Nothing but what is set: the page tells "unknown" from 0 by the key being absent.
		expect(Object.keys(states[1]).sort()).toEqual(["groups", "id", "label", "unavailable"]);
		expect("resetsAt" in states[0].groups[1].windows[0]).toBe(false);
	});

	it("clamps percentages and drops windows it cannot trust", () => {
		registerPlanUsageSource(
			fakeSource("dirty", {
				groups: [
					{
						label: "",
						windows: [
							{ kind: "five_hour", leftPercent: 140, resetsAt: 5 },
							{ kind: "weekly", leftPercent: -3, resetsAt: Number.NaN },
							{ kind: "weekly", leftPercent: Number.NaN },
							{ kind: "five_hour", leftPercent: Number.POSITIVE_INFINITY },
							{ kind: "five_hour", leftPercent: "50" },
							{ kind: "monthly", leftPercent: 50 },
							{ kind: "weekly", leftPercent: 12.5, resetsAt: Number.POSITIVE_INFINITY },
							null,
						],
					},
				],
				observedAt: Number.NaN,
				nextRefreshAt: Number.POSITIVE_INFINITY,
			} as unknown as PlanUsageSnapshot),
		);
		const [state] = planUsageStates();
		expect(state.groups).toEqual([
			{
				label: "",
				windows: [
					{ kind: "five_hour", leftPercent: 100, resetsAt: 5 },
					{ kind: "weekly", leftPercent: 0 },
					{ kind: "weekly", leftPercent: 12.5 },
				],
			},
		]);
		expect("observedAt" in state).toBe(false);
		expect("nextRefreshAt" in state).toBe(false);
	});

	it("shows the message of a source whose snapshot throws, and goes on with the others", () => {
		registerPlanUsageSource(
			fakeSource("broken", () => {
				throw new Error("cannot read the file");
			}),
		);
		registerPlanUsageSource(fakeSource("fine", { groups: [], error: "last read failed" }));
		expect(planUsageStates()).toEqual([
			{ id: "broken", label: "Label of broken", groups: [], error: "cannot read the file" },
			{ id: "fine", label: "Label of fine", groups: [], error: "last read failed" },
		]);
	});

	it("refreshes one source by id, or all of them in parallel, and swallows a rejection", async () => {
		let release: () => void = () => {};
		const slow = fakeSource(
			"slow",
			EMPTY,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const failing = fakeSource("failing", EMPTY, async () => {
			throw new Error("the program crashed");
		});
		const throwing = fakeSource("throwing", EMPTY, () => {
			throw new Error("not even a promise");
		});
		const fine = fakeSource("fine");
		for (const source of [slow, failing, throwing, fine]) registerPlanUsageSource(source);

		await expect(refreshPlanUsage({ id: "failing", maxAgeMs: 5000 })).resolves.toBeUndefined();
		await expect(refreshPlanUsage({ id: "throwing" })).resolves.toBeUndefined();
		await expect(refreshPlanUsage({ id: "missing" })).resolves.toBeUndefined();
		expect(failing.refresh).toHaveBeenCalledTimes(1);
		expect(failing.refresh).toHaveBeenCalledWith({ maxAgeMs: 5000 });
		expect(throwing.refresh).toHaveBeenCalledTimes(1);
		expect(slow.refresh).not.toHaveBeenCalled();
		expect(fine.refresh).not.toHaveBeenCalled();

		// All sources are asked at once: the slow one does not hold back the others.
		const all = refreshPlanUsage({ maxAgeMs: 0 });
		expect(fine.refresh).toHaveBeenCalledWith({ maxAgeMs: 0 });
		expect(failing.refresh).toHaveBeenCalledTimes(2);
		let finished = false;
		void all.then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		release();
		await all;
		expect(finished).toBe(true);
	});
});

describe("plan usage routes", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		vi.useRealTimers();
		while (cleanups.length > 0) await cleanups.pop()?.();
		for (const source of listPlanUsageSources()) unregisterPlanUsageSource(source.id);
	});

	async function start() {
		const server = new WebHttpServer();
		const events: Array<{ event: string; data: unknown }> = [];
		server.broadcast = (event: string, data: unknown) => {
			events.push({ event, data });
		};
		const dispose = registerPlanUsageRoutes(server);
		const port = (await server.listen(0)).port;
		cleanups.push(() => server.close());
		cleanups.push(dispose);
		// No x-myharness-slot header: these routes belong to the process, not to a chat.
		const call = async (path: string, body?: unknown, raw?: string) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: body === undefined && raw === undefined ? "GET" : "POST",
				headers: { "Content-Type": "application/json", "x-myharness-web": "1" },
				...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			return { status: response.status, body: (await response.json()) as Record<string, any> };
		};
		return { events, dispose, call };
	}

	it("answers GET with the states of the sources", async () => {
		registerPlanUsageSource(
			fakeSource("claude-code", { groups: [{ label: "", windows: [{ kind: "weekly", leftPercent: 70 }] }] }),
		);
		const { call } = await start();
		const answer = await call("/api/plan-usage");
		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({
			sources: [
				{
					id: "claude-code",
					label: "Label of claude-code",
					groups: [{ label: "", windows: [{ kind: "weekly", leftPercent: 70 }] }],
				},
			],
		});
	});

	it("starts a refresh without waiting for it and answers with the numbers as they are", async () => {
		let release: () => void = () => {};
		let finished = false;
		const source = fakeSource("claude-code", { groups: [], observedAt: 1 }, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			finished = true;
		});
		const other = fakeSource("agy");
		registerPlanUsageSource(source);
		registerPlanUsageSource(other);
		const { call } = await start();

		const all = await call("/api/plan-usage/refresh", {});
		expect(all.status).toBe(200);
		expect((all.body.sources as Array<{ id: string }>).map((state) => state.id)).toEqual(["claude-code", "agy"]);
		// The page waits no longer than it takes to answer: the read is still going on.
		expect(finished).toBe(false);
		expect(source.refresh).toHaveBeenCalledWith({ maxAgeMs: 60_000 });
		expect(other.refresh).toHaveBeenCalledWith({ maxAgeMs: 60_000 });
		release();

		const one = await call("/api/plan-usage/refresh", { id: "agy", maxAgeMs: 0 });
		expect(one.status).toBe(200);
		expect(other.refresh).toHaveBeenLastCalledWith({ maxAgeMs: 0 });
		expect(source.refresh).toHaveBeenCalledTimes(1);

		// An empty body is the same as {}.
		expect((await call("/api/plan-usage/refresh", undefined, "")).status).toBe(200);
		expect(source.refresh).toHaveBeenCalledTimes(2);
	});

	it("refuses a maxAgeMs that is not a number of 0 or more, and a body that is not an object", async () => {
		const source = fakeSource("claude-code");
		registerPlanUsageSource(source);
		const { call } = await start();
		for (const body of [
			{ maxAgeMs: -1 },
			{ maxAgeMs: "60000" },
			{ maxAgeMs: null },
			{ maxAgeMs: true },
			{ id: 5 },
			[],
			"text",
		]) {
			expect((await call("/api/plan-usage/refresh", body)).status, JSON.stringify(body)).toBe(400);
		}
		expect((await call("/api/plan-usage/refresh", undefined, "{broken")).status).toBe(400);
		expect(source.refresh).not.toHaveBeenCalled();
	});

	it("broadcasts one plan_usage event for a burst of changes, and none when nothing differs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let left = 80;
		const source = fakeSource("claude-code", () => ({
			groups: [{ label: "", windows: [{ kind: "five_hour", leftPercent: left }] }],
		}));
		const { events, dispose } = await start();
		const changed = registerPlanUsageSource(source);
		changed();
		changed();
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(60);
		expect(events).toEqual([
			{
				event: "plan_usage",
				data: {
					sources: [
						{
							id: "claude-code",
							label: "Label of claude-code",
							groups: [{ label: "", windows: [{ kind: "five_hour", leftPercent: 80 }] }],
						},
					],
				},
			},
		]);

		// The same numbers again: no event.
		changed();
		await vi.advanceTimersByTimeAsync(60);
		expect(events).toHaveLength(1);

		left = 75;
		changed();
		await vi.advanceTimersByTimeAsync(60);
		expect(events).toHaveLength(2);
		expect((events[1].data as any).sources[0].groups[0].windows[0].leftPercent).toBe(75);

		// Once disposed the routes stop listening, and a change that was still waiting is dropped.
		left = 60;
		changed();
		dispose();
		await vi.advanceTimersByTimeAsync(60);
		changed();
		await vi.advanceTimersByTimeAsync(60);
		expect(events).toHaveLength(2);
	});
});
