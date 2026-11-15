import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

// The first switch to a mode whose chat is not loaded yet: the reveal animation captures the page as it is when it
// starts. The conversation being left must still be on that page, so `state.switching` (which makes the page draw the
// target's "Loading…") may only be set once the reveal has captured it, while sends are locked the whole time.
it("leaves the old conversation on screen until the mode reveal has captured it", async () => {
	const source = readFileSync(new URL("../web/js/store.js", import.meta.url), "utf8");
	const cut = (from: string, to: string) => {
		const start = source.indexOf(from);
		const end = source.indexOf(to, start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	};
	const sequence = cut("let switchSeq = 0;", "\n\n/**");
	const switchMode = cut("export async function switchChatMode", "\n// ---- Switching between sessions");
	const canSend = cut("export const canSendToActive", "\n");
	const code = `${sequence}\n${switchMode}\n${canSend}\nglobalThis.api = { switchChatMode, canSendToActive };`.replace(
		/^export /gm,
		"",
	);

	const state: any = { view: { chatMode: "coding" }, switching: null, modeState: {}, opening: null };
	const seen: { switching: unknown; canSend: boolean }[] = [];
	let update: (() => void) | undefined;
	let revealed!: () => void;
	const context: any = vm.createContext({
		state,
		activeSlot: "a",
		panelKey: "a",
		bags: new Map(),
		bagOf: () => ({ loaded: true }),
		chatModeOf: (mode: unknown) => (mode === "general" ? "general" : "coding"),
		startInteraction: () => ({}),
		emit: () => {},
		reverseModeReveal: () => false,
		flushDrafts: async () => {},
		rememberChat: async () => {},
		sameFile: () => false,
		// Like the View Transition: the page is captured as it is now, and the update runs a moment later.
		revealMode: (callback: () => void) => {
			seen.push({ switching: state.switching, canSend: context.api.canSendToActive() });
			update = callback;
			return new Promise<void>((resolve) => {
				revealed = resolve;
			});
		},
		beginSwitch: (target: { mode: string }, seq: number) => {
			state.switching = { mode: target.mode, seq, error: null };
			return state.switching;
		},
		loadWorkspaces: async () => {},
		loadSlots: async () => {},
		post: async () => ({ state: {}, slot: "b" }),
		setModeState: () => {},
		activateSlot: async () => {
			state.switching = null;
		},
		failSwitch: () => {},
		applyPanel: () => {},
		setChatMode: () => {},
	});
	vm.runInContext(code, context);
	const { switchChatMode, canSendToActive } = context.api;

	// Before any switch nothing is locked.
	expect(canSendToActive()).toBe(true);
	const switching = switchChatMode("general");
	await Promise.resolve();
	// At the capture: the old page is not replaced by the target's placeholder, and no message can slip in.
	expect(seen).toEqual([{ switching: null, canSend: false }]);
	expect(state.switching).toBeNull();
	// The reveal's update selects the target; from there `state.switching` carries the lock.
	update?.();
	expect(state.switching?.mode).toBe("general");
	expect(canSendToActive()).toBe(false);
	revealed();
	await switching;
	expect(state.switching).toBeNull();
	expect(canSendToActive()).toBe(true);
});
