// Ambient sign-ins stay in the provider's own program; this view never asks for or stores an API key.
import { html, useState, Collapse, CopyButton, Icon } from "./ui.js";
import { loadModels, loadProviders, post, toast } from "./store.js";
import { t } from "./i18n.js";

export function ExternalLogin({ provider }) {
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(null);
	const setup = provider.externalLogin;
	const check = async () => {
		if (busy) return;
		setBusy(true);
		setNotice(null);
		try {
			const result = await post("/api/providers/auth/check", { id: provider.id });
			await Promise.all([loadProviders(), loadModels()]);
			if (result.configured) toast(t("Signed in"), "info", 3500);
			else {
				setExpanded(true);
				setNotice({ text: t("The independent profile is not signed in yet. Complete the terminal sign-in, then check again."), error: false });
			}
		} catch (error) {
			setNotice({ text: error.rawMessage || error.message, error: true });
		} finally {
			setBusy(false);
		}
	};
	return html`<div class="col external-login">
		<div class="key-current">
			<${Icon} name="key" size=${14} />
			<span class=${`grow ${provider.configured ? "" : "dim"}`}>${provider.configured ? t("Signed in") : t("Not signed in")}</span>
			<button class="btn sm" disabled=${busy} aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>${provider.configured ? t("Sign in again") : t("Sign in")}</button>
			<button class="btn sm" disabled=${busy} onClick=${check}>${busy ? t("Checking…") : t("Check sign-in status")}</button>
		</div>
		<${Collapse} open=${expanded}><div class="col">
			<div class="pre-wrap dim pf-hint">${setup.instructions}</div>
			<div class="row"><span class="dim">${t("Sign-in command")}</span><${CopyButton} text=${setup.command} label=${t("Copy command")} /></div>
			<textarea class="field mono" rows=${5} readonly aria-label=${t("Sign-in command")} value=${setup.command} />
		</div><//>
		${notice ? html`<div class=${`notice ${notice.error ? "danger" : ""}`} role="status">${notice.text}</div>` : null}
	</div>`;
}
