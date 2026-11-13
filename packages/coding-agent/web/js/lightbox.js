// Image viewer: one fullscreen overlay shared by the composer thumbnails, the message images and the pictures of a
// reply. The picture opens whole, never enlarged past its own pixels, and can then be looked at closely: the wheel
// zooms at the pointer, dragging moves it, a double click switches between the whole picture and its real size.
import { html, useEffect, useLayoutEffect, useRef, useState, Icon, motionEnabled, usePresence } from "./ui.js";
import { t } from "./i18n.js";
import { ZOOM_STEP, clampView, fitScale, scaleLimits, wheelFactor, zoomAt } from "./lightbox-view.js";

// Small module-local signal (the store's style, without persistence): a value plus a listener set.
const listeners = new Set();
let current = null;
let previousFocus = null;
function get() {
	return current;
}
function emit() {
	for (const fn of [...listeners]) fn(current);
}
function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
function useLightbox() {
	const [, force] = useState(0);
	useLayoutEffect(() => subscribe(() => force((n) => n + 1)), []);
	return get();
}

/**
 * Show `src` fullscreen. A missing image never opens (the caller asked for nothing), and the keyboard is handed
 * back to what had it once the preview closes.
 */
export function openImageLightbox(src, alt) {
	if (!src || typeof src !== "string" || get()?.src === src) return;
	if (typeof document !== "undefined" && !get()) previousFocus = document.activeElement;
	current = { src, alt: typeof alt === "string" && alt ? alt : "" };
	emit();
}

export function closeImageLightbox() {
	if (!get()) return;
	current = null;
	emit();
	if (typeof document === "undefined") return;
	// Hand the keyboard back unless the focus already moved on (the overlay may still be fading out).
	const active = document.activeElement;
	if (!active || active === document.body || active.closest?.(".lightbox-scrim")) previousFocus?.focus?.();
	previousFocus = null;
}

/**
 * The host mounted once at the root of the app. The Escape listener is permanent (so it runs before the dialogs'
 * own capture listeners and a press never closes what sits below the preview), the overlay only while it shows.
 */
