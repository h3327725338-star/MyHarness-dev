import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir as osTmpdir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMirrorCopy, prewarmMirrorPool, releaseMirrorCopy } from "../src/agent/delegation/mirror-pool.ts";

const directories: string[] = [];

async function originDir() {
	const path = await mkdtemp(join(tmpdir(), "mirror-pool-origin-"));
	directories.push(path);
	return path;
}

async function agentDir() {
	const path = await mkdtemp(join(osTmpdir(), "mirror-pool-agent-"));
	directories.push(path);
	return path;
}

afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

type AcquireOptions = Parameters<typeof acquireMirrorCopy>[0];

async function acquire(origin: string, agent: string, options: Partial<AcquireOptions> = {}) {
	const result = await acquireMirrorCopy({
		agentDir: agent,
		originCwd: origin,
		access: "write",
		...options,
	} as AcquireOptions);
	expect(result.ok, result.ok ? undefined : result.error).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.handle;
}

/** Snapshot every entry (files and directories) below a root, keyed by relative path. */
async function snapshot(root: string): Promise<Map<string, { size: number; mtimeMs: number }>> {
	const entries = new Map<string, { size: number; mtimeMs: number }>();
	const directories_ = [root];
	while (directories_.length > 0) {
		const current = directories_.pop()!;
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const info = await stat(path);
			entries.set(path.slice(root.length + 1), { size: info.size, mtimeMs: info.mtimeMs });
			if (info.isDirectory()) directories_.push(path);
		}
	}
	return entries;
}

async function poolRootOf(agent: string): Promise<string> {
	const sandboxes = await readdir(join(agent, "sandboxes"));
	expect(sandboxes).toHaveLength(1);
	return join(agent, "sandboxes", sandboxes[0]!);
}

