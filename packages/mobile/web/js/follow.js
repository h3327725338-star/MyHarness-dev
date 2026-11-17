// Whether the conversation follows the end of the reply, as arithmetic without a page (chat.js drives it from the scroll
// events of the pane; test/scroll-follow.test.mjs tests it).
//
// The pane follows the end while the reader is at the end. What ends the following must be the reader moving away from
// the end, not the page becoming taller below them: a scroll event is delivered after the layout of a later frame, so
// when a block of text lands in the same moment as the pane is moved to the end (a chat opened, a chat read again from
// the PC, a tool block opening), the event sees the end a few hundred pixels further down than where the pane was put,
// and "far from the end" used to be read as "the reader scrolled up": the pane stayed there for the rest of the reply.

/** Within this many pixels of the end counts as being at the end. */
export const STICK_PX = 90;
/** Further than this from the end, the button that jumps there shows. */
export const AWAY_PX = 420;
/** Smaller moves up are rounding, not a reader. */
const MOVED_PX = 1;

/** `stick`: follow the end; `top`: the scroll position last seen (to tell a move up from the page growing). */
export function createFollow() {
	return { stick: true, top: 0 };
}

/**
 * A scroll event. `top`, `height` and `client` are the pane's scrollTop, scrollHeight and clientHeight now. Returns how far
 * the pane is from the end. Being at the end starts following; moving up, away from the end, stops it; the end moving
 * further away because the page grew (the position did not change) changes nothing.
 */
export function scrolled(follow, { top, height, client }) {
	const distance = Math.max(0, height - top - client);
	const moved = top - follow.top;
	follow.top = top;
	if (distance < STICK_PX) follow.stick = true;
	else if (moved < -MOVED_PX) follow.stick = false;
	return distance;
}

/** The page set the scroll position itself (to the end, or to keep a place): that is not the reader moving. */
export function wrote(follow, top) {
	follow.top = top;
}

/**
 * Where the pane should be after the page changed, as a scrollTop (the browser holds it to the end of the page), or null
 * to leave it alone. Following the end wins; otherwise `place` ({ top, height } taken when older messages began to load)
 * keeps the reader where they were when those messages are added above.
 */
export function settled(follow, { place = null, height }) {
	if (follow.stick) return height;
	if (place) return place.top + (height - place.height);
	return null;
}
