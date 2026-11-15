// Sidebar peek: while the sidebar is hidden, resting the mouse on the "Show sidebar" button floats the sidebar over the
// conversation, and it slides away again once the mouse leaves it. A click on the button still keeps the sidebar open,
// as before; a click during a peek moves the floating sidebar into its column instead of reopening it.
//
// The peek lives on <html data-sidebar-peek> (never in the store), so showing it re-renders nothing; layout.css draws
// each phase:
//   ready - the pointer reached the button: placed off-screen at the left, all but transparent, without a transition
//           (where the slide starts; it goes again if the pointer leaves before the open delay)
//   in    - slid in over the conversation
//   out   - sliding back out; the attribute goes once it is out of sight
//   dock  - the sidebar was kept open mid-peek: it moves into its column while the conversation makes room
import { afterModeReveal, modeRevealActive } from "./mode-transition.js";
import { state, subscribe } from "./store.js";

// A pointer that only passes the button opens nothing.
const OPEN_DELAY_MS = 60;
// Crossing from the button down into the sidebar, or slipping past its edge for a moment, does not close it.
const CLOSE_DELAY_MS = 160;
// While something opened from the peek still needs it (a menu, a dialog, a rename box), the close is retried this often.
const HOLD_RETRY_MS = 150;
// The slide-out and the docking motion of layout.css (the docking one is --t-slow, the column's own motion).
const OUT_MS = 180;
const DOCK_MS = 260;
// Floating layers that keep the peek open while they are up: menus and dialogs opened from it.
const LAYERS = ".scrim, .popover:not(.closing), .local-file-menu, .personal-fullscreen-scrim";

let phase = "";
let overButton = false;
let overSidebar = false;
let pressed = false;
let openTimer = 0;
let closeTimer = 0;
let phaseTimer = 0;
// Layers already up when the peek opened belong to something else; only those that came later hold it open.
let layersBefore = new Set();
// Where the mouse was last seen while the peek is up, and the button it opened from: after a mode reveal these decide
// whether the pointer is still on the peek (pointerStillOnPeek).
let lastX = -1;
let lastY = -1;
let buttonEl = null;
let revealHeld = false;
let revealWait = null;
// The pointer was found on the peek by where it was last seen (pointerStillOnPeek), not by an enter event. The browser
// may never send the leave that belongs to it (it did not see the pointer come back), so until an enter or leave event
// arrives again the moves themselves are checked (onTrack).
let assumedOver = false;

const sidebarEl = () => document.querySelector(".app > .sidebar");
const byMouse = (event) => event.pointerType === "mouse";

function setPhase(next) {
	phase = next;
	if (next) document.documentElement.dataset.sidebarPeek = next;
	else delete document.documentElement.dataset.sidebarPeek;
}

const onMove = (event) => {
	if (event.pointerType !== "mouse") return;
	lastX = event.clientX;
	lastY = event.clientY;
};
const onDown = (event) => {
	pressed = true;
	onMove(event);
};
// Every mouse move while the peek is up.
const onTrack = (event) => {
	onMove(event);
	if (!assumedOver || event.pointerType !== "mouse" || modeRevealActive()) return;
	const target = event.target instanceof Node ? event.target : null;
	if (target && (sidebarEl()?.contains(target) || buttonEl?.contains(target))) return;
	leftUnseen();
};
// The mouse left the window: where it was last seen says nothing any more.
const onGone = (event) => {
	if (event.pointerType !== "mouse") return;
	lastX = lastY = -1;
	if (assumedOver) leftUnseen();
};
// The pointer is off the peek and no leave event said so.
function leftUnseen() {
	assumedOver = false;
	overSidebar = overButton = false;
	settle();
}
const onUp = () => {
	pressed = false;
};
function listen(on) {
	const method = on ? "addEventListener" : "removeEventListener";
	window[method]("pointerdown", onDown, true);
	window[method]("pointerup", onUp, true);
	window[method]("pointercancel", onUp, true);
	window[method]("pointermove", onTrack, true);
	document.documentElement[method]("pointerleave", onGone);
	if (!on) assumedOver = false;
	if (!on) pressed = false;
}

function clearTimers() {
	clearTimeout(openTimer);
	clearTimeout(closeTimer);
	clearTimeout(phaseTimer);
	openTimer = closeTimer = phaseTimer = 0;
	revealWait?.();
	revealWait = null;
}

function open() {
	openTimer = 0;
	if (state.view.sidebarOpen || (!overButton && !overSidebar)) return;
	const sidebar = sidebarEl();
	if (!sidebar) return;
	clearTimeout(phaseTimer);
	phaseTimer = 0;
	if (phase === "") prepare();
	// The start position must be laid out before the slide, or the sidebar would appear without moving.
	if (phase === "ready") void sidebar.offsetWidth;
	listen(true);
	setPhase("in");
}

// The sidebar takes its start position (off-screen at the left) as soon as the pointer reaches the button, so the work
// of drawing it the first time happens during the open delay instead of in the first frames of the slide.
function prepare() {
	layersBefore = new Set(document.querySelectorAll(LAYERS));
	setPhase("ready");
}

