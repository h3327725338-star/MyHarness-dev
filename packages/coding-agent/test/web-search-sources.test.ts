import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { WebSearchSettings } from "../src/config/settings/types.ts";
import { WebSearchCache } from "../src/tools/web-search/cache.ts";
import { WEB_SEARCH_LIMITS, WebSearchError, WebSearchService } from "../src/tools/web-search/service.ts";
import {
	getWebSearchSource,
	listWebSearchSources,
	registerWebSearchSource,
	timeRangeWords,
	unregisterWebSearchSource,
	type WebSearchSource,
	type WebSearchSourceRequest,
	webSearchSourceEffort,
	webSearchSourceEfforts,
	webSearchSourceModel,
} from "../src/tools/web-search/sources.ts";
import { createWebSearchToolDefinition } from "../src/tools/web-search/tool.ts";

function ddgHtml(results: Array<{ title: string; url: string; snippet?: string }>): string {
	const rows = results
		.map(
			(result, index) => `
<tr><td valign="top">${index + 1}.&nbsp;</td><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}&amp;rut=abc" class='result-link'>${result.title}</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>${result.snippet ?? ""}</td></tr>
<tr><td>&nbsp;</td><td><span class='link-text'>${result.url}</span></td></tr>`,
		)
		.join("");
	return `<html><body><form action="/lite/" method="post"><input name="q" type="text"></form><table>${rows}</table></body></html>`;
}

const html = (body: string) =>
	new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

/** A source that answers every query with `links`, and records what it was asked. */
function fakeSource(
	id: string,
	links: Array<{ title: string; url: string; snippet?: string }>,
	extra: Partial<WebSearchSource> = {},
): WebSearchSource & { requests: WebSearchSourceRequest[] } {
	const requests: WebSearchSourceRequest[] = [];
	return {
		id,
		label: `${id} label`,
		requests,
		async search(request) {
			requests.push(request);
			return request.queries.map((query) => ({ query, results: links }));
		},
		...extra,
	};
}

function createService(
	settings: WebSearchSettings,
	sources: WebSearchSource[],
	options: { pages?: Record<string, string>; now?: () => number; timeoutMs?: number } = {},
) {
	const settingsManager = SettingsManager.inMemory({
		webSearch: { enabled: true, browserFallback: true, pagesPerSearch: 0, ...settings },
	});
	const calls: string[] = [];
	const service = new WebSearchService({
		settings: settingsManager,
		fetchImpl: vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			calls.push(url.hostname);
			if (url.hostname === "lite.duckduckgo.com") {
				return html(
					ddgHtml([
						{ title: "Shared result", url: "https://shared.example/page", snippet: "fetch api docs" },
						{ title: "DDG only", url: "https://ddg.example/", snippet: "fetch" },
					]),
				);
			}
			const page = options.pages?.[url.hostname];
			if (page) return html(page);
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
		}),
		lookup: async () => ["93.184.216.34"],
		cache: new WebSearchCache(undefined),
		browser: null,
		sources: () => sources,
		now: options.now,
		extensionSourceTimeoutMs: options.timeoutMs,
		extensionSourceGraceMs: options.timeoutMs === undefined ? undefined : 10,
	});
	return { service, settingsManager, calls };
}

