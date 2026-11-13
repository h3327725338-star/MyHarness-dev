// The two sides a message can go to: the phone's own agent, or MyHarness on the user's PC. Both offer the same
// functions (send, stop, openChat, newChat, setModel…), so the panes never ask which one is in front.
import { local } from "./backend-local.js";
import { pc } from "./backend-remote.js";
import { setPrefs } from "./prefs.js";
import { emit, state } from "./store.js";

export const backends = { local, pc };
export const backend = () => backends[state.mode];

export function setMode(mode) {
	const next = mode === "pc" ? "pc" : "local";
	if (state.mode === next) return;
	state.mode = next;
	setPrefs({ mode: next });
	if (next === "pc") pc.activate();
	emit();
}

/** Things one pane asks of the whole app (set by main.js): show a pane, open settings, open an address in the browser. */
export const nav = {
	go: () => {},
	openSettings: () => {},
	openLink: () => {},
	openUrl: () => {},
};
