/**
 * A pool of reusable, long-lived file mirrors of one non-Git workspace folder for sub-agent tasks.
 *
 * Instead of building a fresh temporary mirror per dispatch (see {@link ../non-git-sandbox.ts}), the pool keeps a
 * small set of ready-made mirror slots under `<agentDir>/sandboxes/<pool key>` and hands one slot to one task at a
 * time. Acquisition never waits: a free slot is locked, or the next slot is created immediately. Before a slot is
 * reused, whatever the previous task left behind in its mirror is detected and saved under `<poolRoot>/saved/`, so
 * no task's changes are destroyed. The mirror is then re-synced against the origin, copying only files that are new
 * or changed (by size and mtimeMs) and removing mirror files the origin no longer has.
 *
 * Safety rules inherited from the temporary mirror: the origin is only ever read, exclusion rules
 * ({@link nonGitMirrorExclusion}) and budgets ({@link NON_GIT_MIRROR_LIMITS}) apply to every walk, symlinks and
 * junctions are never followed or created, the origin must never overlap the pool root, and nothing is git-inited.
 */
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";
import { NON_GIT_MIRROR_LIMITS, nonGitMirrorExclusion } from "./non-git-sandbox.ts";
import { isSlotLockHeld, releaseSlotLock, type SlotLock, tryAcquireSlotLock, withPoolMutex } from "./slot-lock.ts";

const MAX_NOTES = 20;
const MANIFEST_FILE = "manifest.json";
const STATE_FILE = "state.json";
const WORKSPACE_DIR = "workspace";
const LOCKS_DIR = "locks";
const SAVED_DIR = "saved";
/** What the prewarm has already read in a slot: rel path -> "size:mtimeMs" of the mirror file at that time. */
const WARMED_FILE = "warmed.json";
const MAX_NOT_SAVED_LISTED = 200;
/** Upper bound for counting files in a workspace that is moved aside, so a huge leftover stays cheap to report. */
const MOVED_WORKSPACE_FILE_CAP = 10_000;

export interface MirrorCopyHandle {
	slotName: string;
	/** The worker's cwd: `<poolRoot>/<slotName>/workspace`. */
	sandboxPath: string;
	containerPath: string;
	/** realpath of the origin workspace; the pool only ever reads from it. */
	originCwd: string;
	access: "read" | "write";
	/** Files present in the mirror after the sync. */
	importedFiles: number;
	importedBytes: number;
	/** Files copied from the origin during this sync. */
	copiedFiles: number;
	removedFiles: number;
	skippedEntries: number;
	importNotes: string[];
	complete: boolean;
	preparationMs: number;
	savedChanges?: { path: string; files: number };
	lock: SlotLock;
}

export type MirrorPoolAcquireResult = { ok: true; handle: MirrorCopyHandle } | { ok: false; error: string };

interface ManifestEntry {
	originSize: number;
	originMtimeMs: number;
	mirrorSize: number;
	mirrorMtimeMs: number;
}

interface Manifest {
	version: 1;
	files: Record<string, ManifestEntry>;
}

interface SlotState {
	version: 1;
	unsavedChanges: boolean;
	changedFiles: number;
	access: "read" | "write";
	checkedAt: string;
}

interface MirrorChanges {
	created: string[];
	modified: string[];
	missing: string[];
}

interface SyncResult {
	manifest: Manifest;
	copiedFiles: number;
	removedFiles: number;
	importedFiles: number;
	importedBytes: number;
	skippedEntries: number;
	importNotes: string[];
	complete: boolean;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `<agentDir>/sandboxes/<first 16 hex of sha256(pathIdentityKey(origin))>`. */
export function poolRootFor(agentDir: string, originCwd: string): string {
	const key = pathIdentityKey(originCwd);
	const digest = createHash("sha256").update(key).digest("hex");
	return join(resolve(agentDir), "sandboxes", digest.slice(0, 16));
}

function slotDir(poolRoot: string, slotName: string): string {
	return join(poolRoot, slotName);
}

function slotWorkspace(poolRoot: string, slotName: string): string {
	return join(slotDir(poolRoot, slotName), WORKSPACE_DIR);
}

function slotLockPath(poolRoot: string, slotName: string): string {
	return join(poolRoot, LOCKS_DIR, `${slotName}.lock`);
}

function normalizeRel(rel: string): string {
	return rel.split(sep).join("/");
}

async function listSlotNames(poolRoot: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(poolRoot);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries) {
		const match = /^slot-(\d+)$/.exec(entry);
		if (!match) continue;
		try {
			if ((await fs.lstat(join(poolRoot, entry))).isDirectory()) names.push(entry);
		} catch {
			// Vanished mid-scan: not a usable slot.
		}
	}
	return names.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}