export function ImageLightboxHost() {
	const preview = useLightbox();
	const { mounted, shown } = usePresence(!!preview, motionEnabled() ? 170 : 0);
	const closeRef = useRef(null);
	const dialogRef = useRef(null);
	const last = useRef(null);
	// The picture's own pixel size (known once it loaded), and how it is looked at: scale, and its center's offset.
	const [size, setSize] = useState(null);
	const [view, setViewState] = useState({ scale: 1, x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const live = useRef({ size: null, view });
	live.current = { size, view };
	// Whether the picture was shown whole when this was last drawn: a window that changes size keeps it whole.
	const whole = useRef(true);
	const drag = useRef(null);
	if (preview) last.current = preview;

	const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight });
	const fitOf = (of = live.current.size) => (of ? fitScale(of.width, of.height, windowSize().width, windowSize().height) : 1);
	const apply = (next) => {
		const of = live.current.size;
		if (!of) return;
		const { min, max } = scaleLimits(fitOf(of));
		const scale = Math.min(max, Math.max(min, next.scale));
		// A clamped scale keeps the point it had: only the part of the step that was taken moves the picture.
		const moved = scale === next.scale ? next : zoomAt(live.current.view, scale, next.point);
		setViewState(clampView({ scale, x: moved.x, y: moved.y }, of, windowSize().width, windowSize().height));
	};
	const zoomTo = (scale, point) => apply({ ...zoomAt(live.current.view, scale, point), point });
	const showWhole = () => setViewState({ scale: fitOf(), x: 0, y: 0 });
	const isWhole = () => Math.abs(live.current.view.scale - fitOf()) < 0.001 && live.current.view.x === 0 && live.current.view.y === 0;
	const pointOf = (event) => ({ x: event.clientX - window.innerWidth / 2, y: event.clientY - window.innerHeight / 2 });

	// A new picture starts whole.
	useLayoutEffect(() => {
		setSize(null);
		setViewState({ scale: 1, x: 0, y: 0 });
	}, [preview?.src]);

	useEffect(() => {
		const onKey = (event) => {
			if (!get()) return;
			if (event.key === "Escape") {
				// A press while the preview is open ends here: not in the settings/quote dialog below, not in the composer.
				event.stopImmediatePropagation();
				event.preventDefault();
				closeImageLightbox();
				return;
			}
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const current = live.current.view;
			const pan = 80;
			const move = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] }[event.key];
			if (event.key === "+" || event.key === "=") zoomTo(current.scale * ZOOM_STEP);
			else if (event.key === "-" || event.key === "_") zoomTo(current.scale / ZOOM_STEP);
			else if (event.key === "0") showWhole();
			else if (event.key === "1") zoomTo(1);
			else if (move) apply({ scale: current.scale, x: current.x + move[0], y: current.y + move[1] });
			else return;
			event.stopImmediatePropagation();
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	useEffect(() => {
		if (preview) closeRef.current?.focus?.({ preventScroll: true });
	}, [preview]);
	// The window changed size: a picture shown whole stays whole, any other view stays where it is but inside the window.
	useEffect(() => {
		if (!preview) return undefined;
		const onResize = () => (whole.current ? showWhole() : apply(live.current.view));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [preview?.src]);

	if (!mounted) return null;
	whole.current = !size || isWhole();
	const image = preview || last.current;
	const percent = Math.round(view.scale * 100);
	const onLoad = (event) => {
		const element = event.currentTarget;
		// A vector picture may not say how large it is: it gets a size that reads well and can be zoomed like any other.
		const width = element.naturalWidth || 1200;
		const height = element.naturalHeight || Math.round(width * 0.75);
		const next = { width, height };
		live.current = { size: next, view: live.current.view };
		setSize(next);
		setViewState({ scale: fitScale(width, height, window.innerWidth, window.innerHeight), x: 0, y: 0 });
	};
	const onWheel = (event) => {
		if (!live.current.size) return;
		event.preventDefault();
		zoomTo(live.current.view.scale * wheelFactor(event.deltaY, event.deltaMode), pointOf(event));
	};
	const onPointerDown = (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: live.current.view };
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDragging(true);
	};
	const onPointerMove = (event) => {
		const held = drag.current;
		if (!held || held.id !== event.pointerId) return;
		apply({ scale: held.from.scale, x: held.from.x + event.clientX - held.x, y: held.from.y + event.clientY - held.y });
	};
	const endDrag = (event) => {
		if (drag.current?.id !== event.pointerId) return;
		drag.current = null;
		setDragging(false);
	};
	const onDoubleClick = (event) => {
		// Whole picture <-> real size at the place that was clicked. A picture that is already whole at real size goes
		// to twice that instead, so a double click always shows something.
		if (!isWhole()) showWhole();
		else zoomTo(fitOf() < 1 ? 1 : 2, pointOf(event));
	};
	const width = size ? size.width * view.scale : undefined;
	const height = size ? size.height * view.scale : undefined;
	const pictureStyle = size
		? { width: `${width}px`, height: `${height}px`, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` }
		: { visibility: "hidden" };
	const { min, max } = scaleLimits(size ? fitOf(size) : 1);
	return html`<div class=${`lightbox-scrim ${shown ? "open" : ""}`}
		onMouseDown=${(event) => event.target === event.currentTarget && closeImageLightbox()}
		onWheel=${onWheel}>
		<div class="lightbox-dialog" ref=${dialogRef} role="dialog" aria-modal="true" aria-label=${t("Image preview")}
			onKeyDown=${(event) => {
				// Tab stays inside the viewer: its buttons in turn, never the page below.
				if (event.key !== "Tab") return;
				const stops = [...(dialogRef.current?.querySelectorAll("button:not([disabled])") ?? [])];
				if (stops.length === 0) return;
				event.preventDefault();
				const at = stops.indexOf(document.activeElement);
				stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus?.();
			}}>
			<img class=${`lightbox-img ${dragging ? "dragging" : ""}`} src=${image.src} alt=${image.alt || t("Image preview")} draggable=${false}
				style=${pictureStyle}
				onLoad=${onLoad}
				onError=${() => closeImageLightbox()}
				onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${endDrag} onPointerCancel=${endDrag}
				onDblClick=${onDoubleClick} />
			<div class="lightbox-bar" role="toolbar" aria-label=${t("Zoom")}>
				<button type="button" class="lightbox-tool" aria-label=${t("Zoom out")} title=${t("Zoom out")} disabled=${!size || view.scale <= min + 0.0005} onClick=${() => zoomTo(view.scale / ZOOM_STEP)}><${Icon} name="zoomOut" size=${16} /></button>
				<button type="button" class="lightbox-tool lightbox-percent" title=${t("Real size (100%)")} aria-label=${t("Real size (100%)")} disabled=${!size} onClick=${() => zoomTo(1)}>${percent}%</button>
				<button type="button" class="lightbox-tool" aria-label=${t("Zoom in")} title=${t("Zoom in")} disabled=${!size || view.scale >= max - 0.0005} onClick=${() => zoomTo(view.scale * ZOOM_STEP)}><${Icon} name="zoomIn" size=${16} /></button>
				<span class="lightbox-sep" />
				<button type="button" class="lightbox-tool lightbox-fit" title=${t("Show the whole picture")} aria-label=${t("Show the whole picture")} disabled=${!size} onClick=${showWhole}><${Icon} name="fitPage" size=${16} />${t("Fit")}</button>
				${size ? html`<span class="lightbox-size">${size.width} × ${size.height}</span>` : null}
			</div>
			<button ref=${closeRef} type="button" class="lightbox-close" aria-label=${t("Close preview")} onClick=${() => closeImageLightbox()}>
				<${Icon} name="x" size=${18} />
			</button>
		</div>
	</div>`;
}
