// Loads and draws the pictures, video and sound a reply shows inside its text. markdown.js writes one `.md-fig` per
// `![caption](path "layout")` (reply-media-model.js reads the syntax); this fills it once the Markdown is on the page.
import { t } from "./i18n.js";
import { openImageLightbox } from "./lightbox.js";

/**
 * Pictures already loaded, by chat and path as written: the bytes behind an object URL plus their size in pixels. A
 * reply's HTML is set again every time its text grows, which makes new elements; drawn from here they show at once, at
 * their final size, with no request and no jump. Least recently used goes first.
 */
const pictures = new Map();
const MAX_PICTURES = 80;
/** A picture is asked for again (the server answers 304 while the file is the same) once it was last checked this long ago. */
const FRESH_MS = 5000;
/** A file that could not be shown is tried again after this long: it may only just be written. */
const RETRY_MS = 3000;
const loading = new Map();

const pictureKey = (slot, target) => `${slot ?? ""}\0${target}`;

/** The address the server answers a reply's media under; a relative path resolves in that chat's folder. */
export function mediaUrl(target, slot) {
	const url = `/api/files/media?path=${encodeURIComponent(target)}`;
	return slot && !String(slot).startsWith("pending:") ? `${url}&slot=${encodeURIComponent(slot)}` : url;
}

function keep(key, entry) {
	pictures.delete(key);
	pictures.set(key, entry);
	while (pictures.size > MAX_PICTURES) {
		const [oldest, old] = pictures.entries().next().value;
		pictures.delete(oldest);
		// A picture still on the page keeps its bytes (its large preview reads them again); they go with the page.
		if (old.url && ![...document.querySelectorAll(".md-fig-frame > img")].some((image) => image.src === old.url)) URL.revokeObjectURL(old.url);
	}
}

/** Pixel size of an image behind `url`, or null when the browser cannot show it. */
function measure(url) {
	return new Promise((resolve) => {
		const probe = new Image();
		probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
		probe.onerror = () => resolve(null);
		probe.src = url;
	});
}

async function fetchPicture(key, target, slot) {
	const held = pictures.get(key);
	let entry;
	try {
		const response = await fetch(mediaUrl(target, slot), { cache: "no-cache" });
		const etag = response.headers.get("etag") || "";
		if (response.ok && held?.url && etag && held.etag === etag) {
			void response.body?.cancel();
			entry = { ...held, checkedAt: Date.now() };
		} else if (response.ok) {
			const url = URL.createObjectURL(await response.blob());
			const size = await measure(url);
			if (size) entry = { url, ...size, etag, checkedAt: Date.now() };
			else URL.revokeObjectURL(url);
		}
	} catch {
		// The server is away or the request was cut: shown as not found, and tried again later.
	}
	entry ??= { missing: true, checkedAt: Date.now() };
	keep(key, entry);
	// Every figure of this file on the page that shows something else moves on: the ones still waiting, the ones drawn
	// from bytes the file no longer has, and a "cannot show" note whose file has arrived. Then the old bytes are let go.
	for (const figure of document.querySelectorAll(".md-fig[data-media-state]")) {
		if (figureKeys.get(figure) === key && !sameContent(shown.get(figure), entry)) draw(figure, entry);
	}
	if (held?.url && held.url !== entry.url) URL.revokeObjectURL(held.url);
}

/** Which file a figure on the page belongs to, and what it shows now. */
const figureKeys = new WeakMap();
const shown = new WeakMap();
const sameContent = (a, b) => !!a && a.url === b.url && !!a.missing === !!b.missing;

function load(key, target, slot) {
	let pending = loading.get(key);
	if (!pending) {
		pending = fetchPicture(key, target, slot).finally(() => loading.delete(key));
		loading.set(key, pending);
	}
	return pending;
}

