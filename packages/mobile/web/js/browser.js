// The right pane: the built-in browser. The page itself is a native web view placed by the Android shell exactly
// over `.browser-view` (browser-model.js sends its position); this file draws everything around it: the address
// field with its suggestions, the start page (the shortcuts of the PC browser's new-tab page), the tab list,
// bookmarks and history, the search inside a page, and the way to hand a page to the conversation.
//
// The web view lies over the app's own page, so anything of the app that must cover the web content (a sheet, the
// suggestions) needs the web view hidden meanwhile. A picture of the page is put in its place first (`freeze`), so
// the page does not blink away under a menu.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/shared/ui.js";
import { relTime } from "/shared/util.js";
import { imageAttachment } from "./attachments.js";
import { nav } from "./backends.js";
import {
	activateTab,
	activeTab,
	clearBrowsingData,
	clearHistory,
	closeAllTabs,
	closeTab,
	ensureShownTab,
	findInPage,
	goBack,
	goForward,
	hostOf,
	isBookmarked,
	library,
	navigate,
	openOutside,
	openTab,
	readPage,
	reload,
	screenshotPage,
	setBounds,
	setDesktopSite,
	stopLoading,
	toUrl,
	toggleBookmark,
} from "./browser-model.js";
import { Icon } from "./micons.js";
import { copyText, haptic, isNative, onInsets, pushBack, shareText } from "./native.js";
import { prefs, setPrefs } from "./prefs.js";
import { Row, Sheet, actionSheet, confirmSheet, openSheet } from "./sheets.js";
import { emit, state, toast, useStore } from "./store.js";

const motionOn = () => document.documentElement.dataset.motion !== "off";

// ---- Site icons and the start page's shortcuts -----------------------------------------------------------------
/** The letter a site without a usable icon goes by: the first of its name, else of its host. */
function siteLetter(site) {
	const source = String(site?.title || "").trim() || hostOf(site?.url || "");
	return (Array.from(source)[0] || "?").toUpperCase();
}

function SiteIcon({ site, mini = false }) {
	// Remember which icon failed, so a changed icon gets its own chance and a failed one never comes back blank.
	const [failed, setFailed] = useState(null);
	if (site.icon && failed !== site.icon) return html`<img class="sd-favicon ${mini ? "mini" : ""}" src=${site.icon} alt="" draggable=${false} onError=${() => setFailed(site.icon)} />`;
	return html`<span class="sd-letter ${mini ? "mini" : ""}" aria-hidden="true">${siteLetter(site)}</span>`;
}

/** Call `onLong` when the finger rests on the element; the tap that follows a long press is swallowed. */
function useLongPress(onLong) {
	const timer = useRef(0);
	const fired = useRef(false);
	const cancel = () => clearTimeout(timer.current);
	useEffect(() => cancel, []);
	return {
		fired,
		handlers: {
			onPointerDown: () => {
				fired.current = false;
				if (!onLong) return;
				timer.current = setTimeout(() => {
					fired.current = true;
					haptic("long");
					onLong();
				}, 460);
			},
			onPointerUp: cancel,
			onPointerLeave: cancel,
			onPointerCancel: cancel,
			onPointerMove: (event) => (Math.abs(event.movementX) > 3 || Math.abs(event.movementY) > 3) && cancel(),
			onContextMenu: (event) => event.preventDefault(),
		},
	};
}

function DialTile({ entry, index = 0, onOpen, onOpenGroup, onMenu }) {
	const isGroup = entry.type === "group";
	// A site saved without a name shows its icon alone, as on the desktop; a group without one is called "Group".
	const title = isGroup ? entry.title || t("Group") : entry.title;
	const press = useLongPress(isGroup ? null : () => onMenu?.(entry));
	return html`<button
		class="sd-tile"
		data-sd-id=${entry.id}
		style=${`animation-delay:${Math.min(index, 14) * 18}ms`}
		aria-label=${title || hostOf(entry.url)}
		...${press.handlers}
		onClick=${(event) => {
			if (press.fired.current) return;
			haptic("tick");
			if (isGroup) onOpenGroup(entry, event.currentTarget);
			else onOpen(entry.url);
		}}
	>
		<span class="sd-icon ${isGroup ? "group" : ""}">${isGroup ? entry.items.slice(0, 4).map((site) => html`<${SiteIcon} key=${site.id} site=${site} mini />`) : html`<${SiteIcon} site=${entry} />`}</span>
		<span class="sd-label">${title}</span>
	</button>`;
}

