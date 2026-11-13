import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, nowIso, readJsonFile, sha256, shortHash, writeJsonFile } from "./util.ts";

/**
 * The last content both devices had for a memory.
 *
 * A three-way merge needs the common ancestor; without it, two independent edits can only be appended, which loses the
 * document structure. This store keeps that ancestor per key. It is written only when a version is committed (applied
 * from another device or published from here), so it always describes a version both sides have seen.
 *
 * Everything lives below the agent directory, one content file per hash, and is never uploaded.
 *
 * The index is one file for every key. It is written at most about once a second (and by `flush()`), not after every
 * change: a download of a thousand memories used to rewrite and fsync it a thousand times, which held the server's
 * event loop for seconds. An index entry lost to a crash only means that memory has no ancestor for its next merge.
 */

interface StoredBase {
	hash: string;
	file: string;
	at: string;
}

interface BaseIndex {
	version: 1;
	entries: Record<string, StoredBase>;
}

const INDEX_VERSION = 1;
const MAX_ENTRIES = 2000;
const SAVE_DELAY_MS = 1000;

export class MemoryBaseStore {
	private readonly dir: string;
	private readonly indexPath: string;
	private index: BaseIndex | undefined;
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirReady = false;

	constructor(dir: string) {
		this.dir = dir;
		this.indexPath = join(dir, "index.json");
	}

	private load(): BaseIndex {
		if (this.index) return this.index;
		const stored = readJsonFile<BaseIndex>(this.indexPath);
		this.index =
			stored && stored.version === INDEX_VERSION && stored.entries && typeof stored.entries === "object"
				? { version: INDEX_VERSION, entries: stored.entries }
				: { version: INDEX_VERSION, entries: {} };
		return this.index;
	}

	private save(): void {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
		this.timer.unref?.();
	}

	/** Write the index now if it changed. Called at the end of a pass and when the engine stops. */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.dirty) return;
		this.dirty = false;
		try {
			this.prepareDir();
			writeJsonFile(this.indexPath, this.load());
		} catch {
			// A read-only agent directory must not stop a pass; the index is rebuilt from what is committed next.
		}
	}

	private prepareDir(): void {
		if (this.dirReady) return;
		ensureDir(this.dir);
		this.dirReady = true;
	}

	get(key: string): { hash: string; text: string } | undefined {
		const entry = this.load().entries[key];
		if (!entry) return undefined;
		try {
			return { hash: entry.hash, text: readFileSync(join(this.dir, entry.file), "utf8") };
		} catch {
			delete this.load().entries[key];
			this.save();
			return undefined;
		}
	}

	set(key: string, text: string): void {
		const index = this.load();
		const bytes = Buffer.from(text, "utf8");
		const hash = sha256(new Uint8Array(bytes));
		if (index.entries[key]?.hash === hash) return;
		const file = `${hash}.txt`;
		const target = join(this.dir, file);
		try {
			this.prepareDir();
			const temporary = join(this.dir, `${hash}.${process.pid}.tmp`);
			writeFileSync(temporary, bytes);
			renameSync(temporary, target);
		} catch {
			this.dirReady = false;
			// A read-only agent directory must not stop the merge; the next pass simply has no base.
			return;
		}
		const previous = index.entries[key];
		if (previous && previous.file !== file) rmSync(join(this.dir, previous.file), { force: true });
		index.entries[key] = { hash, file, at: nowIso() };
		this.prune(index);
		this.save();
	}

	remove(key: string): void {
		const index = this.load();
		const entry = index.entries[key];
		if (!entry) return;
		delete index.entries[key];
		rmSync(join(this.dir, entry.file), { force: true });
		this.save();
	}

	private prune(index: BaseIndex): void {
		const entries = Object.entries(index.entries);
		if (entries.length <= MAX_ENTRIES) return;
		entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
		for (const [key, entry] of entries.slice(0, entries.length - MAX_ENTRIES)) {
			delete index.entries[key];
			rmSync(join(this.dir, entry.file), { force: true });
		}
	}
}

/** Per-account directory so two Google accounts never share an ancestor. */
export function memoryBaseDir(syncDir: string, accountKey: string): string {
	return join(syncDir, `bases-${shortHash(accountKey)}`);
}
