/**
 * WebHostHub: keeps one WebHost ("slot") per open session so several sessions can run at the same time.
 *
 * Each slot owns an independent AgentSessionRuntime (session + cwd-bound services), created from the same
 * factory the process started with. Nothing here adds Agent behaviour: the hub only decides which runtime a
 * request talks to and which idle runtimes to release.
 *
 * Routes are written against a single `WebHost`. `hub.host` is a stand-in whose calls are forwarded to the slot
 * that the current request addresses (`x-myharness-slot` header or `slot` query parameter), so route code does
 * not need to know that several sessions exist.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync, unwatchFile, watchFile } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import type { WorkspaceStore } from "../../application/workspace-store.ts";
import { WorkspaceStore as WorkspaceStoreImpl } from "../../application/workspace-store.ts";
import { UNBOUND_WORKSPACE_ID } from "../../config/paths/index.ts";
import { getDataDir } from "../../config.ts";
import { ensureDefaultWorkingDir } from "../../data/workspace-store.ts";
import { getMissingSessionCwdIssue } from "../../session/manager/cwd.ts";
import { SessionManager } from "../../session/manager/index.ts";
import type { ChatMode } from "../../session/types.ts";
import { backgroundJobManager } from "../../tools/shell/job-manager.ts";
import { pathIdentityKey, resolvePath } from "../../utils/paths.ts";
import { ChangeClaimRegistry, type ShellWindow } from "./change-claims.ts";
import { WebDialogBridge } from "./dialogs.ts";
import { type SlotStatus, WebHost, type WebHostHubLink } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import {
	DEFAULT_IDLE_SLOT_BUDGET_BYTES,
	describeHostForBudget,
	MAX_IDLE_BACKGROUND_SLOTS,
	selectIdleSlotsToEvict,
} from "./slot-budget.ts";

/**
 * Hard fallback cap on idle background slots (defined in slot-budget.ts, re-exported here so existing
 * imports keep working). The idle memory budget evicts first; this only bounds many tiny idle chats.
 */
export { MAX_IDLE_BACKGROUND_SLOTS };
const STATUS_EVENTS = new Set([
	"git_task",
	"agent_start",
	"agent_end",
	"agent_settled",
	"run_state",
	"run_finished",
	"completion",
	"result_seen",
	"dialogs",
	"session_info",
	"conversation_naming",
	"entry_appended",
	"session_replaced",
	"workspaces_changed",
	"bash_start",
	"bash_end",
]);
const STATUS_DEBOUNCE_MS = 80;
const RECLAIM_RETRY_MS = 250;
const RECLAIM_TIMEOUT_MS = 15_000;
/** A slot created less than this long ago counts as busy for eviction (a fresh empty chat must survive the next open). */
export const SLOT_STARTUP_GRACE_MS = 30_000;
/** An eviction candidate touched this recently is skipped this round (a racing request just addressed it). */
export const SLOT_TOUCH_RECHECK_MS = 5_000;

export interface WebHostHubOptions {
	server: WebHttpServer;
	version: string;
	onShutdown: () => void;
	/** Hard fallback cap on idle background slots (default MAX_IDLE_BACKGROUND_SLOTS). */
	maxIdleSlots?: number;
	/** Budget over the estimated bytes of evictable idle slots (default DEFAULT_IDLE_SLOT_BUDGET_BYTES). */
	idleBudgetBytes?: number;
	/**
	 * Per-slot byte estimate override (tests inject exact sizes without real runtimes).
	 * Defaults to the heuristic built from entry counts, cached projection size, session file size and tracked runs.
	 */
	estimateSlotBytes?: (host: WebHost) => number;
}

/**
 * The background shell jobs of this process as attribution windows: a job keeps writing after the tool call that
 * started it returned, so its whole run (until it really ends) is a window of the chat that started it. Jobs are filed
 * under `session:<id>` (tools/shell/session-scope.ts); a job without a session id belongs to no chat.
 */
function backgroundJobWindows(): ShellWindow[] {
	const windows: ShellWindow[] = [];
	for (const job of backgroundJobManager.list()) {
		if (!job.sessionKey.startsWith("session:")) continue;
		windows.push({
			sessionKey: job.sessionKey.slice("session:".length),
			runId: 0,
			startedAt: job.startedAt,
			...(job.status === "running" ? {} : { endedAt: job.endedAt ?? job.startedAt }),
			kind: "job",
		});
	}
	return windows;
}