const GROUP_MS = 280;
const GROUP_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** A group opened in place: it grows out of its tile and folds back into it, like a folder on a home screen. */
function DialGroup({ group, from, onOpen, onMenu, onClose }) {
	const backdrop = useRef(null);
	const panel = useRef(null);
	const closing = useRef(false);

	const shut = () => {
		const box = panel.current.getBoundingClientRect();
		const tile = from?.isConnected ? from.querySelector(".sd-icon")?.getBoundingClientRect() : null;
		if (!tile?.width) return { transform: "scale(0.9)", opacity: 0 };
		const scale = Math.max(0.08, Math.min(tile.width / Math.max(1, box.width), tile.height / Math.max(1, box.height)));
		return { transform: `translate(${tile.left + tile.width / 2 - (box.left + box.width / 2)}px, ${tile.top + tile.height / 2 - (box.top + box.height / 2)}px) scale(${scale})`, opacity: 0 };
	};

	useLayoutEffect(() => {
		if (!motionOn() || typeof panel.current?.animate !== "function") return;
		backdrop.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GROUP_MS, easing: GROUP_EASE });
		panel.current.animate([shut(), { transform: "none", opacity: 1 }], { duration: GROUP_MS, easing: GROUP_EASE });
		// The shortcuts inside appear a moment after the box starts to grow, so they are never seen squeezed.
		for (const [index, node] of [...panel.current.querySelectorAll(".sd-tile")].entries()) node.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 200, delay: 60 + Math.min(index, 8) * 18, easing: GROUP_EASE, fill: "backwards" });
	}, []);

	const close = () => {
		if (closing.current) return;
		closing.current = true;
		if (!motionOn() || typeof panel.current?.animate !== "function") return onClose();
		backdrop.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GROUP_MS, easing: GROUP_EASE, fill: "forwards" });
		panel.current.animate([{ transform: "none", opacity: 1 }, shut()], { duration: GROUP_MS, easing: GROUP_EASE, fill: "forwards" }).finished.then(onClose, onClose);
	};
	useEffect(() => pushBack(() => (close(), true)), []);

	return html`<div class="sd-group-backdrop" ref=${backdrop} onClick=${(event) => event.target === event.currentTarget && close()}>
		<div class="sd-group" ref=${panel} role="dialog" aria-label=${group.title || t("Group")}>
			<div class="sd-group-title">${group.title || t("Group")}</div>
			<div class="sd-grid">${group.items.map((site) => html`<${DialTile} key=${site.id} entry=${site} onOpen=${onOpen} onMenu=${onMenu} />`)}</div>
		</div>
	</div>`;
}

async function siteMenu(site) {
	const mine = !site.id && isBookmarked(site.url);
	const choice = await actionSheet({
		title: site.title || hostOf(site.url),
		sub: hostOf(site.url),
		actions: [
			{ value: "tab", label: t("Open in a new tab"), icon: "plus" },
			{ value: "copy", label: t("Copy link"), icon: "copy" },
			{ value: "share", label: t("Share link"), icon: "share" },
			mine && { value: "remove", label: t("Remove bookmark"), icon: "trash", danger: true },
		],
	});
	if (choice === "tab") openTab(site.url);
	else if (choice === "copy") (await copyText(site.url)) && toast(t("Copied"), "ok", 1400);
	else if (choice === "share") shareText(site.url);
	else if (choice === "remove") toggleBookmark(site.url, site.title);
}

/**
 * What an empty tab shows: the shortcuts of the PC browser's new-tab page (sites and groups, in the PC's order; before
 * the PC has sent them, its bookmarks), then what was bookmarked or visited on this phone.
 */
