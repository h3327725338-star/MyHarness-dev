// A stand-in for `agy acp` in tests: an Agent Client Protocol agent over stdin/stdout with no model behind it. What it
// does in a turn is written in the prompt itself, as steps separated by " ;; " (see runStep). It calls no network
// service except the MCP endpoint its client names.
//
// Environment:
//   MOCK_ACP_CAPS         JSON merged over the default agentCapabilities (each key as a whole: `"_meta": {}` is an
//                         agent that takes no system prompt from its client)
//   MOCK_ACP_NEEDS_AUTH   "1": sessions need `authenticate` first
//   MOCK_ACP_STATE        file that remembers session ids across starts (for session/resume)
//   MOCK_ACP_LOG          file that gets one JSON line per request received
//   MOCK_ACP_HANG         a method this agent never answers (an agent that hangs there)
//   MOCK_ACP_SEARCH       how a search relay prompt (the web search source) is answered: "saved" (search_web per
//                         numbered line, each result saved where agy saves it), "listing" (no saved results, the reply
//                         lists the sources), "fail" (every search_web fails), "other" (another tool first),
//                         "never" (the first search_web never ends)
//   MOCK_ACP_MODELS       JSON: the models a conversation offers ([{"value": "id", "name": "Name"}]) instead of the
//                         two built in
//   MOCK_ACP_LEVELS       JSON: the thinking levels of single models by id ({"model": ["Low", "High"]}); a model with
//                         an empty list has no thinking level option at all. Any other model has all five.
//   MOCK_ACP_COMMANDS     the slash commands a conversation offers, comma-separated (e.g. "compact")
//   MOCK_ACP_COMPACT_TO   what "/compact" leaves in the context, in tokens (reported as a usage update)
//   MOCK_ACP_STRICT_TOOLS how a call of the client's MCP tool is checked first, the way agy does it: its own
//                         `toolSummary` argument is required and the arguments, that one included, must fit the
//                         schema the tool was offered with. "1": the argument is taken out before the tool is
//                         called; "keep": it is passed on to the tool
//   MOCK_AGY_MODELS       what `agy models` prints
//   MOCK_AGY_USAGE        what `agy -p /usage` prints
//   MOCK_AGY_HELP         what `agy --help` prints (on stderr, like the real program); `agy update` is logged with
//                         the value of AGY_CLI_DISABLE_AUTO_UPDATE it was started with
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const env = process.env;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const log = (entry) => {
	if (env.MOCK_ACP_LOG) appendFileSync(env.MOCK_ACP_LOG, `${JSON.stringify(entry)}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaults = {
	loadSession: false,
	promptCapabilities: { image: true, audio: false, embeddedContext: true },
	mcpCapabilities: { http: true, sse: false },
	sessionCapabilities: { resume: {}, close: {} },
	// The real program's own addition to ACP: a prompt its client gives is added to the end of its system prompt.
	_meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
};
/** The addition to the system prompt that a request to open a conversation carries, as the real program reads it. */
const appended = (params) => {
	const append = params?._meta?.antigravity?.systemPrompt?.append;
	return typeof append === "string" ? append : undefined;
};
const capabilities = { ...defaults, ...(env.MOCK_ACP_CAPS ? JSON.parse(env.MOCK_ACP_CAPS) : {}) };
const MODELS = env.MOCK_ACP_MODELS
	? JSON.parse(env.MOCK_ACP_MODELS)
	: [
			{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			{ value: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
		];
const levelOptions = (names) => names.map((name) => ({ value: name === "Extra" ? "xhigh" : name.toLowerCase(), name }));
const LEVELS = ["Low", "Medium", "High", "Extra", "Max"].map((name) => ({ value: name.toLowerCase(), name }));
const OWN_LEVELS = env.MOCK_ACP_LEVELS ? JSON.parse(env.MOCK_ACP_LEVELS) : {};
/** Where agy keeps its record of a conversation, one JSON line per step. */
const recordOf = (id) => join(homedir(), ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs");

// The answers of the real program that need no conversation: `agy models` and `agy -p /usage`.
const argv = process.argv.slice(2);
// Its help and its own update command.
if (argv[0] === "--help" || argv[0] === "update") {
	log({ start: argv, noAutoUpdate: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null });
	const [stream, text] =
		argv[0] === "--help"
			? [process.stderr, env.MOCK_AGY_HELP ?? ""]
			: [process.stdout, "You are already on the latest version.\n"];
	stream.write(text, () => process.exit(0));
	await new Promise(() => {});
}
if (argv[0] === "models" || argv.includes("-p")) {
	const printed = argv[argv.indexOf("-p") + 1];
	log({ start: argv });
	const text = argv[0] === "models" ? env.MOCK_AGY_MODELS : printed === "/usage" ? env.MOCK_AGY_USAGE : "";
	process.stdout.write(text ?? "", () => process.exit(0));
	// Nothing below may start reading stdin for this run.
	await new Promise(() => {});
}

const known = () => (env.MOCK_ACP_STATE && existsSync(env.MOCK_ACP_STATE) ? JSON.parse(readFileSync(env.MOCK_ACP_STATE, "utf8")) : []);
const remember = (id) => {
	if (env.MOCK_ACP_STATE) writeFileSync(env.MOCK_ACP_STATE, JSON.stringify([...new Set([...known(), id])]));
};

let authenticated = false;
let nextRequest = 1;
const waiting = new Map();
const sessions = new Map();

/** A request to the client; resolves with its result. */
const ask = (method, params) =>
	new Promise((resolve, reject) => {
		const id = `agent-${nextRequest++}`;
		waiting.set(id, { resolve, reject });
		send({ id, method, params });
	});

const configOptions = (session) => {
	const own = OWN_LEVELS[session.model];
	const levels = own ? levelOptions(own) : LEVELS;
	return [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS },
		...(levels.length
			? [
					{
						id: "thinking",
						name: "Thinking level",
						category: "thought_level",
						type: "select",
						currentValue: levels.some((level) => level.value === session.level) ? session.level : levels[0].value,
						options: levels,
					},
				]
			: []),
	];
};

function openSession(id, params) {
	const session = {
		id,
		cwd: params.cwd,
		mcp: (params.mcpServers ?? [])[0],
		// Not kept with the conversation: one that is resumed without it has none, like the real program's.
		systemPrompt: appended(params) ?? "",
		model: MODELS[0].value,
		level: "medium",
		cancelled: false,
		calls: 0,
		steps: 0,
	};
	sessions.set(id, session);
	remember(id);
	return session;
}

async function mcp(session, method, params) {
	if (!session.mcp) throw new Error("no MCP server was given");
	const headers = { "content-type": "application/json" };
	for (const header of session.mcp.headers ?? []) headers[header.name] = header.value;
	const response = await fetch(session.mcp.url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const answer = await response.json();
	if (answer.error) throw new Error(answer.error.message);
	return answer.result;
}

const update = (session, body) => send({ method: "session/update", params: { sessionId: session.id, update: body } });
const say = (session, text) => update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const PERMISSION_OPTIONS = [
	{ optionId: "yes", name: "Allow", kind: "allow_once" },
	{ optionId: "always", name: "Always allow", kind: "allow_always" },
	{ optionId: "no", name: "Deny", kind: "reject_once" },
];

/** Asks the client before a tool acts. True when it allowed. */
async function permitted(session, toolCallId, title, kind) {
	const answer = await ask("session/request_permission", {
		sessionId: session.id,
		toolCall: { toolCallId, title, kind },
		options: PERMISSION_OPTIONS,
	});
	return answer?.outcome?.outcome === "selected" && answer.outcome.optionId !== "no";
}

/** One own tool: reported, permitted (unless `free`), run, and reported as ended. */
async function ownTool(session, { title, kind, rawInput, free }, run) {
	const toolCallId = `call-${session.id}-${++session.calls}`;
	update(session, { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput });
	if (!free && !(await permitted(session, toolCallId, title, kind))) {
		update(session, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "Permission denied." } }],
		});
		return false;
	}
	update(session, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
	const result = await run();
	update(session, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", ...result });
	return true;
}

async function runStep(session, step, promptText) {
	const [verb, ...rest] = step.trim().split(" ");
	const argument = rest.join(" ");
	const file = (name) => (isAbsolute(name) ? name : join(session.cwd, name));
	if (verb === "say") say(session, argument);
	else if (verb === "think") update(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: argument } });
	else if (verb === "echo") say(session, `PROMPT:${promptText}`);
	else if (verb === "system") say(session, `SYSTEM:${session.systemPrompt}`);
	else if (verb === "env") say(session, `KEY:${env.GEMINI_API_KEY ? "yes" : "no"} AUTH:${authenticated ? "yes" : "no"}`);
	else if (verb === "model") say(session, `MODEL:${session.model} LEVEL:${session.level}`);
	else if (verb === "usage") {
		const [used, size] = rest.map(Number);
		session.size = size;
		update(session, { sessionUpdate: "usage_update", used, size });
	} else if (verb === "tokens" || verb === "latetokens") {
		// One model request in agy's own record of the conversation: what it read in full, read from the cache and wrote.
		// `latetokens` writes it a moment later, after the turn's words are out.
		const [input, cacheRead, output] = rest.map(Number);
		const record = () => {
			mkdirSync(recordOf(session.id), { recursive: true });
			const step = { step_index: ++session.steps, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE" };
			appendFileSync(
				join(recordOf(session.id), "transcript.jsonl"),
				`${JSON.stringify({ ...step, input_tokens: input, cache_read_tokens: cacheRead, output_tokens: output })}\n`,
			);
		};
		if (verb === "tokens") record();
		else setTimeout(record, 250);
	} else if (verb === "note") {
		// A step of the record that is no model request (a tool's result).
		mkdirSync(recordOf(session.id), { recursive: true });
		appendFileSync(
			join(recordOf(session.id), "transcript.jsonl"),
			`${JSON.stringify({ step_index: ++session.steps, source: "MODEL", type: "GENERIC", status: "DONE", content: argument })}\n`,
		);
	} else if (verb === "cut") {
		// agy passed on only the beginning of the message: its record ends the message with a mark and a note to the model.
		mkdirSync(recordOf(session.id), { recursive: true });
		const note = "NOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range.";
		const content = `<USER_REQUEST>\n${promptText.slice(0, 200)}\n<truncated ${argument} bytes>\n\n${note}`;
		appendFileSync(
			join(recordOf(session.id), "transcript.jsonl"),
			`${JSON.stringify({ step_index: ++session.steps, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content })}\n`,
		);
	} else if (verb === "sleep") await sleep(Number(argument));
	else if (verb === "wait") {
		while (!session.cancelled) await sleep(20);
	} else if (verb === "write") {
		const [name, ...words] = rest;
		const text = words.join(" ");
		const ok = await ownTool(session, { title: `Write ${name}`, kind: "edit", rawInput: { path: name, content: text } }, async () => {
			const before = existsSync(file(name)) ? readFileSync(file(name), "utf8") : null;
			writeFileSync(file(name), `${text}\n`);
			return { content: [{ type: "diff", path: file(name), oldText: before, newText: `${text}\n` }] };
		});
		say(session, ok ? `wrote ${name}. ` : `could not write ${name}. `);
	} else if (verb === "read") {
		await ownTool(session, { title: `Read ${argument}`, kind: "read", rawInput: { path: argument }, free: true }, async () => ({
			content: [{ type: "content", content: { type: "text", text: readFileSync(file(argument), "utf8") } }],
		}));
	} else if (verb === "run" || verb === "other") {
		const kind = verb === "run" ? "execute" : "other";
		const ok = await ownTool(session, { title: `${verb === "run" ? "Run" : "Do"} ${argument}`, kind, rawInput: { command: argument } }, async () => {
			await sleep(30);
			return { rawOutput: `ran ${argument}` };
		});
		say(session, ok ? `ran ${argument}. ` : `refused ${argument}. `);
	} else if (verb === "leave") {
		// A tool the agent starts and never reports the end of (a process it leaves running).
		const toolCallId = `call-${session.id}-${++session.calls}`;
		const call = { toolCallId, title: `Run ${argument}`, kind: "execute", rawInput: { command: argument } };
		update(session, { sessionUpdate: "tool_call", ...call, status: "pending" });
		update(session, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
	} else if (verb === "tools") {
		const listed = await mcp(session, "tools/list", {});
		say(session, `TOOLS:${listed.tools.map((tool) => tool.name).join(",")}`);
	} else if (verb === "app" || verb === "appquiet") {
		// A tool of the client's MCP server. `appquiet` reports it under a title that does not name the tool.
		const [tool, ...json] = rest;
		const args = json.length ? JSON.parse(json.join(" ")) : {};
		const title = verb === "app" ? `${tool} (${session.mcp?.name} MCP Server)` : "Calling a tool";
		// agy checks a call before it runs it, and never reports one it refused: the model is told, and nobody else.
		const invalid = env.MOCK_ACP_STRICT_TOOLS ? await invalidCall(session, tool, args) : undefined;
		if (invalid) {
			say(session, `INVALID:${invalid}`);
			return;
		}
		const sent = { ...args };
		if (env.MOCK_ACP_STRICT_TOOLS === "1") delete sent.toolSummary;
		let text = "";
		const ok = await ownTool(session, { title, kind: "other", rawInput: args, free: verb === "appquiet" }, async () => {
			const result = await mcp(session, "tools/call", { name: tool, arguments: sent });
			text = (result.content ?? []).map((part) => part.text ?? "").join("");
			return { content: [{ type: "content", content: { type: "text", text } }] };
		});
		say(session, ok ? `RESULT:${text}` : `refused ${tool}. `);
	}
}

/**
 * agy's own check of a call of an MCP tool, as its errors show it: `toolSummary` must be there, and the arguments,
 * that one included, must fit the schema the tool was offered with. Returns what agy tells the model, if it refuses.
 */
async function invalidCall(session, tool, args) {
	const { Compile } = await import("typebox/compile");
	const offered = (await mcp(session, "tools/list", {})).tools.find((entry) => entry.name === tool);
	if (!offered) return `unknown tool ${tool}`;
	if (!("toolSummary" in args)) return "invalid tool call: invalid arguments: missing property 'toolSummary'";
	return Compile(offered.inputSchema).Check(args)
		? undefined
		: "invalid tool call: invalid arguments: additional properties 'toolSummary' not allowed";
}

/** The turn of a search relay prompt: one search_web per numbered line, then a reply that lists the sources. */
async function searchRelay(session, promptText) {
	const mode = env.MOCK_ACP_SEARCH;
	const queries = [...promptText.matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]);
	session.cancelled = false;
	if (mode === "other") {
		await ownTool(session, { title: "Run whoami", kind: "execute", rawInput: { command: "whoami" } }, async () => ({
			rawOutput: "ran whoami",
		}));
	}
	const listing = [];
	for (const [index, query] of queries.entries()) {
		if (session.cancelled) break;
		const call = {
			toolCallId: `search-${session.id}-${index}`,
			name: "search_web",
			kind: "search",
			title: `"${query}" on Web`,
			rawInput: { query },
		};
		update(session, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
		await sleep(20);
		while (mode === "never" && !session.cancelled) await sleep(20);
		const redirect = (name) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/q${index}${name}`;
		const sources = [`[1] [a.example](${redirect("a")})`, `[2] [b.example](${redirect("b")})`, `[3] [a.example](${redirect("a")})`];
		if (mode === "saved") {
			const step = join(homedir(), ".gemini", "antigravity-cli", "brain", session.id, ".system_generated", "steps", String(index + 2));
			mkdirSync(step, { recursive: true });
			writeFileSync(
				join(step, "output.txt"),
				[
					"Created At: 2026-11-14T06:30:56+08:00",
					"Completed At: 2026-11-14T06:31:02+08:00",
					`The search for "${query}" returned the following summary:`,
					`About ${query}: version 6.0 is out[1]. Nothing else is known.[2] A third point[1][2].`,
					"",
					"Sources:",
					...sources,
					"",
					"Note: Source URLs are HTTP redirects; check where they resolve if you need the direct link.",
				].join("\n"),
			);
		}
		update(session, { sessionUpdate: "tool_call_update", ...call, status: mode === "fail" ? "failed" : "completed" });
		listing.push(`## ${index + 1}`, ...sources);
	}
	// The reply is a second model request, which a client that reads the saved results does not wait for.
	for (let waited = 0; waited < 300 && !session.cancelled; waited += 20) await sleep(20);
	if (session.cancelled) return { stopReason: "cancelled" };
	log({ replied: true });
	say(session, `Here are the sources.\n${listing.join("\n")}`);
	return { stopReason: "end_turn" };
}

