/**
 * When a repeated tool call is skipped as a duplicate. A repeat is skipped only while skipping it cannot change the
 * outcome: a shell command within the reply that ran it first, a write or an edit while the file is still exactly as
 * that call left it. Real files and a real shell; no model.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "../src/index.ts";
import { createBashToolDefinition } from "../src/tools/shell/bash.ts";
import { ToolIdempotencyCache, toolIdempotency } from "../src/tools/tool-idempotency.ts";

const textOf = (result: any): string =>
	(result.content ?? []).map((part: any) => (part.type === "text" ? part.text : "")).join("");

describe("duplicate tool calls", () => {
	let dir: string;
	let session = 0;
	let ctx: any;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "myharness-idempotency-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	beforeEach(() => {
		// Every case is a session of its own, the way a chat is.
		const id = `idempotency-session-${++session}`;
		ctx = { sessionManager: { getSessionId: () => id } };
		toolIdempotency.beginReply(id);
	});
	const nextReply = () => toolIdempotency.beginReply(ctx.sessionManager.getSessionId());

	describe("bash", () => {
		it("runs the same command again in a later reply, and skips it only within one reply", async () => {
			const bash = createBashToolDefinition(dir);
			const counter = join(dir, "counter.txt");
			writeFileSync(counter, "");
			const command = "echo run >> counter.txt && wc -l < counter.txt";
			const runs = () => readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;

			const first = await bash.execute("call-1", { command }, undefined, undefined, ctx);
			expect(textOf(first).trim()).toBe("1");
			// The same command twice in one reply: the second is not run, and says where the output is.
			const repeat = await bash.execute("call-2", { command }, undefined, undefined, ctx);
			expect(textOf(repeat)).toContain("Duplicate bash call");
			expect(textOf(repeat)).toContain("in this same reply");
			expect(runs()).toBe(1);

			// A later reply asks again on purpose (the tests after a fix, `git status` after an edit, a wait).
			nextReply();
			const later = await bash.execute("call-3", { command }, undefined, undefined, ctx);
			expect(textOf(later).trim()).toBe("2");
			expect(runs()).toBe(2);
		}, 30_000);

		it("never treats a command as a repeat when nothing tells replies apart", async () => {
			const bash = createBashToolDefinition(dir);
			const counter = join(dir, "no-session.txt");
			writeFileSync(counter, "");
			const command = "echo run >> no-session.txt && wc -l < no-session.txt";
			expect(textOf(await bash.execute("call-1", { command }, undefined, undefined, undefined as any)).trim()).toBe(
				"1",
			);
			expect(textOf(await bash.execute("call-2", { command }, undefined, undefined, undefined as any)).trim()).toBe(
				"2",
			);
		}, 30_000);

		it("keeps a failed command retryable within the reply", async () => {
			const bash = createBashToolDefinition(dir);
			const command = "test -f appears-later.txt && echo found";
			await expect(bash.execute("call-1", { command }, undefined, undefined, ctx)).rejects.toThrow();
			writeFileSync(join(dir, "appears-later.txt"), "x");
			expect(textOf(await bash.execute("call-2", { command }, undefined, undefined, ctx)).trim()).toBe("found");
		}, 30_000);
	});

	describe("write", () => {
		it("replays the same bytes only while the file is as that write left it", async () => {
			const write = createWriteToolDefinition(dir);
			const read = createReadToolDefinition(dir);
			const file = join(dir, "page.txt");
			const one = "version one\n";

			await write.execute("call-1", { path: file, content: one }, undefined, undefined, ctx);
			const same = await write.execute("call-2", { path: file, content: one }, undefined, undefined, ctx);
			expect(same.details).toMatchObject({ idempotentReplay: true });

			// Another version is written, then the first one again: it must really be on disk again.
			await read.execute("call-3", { path: file }, undefined, undefined, ctx);
			await write.execute("call-4", { path: file, content: "version two\n" }, undefined, undefined, ctx);
			const back = await write.execute("call-5", { path: file, content: one }, undefined, undefined, ctx);
			expect(back.details?.idempotentReplay).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(one);
		});

		it("writes again after something outside the tool changed the file", async () => {
			const write = createWriteToolDefinition(dir);
			const read = createReadToolDefinition(dir);
			const file = join(dir, "outside.txt");
			const content = "kept by the tool\n";
			await write.execute("call-1", { path: file, content }, undefined, undefined, ctx);
			// A command, an editor or the user changes the file.
			writeFileSync(file, "changed by someone else, and longer\n");
			await read.execute("call-2", { path: file }, undefined, undefined, ctx);
			const again = await write.execute("call-3", { path: file, content }, undefined, undefined, ctx);
			expect(again.details?.idempotentReplay).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(content);
		});
	});

	describe("edit", () => {
		it("answers a repeat as a duplicate while the file is unchanged, and applies it once the text is back", async () => {
			const edit = createEditToolDefinition(dir);
			const read = createReadToolDefinition(dir);
			const file = join(dir, "config.txt");
			writeFileSync(file, "mode = slow\nname = demo\n");
			const edits = [{ oldText: "mode = slow", newText: "mode = fast" }];

			await read.execute("call-1", { path: file }, undefined, undefined, ctx);
			await edit.execute("call-2", { path: file, edits }, undefined, undefined, ctx);
			expect(readFileSync(file, "utf8")).toContain("mode = fast");
			const repeat = await edit.execute("call-3", { path: file, edits }, undefined, undefined, ctx);
			expect(textOf(repeat)).toContain("Duplicate edit call");
			expect(repeat.details).toMatchObject({ idempotentDuplicate: true });

			// The change is taken back (here by another edit); the same edit is then a real change again.
			await edit.execute(
				"call-4",
				{ path: file, edits: [{ oldText: "mode = fast", newText: "mode = slow" }] },
				undefined,
				undefined,
				ctx,
			);
			const again = await edit.execute("call-5", { path: file, edits }, undefined, undefined, ctx);
			expect(textOf(again)).not.toContain("Duplicate");
			expect(readFileSync(file, "utf8")).toContain("mode = fast");
		});
	});

	it("numbers a session's replies and forgets the sessions used longest ago", () => {
		const cache = new ToolIdempotencyCache();
		expect(cache.replyOf("a")).toBe(0);
		cache.beginReply("a");
		cache.beginReply("a");
		cache.beginReply("b");
		expect(cache.replyOf("a")).toBe(2);
		expect(cache.replyOf("b")).toBe(1);
		for (let index = 0; index < 250; index++) cache.beginReply(`other-${index}`);
		expect(cache.replyOf("a")).toBe(0);
		cache.set("key", true);
		cache.delete("key");
		expect(cache.has("key")).toBe(false);
	});
});