function StartPage({ onGo }) {
	useStore((s) => s.browser);
	const dial = useStore((s) => s.pcDial);
	const marks = useStore((s) => s.pcBookmarks);
	const [open, setOpen] = useState(null); // { group, from }
	const fromPc = useMemo(() => (dial.length ? dial : marks.filter((entry) => /^https?:/i.test(entry.url)).slice(0, 12).map((entry) => ({ id: `mark:${entry.url}`, type: "site", title: entry.title || "", url: entry.url, icon: entry.icon }))), [dial, marks]);
	const known = new Set(fromPc.flatMap((entry) => (entry.type === "group" ? entry.items : [entry])).map((site) => site.url));
	const own = [...library.bookmarks, ...library.history.filter((entry) => !library.bookmarks.some((mark) => mark.url === entry.url))].filter((entry) => !known.has(entry.url)).slice(0, 8);
	// A group that left the list (the PC changed its shortcuts) closes.
	const group = open && fromPc.find((entry) => entry.id === open.group.id && entry.type === "group");
	const go = (url) => {
		setOpen(null);
		onGo(url);
	};
	return html`<div class="start-page">
		${fromPc.length > 0 && html`<div class="sd-grid" role="list">${fromPc.map((entry, index) => html`<${DialTile} key=${entry.id} entry=${entry} index=${index} onOpen=${go} onOpenGroup=${(target, from) => setOpen({ group: target, from })} onMenu=${siteMenu} />`)}</div>`}
		${own.length > 0 &&
		html`<div class="sd-section">${fromPc.length > 0 ? t("On this phone") : t("Recently on this phone")}</div>
			<div class="sd-grid" role="list">${own.map((entry, index) => html`<${DialTile} key=${entry.url} entry=${{ type: "site", title: entry.title || hostOf(entry.url), url: entry.url }} index=${fromPc.length + index} onOpen=${go} onMenu=${siteMenu} />`)}</div>`}
		${fromPc.length === 0 && own.length === 0 && html`<div class="start-empty"><span class="eicon"><${Icon} name="globe" size=${26} /></span>${t("Links in a reply open here. The assistant can also open and read pages in this browser when you ask it to.")}</div>`}
		${group ? html`<${DialGroup} key=${group.id} group=${group} from=${open.from} onOpen=${go} onMenu=${siteMenu} onClose=${() => setOpen(null)} />` : null}
	</div>`;
}

// ---- Tabs, bookmarks, history ----------------------------------------------------------------------------------
function TabsSheet({ close }) {
	const tabs = useStore((s) => s.browser.tabs);
	const active = useStore((s) => s.browser.active);
	return html`<${Sheet}
		title=${t("Tabs")}
		sub=${String(tabs.length)}
		close=${close}
		footer=${html`${tabs.length > 1 ? html`<button class="btn" onClick=${() => (closeAllTabs(), close())}>${t("Close all")}</button>` : null}<button class="btn primary" onClick=${() => (openTab(""), close())}><${Icon} name="plus" size=${18} />${t("New tab")}</button>`}
	>
		${tabs.length === 0 && html`<div class="empty-state"><span class="eicon"><${Icon} name="tabs" size=${24} /></span>${t("No tabs are open.")}</div>`}
		${tabs.map(
			(tab) => html`<div class="tab-card ${tab.id === active ? "on" : ""}" key=${tab.id}>
				<button class="tmain" onClick=${() => (activateTab(tab.id), close())}>
					<div class="ttitle">${tab.pcKey ? html`<span class="tfrom"><${Icon} name="desktop" size=${12} /></span>` : null}${tab.title || (tab.url ? hostOf(tab.url) : t("New tab"))}</div>
					<div class="turl">${tab.url ? (tab.lazy ? `${t("Opened on the PC")} · ${hostOf(tab.url)}` : tab.url) : t("Start page")}</div>
				</button>
				<button class="icon-btn" onClick=${() => closeTab(tab.id)} aria-label=${t("Close tab")}><${Icon} name="x" size=${18} /></button>
			</div>`,
		)}
	<//>`;
}

