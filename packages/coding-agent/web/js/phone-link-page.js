// Settings → Phone: the link the MyHarness Android app uses to control this PC. Two ways in:
// - the local network: one switch turns the gateway's server on (modes/web/phone-link/gateway.ts) and a QR code pairs
//   a phone;
// - any network, for phones signed in with this PC's Google account (phone-link/remote.ts): on by default once this
//   PC is signed in; no QR code.
// Paired phones are listed and can be removed. The page reads GET /api/phone-link and follows `phone_link_changed`.
//
// Off by default: while it is on, this PC listens on the local network, so the page says so plainly, shows the
// addresses, and explains what a paired phone may do.
import { html, useEffect, useRef, useState, CopyButton, Icon, Spinner, Toggle } from "./ui.js";
import { api, attempt, post, toast, useStore } from "./store.js";
import { confirmDialog } from "./actions.js";
import { serverText, t } from "./i18n.js";
import { relTime } from "./util.js";
import { qrMatrix, qrSvgPath } from "./qr-code.js";

/** The pairing code as a picture. Always dark on white, whatever the theme: a camera has to read it. */
function QrCode({ text }) {
	let drawn = null;
	try {
		drawn = qrSvgPath(qrMatrix(text, { level: "M" }));
	} catch {
		drawn = null;
	}
	if (!drawn) return html`<div class="notice danger">${t("The pairing code could not be drawn. Copy the pairing code instead.")}</div>`;
	return html`<svg class="phone-qr" viewBox=${`0 0 ${drawn.box} ${drawn.box}`} role="img" aria-label=${t("Pairing QR code")} shape-rendering="crispEdges">
		<rect width=${drawn.box} height=${drawn.box} fill="#fff" />
		<path d=${drawn.d} fill="#000" />
	</svg>`;
}

