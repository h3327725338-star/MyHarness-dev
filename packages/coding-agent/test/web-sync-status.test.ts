import { describe, expect, it } from "vitest";

const { agoText, deriveSync, etaText, massDeleteText, progressText, summaryLine, syncSummary } = await import(
	new URL("../web/js/sync-status.js", import.meta.url).href
);

const NOW = Date.parse("2026-11-12T12:00:00.000Z");

function status(patch: Record<string, unknown> = {}) {
	return {
		connected: true,
		enabled: true,
		paused: false,
		phase: "idle",
		lastError: null,
		lastCheckAt: "2026-11-12T11:58:00.000Z",
		pendingUploads: 0,
		pendingDownloads: 0,
		conflicts: [],
		issues: [],
		pendingBindings: [],
		manual: null,
		progress: null,
		files: { workspaces: [], conflicts: [], issues: [] },
		...patch,
	};
}

const summary = (patch: Record<string, unknown> = {}) => {
	const value = status(patch);
	return syncSummary(value, deriveSync(value), NOW);
};

describe("Google Drive sync summary", () => {
	it("says up to date and when, with nothing to do", () => {
		const view = summary();
		expect(view).toMatchObject({ tone: "ok", title: "Up to date", detail: "Last synced 2 min ago", action: "sync" });
		expect(summaryLine(view)).toBe("Up to date · Last synced 2 min ago");
	});

	it("offers to connect before anything else", () => {
		expect(summary({ connected: false })).toMatchObject({ tone: "off", title: "Not connected", action: "connect" });
		expect(summary({ connected: false, phase: "authorizing" })).toMatchObject({ tone: "busy", action: "cancel" });
	});

	it("shows how far a pass got, with numbers for the bar", () => {
		const view = summary({
			phase: "downloading",
			pendingDownloads: 240,
			progress: { stage: "download", step: "write", done: 12, total: 240 },
		});
		expect(view.tone).toBe("busy");
		expect(view.title).toBe("Syncing…");
		expect(view.detail).toBe("Downloading 12 / 240");
		expect(view.progress).toEqual({ done: 12, total: 240, percent: 5, stage: "download" });
		// Reading the change lists is its own step and says so.
		expect(summary({ progress: { stage: "download", step: "read", done: 3, total: 9 } }).detail).toBe(
			"Reading changes from Drive 3 / 9",
		);
		expect(summary({ progress: { stage: "upload", done: 4, total: 8 } }).detail).toBe("Uploading 4 / 8");
	});

	it("says what is waiting while a pass has not counted its work yet", () => {
		const view = summary({ phase: "uploading", pendingUploads: 3, pendingDownloads: 2 });
		expect(view).toMatchObject({ tone: "busy", title: "Syncing…", detail: "3 to upload · 2 to download" });
		expect(view.progress).toBeUndefined();
	});

	it("turns an expired sign-in into one clear action, and other failures into a retry", () => {
		expect(summary({ phase: "error", lastError: "Google sign-in expired. Sign in again." })).toMatchObject({
			tone: "danger",
			title: "Sign in to Google again",
			action: "signin",
		});
		expect(summary({ phase: "error", lastError: "Network is unreachable" })).toMatchObject({
			tone: "danger",
			title: "Sync could not finish",
			detail: "Network is unreachable",
			action: "sync",
		});
	});

	it("treats paused and switched off as one state with one way back", () => {
		expect(summary({ paused: true, pendingUploads: 4 })).toMatchObject({
			tone: "off",
			title: "Sync is off",
			detail: "4 changes are waiting. Turn sync on to continue.",
			action: "resume",
		});
		expect(summary({ enabled: false })).toMatchObject({ tone: "off", action: "resume" });
	});

	it("asks the user only for what it cannot decide: a folder, a large deletion, waiting file deletions", () => {
		const value = status({
			pendingBindings: [{ workspaceId: "ws1", name: "Study", path: "D:/x" }],
			issues: [
				{
					key: "mass-delete:memory",
					reason: "mass-delete",
					detail:
						"60 of 80 synced memory records are missing from this computer, so their deletion was not published.",
					at: "2026-11-12T11:00:00.000Z",
				},
				{ key: "missing:abc", reason: "missing-object", detail: "object abc", at: "2026-11-12T11:00:00.000Z" },
			],
			files: {
				workspaces: [
					{
						workspaceId: "ws2",
						name: "Notes",
						managed: true,
						state: "blocked",
						pendingUploads: 0,
						pendingDownloads: 0,
					},
				],
				conflicts: [],
				issues: [],
			},
		});
		const view = deriveSync(value);
		expect(view.needsYou).toBe(3);
		// Background retries are not the user's job and do not change the summary.
		expect(view.retrying.map((issue: { key: string }) => issue.key)).toEqual(["missing:abc"]);
		expect(syncSummary(value, view, NOW)).toMatchObject({ tone: "warn", title: "3 things need you" });
		expect(massDeleteText(view.massDeletes[0])).toContain("60 of 80 synced memories are missing");
	});

	it("never asks about two versions of something: entries an older version left are ignored", () => {
		const value = status({
			conflicts: [{ id: "c1", key: "memory:memory/profile.md", kind: "memory", reason: "both-modified" }],
			files: { workspaces: [], conflicts: [{ id: "f1", workspaceId: "ws1", path: "a.html" }], issues: [] },
		});
		const view = deriveSync(value);
		expect(view.needsYou).toBe(0);
		expect(syncSummary(value, view, NOW).tone).toBe("ok");
	});

	it("does not count a restored workspace that already has its managed folder", () => {
		const value = status({
			pendingBindings: [{ workspaceId: "ws1", name: "Study", path: "D:/x" }],
			files: {
				workspaces: [
					{
						workspaceId: "ws1",
						name: "Study",
						managed: true,
						state: "idle",
						pendingUploads: 0,
						pendingDownloads: 0,
					},
				],
				conflicts: [],
				issues: [],
			},
		});
		expect(deriveSync(value).needsYou).toBe(0);
	});
});

describe("Google Drive sync small texts", () => {
	it("tells how long ago in words", () => {
		expect(agoText("2026-11-12T11:59:40.000Z", NOW)).toBe("just now");
		expect(agoText("2026-11-12T11:30:00.000Z", NOW)).toBe("30 min ago");
		expect(agoText("2026-11-12T07:00:00.000Z", NOW)).toBe("5 h ago");
		expect(agoText(null, NOW)).toBe("");
	});

	it("estimates the time left only when there is a rate", () => {
		expect(etaText(100, undefined)).toBe("");
		expect(etaText(0, 5)).toBe("");
		expect(etaText(20, 5)).toBe("a few seconds left");
		expect(etaText(100, 5)).toBe("about 20 s left");
		expect(etaText(3000, 5)).toBe("about 10 min left");
	});

	it("gives the count of one stage only while that stage moves", () => {
		const moving = status({ progress: { stage: "upload", done: 300, total: 240 } });
		expect(progressText(moving, "upload")).toBe("240 / 240");
		expect(progressText(moving, "download")).toBe("");
		expect(progressText(status(), "upload")).toBe("");
	});
});