export class WebHostHub implements WebHostHubLink {
	private readonly slots = new Map<string, WebHost>();
	private readonly scope = new AsyncLocalStorage<WebHost>();
	private readonly opening = new Map<string, Promise<WebHost>>();
	private readonly options: WebHostHubOptions;
	/** Shared by all slots: what every open conversation changed, for cross-session attribution. */
	private readonly changeClaims = new ChangeClaimRegistry({ windowSource: backgroundJobWindows });
	private workspaceStore: WorkspaceStore | undefined;
	private primary: WebHost | undefined;
	private nextSlot = 1;
	private statusTimer: ReturnType<typeof setTimeout> | undefined;
	private lastStatusJson = "";
	private disposed = false;
	/** Slots whose model list changed while they were busy; they are reconciled as soon as they are idle. */
	private readonly deferredModelsReconcile = new Set<string>();
	private readonly providerFileWatches = new Map<string, () => void>();
	private readonly pendingProviderReloads = new Set<WebHost>();
	private providerReload: Promise<void> | undefined;
	private readonly providerReloadErrors = new Map<string, readonly string[]>();
	private readonly providerFileStamps = new Map<string, string>();
	/** Route code sees this as a normal WebHost; every access is forwarded to the slot the request addresses. */
	readonly host: WebHost;

