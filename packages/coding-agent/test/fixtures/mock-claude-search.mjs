// A stand-in for `claude -p` in the tests of the Claude Code search source: it reads one user message whose lines are
// search queries and reports WebSearch calls the way the real program does (stream-json), with no model and no network.
//
// Environment:
//   MOCK_CLAUDE_MODE   "ok" (default): every query is searched; "partial": only the first is, then nothing more
//                      happens; "rewrite": the queries are searched in other words; "error": the search tool fails;
//                      "login": the turn ends in an error at once; "silent": nothing is ever written
//   MOCK_CLAUDE_LOG    file that gets one JSON line for the start (arguments, environment) and one when the answer
//                      after the searches is written (the request a client saves by stopping the program first)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const mode = env.MOCK_CLAUDE_MODE || "ok";
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => {
	if (env.MOCK_CLAUDE_LOG) appendFileSync(env.MOCK_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

log({
	start: process.argv.slice(2),
	cwd: process.cwd(),
	env: Object.fromEntries(
		["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_CLAUDE_MDS"].map(
			(name) => [name, env[name] ?? null],
		),
	),
});

const links = (query, index) => [
	{ title: `First of ${query}`, url: `https://one.example/${index}` },
	{ title: `Second of ${query}`, url: `https://two.example/${index}` },
	// The real tool repeats a page now and then.
	{ title: `First of ${query}`, url: `https://one.example/${index}` },
];

async function answer(text) {
	send({ type: "system", subtype: "init", tools: ["WebSearch"], model: "mock" });
	if (mode === "login") {
		send({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
		return;
	}
	const queries = text.split("\n").filter(Boolean);
	const calls = queries.map((query, index) => ({
		id: `toolu_${index}`,
		query: mode === "rewrite" ? `${query} (reworded)` : query,
	}));
	send({
		type: "assistant",
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "tool_use", id: call.id, name: "WebSearch", input: { query: call.query } })),
		},
	});
	send({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
	for (const [index, call] of calls.entries()) {
		await sleep(15);
		if (mode === "partial" && index > 0) return;
		const found = links(queries[index], index);
		const summary = `Web search results for query: "${call.query}"\n\nLinks: ${JSON.stringify(found)}\n\nA summary.`;
		send({
			type: "user",
			message: {
				role: "user",
				content: [
					mode === "error"
						? { type: "tool_result", tool_use_id: call.id, is_error: true, content: "Web search is unavailable." }
						: { type: "tool_result", tool_use_id: call.id, content: summary },
				],
			},
			// Every other result carries the structured copy; the rest only the text the model reads.
			...(mode !== "error" && index % 2 === 0
				? { tool_use_result: { query: call.query, results: [{ tool_use_id: `srv_${index}`, content: found }, "A summary."] } }
				: {}),
		});
	}
	// The model's own answer: a second request, which a client that only wants the results does not wait for.
	await sleep(400);
	log({ answered: true });
	send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
	send({ type: "result", subtype: "success", is_error: false, result: "DONE" });
}

if (mode !== "silent") {
	createInterface({ input: process.stdin }).on("line", (line) => {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type !== "user") return;
		void answer((event.message?.content ?? []).map((part) => part.text ?? "").join("\n"));
	});
} else {
	// A program that hangs: it stays until it is killed and never says a word.
	process.stdin.resume();
	setInterval(() => {}, 1000);
}
process.stdin.on("end", () => process.exit(0));
