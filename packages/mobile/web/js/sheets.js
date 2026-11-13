// What comes over the three panes: bottom sheets (menus, pickers, confirmations) and full pages (settings).
// Every layer closes with the system back key, a tap on the dimmed area, or by dragging it away.
import { t } from "/shared/i18n.js";
import { html, useEffect, useRef, useState } from "/shared/ui.js";
import { uid } from "/shared/util.js";
import { Icon } from "./micons.js";
import { haptic, pushBack } from "./native.js";
import { emit, state, useStore } from "./store.js";

const EXIT_MS = 230;

function openLayer(kind, render, options = {}) {
	const id = uid("layer");
	if (document.activeElement && document.activeElement !== document.body && !options.keepFocus) document.activeElement.blur();
	state.layers = [...state.layers, { id, kind, render, options }];
	emit();
	return () => closeLayer(id);
}

export function closeLayer(id) {
	const layer = state.layers.find((entry) => entry.id === id);
	if (!layer || layer.closing) return;
	state.layers = state.layers.map((entry) => (entry.id === id ? { ...entry, closing: true } : entry));
	emit();
	setTimeout(() => {
		state.layers = state.layers.filter((entry) => entry.id !== id);
		emit();
		layer.options.onClosed?.();
	}, document.documentElement.dataset.motion === "off" ? 0 : EXIT_MS);
}

/** Open a bottom sheet. `render(close)` returns its content (use the Sheet component). Returns the function that closes it. */
export const openSheet = (render, options) => openLayer("sheet", render, options);
/** Open a full page that slides in from the right. `render(close)` returns its content (use the Page component). */
export const openPage = (render, options) => openLayer("page", render, options);

/** Drag a sheet down by its handle, or a page right from its left edge; far or fast enough closes it. */
function useDismissDrag(ref, axis, close) {
	const drag = useRef(null);
	const onDown = (event) => {
		if (axis === "x" && event.clientX > 28) return;
		drag.current = { id: event.pointerId, start: axis === "y" ? event.clientY : event.clientX, last: 0, time: event.timeStamp, speed: 0, moved: false };
	};
	const onMove = (event) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		const delta = Math.max(0, (axis === "y" ? event.clientY : event.clientX) - current.start);
		if (!current.moved && delta < 6) return;
		if (!current.moved) {
			current.moved = true;
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				// The pointer is gone already.
			}
			ref.current?.classList.add("dragging");
		}
		const dt = Math.max(1, event.timeStamp - current.time);
		current.speed = (delta - current.last) / dt;
		current.last = delta;
		current.time = event.timeStamp;
		if (ref.current) ref.current.style.transform = axis === "y" ? `translateY(${delta}px)` : `translateX(${delta}px)`;
	};
	const onUp = (event) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = null;
		const node = ref.current;
		if (!node || !current.moved) return;
		node.classList.remove("dragging");
		const size = axis === "y" ? node.offsetHeight : node.offsetWidth;
		const away = current.last > size * 0.33 || current.speed > 0.55;
		node.style.transform = "";
		if (away) close();
	};
	return { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
}

function Layer({ layer, top }) {
	const [open, setOpen] = useState(false);
	const close = () => closeLayer(layer.id);
	// A tap closes the layer only when it began on the dimmed area: the finger that opened a menu by a long
	// press is still down when the menu appears, and lifting it must not close the menu again.
	const pressed = useRef(false);
	useEffect(() => {
		const timer = setTimeout(() => setOpen(true), 20);
		const removeBack = pushBack(() => {
			if (layer.options.onBack?.() === true) return true;
			close();
			return true;
		});
		return () => {
			clearTimeout(timer);
			removeBack();
		};
	}, []);
	return html`<div class="layer ${open && !layer.closing ? "open" : ""} ${layer.closing ? "closing" : ""}" data-kind=${layer.kind} data-top=${top ? "1" : undefined}>
		<div
			class="layer-scrim"
			onPointerDown=${() => (pressed.current = true)}
			onClick=${() => {
				const began = pressed.current;
				pressed.current = false;
				if (began && !layer.options.modal) close();
			}}
		></div>
		${layer.render(close)}
	</div>`;
}

/** Draws every open layer; mounted once by main.js. */
export function Layers() {
	const layers = useStore((s) => s.layers);
	return layers.map((layer, index) => html`<${Layer} key=${layer.id} layer=${layer} top=${index === layers.length - 1} />`);
}

export function Sheet({ title, sub, close, children, footer, class: cls, bodyClass }) {
	const ref = useRef(null);
	const drag = useDismissDrag(ref, "y", close);
	return html`<div class="sheet ${cls || ""}" ref=${ref} role="dialog" aria-modal="true">
		<div class="sheet-grip" ...${drag}></div>
		${title && html`<div class="sheet-head" ...${drag}><h2>${title}${sub ? html` <span class="sub">${sub}</span>` : null}</h2></div>`}
		<div class="sheet-body ${bodyClass || ""}">${children}</div>
		${footer && html`<div class="sheet-foot">${footer}</div>`}
	</div>`;
}

export function Page({ title, close, children, action }) {
	const ref = useRef(null);
	const drag = useDismissDrag(ref, "x", close);
	return html`<div class="page" ref=${ref} role="dialog" aria-modal="true" ...${drag}>
		<div class="page-head">
			<button class="icon-btn" onClick=${close} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${22} /></button>
			<h2>${title}</h2>
			${action}
		</div>
		<div class="page-body"><div class="inner">${children}</div></div>
	</div>`;
}