	constructor(options: WebHostHubOptions) {
		this.options = options;
		this.host = new Proxy({} as WebHost, {
			get: (_target, property) => {
				const target = this.current();
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
			set: (_target, property, value) => Reflect.set(this.current(), property, value),
		});
		options.server.setRequestScope(({ req, url }, run) => {
			const wanted = req.headers["x-myharness-slot"];
			const id = typeof wanted === "string" && wanted ? wanted : (url.searchParams.get("slot") ?? undefined);
			if (!id) return run();
			const slot = this.slots.get(id);
			if (!slot) throw new HttpError(410, "This session is no longer open. Reopen it from the sidebar.");
			slot.touchedAt = Date.now();
			return this.scope.run(slot, run);
		});
		options.server.onSseConnect = (client) => client.send("slots", { slots: this.statuses() });
	}

	private current(): WebHost {
		const host = this.scope.getStore() ?? this.primary;
		if (!host) throw new HttpError(503, "The session is not ready yet.");
		return host;
	}

	/** Register the runtime the process started with. Its dialog bridge already exists (Project Trust runs before it). */
	async addPrimary(runtimeHost: AgentSessionRuntime, dialogs: WebDialogBridge): Promise<WebHost> {
		this.workspaceStore = WorkspaceStoreImpl.create(runtimeHost.services.agentDir, getDataDir());
		const host = await this.addRuntime(runtimeHost, dialogs);
		this.primary = host;
		return host;
	}

	private async addRuntime(runtimeHost: AgentSessionRuntime, dialogs: WebDialogBridge): Promise<WebHost> {
		const host = new WebHost({
			runtimeHost,
			server: this.options.server,
			dialogs,
			version: this.options.version,
			slotId: `s${this.nextSlot++}`,
			workspaceStore: this.workspaceStore,
			changeClaims: this.changeClaims,
			hub: this,
		});
		this.slots.set(host.slotId, host);
		await host.start();
		this.updateProviderFileWatches();
		this.scheduleStatus();
		return host;
	}

	get(id: string): WebHost | undefined {
		return this.slots.get(id);
	}

	all(): WebHost[] {
		return [...this.slots.values()];
	}

	statuses(): SlotStatus[] {
		return this.all().map((host) => host.status);
	}

	/** Any dialog id (they are UUIDs) can be answered no matter which slot asked. */
	respondToDialog(id: string, value: string | boolean | undefined): boolean {
		return this.all().some((host) => host.dialogs.respond(id, value));
	}

	// ---- WebHostHubLink ---------------------------------------------------------------------

	hostBroadcast(host: WebHost, event: string): void {
		if (STATUS_EVENTS.has(event)) this.scheduleStatus();
		if (event === "trust_changed") {
			// A trust decision covers a folder: the other open chats in it follow the chat it was made in.
			for (const other of this.slots.values()) if (other !== host) void other.applySavedTrust().catch(() => {});
		}
		if (event === "settings_changed" || event === "models_changed") {
			// Other runtimes keep their own in-memory settings; pick up what this one just saved.
			for (const other of this.slots.values()) {
				if (other === host) continue;
				// A busy slot must not swap its model mid-run: reconcile it as soon as it is idle again.
				if (!other.session.isIdle) {
					if (event === "models_changed") this.deferredModelsReconcile.add(other.slotId);
					continue;
				}
				this.reconcileSlot(other, event);
			}
		}
		// A slot that missed a model update while it was busy catches up once its work has settled.
		if (event === "session_replaced") this.updateProviderFileWatches();
		if (
			this.deferredModelsReconcile.has(host.slotId) &&
			host.session.isIdle &&
			!this.pendingProviderReloads.has(host)
		)
			this.reconcileSlot(host, "models_changed");
		if (this.pendingProviderReloads.size && host.session.isIdle) void this.flushProviderFiles();
	}

	private providerFiles(host: WebHost): string[] {
		const models = host.session.modelRuntime.getModelsConfigPath();
		const auth = join(models ? dirname(models) : host.runtimeHost.services.agentDir, "auth.json");
		return models ? [models, auth] : [auth];
	}

	private updateProviderFileWatches(): void {
		if (this.disposed) return;
		const paths = new Set(this.all().flatMap((host) => this.providerFiles(host)));
		for (const [path, stop] of this.providerFileWatches) {
			if (paths.has(path)) continue;
			stop();
			this.providerFileWatches.delete(path);
			this.providerFileStamps.delete(path);
			this.providerReloadErrors.delete(path);
		}
		for (const path of paths) {
			if (this.providerFileWatches.has(path)) continue;
			this.providerFileStamps.set(path, this.providerFileStamp(path));
			const listener = () => {
				this.detectProviderFileChange(path);
				void this.flushProviderFiles();
			};
			// Watching the path by stat also sees creation and atomic replacement on Windows.
			watchFile(path, { interval: 400, persistent: false }, listener);
			this.providerFileWatches.set(path, () => unwatchFile(path, listener));
		}
	}

	private providerFileStamp(path: string): string {
		try {
			const info = statSync(path, { bigint: true });
			return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code ?? "unreadable";
		}
	}

	private detectProviderFileChange(path: string): void {
		const stamp = this.providerFileStamp(path);
		if (this.providerFileStamps.get(path) === stamp) return;
		this.providerFileStamps.set(path, stamp);
		for (const host of this.slots.values()) {
			if (this.providerFiles(host).includes(path)) this.pendingProviderReloads.add(host);
		}
	}

	async refreshProviderFilesBeforePrompt(host: WebHost): Promise<void> {
		for (const path of this.providerFiles(host)) this.detectProviderFileChange(path);
		while (this.providerReload || this.pendingProviderReloads.has(host)) {
			const reload = this.flushProviderFiles();
			// If a sibling is busy, let the prompt proceed on the current shared configuration.
			if (!reload) break;
			await reload;
		}
	}

	/** Applied as a group because chats in the same directory can share a ModelRuntime. */
	private flushProviderFiles(): Promise<void> | undefined {
		if (this.providerReload) return this.providerReload;
		if (this.disposed || !this.pendingProviderReloads.size) return;
		const groups = new Map<AgentSessionRuntime["session"]["modelRuntime"], WebHost[]>();
		for (const host of this.slots.values()) {
			const runtime = host.session.modelRuntime;
			const group = groups.get(runtime);
			if (group) group.push(host);
			else groups.set(runtime, [host]);
		}
		const ready = [...groups].filter(
			([, hosts]) =>
				hosts.some((host) => this.pendingProviderReloads.has(host)) && hosts.every((host) => host.session.isIdle),
		);
		if (!ready.length) return;
		const reload = Promise.resolve()
			.then(async () => {
				for (const [runtime, hosts] of ready) {
					if (this.disposed || hosts.some((host) => !host.session.isIdle)) continue;
					const sessions = hosts.map((host) => ({ host, session: host.session }));
					for (const host of hosts) this.pendingProviderReloads.delete(host);
					const stillOpen = () =>
						sessions.filter(({ host, session }) => this.slots.has(host.slotId) && host.session === session);
					const errors = await runtime
						.reloadProviderFiles(
							() =>
								!this.disposed &&
								this.all().every((host) => host.session.modelRuntime !== runtime || host.session.isIdle),
						)
						.catch(() => ["Provider configuration"]);
					if (this.disposed) return;
					if (!errors) {
						for (const { host } of stillOpen()) this.pendingProviderReloads.add(host);
						continue;
					}
					const path = this.providerFiles(hosts[0])[0];
					const previous = this.providerReloadErrors.get(path) ?? [];
					if (errors.length) this.providerReloadErrors.set(path, errors);
					else this.providerReloadErrors.delete(path);
					for (const file of errors) {
						if (!previous.includes(file))
							this.options.server.broadcast("notice", {
								message: `${file} 重载失败，请检查配置文件。`,
								type: "error",
							});
					}
					for (const { host, session } of stillOpen()) {
						if (!session.isIdle) {
							this.pendingProviderReloads.add(host);
							continue;
						}
						if (!session.isMirror) session.reconcileExternalProviderChange();
						this.options.server.broadcast("models_changed", { slot: host.slotId });
					}
				}
			})
			.finally(() => {
				this.providerReload = undefined;
				void this.flushProviderFiles();
			});
		this.providerReload = reload;
		return reload;
	}

	/**
	 * Pull one slot's in-memory settings and models up to date with what another slot just saved. When the slot's
	 * own model was deleted, its session is reconciled first and the reconciled slot is announced afterwards: the
	 * original event can reach browsers before this runtime finishes reloading, and an already loaded chat would
	 * otherwise keep showing the deleted model until the page is reloaded.
	 */
	private reconcileSlot(other: WebHost, event: string): void {
		this.deferredModelsReconcile.delete(other.slotId);
		void (async () => {
			await other.session.settingsManager.reload();
			if (!this.slots.has(other.slotId)) return;
			other.refreshConversationNaming();
			other.refreshSessionHandoff();
			if (event !== "models_changed") return;
			// Providers added, edited or deleted elsewhere must reach this runtime too (each has its own ModelRuntime).
			// Credentials go first: a key or login saved in the other session lives in auth.json, and the reload below is
			// what lets this runtime's snapshot pick it up.
			other.session.modelRuntime.reloadCredentials();
			// A provider enabled or disabled elsewhere: the settings reloaded above hold the new list, this runtime does not.
			other.session.modelRuntime.setDisabledProviders(other.session.settingsManager.getDisabledProviders());
			await other.session.modelRuntime.reloadConfig();
			await other.session.reconcileModelAfterConfigChange();
			if (!this.slots.has(other.slotId)) return;
			// Publish the reconciled slot without feeding the hub's reload fan-out again.
			this.options.server.broadcast("models_changed", { slot: other.slotId });
			other.broadcast("usage", other.usage());
		})().catch(() => {
			// A catch-up that fails must not be forgotten: while the slot is open, the next broadcast retries it.
			if (this.slots.has(other.slotId)) this.deferredModelsReconcile.add(other.slotId);
		});
	}

	requestShutdown(): void {
		this.options.onShutdown();
	}

	/**
	 * A session that was only being followed lost its owning process. Replace it in the same slot by the session
	 * opened normally, which now holds the writer lock (or follows the next owner).
	 */
	reclaimMirror(host: WebHost): void {
		const path = host.session.sessionFile;
		if (!path || !this.slots.has(host.slotId)) return;
		void (async () => {
			// The owner closes its bridge a moment before it releases the writer lock: try again until it is free.
			const deadline = Date.now() + RECLAIM_TIMEOUT_MS;
			for (;;) {
				try {
					await host.runtimeHost.switchSession(path, { allowMissingCwd: true });
					return;
				} catch (error) {
					const raw = error instanceof Error ? error.message : String(error);
					if (/already active/i.test(raw) && Date.now() < deadline && this.slots.has(host.slotId)) {
						await new Promise((resolve) => setTimeout(resolve, RECLAIM_RETRY_MS));
						continue;
					}
					// Never surface absolute session or workspace paths for a missing folder.
					const message = /does not exist|MissingSessionCwd|Workspace directory/i.test(raw)
						? "工作区本地目录不存在或已被移除，历史对话仍可查阅。"
						: raw;
					host.broadcast("notice", { id: `reclaim-${Date.now()}`, message, type: "error", ts: Date.now() });
					return;
				}
			}
		})();
	}

	private scheduleStatus(): void {
		if (this.statusTimer || this.disposed) return;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			this.broadcastStatus();
		}, STATUS_DEBOUNCE_MS);
	}

	private broadcastStatus(): void {
		const slots = this.statuses();
		const json = JSON.stringify(slots);
		if (json === this.lastStatusJson) return;
		this.lastStatusJson = json;
		this.options.server.broadcast("slots", { slots });
	}

	// ---- Opening, creating and closing sessions -----------------------------------------

	private findBySessionFile(path: string): WebHost | undefined {
		const key = pathIdentityKey(path);
		return this.all().find((host) => host.session.sessionFile && pathIdentityKey(host.session.sessionFile) === key);
	}

	/** Show an existing session. It keeps running in its own runtime if it already has one.
	 *
	 * A session whose folder was removed externally still opens: history stays readable,
	 * the switch never throws, and the caller is told which workspace is missing by name
	 * (never by absolute path) so it can show one lightweight toast.
	 */
	async openSession(
		from: WebHost,
		path: string,
		cwdOverride?: string,
	): Promise<{ slot: string; created: boolean; cwdMissing?: boolean; workspaceName?: string; workspaceId?: string }> {
		const existing = this.findBySessionFile(path);
		if (existing) {
			const missing = this.describeMissingWorkspace(existing);
			return missing
				? { slot: existing.slotId, created: false, ...missing }
				: { slot: existing.slotId, created: false };
		}
		// A chat that is in no slot and not on disk was deleted: opening its path would start an empty chat there in the
		// default mode (Coding), inside a folder that is gone.
		if (!existsSync(resolvePath(path))) throw new HttpError(404, "This chat no longer exists.");
		const key = pathIdentityKey(path);
		let pending = this.opening.get(key);
		const created = !pending;
		if (!pending) {
			pending = (async () => {
				let sessionManager = SessionManager.open(path, undefined, cwdOverride);
				if (cwdOverride === undefined) {
					// A chat synced from another device stores that device's folder; this device's binding wins.
					const local =
						this.localWorkspaceRootFor(
							sessionManager.getCwd(),
							sessionManager.getWorkspaceId(),
							sessionManager.getMode(),
						) ?? this.localDefaultFolderFor(sessionManager, from);
					if (local) sessionManager = SessionManager.open(path, undefined, local);
				}
				const issue = cwdOverride === undefined ? getMissingSessionCwdIssue(sessionManager, from.cwd) : undefined;
				const missing = issue
					? this.describeMissingWorkspaceForSession(
							sessionManager.getCwd(),
							sessionManager.getWorkspaceId(),
							sessionManager.getMode(),
						)
					: undefined;
				const runtime = await from.runtimeHost.createSibling({
					sessionManager,
					sessionStartEvent: {
						type: "session_start",
						reason: "resume",
						previousSessionFile: from.session.sessionFile,
					},
					projectTrustContext: from.createProjectTrustContext(sessionManager.getCwd()),
					allowMissingCwd: issue !== undefined,
				});
				const host = await this.addRuntime(runtime, new WebDialogBridge());
				if (missing)
					(
						host as WebHost & {
							pendingMissingWorkspace?: { cwdMissing: boolean; workspaceName: string; workspaceId?: string };
						}
					).pendingMissingWorkspace = { cwdMissing: true, ...missing };
				return host;
			})();
			this.opening.set(key, pending);
		}
		let host: WebHost | undefined;
		try {
			host = await pending;
			const pendingMissing = (
				host as WebHost & {
					pendingMissingWorkspace?: { cwdMissing: boolean; workspaceName: string; workspaceId?: string };
				}
			).pendingMissingWorkspace;
			if (pendingMissing) return { slot: host.slotId, created, ...pendingMissing };
			const missing = this.describeMissingWorkspace(host);
			return missing ? { slot: host.slotId, created, ...missing } : { slot: host.slotId, created };
		} finally {
			this.opening.delete(key);
			// pruneIdle defers while an open is still in flight (`opening.size > 0`), so it must run after
			// the key is removed. Calling it before the delete made the open path never prune, letting idle
			// background slots pile up until the next create.
			if (host) this.pruneIdle(host);
		}
	}

	/**
	 * The folder a chat should run in on this device when the one it stored is not usable here: the stored folder is
	 * gone (it came from another device, or was removed), or it is the managed placeholder a restored Workspace used
	 * until the user bound its real folder. Only the chat's own Workspace (by id) is consulted, and only an existing
	 * directory is returned; any other chat keeps its stored folder (a worktree or sub-folder stays as it is).
	 */
	private localWorkspaceRootFor(
		sessionCwd: string,
		workspaceId: string | undefined,
		mode: ChatMode,
	): string | undefined {
		const store = this.workspaceStore ?? this.all()[0]?.workspaceStore;
		if (!store || !workspaceId) return undefined;
		const workspace = store.getById(workspaceId, mode) ?? store.getById(workspaceId);
		if (!workspace?.rootPath || pathIdentityKey(workspace.rootPath) === pathIdentityKey(sessionCwd)) return undefined;
		try {
			if (!statSync(workspace.rootPath).isDirectory()) return undefined;
		} catch {
			return undefined;
		}
		let usable = false;
		try {
			usable = existsSync(sessionCwd);
		} catch {
			usable = false;
		}
		const dataRoot = store.getDataRoot();
		const placeholder =
			usable && dataRoot ? relative(join(resolvePath(dataRoot), "workspace-folders"), resolvePath(sessionCwd)) : "";
		const inPlaceholder = !!placeholder && !placeholder.startsWith("..") && !/^[A-Za-z]:/.test(placeholder);
		return !usable || inPlaceholder ? workspace.rootPath : undefined;
	}

	/**
	 * A chat of the default group (no Workspace) runs in MyHarness's own default folder. One synced from another
	 * device stores that device's default folder, which usually does not exist here (another user name, another
	 * data folder): it runs in this device's default folder instead, like a new chat of that group would.
	 */
	private localDefaultFolderFor(sessionManager: SessionManager, from: WebHost): string | undefined {
		if (sessionManager.getWorkspaceId() !== UNBOUND_WORKSPACE_ID || !sessionManager.usesDefaultSessionDir())
			return undefined;
		let usable = false;
		try {
			usable = existsSync(sessionManager.getCwd());
		} catch {
			usable = false;
		}
		return usable ? undefined : ensureDefaultWorkingDir(from.runtimeHost.services.agentDir);
	}

	/**
	 * Providers, keys or settings were written to disk by something that is not a chat (Google Drive sync brought them
	 * from another computer). Every open chat reloads them like a change saved in another chat; a busy one waits
	 * until its work has settled, so no model is swapped in the middle of a run.
	 */
	reloadConfigFromDisk(): void {
		for (const host of this.slots.values()) {
			if (host.session.isIdle) this.reconcileSlot(host, "models_changed");
			else this.deferredModelsReconcile.add(host.slotId);
		}
	}

	/**
	 * Google Drive sync changed the Workspace registry through its own store (a restored Workspace, or a folder the
	 * user just bound). Re-read it, so the shared store does not save its old copy over the new one, and move every
	 * idle open chat whose folder is not usable here onto its Workspace's folder, so the panels show it at once.
	 */
	async reloadWorkspaces(): Promise<void> {
		const store = this.workspaceStore ?? this.all()[0]?.workspaceStore;
		if (!store) return;
		store.reload();
		for (const host of this.all()) {
			const file = host.session.sessionFile;
			if (!file || !host.session.isIdle || host.completionActive) continue;
			const manager = host.session.sessionManager;
			const local = this.localWorkspaceRootFor(host.cwd, manager.getWorkspaceId(), manager.getMode());
			if (!local) continue;
			try {
				await host.runtimeHost.switchSession(file, { cwdOverride: local });
			} catch {
				/* The chat stays readable in its old folder; opening it again resolves the folder anew. */
			}
		}
	}

	/** Name the workspace whose folder is gone, without ever exposing absolute paths. */
	private describeMissingWorkspace(
		host: WebHost,
	): { cwdMissing: boolean; workspaceName: string; workspaceId?: string } | undefined {
		try {
			if (existsSync(host.cwd)) return undefined;
		} catch {
			return undefined;
		}
		const workspace = host.workspace;
		const name =
			workspace?.name ??
			this.describeMissingWorkspaceForSession(
				host.cwd,
				host.session.sessionManager.getWorkspaceId(),
				host.session.sessionManager.getMode(),
			)?.workspaceName ??
			basename(host.cwd);
		return { cwdMissing: true, workspaceName: name, ...(workspace ? { workspaceId: workspace.workspaceId } : {}) };
	}

	private describeMissingWorkspaceForSession(
		sessionCwd: string,
		workspaceId: string | undefined,
		mode: ChatMode,
	): { workspaceName: string; workspaceId?: string } {
		const store = this.workspaceStore ?? this.all()[0]?.workspaceStore;
		const byId = workspaceId && store ? store.getById(workspaceId, mode) : undefined;
		if (byId) return { workspaceName: byId.name, workspaceId: byId.workspaceId };
		const byPath = store ? store.getByPath(sessionCwd, mode) : undefined;
		if (byPath) return { workspaceName: byPath.name, workspaceId: byPath.workspaceId };
		return { workspaceName: basename(sessionCwd) || sessionCwd };
	}

	/**
	 * Start a fresh chat. The session the request came from keeps running untouched.
	 *
	 * With `rootPath` the chat belongs to that Workspace. Without one it follows the session it was started from: a
	 * chat that belongs to no Workspace stays that way, and `unbound` asks for one explicitly. A new unbound chat runs in
	 * MyHarness's own default working directory, not in the folder of a Workspace it may have been removed from.
	 */
	async newSession(
		from: WebHost,
		rootPath?: string,
		unbound = false,
		mode: ChatMode = from.session.sessionManager.getMode(),
		options: { forceNew?: boolean } = {},
	): Promise<{ slot: string; created: boolean }> {
		const manager = from.session.sessionManager;
		const defaultStorage = manager.usesDefaultSessionDir() && manager.isPersisted();
		const wantUnbound = defaultStorage && (unbound || (!rootPath && from.unbound));
		let cwd = rootPath
			? resolvePath(rootPath)
			: wantUnbound
				? ensureDefaultWorkingDir(from.runtimeHost.services.agentDir)
				: from.cwd;
		// A mode switch that creates the next chat must never be blocked by a folder that
		// vanished meanwhile: fall back to the default directory instead of throwing.
		if (!rootPath) {
			try {
				if (!existsSync(cwd)) cwd = ensureDefaultWorkingDir(from.runtimeHost.services.agentDir);
			} catch {
				cwd = ensureDefaultWorkingDir(from.runtimeHost.services.agentDir);
			}
		} else {
			let missing = false;
			try {
				missing = !existsSync(cwd);
			} catch {
				missing = false;
			}
			if (missing) {
				const name = from.workspaceStore.getByPath(cwd, mode)?.name ?? basename(cwd);
				throw new HttpError(400, `工作区 [${name}] 本地目录不存在或已被移除`);
			}
		}
		let isDirectory = true;
		try {
			isDirectory = statSync(cwd).isDirectory();
		} catch {
			const name = rootPath
				? (from.workspaceStore.getByPath(cwd, mode)?.name ?? basename(cwd))
				: (from.workspace?.name ?? basename(cwd));
			throw new HttpError(400, `工作区 [${name}] 本地目录不存在或已被移除`);
		}
		if (!isDirectory) {
			const name = rootPath
				? (from.workspaceStore.getByPath(cwd, mode)?.name ?? basename(cwd))
				: (from.workspace?.name ?? basename(cwd));
			throw new HttpError(400, `工作区 [${name}] 本地路径不是目录`);
		}
		await from.session.settingsManager.reload();
		// An untouched empty chat can be reused when no explicit new-chat defaults need resolving.
		const reusable =
			options.forceNew || from.session.settingsManager.getNewChatModel()
				? undefined
				: [from, ...this.all()].find(
						(host) =>
							host.session.sessionManager.getMode() === mode &&
							pathIdentityKey(host.cwd) === pathIdentityKey(cwd) &&
							host.session.isIdle &&
							!host.gitTask &&
							!host.completionActive &&
							(!defaultStorage || host.unbound === wantUnbound) &&
							// Asks "no messages?" without projecting every message of every open chat just to read a length.
							host.session.sessionManager.hasContextMessages() === false &&
							!host.hasOperationContent,
					);
		if (reusable) return { slot: reusable.slotId, created: false };
		const sessionDir = manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir();
		const sessionManager = !manager.isPersisted()
			? SessionManager.inMemory(cwd, { mode })
			: wantUnbound
				? SessionManager.createUnbound(cwd, { mode }, { dataRoot: manager.getDataRoot() })
				: SessionManager.create(cwd, sessionDir, { mode });
		const runtime = await from.runtimeHost.createSibling({
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile: from.session.sessionFile },
			projectTrustContext: from.createProjectTrustContext(cwd),
		});
		const host = await this.addRuntime(runtime, new WebDialogBridge());
		this.pruneIdle(host);
		return { slot: host.slotId, created: true };
	}

	/** Slots that currently show the given session file. */
	slotsShowing(path: string): WebHost[] {
		const key = pathIdentityKey(path);
		return this.all().filter((host) => host.session.sessionFile && pathIdentityKey(host.session.sessionFile) === key);
	}

	/** Release a slot's runtime. The last slot is kept; callers replace its session instead. */
	async closeSlot(host: WebHost): Promise<void> {
		if (!this.slots.delete(host.slotId)) return;
		this.deferredModelsReconcile.delete(host.slotId);
		this.pendingProviderReloads.delete(host);
		this.updateProviderFileWatches();
		void this.flushProviderFiles();
		if (this.primary === host) this.primary = this.all()[0];
		await host.dispose();
		this.options.server.broadcast("slot_closed", { slot: host.slotId });
		this.scheduleStatus();
	}

	private isBusy(host: WebHost): boolean {
		// A finished session whose result is still unread keeps its slot, so its sidebar marker cannot vanish unseen.
		// A chat with a background command still running keeps it too: the command reports back to that session.
		return (
			!!host.gitTask ||
			host.backgroundGit.size > 0 ||
			!host.session.isIdle ||
			host.completionActive ||
			host.dialogs.requests.length > 0 ||
			host.unread ||
			host.backgroundJobsPending
		);
	}

	/**
	 * Keep the most-recently-touched idle background slots within the memory budget and the hard count cap
	 * (P1-4; see slot-budget.ts). Running or waiting slots are never touched, nor the slot just opened and
	 * nor the primary one.
	 */
	private pruneIdle(keep: WebHost): void {
		// An open/create still in flight may be about to claim a slot: defer to the next round.
		if (this.opening.size > 0) return;
		const now = Date.now();
		const byId = new Map(this.all().map((host) => [host.slotId, host]));
		const candidates = this.all()
			.filter(
				(host) =>
					host !== keep &&
					host !== this.primary &&
					!this.isBusy(host) &&
					now - host.startedAt >= SLOT_STARTUP_GRACE_MS,
			)
			.map((host) => describeHostForBudget(host, this.primary, false));
		const injected = this.options.estimateSlotBytes;
		const { evict } = selectIdleSlotsToEvict(candidates, {
			budgetBytes: this.options.idleBudgetBytes ?? DEFAULT_IDLE_SLOT_BUDGET_BYTES,
			maxIdleSlots: this.options.maxIdleSlots ?? MAX_IDLE_BACKGROUND_SLOTS,
			// An injected estimator ranks by host; the default ranks by the described view. Either way the
			// pure selection stays free of WebHost.
			...(injected ? { estimateBytes: (slot: { slotId: string }) => injected(byId.get(slot.slotId)!) } : {}),
		});
		for (const id of evict) {
			const host = byId.get(id);
			if (!host) continue;
			// Re-check before releasing: a request may have addressed the slot after the plan was made.
			if (Date.now() - host.touchedAt < SLOT_TOUCH_RECHECK_MS) continue;
			void this.closeSlot(host).catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const stop of this.providerFileWatches.values()) stop();
		this.providerFileWatches.clear();
		this.pendingProviderReloads.clear();
		await this.providerReload;
		if (this.statusTimer) clearTimeout(this.statusTimer);
		const hosts = this.all();
		this.slots.clear();
		await Promise.allSettled(hosts.map((host) => host.dispose()));
		await Promise.allSettled(hosts.map((host) => host.runtimeHost.services.settingsManager.flush()));
	}
}
