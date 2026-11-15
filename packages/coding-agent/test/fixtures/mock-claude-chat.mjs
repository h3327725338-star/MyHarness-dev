// A stand-in for `claude -p` in a chat of the Claude Code shell, for the sub-agent tests: it speaks stream-json on
// stdin/stdout and calls one MyHarness tool over the MCP endpoint it was given, the way the real program does, with no
// model and no network beyond that loopback endpoint.
//
// One turn: it lists the endpoint's tools, calls `read` on the file named in MOCK_CLAUDE_READ (default notes.txt),
// writes "REPORT: <what the tool returned>" and ends the turn.
//
// Environment:
//   MOCK_CLAUDE_LOG   file that gets one JSON line for the start (arguments, cwd) and one with the tools the endpoint
//                     offered
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const args = process.argv.slice(2);
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => {
	if (env.MOCK_CLAUDE_LOG) appendFileSync(env.MOCK_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
};
const valueOf = (flag) => {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
};

log({
	start: args,
	cwd: process.cwd(),
	entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
	autoMemoryOff: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
});

const mcpFile = valueOf("--mcp-config");
const mcp = mcpFile ? Object.values(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers)[0] : undefined;
let nextId = 1;
async function rpc(method, params) {
	const response = await fetch(mcp.url, {
		method: "POST",
		headers: { "content-type": "application/json", ...mcp.headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	if (!response.ok) throw new Error(`MCP ${method}: HTTP ${response.status}`);
	const answer = await response.json();
	if (answer.error) throw new Error(`MCP ${method}: ${answer.error.message}`);
	return answer.result;
}

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

async function turn() {
	if (!mcp) {
		send({ type: "result", subtype: "error_during_execution", is_error: true, result: "no MCP endpoint was given" });
		return;
	}
	await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mock-claude" } });
	const { tools } = await rpc("tools/list", {});
	log({ offered: tools.map((tool) => tool.name) });
	const toolUseId = "toolu_mock_1";
	const input = { path: env.MOCK_CLAUDE_READ || "notes.txt" };
	send({
		type: "assistant",
		message: {
			id: "msg_mock_1",
			usage,
			content: [{ type: "tool_use", id: toolUseId, name: "mcp__myharness__read", input }],
		},
	});
	const result = await rpc("tools/call", {
		name: "read",
		arguments: input,
		_meta: { "claudecode/toolUseId": toolUseId },
	});
	send({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result.content }] },
	});
	const text = (result.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
	send({
		type: "assistant",
		message: {
			id: "msg_mock_2",
			usage,
			stop_reason: "end_turn",
			content: [{ type: "text", text: `REPORT: ${result.isError ? "tool failed: " : ""}${text}` }],
		},
	});
	send({ type: "result", subtype: "success", is_error: false });
}

send({ type: "system", subtype: "init", session_id: "mock-session", tools: [], model: valueOf("--model") ?? "mock" });

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
		return;
	}
	if (message.type === "user") {
		turn().catch((error) => {
			send({ type: "result", subtype: "error_during_execution", is_error: true, result: String(error?.message ?? error) });
		});
	}
});
process.stdin.on("end", () => process.exit(0));
