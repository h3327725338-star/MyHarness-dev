// The middle pane: the conversation and the input area.
import { serverText, t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/shared/ui.js";
import { backend, nav } from "./backends.js";
import { Composer, shortModelName } from "./composer.js";
import { awaitingFirstReply } from "./live.js";
import { Icon, Mark } from "./micons.js";
import { haptic, onInsets } from "./native.js";
import { promptSheet } from "./sheets.js";
import { attempt, emit, side, state, toast, useStore } from "./store.js";
import { Transcript } from "./transcript.js";

const STICK_PX = 90;
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
	const stick = useRef(true);
	const [away, setAway] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const lastChat = useRef(null);
	const prepend = useRef(null);

	const toBottom = (smooth) => {
		const node = scroll.current;
		if (!node) return;
		if (smooth && document.documentElement.dataset.motion !== "off") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
		else node.scrollTop = node.scrollHeight;
	};

	const onScroll = () => {
		const node = scroll.current;
		const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
		stick.current = distance < STICK_PX;
		setAway(distance > 420);
		setScrolled(node.scrollTop > 4);
		if (node.scrollTop < 240 && chat.hasMore && !chat.loadingOlder) {
			prepend.current = { height: node.scrollHeight, top: node.scrollTop };
			backend().loadOlder?.();
		}
	};

	// Follow the reply while the reader is at the end; keep the reader's place when older messages are added above.
	useLayoutEffect(() => {
		const node = scroll.current;
		if (!node) return;
		if (lastChat.current !== chat.id) {
			lastChat.current = chat.id;
			stick.current = true;
			prepend.current = null;
			node.scrollTop = node.scrollHeight;
			return;
		}
		if (prepend.current && !chat.loadingOlder) {
			node.scrollTop = prepend.current.top + (node.scrollHeight - prepend.current.height);
			prepend.current = null;
			return;
		}
		if (stick.current) node.scrollTop = node.scrollHeight;
	}, [chat.id, chat.items, chat.toolRuns, chat.running, chat.loadingOlder, chat.dialogs]);

	// The keyboard takes space from the conversation: the end stays in view.
	useEffect(() => onInsets(() => stick.current && requestAnimationFrame(() => toBottom(false))), []);

	// A message the user just sent is always brought into view.
	const pendingCount = chat.items.reduce((sum, item) => sum + (item.pending ? 1 : 0), 0);
	useEffect(() => {
		if (pendingCount > 0) {
			stick.current = true;
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
	const where = mode === "pc" ? link.paired?.name || t("PC") : t("This phone");
	const sub = [where, mode === "pc" ? chat.place : "", models.current ? shortModelName(models.current.name, models.current.providerName) : ""].filter(Boolean).join(" · ");
	const awaiting = awaitingFirstReply({ running: chat.running, items: chat.items });

	const newChat = async () => {
		haptic("tick");
		await attempt(() => backend().newChat());
	};

	return html`<div class="chat">
		<div class="head ${scrolled ? "scrolled" : ""}">
			<button class="icon-btn" onClick=${() => nav.go("drawer")} aria-label=${t("Chats")}><${Icon} name="menu" size=${22} /></button>
			<div class="head-title" onClick=${() => scroll.current?.scrollTo({ top: 0, behavior: "smooth" })}>
				<span class="name title-swap" key=${title}>${title}</span>
				<span class="sub"><span class="where"><${Icon} name=${mode === "pc" ? "desktop" : "phone"} size=${12} /></span>${sub}</span>
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
								items=${chat.items}
								toolRuns=${chat.toolRuns}
								runs=${chat.runs}
								running=${chat.running}
								awaiting=${awaiting}
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
				stick.current = true;
				toBottom(true);
			}}
			aria-label=${t("Jump to the latest")}
		>
			<${Icon} name="arrowDown" size=${18} />
		</button>
		<${Composer} onOpenSettings=${(section) => nav.openSettings(section)} onOpenLink=${() => nav.openLink()} />
	</div>`;
}
