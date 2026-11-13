// Derived Google Drive sync status: what the settings page and the sidebar indicator say is computed once here, so
// they can never disagree. Pure data in, text out; no DOM and no page state.
//
// Nothing here asks the user to pick between two versions: what two computers did differently is settled by the later
// change in the background. What is left for the user is rare and concrete: sign in again, pick a folder for a
// restored workspace, or confirm a large deletion.
import { t } from "./i18n.js";

/** `needsYou` counts what only the user can do; `retrying` is background work that repeats by itself. */
export function deriveSync(status) {
	const files = status?.files ?? null;
	const workspaces = files?.workspaces ?? [];
	const issues = status?.issues ?? [];
	// A local workspace that already got its managed copy on this device needs no restore card.
	const managedIds = new Set(workspaces.filter((item) => item.managed).map((item) => item.workspaceId));
	const pendingBindings = (status?.pendingBindings ?? []).filter((item) => !managedIds.has(item.workspaceId));
	const blocked = workspaces.filter((item) => item.state === "blocked");
	const failing = workspaces.filter((item) => item.state === "error" || item.incomplete === true);
	const massDeletes = issues.filter((issue) => issue.reason === "mass-delete");
	const retrying = issues.filter((issue) => issue.reason !== "mass-delete");
	const filePending = workspaces.reduce(
		(total, item) => total + (item.pendingUploads ?? 0) + (item.pendingDownloads ?? 0),
		0,
	);
	const up = Number(status?.pendingUploads) || 0;
	const down = Number(status?.pendingDownloads) || 0;
	return {
		files,
		workspaces,
		issues,
		retrying,
		massDeletes,
		pendingBindings,
		blocked,
		failing,
		filePending,
		up,
		down,
		needsYou: pendingBindings.length + blocked.length + massDeletes.length,
	};
}

/** "just now", "5 minutes ago", "3 hours ago", then the date. */
export function agoText(value, now = Date.now()) {
	const time = Date.parse(value ?? "");
	if (!Number.isFinite(time)) return "";
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 45) return t("just now");
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return t("{count} min ago", { count: Math.max(1, minutes) });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t("{count} h ago", { count: hours });
	try {
		return new Date(time).toLocaleDateString();
	} catch {
		return "";
	}
}

/** The latest moment this computer and Drive were known to agree: the last finished check. */
export function lastSyncedAt(status) {
	return status?.lastCheckAt || status?.lastDownloadAt || status?.lastUploadAt || null;
}

/**
 * What the pass in flight is doing. A download first reads the change lists of new batches, then fetches and writes
 * what they name; the two steps count different things, so each says which one it is.
 */
export function movingText(moving) {
	if (moving?.stage === "upload") return t("Uploading");
	return moving?.step === "read" ? t("Reading changes from Drive") : t("Downloading");
}

/** "12 / 240" for the pass in flight in one stage, or "" when that stage is not moving. */
export function progressText(status, stage) {
	const progress = status?.progress;
	if (!progress || progress.stage !== stage || !(progress.total > 0)) return "";
	return `${Math.min(progress.done, progress.total)} / ${progress.total}`;
}

/** "about 20 s left" from a rate in items per second; "" when there is nothing to say yet. */
export function etaText(left, perSecond) {
	if (!(left > 0) || !(perSecond > 0)) return "";
	const seconds = left / perSecond;
	if (seconds < 8) return t("a few seconds left");
	if (seconds < 90) return t("about {count} s left", { count: Math.round(seconds / 5) * 5 });
	if (seconds < 90 * 60) return t("about {count} min left", { count: Math.max(2, Math.round(seconds / 60)) });
	return t("about {count} h left", { count: Math.max(2, Math.round(seconds / 3600)) });
}

/**
 * The one summary of sync: a tone, a short title, one line of detail, and the bar's numbers while something moves.
 * `tone`: "off" (not connected or switched off), "ok", "busy", "warn" (the user has something to do), "danger".
 * `action`: what the main button should do next: "connect", "signin", "resume" or "sync".
 */
