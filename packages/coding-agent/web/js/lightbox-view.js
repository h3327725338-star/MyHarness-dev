// The arithmetic of the image viewer (lightbox.js): how large the picture is shown and where, with no DOM in it.
// A view is `{ scale, x, y }`: the zoom, and how far the picture's center is moved from the window's center.

/** Room kept free around the picture when it is shown whole: the edges, and the bar under it. */
const MARGIN_X = 48;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 84;
/** However far it is moved, this much of the picture stays in the window. */
const KEEP_VISIBLE = 96;
const MAX_SCALE = 8;
/** One press of a zoom button or key. */
export const ZOOM_STEP = 1.25;

/**
 * The scale at which the whole picture fits the window. Never above 1: a small picture is shown at its own size,
 * sharp, instead of being stretched to fill the screen.
 */
export function fitScale(width, height, viewWidth, viewHeight) {
	const roomX = Math.max(120, viewWidth - MARGIN_X * 2);
	const roomY = Math.max(120, viewHeight - MARGIN_TOP - MARGIN_BOTTOM);
	return Math.min(1, roomX / Math.max(1, width), roomY / Math.max(1, height));
}

/** The smallest and largest scale: down to half of "whole picture", up to eight times the picture's own pixels. */
export function scaleLimits(fit) {
	return { min: Math.min(fit, 1) * 0.5, max: Math.max(MAX_SCALE, fit * 4) };
}

/**
 * Zoom to `next` so that the point under the pointer stays under it. `point` is the pointer's distance from the
 * window's center.
 */
export function zoomAt(view, next, point = { x: 0, y: 0 }) {
	const ratio = next / view.scale;
	return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Keep part of the picture in the window: it can be moved until only a strip of it shows, not out of sight. */
export function clampView(view, size, viewWidth, viewHeight) {
	const halfW = (size.width * view.scale) / 2;
	const halfH = (size.height * view.scale) / 2;
	const limitX = Math.max(0, viewWidth / 2 + halfW - KEEP_VISIBLE);
	const limitY = Math.max(0, viewHeight / 2 + halfH - KEEP_VISIBLE);
	return { scale: view.scale, x: Math.min(limitX, Math.max(-limitX, view.x)), y: Math.min(limitY, Math.max(-limitY, view.y)) };
}

/** How much one wheel event zooms: a notch (about 100) and a touchpad's many small steps give the same total. */
export function wheelFactor(deltaY, deltaMode = 0) {
	const amount = deltaMode === 1 ? deltaY * 33 : deltaY;
	return Math.exp(-amount * 0.0016);
}
