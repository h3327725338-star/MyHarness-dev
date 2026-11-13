// The first screen until the phone is signed in with Google (account.js). Signing in is what lets the phone use what
// the user's PCs have (their chats, models with their keys, memories) and reach those PCs from any network, so the
// app asks for it before anything else, like MyHarness on the PC.
import { t } from "/shared/i18n.js";
import { html } from "/shared/ui.js";
import { account } from "./account.js";
import { Icon, Mark } from "./micons.js";
import { isNative } from "./native.js";
import { attempt, useStore } from "./store.js";

export function SignInGate() {
	const booted = useStore((s) => s.booted);
	const info = useStore((s) => s.account);
	if (!booted || info.skipped || (info.status !== "signedOut" && info.status !== "signingIn")) return null;
	const waiting = info.status === "signingIn";
	return html`<div class="signin" role="dialog" aria-modal="true" aria-label=${t("Sign in to MyHarness")}>
		<div class="signin-card">
			<${Mark} size=${64} />
			<h1>${t("Sign in to MyHarness")}</h1>
			<p>${t("Use the Google account MyHarness on your PC is signed in with. The phone then has your PCs' chats, models and memories, and can connect to any of your PCs that is on, from any network.")}</p>
			<button class="btn primary block signin-google" disabled=${waiting} onClick=${() => attempt(() => account.signIn(), { quiet: true })}>
				<${Icon} name=${waiting ? "clock" : "globe"} size=${18} />${waiting ? t("Finish signing in in the browser…") : t("Sign in with Google")}
			</button>
			${info.error && html`<p class="signin-error">${info.error}</p>`}
			<p class="signin-note">${t("Google shows its sign-in page in your phone's browser; afterwards it brings you back here. MyHarness can see only the files it created in your Google Drive.")}</p>
			${!isNative && html`<button class="btn block" onClick=${() => account.skip()}>${t("Preview: continue without signing in")}</button>`}
		</div>
	</div>`;
}
