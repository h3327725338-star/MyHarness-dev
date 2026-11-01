import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { runGit } from "../../git/repository/command.ts";
import {
	type ChatActivity,
	isWithinTimeSpans,
	mergeTimeSpans,
	mergeWrittenFiles,
	readChatActivity,
	type TimeSpan,
	type WrittenFile,
} from "../../session/artifacts/written-files.ts";
import { mapLimited } from "../../session/memory/store.ts";

/** Why something a chat made stays when the chat's artifacts are deleted. */
export type KeptReason = "changed" | "committed" | "other-chat" | "no-recycle-bin";

export interface ProducedFile {
	path: string;
	/** For a folder, the bytes of all its files. */
	bytes: number;
	/** A folder the chats made and that holds nothing else: it goes as one item. */
	folder?: boolean;
	/** How many files such a folder holds. */
	files?: number;
	kept?: KeptReason;
}

export interface ProducedFiles {
	files: ProducedFile[];
	/** The folders were too big to look through in time: what was not reached simply stays. */
	incomplete: boolean;
}

/** A chat that stays, as far as telling whether it worked at the same time takes. Times are epoch ms. */
export interface OtherChat {
	path: string;
	created: number;
	modified: number;
	/** It is working right now, so what its current tool makes has no entry yet. */
	busy: boolean;
}

/** What the delete dialogs show: what would go, and what stays. The list is capped, the counts are not. */
export interface ProducedFilesSummary {
	files: number;
	bytes: number;
	kept: number;
	/** The rows the list would have without its cap. */
	items: number;
	list: ProducedFile[];
	incomplete?: boolean;
}

/** The part of the desktop channel this needs (undefined outside the desktop app). */
export interface RecycleChannel {
	request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

const LIST_LIMIT = 200;
/** Leeway between a chat's entries and a file's own times: they come from one clock, a file system may round it. */
const SLACK_MS = 2000;
const GIT_NAMES_PER_CALL = 200;
const MAX_ENTRIES = 300_000;
const TIME_LIMIT_MS = 30_000;
/** Holds the app's own settings and state, never a chat's output. */
const NEVER_ENTERED = new Set([".myharness"]);
/** Installed packages: an old one is not looked through, and nothing a chat made sits only there. */
const LEFT_ALONE_WHEN_OLD = new Set(["node_modules", ".venv", "venv", "__pycache__"]);

const isInside = (root: string, file: string) => {
	const inside = relative(root, file);
	return !inside.startsWith("..") && !isAbsolute(inside);
};
const pathKey = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);

/** The app's data: chats and artifacts. A folder made for a Workspace lives there too and is a project like any other. */
const isAppData = (dataRoot: string, file: string) =>
	isInside(dataRoot, file) && !isInside(join(dataRoot, "workspace-folders"), file);

/** A chat at the user's home or a drive's root reaches far more than its work: only what its tools named counts there. */
const isTooWideToSearch = (root: string) => parse(root).root === root || isInside(root, homedir());

/** Which of these files Git tracks. A folder outside any repository tracks none; a Git that did not answer keeps all. */
async function trackedByGit(files: readonly string[]): Promise<Set<string>> {
	const byFolder = new Map<string, string[]>();
	for (const file of files) byFolder.set(dirname(file), [...(byFolder.get(dirname(file)) ?? []), file]);
	const tracked = new Set<string>();
	await mapLimited([...byFolder], 4, async ([folder, list]) => {
		for (let at = 0; at < list.length; at += GIT_NAMES_PER_CALL) {
			const part = list.slice(at, at + GIT_NAMES_PER_CALL);
			const names = part.map((file) => `:(literal)${basename(file)}`);
			const result = await runGit(["ls-files", "-z", "--", ...names], { cwd: folder });
			if (result.failureKind === "timeout" || result.failureKind === "cancelled") {
				for (const file of part) tracked.add(file);
				continue;
			}
			if (!result.ok) continue;
			const listed = new Set(result.stdout.split("\0").map((name) => name.toLowerCase()));
			for (const file of part) if (listed.has(basename(file).toLowerCase())) tracked.add(file);
		}
	});
	return tracked;
}

