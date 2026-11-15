// A stand-in for the short-lived `claude -p` that the Claude Code plugin asks for the plan limits: it answers the
// `initialize` and `get_usage` control requests the way the real program does (stream-json), with no model and no network.
//
// Environment:
//   MOCK_CLAUDE_USAGE   the JSON of the get_usage answer; "error" makes the program refuse the request, "silent" makes
//                       it answer `initialize` and then nothing
//   MOCK_CLAUDE_LOG     file that gets one JSON line for the start (arguments) and one per control request
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => {
	if (env.MOCK_CLAUDE_LOG) appendFileSync(env.MOCK_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
};

log({ start: process.argv.slice(2) });

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.type !== "control_request") return;
	const id = message.request_id;
	const request = message.request ?? {};
	log({ request });
	if (request.subtype === "initialize") {
		send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
	} else if (request.subtype === "get_usage") {
		if (env.MOCK_CLAUDE_USAGE === "silent") return;
		if (env.MOCK_CLAUDE_USAGE === "error") {
			send({ type: "control_response", response: { subtype: "error", request_id: id, error: "Not logged in" } });
			return;
		}
		send({
			type: "control_response",
			response: { subtype: "success", request_id: id, response: JSON.parse(env.MOCK_CLAUDE_USAGE || "{}") },
		});
	}
});
process.stdin.on("end", () => process.exit(0));