function LibrarySheet({ close, kind }) {
	useStore((s) => s.browser);
	// The PCs' bookmarks (Google account), read only here: the PC's browser is the one they belong to.
	const pcMarks = useStore((s) => (kind === "bookmarks" ? s.pcBookmarks : []));
	const rows = kind === "bookmarks" ? library.bookmarks : library.history;
	return html`<${Sheet}
		title=${kind === "bookmarks" ? t("Bookmarks") : t("History")}
		close=${close}
		footer=${kind === "history" && rows.length > 0 ? html`<button class="btn danger" onClick=${() => (clearHistory(), close())}>${t("Clear history")}</button>` : null}
	>
		${rows.length === 0 && pcMarks.length === 0 && html`<div class="empty-state"><span class="eicon"><${Icon} name=${kind === "bookmarks" ? "bookmark" : "clock"} size=${24} /></span>${kind === "bookmarks" ? t("Pages you bookmark are listed here.") : t("Pages you visit are listed here.")}</div>`}
		<div class="rows">
			${rows.slice(0, 120).map(
				(row) => html`<${Row} key=${row.url + (row.ts || "")} icon="globe" title=${row.title || hostOf(row.url) || row.url} sub=${row.url} value=${row.ts ? relTime(row.ts) : ""} onClick=${() => (navigate(row.url), close())} />`,
			)}
		</div>
		${pcMarks.length > 0 &&
		html`<div class="rows-title" style="margin-top:14px">${t("From your PCs")}</div>
			<div class="rows">
				${pcMarks
					.filter((row) => /^https?:/i.test(row.url))
					.slice(0, 200)
					.map((row) => html`<${Row} key=${`pc:${row.url}`} icon="desktop" title=${row.title || hostOf(row.url) || row.url} sub=${row.url} onClick=${() => (navigate(row.url), close())} />`)}
			</div>`}
	<//>`;
}

async function sendPageToChat(withShot) {
	const tab = activeTab();
	if (!tab?.url) return;
	try {
		const page = await readPage(tab.id, 30000);
		const attachments = [{ id: `page-${Date.now()}`, type: "text", name: `${(page.title || hostOf(page.url) || "page").slice(0, 60)}.txt`, size: page.text.length, text: `${page.title}\n${page.url}\n\n${page.text}`, mimeType: "text/plain" }];
		if (withShot) {
			try {
				attachments.push(imageAttachment({ name: "page.jpg", ...(await screenshotPage(tab.id)) }));
			} catch {
				// The text alone goes.
			}
		}
		state.composerInsert = { text: "", attachments, nonce: Date.now() };
		emit();
		nav.go("chat");
		toast(t("The page was added to your message."), "ok", 2200);
	} catch (error) {
		toast(t("The page could not be read: {reason}", { reason: error.message }), "error");
	}
}

/** What the address field offers while it is typed in: a search or the address itself, then sites the user knows. */
function suggestionsFor(text, { dial, marks }) {
	const needle = text.trim().toLowerCase();
	const sites = [];
	const seen = new Set();
	const add = (url, title, icon, source) => {
		if (!/^https?:/i.test(url || "") || seen.has(url)) return;
		if (needle && !`${title || ""} ${url}`.toLowerCase().includes(needle)) return;
		seen.add(url);
		sites.push({ url, title: title || "", icon, source });
	};
	for (const entry of dial) for (const site of entry.type === "group" ? entry.items : [entry]) add(site.url, site.title, site.icon, "pc");
	for (const mark of library.bookmarks) add(mark.url, mark.title, undefined, "bookmark");
	for (const mark of marks) add(mark.url, mark.title, mark.icon, "pc");
	for (const visit of library.history) add(visit.url, visit.title, undefined, "history");
	// Without a word typed: where the user was last, then the shortcuts.
	if (!needle) return [...sites.filter((site) => site.source === "history").slice(0, 6), ...sites.filter((site) => site.source !== "history").slice(0, 8)];
	return sites.slice(0, 12);
}

function Suggestions({ text, onGo, onFill }) {
	useStore((s) => s.browser);
	const dial = useStore((s) => s.pcDial);
	const marks = useStore((s) => s.pcBookmarks);
	const rows = suggestionsFor(text, { dial, marks });
	const typed = text.trim();
	const address = typed ? toUrl(typed) : "";
	const isSearch = !!typed && !/^https?:\/\//i.test(typed) && address.includes(encodeURIComponent(typed));
	return html`<div class="suggest">
		${typed &&
		html`<button class="suggest-row top" onClick=${() => onGo(typed)}>
			<span class="sicon"><${Icon} name=${isSearch ? "search" : "globe"} size=${18} /></span>
			<span class="smain"><span class="stitle">${typed}</span><span class="ssub">${isSearch ? t("Search the web") : t("Open this address")}</span></span>
		</button>`}
		${rows.map(
			(site) => html`<div class="suggest-row" key=${site.url}>
				<button class="spick" onClick=${() => onGo(site.url)}>
					<span class="sicon"><${SiteIcon} site=${site} mini /></span>
					<span class="smain"><span class="stitle">${site.title || hostOf(site.url)}</span><span class="ssub">${site.url.replace(/^https?:\/\/(www\.)?/i, "")}</span></span>
				</button>
				<button class="icon-btn sfill" onClick=${() => onFill(site.url)} aria-label=${t("Put this address in the field")}><${Icon} name="arrowUp" size=${17} style="transform:rotate(-45deg)" /></button>
			</div>`,
		)}
		${!typed && rows.length === 0 && html`<div class="start-empty">${t("Type a search or an address.")}</div>`}
	</div>`;
}