/** Minutes and seconds left of a pairing code, re-rendered every second. */
function useCountdown(until) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!until) return undefined;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [until]);
	const left = Math.max(0, Math.ceil(((until || 0) - now) / 1000));
	return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` };
}

function PairCard({ status, pairing, setPairing }) {
	const [busy, setBusy] = useState(false);
	const clock = useCountdown(pairing?.expiresAt);
	useEffect(() => {
		if (pairing && clock.left === 0) setPairing(null);
	}, [pairing, clock.left]);
	const start = async () => {
		setBusy(true);
		const result = await attempt(() => post("/api/phone-link/pair"));
		setBusy(false);
		if (result?.uri) setPairing(result);
	};
	return html`<div class="svc-card">
		<div class="svc-head">
			<span class="svc-logo"><${Icon} name="plus" size=${18} /></span>
			<div class="svc-title">
				<div class="svc-name"><strong>${t("Pair a phone")}</strong></div>
				<div class="svc-desc">${t("In the MyHarness app on the phone: open the PC tab, tap Connect to a PC and scan the code.")}</div>
			</div>
			<div class="svc-action">
				${pairing
					? html`<button class="btn" onClick=${() => setPairing(null)}>${t("Hide code")}</button>`
					: html`<button class="btn primary" disabled=${busy || !status.listening} onClick=${start}>${busy ? html`<${Spinner} />` : null}${t("Show pairing code")}</button>`}
			</div>
		</div>
		${pairing
			? html`<div class="phone-pair">
					<${QrCode} text=${pairing.uri} />
					<div class="phone-pair-text">
						<div class="phone-pair-title">${t("Scan with the MyHarness app")}</div>
						<div class="set-desc">${t("The code works once and expires in {time}. It holds the key of this connection: do not share a picture of it.", { time: clock.text })}</div>
						<div class="phone-pair-copy">
							<span class="set-desc">${t("No camera? Copy the pairing code and paste it in the app.")}</span>
							<${CopyButton} text=${pairing.uri} label=${t("Copy pairing code")} />
						</div>
					</div>
				</div>`
			: null}
	</div>`;
}

const TRANSPORT = { lan: "Local network", direct: "Direct connection", relay: "Through Google Drive" };

function DeviceRow({ device, reload }) {
	const remove = async () => {
		const ok = await confirmDialog({
			title: t("Remove this phone?"),
			message:
				device.source === "google"
					? t("“{name}” can no longer reach this PC. It comes back only when it signs in to Google again in the app.", { name: device.name })
					: t("“{name}” can no longer reach this PC. To use it again, pair it again with a new code.", { name: device.name }),
			confirmLabel: t("Remove"),
			danger: true,
		});
		if (ok && (await attempt(() => post("/api/phone-link/devices/remove", { id: device.id })))) reload();
	};
	const route = (device.transports || []).map((kind) => t(TRANSPORT[kind] || kind)).join(" · ");
	const state = device.connected
		? route
			? t("Connected now ({route})", { route })
			: t("Connected now")
		: device.lastSeenAt
			? t("Last seen: {time}", { time: relTime(device.lastSeenAt) })
			: t("Paired, not connected yet");
	const how = device.source === "google" ? t("Google account") : t("QR code");
	return html`<div class="svc-account">
		<span class="svc-avatar" aria-hidden="true"><${Icon} name="phone" size=${15} /></span>
		<div class="svc-account-text"><span class="truncate" title=${device.name}>${device.name}</span><span class="truncate svc-account-sub">${how} · ${state}</span></div>
		${device.connected ? html`<span class="badge ok">${t("Online")}</span>` : null}
		<div class="svc-account-actions"><button class="btn sm ghost danger" onClick=${remove}>${t("Remove")}</button></div>
	</div>`;
}

export function PhoneLinkPage() {
	const nonce = useStore((s) => s.phoneLinkNonce);
	const [status, setStatus] = useState(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [pairing, setPairing] = useState(null);
	const [port, setPort] = useState("");
	const pairingRef = useRef(null);
	pairingRef.current = pairing;

	const reload = async () => {
		try {
			const next = await api("/api/phone-link");
			setStatus(next);
			setError("");
			// The phone used the code on screen: put it away and say so.
			const shown = pairingRef.current;
			if (shown) {
				const device = next.devices.find((entry) => entry.id === shown.deviceId);
				if (device && !device.pending) {
					setPairing(null);
					toast(t("“{name}” is paired.", { name: device.name }), "info", 5000);
				} else if (!device) setPairing(null);
			}
		} catch (failure) {
			// A launch copy (a second MyHarness started from a worktree) leaves the link to the main one.
			if (failure.status === 404) setStatus({ unavailable: true });
			else setError(failure.message || String(failure));
		}
	};
	useEffect(() => {
		reload();
	}, [nonce]);
	// Who is connected changes without an event when a phone goes out of range; look again now and then.
	useEffect(() => {
		const timer = setInterval(reload, 15000);
		return () => clearInterval(timer);
	}, []);

	if (!status) return error ? html`<div class="notice danger">${serverText(error)}</div>` : html`<${Spinner} />`;
	if (status.unavailable) return html`<div class="notice">${t("The phone link is managed by the main MyHarness, not by this copy of it.")}</div>`;

	const turn = async (enabled) => {
		setBusy(true);
		const next = await attempt(() => post("/api/phone-link/enable", { enabled }));
		setBusy(false);
		if (!enabled) setPairing(null);
		if (next && typeof next === "object") setStatus(next);
	};
	const savePort = async () => {
		const value = Number(port);
		setBusy(true);
		const next = await attempt(() => post("/api/phone-link/enable", { enabled: status.enabled, port: value }));
		setBusy(false);
		if (next && typeof next === "object") {
			setStatus(next);
			setPort("");
			setPairing(null);
		}
	};
	const turnRemote = async (enabled) => {
		setBusy(true);
		const next = await attempt(() => post("/api/phone-link/remote", { enabled }));
		setBusy(false);
		if (next && typeof next === "object") setStatus(next);
	};
	const paired = status.devices.filter((device) => !device.pending);
	const remoteError = status.account?.remote?.error || status.account?.channel?.lastError || "";
	const remoteBadge = !status.remote ? { cls: "", text: t("Off") } : status.remoteActive ? { cls: "ok", text: t("On") } : { cls: "", text: t("Waiting") };
	const badge = !status.enabled ? { cls: "", text: t("Off") } : status.listening ? { cls: "ok", text: t("On") } : { cls: "danger", text: t("Not running") };
	const portDraft = port.trim();
	const portValid = /^\d+$/.test(portDraft) && Number(portDraft) >= 1024 && Number(portDraft) <= 65535 && Number(portDraft) !== status.port;

	return html`<div class="svc-page">
		${status.error ? html`<div class="notice danger">${serverText(status.error)}</div>` : null}
		<div class="svc-card">
			<div class="svc-head">
				<span class="svc-logo"><${Icon} name="phone" size=${18} /></span>
				<div class="svc-title">
					<div class="svc-name"><strong>${t("Phone link")}</strong><span class=${`badge ${badge.cls}`}>${badge.text}</span></div>
					<div class="svc-desc">${t("Lets the MyHarness app on your Android phone send messages to this PC and show its replies, over your local network.")}</div>
				</div>
				<div class="svc-action">${busy ? html`<${Spinner} />` : null}<${Toggle} checked=${status.enabled} disabled=${busy} onChange=${turn} label=${t("Phone link")} /></div>
			</div>
			${status.enabled && status.listening
				? html`<div class="svc-note">
						${status.addresses.length
							? html`<div class="phone-addresses">${t("Listening on")} ${status.addresses.map((address) => html`<code key=${address}>${address}:${status.port}</code>`)}</div>`
							: html`<div class="phone-addresses warn">${t("This PC is not connected to a network a phone could reach.")}</div>`}
						<div>${t("The phone and this PC must be on the same Wi-Fi or network. If Windows asks whether MyHarness may be reached on the network the first time, allow it for private networks.")}</div>
					</div>`
				: null}
			<div class="svc-note phone-port">
				<label for="phone-link-port">${t("Port")}</label>
				<input id="phone-link-port" class="field" inputmode="numeric" value=${port} placeholder=${String(status.port)} spellcheck="false" autocomplete="off" onInput=${(event) => setPort(event.target.value)} onKeyDown=${(event) => event.key === "Enter" && portValid && savePort()} />
				<button class="btn sm" disabled=${busy || !portValid} onClick=${savePort}>${t("Change")}</button>
				<span class="set-desc">${t("1024–65535. Paired phones find the new port again only after pairing again.")}</span>
			</div>
		</div>
		${status.enabled && status.listening ? html`<${PairCard} status=${status} pairing=${pairing} setPairing=${setPairing} />` : null}
		${status.account
			? html`<div class="svc-card">
					<div class="svc-head">
						<span class="svc-logo"><${Icon} name="globe" size=${18} /></span>
						<div class="svc-title">
							<div class="svc-name"><strong>${t("Phones of your Google account")}</strong><span class=${`badge ${remoteBadge.cls}`}>${remoteBadge.text}</span></div>
							<div class="svc-desc">${t("A phone signed in to the MyHarness app with this PC's Google account connects from any network, without a QR code: directly over the internet when it can, otherwise through files in your Google Drive (slower).")}</div>
						</div>
						<div class="svc-action"><${Toggle} checked=${status.remote} disabled=${busy} onChange=${turnRemote} label=${t("Phones of your Google account")} /></div>
					</div>
					${status.remote && !status.remoteActive
						? html`<div class="svc-note">${t("Starts once this PC is signed in with Google (Settings → Google Drive) and a phone of the account has signed in.")}</div>`
						: null}
					${remoteError ? html`<div class="svc-note warn">${serverText(remoteError)}</div>` : null}
				</div>`
			: null}
		<div class="svc-group-title">${t("Paired phones")}<span>${paired.length ? String(paired.length) : ""}</span></div>
		<div class="svc-card">
			${paired.length
				? paired.map((device) => html`<${DeviceRow} key=${device.id} device=${device} reload=${reload} />`)
				: html`<div class="phone-empty">${status.remote && status.account ? t("No phone yet. Sign in to the MyHarness app on the phone with this PC's Google account, or pair one with a QR code on the local network.") : status.enabled ? t("No phone is paired yet.") : t("Turn the phone link on to pair a phone.")}</div>`}
		</div>
		<div class="svc-foot phone-foot"><${Icon} name="lock" size=${12} /><span>${t("On the local network, phone and PC talk directly. From other networks they connect directly over the internet when they can (public STUN servers help them find the way), otherwise through files in your own Google Drive. Every message is encrypted with the phone's own key. A paired phone can read this PC's chats and have the agent act here, so connect only your own phones.")}</span></div>
	</div>`;
}
