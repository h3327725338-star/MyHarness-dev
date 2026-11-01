import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionDir, getWorkspaceSessionsDir, parseSessionDataPath } from "../../config/paths/index.ts";
import { deleteWorkspaceArtifacts } from "../../session/artifacts/store.ts";
import { readChatActivity } from "../../session/artifacts/written-files.ts";
import {
	chatsWithMemories,
	deleteSessionMemories,
	deleteWorkspaceMemories,
	describeWorkspaceMemories,
	mapLimited,
	type WorkspaceMemoryChat,
	withMemoryLock,
} from "../../session/memory/store.ts";
import {
	countSessionFolderFiles,
	deleteLeftoverSessionFolder,
	deleteSessionFile,
	readSessionMemoryProvenance,
} from "../../session/storage/jsonl/file-operations.ts";
import {
	findProducedFiles,
	type OtherChat,
	type ProducedFilesSummary,
	type RecycleChannel,
	recycleProducedFiles,
	summarizeProducedFiles,
} from "./produced-files.ts";

/** The Workspace being removed from one chat mode, and that mode's chats. */
export interface WorkspaceRemovalTarget {
	dataRoot: string;
	workspaceId: string;
	chatPaths: readonly string[];
	/** The Workspace stays in the other mode or holds chats of it: only what belongs to these chats may go. */
	sharedWithOtherMode: boolean;
	/** The chats that stay around this folder: what they may have made does not go. */
	others: readonly OtherChat[];
}

/** What the "Remove workspace?" dialog shows before anything happens. */
export interface WorkspaceRemovalSummary {
	chats: number;
	artifacts: { files: number; bytes: number };
	history: { uploads: { files: number; bytes: number }; toolResults: { files: number; bytes: number } };
	writtenFiles: ProducedFilesSummary;
	memories: {
		owned: Array<{ id: string; name: string; scope: "global" | "workspace" | "session" }>;
		shared: number;
		retired: number;
	};
}

/** The removal stopped: nothing was deleted when `deletedChats` is 0 and it is about memories or an open file. */
export class WorkspaceRemovalError extends Error {
	readonly code: "in-use" | "memory-busy" | undefined;
	readonly deletedChats: number;

	constructor(message: string, code: "in-use" | "memory-busy" | undefined, deletedChats: number) {
		super(message);
		this.code = code;
		this.deletedChats = deletedChats;
	}
}

const addCounts = (parts: ReadonlyArray<{ files: number; bytes: number }>) =>
	parts.reduce((sum, part) => ({ files: sum.files + part.files, bytes: sum.bytes + part.bytes }), {
		files: 0,
		bytes: 0,
	});

const IN_USE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function chatsOf(target: WorkspaceRemovalTarget): Array<{ path: string; sessionId: string }> {
	return target.chatPaths.flatMap((path) => {
		const scope = parseSessionDataPath(path);
		return scope ? [{ path, sessionId: scope.sessionId }] : [];
	});
}

async function readMemoryChats(
	chats: ReadonlyArray<{ path: string; sessionId: string }>,
): Promise<WorkspaceMemoryChat[]> {
	return mapLimited(chats, 8, async ({ path, sessionId }) => ({
		sessionId,
		provenance: await readSessionMemoryProvenance(path),
	}));
}

/**
 * The numbers behind the dialog, read with asynchronous I/O only. Folders of chats deleted earlier that kept their
 * artifacts count too, because deleting a Workspace's artifacts takes them.
 */
export async function summarizeWorkspaceRemoval(
	target: WorkspaceRemovalTarget,
	options: { canRecycle: boolean },
): Promise<WorkspaceRemovalSummary> {
	const { dataRoot, workspaceId, chatPaths, sharedWithOtherMode } = target;
	const chats = chatsOf(target);
	const folders = sharedWithOtherMode
		? chats.map(({ sessionId }) => getSessionDir(dataRoot, workspaceId, sessionId))
		: await readdir(getWorkspaceSessionsDir(dataRoot, workspaceId), { withFileTypes: true }).then(
				(entries) =>
					entries
						.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
						.map((entry) => getSessionDir(dataRoot, workspaceId, entry.name)),
				() => [],
			);
	const [activity, counts, memoryChats] = await Promise.all([
		mapLimited(chatPaths, 8, readChatActivity),
		mapLimited(folders, 16, countSessionFolderFiles),
		readMemoryChats(chats),
	]);
	const [produced, memories] = await Promise.all([
		findProducedFiles(activity, { dataRoot, canRecycle: options.canRecycle, others: target.others }),
		describeWorkspaceMemories(dataRoot, workspaceId, memoryChats, !sharedWithOtherMode),
	]);
	return {
		chats: chatPaths.length,
		artifacts: addCounts(counts.map((count) => count.artifacts)),
		// Uploads and tool results stay only for copies of a chat that may still use them, and none is left of a whole Workspace.
		history: sharedWithOtherMode
			? {
					uploads: addCounts(counts.map((count) => count.history.uploads)),
					toolResults: addCounts(counts.map((count) => count.history.toolResults)),
				}
			: { uploads: { files: 0, bytes: 0 }, toolResults: { files: 0, bytes: 0 } },
		writtenFiles: summarizeProducedFiles(produced),
		memories: {
			owned: memories.owned.map(({ id, name, scope }) => ({ id, name, scope })),
			shared: memories.shared,
			retired: memories.retired,
		},
	};
}

