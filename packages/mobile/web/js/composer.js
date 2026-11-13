// The input area of the chat pane: text, attachments (camera, photos, files), the model and effort choice, and the
// button that sends, or stops the reply being written.
import { t } from "/shared/i18n.js";
import { Spinner, html, useEffect, useLayoutEffect, useRef, useState } from "/shared/ui.js";
import { effortName, fmtBytes } from "/shared/util.js";
import { imageAttachment, prepareFile } from "./attachments.js";
import { backend } from "./backends.js";
import { Icon } from "./micons.js";
import { haptic, onNative } from "./native.js";
import { prefs } from "./prefs.js";
import { Row, Sheet, actionSheet, openSheet } from "./sheets.js";
import { side, state, toast, useStore } from "./store.js";

const DRAFT_KEY = "myharness.mobile.draft";
const MAX_ATTACHMENTS = 10;

function loadDraft() {
	try {
		return sessionStorage.getItem(DRAFT_KEY) || "";
	} catch {
		return "";
	}
}
function saveDraft(text) {
	try {
		if (text) sessionStorage.setItem(DRAFT_KEY, text);
		else sessionStorage.removeItem(DRAFT_KEY);
	} catch {
		// The draft lives in memory only.
	}
}

// ---- Model picker ------------------------------------------------------------------------------
function ModelSheet({ close, onManage }) {
	const models = useStore((s) => side(s).models);
	const mode = useStore((s) => s.mode);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const total = models.providers.reduce((sum, provider) => sum + provider.models.length, 0);
	const groups = models.providers
		.map((provider) => ({ ...provider, models: provider.models.filter((model) => !needle || `${model.name} ${model.id} ${provider.name}`.toLowerCase().includes(needle)) }))
		.filter((provider) => provider.models.length);
	return html`<${Sheet} title=${t("Model")} sub=${mode === "pc" ? t("on the PC") : t("on this phone")} close=${close}>
		${total > 8 && html`<input class="field sheet-search" style="width:calc(100% - 8px)" placeholder=${t("Search models")} value=${query} onInput=${(event) => setQuery(event.target.value)} />`}
		${groups.map(
			(provider) => html`<div key=${provider.id} style="margin-bottom:14px">
				<div class="rows-title">${provider.name}</div>
				<div class="rows">
					${provider.models.map((model) => {
						const on = models.current?.provider === provider.id && models.current?.id === model.id;
						return html`<${Row}
							key=${model.id}
							title=${model.name}
							sub=${model.name !== model.id ? model.id : ""}
							on=${on}
							check=${on}
							onClick=${async () => {
								haptic("tick");
								try {
									await backend().setModel(provider.id, model.id);
								} catch (error) {
									toast(error.message, "error");
								}
								close();
							}}
						/>`;
					})}
				</div>
			</div>`,
		)}
		${!groups.length && html`<div class="empty-state"><span class="eicon"><${Icon} name="cpu" size=${24} /></span>${total ? t("No model matches.") : mode === "pc" ? t("The PC has no model set up yet.") : t("No model yet. Add a provider and its models first.")}</div>`}
		${mode === "local" && html`<button class="btn block" onClick=${() => (close(), onManage())}><${Icon} name="sliders" size=${17} />${t("Manage providers and models")}</button>`}
	<//>`;
}

async function pickEffort() {
	const models = side().models;
	const choice = await actionSheet({
		title: t("Reasoning effort"),
		sub: models.current?.name,
		actions: models.efforts.map((level) => ({ value: level, label: effortName(level), checked: level === models.effort })),
	});
	if (choice) {
		try {
			await backend().setEffort(choice);
		} catch (error) {
			toast(error.message, "error");
		}
	}
}

// ---- Attachments -------------------------------------------------------------------------------
function AttachmentChip({ item, onRemove }) {
	const [leaving, setLeaving] = useState(false);
	const remove = () => {
		setLeaving(true);
		setTimeout(onRemove, 150);
	};
	return html`<div class="attach ${leaving ? "leaving" : ""}">
		${item.type === "image" && item.data
			? html`<img src=${`data:${item.mimeType};base64,${item.data}`} alt="" />`
			: html`<div class="attach-file">
					<span class="ficon"><${Icon} name=${item.busy ? "clock" : "file"} size=${18} /></span>
					<span class="fmeta"><span class="fname">${item.name}</span><span class="fsize">${item.busy ? t("Reading…") : fmtBytes(item.size)}</span></span>
				</div>`}
		${item.busy && item.type === "image" && html`<div class="attach-busy"><${Spinner} size=${18} /></div>`}
		<button class="attach-x" onClick=${remove} aria-label=${t("Remove")}><${Icon} name="x" size=${13} /></button>
	</div>`;
}

