import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// The plan-limits meter's decisions are plain ES modules without DOM or store imports; load them through computed URLs
// like the other web tests.
const webDir = new URL("../web/js/", import.meta.url);
const model = await import(new URL("plan-usage-model.js", webDir).href);
const lang = await import(new URL("lang.js", webDir).href);
const i18n = await import(new URL("i18n.js", webDir).href);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 14, 16, 56).getTime();

type Win = { kind: "five_hour" | "weekly"; leftPercent: number; resetsAt?: number };
type Group = { label: string; modelIds?: string[]; windows: Win[] };
type Source = {
	id: string;
	label: string;
	groups: Group[];
	observedAt?: number;
	refreshing?: boolean;
	unavailable?: string;
	error?: string;
	nextRefreshAt?: number;
};

const five = (leftPercent: number, resetsAt?: number): Win => ({ kind: "five_hour", leftPercent, resetsAt });
const week = (leftPercent: number, resetsAt?: number): Win => ({ kind: "weekly", leftPercent, resetsAt });

// The real readings of 2026-11-14.
const claude: Source = {
	id: "claude-code",
	label: "Claude",
	observedAt: NOW - 2 * MIN,
	groups: [
		{ label: "", windows: [five(93, NOW + 4 * HOUR + 40 * MIN), week(74, NOW + 5 * DAY)] },
		{ label: "Fable", modelIds: ["fable"], windows: [week(79, NOW + 5 * DAY)] },
	],
};
const agy: Source = {
	id: "agy",
	label: "agy",
	observedAt: NOW - 2 * MIN,
	groups: [
		{
			label: "Gemini Models",
			modelIds: ["gemini-pro", "gemini-flash"],
			windows: [five(26, NOW + 2 * HOUR), week(69, NOW + 3 * DAY)],
		},
		{ label: "Claude and GPT models", modelIds: ["claude-sonnet", "gpt-oss"], windows: [five(100), week(100)] },
		{ label: "Gemini 4 Argon", modelIds: ["gemini-4-argon"], windows: [week(99, NOW + 6 * DAY)] },
	],
};

const plain = (text: string, params?: Record<string, unknown>) =>
	params
		? text.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key])))
		: text;

afterEach(() => lang.setLang("en"));

