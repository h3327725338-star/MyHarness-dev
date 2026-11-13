// The PC side of the drawer: the PC's chats as its own sidebar shows them. A Coding / General switch picks the mode;
// below it the mode's Workspaces, each a group that folds, then "Default" (chats that belong to no Workspace), the chats
// scheduled tasks started and the chats in worktree copies. The groups come from pc-groups.js; their lists are read
// through backend-remote.js.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useMemo, useState } from "/shared/ui.js";
import { pc } from "./backend-remote.js";
import { Icon } from "./micons.js";
import { haptic } from "./native.js";
import { setShownMode } from "./prefs.js";
import { buildGroups, chatModeOf } from "./pc-groups.js";
import { attempt, useStore } from "./store.js";

// As many rows as the desktop shows in a group before "Show more".
const ROWS_SHOWN = 12;
// Named as on the desktop, whose switch puts Coding first.
const MODES = [
	{ value: "coding", label: "Coding" },
	{ value: "general", label: "General" },
];

/** The Coding / General switch of the PC side. */
export function ModeTabs() {
	const mode = useStore((s) => s.pc.listMode);
	const index = MODES.findIndex((entry) => entry.value === mode);
	// The other mode's colours spread from the middle of the side that was tapped.
	const pick = (value, event) => {
		if (value === mode) return;
		haptic("tick");
		const box = event.currentTarget.getBoundingClientRect();
		setShownMode(value, { origin: { x: box.left + box.width / 2, y: box.top + box.height / 2 }, change: () => pc.setListMode(value) });
	};
	return html`<div class="seg seg-sm mode-tabs" role="tablist" aria-label=${t("Chat mode on the PC")}>
		<span class="seg-thumb" data-mode=${mode} style=${`width:calc((100% - 6px) / 2);transform:translateX(${index * 100}%)`}></span>
		${MODES.map(
			(entry) => html`<button key=${entry.value} role="tab" data-mode=${entry.value} aria-selected=${entry.value === mode ? "true" : "false"} class=${entry.value === mode ? "on" : ""} onClick=${(event) => pick(entry.value, event)}>${entry.label}</button>`,
		)}
	</div>`;
}

const rowTitle = (row) => row.name || (row.firstMessage || "").split("\n")[0].slice(0, 60) || t("New chat");

function groupName(group) {
	if (group.kind === "default") return t("Default");
	if (group.kind === "scheduled") return t("Scheduled tasks");
	if (group.kind === "copies") return t("Copy chats");
	return group.name;
}

function emptyNote(group) {
	if (group.kind === "default") return t("No chats without a workspace");
	return t("No chats yet");
}