export function Composer({ onOpenSettings, onOpenLink }) {
	const mode = useStore((s) => s.mode);
	const running = useStore((s) => side(s).chat.running);
	const queue = useStore((s) => side(s).chat.queue);
	const models = useStore((s) => side(s).models);
	const link = useStore((s) => s.pc.link);
	// No PC chat is open yet (a new one is still being made on the PC): nothing to send into.
	const noPcChat = useStore((s) => s.mode === "pc" && !s.pc.chat.slot);
	// A PC's chat is still being read from Google Drive on the phone side (or could not be): a message must not start a
	// separate chat under its title.
	const pcChatOpening = useStore((s) => s.mode === "local" && String(s.local.chat.id || "").startsWith("sync:"));
	const insert = useStore((s) => s.composerInsert);
	const [text, setText] = useState(loadDraft);
	const [attachments, setAttachments] = useState([]);
	const [focus, setFocus] = useState(false);
	const input = useRef(null);
	const camera = useRef(null);
	const photos = useRef(null);
	const files = useRef(null);
	const latest = useRef({});
	latest.current = { text, attachments };

	// The box grows with its text up to a share of the screen, then scrolls.
	useLayoutEffect(() => {
		const node = input.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, Math.max(120, innerHeight * 0.32))}px`;
	}, [text]);

	useEffect(() => saveDraft(text), [text]);

	useEffect(() => {
		if (!insert) return;
		setText((before) => (before.trim() ? `${before.replace(/\s+$/, "")}\n${insert.text}` : insert.text));
		if (insert.attachments?.length) setAttachments((before) => [...before, ...insert.attachments].slice(0, MAX_ATTACHMENTS));
		if (insert.focus !== false) setTimeout(() => input.current?.focus(), 80);
	}, [insert]);

	const addFiles = async (list) => {
		const picked = [...list];
		if (!picked.length) return;
		const room = MAX_ATTACHMENTS - latest.current.attachments.length;
		if (picked.length > room) toast(t("A message takes up to {n} attachments.", { n: MAX_ATTACHMENTS }), "warning");
		for (const file of picked.slice(0, Math.max(0, room))) {
			const placeholder = { id: `busy-${Math.random().toString(36).slice(2)}`, type: /^image\//.test(file.type) ? "image" : "binary", name: file.name, size: file.size, busy: true };
			setAttachments((before) => [...before, placeholder]);
			try {
				const ready = await prepareFile(file);
				if (ready.type === "binary" && state.mode === "local") {
					toast(t("“{name}” is not a picture or a text file. The phone's own agent reads only those; switch to the PC to send other files.", { name: file.name }), "warning", 6000);
					setAttachments((before) => before.filter((entry) => entry.id !== placeholder.id));
					continue;
				}
				setAttachments((before) => before.map((entry) => (entry.id === placeholder.id ? ready : entry)));
			} catch (error) {
				toast(error.message || String(error), "error");
				setAttachments((before) => before.filter((entry) => entry.id !== placeholder.id));
			}
		}
	};

	// Something shared to the app from another app (a text, a link, pictures).
	useEffect(
		() =>
			onNative("share", (shared) => {
				if (shared.text) setText((before) => (before.trim() ? `${before}\n${shared.text}` : shared.text));
				if (Array.isArray(shared.images)) setAttachments((before) => [...before, ...shared.images.map(imageAttachment)].slice(0, MAX_ATTACHMENTS));
			}),
		[],
	);

	const attachMenu = async () => {
		haptic("tick");
		const choice = await actionSheet({
			title: t("Add to the message"),
			actions: [
				{ value: "camera", label: t("Take a photo"), icon: "camera" },
				{ value: "photos", label: t("Photos"), icon: "image" },
				{ value: "files", label: t("Files"), icon: "paperclip", sub: mode === "local" ? t("Text and code files; pictures") : t("Any file up to 16 MB, sent to the PC") },
			],
		});
		const target = { camera, photos, files }[choice]?.current;
		if (target) {
			target.value = "";
			target.click();
		}
	};

	const busy = attachments.some((entry) => entry.busy);
	const canSend = !busy && (text.trim().length > 0 || attachments.length > 0);
	const blocked = mode === "local" ? (models.loaded && !models.current) || pcChatOpening : !link.paired || link.status !== "online" || noPcChat;

	// As on the desktop, the box is emptied at once and the message shows in the chat; the PC (or the phone's agent)
	// takes it in the background. If it is refused, what was sent comes back into the box, unless something new was
	// typed meanwhile.
	const send = async () => {
		if (!canSend || noPcChat || pcChatOpening) return;
		const sentText = text;
		const sentAttachments = attachments;
		const outgoing = { text: text.trim(), attachments };
		haptic("confirm");
		setText("");
		setAttachments([]);
		saveDraft("");
		try {
			await backend().send(outgoing);
		} catch (error) {
			setText((now) => (now.trim() ? now : sentText));
			setAttachments((now) => (now.length ? now : sentAttachments));
			toast(error?.message || String(error), "error", 7000);
		}
	};

	const stop = () => {
		haptic("reject");
		backend().stop();
	};

	const onPaste = (event) => {
		const pasted = [...(event.clipboardData?.files || [])];
		if (pasted.length) {
			event.preventDefault();
			addFiles(pasted);
		}
	};

	const showStop = running && !text.trim() && !attachments.length;
	const modelLabel = models.current?.name || (mode === "pc" ? t("Model") : t("Choose a model"));

	return html`<div class="composer-wrap">
		${mode === "local" &&
		models.loaded &&
		!models.current &&
		html`<div class="banner info"><${Icon} name="cpu" size=${18} /><span class="btext">${t("Add a model provider to start chatting on this phone.")}</span><button class="btn sm primary" onClick=${() => onOpenSettings("models")}>${t("Set up")}</button></div>`}
		${mode === "pc" && !link.paired && html`<div class="banner info"><${Icon} name="desktop" size=${18} /><span class="btext">${t("Connect to MyHarness on your PC to send messages to it.")}</span><button class="btn sm primary" onClick=${onOpenLink}>${t("Connect")}</button></div>`}
		${mode === "pc" &&
		link.paired &&
		link.status === "offline" &&
		html`<div class="banner"><${Icon} name="wifi" size=${18} /><span class="btext">${link.error || t("The PC cannot be reached. Is it on, with MyHarness open, on the same network?")}</span><button class="btn sm" onClick=${() => backend().reconnect?.()}>${t("Retry")}</button></div>`}
		${queue.length > 0 &&
		html`<div class="queue-row">
			${queue.map((entry, index) => html`<div class="queue-item" key=${index}><span class="qlabel">${t("Queued")}</span><span class="qbody">${entry.text || t("(attachments)")}</span></div>`)}
		</div>`}
		<div class="composer ${focus ? "focus" : ""}">
			${attachments.length > 0 &&
			html`<div class="attach-row">
				${attachments.map((item) => html`<${AttachmentChip} key=${item.id} item=${item} onRemove=${() => setAttachments((before) => before.filter((entry) => entry.id !== item.id))} />`)}
			</div>`}
			<textarea
				ref=${input}
				class="composer-input"
				rows="1"
				placeholder=${running ? t("Add to what it is doing…") : mode === "pc" ? t("Message your PC") : t("Ask anything")}
				value=${text}
				enterkeyhint=${prefs.sendOnEnter ? "send" : "enter"}
				onInput=${(event) => setText(event.target.value)}
				onFocus=${() => setFocus(true)}
				onBlur=${() => setFocus(false)}
				onPaste=${onPaste}
				onKeyDown=${(event) => {
					if (event.key === "Enter" && !event.isComposing && (prefs.sendOnEnter ? !event.shiftKey : event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						send();
					}
				}}
			></textarea>
			<div class="composer-bar">
				<button class="round-btn" onClick=${attachMenu} aria-label=${t("Add attachment")}><${Icon} name="plus" size=${22} /></button>
				<button class="chip" onClick=${() => openSheet((close) => html`<${ModelSheet} close=${close} onManage=${() => onOpenSettings("models")} />`)} aria-label=${t("Model")}>
					<${Icon} name=${mode === "pc" ? "desktop" : "phone"} size=${15} /><span class="label">${modelLabel}</span>
				</button>
				${models.efforts.length > 1 && html`<button class="chip" onClick=${pickEffort} aria-label=${t("Reasoning effort")}><${Icon} name="brain" size=${15} /><span class="label">${effortName(models.effort)}</span></button>`}
				<span class="spacer"></span>
				${showStop
					? html`<button class="round-btn stop" onClick=${stop} aria-label=${t("Stop")}><span class="swap" key="stop"><${Icon} name="stop" size=${18} /></span></button>`
					: html`<button class="round-btn send" onClick=${send} disabled=${!canSend || blocked} aria-label=${t("Send")}>
							<span class="swap" key="send"><${Icon} name="send" size=${21} /></span>
						</button>`}
			</div>
		</div>
		<input ref=${camera} type="file" accept="image/*" capture="environment" hidden onChange=${(event) => addFiles(event.target.files)} />
		<input ref=${photos} type="file" accept="image/*" multiple hidden onChange=${(event) => addFiles(event.target.files)} />
		<input ref=${files} type="file" multiple hidden onChange=${(event) => addFiles(event.target.files)} />
	</div>`;
}
