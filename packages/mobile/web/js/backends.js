// The two sides a message can go to: the phone's own agent, or MyHarness on the user's PC. Both offer the same
// functions (send, stop, openChat, newChat, setModel…), so the panes never ask which one is in front.
import { local } from "./backend-local.js";
import { pc } from "./backend-remote.js";
import { setPrefs, setShownMode } from "./prefs.js";
import { emit, state } from "./store.js";

export const backends = { local, pc };
export const backend = () => backends[state.mode];

/** The chat mode whose colours the page wears: Coding or General on a paired PC's side, General for the phone's own assistant. */
export const chatModeOnScreen = (s = state) => (s.mode === "pc" && s.pc.link.paired && s.pc.listMode === "coding" ? "coding" : "general");

/** Switch sides. `origin` is where the switch was tapped: the other side's colours spread from there (prefs.js). */
export function setMode(mode, origin) {
	const next = mode === "pc" ? "pc" : "local";
	if (state.mode === next) return;
	setShownMode(chatModeOnScreen({ ...state, mode: next }), {
		origin,
		change: () => {
			state.mode = next;
			setPrefs({ mode: next });
			if (next === "pc") pc.activate();
			emit();
		},
	});
}

/** Things one pane asks of the whole app (set by main.js): show a pane, open settings, open an address in the browser. */
export const nav = {
	go: () => {},
	openSettings: () => {},
	openLink: () => {},
	openUrl: () => {},
};