/**
 * What the chats that stay did while these worked: a file born in that time may be theirs. Chats that ended before this
 * work began or started after it ended take no part, and are not read.
 */
async function readWorkOfOthers(
	runs: readonly TimeSpan[],
	others: readonly OtherChat[],
): Promise<{ runs: TimeSpan[]; files: Set<string> }> {
	const first = runs[0]?.start ?? Number.POSITIVE_INFINITY;
	const last = runs[runs.length - 1]?.end ?? Number.NEGATIVE_INFINITY;
	const met = others.filter(
		(other) => (other.busy || other.modified >= first - SLACK_MS) && other.created <= last + SLACK_MS,
	);
	const activity = await mapLimited(met, 8, async (other) => {
		const chat = await readChatActivity(other.path);
		const running = other.busy && chat.lastEntry !== undefined ? [{ start: chat.lastEntry, end: Date.now() }] : [];
		return { ...chat, toolRuns: [...chat.toolRuns, ...running] };
	});
	return {
		runs: mergeTimeSpans(activity.flatMap((chat) => chat.toolRuns)),
		files: new Set(activity.flatMap((chat) => chat.written.map((file) => pathKey(file.path)))),
	};
}

interface FolderNode {
	path: string;
	parent?: FolderNode;
	bornInRun: boolean;
	/** It holds something that stays, so it cannot go as one item. */
	stays: boolean;
	items: ProducedFile[];
}

/**
 * Look through the chats' folders for what their tools made: files and folders born while a tool ran, or that the write
 * tool reported creating. One level at a time with few requests out, so a big project does not hold the server.
 */
async function searchFolders(
	roots: readonly string[],
	runs: readonly TimeSpan[],
	created: ReadonlyMap<string, WrittenFile>,
	others: { runs: readonly TimeSpan[]; files: ReadonlySet<string> },
	dataRoot: string,
): Promise<{ levels: FolderNode[][]; repositories: string[]; ownRepositories: Set<string>; incomplete: boolean }> {
	const firstRun = runs[0]?.start ?? Number.POSITIVE_INFINITY;
	const inRun = (time: number) => isWithinTimeSpans(runs, time, SLACK_MS);
	const inRunOfOther = (time: number) => isWithinTimeSpans(others.runs, time, SLACK_MS);
	const foldersOfCreated = new Set([...created.values()].map((file) => pathKey(dirname(file.path))));
	const deadline = Date.now() + TIME_LIMIT_MS;
	const levels: FolderNode[][] = [];
	const repositories = [...roots];
	const ownRepositories = new Set<string>();
	let entriesSeen = 0;
	let incomplete = false;
	const overBudget = () => {
		if (entriesSeen <= MAX_ENTRIES && Date.now() <= deadline) return false;
		incomplete = true;
		return true;
	};
	let level: FolderNode[] = roots.map((path) => ({ path, bornInRun: false, stays: false, items: [] }));
	while (level.length > 0) {
		if (overBudget()) {
			for (const folder of level) if (folder.parent) folder.parent.stays = true;
			break;
		}
		const below: FolderNode[] = [];
		const toCheck: Array<{ folder: FolderNode; path: string }> = [];
		const visited: FolderNode[] = [];
		await mapLimited(level, 16, async (folder) => {
			if (overBudget()) {
				if (folder.parent) folder.parent.stays = true;
				return;
			}
			const stats = await lstat(folder.path).catch(() => undefined);
			if (!stats) return;
			folder.bornInRun = inRun(stats.birthtimeMs) && !inRunOfOther(stats.birthtimeMs);
			if (!folder.bornInRun && LEFT_ALONE_WHEN_OLD.has(basename(folder.path))) {
				if (folder.parent) folder.parent.stays = true;
				return;
			}
			const entries = await readdir(folder.path, { withFileTypes: true }).catch(() => undefined);
			if (!entries) {
				if (folder.parent) folder.parent.stays = true;
				return;
			}
			visited.push(folder);
			entriesSeen += entries.length;
			// Adding a file to a folder updates the folder's own time: one untouched since before the first run got no new file.
			const mayHoldNew = stats.mtimeMs >= firstRun - SLACK_MS || foldersOfCreated.has(pathKey(folder.path));
			for (const entry of entries) {
				const path = join(folder.path, entry.name);
				if (entry.name === ".git") {
					const gitDir = entry.isDirectory() ? await lstat(path).catch(() => undefined) : undefined;
					const history = gitDir ? await lstat(join(path, "logs", "HEAD")).catch(() => undefined) : undefined;
					if (
						gitDir &&
						inRun(gitDir.birthtimeMs) &&
						!inRunOfOther(gitDir.birthtimeMs) &&
						(!history || inRun(history.mtimeMs))
					) {
						// A repository the chat itself started, and nobody committed to since: it is the chat's work, like its files.
						ownRepositories.add(pathKey(folder.path));
						folder.items.push({ path, bytes: 0, files: 0, folder: true });
					} else {
						folder.stays = true;
						repositories.push(folder.path);
					}
				} else if (entry.isSymbolicLink() || NEVER_ENTERED.has(entry.name) || isAppData(dataRoot, path)) {
					folder.stays = true;
				} else if (entry.isDirectory()) {
					below.push({ path, parent: folder, bornInRun: false, stays: false, items: [] });
				} else if (!entry.isFile() || !(mayHoldNew || created.has(pathKey(path)))) {
					folder.stays = true;
				} else {
					toCheck.push({ folder, path });
				}
			}
		});
		await mapLimited(toCheck, 32, async ({ folder, path }) => {
			const stats = overBudget() ? undefined : await lstat(path).catch(() => undefined);
			const written = created.get(pathKey(path));
			if (!stats || !(written || inRun(stats.birthtimeMs))) {
				folder.stays = true;
				return;
			}
			const lastOwnChange = written ? written.lastTouched : stats.birthtimeMs;
			const kept: KeptReason | undefined =
				stats.mtimeMs > lastOwnChange + SLACK_MS && !inRun(stats.mtimeMs)
					? "changed"
					: others.files.has(pathKey(path)) || (!written && inRunOfOther(stats.birthtimeMs))
						? "other-chat"
						: undefined;
			folder.items.push(kept ? { path, bytes: stats.size, kept } : { path, bytes: stats.size });
		});
		levels.push(visited);
		level = below;
	}
	return { levels, repositories, ownRepositories, incomplete };
}

