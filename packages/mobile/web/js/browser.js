// The right pane: the built-in browser. The page itself is a native web view placed by the Android shell exactly
// over `.browser-view` (browser-model.js sends its position); this file draws everything around it: the address
// field, the tab list, bookmarks and history, and the way to hand a page to the conversation.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useLayoutEffect, useRef, useState } from "/shared/ui.js";
import { relTime } from "/shared/util.js";
import { imageAttachment } from "./attachments.js";
import { nav } from "./backends.js";
import {
	activateTab,
	activeTab,
	clearBrowsingData,
	clearHistory,
	closeTab,
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
	toggleBookmark,
} from "./browser-model.js";
import { Icon } from "./micons.js";
import { copyText, haptic, isNative, onInsets, shareText } from "./native.js";
import { prefs, setPrefs } from "./prefs.js";
import { Row, Sheet, actionSheet, confirmSheet, openSheet } from "./sheets.js";
import { emit, state, toast, useStore } from "./store.js";

function TabsSheet({ close }) {
	const tabs = useStore((s) => s.browser.tabs);
	const active = useStore((s) => s.browser.active);
	return html`<${Sheet} title=${t("Tabs")} sub=${String(tabs.length)} close=${close} footer=${html`<button class="btn primary" onClick=${() => (openTab(""), close())}><${Icon} name="plus" size=${18} />${t("New tab")}</button>`}>
		${tabs.length === 0 && html`<div class="empty-state"><span class="eicon"><${Icon} name="tabs" size=${24} /></span>${t("No tabs are open.")}</div>`}
		${tabs.map(
			(tab) => html`<div class="tab-card ${tab.id === active ? "on" : ""}" key=${tab.id}>
				<button class="tmain" onClick=${() => (activateTab(tab.id), close())}>
					<div class="ttitle">${tab.title || (tab.url ? hostOf(tab.url) : t("New tab"))}</div>
					<div class="turl">${tab.url || t("Start page")}</div>
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
		html`<div class="rows-title">${t("From your PCs")}</div>
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

async function pageMenu() {
	const tab = activeTab();
	const hasPage = !!tab?.url;
	const choice = await actionSheet({
		title: hasPage ? tab.title || hostOf(tab.url) : t("Browser"),
		sub: hasPage ? hostOf(tab.url) : "",
		actions: [
			{ value: "new", label: t("New tab"), icon: "plus" },
			hasPage && { value: "bookmark", label: isBookmarked(tab.url) ? t("Remove bookmark") : t("Add bookmark"), icon: "bookmark" },
			{ value: "bookmarks", label: t("Bookmarks"), icon: "book" },
			{ value: "history", label: t("History"), icon: "clock" },
			hasPage && { value: "shot", label: t("Send page and screenshot to the chat"), icon: "image" },
			hasPage && { value: "desktop", label: t("Desktop site"), icon: "desktop", checked: !!prefs.desktopSite },
			hasPage && { value: "share", label: t("Share link"), icon: "share" },
			hasPage && { value: "copy", label: t("Copy link"), icon: "copy" },
			hasPage && { value: "outside", label: t("Open in the phone's browser"), icon: "externalLink" },
			{ value: "clear", label: t("Clear cookies and site data"), icon: "trash", danger: true },
		],
	});
	if (choice === "new") openTab("");
	else if (choice === "bookmark") toast(toggleBookmark(tab.url, tab.title) ? t("Bookmarked") : t("Bookmark removed"), "ok", 1500);
	else if (choice === "bookmarks" || choice === "history") openSheet((close) => html`<${LibrarySheet} close=${close} kind=${choice} />`);
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
}

function StartPage({ onGo }) {
	useStore((s) => s.browser);
	const [text, setText] = useState("");
	const shortcuts = [...library.bookmarks, ...library.history.filter((entry) => !library.bookmarks.some((mark) => mark.url === entry.url))].slice(0, 8);
	return html`<div class="start-page">
		<h2>${t("Browse the web")}</h2>
		<form
			class="start-search"
			onSubmit=${(event) => {
				event.preventDefault();
				if (text.trim()) onGo(text);
			}}
		>
			<${Icon} name="search" size=${19} />
			<input type="text" inputmode="url" enterkeyhint="go" autocapitalize="off" autocomplete="off" spellcheck=${false} placeholder=${t("Search or enter an address")} value=${text} onInput=${(event) => setText(event.target.value)} />
		</form>
		${shortcuts.length > 0
			? html`<div class="dial">
					${shortcuts.map(
						(entry) => html`<button class="dial-item" key=${entry.url} onClick=${() => onGo(entry.url)}>
							<span class="dial-icon">${(hostOf(entry.url) || "?").charAt(0).toUpperCase()}</span>
							<span>${entry.title || hostOf(entry.url)}</span>
						</button>`,
					)}
				</div>`
			: html`<div class="dim" style="font-size:var(--fs-sm);text-align:center;max-width:320px;line-height:20px">${t("Links in a reply open here. The assistant can also open and read pages in this browser when you ask it to.")}</div>`}
	</div>`;
}

export function Browser() {
	const tabs = useStore((s) => s.browser.tabs);
	const activeId = useStore((s) => s.browser.active);
	const external = useStore((s) => s.browser.external);
	const layers = useStore((s) => s.layers.length);
	const pane = useStore((s) => s.pane);
	const tab = tabs.find((entry) => entry.id === activeId) || null;
	const [editing, setEditing] = useState(false);
	const [address, setAddress] = useState("");
	const view = useRef(null);
	const input = useRef(null);

	const hasPage = !!tab?.url && !tab.error;
	const showNative = hasPage && layers === 0 && pane === "browser";

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

	useEffect(() => {
		if (!external) return;
		confirmSheet({ title: t("Open another app?"), message: external.url.slice(0, 200), confirmLabel: t("Open") }).then((yes) => yes && openOutside(external.url));
	}, [external?.nonce]);

	const go = (text) => {
		setEditing(false);
		input.current?.blur();
		navigate(text);
	};

	const startEdit = () => {
		setAddress(tab?.url || "");
		setEditing(true);
		setTimeout(() => {
			input.current?.focus();
			input.current?.select();
		}, 30);
	};

	const secure = /^https:/i.test(tab?.url || "");
	const progress = tab?.loading ? Math.max(0.08, (tab.progress || 0) / 100) : 1;

	return html`<div class="browser">
		<div class="browser-bar">
			<button class="icon-btn" onClick=${() => nav.go("chat")} aria-label=${t("Back to the chat")}><${Icon} name="chevronLeft" size=${22} /></button>
			<form
				class="address"
				onSubmit=${(event) => {
					event.preventDefault();
					if (address.trim()) go(address);
				}}
			>
				${editing
					? html`<input ref=${input} type="text" inputmode="url" enterkeyhint="go" autocapitalize="off" autocomplete="off" spellcheck=${false} value=${address} onInput=${(event) => setAddress(event.target.value)} onBlur=${() => setEditing(false)} />`
					: html`${tab?.url ? html`<span class="lock ${secure ? "" : "insecure"}"><${Icon} name=${secure ? "lock" : "alertTriangle"} size=${14} /></span>` : html`<${Icon} name="search" size=${16} />`}
							<button type="button" class="shown" onClick=${startEdit}>${tab?.url ? hostOf(tab.url) || tab.url : t("Search or enter an address")}</button>`}
			</form>
			${tab?.url && html`<button class="icon-btn" onClick=${() => (tab.loading ? stopLoading() : reload())} aria-label=${tab.loading ? t("Stop") : t("Reload")}><${Icon} name=${tab.loading ? "x" : "refresh"} size=${20} /></button>`}
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
					: !isNative
						? html`<div class="browser-note"><${Icon} name="globe" size=${30} /><div>${hostOf(tab.url)}</div><div>${t("Web pages are shown inside the app. This preview in a desktop browser only has the controls.")}</div></div>`
						: tab.loading && (tab.progress || 0) < 15
							? html`<div class="browser-note"><${Spinner} size=${22} /></div>`
							: null}
		</div>
		<div class="browser-nav">
			<button class="icon-btn" disabled=${!tab?.canGoBack} onClick=${() => goBack()} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${21} /></button>
			<button class="icon-btn" disabled=${!tab?.canGoForward} onClick=${() => goForward()} aria-label=${t("Forward")}><${Icon} name="arrowRight" size=${21} /></button>
			<button class="icon-btn" disabled=${!hasPage} onClick=${() => (haptic("tick"), sendPageToChat(false))} aria-label=${t("Send page to the chat")}><${Icon} name="sparkle" size=${21} /></button>
			<button class="icon-btn" onClick=${() => openSheet((close) => html`<${TabsSheet} close=${close} />`)} aria-label=${t("Tabs")}><span class="tab-count">${tabs.length}</span></button>
			<button class="icon-btn" onClick=${pageMenu} aria-label=${t("More")}><${Icon} name="more" size=${21} /></button>
		</div>
	</div>`;
}