function missing(figure) {
	const frame = figure.querySelector(".md-fig-frame");
	figure.dataset.mediaState = "missing";
	const note = document.createElement("span");
	note.className = "md-fig-missing";
	note.textContent = t("Cannot show {name}", { name: figure.dataset.mediaName || "" });
	note.title = figure.dataset.mediaSrc || "";
	frame.replaceChildren(note);
}

/** Puts a loaded picture (or the note that there is none) into its figure. */
function draw(figure, entry) {
	shown.set(figure, entry);
	if (entry.missing) {
		missing(figure);
		return;
	}
	const frame = figure.querySelector(".md-fig-frame");
	const image = document.createElement("img");
	image.src = entry.url;
	image.width = entry.width;
	image.height = entry.height;
	image.alt = figure.dataset.mediaAlt || figure.dataset.mediaName || "";
	image.draggable = false;
	if (figure.dataset.layout !== "inline") {
		image.tabIndex = 0;
		image.setAttribute("role", "button");
		image.setAttribute("aria-label", t("Preview image {name}", { name: image.alt }));
	}
	figure.dataset.mediaState = "ready";
	// Side by side, pictures share the row's width by their shapes, so they come out at one height.
	figure.style.setProperty("--fig-ratio", String(entry.width / Math.max(1, entry.height)));
	frame.replaceChildren(image);
}

function player(figure, slot) {
	const frame = figure.querySelector(".md-fig-frame");
	const element = document.createElement(figure.dataset.mediaKind === "audio" ? "audio" : "video");
	element.controls = true;
	element.preload = "metadata";
	element.addEventListener("error", () => missing(figure), { once: true });
	element.src = mediaUrl(figure.dataset.mediaSrc, slot);
	figure.dataset.mediaState = "ready";
	frame.replaceChildren(element);
}

/** Text flowing around a picture needs room: in a column narrower than this the picture takes a line of its own. */
const WRAP_MIN_WIDTH = 440;
const narrowWatch = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => entries.forEach((entry) => fitWrap(entry.target))) : null;
function fitWrap(root) {
	const narrow = root.clientWidth > 0 && root.clientWidth < WRAP_MIN_WIDTH;
	for (const figure of root.querySelectorAll('.md-fig[data-layout="left"], .md-fig[data-layout="right"]')) figure.toggleAttribute("data-unwrapped", narrow);
}

/**
 * Fills every figure under `root` that is still empty. Called after each render of a Markdown block, before the
 * browser paints: a picture loaded before is in place in the same frame its element appears.
 */
export function showReplyMedia(root, slot) {
	const figures = root.querySelectorAll(".md-fig[data-media-src]:not([data-media-state])");
	const wraps = root.querySelector('.md-fig[data-layout="left"], .md-fig[data-layout="right"]');
	if (wraps) {
		narrowWatch?.observe(root);
		fitWrap(root);
	} else narrowWatch?.unobserve(root);
	for (const figure of figures) {
		const target = figure.dataset.mediaSrc;
		if (figure.dataset.mediaKind !== "image") {
			player(figure, slot);
			continue;
		}
		const key = pictureKey(slot, target);
		const held = pictures.get(key);
		figureKeys.set(figure, key);
		// What is known shows at once, also while it is checked again: a picture never goes back to "loading", and a
		// file that could not be shown keeps its note until it can.
		if (held) draw(figure, held);
		else figure.dataset.mediaState = "loading";
		if (held && Date.now() - held.checkedAt < (held.missing ? RETRY_MS : FRESH_MS)) continue;
		// fetchPicture fills every figure of this file that is on the page when the answer arrives.
		void load(key, target, slot);
	}
}

/** The Markdown block is going away. */
export function forgetReplyMedia(root) {
	narrowWatch?.unobserve(root);
}

/** A click or Enter/Space on a picture in a reply opens it large. True when the event was one. */
export function openReplyPicture(event) {
	const image = event.target.closest?.(".md-fig-frame > img");
	if (!image || image.closest(".md-fig")?.dataset.layout === "inline") return false;
	if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return false;
	event.preventDefault();
	openImageLightbox(image.src, image.alt);
	return true;
}
