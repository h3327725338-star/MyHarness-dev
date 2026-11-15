import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeCodeShell, {
	ENTRYPOINT,
	internals,
	SEARCH_DEFAULT_EFFORT,
	SEARCH_DEFAULT_MODEL,
	SEARCH_EFFORTS,
	SEARCH_RELAY_PROMPT,
	SEARCH_SOURCE_ID,
	SearchRun,
	searchArgs,
	searchLinks,
} from "../examples/extensions/claude-code-shell.ts";

const MOCK = fileURLToPath(new URL("./fixtures/mock-claude-search.mjs", import.meta.url));

const call = (id: string, query: string) => ({
	type: "assistant",
	message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query } }] },
});
const found = (id: string, links: Array<{ title: string; url: string }>) => ({
	type: "user",
	message: { content: [{ type: "tool_result", tool_use_id: id, content: "text" }] },
	tool_use_result: { results: [{ tool_use_id: "srv", content: links }, "A summary."] },
});

describe("claude-code-shell search source: what it reads", () => {
	it("starts claude with its WebSearch only, nothing of the user's setup, and keeps no conversation", () => {
		const args = searchArgs("claude-haiku-5-5", "C:\\data\\search-prompt.md");
		const value = (flag: string) => args[args.indexOf(flag) + 1];
		expect(args[0]).toBe("-p");
		expect(value("--tools")).toBe("WebSearch");
		expect(value("--model")).toBe("claude-haiku-5-5");
		expect(value("--setting-sources")).toBe("");
		expect(value("--append-system-prompt-file")).toBe("C:\\data\\search-prompt.md");
		for (const flag of [
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--no-chrome",
			"--no-session-persistence",
		]) {
			expect(args, flag).toContain(flag);
		}
		// No other prompt replaces Claude Code's own: the relay's instructions are appended.
		expect(args).not.toContain("--system-prompt-file");
		expect(SEARCH_RELAY_PROMPT).toContain("word for word");
	});

	it("searches on the lowest reasoning level unless another one is chosen", () => {
		const effortOf = (args: string[]) => args[args.indexOf("--effort") + 1];
		expect(SEARCH_DEFAULT_EFFORT).toBe("low");
		expect(effortOf(searchArgs("claude-haiku-5-5", "p.md"))).toBe("low");
		for (const effort of SEARCH_EFFORTS)
			expect(effortOf(searchArgs("claude-haiku-5-5", "p.md", effort))).toBe(effort);
		// A level `claude --effort` does not take never reaches it.
		expect(effortOf(searchArgs("claude-haiku-5-5", "p.md", "minimal"))).toBe("low");
		expect(effortOf(searchArgs("claude-haiku-5-5", "p.md", "--model x"))).toBe("low");
	});

	it("takes a search's pages from the structured copy, or from the Links line of the text", () => {
		const links = [
			{ title: "One", url: "https://one.example/" },
			{ title: "Two", url: "https://two.example/a" },
			{ title: "One again", url: "https://one.example/" },
			{ title: "Not a page", url: "javascript:alert(1)" },
			{ url: "https://untitled.example/" },
		];
		const expected = [
			{ title: "One", url: "https://one.example/" },
			{ title: "Two", url: "https://two.example/a" },
			{ title: "", url: "https://untitled.example/" },
		];
		expect(searchLinks({ tool_use_result: { results: [{ content: links }, "summary"] } }, {})).toEqual(expected);
		const text = `Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}\n\nThe results agree.`;
		expect(searchLinks({}, { content: text })).toEqual(expected);
		expect(searchLinks({}, { content: [{ type: "text", text }] })).toEqual(expected);
		expect(searchLinks({}, { content: "Links: [not json" })).toEqual([]);
		expect(searchLinks({}, { content: "no links here" })).toEqual([]);
	});

	it("matches each WebSearch call to its query, also the same query asked twice", () => {
		const run = new SearchRun(["tokio vs async-std", "same", "same"]);
		run.take(call("a", "same"));
		run.take(call("b", "  Tokio  VS async-std "));
		run.take(call("c", "same"));
		run.take({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } });
		expect(run.complete).toBe(false);
		run.take(found("b", [{ title: "T", url: "https://t.example/" }]));
		run.take(found("a", [{ title: "S1", url: "https://s1.example/" }]));
		run.take(found("unknown", [{ title: "?", url: "https://unknown.example/" }]));
		expect(run.complete).toBe(false);
		run.take(found("c", [{ title: "S2", url: "https://s2.example/" }]));
		expect(run.complete).toBe(true);
		expect(run.finish("missing")).toEqual([
			{ query: "tokio vs async-std", results: [{ title: "T", url: "https://t.example/" }] },
			{ query: "same", results: [{ title: "S1", url: "https://s1.example/" }] },
			{ query: "same", results: [{ title: "S2", url: "https://s2.example/" }] },
		]);
	});

	it("matches calls whose query the model changed by their place, only when that is unambiguous", () => {
		const reworded = new SearchRun(["first", "second", "third"]);
		reworded.take(call("a", "first"));
		reworded.take(call("b", "the second one"));
		reworded.take(call("c", "3rd"));
		for (const id of ["c", "a", "b"]) reworded.take(found(id, [{ title: id, url: `https://${id}.example/` }]));
		expect(reworded.complete).toBe(false);
		// Strays go to the open queries in the order they finished.
		expect(reworded.finish("missing").map((answer) => answer.results[0]?.url)).toEqual([
			"https://a.example/",
			"https://c.example/",
			"https://b.example/",
		]);

		const unclear = new SearchRun(["first", "second"]);
		unclear.take(call("a", "something else"));
		unclear.take(found("a", [{ title: "a", url: "https://a.example/" }]));
		expect(unclear.finish("missing")).toEqual([
			{ query: "first", results: [], error: "missing" },
			{ query: "second", results: [], error: "missing" },
		]);
	});

	it("keeps a failed search's own words and an error that ended the turn", () => {
		const run = new SearchRun(["q"]);
		run.take(call("a", "q"));
		run.take({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "Web search is unavailable." }],
			},
		});
		expect(run.finish("missing")).toEqual([{ query: "q", results: [], error: "Web search is unavailable." }]);

		const ended = new SearchRun(["q"]);
		ended.take({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
		expect(ended.ended).toBe(true);
		expect(ended.problem).toBe("Not logged in · Please run /login");
		const fine = new SearchRun(["q"]);
		fine.take({ type: "result", is_error: false, result: "DONE" });
		expect(fine.problem).toBeUndefined();
	});
});

