/**
 * Calls that say what they mean in other words than the declared ones. Every form here was sent by a model in real
 * chats and refused once before it was sent again; each is now read as the declared call it stands for, and checked
 * against the tool's own schema the way the agent loop checks it.
 */
import { type Tool, validateToolArguments } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createSessionGetToolDefinition } from "../src/tools/history/session-history.ts";
import { createWebFetchToolDefinition, createWebSearchToolDefinition } from "../src/tools/web-search/tool.ts";
import { createWorkspaceToolDefinition, normalizeWorkspaceArguments } from "../src/tools/workspace.ts";

/** What the tool is executed with: its own preparation, then the validation of its schema. */
function accepted(
	definition: {
		name: string;
		description: string;
		parameters: unknown;
		prepareArguments?: (args: unknown) => unknown;
	},
	args: Record<string, unknown>,
): unknown {
	const prepared = definition.prepareArguments ? definition.prepareArguments(args) : args;
	const tool = {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
	} as Tool;
	return validateToolArguments(tool, {
		type: "toolCall",
		id: "call-1",
		name: definition.name,
		arguments: prepared as Record<string, unknown>,
	});
}

describe("workspace: other words for a declared call", () => {
	const workspace = createWorkspaceToolDefinition() as any;

	it("reads a point given to click as the mouse's click at that point", () => {
		expect(accepted(workspace, { operation: "click", tabId: "t1", x: 320, y: 144 })).toEqual({
			operation: "mouse",
			action: "click",
			tabId: "t1",
			x: 320,
			y: 144,
		});
		expect(accepted(workspace, { operation: "click", tabId: "t1", x: "320", y: "144", screenshot: true })).toEqual({
			operation: "mouse",
			action: "click",
			tabId: "t1",
			x: 320,
			y: 144,
			screenshot: true,
		});
		expect(accepted(workspace, { operation: "click", tabId: "t1", x: 5, y: 6, double: true })).toMatchObject({
			operation: "mouse",
			action: "double_click",
		});
		expect(accepted(workspace, { operation: "click", tabId: "t1", x: 5, y: 6, button: "right" })).toMatchObject({
			operation: "mouse",
			action: "right_click",
		});
	});

	it("leaves a click at an element alone, and still refuses a point next to an element", () => {
		const byLabel = { operation: "click", tabId: "t1", label: "Sign in" };
		expect(normalizeWorkspaceArguments(byLabel)).toBe(byLabel);
		expect(accepted(workspace, byLabel)).toEqual(byLabel);
		expect(() => accepted(workspace, { operation: "click", tabId: "t1", selector: "#go", x: 1, y: 2 })).toThrow(
			/not a parameter of this operation/,
		);
	});

	it("takes the operation named as a key or as action", () => {
		expect(accepted(workspace, { navigate: "https://example.com", tabId: "t1" })).toEqual({
			operation: "navigate",
			url: "https://example.com",
			tabId: "t1",
		});
		expect(accepted(workspace, { action: "open", url: "https://example.com" })).toMatchObject({
			operation: "open",
			url: "https://example.com",
		});
		// The mouse's own `action` is not an operation: such a call still has to name one.
		expect(() => accepted(workspace, { action: "wheel", tabId: "t1", deltaY: 300 })).toThrow(/operation: missing/);
	});

	it("reads an address given to read as read_many of that one page", () => {
		expect(accepted(workspace, { operation: "read", url: "https://example.com/a", links: true })).toEqual({
			operation: "read_many",
			urls: ["https://example.com/a"],
			links: true,
		});
		expect(accepted(workspace, { operation: "read_many", url: "https://example.com/a" })).toEqual({
			operation: "read_many",
			urls: ["https://example.com/a"],
		});
		// A tab's own read is untouched; an address next to a tab is still refused (two things to read).
		const ofTab = { operation: "read", tabId: "t1", scroll: true };
		expect(normalizeWorkspaceArguments(ofTab)).toBe(ofTab);
		expect(() => accepted(workspace, { operation: "read", tabId: "t1", url: "https://example.com" })).toThrow(
			/url: not a parameter of this operation/,
		);
	});

	it("takes scroll's limit under the name read uses", () => {
		expect(accepted(workspace, { operation: "scroll", tabId: "t1", deltaY: 600, maxScrolls: 5 })).toEqual({
			operation: "scroll",
			tabId: "t1",
			deltaY: 600,
			maxSteps: 5,
		});
	});

	it("still refuses what names no declared call", () => {
		expect(() => accepted(workspace, { operation: "status", type: "browser", url: "https://example.com" })).toThrow(
			/not a parameter of this operation/,
		);
		expect(() => accepted(workspace, { tabId: "t1" })).toThrow(/operation: missing/);
	});
});

describe("web_search and web_fetch: the field named in the singular", () => {
	it("reads query as the one query and url as the one address", () => {
		expect(accepted(createWebSearchToolDefinition(process.cwd()) as any, { query: "tsgo incremental" })).toEqual({
			queries: ["tsgo incremental"],
		});
		expect(accepted(createWebFetchToolDefinition(process.cwd()) as any, { url: "https://example.com" })).toEqual({
			urls: ["https://example.com"],
		});
	});

	it("keeps the list when both are given, and a list written as text", () => {
		expect(accepted(createWebSearchToolDefinition(process.cwd()) as any, { queries: "one query" })).toEqual({
			queries: ["one query"],
		});
		expect(accepted(createWebSearchToolDefinition(process.cwd()) as any, { queries: ["a", "b"] })).toEqual({
			queries: ["a", "b"],
		});
	});
});

describe("session_get: the chat's id under another name", () => {
	const sessionGet = createSessionGetToolDefinition(process.cwd()) as any;

	it("reads id, session_id or sessionId as session when session is missing", () => {
		for (const name of ["id", "session_id", "sessionId"]) {
			expect(accepted(sessionGet, { [name]: "01a1d69f", tail: 4 })).toEqual({ session: "01a1d69f", tail: 4 });
		}
		expect(accepted(sessionGet, { session: "01a1d69f" })).toEqual({ session: "01a1d69f" });
		expect(() => accepted(sessionGet, {})).toThrow(/session/);
	});
});
