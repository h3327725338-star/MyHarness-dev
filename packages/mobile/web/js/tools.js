// The tools of the phone's own agent: searching the web, reading a page, and driving the app's built-in browser.
// Results use the shapes of the desktop tools of the same name (details.results / details.pages), so the shared
// transcript code (turns.js) counts and words them the same way.
import { Type } from "./core.bundle.js";
import { activateTab, activeTab, closeTab, navigate, openTab, readPage, screenshotPage, waitForLoad } from "./browser-model.js";
import { httpFetch, secretGet } from "./native.js";
import { searchMemories } from "./account-view.js";
import { prefs } from "./prefs.js";
import { state } from "./store.js";

const text = (value) => ({ type: "text", text: String(value) });
const UA = navigator.userAgent;
const HTML_HEADERS = { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": `${navigator.language || "en"},en;q=0.8` };

async function fetchText(url, { headers, signal, timeoutMs = 20000, method = "GET", body } = {}) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	signal?.addEventListener("abort", stop);
	const timer = setTimeout(stop, timeoutMs);
	try {
		const response = await httpFetch(url, { method, headers, body, signal: controller.signal });
		return { status: response.status, url: response.url || url, type: response.headers.get("content-type") || "", text: await response.text() };
	} catch (error) {
		if (signal?.aborted) throw error;
		if (controller.signal.aborted) throw new Error("timed out");
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}

const squash = (value) => String(value || "").replace(/\s+/g, " ").trim();

// ---- Search engines ----------------------------------------------------------------------------
const RECENCY = { day: "day", week: "week", month: "month", year: "year" };

async function searchTavily(query, { signal, recency }) {
	const key = secretGet("search.tavily");
	const body = { query, search_depth: "basic", max_results: 10, include_published_date: true };
	if (recency) body.time_range = recency;
	const page = await fetchText("https://api.tavily.com/search", {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : { "x-tavily-access-mode": "keyless" }) },
		body: JSON.stringify(body),
		signal,
	});
	if (page.status !== 200) throw new Error(key ? `HTTP ${page.status}` : `HTTP ${page.status} (free access; a free Tavily key in Settings lifts the limit)`);
	const data = JSON.parse(page.text);
	return (data.results || []).map((row) => ({ title: squash(row.title), url: row.url, snippet: squash(row.content).slice(0, 500), date: row.published_date || undefined }));
}

function decodeBingLink(href) {
	try {
		const url = new URL(href, "https://www.bing.com");
		if (!/(^|\.)bing\.com$/.test(url.hostname) || !url.pathname.startsWith("/ck/a")) return url.href;
		const packed = url.searchParams.get("u") || "";
		if (!packed.startsWith("a1")) return url.href;
		const base64 = packed.slice(2).replace(/-/g, "+").replace(/_/g, "/");
		return decodeURIComponent(escape(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))));
	} catch {
		return href;
	}
}

async function searchBing(query, { signal, recency }) {
	const filters = { day: 'ex1:"ez1"', week: 'ex1:"ez2"', month: 'ex1:"ez3"' };
	const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}${filters[recency] ? `&filters=${encodeURIComponent(filters[recency])}` : ""}`;
	const page = await fetchText(url, { headers: HTML_HEADERS, signal });
	if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
	const doc = new DOMParser().parseFromString(page.text, "text/html");
	const rows = [];
	for (const item of doc.querySelectorAll("#b_results li.b_algo")) {
		const link = item.querySelector("h2 a");
		if (!link) continue;
		const href = decodeBingLink(link.getAttribute("href") || "");
		if (!/^https?:/i.test(href)) continue;
		const snippet = item.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p");
		rows.push({ title: squash(link.textContent), url: href, snippet: squash(snippet?.textContent).slice(0, 500) });
	}
	if (!rows.length && /captcha|verify you are human|unusual traffic/i.test(page.text)) throw new Error("the engine asked for a human check");
	return rows;
}

async function searchDuckDuckGo(query, { signal, recency }) {
	const df = { day: "d", week: "w", month: "m", year: "y" }[recency];
	const page = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}${df ? `&df=${df}` : ""}`, { headers: HTML_HEADERS, signal });
	if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
	const doc = new DOMParser().parseFromString(page.text, "text/html");
	const rows = [];
	const snippets = [...doc.querySelectorAll("td.result-snippet")];
	[...doc.querySelectorAll("a.result-link")].forEach((link, index) => {
		let href = link.getAttribute("href") || "";
		try {
			const url = new URL(href, "https://duckduckgo.com");
			href = url.searchParams.get("uddg") || url.href;
		} catch {
			return;
		}
		if (!/^https?:/i.test(href)) return;
		rows.push({ title: squash(link.textContent), url: href, snippet: squash(snippets[index]?.textContent).slice(0, 500) });
	});
	if (!rows.length && /anomaly|bots use DuckDuckGo/i.test(page.text)) throw new Error("the engine asked for a human check");
	return rows;
}

