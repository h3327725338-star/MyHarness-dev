#!/usr/bin/env node
/**
 * Process entry point for the local Web UI and internal delegated workers.
 * Development: node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";
import { configureHttpDispatcher } from "./platform/process/http-dispatcher.ts";

process.title = APP_NAME;
process.env.MYHARNESS_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const args = process.argv.slice(2);
if (args[0] === "--internal-delegated-worker") {
	// A worker is done when its task is, and its parent waits for the process to end. Whatever is still open then (the
	// local endpoint or the timers of a provider extension, a pipe to a program it started) must not keep the process
	// alive, so it exits by itself once its last line is written.
	const end = (code: number, message?: string) => {
		process.exitCode = code;
		process.stderr.write(message ? `${message}\n` : "", () => process.exit(code));
	};
	void import("./agent/delegation/worker.ts")
		.then(({ runDelegatedWorker }) => runDelegatedWorker(args.slice(1)))
		.then(
			() => end(typeof process.exitCode === "number" ? process.exitCode : 0),
			(error) => end(1, error instanceof Error ? error.message : String(error)),
		);
} else {
	void main(args).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