/** One row of a grouped list. */
export function Row({ icon, title, sub, value, chevron, danger, on, check, onClick, disabled, children }) {
	const inner = html`${icon && html`<span class="ricon"><${Icon} name=${icon} size=${18} /></span>`}
		<span class="rmain"><span class="rtitle">${title}</span>${sub ? html`<span class="rsub">${sub}</span>` : null}</span>
		${value != null && value !== "" ? html`<span class="rvalue">${value}</span>` : null}
		${children}
		${check ? html`<span class="check"><${Icon} name="check" size=${20} /></span>` : null}
		${chevron ? html`<span class="rchev"><${Icon} name="chevronRight" size=${16} /></span>` : null}`;
	const cls = `rowi ${danger ? "danger" : ""} ${on ? "on" : ""}`;
	return onClick ? html`<button class=${cls} onClick=${onClick} disabled=${disabled}>${inner}</button>` : html`<div class=${cls}>${inner}</div>`;
}

export function Switch({ on, onChange, label }) {
	return html`<button
		class="toggle ${on ? "on" : ""}"
		role="switch"
		aria-checked=${on ? "true" : "false"}
		aria-label=${label}
		onClick=${(event) => {
			event.stopPropagation();
			haptic("tick");
			onChange(!on);
		}}
	></button>`;
}

/** A menu of actions. Resolves with the chosen value, or undefined when it was dismissed. */
export function actionSheet({ title, sub, actions }) {
	return new Promise((resolve) => {
		let chosen;
		openSheet(
			(close) => html`<${Sheet} title=${title} sub=${sub} close=${close}>
				<div class="rows">
					${actions.filter(Boolean).map(
						(action) => html`<${Row}
							key=${action.value}
							icon=${action.icon}
							title=${action.label}
							sub=${action.sub}
							danger=${action.danger}
							check=${action.checked}
							on=${action.checked}
							disabled=${action.disabled}
							onClick=${() => {
								chosen = action.value;
								haptic("tick");
								close();
							}}
						/>`,
					)}
				</div>
			<//>`,
			{ onClosed: () => resolve(chosen) },
		);
	});
}

/** Ask before something that cannot be undone. Resolves true only on the confirming button. */
export function confirmSheet({ title, message, confirmLabel = t("Confirm"), cancelLabel = t("Cancel"), danger = false }) {
	return new Promise((resolve) => {
		let answer = false;
		openSheet(
			(close) => html`<${Sheet}
				title=${title}
				close=${close}
				footer=${html`<button class="btn" onClick=${close}>${cancelLabel}</button>
					<button
						class="btn ${danger ? "danger solid" : "primary"}"
						onClick=${() => {
							answer = true;
							haptic(danger ? "reject" : "confirm");
							close();
						}}
					>
						${confirmLabel}
					</button>`}
			>
				${message && html`<div class="sheet-text">${message}</div>`}
			<//>`,
			{ onClosed: () => resolve(answer) },
		);
	});
}

function TextPrompt({ close, title, label, value, placeholder, multiline, confirmLabel, hint, password, validate, onDone }) {
	const [text, setText] = useState(value || "");
	const [error, setError] = useState("");
	const input = useRef(null);
	useEffect(() => {
		const timer = setTimeout(() => input.current?.focus(), 260);
		return () => clearTimeout(timer);
	}, []);
	const submit = () => {
		const problem = validate?.(text);
		if (problem) return setError(problem);
		onDone(text);
		close();
	};
	return html`<${Sheet}
		title=${title}
		close=${close}
		footer=${html`<button class="btn" onClick=${close}>${t("Cancel")}</button><button class="btn primary" onClick=${submit}>${confirmLabel || t("Save")}</button>`}
	>
		<div class="form-field">
			${label && html`<label>${label}</label>`}
			${multiline
				? html`<textarea class="field" ref=${input} rows="6" placeholder=${placeholder} value=${text} onInput=${(event) => (setText(event.target.value), setError(""))}></textarea>`
				: html`<input
						class="field ${error ? "invalid" : ""}"
						ref=${input}
						type=${password ? "password" : "text"}
						autocomplete="off"
						autocapitalize="off"
						spellcheck=${false}
						placeholder=${placeholder}
						value=${text}
						onInput=${(event) => (setText(event.target.value), setError(""))}
						onKeyDown=${(event) => event.key === "Enter" && submit()}
					/>`}
			${error ? html`<div class="hint bad">${error}</div>` : hint ? html`<div class="hint">${hint}</div>` : null}
		</div>
	<//>`;
}

/** Ask for a line (or a block) of text. Resolves with the text, or null when it was dismissed. */
export function promptSheet(options) {
	return new Promise((resolve) => {
		let result = null;
		openSheet((close) => html`<${TextPrompt} ...${options} close=${close} onDone=${(text) => (result = text)} />`, { onClosed: () => resolve(result), keepFocus: false });
	});
}

/** Pick one of several options (a checked list). Resolves with the value, or undefined when dismissed. */
export function pickSheet({ title, sub, options, value }) {
	return actionSheet({ title, sub, actions: options.map((option) => ({ ...option, checked: option.value === value })) });
}