const VERBS = new Set(
	"say think echo system env model usage tokens latetokens note cut sleep wait write read run other leave tools app appquiet stop".split(
		" ",
	),
);

async function prompt(session, params) {
	const promptText = (params.prompt ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
	if (env.MOCK_ACP_SEARCH && promptText.includes("search relay")) return searchRelay(session, promptText);
	// agy's own command: the conversation is summarized inside agy, which then says how full the context is.
	if (promptText.trim() === "/compact" && env.MOCK_ACP_COMPACT_TO) {
		log({ compact: session.id });
		update(session, { sessionUpdate: "usage_update", used: Number(env.MOCK_ACP_COMPACT_TO), size: session.size ?? 1_000_000 });
		return { stopReason: "end_turn" };
	}
	// The steps are the last line that starts with one of the verbs, so whatever a client puts around it (instructions
	// in front, a reminder after) changes nothing.
	const lines = promptText.trim().split("\n");
	const script = lines.reverse().find((line) => VERBS.has(line.trim().split(" ")[0])) ?? "";
	session.cancelled = false;
	let stopReason = "end_turn";
	for (const step of script.split(" ;; ")) {
		if (session.cancelled) break;
		if (step.startsWith("stop ")) stopReason = step.slice(5).trim();
		else await runStep(session, step, promptText);
	}
	return { stopReason: session.cancelled ? "cancelled" : stopReason };
}

async function handle(method, params) {
	if (method === "initialize") {
		return {
			protocolVersion: 1,
			agentCapabilities: capabilities,
			agentInfo: { name: "mock-agy", version: "9.9.9" },
			authMethods: [
				{ id: "oauth-personal", name: "Log in with Google" },
				{ id: "gemini-api-key", name: "Gemini API key" },
				{ id: "terminal-login", name: "Log in from the terminal", type: "terminal" },
			],
		};
	}
	if (method === "authenticate") {
		authenticated = true;
		return {};
	}
	if (method === "session/new" || method === "session/resume" || method === "session/load") {
		if (env.MOCK_ACP_NEEDS_AUTH === "1" && !authenticated) throw Object.assign(new Error("Authentication required"), { code: -32000 });
		if (method !== "session/new" && !known().includes(params.sessionId)) {
			throw Object.assign(new Error("Session not found"), { code: -32002 });
		}
		const id = method === "session/new" ? `mock-${process.pid}-${sessions.size + 1}` : params.sessionId;
		const session = openSession(id, params);
		if (env.MOCK_ACP_COMMANDS) {
			const availableCommands = env.MOCK_ACP_COMMANDS.split(",").map((name) => ({ name, description: name }));
			setTimeout(() => update(session, { sessionUpdate: "available_commands_update", availableCommands }), 5);
		}
		return { ...(method === "session/new" ? { sessionId: id } : {}), configOptions: configOptions(session) };
	}
	const session = sessions.get(params?.sessionId);
	if (!session) throw Object.assign(new Error("Session not found"), { code: -32002 });
	if (method === "session/set_config_option") {
		if (params.configId === "model") session.model = params.value;
		if (params.configId === "thinking") session.level = params.value;
		return { configOptions: configOptions(session) };
	}
	if (method === "session/prompt") return prompt(session, params);
	if (method === "session/close" || method === "session/delete") {
		sessions.delete(session.id);
		return {};
	}
	throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

log({ start: process.argv.slice(2) });
createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === undefined) {
		const pending = waiting.get(message.id);
		waiting.delete(message.id);
		if (message.error) pending?.reject(new Error(message.error.message));
		else pending?.resolve(message.result);
		return;
	}
	log({
		method: message.method,
		mcp: message.params?.mcpServers?.map((server) => server.name),
		systemPrompt: appended(message.params) === undefined ? undefined : "append",
		sessionId: message.params?.sessionId,
		value: message.params?.value,
	});
	if (message.method === env.MOCK_ACP_HANG) return;
	if (message.id === undefined) {
		if (message.method === "session/cancel") {
			const session = sessions.get(message.params?.sessionId);
			if (session) session.cancelled = true;
			// Whatever waited for the client is abandoned.
			for (const pending of waiting.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
			waiting.clear();
		}
		return;
	}
	handle(message.method, message.params ?? {}).then(
		(result) => send({ id: message.id, result }),
		(error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
	);
});
process.stdin.on("end", () => process.exit(0));
