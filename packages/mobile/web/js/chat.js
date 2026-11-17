// The middle pane: the conversation and the input area.
import { serverText, t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/shared/ui.js";
import { backend, nav } from "./backends.js";
import { Composer, shortModelName } from "./composer.js";
import { AWAY_PX, createFollow, scrolled as scrolledTo, settled, wrote } from "./follow.js";
import { headLine, LinkDot, useLinkInfo } from "./link-ui.js";
import { Icon, Mark } from "./micons.js";
import { haptic, onInsets } from "./native.js";
import { promptSheet } from "./sheets.js";
import { attempt, emit, side, state, toast, useStore } from "./store.js";
import { Transcript } from "./transcript.js";

const openUrl = (url, options) => nav.openUrl(url, options);

function greeting() {
	const hour = new Date().getHours();
	if (hour < 5) return t("Still up?");
	if (hour < 12) return t("Good morning");
	if (hour < 18) return t("Good afternoon");
	return t("Good evening");
}

const SUGGESTIONS = [
	{ icon: "globe", label: "Look something up", text: "Search the web and tell me the latest about " },
	{ icon: "edit", label: "Help me write", text: "Help me write " },
	{ icon: "book", label: "Explain a topic", text: "Explain in simple terms: " },
	{ icon: "language", label: "Translate", text: "Translate into English:\n" },
];

function Welcome({ mode, link }) {
	const insert = (text) => {
		haptic("tick");
		state.composerInsert = { text: t(text), nonce: Date.now() };
		emit();
	};
	return html`<div class="welcome">
		<${Mark} size=${56} class="welcome-mark" />
		<h1>${greeting()}</h1>
		${mode === "pc" && link.paired ? null : html`<p>${mode === "pc" ? t("Connect a PC to control it from here.") : t("What can I help you with?")}</p>`}
		${mode === "local" &&
		html`<div class="welcome-chips">
			${SUGGESTIONS.map(
				(entry, index) => html`<button class="welcome-chip" key=${entry.label} style=${`animation-delay:${180 + index * 50}ms`} onClick=${() => insert(entry.text)}><${Icon} name=${entry.icon} size=${16} />${t(entry.label)}</button>`,
			)}
		</div>`}
	</div>`;
}

/** A question the agent on the PC asks (an approval, a choice, a text to type). */
function Ask({ dialog }) {
	const [busy, setBusy] = useState(false);
	const answer = async (value) => {
		haptic("confirm");
		setBusy(true);
		await attempt(() => backend().respond(dialog.id, value));
		setBusy(false);
	};
	const typed = async () => {
		const text = await promptSheet({ title: serverText(dialog.title, dialog.title), value: dialog.initialValue || "", placeholder: dialog.placeholder, multiline: dialog.kind === "editor", confirmLabel: t("Send") });
		if (text !== null) answer(text);
	};
	return html`<div class="ask">
		<div class="atitle">${serverText(dialog.title, dialog.title)}</div>
		${dialog.message && html`<div class="amsg selectable">${dialog.message}</div>`}
		${dialog.kind === "select" && html`<div class="aopts">${(dialog.options || []).map((option) => html`<button class="aopt" key=${option} disabled=${busy} onClick=${() => answer(option)}>${serverText(option, option)}</button>`)}</div>`}
		<div class="arow">
			<button class="btn" disabled=${busy} onClick=${() => answer(dialog.kind === "confirm" ? false : undefined)}>${dialog.kind === "confirm" ? t("No") : t("Dismiss")}</button>
			${dialog.kind === "confirm" && html`<button class="btn primary" disabled=${busy} onClick=${() => answer(true)}>${t("Yes")}</button>`}
			${(dialog.kind === "input" || dialog.kind === "editor") && html`<button class="btn primary" disabled=${busy} onClick=${typed}>${t("Answer")}</button>`}
		</div>
	</div>`;
}

export function Chat() {
	const mode = useStore((s) => s.mode);
	const chat = useStore((s) => {
		const c = side(s).chat;
		return { id: c.id, title: c.title, items: c.items, toolRuns: c.toolRuns, runs: c.runs, running: c.running, loading: c.loading, hasMore: c.hasMore, loadingOlder: c.loadingOlder, dialogs: c.dialogs, cwd: c.cwd, place: c.place };
	});
	const models = useStore((s) => side(s).models);
	const link = useStore((s) => s.pc.link);
	const scroll = useRef(null);
	// Whether the pane follows the end of the reply, and where it was last seen (follow.js).
	const reader = useRef(null);
	if (!reader.current) reader.current = createFollow();
	const [away, setAway] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const lastChat = useRef(null);
	// Where the reader was when older messages began to load, and whether such a load is on.
	const prepend = useRef(null);
	const olderLoading = useRef(false);

	const toBottom = (smooth) => {
		const node = scroll.current;
		if (!node) return;
		if (smooth && document.documentElement.dataset.motion !== "off") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
		else {
			node.scrollTop = node.scrollHeight;
			wrote(reader.current, node.scrollTop);
		}
	};

	const onScroll = () => {
		const node = scroll.current;
		const distance = scrolledTo(reader.current, { top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight });
		setAway(distance > AWAY_PX);
		setScrolled(node.scrollTop > 4);
		if (node.scrollTop < 240 && chat.hasMore && !chat.loadingOlder) {
			prepend.current = { height: node.scrollHeight, top: node.scrollTop };
			backend().loadOlder?.();
		}
	};

	// Moves the pane to where it belongs after the page changed (follow.js: settled): to the end while following it, or
	// back to the reader's place when older messages were added above.
	const settle = (place) => {
		const node = scroll.current;
		if (!node) return;
		// The reader moved the pane and the page changed before that scroll event was delivered: the move counts now,
		// or the pane would be taken back to the end under their finger.
		if (node.scrollTop < reader.current.top - 1) scrolledTo(reader.current, { top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight });
		const top = settled(reader.current, { place, height: node.scrollHeight });
		if (top === null) return;
		node.scrollTop = top;
		wrote(reader.current, node.scrollTop);
	};

	// Follow the reply while the reader is at the end; keep the reader's place when older messages are added above.
	useLayoutEffect(() => {
		if (!scroll.current) return;
		let place = null;
		if (lastChat.current !== chat.id) {
			lastChat.current = chat.id;
			reader.current.stick = true;
			prepend.current = null;
			olderLoading.current = false;
		} else if (chat.loadingOlder) olderLoading.current = true;
		else if (olderLoading.current) {
			// The older messages are in: the reader keeps their place.
			olderLoading.current = false;
			place = prepend.current;
			prepend.current = null;
		} else prepend.current = null; // a place noted for a load that never started (nothing to load, or it failed at once)
		// Class components (the Markdown blocks) draw their text after every layout effect of the same update, so the page
		// is not as tall as it will be yet: the pane is placed when the whole update is on the page (still before anything
		// is painted: microtasks run first).
		queueMicrotask(() => settle(place));
	}, [chat.id, chat.items, chat.toolRuns, chat.running, chat.loadingOlder, chat.dialogs]);

	// The conversation also grows while its items stay the same (a reply being written out, a block of work folding
	// open, a picture arriving): the end stays in view then too.
	const hasTurns = chat.items.length > 0;
	useEffect(() => {
		const node = scroll.current;
		const inner = node?.querySelector(".chat-inner");
		if (!inner || typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver(() => settle(null));
		observer.observe(inner);
		return () => observer.disconnect();
	}, [chat.id, hasTurns]);

	// The keyboard takes space from the conversation: the end stays in view.
	useEffect(() => onInsets(() => reader.current.stick && requestAnimationFrame(() => toBottom(false))), []);

	// A message the user just sent is always brought into view.
	const pendingCount = chat.items.reduce((sum, item) => sum + (item.pending ? 1 : 0), 0);
	useEffect(() => {
		if (pendingCount > 0) {
			reader.current.stick = true;
			toBottom(true);
		}
	}, [pendingCount]);

	const actions = useMemo(
		() => ({
			edit: (text) => {
				state.composerInsert = { text, nonce: Date.now() };
				emit();
			},
			retry: mode === "local" ? () => attempt(() => backend().retry()) : null,
		}),
		[mode],
	);

	const empty = chat.items.length === 0 && !chat.loading;
	// An unnamed chat is called by its first message, as in the chat list.
	const firstLine = (chat.items.find((item) => item.kind === "user")?.text || "").trim().split("\n")[0].slice(0, 60);
	const title = chat.title || firstLine || (empty ? t("New chat") : t("Chat"));
	const linkNow = useLinkInfo();
	const where = mode === "pc" ? link.paired?.name || t("PC") : t("This phone");
	// While the PC is not connected the line says what is going on in place of the workspace and the model.
	const linkLine = mode === "pc" ? headLine(linkNow) : "";
	const sub = linkLine ? `${where} · ${linkLine}` : [where, mode === "pc" ? chat.place : "", models.current ? shortModelName(models.current.name, models.current.providerName) : ""].filter(Boolean).join(" · ");

	const newChat = async () => {
		haptic("tick");
		await attempt(() => backend().newChat());
	};

	return html`<div class="chat">
		<div class="head ${scrolled ? "scrolled" : ""}">
			<button class="icon-btn" onClick=${() => nav.go("drawer")} aria-label=${t("Chats")}><${Icon} name="menu" size=${22} /></button>
			<div class="head-title" onClick=${() => scroll.current?.scrollTo({ top: 0, behavior: "smooth" })}>
				<span class="name title-swap" key=${title}>${title}</span>
				<span class="sub"><span class="where">${mode === "pc" && link.paired ? html`<${LinkDot} info=${linkNow} />` : html`<${Icon} name=${mode === "pc" ? "desktop" : "phone"} size=${12} />`}</span>${sub}</span>
			</div>
			<button class="icon-btn" onClick=${newChat} aria-label=${t("New chat")} disabled=${mode === "pc" && link.status !== "online" && link.status !== "connecting"}><${Icon} name="compose" size=${21} /></button>
		</div>
		<div class="chat-scroll" ref=${scroll} onScroll=${onScroll}>
			${chat.loading && chat.items.length === 0
				? html`<div class="welcome"><${Spinner} size=${22} /></div>`
				: empty
					? html`<${Welcome} mode=${mode} link=${link} />`
					: html`<div class="chat-inner">
							${chat.hasMore && html`<div class="older">${chat.loadingOlder ? html`<${Spinner} size=${16} />` : html`<button class="btn sm ghost" onClick=${() => backend().loadOlder?.()}>${t("Earlier messages")}</button>`}</div>`}
							<${Transcript}
								chatId=${chat.id}
								items=${chat.items}
								toolRuns=${chat.toolRuns}
								runs=${chat.runs}
								running=${chat.running}
								cwd=${chat.cwd}
								actions=${actions}
								onOpenUrl=${openUrl}
								modelLabel=${models.current?.name}
							/>
							${chat.dialogs.length > 0 && html`<div style="margin-top:16px"><${Ask} key=${chat.dialogs[0].id} dialog=${chat.dialogs[0]} /></div>`}
						</div>`}
		</div>
		<button
			class="to-bottom ${away ? "show" : ""}"
			onClick=${() => {
				reader.current.stick = true;
				toBottom(true);
			}}
			aria-label=${t("Jump to the latest")}
		>
			<${Icon} name="arrowDown" size=${18} />
		</button>
		<${Composer} onOpenSettings=${(section) => nav.openSettings(section)} onOpenLink=${() => nav.openLink()} />
	</div>`;
}
