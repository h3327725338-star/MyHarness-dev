// A single reversible, sharp circular reveal. Reversal changes playback direction, not the captured pages.
//
// The circle is drawn by the page itself, frame by frame. The animation runs three registered lengths on the new page's
// layer (--mode-reveal-r, -x, -y; layout.css) and the layer's clip-path reads them; the clip-path itself is not animated.
// It must stay that way. Chromium hands an animated clip-path to the compositor, which then draws every frame from its
// own copy of the animation's current value. A frame that finds no value there (now and then at the end of the reveal,
// more often while the page is busy) draws the layer as the page first painted it: a circle of zero size. The whole old
// page then covers the new one for one frame, and the reveal goes on. A length the page animates has no second copy:
// every frame on screen is one the page produced, and the circle can only grow (or only shrink, played back).
//
// A reversal starts a fresh animation from the current point instead of changing the running one's playbackRate, so the
// two directions never share an animation whose end has already been handled.
import { motionEnabled } from "./ui.js";

let active = null;
const REVEAL_MS = 600;
// Work that can wait until the reveal is over (older turns mounting out of view): run during it, it competes with the
// reveal's frames for the main thread and keeps the live new picture re-rendering.
const waiting = new Set();
/**
 * Run `callback` once the mode reveal on screen is over. Returns null when none is running (the caller goes on at
 * once), otherwise a function that withdraws the wait.
 */
export function afterModeReveal(callback) {
	if (!active) return null;
	waiting.add(callback);
	return () => waiting.delete(callback);
}
/** Whether a mode reveal is on screen: what it draws is the new mode as it stays, with no layout motion of its own. */
export function modeRevealActive() {
	return !!active;
}
// html.mode-revealing turns off the layout's own transitions (panel column, panel fade) while a reveal is on screen.
function release() {
	if (active) return;
	document.documentElement.classList.remove("mode-revealing");
	if (!waiting.size) return;
	const callbacks = [...waiting];
	waiting.clear();
	for (const callback of callbacks) callback();
}
// Capturing the old page restyles the whole document, and so does the end of the transition. Parts of the page that can
// make that cheaper without changing what is on screen (the transcript: turns out of view skip their contents) are asked
// right before the capture, and each returns how to put things back once the new page is in. The collaboration-mode
// morph (layout-morph.js) asks them too.
const captureHooks = new Set();
/** Register `hook` for the next captures (mode reveals and layout morphs); returns the unregister function. */
export function beforePageCapture(hook) {
	captureHooks.add(hook);
	return () => captureHooks.delete(hook);
}
/**
 * Get the page ready for a capture; returns how to put it back. `reach` (in heights of the view) is how much around
 * what is on screen must stay drawn: a morph that widens the conversation brings more of it into view.
 */
export function preparePageCapture({ reach = 0 } = {}) {
	const undo = [];
	for (const hook of captureHooks) {
		try {
			const back = hook({ reach });
			if (typeof back === "function") undo.push(back);
		} catch {}
	}
	return () => {
		for (const back of undo) {
			try { back(); } catch {}
		}
	};
}
// Flipping the colour theme (store.js: data-color-theme / data-chat-mode follow the mode on screen) makes every button, chip
// and border that has a colour transition fade from the other mode's colours to its own over 90-160 ms. Inside the reveal
// that is a visible shimmer: in the first moments of the circle, and again on the restored page the instant a reversed reveal
// ends. `colourFadeGuard()` is taken before the flip and the returned function after it: it finishes the colour transitions
// the flip started, so the new picture is drawn in its own colours at once. Only transitions this flip started, and only
// colours: a list fading in or a panel sliding keeps its motion, and the switch's own colour motion is left alone.
const COLOUR_PROPERTY = /(^|-)color$|^(fill|stroke|box-shadow)$/;
function colourFadeGuard() {
	if (typeof CSSTransition !== "function") return () => {};
	const before = new Set(document.getAnimations());
	return () => {
		for (const animation of document.getAnimations()) {
			if (before.has(animation) || !(animation instanceof CSSTransition) || !COLOUR_PROPERTY.test(animation.transitionProperty)) continue;
			if (animation.effect?.target?.closest?.(".mode-switch")) continue;
			try { animation.finish(); } catch {}
		}
	};
}
// Captured elements can be excluded from hit testing during a View Transition, even with pointer-events:none.
// Forward a physical press inside the live switch's bounds only when the snapshot prevented it reaching the button.
function pressSwitch(event) {
	if (!active || event.button !== 0) return;
	const button = document.querySelector(".mode-switch");
	if (!button || button.contains(event.target)) return;
	const r = button.getBoundingClientRect();
	if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
	event.preventDefault();
	event.stopPropagation();
	button.click();
}
if (typeof document !== "undefined") document.addEventListener("pointerdown", pressSwitch, true);
export function reverseModeReveal(mode) {
	if (!active || (mode !== active.from && mode !== active.to)) return false;
	active.target = mode;
	const rate = mode === active.to ? 1 : -1;
	if (active.animation && active.animation.playbackRate !== rate) playReveal(active, active.animation.currentTime ?? 0, rate);
	return true;
}

