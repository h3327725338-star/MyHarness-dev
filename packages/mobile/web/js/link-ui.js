// The connection to the PC as the page draws it: one hook (`useLinkInfo`) that every place showing the connection
// reads, and the small pieces they share. The decisions (which phase, which words) are in link-status.js.
import { t } from "/shared/i18n.js";
import { html, useEffect, useState } from "/shared/ui.js";
import { routeName } from "./backend-remote.js";
import { linkInfo, linkWords } from "./link-status.js";
import { useStore } from "./store.js";

const DOT = { ok: "ok", busy: "live", warn: "warn", bad: "bad", off: "off" };

/** The link's state worked out (link-status.js), redrawn when it changes and once a second while a countdown runs. */
export function useLinkInfo() {
	const link = useStore((s) => s.pc.link);
	// What the Google account knows of the PC this phone is connected to: is it on at all.
	const peer = useStore((s) => {
		const id = s.pc.link.paired?.kind === "account" ? s.pc.link.paired.pcId : "";
		return id ? (s.account.pcs.find((entry) => entry.id === id) ?? null) : null;
	});
	const [, tick] = useState(0);
	const counting = link.status === "connecting" || (link.status === "offline" && link.retryAt > Date.now());
	useEffect(() => {
		if (!counting) return undefined;
		const timer = setInterval(() => tick((count) => count + 1), 1000);
		return () => clearInterval(timer);
	}, [counting]);
	return linkInfo(link, { peer });
}

/** The state in short words ({ title, detail }), in the page's language. */
export const wordsOf = (info) => linkWords(info, { t, routeName });

/** The coloured dot of a state. */
export function LinkDot({ info }) {
	return html`<span class="dot ${DOT[info.tone] || "off"}"></span>`;
}

/** The first line of a PC's row in a list: its state in one word. */
export function stateWord(info) {
	return { online: t("Connected"), connecting: t("Connecting…"), reconnecting: t("Reconnecting…"), retrying: t("Retrying"), offline: t("Not reachable"), refused: t("Refused"), none: t("Off") }[info.phase];
}

/**
 * What the title bar's second line says instead of the chat's place and model while the PC is not connected: what is going
 * on ("Reconnecting…"). Empty while connected: the coloured dot says so, and the way and delay are in the drawer and in
 * Settings → PC connection; the line has room for the name, the workspace and the model only.
 */
export function headLine(info) {
	return info.phase === "none" || info.phase === "online" ? "" : wordsOf(info).title;
}