describe("plan limits: which source and which windows the meter shows", () => {
	it("speaks for the provider of the chat's model, even when another source has less left", () => {
		const low: Source = { ...agy, groups: [{ label: "", windows: [five(3, NOW + HOUR)] }] };
		expect(model.focusSource([low, claude], { provider: "claude-code" }, NOW)).toBe(claude);
		expect(model.focusSource([claude, low], { provider: "agy" }, NOW)).toBe(low);
	});

	it("keeps the chat's own source even when it has no readings, so its reason is what the meter explains", () => {
		const broken: Source = { id: "claude-code", label: "Claude", groups: [], unavailable: "Not signed in" };
		expect(model.focusSource([agy, broken], { provider: "claude-code" }, NOW)).toBe(broken);
	});

	it("falls back to the usable source with the least five-hour room when the chat is on another provider", () => {
		expect(model.focusSource([claude, agy], { provider: "openai" }, NOW)).toBe(agy);
		expect(model.focusSource([agy, claude], undefined, NOW)).toBe(agy);
		const nearlyOut: Source = {
			...claude,
			groups: [{ label: "", windows: [five(8, NOW + HOUR), week(74, NOW + DAY)] }],
		};
		expect(model.focusSource([agy, nearlyOut], { provider: "openai" }, NOW)).toBe(nearlyOut);
	});

	it("skips sources without readings, and a five-hour reading that is already past its reset", () => {
		const none: Source = { id: "x", label: "X", groups: [], unavailable: "off" };
		const stale: Source = { id: "stale", label: "Stale", groups: [{ label: "", windows: [five(1, NOW - MIN)] }] };
		expect(model.focusSource([none, stale, claude], { provider: "openai" }, NOW)).toBe(claude);
	});

	it("takes the first usable source when none has a five-hour reading, and nothing when none is usable", () => {
		const weeklyOnly: Source = { id: "w", label: "W", groups: [{ label: "", windows: [week(50, NOW + DAY)] }] };
		const empty: Source = { id: "e", label: "E", groups: [{ label: "", windows: [] }] };
		expect(model.focusSource([empty, weeklyOnly], { provider: "openai" }, NOW)).toBe(weeklyOnly);
		expect(model.focusSource([empty], { provider: "openai" }, NOW)).toBeUndefined();
		expect(model.focusSource([], { provider: "openai" }, NOW)).toBeUndefined();
		expect(model.focusSource(undefined, undefined, NOW)).toBeUndefined();
	});

	it("shows the plan-wide limit for any model, and a model's own group only for that model", () => {
		const claudeLow: Source = {
			...claude,
			groups: [
				{ label: "", windows: [five(93, NOW + HOUR), week(74, NOW + DAY)] },
				{ label: "Fable", modelIds: ["fable"], windows: [week(30, NOW + DAY)] },
			],
		};
		const forOpus = model.focusWindows(claudeLow, "opus", NOW);
		expect(forOpus.five_hour?.leftPercent).toBe(93);
		expect(forOpus.weekly?.leftPercent).toBe(74);
		const forFable = model.focusWindows(claudeLow, "fable", NOW);
		expect(forFable.five_hour?.leftPercent).toBe(93);
		expect(forFable.weekly?.leftPercent).toBe(30);
	});

	it("filters pools by modelIds: a model sees the pools that list it", () => {
		const gemini = model.focusWindows(agy, "gemini-pro", NOW);
		expect(gemini.five_hour?.leftPercent).toBe(26);
		expect(gemini.weekly?.leftPercent).toBe(69);
		const sonnet = model.focusWindows(agy, "claude-sonnet", NOW);
		expect(sonnet.five_hour?.leftPercent).toBe(100);
		expect(sonnet.weekly?.leftPercent).toBe(100);
		// Only the Argon pool lists it, and that pool has no five-hour window.
		const argon = model.focusWindows(agy, "gemini-4-argon", NOW);
		expect(argon.five_hour).toBeUndefined();
		expect(argon.weekly?.leftPercent).toBe(99);
		// A model no group applies to has nothing to show.
		expect(model.focusWindows(agy, "unknown", NOW)).toEqual({});
	});

	it("when the chat is on another provider, counts only the plan-wide group, or every group when there is none", () => {
		const offClaude = model.focusWindows(claude, undefined, NOW);
		expect(offClaude.weekly?.leftPercent).toBe(74);
		const withFableLower: Source = {
			...claude,
			groups: [claude.groups[0], { label: "Fable", modelIds: ["fable"], windows: [week(10, NOW + DAY)] }],
		};
		expect(model.focusWindows(withFableLower, undefined, NOW).weekly?.leftPercent).toBe(74);
		// agy has no plan-wide group: the lowest of all groups.
		const offAgy = model.focusWindows(agy, undefined, NOW);
		expect(offAgy.five_hour?.leftPercent).toBe(26);
		expect(offAgy.weekly?.leftPercent).toBe(69);
	});

	it("ignores a window whose reset time has passed and keeps the next lowest", () => {
		const source: Source = {
			id: "s",
			label: "S",
			groups: [
				{ label: "", windows: [five(5, NOW - MIN), week(40, NOW + DAY)] },
				{ label: "", windows: [five(60, NOW + HOUR), week(20, NOW)] },
			],
		};
		const focus = model.focusWindows(source, "m", NOW);
		expect(focus.five_hour?.leftPercent).toBe(60);
		expect(focus.weekly?.leftPercent).toBe(40);
		const allPast: Source = { id: "s", label: "S", groups: [{ label: "", windows: [five(5, NOW - 1)] }] };
		expect(model.focusWindows(allPast, "m", NOW)).toEqual({});
	});

	it("prefers the reading that knows its reset time when two are equal, and returns nothing for no source", () => {
		const source: Source = {
			id: "s",
			label: "S",
			groups: [
				{ label: "", windows: [five(100)] },
				{ label: "", windows: [five(100, NOW + HOUR)] },
			],
		};
		expect(model.focusWindows(source, "m", NOW).five_hour?.resetsAt).toBe(NOW + HOUR);
		expect(model.focusWindows(undefined, "m", NOW)).toEqual({});
	});
});

