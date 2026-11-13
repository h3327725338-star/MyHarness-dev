// The left pane: which side messages go to (this phone or the PC), and that side's chats.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useMemo, useRef, useState } from "/shared/ui.js";
import { pc } from "./backend-remote.js";
import { backend, nav, setMode } from "./backends.js";
import { Icon, Mark } from "./micons.js";
import { haptic } from "./native.js";
import { ModeTabs, PcChats } from "./pc-chats.js";
import { actionSheet, confirmSheet, promptSheet } from "./sheets.js";
import { attempt, side, toast, useStore } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

function dayGroup(ts, now) {
	if (!ts) return "Earlier";
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	if (ts >= startOfToday) return "Today";
	if (ts >= startOfToday - DAY) return "Yesterday";
	if (ts >= startOfToday - 7 * DAY) return "Previous 7 days";
	if (ts >= startOfToday - 30 * DAY) return "Previous 30 days";
	return "Earlier";
}

function ChatRow({ chat, on, onOpen, onMenu }) {
	const timer = useRef(0);
	const longPressed = useRef(false);
	const cancel = () => clearTimeout(timer.current);
	return html`<button
		class="chat-row ${on ? "on" : ""}"
		style="width:100%;text-align:left"
		onPointerDown=${() => {
			longPressed.current = false;
			if (!onMenu) return;
			timer.current = setTimeout(() => {
				longPressed.current = true;
				haptic("long");
				onMenu(chat);
			}, 440);
		}}
		onPointerUp=${cancel}
		onPointerLeave=${cancel}
		onPointerCancel=${cancel}
		onPointerMove=${(event) => (Math.abs(event.movementX) > 3 || Math.abs(event.movementY) > 3) && cancel()}
		onContextMenu=${(event) => event.preventDefault()}
		onClick=${() => !longPressed.current && onOpen(chat)}
	>
		<span class="ctitle">${chat.title}</span>
		${chat.place ? html`<span class="cmeta">${chat.place}</span>` : null}
		<span class="cstate">${chat.running ? html`<${Spinner} size=${13} />` : chat.waiting ? html`<span class="dot warn"></span>` : chat.unread ? html`<span class="dot live"></span>` : chat.pinned ? html`<${Icon} name="pin" size=${13} />` : null}</span>
	</button>`;
}

/** How the PC is reached now, in words. */
export function routeLabel(link) {
	if (link.route === "relay") return t("Through Google Drive");
	if (link.route === "direct") return t("Direct connection");
	if (link.route === "lan") return t("Local network");
	return "";
}

/** The PCs of the Google account, the ones that are on first; tapping one connects to it. */
export function AccountPcs({ onPicked }) {
	const pcs = useStore((s) => s.account.pcs);
	const status = useStore((s) => s.account.status);
	const current = useStore((s) => (s.pc.link.paired?.kind === "account" ? s.pc.link.paired.pcId : ""));
	if (status === "noSpace") return html`<div class="list-note">${t("No PC has used this Google account with MyHarness yet. Sign in on a PC first (MyHarness → Settings → Google Drive), keep MyHarness open there, and look again in a minute.")}</div>`;
	if (!pcs.length) return html`<div class="list-note">${status === "loading" ? html`<${Spinner} size=${18} />` : t("No PC of this Google account is on right now. Open MyHarness on a PC signed in with the same account.")}</div>`;
	const pick = async (entry) => {
		haptic("tick");
		await attempt(() => pc.connectAccount(entry));
		setMode("pc");
		onPicked?.();
	};
	return html`<div class="pc-list">
		${pcs.map(
			(entry) => html`<button class="chat-row pc-row ${entry.id === current ? "on" : ""}" key=${entry.id} disabled=${!entry.online || !entry.accepts} onClick=${() => pick(entry)} style="width:100%;text-align:left">
				<span class="ctitle"><${Icon} name="desktop" size=${16} /> ${entry.name}</span>
				<span class="cmeta">${!entry.online ? t("Off") : !entry.accepts ? t("Does not accept phones") : entry.id === current ? t("Connected") : t("On")}</span>
				<span class="cstate"><span class="dot ${entry.online && entry.accepts ? "ok" : "off"}"></span></span>
			</button>`,
		)}
	</div>`;
}