/** Mark what Git tracks in these repositories. A Git that did not answer keeps everything below the folder it was asked about. */
async function keepTracked(
	levels: readonly FolderNode[][],
	repositories: readonly string[],
	ownRepositories: ReadonlySet<string>,
): Promise<void> {
	const files = levels.flat().flatMap((folder) => folder.items.filter((item) => !item.folder && !item.kept));
	if (files.length === 0) return;
	const tracked = new Set<string>();
	const unanswered: string[] = [];
	const asked = [...new Set(repositories)].filter((folder) => !ownRepositories.has(pathKey(folder)));
	await mapLimited(asked, 4, async (folder) => {
		const result = await runGit(["ls-files", "-z"], { cwd: folder, timeoutMs: 30_000 });
		if (result.ok) {
			for (const name of result.stdout.split("\0")) if (name) tracked.add(pathKey(resolve(folder, name)));
		} else if (result.failureKind !== "exit") unanswered.push(folder);
	});
	for (const file of files)
		if (tracked.has(pathKey(file.path)) || unanswered.some((folder) => isInside(folder, file.path)))
			file.kept = "committed";
}

/**
 * What these chats made and that is still there, outside the app's data. Deleting their artifacts takes it, except what
 * someone changed after the chats last did (it is no longer only their work), what Git tracks (it became part of the
 * project), what may be the work of a chat that stays, and everything when no Recycle Bin can be reached. A folder made
 * by the chats that holds nothing else goes as one item.
 */
