// Google Drive sync settings. The page answers three questions in this order: is everything in sync (one line and one
// button at the top), does anything need me (a card that only exists when something does), and what travels. Things
// used once or never (this computer's name, the Drive folder, an OAuth client of one's own) are folded under Advanced.
// Nothing here asks the user to pick between two versions: the later change wins, in the background.
import { html, useEffect, useRef, useState, Collapse, Icon, Spinner, Toggle } from "./ui.js";
import { api, post, set, toast, useStore } from "./store.js";
import { t } from "./i18n.js";
import { agoText, deriveSync, etaText, massDeleteText, syncSummary } from "./sync-status.js";
import { confirmDialog } from "./actions.js";

function Card({ title, description, action, children, id }) {
	return html`<section class="set-card" id=${id || undefined}>
		<div class="set-card-head"><div class="col grow"><strong>${title}</strong>${description ? html`<span class="set-card-desc">${description}</span>` : null}</div>${action || null}</div>
		<div class="set-card-body">${children}</div>
	</section>`;
}

/** `wide`: the control takes its own full-width line under the name, for values too long for the right column. */
function Row({ label, description, children, stack, wide }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""} ${wide ? "wide" : ""}`}><div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc">${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
}

function formatBytes(value) {
	const bytes = Number(value) || 0;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * How fast the pass in flight moves, in items per second, measured from when this stage was first seen. Undefined for
 * the first two seconds: a rate from one or two items says nothing.
 */
function useRate(progress) {
	const start = useRef(null);
	if (!progress) {
		start.current = null;
		return undefined;
	}
	const now = Date.now();
	const key = `${progress.stage}:${progress.step ?? ""}:${progress.total}`;
	if (!start.current || start.current.key !== key || progress.done < start.current.done) {
		start.current = { key, at: now, done: progress.done };
	}
	const seconds = (now - start.current.at) / 1000;
	const moved = progress.done - start.current.done;
	return seconds >= 2 && moved > 0 ? moved / seconds : undefined;
}

/** The status at the top: a mark in the state's color, what is going on in one line, and the bar while it moves. */
function SyncHero({ summary, action, rate }) {
	const progress = summary.progress;
	const eta = progress ? etaText(progress.total - progress.done, rate) : "";
	const icon =
		summary.tone === "ok" ? "checkCircle" : summary.tone === "danger" ? "alertCircle" : summary.tone === "warn" ? "alertTriangle" : "drive";
	return html`<div class=${`sync-hero tone-${summary.tone}`}>
		<span class="sync-mark" aria-hidden="true">${summary.tone === "busy" ? html`<${Spinner} size=${18} />` : html`<${Icon} name=${icon} size=${20} />`}</span>
		<div class="sync-hero-text" role="status">
			<strong class="sync-hero-title">${summary.title}</strong>
			${summary.detail ? html`<span class="sync-hero-detail">${summary.detail}${eta ? ` · ${eta}` : ""}</span>` : null}
		</div>
		${action || null}
		${progress
			? html`<span class="sync-bar" role="progressbar" aria-valuemin="0" aria-valuemax=${progress.total} aria-valuenow=${progress.done}><i style=${{ width: `${progress.percent}%` }} /></span>`
			: summary.tone === "busy"
				? html`<span class="sync-bar moving" role="progressbar"><i /></span>`
				: null}
	</div>`;
}

/** One line of "what travels": a check mark, what it is, and the few words that say what that covers. */
function Travels({ label, description, on = true, children }) {
	return html`<div class="set-row sync-travels">
		<span class=${`sync-tick ${on ? "on" : ""}`} aria-hidden="true"><${Icon} name=${on ? "check" : "minus"} size=${13} /></span>
		<div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc">${description}</span>` : null}</div>
		${children ? html`<div class="set-control">${children}</div>` : null}
	</div>`;
}

/**
 * The built-in browser (desktop app only). Bookmarks, shortcuts and site settings ride on the normal sync; sign-ins and
 * saved passwords only once a sync passphrase seals them on this computer (packages/desktop/browser-sync.cjs).
 */
function BrowserRows({ syncing }) {
	const host = globalThis.myHarnessDesktop;
	const [state, setState] = useState(null);
	const [phrase, setPhrase] = useState("");
	const [busy, setBusy] = useState("");
	useEffect(() => {
		let live = true;
		const load = () =>
			host
				.browser({ action: "syncStatus" })
				.then((value) => live && setState(value))
				.catch(() => {});
		void load();
		const timer = setInterval(load, 15_000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
	const run = async (key, command, success) => {
		setBusy(key);
		try {
			setState(await host.browser(command));
			if (success) toast(t(success), "success");
			return true;
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
			return false;
		} finally {
			setBusy("");
		}
	};
	const on = state?.on === true;
	// Today's seal by its clock time, an older one by its date: the line has to fit beside the button.
	const sealedAt = state?.lastSealAt ? new Date(state.lastSealAt) : null;
	const sealed = sealedAt
		? t("Sealed {time}", {
				time:
					sealedAt.toDateString() === new Date().toDateString()
						? sealedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
						: sealedAt.toLocaleDateString(),
			})
		: t("Not sealed yet");
	return html`
		<${Travels} on=${syncing} label=${t("Built-in browser")} description=${t("Bookmarks, new-tab shortcuts and site settings such as zoom, dark mode and permissions.")} />
		<div class=${`set-row sync-travels ${on ? "" : "wide"}`}>
			<span class=${`sync-tick ${on && syncing ? "on" : ""}`} aria-hidden="true"><${Icon} name=${on && syncing ? "check" : "minus"} size=${13} /></span>
			<div class="set-text">
				<span class="set-label">${t("Website sign-ins and saved passwords")}</span>
				<span class="set-desc">${on
					? t("Sealed with your sync passphrase before upload. Some sites, such as Google, may ask you to sign in again.")
					: t("Off until you set a sync passphrase. They are encrypted with it on this computer before upload; use the same one on each computer.")}</span>
			</div>
			<div class="set-control">
				${on
					? html`<div class="row sync-field">
							<span class="dim truncate grow" role="status" title=${state?.others ? t("{count} other computers have sealed theirs", { count: state.others }) : ""}>${sealed}</span>
							<button class="btn" disabled=${busy === "off"} onClick=${() => run("off", { action: "syncOff" }, "Sign-in sync is off on this computer.")}>${t("Turn off")}</button>
						</div>`
					: html`<form
							class="row sync-field"
							onSubmit=${async (event) => {
								event.preventDefault();
								if (await run("on", { action: "syncPassphrase", passphrase: phrase }, "Sign-in sync is on.")) setPhrase("");
							}}
						>
							<input
								class="field grow"
								type="password"
								value=${phrase}
								minlength="8"
								placeholder=${t("Sync passphrase, at least 8 characters")}
								autocomplete="new-password"
								disabled=${state && !state.available}
								onInput=${(event) => setPhrase(event.target.value)}
							/>
							<button class="btn primary" type="submit" disabled=${busy === "on" || phrase.length < 8 || (state && !state.available)}>${busy === "on" ? t("Verifying…") : t("Turn on")}</button>
						</form>`}
			</div>
		</div>
		${state?.unreadable?.length
			? html`<div class="notice warn">${t("This passphrase does not open the sign-ins from {names}. Enter the same passphrase on every computer.", { names: state.unreadable.join(", ") })}</div>`
			: null}`;
}

export function SyncPage() {
	const status = useStore((s) => s.syncStatus);
	const [busy, setBusy] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [deviceName, setDeviceName] = useState("");
	const [clientTouched, setClientTouched] = useState(false);
	const [deviceTouched, setDeviceTouched] = useState(false);
	// null until the user toggles it: Advanced then opens by itself only when nothing else can sign in.
	const [advancedOpen, setAdvancedOpen] = useState(null);
	const rate = useRate(status?.progress && status.progress.total > 0 ? status.progress : null);

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const data = await api("/api/sync/state", { timeoutMs: 10_000 });
				if (!cancelled && data?.status) set({ syncStatus: data.status });
			} catch {
				// The polling pass simply tries again; the page keeps the last state it had.
			}
		};
		void refresh();
		const timer = setInterval(refresh, 2500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		if (!status) return;
		if (!clientTouched) setClientId(status.clientConfigured ? (status.clientId ?? "") : "");
		if (!deviceTouched) setDeviceName(status.deviceName ?? "");
	}, [status?.deviceName, status?.clientConfigured, status?.clientId]);

	const run = async (key, action, success) => {
		setBusy(key);
		try {
			const result = await action();
			if (result?.status) set({ syncStatus: result.status });
			if (success) toast(t(success), "success");
			return result;
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
			return null;
		} finally {
			setBusy("");
		}
	};

	if (!status) return html`<div class="row"><${Spinner} /></div>`;

	const sync = deriveSync(status);
	const summary = syncSummary(status, sync);
	const folder = status.folder;
	const account = status.account;
	// With MyHarness's own Google app a sign-in is all it takes; a client of the user's own is needed only without one.
	const canSignIn = (status.clientConfigured && status.clientSecretConfigured) || !!status.builtInClient;
	const advancedShown = advancedOpen ?? (!status.connected && !canSignIn);
	const risk = status.externalRisk ?? { detected: false };
	const files = sync.files;
	const fileWorkspaces = sync.workspaces;
	const pendingBindings = sync.pendingBindings;
	const syncing = status.connected && status.enabled && !status.paused;

	const manual = status.manual ?? null;
	// Off means nothing is uploaded or applied; the manual runs respect it instead of overriding it.
	const manualBlocked = !status.connected || status.paused || manual?.state === "running";

	const saveConfig = (patch) => run("config", () => post("/api/sync/config", patch));

	const connect = () =>
		run(
			"connect",
			async () => {
				const result = await post("/api/sync/connect");
				toast(t("Finish the Google sign-in in the browser. This page updates by itself."), "info", 8000);
				return result;
			},
			null,
		);

	const disconnect = async () => {
		const ok = await confirmDialog({
			title: t("Disconnect Google Drive?"),
			message: status.signInRequired
				? t("Sync stops on this computer and MyHarness shows the sign-in screen until you sign in again. Local chats and memories stay; the cloud copy is not deleted.")
				: t("Sync stops on this computer. Local chats and memories stay; the cloud copy is not deleted."),
			confirmLabel: t("Disconnect"),
			danger: true,
		});
		if (ok) await run("disconnect", () => post("/api/sync/disconnect"), "Google Drive disconnected.");
	};

	// A browser window that was closed leaves the pending flow waiting for its timeout; this clears it at once.
	const cancelWait = () => run("disconnect", () => post("/api/sync/disconnect"), "Authorization canceled.");

	const chooseFolder = async (workspaceId) => {
		setBusy(`bind:${workspaceId}`);
		let pickedPath = "";
		try {
			const picked = await post("/api/fs/pick-folder", { title: t("Choose this workspace's folder") });
			if (!picked?.path) return;
			pickedPath = picked.path;
			const result = await post("/api/sync/bind", { workspaceId, rootPath: picked.path });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("Workspace folder bound."), "success");
		} catch (error) {
			// A folder can be held by a Workspace that was removed from the sidebar. Offer the one safe action:
			// move the hidden record's binding to an internal folder, keep its chats, and retry the bind.
			if (pickedPath) {
				const answer = await post("/api/sync/occupancy", { workspaceId, rootPath: pickedPath }).catch(() => null);
				const occupant = answer?.occupancy;
				if (occupant?.hidden) {
					const ok = await confirmDialog({
						title: t("This folder is held by a hidden workspace"),
						message: t(
							"{name} ({id}) was removed from the sidebar but still keeps {count} chats. Releasing it moves only its folder binding to an internal folder; its chats stay reachable and its files do not move.",
							{ name: occupant.name, id: occupant.workspaceId, count: occupant.chatCount },
						),
						confirmLabel: t("Release and bind"),
					});
					if (ok) {
						await post("/api/sync/release-occupant", {
							workspaceId: occupant.workspaceId,
							confirmed: true,
						});
						const result = await post("/api/sync/bind", { workspaceId, rootPath: pickedPath });
						if (result?.status) set({ syncStatus: result.status });
						toast(t("Workspace folder bound."), "success");
						return;
					}
				} else if (occupant) {
					// A folder belongs to one Workspace on a device. The restored one joins the Workspace that holds it.
					const ok = await confirmDialog({
						title: t("Merge into {name}?", { name: occupant.name }),
						message: t(
							"{name} on this computer already uses this folder ({count} chats). Merging moves the chats and memories of the workspace restored from the other computer into {name}, on every computer, and removes the restored workspace from the lists. Nothing is deleted.",
							{ name: occupant.name, count: occupant.chatCount },
						),
						confirmLabel: t("Merge"),
					});
					if (!ok) return;
					try {
						const result = await post("/api/sync/merge-workspace", {
							workspaceId,
							targetWorkspaceId: occupant.workspaceId,
							confirmed: true,
						});
						if (result?.status) set({ syncStatus: result.status });
						const kept = result?.merged?.kept?.length ?? 0;
						toast(
							kept
								? t("Merged into {name}. {count} items with a name {name} already uses stayed with the restored workspace.", {
										name: occupant.name,
										count: kept,
									})
								: t("Merged into {name}.", { name: occupant.name }),
							kept ? "warning" : "success",
						);
					} catch (mergeError) {
						toast(mergeError?.message || t("The operation failed."), "error", 7000);
					}
					return;
				}
			}
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const enableFiles = async (workspaceId) => {
		setBusy(`files:${workspaceId}`);
		try {
			const answer = await post("/api/sync/workspace-source", { workspaceId });
			const source = answer?.source ?? {};
			if (source.provider) {
				// Another client already syncs this folder; two writers on the same files is exactly the failure mode we refuse.
				toast(
					t("This folder is inside {provider}. Turn that client's sync off for it first, or keep it managed there.", {
						provider: source.provider,
					}),
					"error",
					9000,
				);
				return;
			}
			if (source.source === "drive" && source.driveRootId && source.driveRelativePath) {
				const result = await post("/api/sync/files/enable", {
					workspaceId,
					source: "drive",
					driveRootId: source.driveRootId,
					driveRelativePath: source.driveRelativePath,
				});
				if (result?.status) set({ syncStatus: result.status });
				toast(t("File sync is on. This folder stays owned by the Google Drive client."), "success", 6000);
				return;
			}
			const preview = await post("/api/sync/files/preflight", { workspaceId });
			const scan = preview?.preflight;
			if (!scan?.ok) throw new Error(scan?.error || t("The workspace folder is not available."));
			const ok = await confirmDialog({
				title: t("Upload this folder to Google Drive?"),
				message: t(
					"{files} files ({size}) will be uploaded from {path}. Excluded: {excluded}. Possible secret files found: {secrets}.",
					{
						files: scan.files,
						size: formatBytes(scan.bytes),
						path: scan.path,
						excluded: (scan.excluded ?? []).join(", "),
						secrets: (scan.secrets ?? []).length,
					},
				),
				confirmLabel: t("Start syncing files"),
			});
			if (!ok) return;
			const result = await post("/api/sync/files/enable", { workspaceId, source: "local", confirmed: true });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("File sync is on. The first upload runs in the background."), "success", 6000);
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const disableFiles = async (workspaceId) => {
		const ok = await confirmDialog({
			title: t("Stop syncing this folder's files?"),
			message: t("Files stay where they are. Changes stop being uploaded or applied on this computer."),
			confirmLabel: t("Stop syncing files"),
			danger: true,
		});
		if (!ok) return;
		setBusy(`files:${workspaceId}`);
		try {
			const result = await post("/api/sync/files/disable", { workspaceId });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("File sync stopped for this workspace."), "info");
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const confirmFileDeletes = async (workspaceId) => {
		const ok = await confirmDialog({
			title: t("Confirm the waiting deletions?"),
			message: t("Other computers will delete these files too. A copy is kept under the agent folder first."),
			confirmLabel: t("Delete on every computer"),
			danger: true,
		});
		if (!ok) return;
		setBusy(`deletes:${workspaceId}`);
		try {
			const result = await post("/api/sync/files/confirm-deletes", { workspaceId });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("The deletions are confirmed and queued for upload."), "info");
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const syncNow = () =>
		run("sync", async () => {
			// The built-in browser seals its sign-ins first, so this pass uploads them too.
			await globalThis.myHarnessDesktop?.browser?.({ action: "syncNow" }).catch(() => {});
			return post("/api/sync/sync");
		});
	const turnOn = () => saveConfig({ enabled: true, paused: false });

	const heroAction =
		summary.action === "connect"
			? html`<button class="btn primary" disabled=${busy === "connect" || !canSignIn} onClick=${connect}>${busy === "connect" ? t("Opening…") : t("Connect Google Drive")}</button>`
			: summary.action === "cancel"
				? html`<button class="btn" disabled=${busy === "disconnect"} onClick=${cancelWait}>${t("Cancel waiting")}</button>`
				: summary.action === "signin"
					? html`<button class="btn primary" disabled=${busy === "connect"} onClick=${connect}>${busy === "connect" ? t("Opening…") : t("Sign in again")}</button>`
					: summary.action === "resume"
						? html`<button class="btn primary" disabled=${busy === "config"} onClick=${turnOn}>${t("Turn sync on")}</button>`
						: html`<button class="btn" disabled=${manualBlocked || busy === "sync"} onClick=${syncNow}><${Icon} name="refresh" size=${14} />${t("Sync now")}</button>`;

	const filesOn = (item) => item.managed || item.source === "drive";

	return html`
		${risk.detected ? html`<div class="notice danger">${t(risk.message ?? "The operation failed.")}</div>` : null}
		<section class="set-card sync-top">
			<${SyncHero} summary=${summary} action=${heroAction} rate=${rate} />
			${!status.connected && !canSignIn
				? html`<div class="notice warn sync-inset">${t("Signing in needs a Google OAuth client first. Open Advanced below and paste its client ID and secret.")}</div>`
				: null}
			${status.connected
				? html`<div class="set-card-body">
						<${Row} label=${t("Automatic sync")} description=${t("Changes upload a moment after you make them; what your other computers did arrives by itself.")}>
							<${Toggle}
								checked=${syncing}
								disabled=${busy === "config"}
								label=${t("Automatic sync")}
								onChange=${(value) => (value ? turnOn() : saveConfig({ paused: true }))}
							/>
						<//>
						<${Row} label=${t("Google account")} description=${account?.email || t("Connected")}>
							<button class="btn" disabled=${busy === "disconnect"} onClick=${disconnect}>${t("Disconnect")}</button>
						<//>
					</div>`
				: null}
		</section>
		${sync.needsYou > 0
			? html`<${Card} title=${t("Needs you")} id="sync-needs" description=${t("Sync goes on meanwhile. These are the only things it cannot decide for you.")}>
					${sync.massDeletes.map(
						(issue) => html`<div class="set-row sync-full" key=${issue.key} title=${issue.detail}>
							<div class="set-text"><span class="set-label">${t("A large deletion was held back")}</span><span class="set-desc">${massDeleteText(issue)} ${t("If the data folder was moved, put it back. If you really deleted them, nothing else is needed here.")}</span></div>
						</div>`,
					)}
					${pendingBindings.map(
						(item) => html`<${Row} key=${item.workspaceId} label=${t("Pick a folder for {name}", { name: item.name })} description=${t("This workspace came from another computer. Its chats and memories already work; its files need a folder on this one.")} stack=${true}>
							<div class="row sync-field"><span class="dim mono truncate grow" title=${item.hint || item.path}>${item.hint || item.path}</span>
								<button class="btn primary" disabled=${busy === `bind:${item.workspaceId}`} onClick=${() => chooseFolder(item.workspaceId)}>${t("Choose folder")}</button>
							</div>
						<//>`,
					)}
					${sync.blocked.map(
						(item) => html`<${Row} key=${item.workspaceId} label=${t("Confirm deleting files in {name}", { name: item.name })} description=${item.message} stack=${true}>
							<div class="row sync-field"><span class="grow" />
								<button class="btn danger" disabled=${busy === `deletes:${item.workspaceId}`} onClick=${() => confirmFileDeletes(item.workspaceId)}>${t("Delete on every computer")}</button>
							</div>
						<//>`,
					)}
				<//>`
			: null}
		<${Card} title=${t("What travels")} description=${t("Kept the same on every computer you connect. When two computers change the same thing, the later change wins.")}>
			<${Travels} on=${syncing} label=${t("Chats and memories")} description=${t("General-mode chats with their attachments and files, every memory, drafts, your prompts and scheduled tasks.")} />
			<${Travels} on=${syncing} label=${t("Settings and keys")} description=${t("Providers and their models, which model does which job, model prompts, and API keys. Keys are stored in your own Google Drive, not encrypted separately.")} />
			${typeof globalThis.myHarnessDesktop?.browser === "function" ? html`<${BrowserRows} syncing=${syncing} />` : null}
			${fileWorkspaces.map(
				(item) => html`<${Travels}
					key=${item.workspaceId}
					on=${filesOn(item) && syncing}
					label=${t("Files of {name}", { name: item.name })}
					description=${item.receiving
						? t("Receiving {done} of {total} files ({size} so far).", { done: item.receiving.done, total: item.receiving.total, size: formatBytes(item.receiving.bytes) })
						: filesOn(item)
							? item.message
							: item.path || t("Not synced. Turn it on to keep this folder the same on your computers.")}
				>
					${item.managed
						? html`<button class="btn" disabled=${busy === `files:${item.workspaceId}`} onClick=${() => disableFiles(item.workspaceId)}>${t("Stop")}</button>`
						: item.source === "drive"
							? null
							: html`<button class="btn" disabled=${!status.connected || busy === `files:${item.workspaceId}`} onClick=${() => enableFiles(item.workspaceId)}>${t("Sync files")}</button>`}
				<//>`,
			)}
			<${Travels} on=${false} label=${t("Stays on this computer")} description=${t("Coding-mode chats and repositories, sign-ins to model providers, and settings that belong to one computer such as proxies and folders.")} />
		<//>
		<section class="set-card collapsible">
			<button class="set-card-head set-card-toggle sync-advanced" aria-expanded=${advancedShown} onClick=${() => setAdvancedOpen(!advancedShown)}>
				<${Icon} name="chevronRight" size=${13} class="disclose" /><strong class="grow">${t("Advanced")}</strong>
				<span class="dim">${t("Name, Drive folder, details")}</span>
			</button>
			<${Collapse} open=${advancedShown}>
				<div class="set-card-body">
					<${Row} label=${t("This computer's name")} description=${t("How your other computers call this one.")}>
						<div class="row sync-field">
							<input
								class="field"
								value=${deviceName}
								maxlength="80"
								spellcheck="false"
								onInput=${(event) => {
									setDeviceTouched(true);
									setDeviceName(event.target.value);
								}}
							/>
							<button
								class="btn"
								disabled=${busy === "device" || !deviceName.trim() || deviceName.trim() === status.deviceName}
								onClick=${async () => {
									setDeviceTouched(false);
									await run("device", () => post("/api/sync/config", { deviceName: deviceName.trim() }));
								}}
							>${t("Save")}</button>
						</div>
					<//>
					${folder
						? html`<${Row} label=${t("Folder in Google Drive")} description=${t("Everything is kept in this one folder. Renaming it in Drive is fine.")}>
								<a class="btn" href=${folder.url} target="_blank" rel="noreferrer" data-link-system><${Icon} name="drive" size=${14} />${folder.name}</a>
							<//>`
						: null}
					${status.connected
						? html`<${Row}
								label=${t("Last activity")}
								description=${t("Checked {check} · uploaded {up} · downloaded {down}", {
									check: agoText(status.lastCheckAt) || t("not yet"),
									up: agoText(status.lastUploadAt) || t("not yet"),
									down: agoText(status.lastDownloadAt) || t("not yet"),
								})}
							>
								<button class="btn" disabled=${manualBlocked || busy === "download"} title=${t("Fetches what your other computers did without uploading anything from this one.")} onClick=${() => run("download", () => post("/api/sync/download"))}>
									<${Icon} name="download" size=${14} />${t("Download only")}
								</button>
							<//>`
						: null}
					${sync.retrying.length > 0 || sync.failing.length > 0
						? html`<div class="set-row wide">
								<div class="set-text"><span class="set-label">${t("Being retried in the background")}</span><span class="set-desc">${t("Nothing to do: these are tried again by themselves.")}</span></div>
								<div class="set-control sync-paths">
									${sync.retrying.slice(-5).map((issue) => html`<span class="dim sync-path" key=${issue.key}>${issue.detail || issue.reason} · ${agoText(issue.at)}</span>`)}
									${sync.failing.map((item) => html`<span class="dim sync-path" key=${item.workspaceId}>${item.name}: ${item.message}</span>`)}
								</div>
							</div>`
						: null}
					${files?.historyNote ? html`<div class="set-desc sync-note">${t(files.historyNote)}</div>` : null}
					<${Row}
						label=${t("Your own Google OAuth client")}
						description=${t("Only if you do not want to sign in through MyHarness's own Google app: paste the client ID of a Google Cloud desktop OAuth client.")}
						wide=${true}
					>
						<div class="row sync-field">
							<input
								class="field grow"
								value=${clientId}
								placeholder="1234567890-…apps.googleusercontent.com"
								spellcheck="false"
								autocomplete="off"
								onInput=${(event) => {
									setClientTouched(true);
									setClientId(event.target.value);
								}}
							/>
							<button
								class="btn"
								disabled=${busy === "client" || !clientId.trim() || clientId.trim() === (status.clientId ?? "")}
								onClick=${async () => {
									setClientTouched(false);
									await run("client", () => post("/api/sync/config", { clientId: clientId.trim() }));
								}}
							>${t("Save")}</button>
						</div>
					<//>
					<${Row}
						label=${t("OAuth client secret")}
						description=${status.clientSecretConfigured
							? t("A secret is saved on this computer. Paste a new one only to replace it.")
							: t("Google rejects the token exchange without it, even with PKCE.")}
						wide=${true}
					>
						<div class="row sync-field">
							<input
								class="field grow"
								type="password"
								value=${clientSecret}
								placeholder=${status.clientSecretConfigured ? "••••••••" : "GOCSPX-…"}
								spellcheck="false"
								autocomplete="off"
								onInput=${(event) => setClientSecret(event.target.value)}
							/>
							<button
								class="btn"
								disabled=${busy === "secret" || !clientSecret.trim()}
								onClick=${async () => {
									const result = await run(
										"secret",
										() => post("/api/sync/config", { clientSecret: clientSecret.trim() }),
										"Client secret saved.",
									);
									if (result) setClientSecret("");
								}}
							>${t("Save")}</button>
						</div>
					<//>
					<div class="set-desc sync-note">${t("The Google sign-in of this page is kept in a file only your Windows user can read. It is not encrypted separately, and neither is what is stored in Drive.")}</div>
				</div>
			<//>
		</section>`;
}