describe("plan limits: the state and colour of a window", () => {
	it("tells counting, idle, unknown and expired windows apart", () => {
		expect(model.windowState(five(93, NOW + MIN), NOW)).toBe("counting");
		expect(model.windowState(five(93, NOW), NOW)).toBe("expired");
		expect(model.windowState(five(93, NOW - 1), NOW)).toBe("expired");
		expect(model.windowState(five(100), NOW)).toBe("idle");
		expect(model.windowState(five(99.5), NOW)).toBe("idle");
		expect(model.windowState(five(99.4), NOW)).toBe("unknown");
		expect(model.windowState(five(40), NOW)).toBe("unknown");
		// A full window with a reset time is counting, not idle; an expired one is expired whatever its percent.
		expect(model.windowState(five(100, NOW + HOUR), NOW)).toBe("counting");
		expect(model.windowState(five(100, NOW - HOUR), NOW)).toBe("expired");
	});

	it("colours below 10 danger, below 25 warn, the rest plain", () => {
		expect(model.level(0)).toBe("danger");
		expect(model.level(9.99)).toBe("danger");
		expect(model.level(10)).toBe("warn");
		expect(model.level(24.99)).toBe("warn");
		expect(model.level(25)).toBe("");
		expect(model.level(100)).toBe("");
		expect(model.level(Number.NaN)).toBe("");
		expect(model.level(undefined)).toBe("");
		expect(model.worstLevel(["", "warn"])).toBe("warn");
		expect(model.worstLevel(["warn", "danger"])).toBe("danger");
		expect(model.worstLevel(["", ""])).toBe("");
	});

	it("rounds a percent for display and keeps it inside 0-100", () => {
		expect(model.percentOf(92.6)).toBe(93);
		expect(model.percentOf(-3)).toBe(0);
		expect(model.percentOf(130)).toBe(100);
		expect(model.percentOf(undefined)).toBeNull();
	});

	it("knows what is worth drawing: a reading, or the reason there is none", () => {
		expect(model.worthShowing([])).toBe(false);
		expect(model.worthShowing(undefined)).toBe(false);
		expect(model.worthShowing([{ id: "a", label: "A", groups: [] }])).toBe(false);
		expect(model.worthShowing([{ id: "a", label: "A", groups: [], unavailable: "Not signed in" }])).toBe(true);
		expect(model.worthShowing([{ id: "a", label: "A", groups: [], error: "boom" }])).toBe(true);
		expect(model.worthShowing([claude])).toBe(true);
		expect(
			model.usable({ id: "a", label: "A", groups: [{ label: "", windows: [{ kind: "monthly", leftPercent: 5 }] }] }),
		).toBe(false);
	});
});

describe("plan limits: countdown and clock", () => {
	it("rounds down to whole minutes and splits days, hours and minutes", () => {
		expect(model.countdownParts(0)).toEqual({ days: 0, hours: 0, minutes: 0 });
		expect(model.countdownParts(-5 * MIN)).toEqual({ days: 0, hours: 0, minutes: 0 });
		expect(model.countdownParts(Number.NaN)).toEqual({ days: 0, hours: 0, minutes: 0 });
		expect(model.countdownParts(MIN - 1)).toEqual({ days: 0, hours: 0, minutes: 0 });
		expect(model.countdownParts(MIN)).toEqual({ days: 0, hours: 0, minutes: 1 });
		expect(model.countdownParts(HOUR - 1)).toEqual({ days: 0, hours: 0, minutes: 59 });
		expect(model.countdownParts(HOUR)).toEqual({ days: 0, hours: 1, minutes: 0 });
		expect(model.countdownParts(DAY - 1)).toEqual({ days: 0, hours: 23, minutes: 59 });
		expect(model.countdownParts(DAY)).toEqual({ days: 1, hours: 0, minutes: 0 });
		expect(model.countdownParts(5 * DAY + 6 * HOUR + 30 * MIN + 59_000)).toEqual({ days: 5, hours: 6, minutes: 30 });
	});

	it("writes the shortest wording that is exact to the minute", () => {
		const format = (ms: number) => model.formatCountdown(ms, plain);
		expect(format(30_000)).toBe("less than 1 min");
		expect(format(41 * MIN)).toBe("41 min");
		expect(format(HOUR)).toBe("1 h 0 min");
		expect(format(4 * HOUR + 41 * MIN)).toBe("4 h 41 min");
		expect(format(DAY)).toBe("1 d 0 h");
		expect(format(5 * DAY + 6 * HOUR + 59 * MIN)).toBe("5 d 6 h");
	});

	it("reads naturally in Chinese", () => {
		lang.setLang("zh-CN");
		const format = (ms: number) => model.formatCountdown(ms, i18n.t);
		expect(format(5 * DAY + 6 * HOUR)).toBe("5 天 6 小时");
		expect(format(4 * HOUR + 41 * MIN)).toBe("4 小时 41 分");
		expect(format(41 * MIN)).toBe("41 分");
		expect(format(10_000)).toBe("不到 1 分钟");
	});

	it("shows only the clock for a reset today, and the weekday with it for another day", () => {
		expect(model.resetClock(new Date(2026, 10, 14, 21, 5).getTime(), NOW, "en")).toBe("21:05");
		expect(model.resetClock(new Date(2026, 10, 14, 0, 0).getTime(), NOW, "en")).toBe("00:00");
		// 2026-11-15 is the Sunday after the Saturday NOW is on.
		expect(model.resetClock(new Date(2026, 10, 15, 3, 7).getTime(), NOW, "en")).toBe("Sun 03:07");
		expect(model.resetClock(new Date(2026, 10, 15, 3, 7).getTime(), NOW, "zh-CN")).toMatch(/^周日 03:07$/);
		expect(model.resetClock(new Date(2026, 10, 19, 16, 56).getTime(), NOW, "en")).toBe("Thu 16:56");
	});

	it("counts whole minutes since a reading", () => {
		expect(model.minutesSince(NOW - 30_000, NOW)).toBe(0);
		expect(model.minutesSince(NOW - 5 * MIN - 1, NOW)).toBe(5);
		expect(model.minutesSince(NOW + MIN, NOW)).toBe(0);
		expect(model.minutesSince(undefined, NOW)).toBeNull();
	});
});

