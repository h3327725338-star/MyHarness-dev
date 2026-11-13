// Entry of the phone page: three panes side by side (chats, conversation, browser), everything else over them.
// native.js comes first: it routes requests to other sites through the Android shell before any model SDK loads.
import { browserBack, haptic, nativeReady, onNative, openExternal, pushBack } from "./native.js";
import { zhCN, zhUnits } from "/shared/locales/zh-CN.js";
import { html, render, useEffect, useRef } from "/shared/ui.js";
import { MOBILE_ZH, MOBILE_ZH_UNITS } from "./locale-zh.js";
import { applyAppearance, setShownMode } from "./prefs.js";

// The phone's own words join the desktop's Chinese table before anything is drawn (i18n.js looks them up by the English text).
Object.assign(zhCN, MOBILE_ZH);
Object.assign(zhUnits, MOBILE_ZH_UNITS);
applyAppearance();

const { account } = await import("./account.js");
const { local } = await import("./backend-local.js");
const { pc } = await import("./backend-remote.js");
const { chatModeOnScreen, nav } = await import("./backends.js");
const { Browser } = await import("./browser.js");
const { activeTab, goBack, initBrowser, navigate, openTab } = await import("./browser-model.js");
const { Chat } = await import("./chat.js");
const { Drawer } = await import("./drawer.js");
const { setLinkHandler } = await import("./markdown.js");
const { Icon, Mark } = await import("./micons.js");
const { createPager } = await import("./pager.js");
const { openLinkPage, openSettings, pairFromLink } = await import("./settings.js");
const { Layers } = await import("./sheets.js");
const { SignInGate } = await import("./signin.js");
const { dismissToast, set, state, subscribe, useStore } = await import("./store.js");

const TOAST_ICON = { error: "alertCircle", warning: "alertTriangle", ok: "checkCircle", info: "info" };

function Toasts() {
	const toasts = useStore((s) => s.toasts);
	return html`<div class="toasts" aria-live="polite">
		${toasts.map((toast) => html`<div class="toast ${toast.kind} ${toast.leaving ? "leaving" : ""}" key=${toast.id} onClick=${() => dismissToast(toast.id)}><${Icon} name=${TOAST_ICON[toast.kind] || "info"} size=${18} /><span>${toast.message}</span></div>`)}
	</div>`;
}

function Boot() {
	const booted = useStore((s) => s.booted);
	return html`<div class="boot ${booted ? "gone" : ""}"><${Mark} size=${64} /></div>`;
}

function App() {
	const root = useRef(null);

	useEffect(() => {
		const pager = createPager(root.current, { onPane: (pane) => set({ pane }), onPeek: (browserPeek) => set({ browserPeek }) });
		nav.go = (pane) => pager.go(pane);
		nav.openSettings = (section) => openSettings(section);
		nav.openLink = () => openLinkPage();
		nav.openUrl = (url, options = {}) => {
			if (options.external || !/^https?:/i.test(url)) return openExternal(url);
			haptic("tick");
			// A link opens beside what is already being read, not over it.
			if (activeTab()?.url) openTab(url);
			else navigate(url);
			pager.go("browser");
		};
		setLinkHandler(nav.openUrl);

		// The system back key: first the browser's own history, then back to the conversation, then out of the app.
		const removeBack = pushBack(() => {
			if (pager.pane === "browser") {
				if (activeTab()?.canGoBack) goBack();
				else if (!browserBack()) pager.go("chat");
				return true;
			}
			if (pager.pane === "drawer") {
				pager.go("chat");
				return true;
			}
			return false;
		});

		const removeOpenUrl = onNative("openUrl", (event) => event.url && nav.openUrl(event.url));
		const removeShare = onNative("share", (event) => {
			if (event.link) pairFromLink(event.link);
			else pager.go("chat");
		});
		// From here on the shell delivers what it kept: the system bar sizes, and anything shared to the app at launch.
		const ready = setTimeout(nativeReady, 0);
		return () => {
			clearTimeout(ready);
			removeBack();
			removeOpenUrl();
			removeShare();
			pager.destroy();
		};
	}, []);

	return html`<div class="pager" ref=${root}>
			<div class="pane pane-drawer"><${Drawer} /></div>
			<div class="pane pane-chat">
				<${Chat} />
				<div class="pane-scrim"></div>
			</div>
			<div class="pane pane-browser"><${Browser} /></div>
		</div>
		<${Layers} />
		<${SignInGate} />
		<${Toasts} />
		<${Boot} />`;
}

// Long-press menus of the page itself are the app's own; the system's text menu stays for text that can be selected.
document.addEventListener("contextmenu", (event) => {
	if (!event.target.closest?.("input, textarea, .selectable, .md, .bubble-text")) event.preventDefault();
});

render(html`<${App} />`, document.getElementById("app"));

// The account first: the other parts read its last view (Providers, chats) and its key (account PCs) as they start.
await account.init().catch((error) => console.error("account start-up failed", error));
const started = await Promise.allSettled([local.init(), pc.init(), initBrowser()]);
for (const result of started) if (result.status === "rejected") console.error("start-up step failed", result.reason);
// The page wears the colours of the chat mode on screen. The switches change them themselves, with their animation;
// this follows every other way the mode changes (a PC paired or forgotten, the side restored at start-up).
setShownMode(chatModeOnScreen());
subscribe(() => setShownMode(chatModeOnScreen()));
set({ booted: true });
globalThis.__mhState = state;
