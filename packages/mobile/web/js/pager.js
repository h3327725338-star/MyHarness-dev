// The three panes and the finger that moves between them. One number describes where the screen is:
//   -1  the drawer (chat list) is open     0  the chat     1  the browser covers the chat
// A drag changes it directly, frame by frame; letting go starts a spring from the finger's speed, so a flick and a
// slow drag both land naturally. The panes are moved with transforms only (no layout), and Preact never re-renders
// for a frame of this animation.
import { haptic, setBrowserOffset } from "./native.js";

const PANES = { drawer: -1, chat: 0, browser: 1 };
const NAMES = { "-1": "drawer", 0: "chat", 1: "browser" };
const LOCK_PX = 9; // movement before a drag is taken as horizontal or left to scrolling
const FLICK = 0.45; // px/ms: faster than this, the direction of the flick decides
const STIFFNESS = 420;
const DAMPING = 2 * Math.sqrt(STIFFNESS); // critically damped: fast, no bounce past the edge

/** Whether the touch started in something that scrolls sideways on its own and can still move that way. */
function ownsHorizontal(target, root, dx) {
	for (let node = target; node && node !== root; node = node.parentElement) {
		if (node.dataset?.noSwipe !== undefined) return true;
		const tag = node.tagName;
		if (tag === "INPUT" && node.type === "range") return true;
		if (node.scrollWidth > node.clientWidth + 1) {
			const style = getComputedStyle(node);
			if (style.overflowX === "auto" || style.overflowX === "scroll") {
				if (dx > 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
			}
		}
	}
	return false;
}

export function createPager(root, { onPane, allowBrowser = () => true } = {}) {
	const drawer = root.querySelector(".pane-drawer");
	const chat = root.querySelector(".pane-chat");
	const browser = root.querySelector(".pane-browser");
	const scrim = root.querySelector(".pane-scrim");

	let position = 0; // where the panes are drawn now
	let target = 0; // where they are going
	let velocity = 0; // position units per second
	let frame = 0;
	let lastTime = 0;
	let pane = "chat";
	let width = root.clientWidth || innerWidth;
	let drawerWidth = drawer.offsetWidth || Math.min(width * 0.86, 360);
	let drag = null;

	function draw() {
		const p = position;
		const open = Math.max(0, -p); // 0..1 drawer
		const over = Math.max(0, p); // 0..1 browser
		drawer.style.transform = `translate3d(${-(1 - open) * drawerWidth * 0.28}px,0,0)`;
		drawer.style.opacity = String(0.55 + 0.45 * open);
		chat.style.transform = `translate3d(${open * drawerWidth - over * width * 0.22}px,0,0)`;
		chat.style.borderRadius = open > 0.001 ? `${Math.min(22, open * 40)}px 0 0 ${Math.min(22, open * 40)}px` : "";
		const offset = (1 - over) * width;
		browser.style.transform = `translate3d(${offset}px,0,0)`;
		browser.style.visibility = over > 0.001 ? "visible" : "hidden";
		drawer.style.visibility = open > 0.001 ? "visible" : "hidden";
		scrim.style.opacity = String(Math.max(open * 0.42, over * 0.5));
		scrim.classList.toggle("on", open > 0.5);
		setBrowserOffset(offset);
	}

	function settle(next) {
		const name = NAMES[next];
		if (name === pane) return;
		pane = name;
		onPane?.(name);
	}

	function step(now) {
		frame = 0;
		const dt = Math.min(0.032, (now - lastTime) / 1000 || 0.016);
		lastTime = now;
		const force = -STIFFNESS * (position - target) - DAMPING * velocity;
		velocity += force * dt;
		position += velocity * dt;
		if (Math.abs(position - target) < 0.0015 && Math.abs(velocity) < 0.02) {
			position = target;
			velocity = 0;
			draw();
			return;
		}
		// A spring never leaves the range of the panes: past the edge there is nothing to show.
		if (position < -1) (position = -1), (velocity = 0);
		if (position > 1) (position = 1), (velocity = 0);
		draw();
		frame = requestAnimationFrame(step);
	}

	function animateTo(next, initialVelocity = 0, instant = false) {
		target = next;
		settle(next);
		if (instant || document.documentElement.dataset.motion === "off") {
			cancelAnimationFrame(frame);
			frame = 0;
			position = next;
			velocity = 0;
			draw();
			return;
		}
		velocity = initialVelocity;
		if (!frame) {
			lastTime = performance.now();
			frame = requestAnimationFrame(step);
		}
	}

	function measure() {
		width = root.clientWidth || innerWidth;
		drawerWidth = drawer.offsetWidth || Math.min(width * 0.86, 360);
		draw();
	}

	// ---- Dragging ---------------------------------------------------------------------------------
	function limits() {
		// From the chat both sides are reachable; from a side pane the finger only returns to the chat.
		return { min: -1, max: allowBrowser() ? 1 : 0 };
	}

	function onDown(event) {
		if (drag || (event.pointerType === "mouse" && event.button !== 0)) return;
		if (event.target.closest?.("input, textarea, [contenteditable]") && document.activeElement === event.target) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: position, locked: false, samples: [{ x: event.clientX, t: event.timeStamp }], target: event.target };
	}

	/** Put the panes where the finger is and remember the point for the speed at release. */
	function follow(event) {
		// The panes follow the finger pixel for pixel: the drawer side is as wide as the drawer, the browser side as the screen.
		const toPx = (p) => (p < 0 ? p * drawerWidth : p * width);
		const { min, max } = limits();
		// A drag that began on a side pane ends at the chat at most; it does not carry on into the pane beyond it.
		const low = drag.origin > 0 ? 0 : toPx(min);
		const high = drag.origin < 0 ? 0 : toPx(max);
		const px = Math.max(low, Math.min(high, toPx(drag.start) - (event.clientX - drag.x)));
		position = px < 0 ? px / drawerWidth : px / width;
		const last = drag.samples[drag.samples.length - 1];
		if (!last || last.t !== event.timeStamp) drag.samples.push({ x: event.clientX, t: event.timeStamp });
		if (drag.samples.length > 6) drag.samples.shift();
		draw();
	}

	function onMove(event) {
		if (!drag || event.pointerId !== drag.id) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!drag.locked) {
			if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
			if (Math.abs(dx) < Math.abs(dy) * 1.25 || ownsHorizontal(drag.target, root, dx)) {
				drag = null;
				return;
			}
			drag.locked = true;
			// The pane starts under the finger without a jump: only the lock distance is given away. A busy page
			// delivers a quick swipe as two or three far-apart points, and the rest of such a step must still count.
			drag.x += Math.sign(dx) * LOCK_PX;
			drag.start = position;
			// The pane the finger sets out from is the one the panes were heading to: a drawer still gliding shut
			// already counts as the chat, so the same swipe may go on to the browser.
			drag.origin = target;
			cancelAnimationFrame(frame);
			frame = 0;
			velocity = 0;
			try {
				root.setPointerCapture(event.pointerId);
			} catch {
				// The pointer is gone already.
			}
			if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
			root.classList.add("dragging");
		}
		follow(event);
		event.preventDefault();
	}

	function onUp(event) {
		if (!drag || event.pointerId !== drag.id) return;
		// The finger may have moved since the last point the page was told about.
		if (drag.locked && event.type === "pointerup") follow(event);
		const current = drag;
		drag = null;
		root.classList.remove("dragging");
		if (!current.locked) return;
		const first = current.samples.find((sample) => event.timeStamp - sample.t < 120) || current.samples[Math.max(0, current.samples.length - 2)];
		const last = current.samples[current.samples.length - 1];
		const speed = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px/ms, right is positive
		const { max } = limits();
		let next;
		// A flick goes on to the pane in its direction; a slow release goes to whichever pane is nearer.
		if (Math.abs(speed) > FLICK) next = speed > 0 ? Math.floor(position) : Math.ceil(position);
		else next = Math.round(position);
		next = Math.max(-1, Math.min(max, next)) + 0;
		const span = position < 0 || next < 0 ? drawerWidth : width;
		if (next !== current.origin) haptic("tick");
		animateTo(next, (-speed * 1000) / span);
	}

	root.addEventListener("pointerdown", onDown, { passive: true });
	root.addEventListener("pointermove", onMove, { passive: false });
	root.addEventListener("pointerup", onUp);
	root.addEventListener("pointercancel", onUp);
	scrim.addEventListener("click", () => animateTo(0));
	addEventListener("resize", measure);
	measure();

	return {
		get pane() {
			return pane;
		},
		/** Show a pane ("drawer", "chat" or "browser"). */
		go(name, { instant = false } = {}) {
			const next = PANES[name] ?? 0;
			if (next === 1 && !allowBrowser()) return;
			animateTo(next, 0, instant);
		},
		toggleDrawer() {
			animateTo(pane === "drawer" ? 0 : -1);
		},
		measure,
		destroy() {
			cancelAnimationFrame(frame);
			removeEventListener("resize", measure);
			root.removeEventListener("pointerdown", onDown);
			root.removeEventListener("pointermove", onMove);
			root.removeEventListener("pointerup", onUp);
			root.removeEventListener("pointercancel", onUp);
		},
	};
}
