import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushArtifactIndexRefresh, scheduleArtifactIndexRefresh } from "../src/session/artifacts/index-refresh.ts";
import { artifactScope, ensureSessionArtifacts } from "../src/session/artifacts/store.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// The refresh still runs; the spy only records when the tool wrapper asks for it.
vi.mock("../src/session/artifacts/index-refresh.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/session/artifacts/index-refresh.ts")>();
	return { ...actual, scheduleArtifactIndexRefresh: vi.fn(actual.scheduleArtifactIndexRefresh) };
});

describe("derived artifact indexes after apply_patch", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		// The refresh the tool asked for runs off the calling thread; let it finish before its folder goes.
		await flushArtifactIndexRefresh();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (directories.length > 0) {
			const directory = directories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	function tempDirectory(prefix: string): string {
		const directory = mkdtempSync(join(tmpdir(), prefix));
		directories.push(directory);
		return directory;
	}

	it("asks for a refresh of the derived indexes after an apply_patch call, as the wrapper does for edit and write", async () => {
		const project = tempDirectory("myharness-apply-patch-index-project-");
		const dataRoot = tempDirectory("myharness-apply-patch-index-data-");
		// A Session stored under the data root has the artifact scope that the refresh needs.
		const sessionManager = SessionManager.create(project, undefined, undefined, { dataRoot });
		const harness = await createHarness({ sessionManager, initialActiveToolNames: ["apply_patch"] });
		harnesses.push(harness);

		const refresh = vi.mocked(scheduleArtifactIndexRefresh);
		refresh.mockClear();
		const refreshCountsAtToolStart: number[] = [];
		const refreshCountsAtToolEnd: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "apply_patch") {
				refreshCountsAtToolStart.push(refresh.mock.calls.length);
			}
			if (event.type === "tool_execution_end" && event.toolName === "apply_patch") {
				refreshCountsAtToolEnd.push(refresh.mock.calls.length);
			}
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("apply_patch", {
					patch: ["*** Begin Patch", "*** Add File: made.txt", "+hello", "*** End Patch"].join("\n"),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("add a note");

		expect(harness.eventsOfType("tool_execution_end")).toContainEqual(
			expect.objectContaining({ toolName: "apply_patch", isError: false }),
		);
		expect(refreshCountsAtToolStart).toEqual([0]);
		expect(refreshCountsAtToolEnd).toHaveLength(1);
		expect(refreshCountsAtToolEnd[0]).toBeGreaterThan(refreshCountsAtToolStart[0]!);
		expect(refresh.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: expect.any(String),
			sessionId: expect.any(String),
		});
	});

	it("ends a write call before the indexes are touched, and lists the new artifact in them afterwards", async () => {
		const project = tempDirectory("myharness-write-index-project-");
		const dataRoot = tempDirectory("myharness-write-index-data-");
		const sessionManager = SessionManager.create(project, undefined, undefined, { dataRoot });
		const harness = await createHarness({ sessionManager, initialActiveToolNames: ["write"] });
		harnesses.push(harness);
		const scope = artifactScope(sessionManager);
		if (!scope) throw new Error("the session has no artifact scope");
		const note = join(ensureSessionArtifacts(scope), "reports", "note.md");
		const globalIndex = join(dataRoot, "artifacts", "index.json");

		// Bringing the indexes up to date used to happen inside the call, on the server's thread.
		let indexedWhenCallEnded: boolean | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "write") {
				indexedWhenCallEnded = existsSync(globalIndex);
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: note, content: "# note\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write the note");

		expect(harness.eventsOfType("tool_execution_end")).toContainEqual(
			expect.objectContaining({ toolName: "write", isError: false }),
		);
		expect(readFileSync(note, "utf8")).toBe("# note\n");
		expect(indexedWhenCallEnded).toBe(false);
		await flushArtifactIndexRefresh();
		const entries = JSON.parse(readFileSync(globalIndex, "utf8")).entries as { name: string; sessionId: string }[];
		expect(entries.map((entry) => `${entry.sessionId === scope.sessionId}:${entry.name}`)).toEqual([
			"true:reports/note.md",
		]);
	});
});
