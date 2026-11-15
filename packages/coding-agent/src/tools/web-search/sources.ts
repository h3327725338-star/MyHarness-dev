/**
 * Search sources that extensions provide: another program's own web search (the Claude Code and agy plugins), offered
 * in Web Search settings beside the built-in engines.
 *
 * A source only names pages: titles and URLs, with a snippet when the program gives one. Everything after that is the
 * service's, exactly as for a built-in engine: merging and ranking with the other sources, reading the real pages, the
 * browser fallback for a page that refuses a plain request, the session cache.
 *
 * One registry per process, like the programs themselves: every chat, every sub-agent and the settings page see the
 * same sources. This file is a leaf (type imports only) so the extension loader can register into it.
 */
import { WEB_SEARCH_ENGINE_IDS } from "../../config/settings/defaults.ts";
import type { SearchTimeRange } from "./engines/types.ts";

/** One page a source found. */
export interface WebSearchSourceResult {
	title: string;
	url: string;
	snippet?: string;
	publishedAt?: string;
}

/** How one query ended at a source: the pages it found, or why it has none. */
export interface WebSearchSourceAnswer {
	/** The query as it was asked, word for word. */
	query: string;
	results: WebSearchSourceResult[];
	/** Why this query has no results (the program failed it, or its time ran out before this query). */
	error?: string;
}

export interface WebSearchSourceRequest {
	/** The queries of one web_search call. Each is searched as written. */
	queries: string[];
	/** The model chosen for this source in Web Search settings; the source's own default when unset. */
	model?: string;
	/**
	 * The reasoning level the search runs on (MyHarness's names: low, medium, high, xhigh, max): the one chosen in Web
	 * Search settings, or the source's default. Unset for a model that has no levels to pick.
	 */
	effort?: string;
	/** The search answers within this time; a source returns what it has by then instead of failing as a whole. */
	timeoutMs: number;
	/** The person stopped the call. */
	signal?: AbortSignal;
}

export interface WebSearchSourceModel {
	id: string;
	label: string;
	/** The reasoning levels a search on this model can run on, lowest first; none when the model has no such choice. */
	efforts?: string[];
}

export interface WebSearchSource {
	/** What settings store: lowercase letters, digits and dashes, and not a built-in engine's id. */
	id: string;
	/** The name in Web Search settings and in a search's Engines line. */
	label: string;
	/** The models the user may pick for this source's searches. */
	models?(): WebSearchSourceModel[];
	/** The model searched with while the user has picked none. */
	defaultModel?: string;
	/** The reasoning level searched with while the user has picked none, or picked one the model has not got. */
	defaultEffort?: string;
	/**
	 * Why this computer cannot use the source right now (its program is not installed), or undefined when it can. A
	 * source that cannot be used is left out of a search without a word: the setting may have come from another computer.
	 */
	unavailable?(): string | undefined;
	/**
	 * Search every query and answer each one. A query that failed carries `error`; throwing means nothing could be
	 * searched at all (the program did not start, nobody is signed in).
	 */
	search(request: WebSearchSourceRequest): Promise<WebSearchSourceAnswer[]>;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const sources = new Map<string, WebSearchSource>();

/** Add a source, or replace the one of the same id (an extension is loaded again for every chat). */
export function registerWebSearchSource(source: WebSearchSource): void {
	if (!SOURCE_ID.test(source.id) || (WEB_SEARCH_ENGINE_IDS as readonly string[]).includes(source.id)) {
		throw new Error(`Invalid web search source id "${source.id}".`);
	}
	if (!source.label?.trim() || typeof source.search !== "function") {
		throw new Error(`Web search source "${source.id}" needs a label and a search function.`);
	}
	sources.set(source.id, source);
}

export function unregisterWebSearchSource(id: string): void {
	sources.delete(id);
}

/** Every registered source, in the order they were first registered. */
export function listWebSearchSources(): WebSearchSource[] {
	return [...sources.values()];
}

export function getWebSearchSource(id: string): WebSearchSource | undefined {
	return sources.get(id);
}

/** The model a source searches with: the user's choice while the source still offers it, else the source's default. */
export function webSearchSourceModel(source: WebSearchSource, chosen: string | undefined): string | undefined {
	const offered = source.models?.() ?? [];
	if (chosen && (offered.length === 0 || offered.some((model) => model.id === chosen))) return chosen;
	return source.defaultModel;
}

/** The reasoning levels the user may pick for a source's searches on `model`. */
export function webSearchSourceEfforts(source: WebSearchSource, model: string | undefined): string[] {
	return source.models?.().find((candidate) => candidate.id === model)?.efforts ?? [];
}

/**
 * The reasoning level a source searches with on `model`: the user's choice while that model has it, else the source's
 * default, else the model's lowest. Undefined for a model that has no levels to pick.
 */
export function webSearchSourceEffort(
	source: WebSearchSource,
	model: string | undefined,
	chosen: string | undefined,
): string | undefined {
	const offered = webSearchSourceEfforts(source, model);
	if (chosen && offered.includes(chosen)) return chosen;
	return source.defaultEffort && offered.includes(source.defaultEffort) ? source.defaultEffort : offered[0];
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/**
 * What stands for a time range at a source whose search has no date filter: the date, in the query's language, added
 * to the query the way a person would type it. A week is named by its month, the closest a few words can say.
 */
export function timeRangeWords(query: string, timeRange: SearchTimeRange, now: number): string {
	const date = new Date(now);
	const [year, month, day] = [date.getFullYear(), date.getMonth(), date.getDate()];
	const chinese = /[㐀-鿿]/u.test(query);
	if (timeRange === "year") return chinese ? `${year}年` : String(year);
	if (timeRange === "day") return chinese ? `${year}年${month + 1}月${day}日` : `${MONTHS[month]} ${day} ${year}`;
	return chinese ? `${year}年${month + 1}月` : `${MONTHS[month]} ${year}`;
}