const ENGINES = { tavily: ["Tavily", searchTavily], bing: ["Bing", searchBing], duckduckgo: ["DuckDuckGo", searchDuckDuckGo] };

function engineOrder() {
	const chosen = prefs.searchEngine;
	const all = ["tavily", "bing", "duckduckgo"];
	return ENGINES[chosen] ? [chosen, ...all.filter((id) => id !== chosen)] : all;
}

/** One query through the engines in order: the first that returns results answers; failures are kept for the report. */
async function searchOnce(query, options) {
	const failures = [];
	for (const id of engineOrder()) {
		const [label, run] = ENGINES[id];
		try {
			const rows = await run(query, options);
			if (rows.length) return { engine: label, rows, failures };
			failures.push(`${label}: no results`);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			failures.push(`${label}: ${error?.message || error}`);
		}
	}
	return { engine: "", rows: [], failures };
}

const webSearch = {
	name: "web_search",
	label: "Web search",
	description:
		"Search the public web. Send 1 to 4 focused queries in one call; they run together. Returns for each query a numbered list of results (title, URL, snippet). Use web_fetch to read a result's full page.",
	parameters: Type.Object({
		queries: Type.Array(Type.String({ description: "A search query, written the way a person would type it into a search engine." }), { minItems: 1, maxItems: 4 }),
		recency: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], { description: "Only results from the last day, week, month or year." })),
	}),
	prepareArguments(args) {
		// Models sometimes send one `query` string instead of the `queries` list.
		if (args && typeof args === "object" && !Array.isArray(args.queries)) {
			const single = typeof args.query === "string" ? args.query : typeof args.queries === "string" ? args.queries : typeof args.q === "string" ? args.q : "";
			if (single) return { ...args, queries: [single] };
		}
		return args;
	},
	async execute(_id, params, signal) {
		const queries = [...new Set((params.queries || []).map((query) => squash(query)).filter(Boolean))].slice(0, 4);
		if (!queries.length) throw new Error("No query was given.");
		const recency = RECENCY[params.recency];
		const answers = await Promise.all(queries.map((query) => searchOnce(query, { signal, recency })));
		const results = [];
		const seen = new Set();
		const parts = [];
		const failed = [];
		answers.forEach((answer, index) => {
			const lines = [];
			for (const row of answer.rows.slice(0, 8)) {
				if (seen.has(row.url)) continue;
				seen.add(row.url);
				results.push({ ...row, query: queries[index], engine: answer.engine });
				lines.push(`[${results.length}] ${row.title}\n${row.url}${row.date ? `\n(${row.date})` : ""}${row.snippet ? `\n${row.snippet}` : ""}`);
			}
			if (lines.length) parts.push(`## ${queries[index]}\n\n${lines.join("\n\n")}`);
			else {
				failed.push(queries[index]);
				parts.push(`## ${queries[index]}\n\nNo results. ${answer.failures.join("; ")}`);
			}
		});
		if (!results.length) throw new Error(`The search returned nothing.\n${answers.map((answer, index) => `${queries[index]} — ${answer.failures.join("; ")}`).join("\n")}`);
		return { content: [text(parts.join("\n\n"))], details: { queries, results, pages: [], failed } };
	},
};

// ---- Reading a page ----------------------------------------------------------------------------
/** Addresses on the phone itself or its local network: a page read by the model must not reach devices at home. */
function privateHost(host) {
	const name = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) return true;
	if (name === "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")) return name.includes(":");
	const parts = name.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const DROP = "script,style,noscript,template,svg,canvas,iframe,form,nav,footer,header,aside,button,select,input,textarea,[hidden],[aria-hidden='true'],.advertisement,.ads,.ad,.cookie,.sidebar,.comments";
const BLOCKS = new Set(["P", "DIV", "SECTION", "ARTICLE", "LI", "UL", "OL", "TR", "TABLE", "BLOCKQUOTE", "PRE", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "DT", "DD", "FIGCAPTION"]);

