// How fast a reply's text is shown while it arrives. Over a direct connection the text comes a few characters at a
// time and is shown as it comes. Through Google Drive it comes as a paragraph every second or two (and a short reply
// as one piece): shown at once it bursts onto the page. So what has arrived is written out at a steady speed that is
// chosen to finish about when the next piece is due, which reads as one continuous flow.
// Pure arithmetic, no page: the transcript drives it from its frames (transcript.js: StreamText).

const BASE_RATE = 0.06; // characters per ms: never slower than this, so a slow trickle is shown as it arrives
const FIRST_MS = [250, 1300]; // the first piece (no rhythm known yet): 10 ms a character within these limits
const PIECE_MS = [180, 2500]; // a later piece: the time the pieces lie apart, within these limits
const LAST_MS = [400, 1200]; // what is left when the reply has ended: 1.2 ms a character within these limits

const clamp = (value, [low, high]) => Math.max(low, Math.min(high, value));

/**
 * The state of one text being written out: `length` is what has arrived, `shown` what is on the page (a fraction
 * while it moves), `rate` the speed in characters per ms.
 */
export function createReveal(shown = 0) {
	return { length: shown, shown, rate: BASE_RATE, arrivedAt: 0, gap: 0 };
}

/** More text arrived (`length` characters in all) at time `now` (ms). `ended`: nothing more will come. */
export function arrive(reveal, length, now, ended = false) {
	if (length < reveal.shown) reveal.shown = length;
	const grew = length > reveal.length;
	if (grew && reveal.arrivedAt) {
		const gap = now - reveal.arrivedAt;
		// The rhythm of the pieces, remembered loosely: one late piece does not slow everything after it.
		reveal.gap = reveal.gap ? reveal.gap + (gap - reveal.gap) * 0.5 : gap;
	}
	if (grew) reveal.arrivedAt = now;
	reveal.length = length;
	const backlog = length - reveal.shown;
	if (backlog <= 0) return;
	const span = ended ? clamp(backlog * 1.2, LAST_MS) : reveal.gap ? clamp(reveal.gap, PIECE_MS) : clamp(backlog * 10, FIRST_MS);
	const rate = Math.max(BASE_RATE, backlog / span);
	if (grew) reveal.rate = rate;
	// The end only ever speeds up what is still being written.
	else if (ended) reveal.rate = Math.max(reveal.rate, rate);
}

/** `elapsed` ms went by: how many characters are shown now (a whole number, never more than arrived). */
export function advance(reveal, elapsed) {
	if (reveal.shown < reveal.length) reveal.shown = Math.min(reveal.length, reveal.shown + reveal.rate * Math.max(0, elapsed));
	return Math.floor(reveal.shown);
}

export const revealing = (reveal) => reveal.shown < reveal.length;

/** The first `count` characters of `text`, never ending between the two halves of one character (an emoji). */
export function prefix(text, count) {
	if (count >= text.length) return text;
	const code = text.charCodeAt(count - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? count + 1 : count);
}

// A line that so far is only the sign of what it will become: a list item's dash or number, a heading's hashes, a
// quote's ">", the line under a heading, the fence of a code block with (part of) its language.
const SIGN_ONLY = /^\s{0,3}(?:[-=]+|[-*+]|\d{1,9}[.)]?|#{1,6}|>+|`{1,2}|`{3,}[\w+#.-]*|~{3,}[\w+#.-]*)\s*$/;

/**
 * The first `count` characters of `text` as they are drawn while the text is written out. Markdown reads a line's
 * first characters differently once the rest is there: "Files:" followed by the "-" of a list is a heading for a
 * moment, a code block opens under the wrong language while its name is half written, and a table is rows of bars
 * until its second line is complete. So a last line that is only such a sign, and a table without its first two lines,
 * are left out until more is written; the count itself is not changed.
 */
export function drawnPrefix(text, count) {
	if (count >= text.length) return text;
	const cut = prefix(text, count);
	const lineStart = cut.lastIndexOf("\n") + 1;
	const last = cut.slice(lineStart);
	if (SIGN_ONLY.test(last) && last.trim()) return cut.slice(0, lineStart);
	if (!last.trimStart().startsWith("|")) return cut;
	// The lines of bars this one belongs to: a table once the head and the line under it are whole.
	let start = lineStart;
	let whole = 0;
	while (start > 0) {
		const before = cut.lastIndexOf("\n", start - 2) + 1;
		if (!cut.slice(before, start - 1).trimStart().startsWith("|")) break;
		start = before;
		whole += 1;
	}
	return whole >= 2 ? cut : cut.slice(0, start);
}
