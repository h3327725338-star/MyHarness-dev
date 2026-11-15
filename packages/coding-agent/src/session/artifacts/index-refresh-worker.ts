import { parentPort, workerData } from "node:worker_threads";
import { type IndexRefreshJob, runIndexRefreshJob } from "./store.ts";

// One job per worker (see index-refresh.ts): the derived artifact indexes are read, merged and written here, so the
// server's own thread never waits for them.
const port = parentPort;
if (!port) {
	throw new Error("artifact index worker requires parentPort");
}
// Said before the work starts: a worker that got this far could be loaded, so a failure after it is the job's own.
port.postMessage({ ready: true });
port.postMessage({ answer: runIndexRefreshJob(workerData as IndexRefreshJob) });
