import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionDir, getWorkspaceMetadataPath, UNBOUND_WORKSPACE_ID } from "../src/config/paths/index.ts";
import { ModeStateStore } from "../src/session/mode-state.ts";
import { scanLocalEntities, scanLocalEntitiesAsync } from "../src/sync/scope.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/** A Data root with one General Workspace of `sessions` chats; each has an open writer lock and an artifact. */
function library(sessions: number) {
	const root = mkdtempSync(join(tmpdir(), "mh-sync-scan-"));
	roots.push(root);
	const dataRoot = join(root, "data");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const workspace = "ws-general";
	write(
		getWorkspaceMetadataPath(dataRoot, workspace),
		JSON.stringify({ workspace: { workspaceId: workspace, name: "General", modes: ["general"] } }),
	);
	for (let index = 0; index < sessions; index++) {
		const id = `session-${index}`;
		const conversation = join(getSessionDir(dataRoot, workspace, id), "conversation", `${id}.jsonl`);
		write(
			conversation,
			`${JSON.stringify({ type: "session", id, mode: "general", timestamp: "2026-10-24", cwd: root })}\n`,
		);
		write(`${conversation}.lock.owner`, JSON.stringify({ pid: 1, token: "t" }));
		mkdirSync(`${conversation}.lock`);
		write(join(getSessionDir(dataRoot, workspace, id), "artifacts", "note.txt"), `note ${index}`);
	}
	const modeState = new ModeStateStore(agentDir);
	return { dataRoot, agentDir, modeState };
}

describe("sync scope scan", () => {
	it("finds the same entities in slices as in one pass, and never a writer lock", async () => {
		const options = library(40);
		const whole = scanLocalEntities(options);
		const sliced = await scanLocalEntitiesAsync(options, 0);
		expect([...sliced.keys()].sort()).toEqual([...whole.keys()].sort());
		const keys = [...whole.keys()];
		expect(keys.filter((key) => key.startsWith("session:"))).toHaveLength(40);
		expect(keys.filter((key) => key.endsWith("note.txt"))).toHaveLength(40);
		expect(keys.some((key) => /\.lock/u.test(key))).toBe(false);
	});

	it("finds the same local file versions without reading unrelated session headers", async () => {
		const options = library(4);
		const session = getSessionDir(options.dataRoot, "ws-general", "session-1");
		const file = process.platform === "win32" ? "note.txt" : "note:local.txt";
		write(join(session, "artifacts", file), "unpublished update");
		const key = `file:workspaces/ws-general/sessions/session-1/artifacts/${file}`;
		const dataRoot = relative(process.cwd(), options.dataRoot);
		const whole = scanLocalEntities({ ...options, dataRoot });
		const headerCache = new Map();
		const selected = await scanLocalEntitiesAsync({ ...options, dataRoot, keys: new Set([key]), headerCache }, 0);
		expect(whole.has(key)).toBe(true);
		expect(selected.get(key)).toEqual(whole.get(key));
		expect([...headerCache.keys()]).toEqual([join(session, "conversation", "session-1.jsonl")]);
		expect([...selected.keys()].filter((name) => name.startsWith("file:"))).toEqual([key]);
	});

	it("includes the General chats of the default group, which has no Workspace, but not its Coding chats", () => {
		const options = library(0);
		const chat = (id: string, mode: "general" | "coding") => {
			const session = getSessionDir(options.dataRoot, UNBOUND_WORKSPACE_ID, id);
			write(
				join(session, "conversation", `${id}.jsonl`),
				`${JSON.stringify({ type: "session", id, mode, timestamp: "2026-11-05", cwd: "C:/elsewhere/default-workspace" })}\n`,
			);
			write(join(session, "artifacts", "report.md"), `report ${id}`);
		};
		chat("plain", "general");
		chat("repo", "coding");
		const keys = [...scanLocalEntities(options).keys()];
		expect(keys).toContain(`session:${UNBOUND_WORKSPACE_ID}/plain`);
		expect(keys).toContain(`file:workspaces/${UNBOUND_WORKSPACE_ID}/sessions/plain/artifacts/report.md`);
		expect(keys).not.toContain(`session:${UNBOUND_WORKSPACE_ID}/repo`);
		expect(keys.some((key) => key.includes("/sessions/repo/"))).toBe(false);
		// It is a group, not a Workspace: no Workspace record names it.
		expect(keys).not.toContain(`workspace:${UNBOUND_WORKSPACE_ID}`);
	});
});