// Start (or restart) the run's reveal at `time` playing in direction `rate`; the previous animation, if any, goes.
function playReveal(run, time, rate) {
	const previous = run.animation;
	const animation = document.documentElement.animate(run.keyframes, { duration: REVEAL_MS, easing: "linear", fill: "both", pseudoElement: "::view-transition-new(root)" });
	animation.currentTime = time;
	animation.playbackRate = rate;
	run.animation = animation;
	animation.onfinish = () => {
		if (active !== run || run.animation !== animation) return;
		if (run.target === run.from) {
			const settleColours = colourFadeGuard();
			run.restore?.();
			settleColours();
		}
		active = null;
		run.transition.skipTransition();
		// The animation holds its last frame until the transition's own layers are gone: cancelled at once, the new
		// page's layer would fall back to its hidden start (the radius' initial 0px) for as long as it is still drawn.
		run.transition.finished.catch(() => {}).finally(() => animation.cancel());
		release();
	};
	if (previous) { previous.onfinish = null; previous.cancel(); }
}

export async function revealMode(update, { from, to, restore } = {}) {
	if (active) {
		active.transition.skipTransition();
		active = null;
	}
	const settled = async (guard = false) => {
		const settleColours = guard ? colourFadeGuard() : null;
		update();
		await new Promise((done) => setTimeout(done, 0));
		settleColours?.();
	};
	if (typeof document.startViewTransition !== "function" || !motionEnabled() || document.visibilityState !== "visible") {
		release();
		await settled();
		return;
	}
	const rect = document.querySelector(".mode-switch")?.getBoundingClientRect();
	const x = rect ? rect.left + rect.width / 2 : 0;
	const y = rect ? rect.top + rect.height / 2 : 0;
	const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
	let transition;
	const putBack = preparePageCapture();
	document.documentElement.classList.add("mode-revealing");
	try { transition = document.startViewTransition(() => settled(true)); }
	catch { putBack(); release(); await settled(); return; }
	// After the update the old page is mostly gone; what is left of it (a switch that was superseded) is put back.
	transition.updateCallbackDone.catch(() => {}).finally(putBack);
	// The centre is part of the animation (constant), so nothing is set on <html>, which would restyle the whole page.
	const keyframes = { "--mode-reveal-r": ["0px", `${radius}px`], "--mode-reveal-x": [`${x}px`, `${x}px`], "--mode-reveal-y": [`${y}px`, `${y}px`] };
	const run = { transition, from, to, restore, keyframes, target: to, animation: null };
	active = run;
	// Whatever ends the transition (the reveal finishing, another View Transition taking over), the waiting work goes on.
	// The reveal's animation goes with the transition's layers, also when it was taken over before its end: left behind,
	// it would hold its last radius and draw the next reveal's new page through it until that reveal's own animation starts.
	transition.finished.catch(() => {}).finally(() => {
		if (active === run) active = null;
		run.animation?.cancel();
		release();
	});
	try {
		await transition.ready;
		if (active !== run) return;
		playReveal(run, 0, run.target === from ? -1 : 1);
	} catch {
		if (active === run) { active = null; if (run.target === from) restore?.(); }
		release();
	}
	await transition.updateCallbackDone.catch(() => {});
}
