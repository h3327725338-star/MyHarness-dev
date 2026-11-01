import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findProducedFiles,
	recycleProducedFiles,
	summarizeProducedFiles,
} from "../src/application/use-cases/produced-files.ts";
import {
	isWithinTimeSpans,
	mergeTimeSpans,
	mergeWrittenFiles,
	readChatActivity,
	readWrittenFiles,
	type WrittenFile,
} from "../src/session/artifacts/written-files.ts";
import { createEditTool } from "../src/tools/files/edit.ts";
import { createReadTool } from "../src/tools/files/read.ts";
import { createWriteTool } from "../src/tools/files/write.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HEADER_TIME = "2026-05-01T10:00:00.000Z";
const LATER = "2026-05-01T10:01:00.000Z";

/** A project folder and a chat file saved the way the session stores them. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "myharness-produced-"));
	roots.push(root);
	const project = join(root, "我的 项目");
	const dataRoot = join(root, "data");
	mkdirSync(project, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	const chat = join(root, "chat.jsonl");
	const save = (lines: object[]) =>
		writeFileSync(
			chat,
			[{ type: "session", version: 3, id: "one", timestamp: HEADER_TIME, cwd: project }, ...lines]
				.map((line) => JSON.stringify(line))
				.join("\n"),
		);
	save([]);
	return { root, project, dataRoot, chat, save };
}

const result = (
	toolName: string,
	output: { content: unknown; details?: unknown; isError?: boolean },
	timestamp = LATER,
) => ({
	type: "message",
	id: `entry-${Math.random().toString(36).slice(2)}`,
	parentId: null,
	timestamp,
	message: { role: "toolResult", toolCallId: "call", toolName, isError: false, ...output },
});
const wrote = (path: string, details?: unknown, timestamp?: string) =>
	result("write", { content: [{ type: "text", text: `Successfully wrote 3 bytes to ${path}` }], details }, timestamp);

describe("what a chat's history says it wrote", () => {
	it("reads what the real tools report, with an absolute or a relative path", async () => {
		const f = fixture();
		const write = createWriteTool(f.project);
		const edit = createEditTool(f.project);
		const absolute = join(f.project, "pelican race.html");
		const outputs = [
			["write", await write.execute("a", { path: absolute, content: "abc\n" })],
			["write", await write.execute("b", { path: "sub/relative.txt", content: "abc\n" })],
			["write", await write.execute("c", { path: "sub/relative.txt", content: "abc\ndef\n" })],
		] as const;
		writeFileSync(join(f.project, "existing.md"), "old\n");
		await createReadTool(f.project).execute("d", { path: "existing.md" });
		const overwritten = await write.execute("e", { path: "existing.md", content: "new\n" });
		const edited = await edit.execute("f", {
			path: "existing.md",
			edits: [{ oldText: "new", newText: "newer" }],
		});
		f.save([
			...outputs.map(([name, output]) => result(name, { content: output.content, details: output.details })),
			result("write", { content: overwritten.content, details: overwritten.details }),
			result("edit", { content: edited.content, details: edited.details }),
		]);
		const written = await readWrittenFiles(f.chat);
		expect(Object.fromEntries(written.map((file) => [file.path.slice(f.project.length + 1), file.created]))).toEqual({
			"pelican race.html": true,
			[join("sub", "relative.txt")]: true,
			"existing.md": false,
		});
		expect(written.every((file) => file.lastTouched === Date.parse(LATER))).toBe(true);
	});

	it("takes only this chat's successful results", async () => {
		const f = fixture();
		const file = join(f.project, "a.txt");
		f.save([
			// Copied from the parent chat by a fork: older than this chat.
			wrote(join(f.project, "from-parent.txt"), { created: true }, "2026-04-01T10:00:00.000Z"),
			result("write", {
				content: [{ type: "text", text: `Successfully wrote 3 bytes to ${join(f.project, "failed.txt")}` }],
				details: { created: true },
				isError: true,
			}),
			// Text that only looks like a result.
			{
				type: "message",
				id: "u",
				timestamp: LATER,
				message: { role: "user", content: `"toolName":"write" Successfully wrote 1 bytes to ${file}` },
			},
			wrote(file, { created: true }),
		]);
		expect((await readWrittenFiles(f.chat)).map((item) => item.path)).toEqual([file]);
		expect(await readWrittenFiles(join(f.root, "missing.jsonl"))).toEqual([]);
	});

	it("reads a path up to the end of the result's first line", async () => {
		const f = fixture();
		const file = join(f.project, "a.txt");
		f.save([
			result("write", {
				content: [{ type: "text", text: `Successfully wrote 3 bytes to ${file}\n\nDiagnostics: none` }],
				details: { created: true },
			}),
		]);
		expect((await readWrittenFiles(f.chat)).map((item) => item.path)).toEqual([file]);
	});

	it("merges chats: created by any of them, last touched by whichever came last", () => {
		const path = join(tmpdir(), "same.txt");
		expect(
			mergeWrittenFiles([[{ path, created: true, lastTouched: 5 }], [{ path, created: false, lastTouched: 9 }]]),
		).toEqual([{ path, created: true, lastTouched: 9 }]);
	});
});

describe("when a chat's tools ran", () => {
	const at = (seconds: number) =>
		`2026-05-01T10:${String(10 + Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000Z`;
	const ms = (seconds: number) => Date.parse(at(seconds));
	const called = (seconds: number) => ({
		type: "message",
		id: `a${seconds}`,
		parentId: null,
		timestamp: at(seconds),
		message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "tool", arguments: {} }] },
	});
	const said = (seconds: number) => ({
		type: "message",
		id: `u${seconds}`,
		parentId: null,
		timestamp: at(seconds),
		message: { role: "user", content: `"toolName":"bash" "taskId":"nope"` },
	});
	const finished = (seconds: number, toolName: string, details?: unknown) => ({
		...result(toolName, { content: [{ type: "text", text: "output" }], details }, at(seconds)),
	});

	it("runs from the call to its result, for the tools that can make files", async () => {
		const f = fixture();
		f.save([
			said(0),
			called(10),
			finished(20, "bash"),
			called(30),
			finished(31, "read"),
			called(40),
			finished(50, "ask_user_question"),
			called(60),
			finished(61, "pwsh"),
			finished(62, "write"),
			called(70),
			finished(71, "some_mcp_tool"),
		]);
		const { cwd, toolRuns } = await readChatActivity(f.chat);
		expect(cwd).toBe(f.project);
		expect(mergeTimeSpans(toolRuns)).toEqual([
			{ start: ms(10), end: ms(20) },
			{ start: ms(60), end: ms(62) },
			{ start: ms(70), end: ms(71) },
		]);
	});

	it("leaves out what a fork inherited, and a missing chat has none", async () => {
		const f = fixture();
		f.save([
			{ ...called(1), timestamp: "2026-04-01T10:00:00.000Z" },
			{ ...finished(2, "bash"), timestamp: "2026-04-01T10:00:01.000Z" },
			called(10),
			finished(20, "bash"),
		]);
		expect((await readChatActivity(f.chat)).toolRuns).toEqual([{ start: ms(10), end: ms(20) }]);
		expect(await readChatActivity(join(f.root, "missing.jsonl"))).toEqual({ written: [], toolRuns: [] });
	});

	it("reads the time of a line too long to hold", async () => {
		const f = fixture();
		f.save([
			called(10),
			{ ...finished(20, "bash"), padding: "x".repeat(5 * 1024 * 1024) },
			called(30),
			finished(40, "bash"),
		]);
		expect((await readChatActivity(f.chat)).toolRuns).toEqual([
			{ start: ms(10), end: ms(20) },
			{ start: ms(30), end: ms(40) },
		]);
	});

	it("follows a background job to the end of its turn, and whenever the chat looks at it again", async () => {
		const f = fixture();
		f.save([
			said(0),
			called(10),
			finished(11, "bash", { taskId: "job-1" }),
			called(30),
			finished(31, "read"),
			{ ...called(50), message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
			said(100),
			called(110),
			finished(111, "read"),
			said(200),
			called(210),
			finished(211, "job_output"),
		]);
		expect(mergeTimeSpans((await readChatActivity(f.chat)).toolRuns)).toEqual([{ start: ms(10), end: ms(211) }]);
	});

	it("does not take a job's id quoted in text for a job", async () => {
		const f = fixture();
		f.save([
			said(0),
			called(10),
			finished(11, "bash", { exitCode: 0 }),
			said(100),
			called(110),
			finished(111, "bash"),
		]);
		expect(mergeTimeSpans((await readChatActivity(f.chat)).toolRuns)).toEqual([
			{ start: ms(10), end: ms(11) },
			{ start: ms(110), end: ms(111) },
		]);
	});

	it("finds a time in merged spans, give or take the slack", () => {
		const spans = mergeTimeSpans([
			{ start: 100, end: 200 },
			{ start: 150, end: 300 },
			{ start: 1000, end: 1100 },
		]);
		expect(spans).toEqual([
			{ start: 100, end: 300 },
			{ start: 1000, end: 1100 },
		]);
		expect(isWithinTimeSpans(spans, 250, 0)).toBe(true);
		expect(isWithinTimeSpans(spans, 500, 0)).toBe(false);
		expect(isWithinTimeSpans(spans, 950, 50)).toBe(true);
		expect(isWithinTimeSpans(spans, 949, 50)).toBe(false);
		expect(isWithinTimeSpans([], 1, 1000)).toBe(false);
	});
});

describe("what goes with a chat's artifacts", () => {
	const options = (f: ReturnType<typeof fixture>, canRecycle = true) => ({ dataRoot: f.dataRoot, canRecycle });
	/** A tool that has been running since before the test and is still running. */
	const running = () => [{ start: Date.now() - 1000, end: Date.now() + 60_000 }];
	/** A tool that ran only after these lines: what they made is older than it. */
	const later = () => [{ start: Date.now() + 10_000, end: Date.now() + 60_000 }];
	const chat = (
		f: ReturnType<typeof fixture>,
		toolRuns: { start: number; end: number }[],
		written: WrittenFile[] = [],
	) => ({
		cwd: f.project,
		written,
		toolRuns,
	});
	const going = (found: { files: { path: string; kept?: unknown }[] }, root: string) =>
		found.files.filter((file) => !file.kept).map((file) => file.path.slice(root.length + 1));

	it("takes what a shell command made, and leaves what was there before", async () => {
		const f = fixture();
		writeFileSync(join(f.project, "mine.txt"), "mine");
		const runs = later();
		// The folder's own time decides whether its files are looked at: make it look touched during the run.
		utimesSync(f.project, new Date(runs[0]!.start), new Date(runs[0]!.start));
		expect((await findProducedFiles([chat(f, runs)], options(f))).files).toEqual([]);
		const file = join(f.project, "shot.png");
		writeFileSync(file, "abcd");
		expect((await findProducedFiles([chat(f, running())], options(f))).files).toContainEqual({
			path: file,
			bytes: 4,
		});
	});

	it("takes a folder the chat made as one item, with what it holds counted", async () => {
		const f = fixture();
		mkdirSync(join(f.project, "video", "frames"), { recursive: true });
		writeFileSync(join(f.project, "video", "a.png"), "abc");
		writeFileSync(join(f.project, "video", "frames", "b.png"), "abcd");
		mkdirSync(join(f.project, "empty"));
		const found = await findProducedFiles([chat(f, running())], options(f));
		expect(found.files).toEqual([
			{ path: join(f.project, "empty"), bytes: 0, files: 0, folder: true },
			{ path: join(f.project, "video"), bytes: 7, files: 2, folder: true },
		]);
		const summary = summarizeProducedFiles(found);
		expect(summary).toMatchObject({ files: 2, bytes: 7, kept: 0, items: 2 });
	});

	it("takes the files of a folder that also holds something else, and leaves the folder", async () => {
		const f = fixture();
		mkdirSync(join(f.project, "src"));
		writeFileSync(join(f.project, "src", "old.txt"), "old");
		await wait(2600);
		writeFileSync(join(f.project, "src", "new.txt"), "new");
		const runs = [{ start: Date.now() - 500, end: Date.now() + 60_000 }];
		expect(going(await findProducedFiles([chat(f, runs)], options(f)), f.project)).toEqual([join("src", "new.txt")]);
	});

	describe("with a chat that stays and worked at the same time", () => {
		const iso = (time: number) => new Date(time).toISOString();
		/** A chat saved the way the session stores it, its entries at these times. */
		const savedChat = (f: ReturnType<typeof fixture>, lines: object[]) => {
			const path = join(f.root, `other-${Math.random().toString(36).slice(2)}.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: "two",
				timestamp: iso(Date.now() - 600_000),
				cwd: f.project,
			};
			writeFileSync(path, [header, ...lines].map((line) => JSON.stringify(line)).join("\n"));
			return path;
		};
		const called = (time: number) => ({
			type: "message",
			id: `a${time}`,
			parentId: null,
			timestamp: iso(time),
			message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] },
		});
		const ranShell = (start: number, end: number) => [
			called(start),
			result("bash", { content: [{ type: "text", text: "done" }] }, iso(end)),
		];
		const stays = (path: string, change: { created?: number; modified?: number; busy?: boolean } = {}) => ({
			path,
			created: Date.now() - 600_000,
			modified: Date.now() + 60_000,
			busy: false,
			...change,
		});

		it("keeps what may be its work and says why, a folder as what it holds", async () => {
			const f = fixture();
			const now = Date.now();
			const others = [stays(savedChat(f, ranShell(now - 5000, now + 60_000)))];
			writeFileSync(join(f.project, "shot.png"), "abcd");
			mkdirSync(join(f.project, "video"));
			writeFileSync(join(f.project, "video", "frame.png"), "abc");
			const found = await findProducedFiles([chat(f, running())], { ...options(f), others });
			expect(found.files).toEqual([
				{ path: join(f.project, "shot.png"), bytes: 4, kept: "other-chat" },
				{ path: join(f.project, "video", "frame.png"), bytes: 3, kept: "other-chat" },
			]);
			expect(summarizeProducedFiles(found)).toMatchObject({ files: 0, bytes: 0, kept: 2, items: 2 });
		});

		it("still takes what the write tool says this chat created at that moment", async () => {
			const f = fixture();
			const now = Date.now();
			const others = [stays(savedChat(f, ranShell(now - 5000, now + 60_000)))];
			const file = join(f.project, "page.html");
			writeFileSync(file, "abc");
			const mine = chat(f, running(), [{ path: file, created: true, lastTouched: now + 1000 }]);
			const found = await findProducedFiles([mine], { ...options(f), others });
			expect(found.files).toEqual([{ path: file, bytes: 3 }]);
		});

		it("keeps what it wrote to as well, whenever its tool ran", async () => {
			const f = fixture();
			const now = Date.now();
			const file = join(f.project, "shared.html");
			writeFileSync(file, "abc");
			const others = [
				stays(savedChat(f, [called(now - 500_000), wrote(file, { created: true }, iso(now - 499_000))])),
			];
			const mine = chat(f, running(), [{ path: file, created: true, lastTouched: now + 1000 }]);
			const found = await findProducedFiles([mine], { ...options(f), others });
			expect(found.files).toEqual([{ path: file, bytes: 3, kept: "other-chat" }]);
		});

		it("does not read a chat that ended before this work began or started after it ended", async () => {
			const f = fixture();
			const now = Date.now();
			const path = savedChat(f, ranShell(now - 5000, now + 60_000));
			const file = join(f.project, "shot.png");
			writeFileSync(file, "abcd");
			for (const other of [stays(path, { modified: now - 100_000 }), stays(path, { created: now + 100_000 })]) {
				const found = await findProducedFiles([chat(f, running())], { ...options(f), others: [other] });
				expect(found.files).toEqual([{ path: file, bytes: 4 }]);
			}
		});

		it("counts the tool of a chat working right now, which has no result yet", async () => {
			const f = fixture();
			const now = Date.now();
			const path = savedChat(f, [called(now - 1000)]);
			const file = join(f.project, "shot.png");
			writeFileSync(file, "abcd");
			const asIdle = await findProducedFiles([chat(f, running())], { ...options(f), others: [stays(path)] });
			expect(asIdle.files).toEqual([{ path: file, bytes: 4 }]);
			const asBusy = await findProducedFiles([chat(f, running())], {
				...options(f),
				others: [stays(path, { busy: true })],
			});
			expect(asBusy.files).toEqual([{ path: file, bytes: 4, kept: "other-chat" }]);
		});
	});

	it("keeps what someone changed outside the chat's runs", async () => {
		const f = fixture();
		const file = join(f.project, "changed.txt");
		writeFileSync(file, "abc");
		const runs = [{ start: Date.now() - 1000, end: Date.now() + 1000 }];
		const hourLater = new Date(Date.now() + 3_600_000);
		utimesSync(file, hourLater, hourLater);
		expect((await findProducedFiles([chat(f, runs)], options(f))).files).toEqual([
			{ path: file, bytes: 3, kept: "changed" },
		]);
		// Changed by a later run of the chat itself: still its own work.
		const withLaterRun = [...runs, { start: hourLater.getTime() - 1000, end: hourLater.getTime() + 1000 }];
		expect((await findProducedFiles([chat(f, withLaterRun)], options(f))).files).toEqual([{ path: file, bytes: 3 }]);
	});

	it("takes what the write tool created even outside any run, unless changed after its last write", async () => {
		const f = fixture();
		const file = join(f.project, "made.html");
		writeFileSync(file, "abc");
		const written = (lastTouched: number) => [{ path: file, created: true, lastTouched }];
		expect((await findProducedFiles([chat(f, [], written(Date.now() + 1000))], options(f))).files).toEqual([
			{ path: file, bytes: 3 },
		]);
		expect((await findProducedFiles([chat(f, [], written(Date.now() - 60_000))], options(f))).files).toEqual([
			{ path: file, bytes: 3, kept: "changed" },
		]);
	});

	it("reaches a file the write tool created outside the chat's folder", async () => {
		const f = fixture();
		const outside = join(f.root, "elsewhere.txt");
		writeFileSync(outside, "abc");
		const written = [{ path: outside, created: true, lastTouched: Date.now() + 1000 }];
		expect((await findProducedFiles([chat(f, [], written)], options(f))).files).toEqual([
			{ path: outside, bytes: 3 },
		]);
	});

	it("leaves out what it only edited, what is gone and the app's data, but not a Workspace's folder in the data root", async () => {
		const f = fixture();
		const edited = join(f.project, "only-edited.txt");
		writeFileSync(edited, "abc");
		const inData = join(f.dataRoot, "workspaces", "w", "sessions", "s", "artifacts", "report.md");
		mkdirSync(join(inData, ".."), { recursive: true });
		writeFileSync(inData, "abc");
		const written = [
			{ path: edited, created: false, lastTouched: Date.now() + 1000 },
			{ path: join(f.project, "removed-later.txt"), created: true, lastTouched: Date.now() + 1000 },
			{ path: inData, created: true, lastTouched: Date.now() + 1000 },
		];
		const runs = later();
		expect((await findProducedFiles([chat(f, runs, written)], options(f))).files).toEqual([]);
		const folder = join(f.dataRoot, "workspace-folders", "made-here");
		mkdirSync(folder, { recursive: true });
		const made = join(folder, "a.txt");
		writeFileSync(made, "abc");
		const found = await findProducedFiles([{ cwd: folder, written: [], toolRuns: running() }], options(f));
		expect(found.files).toEqual([{ path: made, bytes: 3 }]);
	});

	it("keeps what Git tracks in a repository that was there before", async () => {
		const f = fixture();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: f.project, stdio: "ignore" });
		git("init");
		await wait(2600);
		const runs = [{ start: Date.now() - 500, end: Date.now() + 60_000 }];
		mkdirSync(join(f.project, "src"));
		const tracked = join(f.project, "src", "main [1].ts");
		const untracked = join(f.project, "src", "scratch.ts");
		writeFileSync(tracked, "abc");
		writeFileSync(untracked, "abc");
		git("add", "--", "src/main [1].ts");
		const found = await findProducedFiles([chat(f, runs)], options(f));
		expect(found.files).toEqual([
			{ path: tracked, bytes: 3, kept: "committed" },
			{ path: untracked, bytes: 3 },
		]);
		expect(existsSync(join(f.project, ".git"))).toBe(true);
	});

	it("takes a repository the chat itself started, with what it tracks", async () => {
		const f = fixture();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: f.project, stdio: "ignore" });
		git("init");
		writeFileSync(join(f.project, "app.js"), "abc");
		git("add", "--", "app.js");
		const found = await findProducedFiles([chat(f, running())], options(f));
		expect(found.files).toEqual([
			{ path: join(f.project, ".git"), bytes: 0, files: 0, folder: true },
			{ path: join(f.project, "app.js"), bytes: 3 },
		]);
	});

	it("does not enter links, the app's own folder or old installed packages", async () => {
		const f = fixture();
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "theirs.txt"), "abc");
		symlinkSync(outside, join(f.project, "link"), "junction");
		mkdirSync(join(f.project, ".myharness"));
		writeFileSync(join(f.project, ".myharness", "settings.json"), "{}");
		mkdirSync(join(f.project, "node_modules", "pkg"), { recursive: true });
		await wait(2600);
		writeFileSync(join(f.project, "node_modules", "pkg", "new.js"), "abc");
		const runs = [{ start: Date.now() - 500, end: Date.now() + 60_000 }];
		expect((await findProducedFiles([chat(f, runs)], options(f))).files).toEqual([]);
		expect(existsSync(join(outside, "theirs.txt"))).toBe(true);
	});

	it("does not search a chat at the drive's root, and names only what its tools created", async () => {
		const f = fixture();
		const root = parse(f.root).root;
		const started = Date.now();
		const found = await findProducedFiles([{ cwd: root, written: [], toolRuns: running() }], options(f));
		expect(found).toEqual({ files: [], incomplete: false });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("keeps everything when no Recycle Bin can be reached", async () => {
		const f = fixture();
		const file = join(f.project, "made.html");
		writeFileSync(file, "abc");
		mkdirSync(join(f.project, "video"));
		expect((await findProducedFiles([chat(f, running())], options(f, false))).files).toEqual([
			{ path: file, bytes: 3, kept: "no-recycle-bin" },
			{ path: join(f.project, "video"), bytes: 0, files: 0, folder: true, kept: "no-recycle-bin" },
		]);
	});

	it("looks through nested chat folders once, for several chats", async () => {
		const f = fixture();
		mkdirSync(join(f.project, "sub"));
		await wait(2600);
		writeFileSync(join(f.project, "sub", "a.txt"), "abc");
		const runs = [{ start: Date.now() - 500, end: Date.now() + 60_000 }];
		const found = await findProducedFiles(
			[chat(f, runs), { cwd: join(f.project, "sub"), written: [], toolRuns: runs }],
			options(f),
		);
		expect(found.files).toEqual([{ path: join(f.project, "sub", "a.txt"), bytes: 3 }]);
	});

	it("caps the list, not the counts, with what goes first", () => {
		const files = Array.from({ length: 250 }, (_, index) => ({
			path: `f${index}`,
			bytes: 1,
			...(index === 0 ? { kept: "changed" as const } : {}),
		}));
		const summary = summarizeProducedFiles({ files, incomplete: true });
		expect(summary).toMatchObject({ files: 249, bytes: 249, kept: 1, items: 250, incomplete: true });
		expect(summary.list).toHaveLength(200);
		expect(summary.list[0]!.path).toBe("f1");
	});
});

describe("moving files to the Recycle Bin", () => {
	it("returns what is still in place, whatever the host answered", async () => {
		const f = fixture();
		const gone = join(f.project, "gone.txt");
		const stays = join(f.project, "stays.txt");
		writeFileSync(gone, "abc");
		writeFileSync(stays, "abc");
		const asked: unknown[] = [];
		const channel = {
			request: async (command: Record<string, unknown>) => {
				asked.push(command);
				rmSync(gone);
				return { done: true };
			},
		};
		expect(await recycleProducedFiles([gone, stays], channel)).toEqual([stays]);
		expect(asked).toEqual([{ channel: "recycle", action: "recycle", paths: [gone, stays] }]);
		expect(readFileSync(stays, "utf8")).toBe("abc");
	});

	it("moves nothing without a host, or when the host fails", async () => {
		const f = fixture();
		const file = join(f.project, "a.txt");
		writeFileSync(file, "abc");
		expect(await recycleProducedFiles([file], undefined)).toEqual([file]);
		const failing = { request: () => Promise.reject(new Error("the channel closed")) };
		expect(await recycleProducedFiles([file], failing)).toEqual([file]);
		const untouched = { request: () => Promise.reject(new Error("never asked")) };
		expect(await recycleProducedFiles([], untouched)).toEqual([]);
	});
});