/** Readable text of an HTML document: the main content when the page marks one, headings and list items kept as Markdown. */
export function htmlToText(html, baseUrl) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const title = squash(doc.querySelector("title")?.textContent);
	doc.querySelectorAll(DROP).forEach((node) => node.remove());
	const root = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector("[role='main']") || doc.body || doc.documentElement;
	const out = [];
	const walk = (node) => {
		if (node.nodeType === 3) {
			out.push(node.nodeValue.replace(/\s+/g, " "));
			return;
		}
		if (node.nodeType !== 1) return;
		const tag = node.tagName;
		if (tag === "PRE") {
			out.push(`\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n`);
			return;
		}
		const heading = /^H([1-6])$/.exec(tag);
		if (heading) out.push(`\n\n${"#".repeat(Number(heading[1]))} `);
		else if (tag === "LI") out.push("\n- ");
		else if (tag === "TD" || tag === "TH") out.push(" | ");
		else if (BLOCKS.has(tag)) out.push("\n");
		for (const child of node.childNodes) walk(child);
		if (tag === "A") {
			const href = node.getAttribute("href");
			if (href && !href.startsWith("#") && !/^javascript:/i.test(href) && squash(node.textContent)) {
				try {
					out.push(` (${new URL(href, baseUrl).href})`);
				} catch {
					// Not an address: the link text stands alone.
				}
			}
		}
		if (heading || BLOCKS.has(tag)) out.push("\n");
	};
	walk(root);
	const body = out
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text: body };
}