describe("web search source registry", () => {
	afterEach(() => {
		for (const source of listWebSearchSources()) unregisterWebSearchSource(source.id);
	});

	it("keeps one source per id, the latest registration", () => {
		const first = fakeSource("my-search", []);
		const second = fakeSource("my-search", []);
		registerWebSearchSource(first);
		registerWebSearchSource(fakeSource("other", []));
		registerWebSearchSource(second);
		expect(listWebSearchSources().map((source) => source.id)).toEqual(["my-search", "other"]);
		expect(getWebSearchSource("my-search")).toBe(second);
	});

	it("refuses ids that are not plain names, a built-in engine's id, and a source that cannot search", () => {
		for (const id of ["", "Has Space", "UPPER", "tavily", "google", "-lead", "a".repeat(41)]) {
			expect(() => registerWebSearchSource(fakeSource(id, [])), id).toThrow(/Invalid web search source id/);
		}
		expect(() => registerWebSearchSource({ id: "no-search", label: "x" } as unknown as WebSearchSource)).toThrow(
			/needs a label and a search function/,
		);
		expect(() => registerWebSearchSource({ ...fakeSource("no-label", []), label: " " })).toThrow(/needs a label/);
		expect(listWebSearchSources()).toEqual([]);
	});

	it("searches with the chosen model while the source still offers it, else with its default", () => {
		const source = fakeSource("pick", [], {
			models: () => [
				{ id: "fast", label: "Fast" },
				{ id: "big", label: "Big" },
			],
			defaultModel: "fast",
		});
		expect(webSearchSourceModel(source, "big")).toBe("big");
		expect(webSearchSourceModel(source, "gone")).toBe("fast");
		expect(webSearchSourceModel(source, undefined)).toBe("fast");
		// A source that lists no models takes whatever was saved.
		expect(webSearchSourceModel(fakeSource("free", []), "anything")).toBe("anything");
	});

	it("searches on the chosen reasoning level while the model has it, else the source's default, else the lowest", () => {
		const source = fakeSource("levels", [], {
			models: () => [
				{ id: "fast", label: "Fast", efforts: ["low", "medium", "high"] },
				{ id: "deep", label: "Deep", efforts: ["medium", "high", "xhigh"] },
				{ id: "plain", label: "Plain", efforts: [] },
				{ id: "old", label: "Old" },
			],
			defaultModel: "fast",
			defaultEffort: "low",
		});
		expect(webSearchSourceEfforts(source, "fast")).toEqual(["low", "medium", "high"]);
		expect(webSearchSourceEffort(source, "fast", "high")).toBe("high");
		expect(webSearchSourceEffort(source, "fast", undefined)).toBe("low");
		// A level chosen for another model that this one has not got.
		expect(webSearchSourceEffort(source, "fast", "xhigh")).toBe("low");
		// The source's default is not one of this model's levels: its lowest.
		expect(webSearchSourceEffort(source, "deep", undefined)).toBe("medium");
		expect(webSearchSourceEffort(source, "deep", "xhigh")).toBe("xhigh");
		// A model with no levels to pick, a model that names none, and a source without models: no level is passed on.
		for (const model of ["plain", "old", "gone", undefined]) {
			expect(webSearchSourceEfforts(source, model)).toEqual([]);
			expect(webSearchSourceEffort(source, model, "high")).toBeUndefined();
		}
		expect(webSearchSourceEffort(fakeSource("free", []), "anything", "high")).toBeUndefined();
	});

	it("words a time range the way a person would add it, in the query's language", () => {
		const now = new Date(2026, 10, 14, 9).getTime();
		expect(timeRangeWords("typescript release", "day", now)).toBe("November 14 2026");
		expect(timeRangeWords("typescript release", "week", now)).toBe("November 2026");
		expect(timeRangeWords("typescript release", "month", now)).toBe("November 2026");
		expect(timeRangeWords("typescript release", "year", now)).toBe("2026");
		expect(timeRangeWords("吉隆坡 天气", "day", now)).toBe("2026年11月14日");
		expect(timeRangeWords("吉隆坡 天气", "month", now)).toBe("2026年11月");
		expect(timeRangeWords("吉隆坡 天气", "year", now)).toBe("2026年");
	});
});

