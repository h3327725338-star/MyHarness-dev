// The PC's built-in browser on the phone. The pages run on the PC, with the PC's sign-ins; the phone shows a picture of
// a tab, taken again after everything the finger does and about once a second while the pane is on screen, and sends
// back where it was tapped, how far it was scrolled and what was typed. It needs a direct connection to the PC (the
// same Wi-Fi, or a direct line from elsewhere): through the Google Drive relay a picture would take seconds.
import { Icon } from "/shared/icons.js";
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useRef, useState } from "/shared/ui.js";
import { nav } from "./backends.js";
import { pcBrowser } from "./backend-remote.js";
import { toUrl } from "./browser-model.js";
import { haptic, pushBack } from "./native.js";
import { prefs, setPrefs } from "./prefs.js";
import { Sheet, actionSheet, openSheet, promptSheet } from "./sheets.js";
import { emit, toast, useStore } from "./store.js";

const ZOOMS = [1, 1.6, 2.4];
const IDLE_MS = 1300; // between two pictures while nothing happens
const BUSY_MS = 350; // while the page loads, or right after the finger did something
const TAP_PX = 9;

/** Whether the PC's browser can be shown: the PC side is open, connected, and not through the relay. */
export function pcBrowserUsable(s) {
	return s.mode === "pc" && s.pc.link.status === "online" && !!s.pc.link.route && s.pc.link.route !== "relay";
}

const hostOf = (url) => {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "";
	}
};

function TabsSheet({ close, tabs, active, onPick, onNew }) {
	return html`<${Sheet} title=${t("Tabs on the PC")} sub=${String(tabs.length)} close=${close} footer=${html`<button class="btn primary" onClick=${() => (onNew(), close())}><${Icon} name="plus" size=${18} />${t("New tab")}</button>`}>
		${tabs.length === 0 ? html`<div class="empty-state"><span class="eicon"><${Icon} name="tabs" size=${24} /></span>${t("No web page is open on the PC.")}</div>` : null}
		${tabs.map(
			(tab) => html`<div class="tab-card ${tab.id === active ? "on" : ""}" key=${tab.id}>
				<button class="tmain" onClick=${() => (onPick(tab.id), close())}>
					<div class="ttitle"><span class="tfrom"><${Icon} name="desktop" size=${12} /></span>${tab.title || hostOf(tab.url)}</div>
					<div class="turl">${tab.url}</div>
				</button>
			</div>`,
		)}
	<//>`;
}

