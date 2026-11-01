import * as fs from "node:fs";
import { flushSessionWrites } from "./write-batch.ts";

const CHUNK_BYTES = 1024 * 1024;
// Lines longer than this (pasted files, images) are skipped unread: the results looked for are a few hundred bytes.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// An entry's time, role and tool name come first; a tool call id is the longest thing before them.
const HEAD_BYTES = 640;

/** What a chat file's first line says about the chat. */
export interface SessionFileHeader {
	/** The chat's header time, epoch ms. Forks and worktree copies carry their parent's entries with older time stamps. */
	time?: number;
	cwd?: string;
}

/**
 * Read a chat file as bytes in chunks and hand over regions of whole lines. `from` is where the lines of a region start
 * (past the header in the first one). `onTooLong` gets the start of a line that is skipped unread.
 */
async function readSessionLines(
	sessionPath: string,
	onRegion: (region: Buffer, from: number, header: SessionFileHeader) => void,
	onTooLong?: (start: Buffer, header: SessionFileHeader) => void,
): Promise<void> {
	flushSessionWrites(sessionPath);
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(sessionPath, "r");
	} catch {
		return;
	}
	try {
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let carry = Buffer.alloc(0);
		const header: SessionFileHeader = {};
		let headerRead = false;
		let skipping = false;
		const scan = (region: Buffer) => {
			let from = 0;
			if (!headerRead) {
				const end = region.indexOf(10);
				const first = region.subarray(0, end < 0 ? region.length : end).toString("utf8");
				try {
					const parsed = JSON.parse(first) as { type?: unknown; timestamp?: unknown; cwd?: unknown };
					if (parsed?.type === "session") {
						const time = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
						if (Number.isFinite(time)) header.time = time;
						if (typeof parsed.cwd === "string") header.cwd = parsed.cwd;
					}
				} catch {
					// No usable header: no entry is treated as inherited.
				}
				headerRead = true;
				from = end < 0 ? region.length : end + 1;
			}
			onRegion(region, from, header);
		};
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			let data = chunk.subarray(0, bytesRead);
			if (skipping) {
				const newline = data.indexOf(10);
				if (newline < 0) continue;
				data = data.subarray(newline + 1);
				skipping = false;
			}
			const joined = carry.length ? Buffer.concat([carry, data]) : data;
			const last = joined.lastIndexOf(10);
			if (last >= 0) scan(joined.subarray(0, last));
			carry = Buffer.from(joined.subarray(last + 1));
			if (carry.length > MAX_LINE_BYTES) {
				headerRead = true;
				onTooLong?.(carry, header);
				carry = Buffer.alloc(0);
				skipping = true;
			}
		}
		if (carry.length && !skipping) scan(carry);
	} catch {
		// An unreadable history proves nothing: keep what was found so far.
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Call `onLine` for each line of a chat file that holds one of `needles`. The file is scanned as bytes: only those lines
 * are decoded. Finds nothing when the file does not exist; a read that fails midway keeps what was already reported.
 */
export async function scanSessionLines(
	sessionPath: string,
	needles: readonly Buffer[],
	onLine: (line: string, header: SessionFileHeader) => void,
): Promise<void> {
	await readSessionLines(sessionPath, (region, start, header) => {
		let from = start;
		// Each needle's next hit is looked up again only once the scan has passed it.
		const next = needles.map((needle) => region.indexOf(needle, from));
		for (;;) {
			const hit = next.reduce((first, at) => (at >= 0 && (first < 0 || at < first) ? at : first), -1);
			if (hit < 0) break;
			const lineStart = region.lastIndexOf(10, hit) + 1;
			const stop = region.indexOf(10, hit);
			const end = stop < 0 ? region.length : stop;
			onLine(region.subarray(lineStart, end).toString("utf8"), header);
			from = end + 1;
			for (let index = 0; index < next.length; index++)
				if (next[index]! >= 0 && next[index]! < from) next[index] = region.indexOf(needles[index]!, from);
		}
	});
}

/**
 * Call `onLine` for every line after the header, in order: `head` is the line's start as text, enough for the fields an
 * entry serializes first (its time, role and tool), and `line` the whole line as bytes, undefined when it is too long to
 * hold. Nothing else is decoded.
 */
export async function scanSessionLineHeads(
	sessionPath: string,
	onLine: (head: string, line: Buffer | undefined, header: SessionFileHeader) => void,
): Promise<void> {
	await readSessionLines(
		sessionPath,
		(region, start, header) => {
			let from = start;
			while (from < region.length) {
				const stop = region.indexOf(10, from);
				const end = stop < 0 ? region.length : stop;
				const line = region.subarray(from, end);
				onLine(line.toString("utf8", 0, Math.min(HEAD_BYTES, line.length)), line, header);
				from = end + 1;
			}
		},
		(start, header) => onLine(start.toString("utf8", 0, HEAD_BYTES), undefined, header),
	);
}