export async function findProducedFiles(
	chats: readonly ChatActivity[],
	options: { dataRoot: string; canRecycle: boolean; others?: readonly OtherChat[] },
): Promise<ProducedFiles> {
	const { dataRoot, canRecycle } = options;
	const runs = mergeTimeSpans(chats.flatMap((chat) => chat.toolRuns));
	const written = mergeWrittenFiles(chats.map((chat) => chat.written));
	const created = new Map(
		written
			.filter((file) => file.created && !isAppData(dataRoot, file.path))
			.map((file) => [pathKey(file.path), file]),
	);
	const hasWork = (chat: ChatActivity) => chat.toolRuns.length > 0 || chat.written.some((file) => file.created);
	const candidates = [
		...new Set(chats.filter(hasWork).flatMap((chat) => (chat.cwd ? [resolve(chat.cwd)] : []))),
	].filter((root) => !isAppData(dataRoot, root) && !isTooWideToSearch(root));
	// A chat below another chat's folder is looked through with it.
	const roots = candidates.filter((root) => !candidates.some((other) => other !== root && isInside(other, root)));
	const others = await readWorkOfOthers(runs, options.others ?? []);
	const { levels, repositories, ownRepositories, incomplete } = await searchFolders(
		roots,
		runs,
		created,
		others,
		dataRoot,
	);
	await keepTracked(levels, repositories, ownRepositories);

	const found: ProducedFile[] = [];
	for (let depth = levels.length - 1; depth >= 0; depth--) {
		for (const folder of levels[depth]!) {
			if (folder.parent && folder.bornInRun && !folder.stays && !folder.items.some((item) => item.kept)) {
				folder.parent.items.push({
					path: folder.path,
					bytes: folder.items.reduce((sum, item) => sum + item.bytes, 0),
					files: folder.items.reduce((sum, item) => sum + (item.folder ? (item.files ?? 0) : 1), 0),
					folder: true,
				});
			} else {
				found.push(...folder.items);
				if (folder.parent) folder.parent.stays = true;
			}
		}
	}

	// What the write tool created elsewhere: a chat can name any path.
	const outside = [...created.values()].filter((file) => !roots.some((root) => isInside(root, file.path)));
	const stats = await mapLimited(outside, 16, (file) => lstat(file.path).catch(() => undefined));
	const existing = outside.flatMap((file, index) => {
		const stat = stats[index];
		if (!stat?.isFile()) return [];
		const changed = stat.mtimeMs > file.lastTouched + SLACK_MS && !isWithinTimeSpans(runs, stat.mtimeMs, SLACK_MS);
		return [{ file, bytes: stat.size, changed }];
	});
	const tracked = await trackedByGit(existing.filter((item) => !item.changed).map((item) => item.file.path));
	for (const { file, bytes, changed } of existing) {
		const kept: KeptReason | undefined = changed
			? "changed"
			: tracked.has(file.path)
				? "committed"
				: others.files.has(pathKey(file.path))
					? "other-chat"
					: undefined;
		found.push(kept ? { path: file.path, bytes, kept } : { path: file.path, bytes });
	}

	const sorted = found.sort((a, b) => a.path.localeCompare(b.path));
	return {
		files: canRecycle ? sorted : sorted.map((file) => (file.kept ? file : { ...file, kept: "no-recycle-bin" })),
		incomplete,
	};
}

export function summarizeProducedFiles({ files, incomplete }: ProducedFiles): ProducedFilesSummary {
	const going = files.filter((file) => !file.kept);
	return {
		files: going.reduce((sum, file) => sum + (file.folder ? (file.files ?? 0) : 1), 0),
		bytes: going.reduce((sum, file) => sum + file.bytes, 0),
		kept: files.reduce((sum, file) => sum + (file.kept ? 1 : 0), 0),
		items: files.length,
		// What goes comes first: the list is there to show what the switch does.
		list: [...going, ...files.filter((file) => file.kept)].slice(0, LIST_LIMIT),
		...(incomplete ? { incomplete } : {}),
	};
}

/**
 * Move files and folders to the Recycle Bin through the desktop host and return the ones still in place, whatever the
 * host answered: what stays is safe, it is only reported. Without a host nothing moves.
 */
export async function recycleProducedFiles(
	paths: readonly string[],
	channel: RecycleChannel | undefined,
): Promise<string[]> {
	if (paths.length === 0) return [];
	if (!channel) return [...paths];
	await channel
		.request({ channel: "recycle", action: "recycle", paths }, 30_000 + paths.length * 1000)
		.catch(() => undefined);
	const stillThere = await mapLimited(paths, 16, async (file) => {
		try {
			await lstat(file);
			return true;
		} catch {
			return false;
		}
	});
	return paths.filter((_, index) => stillThere[index]);
}