export function PcBrowser({ StartPage }) {
	const pane = useStore((s) => s.pane);
	const layers = useStore((s) => s.layers.length);
	const name = useStore((s) => s.pc.link.paired?.name || t("PC"));
	const [tabs, setTabs] = useState([]);
	const [activeId, setActiveId] = useState(null);
	const [shot, setShot] = useState(null); // { image, width, height, tab }
	const [error, setError] = useState("");
	const [zoom, setZoom] = useState(() => (ZOOMS.includes(prefs.pcBrowserZoom) ? prefs.pcBrowserZoom : 1.6));
	const [editing, setEditing] = useState(false);
	const [address, setAddress] = useState("");
	const [waiting, setWaiting] = useState(false);
	const picture = useRef(null);
	const input = useRef(null);
	const live = useRef({ activeId: null, busyUntil: 0, running: false, acting: 0, stamp: 0, image: "", started: false });
	live.current.activeId = activeId;
	const visible = pane === "browser" && layers === 0 && !editing;

	const fail = (problem) => setError(problem?.message || String(problem));

	const loadTabs = async () => {
		const answer = await pcBrowser("tabs");
		setTabs(answer.tabs || []);
		return answer.tabs || [];
	};

	/** Take the tab's picture now (unless one is being taken); an answer for a tab left in the meantime is dropped. */
	const refresh = async () => {
		const state = live.current;
		const id = state.activeId;
		if (!id || state.running || state.acting) return;
		state.running = true;
		const stamp = ++state.stamp;
		try {
			const answer = await pcBrowser("shot", { tabId: id });
			if (state.activeId !== id || stamp !== state.stamp) return;
			state.image = answer.image || "";
			setShot(answer);
			setError("");
			if (answer.tab?.loading) state.busyUntil = Date.now() + 1500;
		} catch (problem) {
			if (state.activeId === id && stamp === state.stamp) fail(problem);
		} finally {
			// A picture that was dropped (the page was acted on, or left, in the meantime) leaves the state to its successor.
			if (stamp === state.stamp) {
				state.running = false;
				setWaiting(false);
			}
		}
	};

	/** Do something to the page, then look at it again. */
	const act = async (action, params = {}) => {
		const state = live.current;
		const id = state.activeId;
		if (!id) return;
		state.busyUntil = Date.now() + 2500;
		// A picture on its way shows the page as it was before this action: it is dropped, and none is asked for until
		// the PC has done what was asked.
		state.stamp++;
		state.acting++;
		try {
			await pcBrowser(action, { tabId: id, ...params });
		} catch (problem) {
			fail(problem);
		}
		state.acting--;
		state.stamp++;
		state.running = false;
		await refresh();
	};

	// The tabs of the PC when the pane comes on screen; the picture again and again while it stays there.
	useEffect(() => {
		if (pane !== "browser") return;
		loadTabs()
			.then((list) => {
				const state = live.current;
				if (state.activeId && !list.some((tab) => tab.id === state.activeId)) setActiveId(null);
				// The first time, the page the PC itself shows (or its newest one) is on screen right away; later the
				// pane stays where it was left, a new tab included.
				if (!state.started && !state.activeId && list.length > 0) pick((list.find((tab) => tab.active) || list[list.length - 1]).id);
				state.started = true;
			})
			.catch(fail);
	}, [pane]);
	useEffect(() => {
		if (!visible || !activeId) return;
		let timer = 0;
		let stopped = false;
		const loop = async () => {
			await refresh();
			if (!stopped) timer = setTimeout(loop, Date.now() < live.current.busyUntil ? BUSY_MS : IDLE_MS);
		};
		loop();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [visible, activeId]);

	const pick = (id) => {
		// A picture of the tab being left is no longer waited for.
		live.current.stamp++;
		live.current.running = false;
		live.current.image = "";
		setShot(null);
		setError("");
		setWaiting(!!id);
		setActiveId(id);
	};

	const open = async (text) => {
		const url = toUrl(text);
		if (!url) return;
		setEditing(false);
		setWaiting(true);
		setError("");
		try {
			if (live.current.activeId) await act("navigate", { url });
			else {
				const answer = await pcBrowser("open", { url });
				await loadTabs().catch(() => {});
				pick(answer.tab.id);
			}
		} catch (problem) {
			setWaiting(false);
			fail(problem);
		}
	};

	// ---- The finger on the picture: a tap is a click there, a vertical drag scrolls the page -----------------------------
	const drag = useRef(null);
	const scale = () => {
		const node = picture.current;
		return node && shot?.width ? shot.width / node.clientWidth : 1;
	};
	const point = (event) => {
		const rect = picture.current.getBoundingClientRect();
		const k = scale();
		return { x: Math.round((event.clientX - rect.left) * k), y: Math.round((event.clientY - rect.top) * k) };
	};
	const onDown = (event) => {
		if (!shot) return;
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// The pointer is gone already.
		}
		event.currentTarget.style.transition = "";
		drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), moved: false, sent: 0, last: event.clientY, start: point(event) };
	};
	const onMove = (event) => {
		const state = drag.current;
		if (!state || state.id !== event.pointerId) return;
		const dx = event.clientX - state.x;
		const dy = event.clientY - state.y;
		if (!state.moved) {
			if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX) return;
			// Sideways the picture itself moves (it is wider than the screen when enlarged); only up and down is the page's.
			if (Math.abs(dx) > Math.abs(dy)) {
				drag.current = null;
				return;
			}
			state.moved = true;
		}
		// The picture follows the finger until the PC's next picture shows the page where it really is.
		picture.current.style.transform = `translateY(${dy}px)`;
		state.last = event.clientY;
	};
	const onUp = (event) => {
		const state = drag.current;
		if (!state || state.id !== event.pointerId) return;
		drag.current = null;
		if (!state.moved) {
			if (Date.now() - state.at < 600) {
				haptic("tick");
				act("tap", state.start);
			}
			return;
		}
		const dy = state.last - state.y;
		const before = live.current.image;
		// The picture stays where the finger left it until the PC's next one is drawn (settle, below). When that one is
		// the same picture (the page had nowhere further to scroll, or the PC did not answer), it glides back.
		act("wheel", { ...state.start, deltaY: Math.round(-dy * scale()) }).finally(() => {
			const node = picture.current;
			if (!node || drag.current?.moved || live.current.image !== before) return;
			node.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
			node.style.transform = "";
		});
	};
	/** A new picture is drawn: it shows the page where it really is, so the finger's offset ends with it. */
	const settle = () => {
		const node = picture.current;
		if (!node || drag.current?.moved) return;
		node.style.transition = "";
		node.style.transform = "";
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

	const typeMenu = async () => {
		const choice = await actionSheet({
			title: t("Type into the page"),
			sub: t("Tap the field on the page first."),
			actions: [
				{ value: "text", label: t("Type text"), icon: "edit" },
				{ value: "enter-text", label: t("Type text and press Enter"), icon: "enter" },
				{ value: "Enter", label: t("Press Enter"), icon: "enter" },
				{ value: "Backspace", label: t("Delete one character"), icon: "x" },
				{ value: "Control+A", label: t("Select everything in the field"), icon: "copy" },
				{ value: "Tab", label: t("Go to the next field"), icon: "arrowRight" },
				{ value: "Escape", label: t("Press Escape"), icon: "x" },
			],
		});
		if (!choice) return;
		if (choice === "text" || choice === "enter-text") {
			const text = await promptSheet({ title: t("Type into the page"), value: "", placeholder: t("Text for the field on the PC"), confirmLabel: t("Send") });
			if (text) act("text", { text, enter: choice === "enter-text" });
		} else act("key", { key: choice });
	};

	const pageMenu = async () => {
		const choice = await actionSheet({
			title: shot?.tab?.title || t("Browser of {name}", { name }),
			sub: shot?.tab?.url ? hostOf(shot.tab.url) : "",
			actions: [
				{ value: "new", label: t("New tab"), icon: "plus" },
				activeId && { value: "reload", label: t("Reload"), icon: "refresh" },
				activeId && { value: "zoom", label: t("Picture size: {size}", { size: `${Math.round(zoom * 100)}%` }), icon: "search" },
				{ value: "phone", label: t("Use this phone's own browser"), icon: "phone" },
			],
		});
		if (choice === "new") pick(null);
		else if (choice === "reload") act("reload");
		else if (choice === "zoom") {
			const next = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length];
			setZoom(next);
			setPrefs({ pcBrowserZoom: next });
		} else if (choice === "phone") {
			setPrefs({ browserSide: "phone" });
			emit();
			toast(t("Pages now open on this phone, with its own sign-ins."), "ok", 2600);
		}
	};

	const tab = shot?.tab || tabs.find((entry) => entry.id === activeId) || null;
	const secure = /^https:/i.test(tab?.url || "");
	return html`<div class="browser pc-browser ${editing ? "editing" : ""}">
		<div class="browser-bar">
			<button class="icon-btn" onClick=${() => (editing ? setEditing(false) : nav.go("chat"))} aria-label=${editing ? t("Cancel") : t("Back to the chat")}><${Icon} name=${editing ? "x" : "chevronLeft"} size=${22} /></button>
			<form
				class="address"
				onSubmit=${(event) => {
					event.preventDefault();
					if (address.trim()) open(address);
				}}
			>
				${editing
					? html`<${Icon} name="search" size=${16} />
							<input ref=${input} type="text" inputmode="url" enterkeyhint="go" autocapitalize="off" autocomplete="off" spellcheck=${false} placeholder=${t("Search or enter an address")} value=${address} onInput=${(event) => setAddress(event.target.value)} />`
					: html`<span class="lock pc-mark ${tab?.url && !secure ? "insecure" : ""}"><${Icon} name="desktop" size=${14} /></span>
							<button type="button" class="shown" onClick=${() => (setAddress(tab?.url || ""), setEditing(true))}>${tab?.url ? hostOf(tab.url) || tab.url : t("Search or enter an address")}</button>`}
			</form>
			${!editing && activeId ? html`<button class="icon-btn" onClick=${() => act("reload")} aria-label=${t("Reload")}><${Icon} name="refresh" size=${20} /></button>` : null}
			<div class="browser-progress"><i style=${`transform:scaleX(${tab?.loading ? 0.6 : 1});opacity:${tab?.loading ? 1 : 0}`}></i></div>
		</div>
		<div class="browser-view">
			${!activeId
				? html`<${StartPage} onGo=${open} />`
				: html`<div class="pc-page" data-no-swipe style="touch-action:pan-x">
						${shot?.image
							? html`<img ref=${picture} class="pc-picture" src=${shot.image} alt="" draggable=${false} style=${`width:${zoom * 100}%;touch-action:pan-x`} onLoad=${settle} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} />`
							: error
								? null
								: html`<div class="browser-note"><${Spinner} size=${22} /></div>`}
					</div>`}
			${error && activeId
				? html`<div class="browser-note pc-error">
						<${Icon} name="alertCircle" size=${28} />
						<div>${error}</div>
						<button class="btn" onClick=${() => (setError(""), setWaiting(true), refresh())}>${t("Try again")}</button>
					</div>`
				: null}
			${waiting && shot ? html`<div class="pc-wait"><${Spinner} size=${16} /></div>` : null}
		</div>
		<div class="browser-nav">
			<button class="icon-btn" disabled=${!tab?.canGoBack} onClick=${() => act("back")} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${21} /></button>
			<button class="icon-btn" disabled=${!tab?.canGoForward} onClick=${() => act("forward")} aria-label=${t("Forward")}><${Icon} name="arrowRight" size=${21} /></button>
			<button class="icon-btn" disabled=${!activeId} onClick=${typeMenu} aria-label=${t("Type into the page")}><${Icon} name="edit" size=${21} /></button>
			<button
				class="icon-btn"
				onClick=${() =>
					loadTabs()
						.catch((problem) => (fail(problem), tabs))
						.then((list) => openSheet((close) => html`<${TabsSheet} close=${close} tabs=${list} active=${activeId} onPick=${pick} onNew=${() => pick(null)} />`))}
				aria-label=${t("Tabs")}
			>
				<span class="tab-count">${tabs.length}</span>
			</button>
			<button class="icon-btn" onClick=${pageMenu} aria-label=${t("More")}><${Icon} name="more" size=${21} /></button>
		</div>
	</div>`;
}
