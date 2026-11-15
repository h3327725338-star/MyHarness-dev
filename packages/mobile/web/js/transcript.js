// The conversation: turns built by the desktop's transcript model (shared/turns.js) and drawn for a phone.
// A turn is the user's message, then the work (reasoning and tool calls, folded into one block once it is done),
// then the answer. The same component draws the phone's own chats and the PC's.
import { count, serverText, t } from "/shared/i18n.js";
import { Collapse, Spinner, html, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/shared/ui.js";
import { actionTitle, buildTurns, groupLabel, groupSteps, nextRound, runForTurn, turnDuration, turnOutcome, turnSegments } from "/shared/turns.js";
import { clip, fmtBytes, fmtDuration } from "/shared/util.js";
import { hostOf } from "./browser-model.js";
import { lastingKey } from "./live.js";
import { Markdown } from "./markdown.js";
import { Icon } from "./micons.js";
import { copyText, haptic, pushBack, saveFile, shareText } from "./native.js";
import { advance, arrive, createReveal, drawnPrefix, prefix, revealing } from "./reveal.js";
import { actionSheet } from "./sheets.js";
import { toast } from "./store.js";

const imageSrc = (image, resolve) => (image.data ? `data:${image.mimeType};base64,${image.data}` : image.src ? resolve?.(image.src) || "" : "");

// ---- Picture viewer ----------------------------------------------------------------------------
function Viewer({ src, name, onClose }) {
	const [leaving, setLeaving] = useState(false);
	const close = () => {
		setLeaving(true);
		setTimeout(onClose, 180);
	};
	useEffect(() => pushBack(() => (close(), true)), []);
	const save = async () => {
		const match = /^data:([^;]+);base64,(.*)$/.exec(src);
		if (!match) return;
		try {
			await saveFile(name || `myharness-${Date.now()}.${match[1].split("/")[1] || "png"}`, match[1], match[2]);
			toast(t("Saved to Downloads"), "ok");
		} catch (error) {
			toast(error.message, "error");
		}
	};
	return html`<div class="viewer ${leaving ? "leaving" : ""}" onClick=${close}>
		<img src=${src} alt="" />
		<div class="viewer-bar" onClick=${(event) => event.stopPropagation()}>
			${src.startsWith("data:") && html`<button class="icon-btn" onClick=${save} aria-label=${t("Save")}><${Icon} name="download" size=${22} /></button>`}
			<button class="icon-btn" onClick=${close} aria-label=${t("Close")}><${Icon} name="x" size=${22} /></button>
		</div>
	</div>`;
}

// ---- The user's message ------------------------------------------------------------------------
function useLongPress(onLongPress) {
	const timer = useRef(0);
	const [pressed, setPressed] = useState(false);
	const cancel = () => {
		clearTimeout(timer.current);
		setPressed(false);
	};
	return {
		pressed,
		handlers: {
			onPointerDown: (event) => {
				if (event.pointerType === "mouse" && event.button !== 0) return;
				setPressed(true);
				timer.current = setTimeout(() => {
					setPressed(false);
					haptic("long");
					onLongPress();
				}, 420);
			},
			onPointerUp: cancel,
			onPointerLeave: cancel,
			onPointerCancel: cancel,
			onPointerMove: (event) => (Math.abs(event.movementX) > 4 || Math.abs(event.movementY) > 4) && cancel(),
			onContextMenu: (event) => event.preventDefault(),
		},
	};
}

function UserMessage({ item, actions, resolveImage, onView }) {
	const long = item.text.length > 700 || item.text.split("\n").length > 12;
	const [open, setOpen] = useState(false);
	const menu = async () => {
		const choice = await actionSheet({
			actions: [
				{ value: "copy", label: t("Copy"), icon: "copy" },
				actions.edit && { value: "edit", label: t("Put back in the input box"), icon: "edit" },
				{ value: "share", label: t("Share"), icon: "share" },
			],
		});
		if (choice === "copy") (await copyText(item.text)) && toast(t("Copied"), "ok", 1400);
		else if (choice === "edit") actions.edit(item.text);
		else if (choice === "share") shareText(item.text);
	};
	const press = useLongPress(menu);
	const sending = item.pending && !item.delivered;
	return html`<div class="user-row ${sending ? "user-pending" : ""}">
		${item.command?.name && html`<span class="user-tag">/${item.command.name}</span>`}
		${item.images?.length > 0 &&
		html`<div class="user-images">
			${item.images.map((image, index) => {
				const src = imageSrc(image, resolveImage);
				return src ? html`<img key=${index} src=${src} alt="" loading="lazy" onClick=${() => onView(src)} />` : null;
			})}
		</div>`}
		${item.attachments?.length > 0 &&
		html`<div class="user-files">
			${item.attachments.map(
				(file) => html`<div class="file-card" key=${file.path || file.name}>
					<span class="ficon"><${Icon} name="file" size=${18} /></span>
					<span class="fname">${file.name}${file.size ? html` <span class="dim">· ${fmtBytes(file.size)}</span>` : null}</span>
				</div>`,
			)}
		</div>`}
		${item.text &&
		html`<div class="user-bubble ${press.pressed ? "pressed" : ""} ${long && !open ? "folded" : ""}" ...${press.handlers}>
			<div class="bubble-text">${item.text}</div>
			${long && html`<button class="bubble-more" onClick=${() => setOpen(!open)}>${open ? t("Show less") : t("Show more")}</button>`}
		</div>`}
		${sending && html`<span class="user-note"><${Spinner} size=${11} />${t("Sending…")}</span>`}
	</div>`;
}

// ---- The work ----------------------------------------------------------------------------------
const KIND_ICON = { read: "file", list: "folder", find: "search", search: "search", run: "terminal", edit: "edit", write: "edit", web: "globe", fetch: "globe", github: "gitBranch", mail: "mail", agent: "layers", history: "clock", tool: "wrench" };

function stepIcon(step) {
	if (step.status === "running" || step.status === "pending") return html`<${Spinner} size=${13} />`;
	if (step.isError) return html`<${Icon} name="alertCircle" size=${15} />`;
	return html`<${Icon} name=${step.call?.name === "browser" ? "globe" : KIND_ICON[step.kind] || "wrench"} size=${15} />`;
}

/** The phone's `browser` tool in words (the shared model only knows the desktop's tools). */
function browserTitle(step) {
	const args = step.call.args || {};
	const running = step.status === "running" || step.status === "pending";
	const words = {
		open: [t("Opening in the browser"), t("Opened in the browser")],
		read: [t("Reading the browser page"), t("Read the browser page")],
		screenshot: [t("Capturing the browser page"), t("Captured the browser page")],
		tabs: [t("Listing browser tabs"), t("Listed browser tabs")],
		close: [t("Closing a browser tab"), t("Closed a browser tab")],
	}[args.action] || [t("Using the browser"), t("Used the browser")];
	return { verb: step.isError ? t("Browser step failed") : running ? words[0] : words[1], target: args.url ? hostOf(args.url) || args.url : "" };
}

function stepWords(step) {
	if (step.call?.name === "browser") return browserTitle(step);
	return { verb: step.verb, target: step.target };
}

function ActionDetail({ step }) {
	const args = step.call.args && typeof step.call.args === "object" ? step.call.args : {};
	const output = step.result?.text || step.run?.partial || "";
	const argText = Object.keys(args).length ? JSON.stringify(args, null, 2) : "";
	return html`<div class="step-detail selectable">
		${argText && html`<span class="dlabel">${t("Request")}</span><pre>${clip(argText, 3000)}</pre>`}
		${output && html`<span class="dlabel">${step.isError ? t("Error") : t("Result")}</span><pre>${clip(output, 6000)}</pre>`}
		${!argText && !output && html`<span class="dim">${t("Nothing to show yet.")}</span>`}
	</div>`;
}

function WebResults({ actions, onOpenUrl }) {
	const seen = new Set();
	const rows = [];
	for (const action of actions) {
		for (const row of [...(action.result?.details?.results || []), ...(action.result?.details?.pages || [])]) {
			if (!row?.url || seen.has(row.url)) continue;
			seen.add(row.url);
			rows.push(row);
		}
	}
	if (!rows.length) return null;
	return html`<div class="web-list">
		${rows.slice(0, 12).map(
			(row) => html`<button class="web-item" key=${row.url} onClick=${() => onOpenUrl(row.url)}>
				<${Icon} name="globe" size=${14} />
				<span class="wtitle">${row.title || row.url}</span>
				<span class="whost">${hostOf(row.url)}</span>
			</button>`,
		)}
		${rows.length > 12 && html`<span class="dim" style="padding:2px 4px;font-size:var(--fs-xs)">${t("and {n} more", { n: rows.length - 12 })}</span>`}
	</div>`;
}

function StepGroup({ group, onOpenUrl }) {
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState(null);
	const single = group.actions.length === 1 ? group.actions[0] : null;
	const running = group.actions.some((action) => action.status === "running" || action.status === "pending");
	const failed = group.actions.every((action) => action.isError);
	const head = single ? stepWords(single) : { verb: groupLabel(group.kind, group.actions), target: "" };
	const lead = single || group.actions.find((action) => action.status === "running") || group.actions[group.actions.length - 1];
	const isWeb = group.kind === "web";
	return html`<div>
		<button class="step-row ${failed ? "error" : ""} ${running ? "running" : ""}" onClick=${() => setOpen(!open)} aria-expanded=${open ? "true" : "false"}>
			<span class="sico">${stepIcon(single || { ...lead, isError: failed })}</span>
			<span class="stext"><span class="verb">${head.verb}</span>${head.target ? html` <span class="target">${clip(head.target, 140)}</span>` : null}</span>
		</button>
		<${Collapse} open=${open}>
			${open &&
			(single
				? isWeb
					? html`<${WebResults} actions=${[single]} onOpenUrl=${onOpenUrl} /><${ActionDetail} step=${single} />`
					: html`<${ActionDetail} step=${single} />`
				: html`<div style="margin-left:27px">
						${group.actions.map((action) => {
							const words = stepWords(action);
							return html`<div key=${action.key}>
								<button class="step-row ${action.isError ? "error" : ""}" onClick=${() => setDetail(detail === action.key ? null : action.key)}>
									<span class="sico">${stepIcon(action)}</span>
									<span class="stext"><span class="verb">${words.verb}</span>${words.target ? html` <span class="target">${clip(words.target, 140)}</span>` : null}</span>
								</button>
								${detail === action.key && html`<div style="margin-left:-27px"><${ActionDetail} step=${action} /></div>`}
							</div>`;
						})}
						${isWeb && html`<div style="margin-left:-27px"><${WebResults} actions=${group.actions} onOpenUrl=${onOpenUrl} /></div>`}
					</div>`)}
		<//>
	</div>`;
}

function Thinking({ step }) {
	const [open, setOpen] = useState(false);
	const empty = !step.text;
	return html`<div>
		<button class="step-row ${step.live ? "running" : ""}" onClick=${() => !empty && setOpen(!open)} aria-expanded=${open ? "true" : "false"}>
			<span class="sico">${step.live ? html`<${Spinner} size=${13} />` : html`<${Icon} name="brain" size=${15} />`}</span>
			<span class="stext"><span class="verb">${step.live ? t("Thinking") : t("Thought")}</span>${!open && step.text ? html` <span class="target">${clip(step.text.replace(/\s+/g, " "), 60)}</span>` : null}</span>
		</button>
		<${Collapse} open=${open}>${open && html`<div class="think-text selectable"><${Markdown} text=${step.text} /></div>`}<//>
	</div>`;
}

/** What a block of work is doing right now, or did: the line shown on its folded head. */
function processSummary(segment, live) {
	const steps = segment.steps;
	if (live) {
		const last = steps[steps.length - 1];
		if (last?.type === "thinking") return t("Thinking");
		if (last?.type === "action") {
			const words = stepWords(last);
			return `${words.verb}${words.target ? ` ${clip(words.target, 60)}` : ""}`;
		}
		return t("Working");
	}
	const actions = steps.filter((step) => step.type === "action");
	const thought = steps.some((step) => step.type === "thinking");
	if (!actions.length) return thought ? t("Thought it through") : t("Worked on it");
	const web = actions.filter((step) => step.kind === "web" || step.kind === "fetch").length;
	if (web === actions.length) return groupLabel("web", actions);
	return t("Took {steps}", { steps: count(actions.length, "step") });
}

function Process({ segment, live, defaultOpen, entering, onOpenUrl }) {
	const [open, setOpen] = useState(defaultOpen);
	const touched = useRef(false);
	// The block of a reply being written stays open so the work can be watched; it folds itself when the answer starts,
	// unless the reader opened or closed it by hand.
	useEffect(() => {
		if (!touched.current) setOpen(defaultOpen);
	}, [defaultOpen]);
	const groups = useMemo(() => groupSteps(segment.steps), [segment.steps]);
	const failed = segment.stats?.failedActions > 0;
	return html`<div class="process ${live ? "live" : ""} ${entering ? "part-in" : ""}">
		<button
			class="process-head"
			aria-expanded=${open ? "true" : "false"}
			onClick=${() => {
				touched.current = true;
				haptic("tick");
				setOpen(!open);
			}}
		>
			<span class="pico">${live ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${failed ? "alertCircle" : "sparkle"} size=${16} />`}</span>
			<span class="ptext ${live ? "shimmer-text" : ""}">${processSummary(segment, live)}</span>
			<span class="disclose"><${Icon} name="chevronRight" size=${15} /></span>
		</button>
		<${Collapse} open=${open}>
			${open &&
			html`<div class="process-body">
				${groups.map((entry) => {
					if (entry.type === "group") return html`<${StepGroup} key=${entry.key} group=${entry} onOpenUrl=${onOpenUrl} />`;
					if (entry.type === "thinking") return html`<${Thinking} key=${entry.key} step=${entry} />`;
					if (entry.type === "note") return html`<div class="note-text" key=${entry.key} style="padding:4px 0 6px"><${Markdown} text=${entry.text} /></div>`;
					if (entry.type === "custom") return html`<div class="step-row" key=${entry.key}><span class="sico"><${Icon} name="info" size=${15} /></span><span class="stext">${clip(entry.item.text, 400)}</span></div>`;
					return null;
				})}
			</div>`}
		<//>
	</div>`;
}

// ---- Text that is being written ----------------------------------------------------------------
// Messages that arrived while the page was open (by an event, not read from the saved chat), and when each was first
// drawn: only those are written out. A chat opened later shows its replies whole.
const firstDrawn = new Map();
const FRESH_MS = 5000;
const STALE_MS = 15000;

function arrivedJustNow(message) {
	const id = message?.liveId;
	if (!id) return false;
	const now = performance.now();
	if (!firstDrawn.has(id)) {
		// A reply that ended a while ago and is drawn only now (its chat was not on screen) did not arrive just now.
		const old = message.final && message.endedAt && Date.now() - message.endedAt > STALE_MS;
		firstDrawn.set(id, old ? now - FRESH_MS : now);
		if (firstDrawn.size > 300) firstDrawn.delete(firstDrawn.keys().next().value);
	}
	return !message.final || now - firstDrawn.get(id) < FRESH_MS;
}

// How far each text of a reply has been written out, by the name of its place in the reply (`textName`). A text keeps
// its name while it moves on the page: what the model writes is drawn as the answer until a tool call follows it, and
// from then on as a note between the steps; and a reply read again from the PC keeps the name it had while it was
// written (live.js: carryLive). Without this memory the same words were written out a second time.
const written = new Map(); // name → { text, shown }
const WRITTEN_MAX = 400;

/** Text is shown whole, not written out: the reader switched motion off, or the page is not on screen. */
const shownAtOnce = () => document.documentElement.dataset.motion === "off" || document.visibilityState === "hidden";

function writtenSoFar(name, text) {
	const before = name ? written.get(name) : null;
	return before && text.startsWith(prefix(before.text, before.shown)) ? Math.min(before.shown, text.length) : 0;
}

function noteWritten(name, text, shown) {
	if (!name) return;
	written.delete(name);
	written.set(name, { text, shown });
	if (written.size > WRITTEN_MAX) written.delete(written.keys().next().value);
}

/** A text that arrived just now (`fresh` when nothing of it was drawn yet) is still being written out. */
function beingWritten(name, text, fresh) {
	if (!text || shownAtOnce()) return false;
	const before = written.get(name);
	if (!before) return !!fresh;
	return before.shown < text.length && text.startsWith(prefix(before.text, before.shown));
}

/** The name of a reply's answer text: the same as the note it becomes when a tool call follows (turns.js: a step's key). */
function textName(message) {
	const at = (message.blocks || []).findIndex((block) => block.type === "text" && block.text?.trim());
	return `${message.liveId || message.id || message.ts}-${Math.max(at, 0)}`;
}

/**
 * A reply's text. While it arrives (`fresh` when it is first drawn) it is written out at a steady speed instead of
 * jumping by whatever piece came in (reveal.js); `open`: more may still come. Text that was there when the chat was
 * opened is simply shown. `name`: see `written`; `onWritten` is called when the text is on the page to its end.
 */
function StreamText({ text, fresh, open, caret, name, onWritten }) {
	const state = useRef(null);
	if (!state.current) state.current = { reveal: createReveal(fresh && !shownAtOnce() ? writtenSoFar(name, text) : text.length), text, frame: 0, at: 0 };
	const s = state.current;
	const [shown, setShown] = useState(() => Math.floor(s.reveal.shown));
	// Text that is not the old text with more at its end (another message in the same place) is shown whole.
	if (shownAtOnce() || !text.startsWith(prefix(s.text, Math.floor(s.reveal.shown)))) s.reveal = createReveal(text.length);
	s.text = text;
	s.name = name;
	s.onWritten = onWritten;
	useLayoutEffect(() => {
		// Nobody watches a page that is not on screen, and it gets no frames to write in.
		if (shownAtOnce()) s.reveal = createReveal(text.length);
		arrive(s.reveal, text.length, performance.now(), !open);
		// The frames go on while more text arrives: they read what is current, not what was when they started.
		const show = (count) => {
			setShown(count);
			noteWritten(s.name, s.text, count);
			// What comes after this text on the page waited for it (Turn).
			if (count >= s.text.length) s.onWritten?.();
		};
		if (!revealing(s.reveal)) {
			show(text.length);
			return;
		}
		noteWritten(s.name, s.text, Math.floor(s.reveal.shown));
		if (s.frame) return;
		s.at = 0;
		const tick = (now) => {
			s.frame = 0;
			const count = advance(s.reveal, s.at ? now - s.at : 8);
			s.at = now;
			show(count);
			if (revealing(s.reveal)) s.frame = requestAnimationFrame(tick);
		};
		s.frame = requestAnimationFrame(tick);
	}, [text, open]);
	useEffect(() => () => cancelAnimationFrame(s.frame), []);
	const writing = shown < text.length;
	return html`<${Markdown} text=${writing ? drawnPrefix(text, shown) : text} />${caret || writing ? html`<span class="caret"></span>` : null}`;
}

// ---- A turn ------------------------------------------------------------------------------------
function ChangesCard({ item }) {
	const files = item.files || [];
	const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
	const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
	return html`<div class="card">
		<div class="ctitle"><${Icon} name="fileDiff" size=${16} />${t("Changed {files}", { files: count(files.length, "file") })}<span class="counts"><span class="add">+${additions}</span><span class="del">−${deletions}</span></span></div>
		${files.slice(0, 8).map((file) => html`<div class="cline" key=${file.path}><span class="cpath">${file.path}</span><span class="counts"><span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></span></div>`)}
		${files.length > 8 && html`<div class="cline dim">${t("and {n} more", { n: files.length - 8 })}</div>`}
	</div>`;
}

const OUTCOME_NOTE = { cancelled: "Stopped", redirected: "Switched to your new message", unanswered: "No response" };

const Turn = memo(function Turn({ turn, live, awaiting, run, last, actions, resolveImage, onView, onOpenUrl, modelLabel }) {
	const done = !live;
	const segments = useMemo(() => turnSegments(turn, { fold: done }), [turn, done]);
	const outcome = turnOutcome(turn, { run, live, waiting: false });
	const duration = done ? turnDuration(turn, run) : 0;
	const finalText = turn.final?.text || "";
	const copyAnswer = async () => (await copyText(finalText)) && (haptic("tick"), toast(t("Copied"), "ok", 1400));
	// The parts of a reply appear one after another, as they were made. Through Google Drive several come at once (a
	// sentence, the tool call after it, its result and the answer): drawn together, the tool call was done before the
	// sentence in front of it was written, and two texts were written at the same time. So while a text is being written
	// out, what follows it waits (`held`); the text says when it is done (`onWritten`).
	const messages = useMemo(() => new Map((turn.assistants || []).map((message) => [String(message.liveId || message.id || message.ts), message])), [turn]);
	// A note's key is its message's name and the number of its block (turns.js). Asked only for a note that is drawn:
	// asking is what marks a message as drawn.
	const freshNote = (step) => {
		const message = messages.get(step.key.replace(/-\d+$/, ""));
		return message ? arrivedJustNow(message) : live;
	};
	const fresh = new Map();
	const freshOf = (step) => (fresh.has(step.key) ? fresh.get(step.key) : fresh.set(step.key, freshNote(step)).get(step.key));
	const [, redraw] = useState(0);
	const holding = useRef(false);
	const onWritten = useCallback(() => holding.current && redraw((n) => n + 1), []);
	let shownSegments = segments.length;
	if (live) {
		const first = segments.findIndex((segment) => segment.type === "text" && beingWritten(segment.step.key, segment.step.text, freshOf(segment.step)));
		if (first >= 0) shownSegments = first + 1;
	}
	const lastShown = segments[shownSegments - 1];
	const held = shownSegments < segments.length || (live && !!turn.final && lastShown?.type === "text" && beingWritten(lastShown.step.key, lastShown.step.text, freshOf(lastShown.step)));
	holding.current = held;
	const lastProcess = segments.reduce((at, segment, index) => (segment.type === "process" ? index : at), -1);
	const lastSegment = segments[segments.length - 1];
	// The block of work that is going on right now, or text that is being written: the page shows that the PC is busy.
	const working = live && !turn.final && lastProcess >= 0 && lastProcess === segments.length - 1;
	const writing = !!turn.final?.streaming || (lastSegment?.type === "text" && !!lastSegment.step.streaming);
	// Otherwise the three dots say so, for as long as the reply is not over: also between the moment the model starts
	// and its first word, which through Google Drive can be seconds.
	const waiting = live && !held && (awaiting || !(working || writing));
	// Parts that appear while the reply is written come in softly; a chat that is opened shows them at once.
	const part = live ? "part-in" : "";
	return html`<div class="turn enter" data-turn=${turn.key}>
		${turn.jobReport && html`<div class="marker">${t("Background work finished")}</div>`}
		${turn.user && html`<${UserMessage} item=${turn.user} actions=${actions} resolveImage=${resolveImage} onView=${onView} />`}
		${[
			...segments
				.slice(0, shownSegments)
				.map((segment, index) =>
					segment.type === "process"
						? html`<${Process} key=${segment.key} segment=${segment} live=${live && index === lastProcess && !turn.final && index === segments.length - 1} defaultOpen=${live && !turn.final && index === segments.length - 1} entering=${live} onOpenUrl=${onOpenUrl} />`
						: html`<div class="final ${part}" key=${segment.key}><${StreamText} text=${segment.step.text} fresh=${live && freshOf(segment.step)} open=${!!segment.step.streaming} name=${segment.step.key} onWritten=${onWritten} /></div>`,
				),
			// The answer has the key of the note it was or becomes (see `written`), so the same element goes on being written.
			turn.final && !held
				? html`<div class="final selectable ${part}" key=${`x-${textName(turn.final.message)}`}><${StreamText} text=${finalText} fresh=${arrivedJustNow(turn.final.message)} open=${!!turn.final.streaming} caret=${!!turn.final.streaming} name=${textName(turn.final.message)} /></div>`
				: null,
		]}
		${waiting && html`<div class="status-line part-in"><span class="typing"><i></i><i></i><i></i></span></div>`}
		${turn.changes && html`<${ChangesCard} item=${turn.changes} />`}
		${done &&
		turn.error &&
		outcome !== "cancelled" &&
		outcome !== "redirected" &&
		html`<div class="msg-error">
			<${Icon} name="alertCircle" size=${18} />
			<span class="etext selectable">${serverText(turn.error.message, turn.error.message)}</span>
			${last && actions.retry && html`<button class="btn sm" onClick=${actions.retry}>${t("Retry")}</button>`}
		</div>`}
		${done && OUTCOME_NOTE[outcome] && html`<div class="msg-error muted"><${Icon} name="stopCircle" size=${18} /><span class="etext">${t(OUTCOME_NOTE[outcome])}</span>${last && outcome === "cancelled" && actions.retry ? html`<button class="btn sm" onClick=${actions.retry}>${t("Retry")}</button>` : null}</div>`}
		${done &&
		finalText &&
		html`<div class="msg-actions">
			<button class="icon-btn" onClick=${copyAnswer} aria-label=${t("Copy")}><${Icon} name="copy" size=${17} /></button>
			<button class="icon-btn" onClick=${() => shareText(finalText)} aria-label=${t("Share")}><${Icon} name="share" size=${17} /></button>
			<span class="meta">${[duration > 1500 ? fmtDuration(duration) : "", turn.lastAssistant?.model || modelLabel || ""].filter(Boolean).join(" · ")}</span>
		</div>`}
	</div>`;
});

function Standalone({ item }) {
	if (item.kind === "compaction") return html`<div class="marker">${t("Earlier messages were summarized")}</div>`;
	if (item.kind === "branchSummary") return html`<div class="marker">${t("Continued from another branch")}</div>`;
	if (item.kind === "reload") return html`<div class="marker">${item.ok ? t("Settings reloaded") : t("Reload failed")}</div>`;
	if (item.kind === "bash")
		return html`<div class="card">
			<div class="ctitle"><${Icon} name="terminal" size=${16} /><span class="truncate mono">${clip(item.command, 120)}</span></div>
			${item.output && html`<pre class="selectable">${clip(item.output, 2500)}</pre>`}
		</div>`;
	if (item.kind === "runChanges") return html`<${ChangesCard} item=${item} />`;
	if (item.kind === "gitStatus" || item.kind === "gitRepair") return html`<div class="marker">${t("Git activity on the PC")}</div>`;
	if (item.kind === "custom" && item.text) return html`<div class="card"><div class="selectable" style="white-space:pre-wrap;overflow-wrap:anywhere">${clip(item.text, 1200)}</div></div>`;
	return null;
}

/**
 * The turns of a chat. `chat` is the live chat object of either side (store.js: emptyChat); `actions` are what the
 * reader can do: { edit(text), retry(), regenerate() }, each optional.
 */
export function Transcript({ items, toolRuns, runs, running, awaiting, cwd, actions, resolveImage, onOpenUrl, modelLabel }) {
	const previous = useRef(null);
	const names = useRef(new Map());
	const turns = useMemo(() => {
		const built = buildTurns(items, { toolRuns, cwd }, previous.current);
		previous.current = built;
		return built;
	}, [items, toolRuns, cwd]);
	const [viewing, setViewing] = useState(null);
	let lastRound = -1;
	for (let i = turns.length - 1; i >= 0; i--) {
		if (!turns[i].standalone) {
			lastRound = i;
			break;
		}
	}
	// The reply that is being written is the last turn's, unless that turn is only a message sent meanwhile, which waits
	// below the reply until the PC takes it: the reply above it goes on.
	let liveRound = lastRound;
	if (running) {
		let at = lastRound;
		while (at >= 0 && (turns[at].standalone || (turns[at].user?.pending && turns[at].user.whileRunning && !turns[at].assistants?.length))) at--;
		if (at >= 0) liveRound = at;
	}
	return html`<div class="turns">
		${turns.map((turn, index) => {
			if (turn.standalone) return html`<${Standalone} key=${turn.key} item=${turn.standalone} />`;
			const last = index === lastRound;
			const live = running && index === liveRound;
			return html`<${Turn}
				key=${lastingKey(names.current, turn)}
				turn=${turn}
				live=${live}
				awaiting=${live && awaiting}
				run=${live ? undefined : runForTurn(turn, runs, nextRound(turns, index))}
				last=${last}
				actions=${actions}
				resolveImage=${resolveImage}
				onView=${setViewing}
				onOpenUrl=${onOpenUrl}
				modelLabel=${last ? modelLabel : ""}
			/>`;
		})}
		${viewing && html`<${Viewer} src=${viewing} onClose=${() => setViewing(null)} />`}
	</div>`;
}