describe("mirror pool", () => {
	it("copies the origin into a slot and never writes into the origin", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await mkdir(join(origin, "sub"));
		await writeFile(join(origin, "a.txt"), "hello");
		await writeFile(join(origin, "sub", "b.txt"), "world");
		const before = await snapshot(origin);
		const handle = await acquire(origin, agent);
		const after = await snapshot(origin);
		expect([...after]).toEqual([...before]);
		expect(handle.slotName).toBe("slot-1");
		expect(handle.sandboxPath).toBe(join(await poolRootOf(agent), "slot-1", "workspace"));
		expect(handle.originCwd).toBe(origin);
		expect(handle.importedFiles).toBe(2);
		expect(handle.copiedFiles).toBe(2);
		expect(handle.complete).toBe(true);
		expect(await readFile(join(handle.sandboxPath, "a.txt"), "utf8")).toBe("hello");
		expect(await readFile(join(handle.sandboxPath, "sub", "b.txt"), "utf8")).toBe("world");
		// The worker could edit the mirror; the origin must stay untouched even then.
		await writeFile(join(handle.sandboxPath, "a.txt"), "worker edit");
		expect(await readFile(join(origin, "a.txt"), "utf8")).toBe("hello");
		expect(await snapshot(origin)).toEqual(before);
		await releaseMirrorCopy(handle);
	});

	it("keeps excluded files out of the mirror", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await mkdir(join(origin, ".git"));
		await mkdir(join(origin, "node_modules"));
		await writeFile(join(origin, ".git", "HEAD"), "ref: refs/heads/main");
		await writeFile(join(origin, "node_modules", "left-pad.js"), "module.exports = {};");
		await writeFile(join(origin, ".env"), "SECRET=1");
		await writeFile(join(origin, "secret.key"), "private key");
		await writeFile(join(origin, "keep.txt"), "kept");
		const handle = await acquire(origin, agent);
		expect(handle.importedFiles).toBe(1);
		expect(await readFile(join(handle.sandboxPath, "keep.txt"), "utf8")).toBe("kept");
		const mirrorNames = await readdir(handle.sandboxPath);
		expect(mirrorNames).toEqual(["keep.txt"]);
		expect(handle.importNotes.join("\n")).toContain(".env");
		expect(handle.importNotes.join("\n")).toContain("node_modules");
		await releaseMirrorCopy(handle);
	});

	it("reuses a slot and copies only changed files", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await mkdir(join(origin, "sub"));
		await writeFile(join(origin, "a.txt"), "one");
		await writeFile(join(origin, "sub", "b.txt"), "two");
		const first = await acquire(origin, agent);
		expect(first.slotName).toBe("slot-1");
		expect(await releaseMirrorCopy(first)).toEqual({ changedFiles: [] });
		// One origin file changed, one new file appeared: only those two are copied on reuse.
		await writeFile(join(origin, "a.txt"), "changed-content");
		await writeFile(join(origin, "c.txt"), "new file");
		const second = await acquire(origin, agent);
		expect(second.slotName).toBe("slot-1");
		expect(second.savedChanges).toBeUndefined();
		expect(second.copiedFiles).toBe(2);
		expect(second.importedFiles).toBe(3);
		expect(await readFile(join(second.sandboxPath, "a.txt"), "utf8")).toBe("changed-content");
		expect(await releaseMirrorCopy(second)).toEqual({ changedFiles: [] });
		// A deleted origin file is removed from the mirror without copying anything.
		await unlink(join(origin, "sub", "b.txt"));
		const third = await acquire(origin, agent);
		expect(third.slotName).toBe("slot-1");
		expect(third.copiedFiles).toBe(0);
		expect(third.removedFiles).toBe(1);
		expect(third.importedFiles).toBe(2);
		await releaseMirrorCopy(third);
	});

	it("a busy slot makes acquire create the next slot immediately", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		const first = await acquire(origin, agent);
		await releaseMirrorCopy(first);
		// Another process holds slot-1: the lock file exists with our pid but a foreign token.
		const poolRoot = await poolRootOf(agent);
		await writeFile(
			join(poolRoot, "locks", "slot-1.lock"),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				host: hostname(),
				token: "foreign-token",
				acquiredAt: new Date().toISOString(),
				purpose: "test",
			}),
		);
		const second = await acquire(origin, agent);
		expect(second.slotName).toBe("slot-2");
		expect(second.importedFiles).toBe(1);
		expect(await readFile(join(second.sandboxPath, "a.txt"), "utf8")).toBe("one");
		await releaseMirrorCopy(second);
		// slot-1 stays exactly as it was, lock file included.
		expect(await readFile(join(poolRoot, "locks", "slot-1.lock"), "utf8")).toContain("foreign-token");
	});

	it("takes over a stale lock left by a dead pid", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		const first = await acquire(origin, agent);
		await releaseMirrorCopy(first);
		const poolRoot = await poolRootOf(agent);
		await writeFile(
			join(poolRoot, "locks", "slot-1.lock"),
			JSON.stringify({
				version: 1,
				pid: 0,
				host: hostname(),
				token: "dead-owner",
				acquiredAt: new Date().toISOString(),
				purpose: "task",
			}),
		);
		const handle = await acquire(origin, agent);
		expect(handle.slotName).toBe("slot-1");
		expect(handle.lock.token).not.toBe("dead-owner");
		await releaseMirrorCopy(handle);
	});

	it("saves a task's changes before reusing the slot", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "origin version");
		await writeFile(join(origin, "b.txt"), "origin b");
		const first = await acquire(origin, agent);
		expect(await releaseMirrorCopy(first)).toEqual({ changedFiles: [] });
		// The "task" edits its mirror: modifies a.txt, creates new.txt and deletes b.txt.
		await writeFile(join(first.sandboxPath, "a.txt"), "task edited a.txt with more text");
		await writeFile(join(first.sandboxPath, "new.txt"), "task created");
		await unlink(join(first.sandboxPath, "b.txt"));
		const released = await releaseMirrorCopy(first);
		expect(released.changedFiles).toEqual(["created:new.txt", "deleted:b.txt", "modified:a.txt"]);
		const second = await acquire(origin, agent);
		expect(second.slotName).toBe("slot-1");
		expect(second.savedChanges).toBeDefined();
		expect(second.savedChanges?.files).toBe(2);
		const savedRoot = second.savedChanges!.path;
		const changes = JSON.parse(await readFile(join(savedRoot, "changes.json"), "utf8")) as {
			created: string[];
			modified: string[];
			deleted: string[];
		};
		expect(changes).toEqual({ created: ["new.txt"], modified: ["a.txt"], deleted: ["b.txt"] });
		expect(await readFile(join(savedRoot, "files", "a.txt"), "utf8")).toBe("task edited a.txt with more text");
		expect(await readFile(join(savedRoot, "files", "new.txt"), "utf8")).toBe("task created");
		// The mirror itself is back in line with the origin.
		expect(await readFile(join(second.sandboxPath, "a.txt"), "utf8")).toBe("origin version");
		expect(await readFile(join(second.sandboxPath, "b.txt"), "utf8")).toBe("origin b");
		expect(await readdir(second.sandboxPath).then((names) => names.includes("new.txt"))).toBe(false);
		expect(second.importedFiles).toBe(2);
		const state = JSON.parse(await readFile(join(second.containerPath, "state.json"), "utf8")) as {
			unsavedChanges: boolean;
		};
		expect(state.unsavedChanges).toBe(false);
		await releaseMirrorCopy(second);
	});

	it("release reports the finished task's changed files", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		const handle = await acquire(origin, agent);
		await writeFile(join(handle.sandboxPath, "a.txt"), "task changed the length");
		await writeFile(join(handle.sandboxPath, "extra.txt"), "extra");
		const result = await releaseMirrorCopy(handle);
		expect(result.changedFiles).toEqual(["created:extra.txt", "modified:a.txt"]);
		const state = JSON.parse(await readFile(join(handle.containerPath, "state.json"), "utf8")) as {
			unsavedChanges: boolean;
		};
		expect(state.unsavedChanges).toBe(true);
	});

	it("refuses when the pool root and the origin overlap", async () => {
		const origin = await originDir();
		const result = await acquireMirrorCopy({
			agentDir: join(origin, "inside"),
			originCwd: origin,
			access: "read",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("重叠");
	});

	it("prewarm fills the pool and acquire hands out both slots", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 2 });
		const poolRoot = await poolRootOf(agent);
		expect(await readdir(poolRoot)).toEqual(expect.arrayContaining(["slot-1", "slot-2"]));
		for (const slot of ["slot-1", "slot-2"]) {
			const manifest = JSON.parse(await readFile(join(poolRoot, slot, "manifest.json"), "utf8")) as {
				files: Record<string, unknown>;
			};
			expect(Object.keys(manifest.files)).toContain("a.txt");
		}
		const first = await acquire(origin, agent);
		expect(first.slotName).toBe("slot-1");
		const second = await acquire(origin, agent);
		expect(second.slotName).toBe("slot-2");
		expect(second.copiedFiles).toBe(0);
		expect(second.importedFiles).toBe(1);
		await releaseMirrorCopy(first);
		await releaseMirrorCopy(second);
	});
	it("prewarm skips a workspace without a pool when asked to", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 2, onlyIfPoolExists: true });
		await expect(readdir(join(agent, "sandboxes"))).rejects.toThrow();
	});

	it("prewarm syncs clean idle slots to the origin and leaves a slot with task changes alone", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 2 });
		const poolRoot = await poolRootOf(agent);
		// slot-1 gets task changes; slot-2 stays clean.
		const busy = await acquire(origin, agent);
		expect(busy.slotName).toBe("slot-1");
		await writeFile(join(busy.sandboxPath, "task.txt"), "task output");
		expect((await releaseMirrorCopy(busy)).changedFiles).toEqual(["created:task.txt"]);
		// The origin moves on while the pool is idle.
		await writeFile(join(origin, "b.txt"), "new in origin");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 2, onlyIfPoolExists: true });
		expect(await readFile(join(poolRoot, "slot-2", "workspace", "b.txt"), "utf8")).toBe("new in origin");
		const warmed = JSON.parse(await readFile(join(poolRoot, "slot-2", "warmed.json"), "utf8")) as Record<
			string,
			string
		>;
		expect(Object.keys(warmed).sort()).toEqual(["a.txt", "b.txt"]);
		// The slot with the task change is untouched: no sync, the change still in place.
		expect(await readFile(join(poolRoot, "slot-1", "workspace", "task.txt"), "utf8")).toBe("task output");
		await expect(stat(join(poolRoot, "slot-1", "workspace", "b.txt"))).rejects.toThrow();
		// The next task takes the clean, already synced slot and copies nothing.
		const next = await acquire(origin, agent);
		expect(next.slotName).toBe("slot-2");
		expect(next.copiedFiles).toBe(0);
		await releaseMirrorCopy(next);
	});

	it("does not copy dependency or build cache files into the saved changes", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		const first = await acquire(origin, agent);
		await mkdir(join(first.sandboxPath, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(first.sandboxPath, "node_modules", "pkg", "index.js"), "module");
		await writeFile(join(first.sandboxPath, "result.md"), "work product");
		await releaseMirrorCopy(first);
		const second = await acquire(origin, agent);
		const savedRoot = second.savedChanges!.path;
		expect(second.savedChanges?.files).toBe(1);
		expect(await readFile(join(savedRoot, "files", "result.md"), "utf8")).toBe("work product");
		await expect(stat(join(savedRoot, "files", "node_modules"))).rejects.toThrow();
		const changes = JSON.parse(await readFile(join(savedRoot, "changes.json"), "utf8")) as {
			notSaved?: { count: number; files: string[] };
		};
		expect(changes.notSaved).toMatchObject({ count: 1, files: ["node_modules/pkg/index.js"] });
		await expect(stat(join(second.sandboxPath, "node_modules"))).rejects.toThrow();
		await releaseMirrorCopy(second);
	});

	it("moves a workspace aside when its manifest is lost instead of syncing over it", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "origin version");
		const first = await acquire(origin, agent);
		await releaseMirrorCopy(first);
		// The "task" edited its mirror, then the manifest is lost (crash, manual deletion, unreadable file...).
		await writeFile(join(first.sandboxPath, "a.txt"), "task edit that must survive");
		await unlink(join(first.containerPath, "manifest.json"));
		const before = await snapshot(origin);
		const second = await acquire(origin, agent);
		expect(second.slotName).toBe("slot-1");
		// The whole old workspace moved into saved/ under a clearly named entry; nothing was synced over it.
		expect(second.savedChanges).toBeDefined();
		expect(second.savedChanges?.path).toContain(join("saved", "slot-1"));
		expect(second.savedChanges?.path).toContain("workspace-without-manifest");
		expect(second.savedChanges?.files).toBe(1);
		// The previous task's change survives in the moved-aside copy.
		expect(await readFile(join(second.savedChanges!.path, "a.txt"), "utf8")).toBe("task edit that must survive");
		// The fresh mirror is rebuilt from the origin, and the origin itself was never touched.
		expect(await readFile(join(second.sandboxPath, "a.txt"), "utf8")).toBe("origin version");
		expect(await snapshot(origin)).toEqual(before);
		// state.json is written atomically: no temp leftovers stay in the slot.
		const slotEntries = await readdir(second.containerPath);
		expect(slotEntries.some((name) => name.includes(".tmp-"))).toBe(false);
		await releaseMirrorCopy(second);
	});

	it("treats a manifest with an unsafe key as unreadable and never uses it as an unlink target", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "origin version");
		const first = await acquire(origin, agent);
		await releaseMirrorCopy(first);
		const poolRoot = await poolRootOf(agent);
		// A crafted manifest points outside the workspace: with the old code the "../escape.txt" key became an
		// unlink target and deleted a file next to the workspace.
		await writeFile(join(poolRoot, "slot-1", "escape.txt"), "outside the workspace");
		await writeFile(
			join(poolRoot, "slot-1", "manifest.json"),
			JSON.stringify({
				version: 1,
				files: {
					"a.txt": { originSize: 14, originMtimeMs: 1, mirrorSize: 14, mirrorMtimeMs: 1 },
					"../escape.txt": { originSize: 0, originMtimeMs: 0, mirrorSize: 0, mirrorMtimeMs: 0 },
				},
			}),
		);
		const second = await acquire(origin, agent);
		// The unsafe manifest is unreadable, so the workspace moved aside instead of being synced over it.
		expect(second.savedChanges).toBeDefined();
		expect(second.savedChanges?.path).toContain("workspace-without-manifest");
		// The file the crafted manifest pointed at was never deleted.
		expect(await readFile(join(poolRoot, "slot-1", "escape.txt"), "utf8")).toBe("outside the workspace");
		// The fresh mirror is rebuilt from the origin.
		expect(await readFile(join(second.sandboxPath, "a.txt"), "utf8")).toBe("origin version");
		await releaseMirrorCopy(second);
	});

	it.runIf(process.platform === "win32")(
		"a junction planted in a manifest-less mirror never redirects the sync outside the pool",
		async () => {
			const origin = await originDir();
			const agent = await agentDir();
			await mkdir(join(origin, "sub"));
			await writeFile(join(origin, "a.txt"), "one");
			await writeFile(join(origin, "sub", "b.txt"), "world");
			const first = await acquire(origin, agent);
			await releaseMirrorCopy(first);
			// The previous task plants a junction where the origin has a directory, then the manifest is lost.
			const outside = await mkdtemp(join(tmpdir(), "mirror-pool-escape-"));
			directories.push(outside);
			await writeFile(join(outside, "target.txt"), "untouched");
			await rm(join(first.sandboxPath, "sub"), { recursive: true });
			await symlink(outside, join(first.sandboxPath, "sub"), "junction");
			await unlink(join(first.containerPath, "manifest.json"));
			const before = await snapshot(outside);
			const second = await acquire(origin, agent);
			expect(second.savedChanges).toBeDefined();
			// Nothing was written into or deleted from the junction target, and the origin is untouched.
			expect(await snapshot(outside)).toEqual(before);
			expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("untouched");
			// The fresh mirror matches the origin through real directories, not through the junction.
			expect(await readFile(join(second.sandboxPath, "sub", "b.txt"), "utf8")).toBe("world");
			await releaseMirrorCopy(second);
		},
	);

	it("prewarm leaves a slot alone while another owner holds its lock", async () => {
		const origin = await originDir();
		const agent = await agentDir();
		await writeFile(join(origin, "a.txt"), "one");
		await writeFile(join(origin, "b.txt"), "two");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 1 });
		const poolRoot = await poolRootOf(agent);
		await writeFile(
			join(poolRoot, "locks", "slot-1.lock"),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				host: hostname(),
				token: "foreign-token",
				acquiredAt: new Date().toISOString(),
				purpose: "test",
			}),
		);
		await writeFile(join(origin, "b.txt"), "changed in origin");
		await prewarmMirrorPool({ agentDir: agent, originCwd: origin, size: 1, onlyIfPoolExists: true });
		// The held slot is neither refreshed (no sync of the changed origin file) nor taken over.
		expect(await readFile(join(poolRoot, "slot-1", "workspace", "b.txt"), "utf8")).toBe("two");
		expect(await readFile(join(poolRoot, "locks", "slot-1.lock"), "utf8")).toContain("foreign-token");
	});
});
