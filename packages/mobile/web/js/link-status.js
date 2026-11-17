// What the page says about the connection to the PC, worked out from the link's state (`state.pc.link`, kept by
// backend-remote.js) and from what the Google account knows of that PC (is it on). Pure, no page state: the drawer,
// the title bar, the composer's banner and Settings → PC connection all read the same answer, so they cannot disagree.
//
// The link's fields: paired { name, … } | null; status none | connecting | online | offline; route lan | direct | relay;
// error (why the last try failed); retryAt (when the next automatic try is due, 0 when none is planned); lost (when a
// connection that had been up broke, 0 for a first try); fatal (the PC refuses this phone, no retry is planned);
// since (when the current try began); trying (routes being tried); fails ({ route: reason } of the last try); rtt (the
// last round trip to the PC in ms); host; pcVersion.

/**
 * - none: no PC chosen
 * - connecting: the first try
 * - reconnecting: a connection that was up broke, a new one is being opened
 * - retrying: the last try failed, the next one is planned (`retryIn` seconds)
 * - online
 * - offline: failed, nothing is planned (the user taps Retry)
 * - refused: the PC does not accept this phone (retrying cannot help)
 */
export function linkInfo(link, { peer = null, now = Date.now() } = {}) {
	const empty = { phase: "none", tone: "off", route: "", trying: [], elapsed: 0, retryIn: 0, reason: "", peer: "", rtt: 0, host: "", version: "", fails: {} };
	if (!link?.paired) return empty;
	let phase = "offline";
	if (link.status === "online") phase = "online";
	else if (link.status === "connecting") phase = link.lost ? "reconnecting" : "connecting";
	else if (link.status === "offline") phase = link.fatal ? "refused" : link.retryAt > now ? "retrying" : "offline";
	const tone = { online: "ok", connecting: "busy", reconnecting: "busy", retrying: "busy", offline: "warn", refused: "bad", none: "off" }[phase];
	const away = phase !== "online";
	// What the account says of the PC (account.js): switched off, or not accepting phones. Said only while the link is not up.
	const peerState = away && peer ? (peer.online === false ? "off" : peer.accepts === false ? "refuses" : "") : "";
	return {
		...empty,
		phase,
		tone,
		route: phase === "online" ? link.route || "" : "",
		trying: phase === "connecting" || phase === "reconnecting" ? link.trying || [] : [],
		elapsed: (phase === "connecting" || phase === "reconnecting") && link.since ? Math.max(0, Math.round((now - link.since) / 1000)) : 0,
		retryIn: phase === "retrying" ? Math.max(1, Math.ceil((link.retryAt - now) / 1000)) : 0,
		reason: away ? link.error || "" : "",
		peer: peerState,
		rtt: phase === "online" ? Number(link.rtt) || 0 : 0,
		host: phase === "online" ? link.host || "" : "",
		version: phase === "online" ? link.pcVersion || "" : "",
		fails: away ? link.fails || {} : {},
	};
}

/** A round trip in words: "180 ms", "1.4 s". */
export function formatLatency(ms) {
	const n = Number(ms) || 0;
	if (n <= 0) return "";
	return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

/** Whether a new round trip is different enough from the shown one to be worth redrawing for. */
export function latencyMoved(shown, next) {
	if (!next) return false;
	if (!shown) return true;
	return Math.abs(next - shown) > Math.max(80, shown * 0.3);
}

/**
 * The state as short words, for a title bar or a list: `{ title, detail }`. `t` translates, `routeName` names a route
 * (both are the page's own; passed in so this file stays free of the page).
 */
export function linkWords(info, { t, routeName }) {
	const peerNote = info.peer === "off" ? t("The PC is off, or MyHarness is closed there.") : info.peer === "refuses" ? t("The PC does not accept phones right now.") : "";
	// The reason is the message of the failed try, kept in English (link-remote.js): it is translated where it is shown. A
	// message the table does not have (one the PC sent) stays as it is.
	const reason = info.reason ? t(info.reason) : "";
	switch (info.phase) {
		case "online": {
			const parts = [routeName(info.route), formatLatency(info.rtt)].filter(Boolean);
			return { title: t("Connected"), detail: parts.join(" · ") };
		}
		case "connecting":
		case "reconnecting": {
			const routes = info.trying.map(routeName).filter(Boolean);
			const detail = [info.elapsed ? t("{seconds} s", { seconds: info.elapsed }) : "", routes.length ? t("trying {routes}", { routes: routes.join(" / ") }) : ""].filter(Boolean).join(" · ");
			return { title: info.phase === "reconnecting" ? t("Reconnecting…") : t("Connecting…"), detail };
		}
		case "retrying":
			return { title: t("Trying again in {seconds} s", { seconds: info.retryIn }), detail: peerNote || reason };
		case "refused":
			return { title: t("The PC refused this phone"), detail: reason };
		case "offline":
			// The account only says the PC has not been seen lately: that may be off, or MyHarness closed, so it is a hint, not the title.
			return { title: t("Not reachable"), detail: peerNote || reason };
		default:
			return { title: t("Not connected"), detail: "" };
	}
}
