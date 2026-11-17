// Whether the conversation follows the end of the reply (follow.js). The page used to read "the end is far away" as "the
// reader scrolled up", so a block of text that landed in the same moment as the pane was moved to the end left the pane
// stuck in the middle of the conversation for the rest of the reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAY_PX, STICK_PX, createFollow, scrolled, settled, wrote } from "../web/js/follow.js";

const CLIENT = 538;
/** A scroll event at `top` in a page `height` tall. */
const at = (follow, top, height) => scrolled(follow, { top, height, client: CLIENT });

test("a chat opened at the end stays followed when its text is drawn after the pane was moved", () => {
	// The pane was moved to the end of what was on the page (1366 px tall); the Markdown blocks were drawn after that and
	// the page is 3030 px tall when the scroll event is delivered: the end is 666 px away although nobody scrolled.
	const f = createFollow();
	wrote(f, 828);
	const distance = at(f, 828, 3030);
	assert.equal(distance, 3030 - 828 - CLIENT);
	assert.equal(f.stick, true, "the page growing below is not the reader leaving");
});

test("the page growing by far more than the threshold, while the reader stays put at the end, does not end the following", () => {
	const f = createFollow();
	assert.equal(at(f, 4000, 4538), 0);
	// 600 px of text arrive; the position did not change.
	at(f, 4000, 5138);
	assert.equal(f.stick, true);
	// Moved to the end again by the page: still followed.
	wrote(f, 4600);
	at(f, 4600, 5138);
	assert.equal(f.stick, true);
});

test("the reader moving up, away from the end, stops the following; growth after that changes nothing", () => {
	const f = createFollow();
	at(f, 4000, 4538);
	at(f, 3700, 4538); // 300 px up
	assert.equal(f.stick, false);
	at(f, 3700, 5000); // the reply grows
	assert.equal(f.stick, false, "the reader is not dragged back");
	at(f, 3900, 5000); // down, but not to the end
	assert.equal(f.stick, false);
});

test("the reader coming back to the end starts the following again", () => {
	const f = createFollow();
	at(f, 4000, 4538);
	at(f, 3000, 4538);
	assert.equal(f.stick, false);
	at(f, 4000 - STICK_PX + 5, 4538);
	assert.equal(f.stick, true);
});

test("a small move up near the end is not leaving it", () => {
	const f = createFollow();
	at(f, 4000, 4538);
	at(f, 4000 - STICK_PX + 10, 4538);
	assert.equal(f.stick, true);
});

test("the page getting shorter moves the position up without the reader doing anything", () => {
	// A block of work folds away: the browser holds the position to the new end.
	const f = createFollow();
	at(f, 4000, 4538);
	at(f, 3700, 4238);
	assert.equal(f.stick, true);
});

test("rounding of a pixel is not a move", () => {
	// The page is far from its end after growing; a position that differs by a fraction of a pixel is not the reader.
	const f = createFollow();
	at(f, 1000.6, 3000);
	f.stick = true;
	at(f, 1000, 3000);
	assert.equal(f.stick, true);
	// A move of a few pixels is.
	at(f, 996, 3000);
	assert.equal(f.stick, false);
});

test("how far from the end, for the button that jumps there", () => {
	const f = createFollow();
	assert.equal(at(f, 100, 1100), 1100 - 100 - CLIENT);
	assert.ok(1100 - 100 - CLIENT > AWAY_PX);
	assert.equal(scrolled(f, { top: 5000, height: 4000, client: CLIENT }), 0, "never negative");
});

test("where the pane belongs after the page changed", () => {
	const f = createFollow();
	// Following the end: the end, also when a place was noted.
	assert.equal(settled(f, { height: 3000 }), 3000);
	assert.equal(settled(f, { place: { top: 100, height: 800 }, height: 3000 }), 3000);
	// Not following: the reader keeps their place when older messages were added above, and is left alone otherwise.
	f.stick = false;
	assert.equal(settled(f, { place: { top: 100, height: 800 }, height: 3000 }), 100 + (3000 - 800));
	assert.equal(settled(f, { height: 3000 }), null);
});

test("an older page that arrives while the reply grows does not pull a reader at the end away from it", () => {
	const f = createFollow();
	at(f, 100, 640); // a short chat: the end is at 102
	assert.equal(f.stick, true);
	// The older messages are added and the reply grew meanwhile: the end, not "the place" (which would be 300 px above it).
	assert.equal(settled(f, { place: { top: 100, height: 640 }, height: 2500 }), 2500);
});