function Group({ group, Row, onOpen, onNew, online, inWorkspace, searching }) {
	const [all, setAll] = useState(false);
	const [more, setMore] = useState(false);
	const rows = group.rows || [];
	const shown = all || searching ? rows : rows.slice(0, ROWS_SHOWN);
	const toggle = () => {
		haptic("tick");
		pc.setGroupOpen(group.key, !group.open);
	};
	const loadMore = async () => {
		setMore(true);
		await attempt(() => pc.loadMore(group));
		setMore(false);
	};
	// "Default" starts a chat without a Workspace; a Workspace's own button only on a PC that takes a Workspace from a phone.
	const startable = online && (group.kind === "default" || (group.kind === "workspace" && !group.missing && inWorkspace));
	return html`<div class="pc-group">
		<div class="group-label tap pc-ghead" aria-expanded=${group.open ? "true" : "false"}>
			<button class="pc-gtoggle" onClick=${toggle} aria-expanded=${group.open ? "true" : "false"}>
				<span class="disclose"><${Icon} name="chevronRight" size=${14} /></span>
				<span class="gname">${groupName(group)}</span>
				${group.missing ? html`<span class="gmeta" title=${t("The folder of this workspace is missing on the PC.")}>${t("Folder missing")}</span>` : null}
				${!group.open && group.signal ? html`<span class="dot live"></span>` : null}
			</button>
			${startable ? html`<button class="icon-btn pc-gnew" onClick=${() => onNew(group)} aria-label=${group.kind === "default" ? t("New chat") : t("New chat in this workspace")}><${Icon} name="plus" size=${16} /></button>` : null}
		</div>
		${group.open
			? html`<div class="pc-gbody">
					${group.loading
						? html`<div class="pc-gnote"><${Spinner} size=${14} /> ${t("Loading…")}</div>`
						: group.error && !rows.length
							? html`<div class="pc-gnote">${group.error} <button class="btn sm" onClick=${() => attempt(() => pc.refreshChats())}>${t("Retry")}</button></div>`
							: !rows.length
								? html`<div class="pc-gnote">${emptyNote(group)}</div>`
								: shown.map((row) => html`<${Row} key=${row.path} chat=${{ id: row.slot ? `slot:${row.slot}` : `file:${row.path}`, title: rowTitle(row), running: row.running, waiting: row.waiting, unread: row.unread, pinned: row.pinned }} on=${row.current} onOpen=${() => onOpen(row)} />`)}
					${!searching && rows.length > ROWS_SHOWN && !all ? html`<button class="pc-more" onClick=${() => setAll(true)}>${t("Show more chats")} <span class="dim">${rows.length - ROWS_SHOWN}</span></button>` : null}
					${!searching && (all || rows.length <= ROWS_SHOWN) && group.hasMore ? html`<button class="pc-more" disabled=${more} onClick=${loadMore}>${more ? html`<${Spinner} size=${13} />` : null}${t("Load more from the PC")}</button>` : null}
				</div>`
			: null}
	</div>`;
}

/** The PC's chats of the mode the switch shows, grouped. `Row` draws one chat (the drawer's row). */
export function PcChats({ query, Row, onOpen, onNew }) {
	const mode = useStore((s) => s.pc.listMode);
	const lists = useStore((s) => s.pc.lists[s.pc.listMode]);
	const slots = useStore((s) => s.pc.slots);
	const folds = useStore((s) => s.pc.folds[s.pc.listMode]);
	// The chat on screen: its row is marked and its Workspace's group opens by itself.
	const chatSlot = useStore((s) => s.pc.chat.slot || "");
	const chatFile = useStore((s) => s.pc.chat.file || "");
	const chatRoot = useStore((s) => (chatModeOf(s.pc.chat.mode) === s.pc.listMode ? s.pc.chat.root || "" : ""));
	const online = useStore((s) => s.pc.link.status === "online");
	const inWorkspace = pc.canStartInWorkspace();
	const searching = !!query.trim();
	useEffect(() => pc.setSearching(searching), [searching, mode]);
	const groups = useMemo(
		() =>
			buildGroups({
				lists,
				slots,
				mode,
				active: { slot: chatSlot, file: chatFile },
				currentRoot: chatRoot,
				folds,
				query,
			}),
		[lists, slots, mode, chatSlot, chatFile, chatRoot, folds, query],
	);
	if (!lists.loaded) return [0, 1, 2, 3, 4].map((index) => html`<div class="skeleton-row" key=${index} style=${`animation-delay:${index * 80}ms`}></div>`);
	if (lists.error && !lists.workspaces.length && lists.unbound === undefined) return html`<div class="list-note">${lists.error}<div><button class="btn" onClick=${() => attempt(() => pc.refreshChats())}>${t("Retry")}</button></div></div>`;
	if (searching && !groups.length) return html`<div class="list-note">${t("No chat matches.")}</div>`;
	const workspaces = groups.filter((group) => group.kind === "workspace");
	return html`<div class="pc-chats" key=${mode}>
		${workspaces.length ? html`<div class="pc-section">${t("Workspaces")}</div>` : null}
		${groups.map((group, index) => html`${index === workspaces.length && workspaces.length ? html`<div class="pc-section-gap"></div>` : null}<${Group} key=${group.key} group=${group} Row=${Row} onOpen=${onOpen} onNew=${onNew} online=${online} inWorkspace=${inWorkspace} searching=${searching} />`)}
	</div>`;
}