/** A menu, dialog or text field opened from the peek, or a held mouse button, keeps it open. */
function holding() {
	if (pressed) return true;
	const active = document.activeElement;
	if (active && sidebarEl()?.contains(active) && active.matches("input, textarea, [contenteditable]")) return true;
	for (const layer of document.querySelectorAll(LAYERS)) if (!layersBefore.has(layer)) return true;
	return false;
}

/**
 * A mode reveal (the Coding / General switch) draws the page through snapshot layers that take it out of hit testing:
 * the pointer "leaves" a sidebar it still rests on, and the switch itself sits in that sidebar. Sliding the peek away
 * under the growing circle and back in afterwards is not what the user did, so the close waits for the reveal to end
 * and is asked again in the same frame (the retry timer is only the fallback).
 */
function waitForReveal() {
	if (!modeRevealActive()) return false;
	revealHeld = true;
	revealWait ??= afterModeReveal(() => {
		revealWait = null;
		if (!closeTimer) return;
		clearTimeout(closeTimer);
		tryClose();
	});
	return true;
}

/**
 * After a mode reveal the enter and leave events are not to be trusted (see waitForReveal): the pointer may never have
 * left. Where it was last seen decides, once; a pointer found on the sidebar or its button counts as over it again.
 */
function pointerStillOnPeek() {
	if (!revealHeld) return false;
	revealHeld = false;
	if (lastX < 0) return false;
	const hit = document.elementFromPoint(lastX, lastY);
	if (!hit) return false;
	if (sidebarEl()?.contains(hit)) overSidebar = true;
	else if (buttonEl?.isConnected && buttonEl.contains(hit)) overButton = true;
	assumedOver = overSidebar || overButton;
	return assumedOver;
}

function tryClose() {
	closeTimer = 0;
	if (phase !== "in" || overButton || overSidebar) return;
	if (waitForReveal() || holding()) {
		closeTimer = setTimeout(tryClose, HOLD_RETRY_MS);
		return;
	}
	if (pointerStillOnPeek()) return;
	setPhase("out");
	phaseTimer = setTimeout(() => {
		phaseTimer = 0;
		if (phase !== "out") return;
		// The keyboard does not stay on a control that is no longer shown.
		const active = document.activeElement;
		if (active && sidebarEl()?.contains(active)) active.blur();
		overSidebar = false;
		setPhase("");
		listen(false);
	}, OUT_MS);
}

function arm() {
	clearTimeout(closeTimer);
	closeTimer = 0;
	if (state.view.sidebarOpen || phase === "in" || phase === "dock") return;
	// Back on it while it slides out: it slides back in from where it is.
	if (phase === "out") return open();
	if (phase === "") prepare();
	if (!openTimer) openTimer = setTimeout(open, OPEN_DELAY_MS);
}

function settle() {
	if (overButton || overSidebar) return;
	clearTimeout(openTimer);
	openTimer = 0;
	if (phase === "ready") setPhase("");
	if (phase === "in" && !closeTimer) closeTimer = setTimeout(tryClose, CLOSE_DELAY_MS);
}

// Hiding the sidebar can put the show button right under a pointer that rests there (after a click that kept the
// sidebar open, then its shortcut): that is not a hover, so such a button peeks only once the pointer left and came back.
const HIDE_QUIET_MS = 500;
let hiddenAt = -Infinity;
let waitForLeave = false;

export function peekButtonEnter(event) {
	if (!byMouse(event) || (event.buttons && phase === "")) return;
	overButton = true;
	revealHeld = assumedOver = false;
	if (event.currentTarget instanceof Element) buttonEl = event.currentTarget;
	onMove(event);
	if (performance.now() - hiddenAt < HIDE_QUIET_MS) waitForLeave = true;
	if (!waitForLeave) arm();
}

export function peekButtonLeave(event) {
	if (!byMouse(event)) return;
	overButton = false;
	waitForLeave = false;
	assumedOver = false;
	onMove(event);
	settle();
}

export function peekSidebarEnter(event) {
	if (!byMouse(event) || (phase !== "in" && phase !== "out")) return;
	overSidebar = true;
	revealHeld = assumedOver = false;
	onMove(event);
	arm();
}

export function peekSidebarLeave(event) {
	if (!byMouse(event) || (phase !== "in" && phase !== "out")) return;
	overSidebar = false;
	assumedOver = false;
	onMove(event);
	settle();
}

// The sidebar is kept open (the button, its shortcut or the command palette): a visible peek moves into the column.
// This runs when the store changes, before the sidebar re-renders without its hidden state, so the move starts from
// where the peek is on screen.
let wasOpen = state.view.sidebarOpen;
subscribe(() => {
	const open = state.view.sidebarOpen;
	if (open === wasOpen) return;
	wasOpen = open;
	const shown = phase === "in" || phase === "out";
	clearTimers();
	overButton = overSidebar = waitForLeave = revealHeld = false;
	if (!open) hiddenAt = performance.now();
	listen(false);
	if (open && shown) {
		setPhase("dock");
		phaseTimer = setTimeout(() => {
			phaseTimer = 0;
			if (phase === "dock") setPhase("");
		}, DOCK_MS + 40);
	} else setPhase("");
});
