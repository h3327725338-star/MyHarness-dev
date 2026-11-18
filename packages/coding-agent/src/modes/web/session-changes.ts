import type { SessionEntry } from "../../session/types.ts";
import type { FileChangeSummary, RunChangeCardFile, RunCommitCard } from "./changes.ts";
import { isDeferredRunChanges, RUN_CHANGES_ENTRY, runChangesToWire } from "./wire.ts";

export interface SessionFileDiff {
	entryId: string;
	runId: number;
	timestamp: string;
	summary: FileChangeSummary;
	patch?: string;
}

/**
 * Index of the last entry that closes a task's changes: a card of the task's last run. The changes a new message cut
 * short (deferred entries) before it are part of that card already; the ones after it belong to a task that is still
 * going on, or that ended without a card (the process stopped), and still count.
 */
export function lastClosingRunChanges(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === RUN_CHANGES_ENTRY && !isDeferredRunChanges(entry.data)) {
			return index;
		}
	}
	return -1;
}

/** Historical changes on the current branch, not a net diff or a claim about uncommitted ownership. */
export function collectSessionChanges(entries: readonly SessionEntry[]): {
	files: FileChangeSummary[];
	diffs: Map<string, SessionFileDiff[]>;
} {
	const files = new Map<string, FileChangeSummary>();
	const diffs = new Map<string, SessionFileDiff[]>();
	const closedAt = lastClosingRunChanges(entries);
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "custom" || entry.customType !== RUN_CHANGES_ENTRY) continue;
		// Held back for a later card that lists these files as well: counting both would count them twice.
		const deferred = isDeferredRunChanges(entry.data);
		if (deferred && index < closedAt) continue;
		const wire = runChangesToWire(
			entry.id,
			Date.parse(entry.timestamp),
			deferred ? { ...(entry.data as object), deferred: undefined } : entry.data,
		);
		if (wire?.kind !== "runChanges") continue;
		const card = entry.data as { files?: RunChangeCardFile[]; commits?: RunCommitCard[] };
		const byPath = new Map<string, { file: (typeof wire.files)[number]; saved: RunChangeCardFile; runId: number }>();
		// Prefer the task's edit diff. For paths only committed, use the latest commit group in that card.
		const addGroup = (files: typeof wire.files, savedFiles: RunChangeCardFile[] | undefined, runId: number) => {
			if (!Array.isArray(savedFiles)) return;
			const savedByPath = new Map<string, RunChangeCardFile>();
			for (const saved of savedFiles) {
				if (saved?.path && !savedByPath.has(saved.path)) savedByPath.set(saved.path, saved);
			}
			for (const file of files) {
				const saved = savedByPath.get(file.path);
				if (saved && !byPath.has(file.path)) byPath.set(file.path, { file, saved, runId });
			}
		};
		addGroup(wire.files, card.files, wire.runId);
		for (const group of (wire.commits ?? []).slice().reverse()) {
			const savedGroup = Array.isArray(card.commits)
				? card.commits.find((saved) => saved?.runId === group.runId)
				: undefined;
			addGroup(group.files, savedGroup?.files, group.runId);
		}
		for (const { file, saved, runId } of byPath.values()) {
			const summary: FileChangeSummary = {
				path: file.path,
				status: saved.status,
				...(file.oldPath ? { oldPath: file.oldPath } : {}),
				additions: file.additions,
				deletions: file.deletions,
				binary: file.binary,
				...(file.unavailable ? { unavailable: file.unavailable } : {}),
				...(saved.patchOmitted
					? { unavailable: "The diff of this file was too large to keep with the chat." }
					: {}),
			};
			const previous = files.get(file.path);
			files.set(file.path, {
				...summary,
				additions: (previous?.additions ?? 0) + summary.additions,
				deletions: (previous?.deletions ?? 0) + summary.deletions,
				binary: !!previous?.binary || summary.binary,
				...(previous?.unavailable || summary.unavailable
					? { unavailable: previous?.unavailable || summary.unavailable }
					: {}),
			});
			const history = diffs.get(file.path) ?? [];
			history.push({
				entryId: entry.id,
				runId,
				timestamp: entry.timestamp,
				summary,
				...(typeof saved.patch === "string" && !saved.patchOmitted ? { patch: saved.patch } : {}),
			});
			diffs.set(file.path, history);
		}
	}
	return { files: [...files.values()], diffs };
}