describe("claude-code-shell search source with a stand-in claude", () => {
	const saved: Record<string, string | undefined> = {};
	const setEnv = (name: string, value: string | undefined) => {
		if (!(name in saved)) saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	let dir = "";
	let log = "";
	const logged = (): any[] =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const search = internals.searchWithClaude;

	beforeEach(() => {
		dir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "claude-search-"));
		log = join(dir, "claude.log");
		setEnv("MYHARNESS_CLAUDE_BIN", MOCK);
		setEnv("MYHARNESS_CODING_AGENT_DIR", join(dir, "agent"));
		setEnv("MOCK_CLAUDE_LOG", log);
		setEnv("MOCK_CLAUDE_MODE", undefined);
		// A key lying in the environment must not reach `claude`: it searches on the user's own login.
		setEnv("ANTHROPIC_API_KEY", "sk-should-not-be-passed-on");
	});
	afterEach(async () => {
		// The stand-ins end when they are stopped; their files are free after that.
		await settle(150);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("registers as a search source with the provider's models and Haiku as the default", () => {
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
		claudeCodeShell(pi);
		expect(sources).toHaveLength(1);
		const [source] = sources;
		expect(source).toMatchObject({ id: SEARCH_SOURCE_ID, label: "Claude Code", defaultModel: SEARCH_DEFAULT_MODEL });
		expect(SEARCH_SOURCE_ID).toBe("claude-code");
		// Each model with the reasoning levels a search may run on.
		expect(source.models()).toContainEqual({
			id: "claude-haiku-5-5",
			label: "Haiku 5.5",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		});
		expect(source.defaultEffort).toBe("low");
		expect(source.models().every((model: any) => !model.label.startsWith("Claude Code"))).toBe(true);
		expect(source.unavailable()).toBeUndefined();
	});

	it("searches every query in one run and stops claude before it writes an answer", async () => {
		const started = Date.now();
		const answers = await search({ queries: ["tokio vs async-std", "吉隆坡  今天\n天气"], timeoutMs: 10_000 });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(answers).toEqual([
			{
				query: "tokio vs async-std",
				results: [
					{ title: "First of tokio vs async-std", url: "https://one.example/0" },
					{ title: "Second of tokio vs async-std", url: "https://two.example/0" },
				],
			},
			{
				// Asked as one line; answered under the query exactly as it was given.
				query: "吉隆坡  今天\n天气",
				results: [
					{ title: "First of 吉隆坡 今天 天气", url: "https://one.example/1" },
					{ title: "Second of 吉隆坡 今天 天气", url: "https://two.example/1" },
				],
			},
		]);
		await settle(700);
		const entries = logged();
		expect(entries).toHaveLength(1);
		expect(entries.some((entry) => entry.answered)).toBe(false);
		const [{ start, cwd, env }] = entries;
		expect(start.slice(start.indexOf("--model"), start.indexOf("--model") + 2)).toEqual([
			"--model",
			SEARCH_DEFAULT_MODEL,
		]);
		expect(start.slice(start.indexOf("--tools"), start.indexOf("--tools") + 2)).toEqual(["--tools", "WebSearch"]);
		expect(start).toContain("--no-session-persistence");
		expect(readFileSync(start[start.indexOf("--append-system-prompt-file") + 1], "utf8")).toBe(SEARCH_RELAY_PROMPT);
		expect(cwd.replace(/\\/g, "/")).toBe(join(dir, "agent", "claude-code-shell", "search").replace(/\\/g, "/"));
		expect(env).toEqual({
			CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT,
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
			ANTHROPIC_API_KEY: null,
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
		});
	});

	it("searches with the model and the reasoning level chosen in Web Search settings", async () => {
		await search({ queries: ["q"], model: "claude-sonnet-5-5", timeoutMs: 10_000 });
		const { start } = logged()[0];
		expect(start[start.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
		expect(start[start.indexOf("--effort") + 1]).toBe("low");
		await search({ queries: ["q"], model: "claude-sonnet-5-5", effort: "high", timeoutMs: 10_000 });
		const again = logged().filter((entry) => entry.start)[1].start;
		expect(again[again.indexOf("--effort") + 1]).toBe("high");
	});

	it("answers under the queries as asked when claude reworded them", async () => {
		setEnv("MOCK_CLAUDE_MODE", "rewrite");
		const answers = await search({ queries: ["first", "second"], timeoutMs: 10_000 });
		// The run is only over at the turn's end here: no call could be matched by its text.
		expect(answers.map((answer) => [answer.query, answer.results[0]?.url, answer.error])).toEqual([
			["first", "https://one.example/0", undefined],
			["second", "https://one.example/1", undefined],
		]);
	});

	it("returns what was found when its time runs out, and says which query was not reached", async () => {
		setEnv("MOCK_CLAUDE_MODE", "partial");
		const started = Date.now();
		const answers = await search({ queries: ["first", "second"], timeoutMs: 1_500 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
		expect(answers[0]).toMatchObject({
			query: "first",
			results: [{ url: "https://one.example/0" }, { url: "https://two.example/0" }],
		});
		expect(answers[1]).toEqual({ query: "second", results: [], error: "2 秒内没有搜完这个问题。" });
	});

	it("fails as a whole, in claude's own words, when nothing could be searched", async () => {
		setEnv("MOCK_CLAUDE_MODE", "login");
		await expect(search({ queries: ["q"], timeoutMs: 10_000 })).rejects.toThrow("Not logged in · Please run /login");
		setEnv("MOCK_CLAUDE_MODE", "silent");
		await expect(search({ queries: ["q"], timeoutMs: 600 })).rejects.toThrow(
			"claude 在 1 秒内没有返回任何搜索结果。",
		);
	});

	it("reports a search claude's tool failed as that query's failure", async () => {
		setEnv("MOCK_CLAUDE_MODE", "error");
		expect(await search({ queries: ["q"], timeoutMs: 10_000 })).toEqual([
			{ query: "q", results: [], error: "Web search is unavailable." },
		]);
	});

	it("stops claude at once when the person stops the call", async () => {
		setEnv("MOCK_CLAUDE_MODE", "silent");
		const controller = new AbortController();
		const work = search({ queries: ["q"], timeoutMs: 10_000, signal: controller.signal });
		await settle(300);
		const started = Date.now();
		controller.abort();
		await expect(work).rejects.toThrow("已中断");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("lets more searches than may run at once wait their turn", async () => {
		const all = await Promise.all(
			Array.from({ length: 5 }, (_unused, index) => search({ queries: [`q${index}`], timeoutMs: 20_000 })),
		);
		expect(all.map((answers) => answers[0].results.length)).toEqual([2, 2, 2, 2, 2]);
		expect(logged().filter((entry) => entry.start)).toHaveLength(5);
	});
});