describe("plan limits: when a new read is worth asking for", () => {
	const fresh = (patch: Partial<Source> = {}): Source => ({ ...claude, observedAt: NOW - MIN, ...patch });

	it("asks when a readable source has no reading or an old one", () => {
		expect(model.needsRefresh([fresh({ observedAt: undefined })], NOW, 10 * MIN)).toBe(true);
		expect(model.needsRefresh([fresh({ observedAt: NOW - 10 * MIN - 1 })], NOW, 10 * MIN)).toBe(true);
		expect(model.needsRefresh([fresh({ observedAt: NOW - 10 * MIN })], NOW, 10 * MIN)).toBe(false);
		expect(model.needsRefresh([fresh()], NOW, 10 * MIN)).toBe(false);
		expect(model.needsRefresh([fresh()], NOW, 30_000)).toBe(true);
		expect(model.needsRefresh([fresh(), fresh({ id: "agy", observedAt: undefined })], NOW, 10 * MIN)).toBe(true);
	});

	it("asks when a window's reset passed more than ten seconds ago, even if the reading is young", () => {
		const group = (resetsAt: number): Group[] => [{ label: "", windows: [five(10, resetsAt)] }];
		expect(model.needsRefresh([fresh({ groups: group(NOW - 10_001) })], NOW, 10 * MIN)).toBe(true);
		expect(model.needsRefresh([fresh({ groups: group(NOW - 10_000) })], NOW, 10 * MIN)).toBe(false);
		expect(model.needsRefresh([fresh({ groups: group(NOW + MIN) })], NOW, 10 * MIN)).toBe(false);
		expect(model.needsRefresh([fresh({ groups: [{ label: "", windows: [five(100)] }] })], NOW, 10 * MIN)).toBe(false);
	});

	it("never asks for a source that has no numbers, is being read, or may not be read again yet", () => {
		const old = { observedAt: NOW - HOUR };
		expect(model.needsRefresh([fresh({ ...old, unavailable: "Not signed in" })], NOW, MIN)).toBe(false);
		expect(model.needsRefresh([fresh({ ...old, refreshing: true })], NOW, MIN)).toBe(false);
		expect(model.needsRefresh([fresh({ ...old, nextRefreshAt: NOW + 1 })], NOW, MIN)).toBe(false);
		expect(model.needsRefresh([fresh({ ...old, nextRefreshAt: NOW })], NOW, MIN)).toBe(true);
		expect(model.needsRefresh([fresh({ observedAt: undefined, nextRefreshAt: NOW + MIN })], NOW, MIN)).toBe(false);
		const reading: Group[] = [{ label: "", windows: [five(10, NOW - MIN)] }];
		expect(model.needsRefresh([fresh({ groups: reading, refreshing: true })], NOW, 10 * MIN)).toBe(false);
		// One quiet source does not hide another one that is due.
		const quiet = fresh({ ...old, refreshing: true });
		expect(model.needsRefresh([quiet, fresh({ id: "agy", ...old })], NOW, MIN)).toBe(true);
	});

	it("asks for nothing when there are no sources", () => {
		expect(model.needsRefresh([], NOW, MIN)).toBe(false);
		expect(model.needsRefresh(undefined, NOW, MIN)).toBe(false);
	});
});

describe("plan limits: where the meter sits", () => {
	it("is mounted in the composer bar between the effort picker and the context ring", () => {
		const composer = readFileSync(new URL("composer.js", webDir), "utf8");
		const at = (name: string) => composer.search(new RegExp(String.raw`<\$\{${name}\}\s*/>`));
		const effort = at("MainEffortPicker");
		const plan = at("PlanUsageMeter");
		const context = at("ContextMeter");
		expect(effort).toBeGreaterThan(-1);
		expect(plan).toBeGreaterThan(effort);
		expect(context).toBeGreaterThan(plan);
	});
});
