/**
 * Keeps the derived artifact indexes up to date after tool calls without making a tool call, or anything else the
 * server does, wait for it.
 *
 * The indexes list every artifact of the data root (`data/artifacts/index.json` and `README.md`, and the same two files
 * per Workspace). Bringing one session's entries up to date reads the global index, merges and sorts it, and writes all
 * four files again when they differ. That used to run on the server's thread right after every write, edit, patch and
 * shell call: on a data root with 252,000 artifacts (a 147 MB index and a 109 MB README) each such call froze every
 * chat for 4 to 8 seconds, and far longer when the disk was busy.
 *
 * Now a tool call only names its session here. The requests of a short while are gathered and done together in a
 * worker thread, one job at a time and not more often than every REFRESH_MIN_GAP_MS. Nothing reads these files to
 * decide anything: the artifact views list the folders themselves, so a few seconds of delay changes nothing visible.
 */
import { Worker } from "node:worker_threads";
import type { SessionDataPathInfo } from "../../config/paths/index.ts";
import {
	type IndexRefreshAnswer,
	type IndexRefreshJob,
	knownArtifactSignature,
	noteArtifactSignature,
	runIndexRefreshJob,
	sessionArtifactKey,
} from "./store.ts";

/** Tool calls come in bursts: the sessions named within this time are refreshed in one job. */
const REFRESH_DELAY_MS = 2_000;
/** A job that finds changes rewrites the whole global index, so jobs start at least this far apart. */
const REFRESH_MIN_GAP_MS = 20_000;

const pending = new Map<string, SessionDataPathInfo>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let lastStartedAt = 0;
/** No worker could be started in this process (some packaged layouts): the work runs on this thread instead. */
let workerUnavailable = false;

/** Asks for one session's entries in the derived indexes to be brought up to date soon. Never waits, never throws. */
export function scheduleArtifactIndexRefresh(scope: SessionDataPathInfo): void {
	pending.set(sessionArtifactKey(scope), scope);
	arm();
}

function arm(): void {
	if (timer || running || pending.size === 0) return;
	const wait = Math.max(REFRESH_DELAY_MS, lastStartedAt + REFRESH_MIN_GAP_MS - Date.now());
	timer = setTimeout(() => {
		timer = undefined;
		void start();
	}, wait);
	// A refresh still owed must not keep the process alive: the next tool call of the session asks again.
	timer.unref?.();
}

function start(): Promise<void> {
	if (running) return running;
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	const sessions = [...pending].map(([key, scope]) => ({ key, scope, known: knownArtifactSignature(key) }));
	pending.clear();
	if (sessions.length === 0) return Promise.resolve();
	lastStartedAt = Date.now();
	const job: IndexRefreshJob = { sessions: sessions.map(({ scope, known }) => ({ scope, known })) };
	const warn = (reason: unknown) =>
		console.warn(
			"[artifacts] Could not refresh derived indexes:",
			reason instanceof Error ? reason.message : String(reason),
		);
	const run: Promise<void> = execute(job)
		.then((answer) => {
			answer.signatures.forEach((signature, index) => {
				if (signature !== undefined) noteArtifactSignature(sessions[index]!.key, signature);
			});
			if (answer.error) warn(answer.error);
		})
		.catch(warn)
		.finally(() => {
			if (running === run) running = undefined;
			arm();
		});
	running = run;
	return run;
}

/** A worker that was loaded and then failed at its job (out of memory on a very large index, say). */
class IndexWorkerFailed extends Error {}

async function execute(job: IndexRefreshJob): Promise<IndexRefreshAnswer> {
	if (!workerUnavailable) {
		try {
			return await runInWorker(job);
		} catch (error) {
			// The job itself failed off this thread. Doing it again here would freeze the server for as long, and fail
			// the same way: the indexes stay as they are, and the sessions' next tool calls ask again.
			if (error instanceof IndexWorkerFailed)
				return { signatures: job.sessions.map(() => undefined), error: error.message };
			workerUnavailable = true;
		}
	}
	// The same work on this thread, once what is running now has finished.
	await new Promise<void>((resolve) => setImmediate(resolve));
	return runIndexRefreshJob(job);
}

function runInWorker(job: IndexRefreshJob): Promise<IndexRefreshAnswer> {
	// A Bun compiled executable finds an embedded worker by its source path, not through import.meta.url.
	const specifier: string | URL =
		typeof process.versions.bun === "string"
			? "./src/session/artifacts/index-refresh-worker.ts"
			: new URL(
					import.meta.url.endsWith(".ts") ? "./index-refresh-worker.ts" : "./index-refresh-worker.js",
					import.meta.url,
				);
	return new Promise((resolve, reject) => {
		const worker = new Worker(specifier, { workerData: job });
		worker.unref();
		let settled = false;
		// Whether the worker's code could be loaded at all; only one that could not is replaced by this thread.
		let loaded = false;
		const settle = (finish: () => void) => {
			if (settled) return;
			settled = true;
			finish();
			void worker.terminate().catch(() => undefined);
		};
		const failed = (reason: string) => (loaded ? new IndexWorkerFailed(reason) : new Error(reason));
		worker.on("message", (message: { ready?: boolean; answer?: IndexRefreshAnswer }) => {
			if (message?.ready) loaded = true;
			else if (message?.answer) settle(() => resolve(message.answer as IndexRefreshAnswer));
		});
		worker.once("error", (error) =>
			settle(() => reject(failed(error instanceof Error ? error.message : String(error)))),
		);
		worker.once("exit", (code) => settle(() => reject(failed(`artifact index worker exited with code ${code}`))));
	});
}

/** Settles once everything asked for so far is in the indexes. For tests and an orderly shutdown. */
export async function flushArtifactIndexRefresh(): Promise<void> {
	while (running || pending.size > 0) await (running ?? start());
}
