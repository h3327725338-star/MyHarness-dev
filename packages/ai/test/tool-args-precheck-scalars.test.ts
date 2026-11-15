/**
 * A number or a boolean written as text reaches the full validation, which reads it as the value it spells. The quick
 * check that runs first used to refuse it ("Write `limit` as number, given string"), so a call whose meaning was never
 * in doubt cost a second request (seen in real chats with `memory_search`).
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { precheckToolArguments } from "../src/utils/tool-args-precheck.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const tool: Tool = {
	name: "memory_search",
	description: "Search",
	parameters: Type.Object({
		query: Type.String({ minLength: 1 }),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
		exact: Type.Optional(Type.Boolean()),
		tags: Type.Optional(Type.Array(Type.String())),
	}),
};
const call = (args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id: "call-1",
	name: tool.name,
	arguments: args,
});

describe("quick argument check and values written as text", () => {
	it("lets a number and a boolean written as text through to the validation that reads them", () => {
		const toolCall = call({ query: "notes", limit: "5", exact: "true" });
		expect(precheckToolArguments(tool, toolCall)).toBeNull();
		expect(validateToolArguments(tool, toolCall)).toEqual({ query: "notes", limit: 5, exact: true });
	});

	it("still has text that spells no number refused, by the full validation", () => {
		const toolCall = call({ query: "notes", limit: "a few" });
		expect(precheckToolArguments(tool, toolCall)).toBeNull();
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/limit/);
	});

	it("still has a number outside the field's range refused once it is read", () => {
		const toolCall = call({ query: "notes", limit: "500" });
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/limit/);
	});

	it("keeps refusing the wrong kinds it always refused", () => {
		// A number where text is expected, and text where a list is expected.
		expect(precheckToolArguments(tool, call({ query: 7 }))).toContain("expected type string but got integer");
		expect(precheckToolArguments(tool, call({ query: "notes", tags: "one, two" }))).toContain("tags");
		// A missing required field.
		expect(precheckToolArguments(tool, call({ limit: 3 }))).toContain("query");
	});
});