describe("WebSearchService with extension sources", () => {
	const links = [
		{ title: "Shared result", url: "https://www.shared.example/page?utm_source=x" },
		{ title: "Source only", url: "https://source.example/", snippet: "from the  program" },
	];

	it("merges a source's pages with the engines' results and names it like an engine", async () => {
		const source = fakeSource("prog", links);
		const { service } = createService({ engines: ["duckduckgo"], extensionSources: ["prog"] }, [source]);
		const response = await service.search({ queries: ["fetch api"] });
		expect(response.engines).toEqual(["duckduckgo", "prog"]);
		expect(response.failures).toEqual([]);
		expect(response.results[0]).toMatchObject({
			url: "https://shared.example/page",
			source: "DuckDuckGo, prog label",
			engines: ["duckduckgo", "prog"],
		});
		expect(response.results.find((result) => result.url === "https://source.example/")).toMatchObject({
			source: "prog label",
			snippet: "from the program",
			engineRank: 2,
		});
		expect(response.routes).toEqual([
			{ engine: "duckduckgo", query: "fetch api", via: "http", resultCount: 2 },
			{ engine: "prog", query: "fetch api", via: "extension", note: undefined, resultCount: 2 },
		]);
		expect(source.requests).toEqual([
			expect.objectContaining({
				queries: ["fetch api"],
				model: undefined,
				timeoutMs: WEB_SEARCH_LIMITS.extensionSourceTimeoutMs,
			}),
		]);
	});

	it("asks a source once for all queries of a call, with the model chosen in settings", async () => {
		const source = fakeSource("prog", links, {
			models: () => [
				{ id: "fast", label: "Fast" },
				{ id: "big", label: "Big" },
			],
			defaultModel: "fast",
		});
		const { service, settingsManager } = createService(
			{ engines: [], extensionSources: ["prog"], extensionSourceModels: { prog: "big" } },
			[source],
		);
		const response = await service.search({ queries: ["one", "two", "one"] });
		expect(source.requests).toHaveLength(1);
		expect(source.requests[0]).toMatchObject({ queries: ["one", "two"], model: "big" });
		expect(response.engines).toEqual(["prog"]);
		expect(response.results.map((result) => result.url)).toEqual([
			"https://www.shared.example/page?utm_source=x",
			"https://source.example/",
		]);
		// Another model is another search: the cached answer of the first is not used for it.
		settingsManager.setWebSearchSettings({
			...settingsManager.getWebSearchSettings(),
			extensionSourceModels: { prog: "fast" },
		});
		await service.search({ queries: ["one", "two"] });
		expect(source.requests).toHaveLength(2);
		expect(source.requests[1].model).toBe("fast");
		await service.search({ queries: ["one", "two"] });
		expect(source.requests).toHaveLength(2);
	});

	it("passes the reasoning level chosen in settings on to the source, for the model it searches with", async () => {
		const source = fakeSource("prog", links, {
			models: () => [
				{ id: "fast", label: "Fast", efforts: ["low", "medium", "high"] },
				{ id: "plain", label: "Plain", efforts: [] },
			],
			defaultModel: "fast",
			defaultEffort: "low",
		});
		const { service, settingsManager } = createService({ engines: [], extensionSources: ["prog"] }, [source]);
		const choose = (extra: Partial<WebSearchSettings>) =>
			settingsManager.setWebSearchSettings({ ...settingsManager.getWebSearchSettings(), ...extra });
		// Nothing chosen: the source's default.
		await service.search({ queries: ["one"] });
		expect(source.requests[0]).toMatchObject({ model: "fast", effort: "low" });
		choose({ extensionSourceEfforts: { prog: "high" } });
		await service.search({ queries: ["two"] });
		expect(source.requests[1]).toMatchObject({ model: "fast", effort: "high" });
		// The level stays saved while the source searches with a model that has none.
		choose({ extensionSourceModels: { prog: "plain" } });
		await service.search({ queries: ["three"] });
		expect(source.requests[2].model).toBe("plain");
		expect(source.requests[2].effort).toBeUndefined();
		expect(settingsManager.getWebSearchSettings().extensionSourceEfforts).toEqual({ prog: "high" });
	});

	it("reads the pages a source found like any other result's", async () => {
		const source = fakeSource("prog", [{ title: "Doc", url: "https://doc.example/" }]);
		const { service, calls } = createService(
			{ engines: [], extensionSources: ["prog"], pagesPerSearch: 1 },
			[source],
			{
				pages: {
					"doc.example":
						"<html><head><title>Doc page</title></head><body><main><p>the real page text</p></main></body></html>",
				},
			},
		);
		const response = await service.search({ queries: ["doc"] });
		expect(calls).toEqual(["doc.example"]);
		expect(response.pages).toEqual([
			expect.objectContaining({
				url: "https://doc.example/",
				title: "Doc page",
				markdown: expect.stringContaining("the real page text"),
			}),
		]);
	});

	it("leaves out, without a word, a source that is switched on but missing or unusable on this computer", async () => {
		const unusable = fakeSource("gone", links, { unavailable: () => "the program is not installed" });
		const broken = fakeSource("broken", links, {
			unavailable: () => {
				throw new Error("boom");
			},
		});
		const { service } = createService(
			{ engines: ["duckduckgo"], extensionSources: ["gone", "broken", "never-registered"] },
			[unusable, broken],
		);
		const response = await service.search({ queries: ["fetch api"] });
		expect(response.engines).toEqual(["duckduckgo"]);
		expect(response.failures).toEqual([]);
		expect(unusable.requests).toEqual([]);

		const alone = createService({ engines: [], extensionSources: ["gone"] }, [unusable]);
		await expect(alone.service.search({ queries: ["x"] })).rejects.toMatchObject({ code: "no_engines" });
	});

	it("does not use a registered source that is not switched on", async () => {
		const source = fakeSource("prog", links);
		const { service } = createService({ engines: ["duckduckgo"] }, [source]);
		const response = await service.search({ queries: ["fetch api"] });
		expect(response.engines).toEqual(["duckduckgo"]);
		expect(source.requests).toEqual([]);
	});

	it("reports a query the source could not answer and keeps the others", async () => {
		const source = fakeSource("prog", links, {
			async search(request) {
				return [
					{ query: request.queries[0], results: links },
					{ query: request.queries[1], results: [], error: "the program gave up on this one" },
				];
			},
		});
		const { service } = createService({ engines: [], extensionSources: ["prog"] }, [source]);
		const response = await service.search({ queries: ["good", "bad", "unanswered"] });
		expect(response.results.length).toBe(2);
		expect(response.failures).toEqual([
			{ query: "bad", engine: "prog", code: "unavailable", message: "the program gave up on this one" },
			{ query: "unanswered", engine: "prog", code: "unavailable", message: "没有返回这个问题的结果。" },
		]);
		expect(response.routes.map((route) => route.query)).toEqual(["good"]);
	});

	it("keeps the engines' results when a source fails as a whole, and leaves it alone for a while", async () => {
		let now = 1_000_000;
		let calls = 0;
		const source = fakeSource("prog", links, {
			async search() {
				calls += 1;
				throw new Error("Not logged in · Please run /login");
			},
		});
		const { service } = createService({ engines: ["duckduckgo"], extensionSources: ["prog"] }, [source], {
			now: () => now,
		});
		const first = await service.search({ queries: ["fetch api"], fresh: true });
		expect(first.results.map((result) => result.url)).toEqual([
			"https://shared.example/page",
			"https://ddg.example/",
		]);
		expect(first.failures).toEqual([
			{ engine: "prog", code: "unavailable", message: "Not logged in · Please run /login" },
		]);

		now += 30_000;
		const second = await service.search({ queries: ["fetch api"], fresh: true });
		expect(calls).toBe(1);
		expect(second.failures).toEqual([
			{
				engine: "prog",
				code: "unavailable",
				message: "prog label 暂停使用 90 秒，原因是刚才的失败：Not logged in · Please run /login",
			},
		]);

		now += WEB_SEARCH_LIMITS.extensionSourceCooldownMs;
		await service.search({ queries: ["fetch api"], fresh: true });
		expect(calls).toBe(2);
	});

	it("fails when the only source fails, in the source's own words", async () => {
		const source = fakeSource("prog", links, {
			async search() {
				throw new WebSearchError("rate_limited", "the plan's limit is reached");
			},
		});
		const { service } = createService({ engines: [], extensionSources: ["prog"] }, [source]);
		await expect(service.search({ queries: ["x"] })).rejects.toMatchObject({
			code: "rate_limited",
			message: "所有搜索引擎的请求都失败了：prog label：the plan's limit is reached",
		});
	});

	it("gives up on a source that does not answer in its time, and tells it to stop", async () => {
		let signal: AbortSignal | undefined;
		const source = fakeSource("prog", links, {
			search: (request) => {
				signal = request.signal;
				return new Promise(() => {});
			},
		});
		const { service } = createService({ engines: ["duckduckgo"], extensionSources: ["prog"] }, [source], {
			timeoutMs: 40,
		});
		const response = await service.search({ queries: ["fetch api"] });
		expect(response.results).toHaveLength(2);
		expect(response.failures).toEqual([{ engine: "prog", code: "timeout", message: "0 秒内没有返回结果。" }]);
		expect(signal?.aborted).toBe(true);
	});

	it("ends at once on a stop and passes the stop on to the source", async () => {
		let signal: AbortSignal | undefined;
		const source = fakeSource("prog", links, {
			search: (request) => {
				signal = request.signal;
				return new Promise(() => {});
			},
		});
		const { service } = createService({ engines: [], extensionSources: ["prog"] }, [source]);
		const controller = new AbortController();
		const work = service.search({ queries: ["x"] }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await expect(work).rejects.toMatchObject({ code: "aborted" });
		expect(signal?.aborted).toBe(true);
		// A stop is no failure of the source: the next search asks it again.
		const again = createService({ engines: [], extensionSources: ["prog"] }, [fakeSource("prog", links)]);
		expect((await again.service.search({ queries: ["x"] })).results).toHaveLength(2);
	});

	it("puts a time range into the query for a source, and answers under the query as asked", async () => {
		const now = new Date(2026, 10, 14, 9).getTime();
		const source = fakeSource("prog", links);
		const { service } = createService({ engines: [], extensionSources: ["prog"] }, [source], { now: () => now });
		const response = await service.search({ queries: ["typescript release", "吉隆坡 天气"], timeRange: "month" });
		expect(source.requests[0].queries).toEqual(["typescript release November 2026", "吉隆坡 天气 2026年11月"]);
		expect(response.routes).toEqual([
			expect.objectContaining({
				query: "typescript release",
				note: "prog label 没有时间筛选，已在搜索词后加上“November 2026”。",
			}),
			expect.objectContaining({
				query: "吉隆坡 天气",
				note: "prog label 没有时间筛选，已在搜索词后加上“2026年11月”。",
			}),
		]);
		expect(response.results[0].queries).toEqual(["typescript release", "吉隆坡 天气"]);
	});

	it("drops entries of a source's answer that are no pages", async () => {
		const source = fakeSource("prog", [], {
			async search(request) {
				return [
					{
						query: request.queries[0],
						results: [
							{ title: "", url: "https://untitled.example/" },
							{ title: "Local", url: "http://127.0.0.1/admin" },
							{ title: "No address", url: "" },
							null,
							{ title: 5, url: "https://number-title.example/" },
						] as never,
					},
				];
			},
		});
		const { service } = createService({ engines: [], extensionSources: ["prog"] }, [source]);
		const response = await service.search({ queries: ["x"] });
		expect(response.results.map((result) => [result.title, result.url])).toEqual([
			["https://untitled.example/", "https://untitled.example/"],
			["https://number-title.example/", "https://number-title.example/"],
		]);
	});

	it("shows a source in the tool's Engines line and Diagnostics by its name, with no transport", async () => {
		const source = fakeSource("prog", links, {
			async search(request) {
				return [
					{ query: request.queries[0], results: links },
					{ query: request.queries[1], results: [], error: "gave up" },
				];
			},
		});
		const { service } = createService({ engines: ["duckduckgo"], extensionSources: ["prog"] }, [source]);
		const definition = createWebSearchToolDefinition("C:\\myharness", { service });
		const updates: string[] = [];
		const result = await definition.execute(
			"call-1",
			{ queries: ["fetch api", "other"] },
			undefined,
			(update) => updates.push(update.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
			undefined,
		);
		const visible = result.content.find((part) => part.type === "text")?.text ?? "";
		expect(visible).toContain("Engines: DuckDuckGo (HTTP), prog label\n");
		expect(visible).toContain("Source: DuckDuckGo, prog label");
		expect(visible).toContain("- [unavailable] prog label · other: gave up");
		expect(updates).toEqual(["正在用 prog label 搜索，这比搜索引擎慢，通常要十几秒。"]);
		expect(result.details.engines).toEqual(["duckduckgo", "prog"]);
	});
});
