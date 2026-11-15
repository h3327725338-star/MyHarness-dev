// The speed at which a reply's text is written out while it arrives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, arrive, createReveal, prefix, revealing } from "../web/js/reveal.js";

/** Run the frames of `ms` milliseconds (120 a second) and return what is shown at the end. */
function play(reveal, ms) {
	let shown = Math.floor(reveal.shown);
	for (let t = 0; t < ms; t += 1000 / 120) shown = advance(reveal, 1000 / 120);
	return shown;
}

test("text that was there when the chat was opened is shown whole", () => {
	const reveal = createReveal(500);
	arrive(reveal, 500, 0, true);
	assert.equal(revealing(reveal), false);
	assert.equal(advance(reveal, 8), 500);
});

test("a piece that comes through Drive is written out, not shown at once", () => {
	const reveal = createReveal(0);
	arrive(reveal, 240, 0);
	assert.equal(advance(reveal, 8) < 20, true, "the first frame shows a few characters");
	const half = play(reveal, 450);
	assert.equal(half > 60 && half < 200, true, `about half way after half the time (${half})`);
	assert.equal(play(reveal, 900), 240, "all of it within a second and a half");
});

test("pieces that come every second and a half flow into each other", () => {
	const reveal = createReveal(0);
	let now = 0;
	arrive(reveal, 200, now);
	play(reveal, 1500);
	for (let piece = 2; piece <= 4; piece++) {
		now += 1500;
		arrive(reveal, piece * 200, now);
		const early = play(reveal, 300);
		assert.equal(early < piece * 200, true, "still writing 0.3 s after the piece came");
		const late = play(reveal, 1000);
		assert.equal(late > piece * 200 - 60 && late < piece * 200, true, `nearly done 0.2 s before the next piece is due (${late})`);
		// Done when the next piece is due, so the writing does not pause between pieces.
		assert.equal(play(reveal, 210), piece * 200);
	}
});

test("a direct connection's trickle is shown as it comes", () => {
	const reveal = createReveal(0);
	let length = 0;
	let behind = 0;
	for (let now = 0; now < 3000; now += 50) {
		length += 3;
		arrive(reveal, length, now);
		play(reveal, 50);
		behind = Math.max(behind, length - Math.floor(reveal.shown));
	}
	assert.equal(behind <= 3, true, `never more than one piece behind (${behind})`);
});

test("when the reply has ended, what is left is written quickly", () => {
	const reveal = createReveal(0);
	arrive(reveal, 3000, 0);
	play(reveal, 100);
	arrive(reveal, 3000, 100, true);
	assert.equal(play(reveal, 1250), 3000, "a long rest takes little more than a second");
	const short = createReveal(0);
	arrive(short, 2, 0, true);
	assert.equal(play(short, 60), 2);
});

test("text that became shorter is never shown past its end", () => {
	const reveal = createReveal(100);
	arrive(reveal, 40, 0);
	assert.equal(advance(reveal, 8), 40);
});

test("a cut never falls inside one character", () => {
	assert.equal(prefix("ab😀cd", 2), "ab");
	assert.equal(prefix("ab😀cd", 3), "ab😀");
	assert.equal(prefix("ab😀cd", 4), "ab😀");
	assert.equal(prefix("abc", 9), "abc");
	assert.equal(prefix("abc", 0), "");
});