async function nextSlotName(poolRoot: string): Promise<string> {
	const names = await listSlotNames(poolRoot);
	const max = names.reduce((value, name) => Math.max(value, Number(name.slice(5))), 0);
	return `slot-${max + 1}`;
}

/**
 * A manifest key is used verbatim as an unlink and copy target, so it must be a safe relative path: no empty key, no
 * NUL, no absolute path, drive letter, UNC or leading slash or backslash, and no empty, `.` or `..` segment.
 * Anything else makes the whole manifest unreadable (it then takes the workspace-without-manifest path).
 */
function manifestKeyIsSafe(key: string): boolean {
	if (key.length === 0 || key.includes("\0")) return false;
	if (/^(?:[a-zA-Z]:|[/\\])/.test(key)) return false;
	return key.split(/[/\\]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readManifest(slotPath: string): Promise<Manifest | undefined> {
	const manifestPath = join(slotPath, MANIFEST_FILE);
	try {
		const stat = await fs.lstat(manifestPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
		if (value?.version !== 1 || typeof value.files !== "object" || value.files === null) return undefined;
		// Every key becomes an unlink or copy target: one unsafe key means the manifest cannot be trusted at all.
		for (const key of Object.keys(value.files)) if (!manifestKeyIsSafe(key)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

async function writeManifest(poolRoot: string, slotName: string, manifest: Manifest): Promise<void> {
	const target = join(slotDir(poolRoot, slotName), MANIFEST_FILE);
	const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
	await replaceFileAtomically(temp, target, JSON.stringify(manifest));
}

/** Write `content` to `temp` and rename it over `target`; a failed step never leaves the temp file behind. */
async function replaceFileAtomically(temp: string, target: string, content: string): Promise<void> {
	try {
		await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
		await fs.rename(temp, target);
	} catch (error) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Rename a folder, retrying a few times when Windows reports it busy: an antivirus scan or an indexer can hold a
 * file in it open for a moment. Any other error, or a folder still busy after the retries, is thrown.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
		}
	}
}

async function readState(poolRoot: string, slotName: string): Promise<SlotState | undefined> {
	try {
		const stat = await fs.lstat(join(slotDir(poolRoot, slotName), STATE_FILE));
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		const value = JSON.parse(await fs.readFile(join(slotDir(poolRoot, slotName), STATE_FILE), "utf8")) as SlotState;
		if (value?.version !== 1 || typeof value.unsavedChanges !== "boolean") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

async function writeState(poolRoot: string, slotName: string, state: SlotState): Promise<void> {
	const target = join(slotDir(poolRoot, slotName), STATE_FILE);
	const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
	await replaceFileAtomically(temp, target, JSON.stringify(state));
}

/**
 * Compare the mirror against the manifest and report what the finished task changed: files it created (in the
 * mirror only), files it modified (size or mtimeMs differ from the recorded mirror stats), and manifest files now
 * missing from the mirror (the task deleted them). Symlinks a task placed in the mirror count as created entries
 * but are never followed when saving.
 */
async function detectMirrorChanges(workspace: string, manifest: Manifest): Promise<MirrorChanges> {
	const changes: MirrorChanges = { created: [], modified: [], missing: [] };
	const seen = new Set<string>();
	const directories = [{ rel: "", depth: 0 }];
	while (directories.length > 0) {
		const item = directories.pop()!;
		let directory: Awaited<ReturnType<typeof fs.opendir>>;
		try {
			directory = await fs.opendir(join(workspace, item.rel));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for await (const entry of directory) {
			const rel = normalizeRel(join(item.rel, entry.name));
			// A file that vanishes while it is walked counts as that one entry missing, never as an acquire failure.
			const stat = await fs.lstat(join(workspace, rel)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (!stat) continue;
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				directories.push({ rel, depth: item.depth + 1 });
				continue;
			}
			seen.add(rel);
			const record = manifest.files[rel];
			if (!record) {
				changes.created.push(rel);
			} else if (stat.isFile() && (stat.size !== record.mirrorSize || stat.mtimeMs !== record.mirrorMtimeMs)) {
				changes.modified.push(rel);
			} else if (!stat.isFile() || stat.isSymbolicLink()) {
				// Replaced by a link or an odd entry: treat as modified content the save step will skip.
				changes.modified.push(rel);
			}
		}
	}
	for (const rel of Object.keys(manifest.files)) if (!seen.has(rel)) changes.missing.push(rel);
	return changes;
}

/**
 * The first ancestor folder of `rel` that the mirror never carries (dependency and build caches such as
 * node_modules, dist or .cache), or undefined. Files a task created inside such a folder can be generated again.
 */
function regenerableAncestor(rel: string): string | undefined {
	const segments = rel.split("/");
	for (let index = 1; index < segments.length; index++) {
		const ancestor = segments.slice(0, index).join("/");
		if (nonGitMirrorExclusion(ancestor, true)) return ancestor;
	}
	return undefined;
}

/**
 * Copy every created and modified regular file of the finished task into
 * `<poolRoot>/saved/<slot>-<timestamp>/files/` and write `changes.json` listing created, modified and deleted
 * paths. Deleted mirror files cannot be restored (their content is gone), so they are only recorded. Files inside
 * dependency or build cache folders (node_modules, dist, ...) are not copied, because they can be generated again
 * and could be huge; `changes.json` lists them under `notSaved`.
 */
async function saveMirrorChanges(
	poolRoot: string,
	slotName: string,
	workspace: string,
	changes: MirrorChanges,
): Promise<{ path: string; files: number; json: { created: string[]; modified: string[]; deleted: string[] } }> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const savedRoot = join(poolRoot, SAVED_DIR, `${slotName}-${stamp}`);
	const filesRoot = join(savedRoot, "files");
	await fs.mkdir(filesRoot, { recursive: true });
	let saved = 0;
	const notSaved: string[] = [];
	let notSavedCount = 0;
	for (const rel of [...changes.created, ...changes.modified]) {
		if (regenerableAncestor(rel)) {
			notSavedCount++;
			if (notSaved.length < MAX_NOT_SAVED_LISTED) notSaved.push(rel);
			continue;
		}
		const source = join(workspace, rel);
		const stat = await fs.lstat(source).catch(() => undefined);
		if (!stat?.isFile() || stat.isSymbolicLink()) continue;
		const destination = join(filesRoot, rel);
		await fs.mkdir(join(destination, ".."), { recursive: true });
		await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
		saved++;
	}
	const json = {
		created: [...changes.created].sort(),
		modified: [...changes.modified].sort(),
		deleted: [...changes.missing].sort(),
	};
	const written =
		notSavedCount > 0
			? {
					...json,
					notSaved: {
						reason: "依赖或构建缓存目录里的文件可以重新生成，没有复制",
						count: notSavedCount,
						files: notSaved.sort(),
					},
				}
			: json;
	await fs.writeFile(join(savedRoot, "changes.json"), JSON.stringify(written, undefined, "\t"), {
		encoding: "utf8",
		mode: 0o600,
	});
	return { path: savedRoot, files: saved, json };
}

/**
 * The safe per-file copy: the source is opened with `O_NOFOLLOW`, verified to still be the ordinary file that was
 * measured (same size, mtimeMs and inode), re-verified after the copy, and the destination is created with `wx` so
 * an existing mirror file is never silently overwritten and nothing but a plain file is ever produced.
 */
async function safeCopyFile(
	originCwd: string,
	rel: string,
	expected: Stats,
	destination: string,
	signal: AbortSignal | undefined,
): Promise<number> {
	let source: Awaited<ReturnType<typeof fs.open>> | undefined;
	let target: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		signal?.throwIfAborted();
		const sourcePath = join(originCwd, rel);
		if (!(await fs.lstat(sourcePath)).isFile()) throw new Error("来源不再是普通文件");
		if (!within(originCwd, await fs.realpath(sourcePath))) throw new Error("文件链接越界");
		source = await fs.open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const before = await source.stat();
		if (
			!before.isFile() ||
			before.size !== expected.size ||
			before.mtimeMs !== expected.mtimeMs ||
			before.ino !== expected.ino
		)
			throw new Error("文件在复制前发生变化");
		await fs.mkdir(join(destination, ".."), { recursive: true });
		target = await fs.open(destination, "wx", 0o600);
		const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
		let position = 0;
		while (position < before.size) {
			signal?.throwIfAborted();
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
			if (bytesRead === 0) throw new Error("复制期间文件被截短");
			let written = 0;
			while (written < bytesRead) {
				const result = await target.write(buffer, written, bytesRead - written, position + written);
				if (result.bytesWritten === 0) throw new Error("文件写入没有进展");
				written += result.bytesWritten;
			}
			position += bytesRead;
		}
		const after = await source.stat();
		const current = await fs.lstat(sourcePath);
		if (
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			current.isSymbolicLink() ||
			current.ino !== before.ino ||
			current.size !== before.size ||
			current.mtimeMs !== before.mtimeMs
		)
			throw new Error("文件在复制期间发生变化");
		return before.size;
	} finally {
		await target?.close();
		await source?.close();
	}
}

/**
 * Bring the mirror back in line with the origin. The origin is walked with the shared exclusion rules and budgets;
 * a file is copied only when the manifest has no entry for it or its origin size/mtimeMs changed, mirror files whose
 * origin file is gone (or now excluded, or no longer budgeted) are removed, and the fresh manifest records both the
 * origin and the mirror stats of every mirrored file.
 */
async function syncFromOrigin(options: {
	originCwd: string;
	workspace: string;
	previous: Manifest | undefined;
	limits: typeof NON_GIT_MIRROR_LIMITS;
	signal?: AbortSignal;
}): Promise<SyncResult> {
	const { originCwd, workspace, previous, limits, signal } = options;
	const result: SyncResult = {
		manifest: { version: 1, files: {} },
		copiedFiles: 0,
		removedFiles: 0,
		importedFiles: 0,
		importedBytes: 0,
		skippedEntries: 0,
		importNotes: [],
		complete: true,
	};
	const note = (rel: string, reason: string, incomplete = false) => {
		result.skippedEntries++;
		if (incomplete) result.complete = false;
		if (result.importNotes.length < MAX_NOTES) result.importNotes.push(`${rel}：${reason}`);
	};
	let examined = 0;
	let reservedBytes = 0;
	const directories: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
	let pending: Promise<void>[] = [];
	const copyErrors: unknown[] = [];
	const drain = async () => {
		const settled = await Promise.allSettled(pending);
		pending = [];
		for (const settledResult of settled)
			if (settledResult.status === "rejected") copyErrors.push(settledResult.reason);
		if (copyErrors.length) throw copyErrors.shift();
	};
	const copyOne = async (rel: string, expected: Stats, destination: string) => {
		try {
			// An outdated mirror file must go before the exclusive-create copy.
			await fs.unlink(destination).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			const size = await safeCopyFile(originCwd, rel, expected, destination, signal);
			result.copiedFiles++;
			result.manifest.files[rel] = {
				originSize: expected.size,
				originMtimeMs: expected.mtimeMs,
				mirrorSize: size,
				mirrorMtimeMs: (await fs.lstat(destination)).mtimeMs,
			};
		} catch (error) {
			await fs.unlink(destination).catch((unlinkError) => {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
			});
			if (signal?.aborted) throw error;
			note(rel, `复制失败（${errorText(error)}）`, true);
		}
	};
	try {
		while (directories.length > 0) {
			signal?.throwIfAborted();
			const item = directories.pop()!;
			const absolute = join(originCwd, item.rel);
			const directoryStat = await fs.lstat(absolute);
			if (
				directoryStat.isSymbolicLink() ||
				!directoryStat.isDirectory() ||
				!within(originCwd, await fs.realpath(absolute))
			) {
				note(item.rel || ".", "目录已变化或链接越界", true);
				continue;
			}
			const directory = await fs.opendir(absolute);
			for await (const entry of directory) {
				signal?.throwIfAborted();
				if (++examined > limits.entries) throw new Error(`工作区超过 ${limits.entries} 个目录项，镜像同步已停止`);
				const rel = normalizeRel(join(item.rel, entry.name));
				const exclusion = nonGitMirrorExclusion(rel, entry.isDirectory());
				if (exclusion) {
					note(rel, exclusion);
					continue;
				}
				const stat = await fs.lstat(join(originCwd, rel));
				if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
					note(rel, "链接或非普通文件");
					continue;
				}
				if (stat.isDirectory()) {
					if (item.depth >= limits.depth) {
						note(rel, "超过目录深度预算", true);
						continue;
					}
					await fs.mkdir(join(workspace, rel), { recursive: true });
					directories.push({ rel, depth: item.depth + 1 });
				} else if (stat.size > limits.fileBytes || reservedBytes + stat.size > limits.totalBytes) {
					note(rel, "超过单文件或累计复制大小预算", true);
				} else {
					reservedBytes += stat.size;
					const record = previous?.files[rel];
					const unchanged =
						record !== undefined && record.originSize === stat.size && record.originMtimeMs === stat.mtimeMs;
					if (unchanged) {
						result.manifest.files[rel] = { ...record };
					} else {
						const destination = join(workspace, rel);
						pending.push(copyOne(rel, stat, destination));
						if (pending.length >= limits.concurrency) await drain();
					}
				}
			}
		}
	} finally {
		await drain();
	}
	signal?.throwIfAborted();
	// Sweep the mirror: record the mirror stats of kept files, and drop files the origin no longer has, files that
	// are now excluded, and files outside the budgets. The sweep never follows links.
	const mirrorDirs: string[] = [];
	const sweepDirectories: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
	while (sweepDirectories.length > 0) {
		const item = sweepDirectories.pop()!;
		let directory: Awaited<ReturnType<typeof fs.opendir>>;
		try {
			directory = await fs.opendir(join(workspace, item.rel));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		mirrorDirs.push(join(workspace, item.rel));
		for await (const entry of directory) {
			const rel = normalizeRel(join(item.rel, entry.name));
			const stat = await fs.lstat(join(workspace, rel));
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				sweepDirectories.push({ rel, depth: item.depth + 1 });
				continue;
			}
			const record = result.manifest.files[rel];
			if (record && !stat.isSymbolicLink() && stat.isFile()) {
				record.mirrorSize = stat.size;
				record.mirrorMtimeMs = stat.mtimeMs;
				result.importedFiles++;
				result.importedBytes += stat.size;
			} else {
				await fs.unlink(join(workspace, rel)).catch(() => {});
				result.removedFiles++;
			}
		}
	}
	// Remove directories the origin no longer has: leaf-first attempts, empty ones go, occupied ones stay.
	for (const directory of mirrorDirs.reverse()) {
		if (directory === workspace) continue;
		await fs.rmdir(directory).catch(() => {});
	}
	return result;
}

async function prepareOrigin(options: { originCwd: string }): Promise<string> {
	const originCwd = await fs.realpath(resolve(options.originCwd));
	if (!(await fs.stat(originCwd)).isDirectory()) throw new Error("原工作区不是目录");
	return originCwd;
}

async function ensurePoolRoot(agentDir: string, originCwd: string): Promise<string> {
	const poolRoot = resolve(poolRootFor(agentDir, originCwd));
	// Refuse before creating anything, so a refused pool never writes into the origin.
	if (within(originCwd, poolRoot) || within(poolRoot, originCwd)) throw new Error("原工作区与镜像池根目录重叠");
	await fs.mkdir(join(poolRoot, LOCKS_DIR), { recursive: true });
	const real = await fs.realpath(poolRoot);
	if (within(originCwd, real) || within(real, originCwd)) throw new Error("原工作区与镜像池根目录重叠");
	return real;
}

interface PickedSlot {
	slotName: string;
	lock: SlotLock;
}

/**
 * Pick a free slot — preferring clean state — or, when `createIfBusy`, the next slot; with `forceCreate` always the
 * next slot (prewarm's growth phase). Never waits or queues for a busy slot.
 */
async function pickSlot(
	poolRoot: string,
	purpose: "task" | "prewarm",
	options: { createIfBusy?: boolean; forceCreate?: boolean } = {},
): Promise<PickedSlot> {
	return withPoolMutex(poolRoot, async () => {
		const names = await listSlotNames(poolRoot);
		const states = new Map<string, SlotState | undefined>();
		for (const name of names) states.set(name, await readState(poolRoot, name));
		const clean = names.filter((name) => states.get(name)?.unsavedChanges === false);
		const dirty = names.filter((name) => states.get(name)?.unsavedChanges !== false);
		if (!options.forceCreate) {
			for (const name of [...clean, ...dirty]) {
				const lockPath = slotLockPath(poolRoot, name);
				if (isSlotLockHeld(lockPath)) continue;
				const lock = tryAcquireSlotLock(lockPath, purpose);
				if (lock) return { slotName: name, lock };
			}
			if (!options.createIfBusy && names.length > 0) throw new Error("没有空闲槽位且不允许新建");
		}
		const created = await nextSlotName(poolRoot);
		await fs.mkdir(slotWorkspace(poolRoot, created), { recursive: true, mode: 0o700 });
		const lock = tryAcquireSlotLock(slotLockPath(poolRoot, created), purpose);
		if (!lock) throw new Error(`新建的槽位锁立即被占用：${created}`);
		return { slotName: created, lock };
	});
}

/** Whether the slot workspace folder exists and holds any entry at all (links included). */
async function slotWorkspaceHasContent(workspace: string): Promise<boolean> {
	try {
		return (await fs.readdir(workspace)).length > 0;
	} catch {
		return false;
	}
}

/**
 * Count the ordinary files below `workspace` without following links, capped so a huge leftover stays cheap. Used
 * only to report how many files a moved-aside workspace still holds.
 */
async function countWorkspaceFiles(workspace: string): Promise<number> {
	let count = 0;
	const directories: string[] = [workspace];
	while (directories.length > 0 && count < MOVED_WORKSPACE_FILE_CAP) {
		const current = directories.pop()!;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (count >= MOVED_WORKSPACE_FILE_CAP) break;
			if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(join(current, entry.name));
			else if (entry.isFile()) count++;
		}
	}
	return count;
}

/**
 * A workspace whose manifest was lost but which has content must never be synced over: the sync would delete or
 * overwrite every mirror file. The whole workspace folder is renamed into `saved/` (same volume, never following
 * links) so the previous task's changes stay recoverable, and the caller builds a fresh workspace in its place.
 */
async function moveWorkspaceAside(
	poolRoot: string,
	slotName: string,
	workspace: string,
): Promise<{ path: string; files: number }> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const savedRoot = join(poolRoot, SAVED_DIR);
	await fs.mkdir(savedRoot, { recursive: true });
	let destination = join(savedRoot, `${slotName}-${stamp}-workspace-without-manifest`);
	for (let attempt = 1; ; attempt++) {
		const taken = await fs
			.lstat(destination)
			.then(() => true)
			.catch(() => false);
		if (!taken) break;
		destination = join(savedRoot, `${slotName}-${stamp}-${attempt}-workspace-without-manifest`);
	}
	await renameWithRetry(workspace, destination);
	return { path: destination, files: await countWorkspaceFiles(destination) };
}

/**
 * Take a mirror slot for a task. Picks or creates a slot under the pool mutex (never waiting for a busy slot),
 * saves whatever the previous task changed in the slot's mirror, then syncs the mirror against the origin by
 * copying only new or changed files.
 */
export async function acquireMirrorCopy(options: {
	agentDir: string;
	originCwd: string;
	access: "read" | "write";
	signal?: AbortSignal;
	limits?: Partial<typeof NON_GIT_MIRROR_LIMITS>;
}): Promise<MirrorPoolAcquireResult> {
	const startedAt = Date.now();
	let picked: PickedSlot | undefined;
	try {
		options.signal?.throwIfAborted();
		const originCwd = await prepareOrigin(options);
		const poolRoot = await ensurePoolRoot(options.agentDir, originCwd);
		const limits = { ...NON_GIT_MIRROR_LIMITS, ...options.limits };
		for (const value of Object.values(limits))
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("镜像预算必须为正整数");
		picked = await pickSlot(poolRoot, "task", { createIfBusy: true });
		const { slotName, lock } = picked;
		const workspace = slotWorkspace(poolRoot, slotName);
		await fs.mkdir(workspace, { mode: 0o700 }).catch(() => {});
		const previous = await readManifest(slotDir(poolRoot, slotName));
		let savedChanges: MirrorCopyHandle["savedChanges"];
		if (previous) {
			const changes = await detectMirrorChanges(workspace, previous);
			if (changes.created.length + changes.modified.length + changes.missing.length > 0) {
				const saved = await saveMirrorChanges(poolRoot, slotName, workspace, changes);
				savedChanges = { path: saved.path, files: saved.files };
				// The saved mirror files (and the manifest entries of deleted ones) must be rebuilt from the origin.
				for (const rel of [...changes.created, ...changes.modified, ...changes.missing]) {
					await fs.unlink(join(workspace, rel)).catch(() => {});
					delete previous.files[rel];
				}
			}
		} else if (await slotWorkspaceHasContent(workspace)) {
			// The manifest is gone, unreadable or untrusted: the previous task's changes cannot be diffed, so the whole
			// workspace is moved aside and rebuilt instead of synced over it.
			const moved = await moveWorkspaceAside(poolRoot, slotName, workspace);
			savedChanges = { path: moved.path, files: moved.files };
			await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
		}
		const sync = await syncFromOrigin({ originCwd, workspace, previous, limits, signal: options.signal });
		await writeManifest(poolRoot, slotName, sync.manifest);
		await writeState(poolRoot, slotName, {
			version: 1,
			unsavedChanges: false,
			changedFiles: 0,
			access: options.access,
			checkedAt: new Date().toISOString(),
		});
		if (!sync.complete && sync.importedFiles === 0 && sync.copiedFiles === 0)
			throw new Error(`没有成功复制可用文件：${sync.importNotes.join("；")}`);
		if (sync.skippedEntries > sync.importNotes.length)
			sync.importNotes.push(`另有 ${sync.skippedEntries - sync.importNotes.length} 项未带入镜像`);
		const handle: MirrorCopyHandle = {
			slotName,
			sandboxPath: workspace,
			containerPath: slotDir(poolRoot, slotName),
			originCwd,
			access: options.access,
			importedFiles: sync.importedFiles,
			importedBytes: sync.importedBytes,
			copiedFiles: sync.copiedFiles,
			removedFiles: sync.removedFiles,
			skippedEntries: sync.skippedEntries,
			importNotes: sync.importNotes,
			complete: sync.complete,
			preparationMs: Date.now() - startedAt,
			lock,
		};
		if (savedChanges) handle.savedChanges = savedChanges;
		return { ok: true, handle };
	} catch (error) {
		if (picked) releaseSlotLock(picked.lock);
		return { ok: false, error: `获取镜像槽位失败：${errorText(error)}` };
	}
}

/**
 * Hand a finished task's slot back. The task's changes are computed (same comparison as reuse), recorded in the
 * slot state file, and the lock is released. The slot itself is never deleted.
 */
export async function releaseMirrorCopy(handle: MirrorCopyHandle): Promise<{ changedFiles: string[]; error?: string }> {
	let changedFiles: string[] = [];
	let error: string | undefined;
	try {
		const previous = await readManifest(handle.containerPath);
		if (!previous) throw new Error(`槽位清单不存在或无效：${handle.containerPath}`);
		const changes = await detectMirrorChanges(handle.sandboxPath, previous);
		changedFiles = [
			...changes.created.map((rel) => `created:${rel}`),
			...changes.modified.map((rel) => `modified:${rel}`),
			...changes.missing.map((rel) => `deleted:${rel}`),
		].sort();
		await writeState(dirname(handle.containerPath), handle.slotName, {
			version: 1,
			unsavedChanges: changedFiles.length > 0,
			changedFiles: changedFiles.length,
			access: handle.access,
			checkedAt: new Date().toISOString(),
		});
	} catch (caught) {
		error = `记录槽位状态失败：${errorText(caught)}`;
	} finally {
		releaseSlotLock(handle.lock);
	}
	return error ? { changedFiles, error } : { changedFiles };
}

/**
 * Grow the pool to `size` ready slots (creating and syncing one at a time), then, one free slot at a time and
 * skipping slots another task holds: sync each clean slot to the origin (only changed files are copied) and read the
 * files the prewarm has not read yet, so antivirus scans happen during idle time instead of at the next dispatch. A
 * slot holding a task's unsaved changes is left alone. With `onlyIfPoolExists`, a workspace without a pool is skipped
 * (session start only tops up pools that dispatches created).
 */
export async function prewarmMirrorPool(options: {
	agentDir: string;
	originCwd: string;
	size: number;
	signal?: AbortSignal;
	onlyIfPoolExists?: boolean;
}): Promise<void> {
	if (!Number.isSafeInteger(options.size) || options.size <= 0) throw new Error("预热数量必须为正整数");
	options.signal?.throwIfAborted();
	const originCwd = await prepareOrigin(options);
	if (options.onlyIfPoolExists) {
		const exists = await fs
			.stat(poolRootFor(options.agentDir, originCwd))
			.then((stat) => stat.isDirectory())
			.catch(() => false);
		if (!exists) return;
	}
	const poolRoot = await ensurePoolRoot(options.agentDir, originCwd);
	while ((await listSlotNames(poolRoot)).length < options.size) {
		options.signal?.throwIfAborted();
		const picked = await pickSlot(poolRoot, "prewarm", { forceCreate: true });
		try {
			const workspace = slotWorkspace(poolRoot, picked.slotName);
			await fs.mkdir(workspace, { mode: 0o700 }).catch(() => {});
			const sync = await syncFromOrigin({
				originCwd,
				workspace,
				previous: await readManifest(slotDir(poolRoot, picked.slotName)),
				limits: NON_GIT_MIRROR_LIMITS,
				signal: options.signal,
			});
			await writeManifest(poolRoot, picked.slotName, sync.manifest);
			await writeState(poolRoot, picked.slotName, {
				version: 1,
				unsavedChanges: false,
				changedFiles: 0,
				access: "read",
				checkedAt: new Date().toISOString(),
			});
		} finally {
			releaseSlotLock(picked.lock);
		}
	}
	for (const slotName of await listSlotNames(poolRoot)) {
		options.signal?.throwIfAborted();
		// The stale-takeover check and take happen under the pool mutex, exactly like the task pick does.
		const lock = await withPoolMutex(poolRoot, () => {
			const lockPath = slotLockPath(poolRoot, slotName);
			if (isSlotLockHeld(lockPath)) return undefined;
			return tryAcquireSlotLock(lockPath, "prewarm");
		});
		if (!lock) continue;
		try {
			await refreshIdleSlot(poolRoot, slotName, originCwd, options.signal);
		} finally {
			releaseSlotLock(lock);
		}
	}
}

/**
 * Sync one free, clean slot to the origin and read the files the prewarm has not read yet. The caller holds the
 * slot's lock. A slot with a task's changes (by its state or by a fresh comparison) is not touched.
 */
async function refreshIdleSlot(
	poolRoot: string,
	slotName: string,
	originCwd: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const container = slotDir(poolRoot, slotName);
	const workspace = slotWorkspace(poolRoot, slotName);
	const state = await readState(poolRoot, slotName);
	const manifest = await readManifest(container);
	if (state?.unsavedChanges !== false || !manifest) return;
	const changes = await detectMirrorChanges(workspace, manifest);
	if (changes.created.length + changes.modified.length + changes.missing.length > 0) return;
	const sync = await syncFromOrigin({
		originCwd,
		workspace,
		previous: manifest,
		limits: NON_GIT_MIRROR_LIMITS,
		signal,
	});
	await writeManifest(poolRoot, slotName, sync.manifest);
	const warmed = await readWarmed(container);
	const next: Record<string, string> = {};
	for (const [rel, entry] of Object.entries(sync.manifest.files)) {
		signal?.throwIfAborted();
		const key = `${entry.mirrorSize}:${entry.mirrorMtimeMs}`;
		if (warmed[rel] !== key) await readFileOnce(join(workspace, rel));
		next[rel] = key;
	}
	await fs.writeFile(join(container, WARMED_FILE), JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
}

async function readWarmed(container: string): Promise<Record<string, string>> {
	try {
		const value = JSON.parse(await fs.readFile(join(container, WARMED_FILE), "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Read one mirror file once, in bounded chunks, never following a link. A vanished file is skipped. */
async function readFileOnce(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		if (!(await fs.lstat(path)).isFile()) return;
		handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
		}
	} catch {
		// Unreadable or gone: nothing to warm.
	} finally {
		await handle?.close();
	}
}