/**
 * Delete what the user switched on, before the Workspace is unregistered; returns the files that could not go to the
 * Recycle Bin. Memories go first because their lock is the likeliest refusal, and then nothing has changed yet. Chats go
 * one at a time, each all-or-nothing: on a refusal the ones already deleted stay deleted, the rest stay as they were, the
 * Workspace stays listed and the user can try again.
 */
export async function removeWorkspaceData(
	target: WorkspaceRemovalTarget,
	options: {
		deleteChats: boolean;
		deleteArtifacts: boolean;
		deleteMemory: boolean;
		channel: RecycleChannel | undefined;
		onChatDeleted?: (path: string) => Promise<void>;
	},
): Promise<string[]> {
	const { dataRoot, workspaceId, chatPaths, sharedWithOtherMode } = target;
	const { deleteChats, deleteArtifacts, deleteMemory, channel } = options;
	const chats = chatsOf(target);
	const wholeWorkspace = !sharedWithOtherMode;
	// Read while the chats are still in place.
	const produced = deleteArtifacts
		? (
				await findProducedFiles(await mapLimited(chatPaths, 8, readChatActivity), {
					dataRoot,
					canRecycle: channel !== undefined,
					others: target.others,
				})
			).files
		: [];
	const memoryChats = deleteMemory ? await readMemoryChats(chats) : [];
	const withMemories = deleteMemory
		? await chatsWithMemories(dataRoot, workspaceId, memoryChats, wholeWorkspace)
		: new Set();
	if (deleteMemory) {
		try {
			await withMemoryLock(dataRoot, async () => {
				if (!deleteChats) {
					for (const chat of memoryChats) {
						if (!withMemories.has(chat.sessionId)) continue;
						await deleteSessionMemories(dataRoot, { workspaceId, sessionId: chat.sessionId }, chat.provenance, {
							keepCursor: true,
						});
					}
				}
				await deleteWorkspaceMemories(dataRoot, workspaceId, { wholeWorkspace, forgetSessionIds: [] });
			});
		} catch (error) {
			const busy = (error as NodeJS.ErrnoException)?.code === "ELOCKED";
			throw new WorkspaceRemovalError(
				error instanceof Error ? error.message : String(error),
				busy ? "memory-busy" : undefined,
				0,
			);
		}
	}
	if (deleteArtifacts) {
		try {
			deleteWorkspaceArtifacts(
				dataRoot,
				workspaceId,
				sharedWithOtherMode ? chats.map((chat) => chat.sessionId) : undefined,
			);
		} catch (error) {
			const inUse = IN_USE_CODES.has((error as NodeJS.ErrnoException)?.code ?? "");
			throw new WorkspaceRemovalError(
				error instanceof Error ? error.message : String(error),
				inUse ? "in-use" : undefined,
				0,
			);
		}
	}
	if (deleteChats) {
		let deletedChats = 0;
		for (const path of chatPaths) {
			const sessionId = parseSessionDataPath(path)?.sessionId;
			const deleted = await deleteSessionFile(path, {
				permanent: true,
				deleteArtifacts,
				deleteMemory: deleteMemory && sessionId !== undefined && withMemories.has(sessionId),
				deleteAttachments: wholeWorkspace,
				artifactsIndexed: true,
			});
			if (!deleted.ok)
				throw new WorkspaceRemovalError(deleted.error ?? "Failed to delete the chat.", deleted.code, deletedChats);
			deletedChats++;
			await options.onChatDeleted?.(path);
			// Hundreds of chats may go in one request: the server answers other requests in between.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		if (wholeWorkspace) {
			// What chats deleted one by one left behind has no chat to go with any more.
			const sessions = getWorkspaceSessionsDir(dataRoot, workspaceId);
			const folders = await readdir(sessions, { withFileTypes: true }).catch(() => []);
			await mapLimited(
				folders.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()),
				8,
				(entry) => deleteLeftoverSessionFolder(join(sessions, entry.name), { deleteArtifacts, deleteMemory }),
			);
		}
		if (deleteMemory) {
			// The chats are gone either way; leftover bookkeeping does no harm and is cleaned by the next deletion.
			await withMemoryLock(dataRoot, () =>
				deleteWorkspaceMemories(dataRoot, workspaceId, {
					wholeWorkspace: false,
					forgetSessionIds: chats.map((chat) => chat.sessionId),
				}),
			).catch(() => undefined);
		}
	}
	return recycleProducedFiles(
		produced.filter((file) => !file.kept).map((file) => file.path),
		channel,
	);
}