function FindBar({ find, onClose }) {
	const [text, setText] = useState(find?.query || "");
	const input = useRef(null);
	useEffect(() => {
		const timer = setTimeout(() => input.current?.focus(), 60);
		const removeBack = pushBack(() => (onClose(), true));
		return () => {
			clearTimeout(timer);
			removeBack();
		};
	}, []);
	const search = (value) => {
		setText(value);
		findInPage(value);
	};
	return html`<form
		class="address find"
		onSubmit=${(event) => {
			event.preventDefault();
			if (text) findInPage(text, { next: true });
		}}
	>
		<${Icon} name="search" size=${16} />
		<input ref=${input} type="text" enterkeyhint="search" autocapitalize="off" autocomplete="off" spellcheck=${false} placeholder=${t("Find in this page")} value=${text} onInput=${(event) => search(event.target.value)} />
		${text ? html`<span class="find-count">${find?.count ? `${find.active} / ${find.count}` : find?.done ? "0" : ""}</span>` : null}
		<button type="button" class="icon-btn sm" disabled=${!find?.count} onClick=${() => findInPage(text, { next: true, backwards: true })} aria-label=${t("Previous match")}><${Icon} name="chevronUp" size=${18} /></button>
		<button type="button" class="icon-btn sm" disabled=${!find?.count} onClick=${() => findInPage(text, { next: true })} aria-label=${t("Next match")}><${Icon} name="chevronDown" size=${18} /></button>
	</form>`;
}

