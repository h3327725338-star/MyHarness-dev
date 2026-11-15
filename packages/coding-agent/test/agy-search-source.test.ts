import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agyShell, {
	internals,
	parseSearchListing,
	parseSearchOutput,
	SEARCH_DEFAULT_EFFORT,
	SEARCH_DEFAULT_MODEL,
	SEARCH_SOURCE_ID,
	searchRelayText,
} from "../examples/extensions/agy-shell.ts";

const MOCK = fileURLToPath(new URL("./fixtures/mock-acp-agent.mjs", import.meta.url));
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

describe("agy-shell search source: what it reads", () => {
	const output = [
		"Created At: 2026-11-14T06:30:56+08:00",
		"Completed At: 2026-11-14T06:31:02+08:00",
		'The search for "TypeScript 6.0 "release" notes" returned the following summary:',
		"TypeScript 6.0 is the last JavaScript-based release[1]. It shipped in March 2026.[2] Version 7.0 follows[1][3].",
		"",
		"| **Flag** | New default[2] | Why |",
		"吉隆坡今天多云[4]。午后有雷阵雨[4][5]",
		"",
		"Sources:",
		`[1] [typescriptlang.org](${REDIRECT}AAA-one_1==)`,
		`[2] [devblogs.microsoft.com](${REDIRECT}BBB)`,
		`[3] [github.com](${REDIRECT}CCC)`,
		`[4] [weather.example](${REDIRECT}DDD)`,
		`[5] [](${REDIRECT}EEE)`,
		`[6] [typescriptlang.org](${REDIRECT}AAA-one_1==)`,
		`[7] [uncited.example](${REDIRECT}FFF)`,
		"",
		"Note: Source URLs are HTTP redirects; check where they resolve if you need the direct link.",
	].join("\n");

	it("reads a saved search_web result: the query, the sources, and what the summary says of each", () => {
		expect(parseSearchOutput(output)).toEqual({
			query: 'TypeScript 6.0 "release" notes',
			results: [
				{
					title: "typescriptlang.org",
					url: `${REDIRECT}AAA-one_1==`,
					snippet: "TypeScript 6.0 is the last JavaScript-based release.",
				},
				{ title: "devblogs.microsoft.com", url: `${REDIRECT}BBB`, snippet: "It shipped in March 2026." },
				{ title: "github.com", url: `${REDIRECT}CCC`, snippet: "Version 7.0 follows." },
				{ title: "weather.example", url: `${REDIRECT}DDD`, snippet: "吉隆坡今天多云。" },
				// A source without a site name goes by its address; one the summary never cites has no snippet.
				{ title: `${REDIRECT}EEE`, url: `${REDIRECT}EEE`, snippet: "午后有雷阵雨" },
				{ title: "uncited.example", url: `${REDIRECT}FFF`, snippet: undefined },
			],
		});
	});

	it("reads a result without sources as an answered search, and anything else as no result", () => {
		expect(parseSearchOutput('The search for "q" returned the following summary:\nNothing was found.')).toEqual({
			query: "q",
			results: [],
		});
		expect(parseSearchOutput("Created At: now\nSome other tool's output")).toBeUndefined();
		expect(parseSearchOutput("")).toBeUndefined();
	});

	it("cuts a long cited sentence", () => {
		const long = `The search for "q" returned the following summary:\n${"word ".repeat(200)}[1]\n\nSources:\n[1] [a.example](${REDIRECT}A)`;
		const snippet = parseSearchOutput(long)?.results[0].snippet ?? "";
		expect(snippet.length).toBe(301);
		expect(snippet.endsWith("…")).toBe(true);
	});

	it("reads the sources of each query from the relay's own reply", () => {
		const listed = parseSearchListing(
			[
				"Here are the sources.",
				"## 1",
				`[1] [a.example](${REDIRECT}A)`,
				`[2] [b.example](${REDIRECT}B)`,
				`[3] [a.example](${REDIRECT}A)`,
				"## 3 (third query)",
				"none",
				"## 2",
				"[1] [c.example](https://c.example/page)",
			].join("\n"),
		);
		expect([...listed.keys()]).toEqual([0, 2, 1]);
		expect(listed.get(0)).toEqual([
			{ title: "a.example", url: `${REDIRECT}A` },
			{ title: "b.example", url: `${REDIRECT}B` },
		]);
		expect(listed.get(2)).toEqual([]);
		expect(listed.get(1)).toEqual([{ title: "c.example", url: "https://c.example/page" }]);
		expect(parseSearchListing("DONE").size).toBe(0);
	});

	it("tells agy to call search_web once per numbered line, word for word", () => {
		const text = searchRelayText(["tokio vs async-std 2026", "吉隆坡 今天 天气"]);
		expect(text).toContain("search relay");
		expect(text).toContain("search_web");
		expect(text).toContain("word for word");
		expect(text.endsWith("\n1. tokio vs async-std 2026\n2. 吉隆坡 今天 天气")).toBe(true);
	});
});