export function syncSummary(status, sync = deriveSync(status), now = Date.now()) {
	if (!status) return { tone: "off", title: t("Sync"), detail: "", action: "connect" };
	if (!status.connected) {
		if (status.phase === "authorizing") {
			return {
				tone: "busy",
				title: t("Waiting for the Google sign-in"),
				detail: t("Finish signing in in the browser; this page updates by itself."),
				action: "cancel",
			};
		}
		return {
			tone: "off",
			title: t("Not connected"),
			detail: t("Connect Google Drive and your chats, memories and settings follow you to your other computers."),
			action: "connect",
		};
	}
	if (status.phase === "authorizing") {
		return { tone: "busy", title: t("Waiting for the Google sign-in"), detail: "", action: "cancel" };
	}
	if (status.phase === "locked") {
		return {
			tone: "warn",
			title: t("Another MyHarness window is syncing"),
			detail: t("Sync continues here when that one is done."),
			action: "sync",
		};
	}
	const waiting = sync.up + sync.down + sync.filePending;
	if (!status.enabled || status.paused) {
		return {
			tone: "off",
			title: t("Sync is off"),
			detail:
				waiting > 0
					? t("{count} changes are waiting. Turn sync on to continue.", { count: waiting })
					: t("Nothing is uploaded or downloaded until you turn it on."),
			action: "resume",
		};
	}
	const moving = status.progress && status.progress.total > 0 ? status.progress : null;
	if (moving) {
		const done = Math.min(moving.done, moving.total);
		return {
			tone: "busy",
			title: t("Syncing…"),
			detail: `${movingText(moving)} ${done} / ${moving.total}`,
			progress: { done, total: moving.total, percent: Math.round((done / moving.total) * 100), stage: moving.stage },
			action: "sync",
		};
	}
	if (status.phase === "error" || status.lastError) {
		const text = String(status.lastError || "");
		const signIn = /sign in|sign-in|authoriz|token|401|invalid_grant|\u767b\u5f55|\u6388\u6743/iu.test(text);
		return {
			tone: "danger",
			title: signIn ? t("Sign in to Google again") : t("Sync could not finish"),
			detail: text ? t(text) : t("It is tried again by itself."),
			action: signIn ? "signin" : "sync",
		};
	}
	if (status.phase === "uploading" || status.phase === "downloading" || status.phase === "scanning" || waiting > 0) {
		const parts = [];
		if (sync.up > 0) parts.push(t("{count} to upload", { count: sync.up }));
		if (sync.down > 0) parts.push(t("{count} to download", { count: sync.down }));
		if (sync.filePending > 0) parts.push(t("{count} workspace files", { count: sync.filePending }));
		return {
			tone: "busy",
			title: t("Syncing…"),
			detail: parts.length ? parts.join(" · ") : t("Checking Google Drive"),
			action: "sync",
		};
	}
	if (sync.needsYou > 0) {
		return {
			tone: "warn",
			title: t("{count} things need you", { count: sync.needsYou }),
			detail: t("Everything else is up to date."),
			action: "sync",
		};
	}
	const at = lastSyncedAt(status);
	return {
		tone: "ok",
		title: t("Up to date"),
		detail: at ? t("Last synced {when}", { when: agoText(at, now) }) : t("Changes sync by themselves."),
		action: "sync",
	};
}

/** The sidebar indicator's tooltip: the summary in one line. */
export function summaryLine(summary) {
	return summary.detail ? `${summary.title} · ${summary.detail}` : summary.title;
}

/** A large deletion that was held back, in plain words. `detail` is the engine's own sentence, kept for the tooltip. */
export function massDeleteText(issue) {
	const match = /^(\d+) of (\d+) synced (\S+) records/u.exec(issue?.detail ?? "");
	const kind =
		{
			memory: t("memories"),
			session: t("chats"),
			file: t("files"),
			workspace: t("workspaces"),
			draft: t("drafts"),
		}[match?.[3]] || t("items");
	if (!match) return t("Many synced items are missing on this computer. Their deletion was not sent to your other computers.");
	return t(
		"{count} of {total} synced {kind} are missing on this computer. To be safe, their deletion was not sent to your other computers, which keep them.",
		{ count: match[1], total: match[2], kind },
	);
}
