/**
 * A shell command the model asks for again in a later reply runs again; only a repeat inside one reply is skipped.
 * Real session, real bash tool, scripted model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("bash repeated across replies", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs the same command once per reply that asks for it", async () => {
		const harness = await createHarness({ sessionCwd: "temp", initialActiveToolNames: ["bash"] });
		harnesses.push(harness);
		const counter = join(harness.tempDir, "counter.txt");
		writeFileSync(counter, "");
		const command = "echo run >> counter.txt && wc -l < counter.txt";
		harness.setResponses([
			// One reply with the command twice: the second is a repeat.
			fauxAssistantMessage([fauxToolCall("bash", { command }), fauxToolCall("bash", { command })], {
				stopReason: "toolUse",
			}),
			// The next reply asks again, having seen the result: it runs.
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("count");

		const results = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message).trim());
		expect(results).toHaveLength(3);
		expect(results[0]).toBe("1");
		expect(results[1]).toContain("Duplicate bash call");
		expect(results[2]).toBe("2");
		expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);

		// And in the reply to a new message of the user.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done again"),
		]);
		await harness.session.prompt("count once more");
		const last = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(getMessageText(last).trim()).toBe("3");
	}, 60_000);
});