const webFetch = {
	name: "web_fetch",
	label: "Read page",
	description: "Read one public web page (http or https) and return its text. Use it for a URL the user gave or a search result worth reading in full.",
	parameters: Type.Object({
		url: Type.String({ description: "The full address of the page, starting with http:// or https://." }),
		maxChars: Type.Optional(Type.Number({ description: "How much text to return at most (default 12000, up to 40000)." })),
	}),
	async execute(_id, params, signal) {
		let url;
		try {
			url = new URL(String(params.url || "").trim());
		} catch {
			throw new Error("That is not a valid address.");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https pages can be read.");
		if (privateHost(url.hostname)) throw new Error("Addresses on the phone or the local network are not read by this tool.");
		const limit = Math.max(1000, Math.min(40000, Number(params.maxChars) || 12000));
		const page = await fetchText(url.href, { headers: HTML_HEADERS, signal, timeoutMs: 25000 });
		if (page.status >= 400) throw new Error(`The page answered HTTP ${page.status}.`);
		let title = "";
		let body = page.text;
		if (/pdf|octet-stream|image\/|audio\/|video\/|zip/i.test(page.type)) throw new Error(`This address is a file (${page.type.split(";")[0]}), not a page that can be read as text.`);
		if (/html|xml/i.test(page.type) || /^\s*<(!doctype|html)/i.test(body)) ({ title, text: body } = htmlToText(body, page.url));
		if (!body.trim()) throw new Error("The page has no readable text (it may need a real browser; the browser tool can open it).");
		const cut = body.length > limit;
		const shown = cut ? body.slice(0, limit) : body;
		return {
			content: [text(`${title ? `# ${title}\n` : ""}${page.url}\n\n${shown}${cut ? `\n\n[Cut: ${body.length - limit} more characters. Ask for a larger maxChars to read on.]` : ""}`)],
			details: { pages: [{ url: page.url, title, chars: shown.length, truncated: cut }] },
		};
	},
};

// ---- The built-in browser ----------------------------------------------------------------------
const browserTool = {
	name: "browser",
	label: "Browser",
	description:
		"Use the app's built-in browser, which the user can see in the right-hand pane. Actions: open (load a URL in a tab), read (the visible text and links of the current tab), screenshot (a picture of the current tab), tabs (list open tabs), close (close a tab). Pages may hold the user's sign-ins: only look, never submit forms or change anything unless the user asked for exactly that.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("open"), Type.Literal("read"), Type.Literal("screenshot"), Type.Literal("tabs"), Type.Literal("close")]),
		url: Type.Optional(Type.String({ description: "For open: the address to load." })),
		newTab: Type.Optional(Type.Boolean({ description: "For open: load in a new tab instead of the current one." })),
		tab: Type.Optional(Type.String({ description: "For read, screenshot, close: a tab id from the tabs action. Defaults to the current tab." })),
		maxChars: Type.Optional(Type.Number({ description: "For read: how much text to return at most (default 12000)." })),
	}),
	executionMode: "sequential",
	async execute(_id, params) {
		const listTabs = () => state.browser.tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, current: tab.id === state.browser.active }));
		switch (params.action) {
			case "open": {
				const address = String(params.url || "").trim();
				if (!/^https?:\/\//i.test(address)) throw new Error("open needs a full http or https address.");
				const id = params.newTab || !activeTab() ? await openTab(address) : await navigate(address);
				const loaded = await waitForLoad(id, 20000);
				const tab = state.browser.tabs.find((entry) => entry.id === id);
				if (tab?.error) throw new Error(`The page did not load: ${tab.error.message}`);
				return { content: [text(`${loaded ? "Opened" : "Still loading"}: ${tab?.title || ""}\n${tab?.url || address}\nTab ${id}. Use the read action to get its text.`)], details: { pages: [{ url: tab?.url || address, title: tab?.title || "" }], tab: id } };
			}
			case "read": {
				const id = params.tab || state.browser.active;
				const page = await readPage(id, Math.max(1000, Math.min(40000, Number(params.maxChars) || 12000)));
				const links = (page.links || []).slice(0, 25).map(([label, href]) => `- ${label}: ${href}`).join("\n");
				const cut = page.length > page.text.length;
				return {
					content: [text(`# ${page.title || ""}\n${page.url}\n\n${page.text}${cut ? `\n\n[Cut: ${page.length - page.text.length} more characters.]` : ""}${links ? `\n\n## Links\n${links}` : ""}`)],
					details: { pages: [{ url: page.url, title: page.title, chars: page.text.length, truncated: cut }], tab: id },
				};
			}
			case "screenshot": {
				const id = params.tab || state.browser.active;
				if (id && id !== state.browser.active) await activateTab(id);
				const shot = await screenshotPage(id);
				const tab = state.browser.tabs.find((entry) => entry.id === id);
				return { content: [text(`Screenshot of ${tab?.url || "the current tab"}`), { type: "image", data: shot.data, mimeType: shot.mimeType }], details: { tab: id } };
			}
			case "tabs": {
				const tabs = listTabs();
				return { content: [text(tabs.length ? tabs.map((tab) => `${tab.current ? "* " : "  "}${tab.id}  ${tab.title || "(no title)"}  ${tab.url || "(empty)"}`).join("\n") : "No tabs are open.")], details: { tabs } };
			}
			case "close": {
				const id = params.tab || state.browser.active;
				if (!id) throw new Error("No tab to close.");
				await closeTab(id);
				return { content: [text(`Closed tab ${id}.`)], details: { tab: id } };
			}
			default:
				throw new Error(`Unknown action: ${params.action}`);
		}
	},
};

/** The tools a chat gets. `vision` false leaves the screenshot out of the browser tool's answer shape (the model cannot see it). */
export function buildTools() {
	return [webSearch, webFetch, browserTool];
}

// ---- Memories (the account's, read from its PCs; account.js) ---------------------------------------
/** memory_search and memory_get over the memories the PCs share with phones. */
export function memoryTools(getMemories) {
	const search = {
		name: "memory_search",
		label: "Search memories",
		description:
			"Search the user's MyHarness memories (kept on their PCs) for what this conversation needs: their preferences, facts about them, earlier decisions. Returns ids, names and short descriptions; read a memory in full with memory_get.",
		parameters: Type.Object({
			query: Type.String({ description: "Words to look for." }),
			limit: Type.Optional(Type.Number({ description: "At most this many results (default 8, up to 20)." })),
		}),
		async execute(_id, params) {
			const found = searchMemories(getMemories(), params.query, Math.max(1, Math.min(20, Number(params.limit) || 8)));
			if (!found.length) return { content: [text("No memory matches these words.")], details: {} };
			return { content: [text(found.map((memory) => `- ${memory.id}: ${memory.name}${memory.description ? ` — ${memory.description}` : ""}`).join("\n"))], details: {} };
		},
	};
	const get = {
		name: "memory_get",
		label: "Read memory",
		description: "Read one of the user's MyHarness memories in full, by the id memory_search gave.",
		parameters: Type.Object({ id: Type.String({ description: "The memory's id." }) }),
		async execute(_id, params) {
			const memory = getMemories().find((entry) => entry.id === String(params.id || "").trim());
			if (!memory) throw new Error("There is no memory with this id. Search first with memory_search.");
			return { content: [text(`# ${memory.name}\n${memory.description ? `${memory.description}\n\n` : ""}${memory.content || ""}`)], details: {} };
		},
	};
	return [search, get];
}
