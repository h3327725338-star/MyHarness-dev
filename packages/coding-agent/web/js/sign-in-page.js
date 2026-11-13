// The first screen of the desktop app while this computer is not signed in with Google. Signing in is how MyHarness
// is used here: chats, memories, Providers and settings come from the account's Drive and go back to it, so the app
// itself only opens once an account is connected. The sign-in runs in the system browser (Google does not allow it in
// an embedded page); this screen waits for it and goes away by itself when it finishes.
import { html, useEffect, useState, Collapse, Icon, Spinner } from "./ui.js";
import { api, post, set, toast, useStore } from "./store.js";
import { t } from "./i18n.js";
import { WindowControls } from "./window-controls.js";

/** Whether the app must show this screen now: the boot answer first, then the live sync status once it exists. */
export function useSignInGate() {
	const signIn = useStore((s) => s.boot.signIn);
	const status = useStore((s) => s.syncStatus);
	if (!signIn?.required) return false;
	const connected = status ? status.connected : signIn.connected;
	return !connected;
}

export function SignInScreen() {
	const status = useStore((s) => s.syncStatus);
	const boot = useStore((s) => s.boot.signIn);
	const [busy, setBusy] = useState("");
	const [advanced, setAdvanced] = useState(null);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");

	// The status event stream carries every change, but a page that opened while the stream reconnects would wait
	// for the next one: read the state now and every two seconds while this screen is up.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const data = await api("/api/sync/state", { timeoutMs: 10_000 });
				if (!cancelled && data?.status) set({ syncStatus: data.status });
			} catch {
				// Tried again on the next tick.
			}
		};
		void refresh();
		const timer = setInterval(refresh, 2000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	const authorizing = status ? status.phase === "authorizing" : !!boot?.authorizing;
	const canSignIn = status ? (status.clientConfigured && status.clientSecretConfigured) || !!status.builtInClient : true;
	const advancedOpen = advanced ?? !canSignIn;
	const error = !authorizing && status?.lastError ? status.lastError : null;
	const waitingNote = authorizing && status?.lastError ? status.lastError : "";

	const run = async (key, action) => {
		setBusy(key);
		try {
			const result = await action();
			if (result?.status) set({ syncStatus: result.status });
			return result;
		} catch (failure) {
			toast(failure?.message || t("The operation failed."), "error", 7000);
			return null;
		} finally {
			setBusy("");
		}
	};

	const signIn = () =>
		run("connect", async () => {
			await post("/api/sync/connect");
			const data = await api("/api/sync/state", { timeoutMs: 10_000 }).catch(() => null);
			return data;
		});
	// A browser window that was closed leaves the flow waiting for its timeout; this ends it at once.
	const cancel = () => run("cancel", () => post("/api/sync/disconnect"));
	const saveClient = () =>
		run("client", async () => {
			if (clientId.trim()) await post("/api/sync/config", { clientId: clientId.trim() });
			if (clientSecret.trim()) await post("/api/sync/config", { clientSecret: clientSecret.trim() });
			setClientSecret("");
			return api("/api/sync/state", { timeoutMs: 10_000 }).catch(() => null);
		});

	return html`<div class="splash sign-in-screen">
		<div class="splash-card sign-in-card">
			<span class="sign-in-mark" aria-hidden="true"><${Icon} name="drive" size=${30} /></span>
			<h2>${t("Sign in to MyHarness")}</h2>
			<div class="dim sign-in-text">
				${t("Sign in with your Google account. Your chats, memories, models and settings then stay the same on every computer and on your phone.")}
			</div>
			${authorizing
				? html`<div class="sign-in-wait" role="status">
						<${Spinner} size=${16} />
						<span>${t("Finish the sign-in in the browser window that opened. This screen goes away by itself.")}</span>
					</div>
					${waitingNote ? html`<div class="dim sign-in-note">${t(waitingNote)}</div>` : null}
					<div class="row sign-in-actions">
						<button class="btn" disabled=${busy === "cancel"} onClick=${cancel}>${t("Cancel")}</button>
					</div>`
				: html`<div class="row sign-in-actions">
						<button class="btn primary sign-in-google" disabled=${busy === "connect" || !canSignIn} onClick=${signIn}>
							${busy === "connect" ? html`<${Spinner} size=${14} />` : html`<span class="google-g" aria-hidden="true">G</span>`}
							${t("Sign in with Google")}
						</button>
					</div>`}
			${error ? html`<div class="sign-in-error" role="alert"><${Icon} name="alertCircle" size=${14} /><span>${t(error)}</span></div>` : null}
			<div class="dim sign-in-note">
				${t("MyHarness asks Google only for the files it creates in your Drive, never for the rest of it.")}
			</div>
			<button class="btn ghost sign-in-advanced" aria-expanded=${advancedOpen ? "true" : "false"} onClick=${() => setAdvanced(!advancedOpen)}>
				<${Icon} name=${advancedOpen ? "chevronDown" : "chevronRight"} size=${13} />${t("Advanced: your own Google OAuth client")}
			</button>
			<${Collapse} open=${advancedOpen}>
				<div class="sign-in-client col">
					<span class="dim">${t("Only if you do not want to sign in through MyHarness's own Google app: paste the client ID of a Google Cloud desktop OAuth client.")}</span>
					<input
						class="field"
						value=${clientId}
						placeholder=${status?.clientId || "1234567890-…apps.googleusercontent.com"}
						spellcheck="false"
						autocomplete="off"
						onInput=${(event) => setClientId(event.target.value)}
					/>
					<input
						class="field"
						type="password"
						value=${clientSecret}
						placeholder=${status?.clientSecretConfigured ? "••••••••" : "GOCSPX-…"}
						spellcheck="false"
						autocomplete="off"
						onInput=${(event) => setClientSecret(event.target.value)}
					/>
					<button class="btn" disabled=${busy === "client" || (!clientId.trim() && !clientSecret.trim())} onClick=${saveClient}>${t("Save")}</button>
				</div>
			<//>
		</div>
		<${WindowControls} bare />
	</div>`;
}