describe("agy-shell search source with a stand-in agy", () => {
	const saved: Record<string, string | undefined> = {};
	const setEnv = (name: string, value: string | undefined) => {
		if (!(name in saved)) saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	let dir = "";
	let log = "";
	let resolved: string[] = [];
	const logged = (): any[] =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const search = internals.searchWithAgy;

	beforeEach(() => {
		dir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "agy-search-"));
		log = join(dir, "acp.log");
		setEnv("MYHARNESS_AGY_BIN", MOCK);
		setEnv("MYHARNESS_CODING_AGENT_DIR", join(dir, "agent"));
		// Where `agy` keeps its conversations: the home folder, here one of the test's own.
		setEnv("USERPROFILE", join(dir, "home"));
		setEnv("HOME", join(dir, "home"));
		setEnv("MOCK_ACP_LOG", log);
		setEnv("MOCK_ACP_STATE", join(dir, "state.json"));
		setEnv("MOCK_ACP_CAPS", undefined);
		setEnv("MOCK_ACP_NEEDS_AUTH", undefined);
		setEnv("MOCK_ACP_HANG", undefined);
		setEnv("MOCK_ACP_SEARCH", "saved");
		setEnv("MOCK_ACP_LEVELS", undefined);
		setEnv("MOCK_AGY_MODELS", undefined);
		setEnv("GEMINI_API_KEY", undefined);
		resolved = [];
		// The redirect links answer with where they lead; one of them never does.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				resolved.push(url);
				expect(init?.redirect).toBe("manual");
				const name = url.slice(REDIRECT.length);
				if (name === "q1b") throw new TypeError("fetch failed");
				return new Response(null, {
					status: 302,
					headers: { location: `https://${name.slice(2)}.example/${name.slice(0, 2)}` },
				});
			}),
		);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		// The stand-ins end when their input closes; their files are free after that.
		await settle(200);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("registers as a search source that defaults to Gemini 3.8 Flash and offers the models agy has listed", async () => {
		const sources: any[] = [];
		const pi: any = new Proxy(
			{},
			{
				get: (_target, name) =>
					name === "registerWebSearchSource"
						? (source: any) => sources.push(source)
						: name === "getActiveTools"
							? () => []
							: () => {},
			},
		);
		agyShell(pi);
		expect(sources).toHaveLength(1);
		const [source] = sources;
		expect(source).toMatchObject({ id: SEARCH_SOURCE_ID, label: "agy", defaultModel: SEARCH_DEFAULT_MODEL });
		expect(SEARCH_DEFAULT_MODEL).toBe("gemini-3.8-flash");
		expect(source.unavailable()).toBeUndefined();
		// A search thinks as little as agy lets it unless the user picks another level.
		expect(source.defaultEffort).toBe(SEARCH_DEFAULT_EFFORT);
		expect(SEARCH_DEFAULT_EFFORT).toBe("low");
		// Before any conversation taught the list: the default alone, with the levels every model of agy's has.
		const everyModel = ["low", "medium", "high"];
		expect(source.models()).toEqual([{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: everyModel }]);
		mkdirSync(join(dir, "agent", "agy-shell"), { recursive: true });
		writeFileSync(
			join(dir, "agent", "agy-shell", "models.json"),
			JSON.stringify([
				{ id: "gemini-4-argon", name: "Gemini 4 Argon" },
				{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", levels: ["low", "medium", "high", "xhigh"] },
				{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", levels: [] },
				// A list saved by an earlier version of the extension.
				{ id: "default", name: "Default" },
			]),
		);
		expect(source.models()).toEqual([
			{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: everyModel },
			// Each model with the thinking levels agy has for it; one whose levels are not known yet with the common ones.
			{ id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: everyModel },
			{ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
			// A model without the option has no level to pick.
			{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", efforts: [] },
		]);
		// Loading the extension asks the stand-in for its model list; that is over before the test's folder goes.
		await internals.shared.discovery;
	});

	it("searches every query in one conversation, reads the results agy saved, and stops the turn before its reply", async () => {
		const answers = await search({ queries: ["tokio vs async-std", "吉隆坡  今天\n天气"], timeoutMs: 15_000 });
		expect(answers).toEqual([
			{
				query: "tokio vs async-std",
				results: [
					{
						title: "a.example",
						url: "https://a.example/q0",
						snippet: "About tokio vs async-std: version 6.0 is out.",
					},
					{ title: "b.example", url: "https://b.example/q0", snippet: "Nothing else is known." },
				],
			},
			{
				// Asked as one line; answered under the query exactly as it was given.
				query: "吉隆坡  今天\n天气",
				results: [
					{
						title: "a.example",
						url: "https://a.example/q1",
						snippet: "About 吉隆坡 今天 天气: version 6.0 is out.",
					},
					// A redirect link that did not answer stays as it is: the page read follows it.
					{ title: "b.example", url: `${REDIRECT}q1b`, snippet: "Nothing else is known." },
				],
			},
		]);
		expect(resolved.sort()).toEqual(["q0a", "q0b", "q1a", "q1b"].map((name) => `${REDIRECT}${name}`));
		await settle(600);
		const entries = logged();
		const methods = entries.map((entry) => entry.method).filter(Boolean);
		expect(methods).toEqual([
			"initialize",
			"session/new",
			"session/set_config_option",
			"session/prompt",
			"session/cancel",
			"session/close",
		]);
		// The model is agy's first one already (the default); only the thinking level is lowered.
		expect(entries.find((entry) => entry.method === "session/set_config_option").value).toBe("low");
		expect(entries.find((entry) => entry.method === "session/new").mcp).toEqual([]);
		expect(entries.some((entry) => entry.replied)).toBe(false);
		// The models agy listed are remembered for the settings page.
		expect(internals.searchModels().map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.8-pro"]);
	});

	it("searches with the model chosen in Web Search settings, and names agy's models when it has none of that name", async () => {
		await search({ queries: ["q"], model: "gemini-3.8-pro", timeoutMs: 15_000 });
		expect(
			logged()
				.filter((entry) => entry.method === "session/set_config_option")
				.map((entry) => entry.value),
		).toEqual(["gemini-3.8-pro", "low"]);
		await expect(search({ queries: ["q"], model: "gone-model", timeoutMs: 15_000 })).rejects.toThrow(
			"agy 现在没有模型 gone-model。它提供的是：Gemini 3.8 Flash、Gemini 3.8 Pro。",
		);
	});

	it("searches with the thinking level chosen in Web Search settings, and the lowest one when the model has not got it", async () => {
		const levelsSet = () =>
			logged()
				.filter((entry) => entry.method === "session/set_config_option")
				.map((entry) => entry.value);
		await search({ queries: ["q"], effort: "high", timeoutMs: 15_000 });
		expect(levelsSet()).toEqual(["high"]);
		// agy calls xhigh "Extra".
		await search({ queries: ["q"], effort: "xhigh", timeoutMs: 15_000 });
		expect(levelsSet()).toEqual(["high", "extra"]);
		// The stand-in's sessions start on Medium, so a search on Medium has nothing to set.
		await search({ queries: ["q"], effort: "medium", timeoutMs: 15_000 });
		expect(levelsSet()).toEqual(["high", "extra"]);
		// A level this model has not got: the lowest, as when none is chosen.
		setEnv("MOCK_ACP_LEVELS", JSON.stringify({ "gemini-3.8-flash": ["Low", "Medium", "High"] }));
		await search({ queries: ["q"], effort: "max", timeoutMs: 15_000 });
		expect(levelsSet()).toEqual(["high", "extra", "low"]);
		// A model without the option is searched with as it is.
		setEnv("MOCK_ACP_LEVELS", JSON.stringify({ "gemini-3.8-flash": [] }));
		const answers = await search({ queries: ["q"], effort: "high", timeoutMs: 15_000 });
		expect(answers[0].results.length).toBeGreaterThan(0);
		expect(levelsSet()).toEqual(["high", "extra", "low"]);
	});

	it("reads the sources from the relay's reply when agy saved no results", async () => {
		setEnv("MOCK_ACP_SEARCH", "listing");
		const answers = await search({ queries: ["first", "second"], timeoutMs: 15_000 });
		expect(answers).toEqual([
			{
				query: "first",
				results: [
					{ title: "a.example", url: "https://a.example/q0" },
					{ title: "b.example", url: "https://b.example/q0" },
				],
			},
			{
				query: "second",
				results: [
					{ title: "a.example", url: "https://a.example/q1" },
					{ title: "b.example", url: `${REDIRECT}q1b` },
				],
			},
		]);
		const entries = logged();
		expect(entries.some((entry) => entry.replied)).toBe(true);
		expect(entries.some((entry) => entry.method === "session/cancel")).toBe(false);
	});

	it("reports searches agy's tool failed as those queries' failures", async () => {
		setEnv("MOCK_ACP_SEARCH", "fail");
		expect(await search({ queries: ["first"], timeoutMs: 15_000 })).toEqual([
			{ query: "first", results: [], error: "agy 的搜索失败了。" },
		]);
		expect(resolved).toEqual([]);
	});

	it("refuses and stops a relay that does anything but search", async () => {
		setEnv("MOCK_ACP_SEARCH", "other");
		const answers = await search({ queries: ["first"], timeoutMs: 15_000 });
		expect(answers).toEqual([
			{ query: "first", results: [], error: "agy 没有按要求只做搜索（它调用了 Run whoami），这次搜索已停止。" },
		]);
		await settle(300);
		expect(logged().some((entry) => entry.method === "session/cancel")).toBe(true);
	});

	it("fails as a whole when nothing came back in its time, or nobody is signed in", async () => {
		setEnv("MOCK_ACP_SEARCH", "never");
		const started = Date.now();
		await expect(search({ queries: ["q"], timeoutMs: 1_200 })).rejects.toThrow("agy 在 1 秒内没有返回任何搜索结果。");
		expect(Date.now() - started).toBeLessThan(5_000);
		setEnv("MOCK_ACP_SEARCH", "saved");
		setEnv("MOCK_ACP_NEEDS_AUTH", "1");
		await expect(search({ queries: ["q"], timeoutMs: 15_000 })).rejects.toThrow("agy 还没有登录");
	});

	it("stops agy at once when the person stops the call", async () => {
		setEnv("MOCK_ACP_SEARCH", "never");
		const controller = new AbortController();
		const work = search({ queries: ["q"], timeoutMs: 15_000, signal: controller.signal });
		await settle(500);
		const started = Date.now();
		controller.abort();
		await expect(work).rejects.toThrow("已中断");
		expect(Date.now() - started).toBeLessThan(1_000);
		await settle(300);
		expect(logged().some((entry) => entry.method === "session/cancel")).toBe(true);
	});
});