/** While a PC is being connected: how long it has taken, and which ways to it are still being tried. */
function ConnectProgress({ link }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => tick((count) => count + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const routes = (link.trying || []).map((route) => routeLabel({ route })).filter(Boolean);
	if (!routes.length || !link.since) return null;
	const seconds = Math.max(0, Math.round((Date.now() - link.since) / 1000));
	return html`<div class="connect-progress">${t("{seconds} s · trying: {routes}", { seconds, routes: routes.join(" / ") })}</div>`;
}

function LinkDot({ link }) {
	const cls = link.status === "online" ? "ok" : link.status === "connecting" ? "live" : link.paired ? "warn" : "off";
	return html`<span class="dot ${cls}"></span>`;
}

export function Drawer() {
	const mode = useStore((s) => s.mode);
	const chats = useStore((s) => side(s).chats);
	const loaded = useStore((s) => side(s).chatsLoaded);
	const activeId = useStore((s) => (s.mode === "pc" ? (side(s).chat.slot ? `slot:${side(s).chat.slot}` : "") : side(s).chat.id));
	const link = useStore((s) => s.pc.link);
	const signed = useStore((s) => s.account.status !== "signedOut");
	const [query, setQuery] = useState("");

	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const rows = needle ? chats.filter((chat) => `${chat.title} ${chat.preview || ""} ${chat.place || ""}`.toLowerCase().includes(needle)) : chats;
		const out = [];
		const push = (label, chat) => {
			let group = out.find((entry) => entry.label === label);
			if (!group) out.push((group = { label, chats: [] }));
			group.chats.push(chat);
		};
		const now = Date.now();
		for (const chat of rows) push(chat.open ? "Open on the PC" : dayGroup(chat.updatedAt, now), chat);
		return out;
	}, [chats, query]);

	const open = async (chat) => {
		haptic("tick");
		nav.go("chat");
		await attempt(() => backend().openChat(chat.id));
	};

	const newChat = async () => {
		haptic("tick");
		nav.go("chat");
		await attempt(() => backend().newChat());
	};

	// The PC side: a row of the PC's lists, and the "+" of a group (a new chat in that Workspace, or in "Default").
	const openPcRow = async (row) => {
		haptic("tick");
		nav.go("chat");
		await attempt(() => backend().openChat(row.slot ? `slot:${row.slot}` : `file:${row.path}`));
	};
	const newPcChat = async (group) => {
		haptic("tick");
		nav.go("chat");
		await attempt(() => backend().newChat(group.kind === "workspace" ? { rootPath: group.root } : {}));
	};

	const menu = async (chat) => {
		const choice = await actionSheet({
			title: chat.title,
			actions: [
				{ value: "rename", label: t("Rename"), icon: "edit" },
				{ value: "delete", label: t("Delete"), icon: "trash", danger: true },
			],
		});
		if (choice === "rename") {
			const title = await promptSheet({ title: t("Rename chat"), value: chat.title, validate: (value) => (value.trim() ? "" : t("Enter a name.")) });
			if (title) await attempt(() => backend().renameChat(chat.id, title));
		} else if (choice === "delete") {
			const sure = chat.synced
				? await confirmSheet({ title: t("Remove from this phone?"), message: t("“{title}” leaves this phone's list. The chat stays on your PCs.", { title: chat.title }), confirmLabel: t("Remove"), danger: true })
				: await confirmSheet({ title: t("Delete this chat?"), message: t("“{title}” is removed from this phone. This cannot be undone.", { title: chat.title }), confirmLabel: t("Delete"), danger: true });
			if (sure) {
				await attempt(() => backend().deleteChat(chat.id));
				toast(t("Chat deleted"), "ok", 1600);
			}
		}
	};

	const pcBlocked = mode === "pc" && link.status !== "online";

	return html`<div class="drawer">
		<div class="drawer-top">
			<div class="brand"><${Mark} size=${28} /><span class="bname">MyHarness</span></div>
			<div class="seg" role="tablist">
				<span class="seg-thumb" style=${`width:calc((100% - 6px) / 2);transform:translateX(${mode === "pc" ? 100 : 0}%)`}></span>
				<button role="tab" aria-selected=${mode === "local" ? "true" : "false"} class=${mode === "local" ? "on" : ""} onClick=${() => (haptic("tick"), setMode("local"))}><${Icon} name="phone" size=${15} />${t("This phone")}</button>
				<button role="tab" aria-selected=${mode === "pc" ? "true" : "false"} class=${mode === "pc" ? "on" : ""} onClick=${() => (haptic("tick"), setMode("pc"))}><${Icon} name="desktop" size=${15} />${t("PC")}<${LinkDot} link=${link} /></button>
			</div>
			${mode === "pc" && link.paired ? html`<${ModeTabs} />` : null}
			<label class="search-field"><${Icon} name="search" size=${17} /><input type="search" placeholder=${t("Search chats")} value=${query} onInput=${(event) => setQuery(event.target.value)} enterkeyhint="search" /></label>
			<button class="new-chat" onClick=${newChat} disabled=${pcBlocked}><span class="plus"><${Icon} name="plus" size=${18} /></span>${t("New chat")}</button>
		</div>
		<div class="drawer-list">
			${mode === "pc" && !link.paired && signed
				? html`<div class="group-label"><span class="gname">${t("Your PCs")}</span></div>
						<${AccountPcs} />
						<div class="list-note"><button class="btn" onClick=${() => nav.openLink()}><${Icon} name="qr" size=${17} />${t("Pair with a QR code instead")}</button></div>`
				: mode === "pc" && !link.paired
				? html`<div class="list-note">
						${t("Pair this phone with MyHarness on your PC. What you type here is sent to the PC, and its replies show here.")}
						<div><button class="btn primary" onClick=${() => nav.openLink()}><${Icon} name="qr" size=${17} />${t("Connect to a PC")}</button></div>
					</div>`
				: pcBlocked
					? html`<div class="list-note">
							${link.status === "connecting" ? html`<${Spinner} size=${18} />` : null}
							<div>${link.status === "connecting" ? t("Connecting to {name}…", { name: link.paired?.name || "PC" }) : link.error || t("The PC cannot be reached.")}</div>
							${link.status === "connecting" ? html`<${ConnectProgress} link=${link} />` : null}
							${link.status !== "connecting" && html`<button class="btn" onClick=${() => backend().reconnect()}>${t("Retry")}</button>`}
						</div>`
					: mode === "pc"
						? html`<${PcChats} query=${query} Row=${ChatRow} onOpen=${openPcRow} onNew=${newPcChat} />`
						: !loaded
						? [0, 1, 2, 3, 4].map((index) => html`<div class="skeleton-row" key=${index} style=${`animation-delay:${index * 80}ms`}></div>`)
						: groups.length === 0
							? html`<div class="list-note">${query ? t("No chat matches.") : mode === "pc" ? t("No chats on the PC yet.") : t("Your chats on this phone will be listed here.")}</div>`
							: groups.map(
									(group) => html`<div key=${group.label}>
										<div class="group-label"><span class="gname">${t(group.label)}</span></div>
										${group.chats.map((chat) => html`<${ChatRow} key=${chat.id} chat=${chat} on=${chat.id === activeId} onOpen=${open} onMenu=${mode === "local" ? menu : null} />`)}
									</div>`,
								)}
		</div>
		<div class="drawer-foot">
			<button class="foot-btn grow" onClick=${() => nav.openSettings()}><${Icon} name="gear" size=${20} /><span class="flabel">${t("Settings")}</span></button>
			${mode === "pc" && link.paired && html`<button class="foot-btn" onClick=${() => nav.openLink()} aria-label=${t("PC connection")}><${Icon} name="desktop" size=${20} /><span class="flabel">${link.paired.name}</span></button>`}
		</div>
	</div>`;
}