export function Browser() {
	const tabs = useStore((s) => s.browser.tabs);
	const activeId = useStore((s) => s.browser.active);
	const external = useStore((s) => s.browser.external);
	const find = useStore((s) => s.browser.find);
	const layers = useStore((s) => s.layers.length);
	const pane = useStore((s) => s.pane);
	// The pane is (partly) on screen while a finger drags it in, before it is the pane the app is on.
	const peek = useStore((s) => s.browserPeek);
	const tab = tabs.find((entry) => entry.id === activeId) || null;
	const [editing, setEditing] = useState(false);
	const [finding, setFinding] = useState(false);
	const [address, setAddress] = useState("");
	const [frozen, setFrozen] = useState(null); // a picture of the page while the web view is hidden under something
	const view = useRef(null);
	const input = useRef(null);

	const hasPage = !!tab?.url && !tab.error;
	const onScreen = pane === "browser" || peek;
	const showNative = hasPage && !tab.lazy && layers === 0 && onScreen && !editing;

	// Tell the shell where the page goes. The pane slides with a transform, which the shell follows by itself
	// (pager.js); only the box inside the pane is sent from here.
	useLayoutEffect(() => {
		const node = view.current;
		if (!node) return;
		const send = () => {
			const pager = node.closest(".pane-browser");
			const paneRect = pager.getBoundingClientRect();
			const rect = node.getBoundingClientRect();
			setBounds({ x: rect.left - paneRect.left, y: rect.top, width: rect.width, height: rect.height }, showNative);
		};
		send();
		const observer = new ResizeObserver(send);
		observer.observe(node);
		const removeInsets = onInsets(send);
		return () => {
			observer.disconnect();
			removeInsets();
		};
	}, [showNative, activeId]);

	// The web view is back over the page: its picture has done its work (it leaves a moment later, under the web view).
	useEffect(() => {
		if (!showNative || !frozen) return;
		const timer = setTimeout(() => setFrozen(null), 120);
		return () => clearTimeout(timer);
	}, [showNative, frozen]);

	// A tab that only has an address yet (a page opened on the PC) loads when the browser comes on screen.
	useEffect(() => {
		if (pane === "browser") ensureShownTab();
	}, [pane, activeId]);

	// Another tab, or away from the browser: the address being typed and the search in the page end.
	useEffect(() => {
		setEditing(false);
		if (finding) {
			setFinding(false);
			findInPage("");
		}
	}, [activeId, pane === "browser"]);

	useEffect(() => {
		if (!external) return;
		confirmSheet({ title: t("Open another app?"), message: external.url.slice(0, 200), confirmLabel: t("Open") }).then((yes) => yes && openOutside(external.url));
	}, [external?.nonce]);

	/** Put a picture of the page where the web view is, before something of the app covers it. */
	const freeze = async () => {
		if (!isNative || !showNative) return;
		try {
			const shot = await Promise.race([screenshotPage(tab.id, 720), new Promise((resolve) => setTimeout(() => resolve(null), 180))]);
			if (shot?.data) setFrozen(`data:${shot.mimeType};base64,${shot.data}`);
		} catch {
			// Without a picture the page area is plain for a moment.
		}
	};
	const over = async (open) => {
		await freeze();
		open();
	};

	const go = (text) => {
		setEditing(false);
		input.current?.blur();
		navigate(text);
	};

	const startEdit = async () => {
		await freeze();
		setAddress(tab?.url || "");
		setEditing(true);
	};
	useEffect(() => {
		if (!editing) return;
		const timer = setTimeout(() => {
			input.current?.focus();
			input.current?.select();
		}, 30);
		const removeBack = pushBack(() => (setEditing(false), true));
		return () => {
			clearTimeout(timer);
			removeBack();
		};
	}, [editing]);

	const endFind = () => {
		setFinding(false);
		findInPage("");
	};

	const pageMenu = async () => {
		const hasUrl = !!tab?.url;
		await freeze();
		const choice = await actionSheet({
			title: hasUrl ? tab.title || hostOf(tab.url) : t("Browser"),
			sub: hasUrl ? hostOf(tab.url) : "",
			actions: [
				{ value: "new", label: t("New tab"), icon: "plus" },
				hasUrl && { value: "bookmark", label: isBookmarked(tab.url) ? t("Remove bookmark") : t("Add bookmark"), icon: "bookmark", checked: isBookmarked(tab.url) },
				{ value: "bookmarks", label: t("Bookmarks"), icon: "book" },
				{ value: "history", label: t("History"), icon: "clock" },
				hasPage && { value: "find", label: t("Find in this page"), icon: "search" },
				hasPage && { value: "shot", label: t("Send page and screenshot to the chat"), icon: "image" },
				hasPage && { value: "desktop", label: t("Desktop site"), icon: "desktop", checked: !!prefs.desktopSite },
				hasUrl && { value: "share", label: t("Share link"), icon: "share" },
				hasUrl && { value: "copy", label: t("Copy link"), icon: "copy" },
				hasUrl && { value: "outside", label: t("Open in the phone's browser"), icon: "externalLink" },
				{ value: "clear", label: t("Clear cookies and site data"), icon: "trash", danger: true },
			],
		});
		if (choice === "new") openTab("");
		else if (choice === "bookmark") toast(toggleBookmark(tab.url, tab.title) ? t("Bookmarked") : t("Bookmark removed"), "ok", 1500);
		else if (choice === "bookmarks" || choice === "history") openSheet((close) => html`<${LibrarySheet} close=${close} kind=${choice} />`);
		else if (choice === "find") setFinding(true);
		else if (choice === "shot") sendPageToChat(true);
		else if (choice === "desktop") {
			setPrefs({ desktopSite: !prefs.desktopSite });
			setDesktopSite(prefs.desktopSite);
		} else if (choice === "share") shareText(tab.url);
		else if (choice === "copy") (await copyText(tab.url)) && toast(t("Copied"), "ok", 1400);
		else if (choice === "outside") openOutside(tab.url);
		else if (choice === "clear") {
			if (await confirmSheet({ title: t("Clear cookies and site data?"), message: t("You will be signed out of websites in the built-in browser."), confirmLabel: t("Clear"), danger: true })) {
				await clearBrowsingData();
				toast(t("Cleared"), "ok", 1500);
			}
		}
	};

	const secure = /^https:/i.test(tab?.url || "");
	const progress = tab?.loading ? Math.max(0.08, (tab.progress || 0) / 100) : 1;

	return html`<div class="browser ${editing ? "editing" : ""}">
		<div class="browser-bar">
			<button class="icon-btn" onClick=${() => (editing ? setEditing(false) : finding ? endFind() : nav.go("chat"))} aria-label=${editing || finding ? t("Cancel") : t("Back to the chat")}><${Icon} name=${editing || finding ? "x" : "chevronLeft"} size=${22} /></button>
			${finding && !editing
				? html`<${FindBar} find=${find} onClose=${endFind} />`
				: html`<form
						class="address"
						onSubmit=${(event) => {
							event.preventDefault();
							if (address.trim()) go(address);
						}}
					>
						${editing
							? html`<${Icon} name="search" size=${16} />
									<input ref=${input} type="text" inputmode="url" enterkeyhint="go" autocapitalize="off" autocomplete="off" spellcheck=${false} placeholder=${t("Search or enter an address")} value=${address} onInput=${(event) => setAddress(event.target.value)} />
									${address ? html`<button type="button" class="icon-btn sm" onClick=${() => (setAddress(""), input.current?.focus())} aria-label=${t("Clear")}><${Icon} name="x" size=${16} /></button>` : null}`
							: html`${tab?.url ? html`<span class="lock ${secure ? "" : "insecure"}"><${Icon} name=${secure ? "lock" : "alertTriangle"} size=${14} /></span>` : html`<${Icon} name="search" size=${16} />`}
									<button type="button" class="shown" onClick=${startEdit}>${tab?.url ? hostOf(tab.url) || tab.url : t("Search or enter an address")}</button>`}
					</form>`}
			${!editing && !finding && tab?.url && html`<button class="icon-btn" onClick=${() => (tab.loading ? stopLoading() : reload())} aria-label=${tab.loading ? t("Stop") : t("Reload")}><${Icon} name=${tab.loading ? "x" : "refresh"} size=${20} /></button>`}
			<div class="browser-progress"><i style=${`transform:scaleX(${progress});opacity:${tab?.loading ? 1 : 0}`}></i></div>
		</div>
		<div class="browser-view" ref=${view}>
			${!tab || !tab.url
				? html`<${StartPage} onGo=${go} />`
				: tab.error
					? html`<div class="browser-note">
							<${Icon} name="alertCircle" size=${30} />
							<div><strong>${t("This page did not load")}</strong></div>
							<div>${tab.error.message}</div>
							<button class="btn" onClick=${() => reload()}>${t("Try again")}</button>
						</div>`
					: tab.lazy
						? html`<div class="browser-note"><${Icon} name="desktop" size=${30} /><div><strong>${tab.title || hostOf(tab.url)}</strong></div><div>${t("The assistant opened this page on the PC. It opens here with this phone's own sign-ins.")}</div><${Spinner} size=${20} /></div>`
						: !isNative
							? html`<div class="browser-note"><${Icon} name="globe" size=${30} /><div>${hostOf(tab.url)}</div><div>${t("Web pages are shown inside the app. This preview in a desktop browser only has the controls.")}</div></div>`
							: frozen
								? html`<img class="browser-frozen" src=${frozen} alt="" />`
								: tab.loading && (tab.progress || 0) < 15
									? html`<div class="browser-note"><${Spinner} size=${22} /></div>`
									: null}
			${editing ? html`<${Suggestions} text=${address} onGo=${go} onFill=${(url) => (setAddress(url), input.current?.focus())} />` : null}
		</div>
		<div class="browser-nav">
			<button class="icon-btn" disabled=${!tab?.canGoBack} onClick=${() => goBack()} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${21} /></button>
			<button class="icon-btn" disabled=${!tab?.canGoForward} onClick=${() => goForward()} aria-label=${t("Forward")}><${Icon} name="arrowRight" size=${21} /></button>
			<button class="icon-btn" disabled=${!hasPage || tab.lazy} onClick=${() => (haptic("tick"), sendPageToChat(false))} aria-label=${t("Send page to the chat")}><${Icon} name="sparkle" size=${21} /></button>
			<button class="icon-btn" onClick=${() => over(() => openSheet((close) => html`<${TabsSheet} close=${close} />`))} aria-label=${t("Tabs")}><span class="tab-count">${tabs.length}</span></button>
			<button class="icon-btn" onClick=${pageMenu} aria-label=${t("More")}><${Icon} name="more" size=${21} /></button>
		</div>
	</div>`;
}
