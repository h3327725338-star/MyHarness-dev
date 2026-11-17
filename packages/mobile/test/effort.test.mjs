// The reasoning effort that goes with a model on the phone (web/js/effort.js): which levels a model offers, what "Default"
// is, and what the effort becomes when another model is chosen. The rules are the desktop's (packages/ai models.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampLevel, defaultLevel, FALLBACK_LEVEL, LEVEL_ORDER, levelAfterSwitch, offeredLevels, pcModels, snapFromEvent, switchSnap } from "../web/js/effort.js";

const FIVE = ["off", "minimal", "low", "medium", "high"];
const SIX = ["off", "low", "medium", "high", "xhigh", "max"];
const THREE = ["off", "low", "high"];

// What GET /api/models and GET /api/state of the PC say (wire.ts: toWireModel, host.ts: snapshot).
const wire = (id, levels, extra = {}) => ({ provider: "p", id, name: id.toUpperCase(), reasoning: levels.length > 1, input: ["text", "image"], thinkingLevels: levels, defaultThinkingLevel: levels.at(-1), ...extra });
const list = (defaults = { thinkingLevel: "medium" }) => ({
	current: { provider: "p", id: "a" },
	providers: [{ id: "p", name: "Provider", models: [wire("a", SIX), wire("b", FIVE), wire("c", THREE), wire("plain", ["off"], { reasoning: false })] }],
	defaults,
});
const snapOf = (model, level) => ({ model, thinking: { supported: model.reasoning, levels: model.thinkingLevels, level } });

test("the level order is the desktop's, weakest first", () => {
	assert.deepEqual(LEVEL_ORDER, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("a model with one level, or that cannot reason, offers no choice", () => {
	assert.deepEqual(offeredLevels(wire("x", ["off"], { reasoning: true })), []);
	assert.deepEqual(offeredLevels(wire("x", FIVE, { reasoning: false })), []);
	assert.deepEqual(offeredLevels(wire("x", FIVE)), FIVE);
	assert.deepEqual(offeredLevels(null), []);
	assert.deepEqual(offeredLevels({ reasoning: true }), []);
});

test("a level is brought within the levels of the model: stronger first, then weaker", () => {
	assert.equal(clampLevel(FIVE, "medium"), "medium");
	assert.equal(clampLevel(FIVE, "xhigh"), "high", "nothing stronger than high: the nearest weaker one");
	assert.equal(clampLevel(FIVE, "max"), "high");
	assert.equal(clampLevel(THREE, "minimal"), "low", "the next stronger level is taken first");
	assert.equal(clampLevel(THREE, "medium"), "high");
	assert.equal(clampLevel(SIX, "minimal"), "low");
	assert.equal(clampLevel(["off"], "high"), "off");
	assert.equal(clampLevel([], "high"), "off");
	assert.equal(clampLevel(FIVE, "nonsense"), "off");
});

test("Default is the model's configured level when it offers it, else its strongest", () => {
	assert.equal(defaultLevel(wire("x", SIX)), "max", "the strongest level when nothing is configured");
	assert.equal(defaultLevel(wire("x", SIX, { defaultThinkingLevel: "medium" })), "medium");
	assert.equal(defaultLevel(wire("x", FIVE, { defaultThinkingLevel: "max" })), "high", "a configured level the model does not offer is ignored");
	assert.equal(defaultLevel(wire("x", ["off"])), "");
	assert.equal(defaultLevel({ reasoning: false }), "");
});

test("the page's models carry each model's own levels and the default of the one in use", () => {
	const a = wire("a", SIX, { defaultThinkingLevel: "high" });
	const models = pcModels({ list: list(), snap: snapOf(a, "medium") });
	assert.equal(models.loaded, true);
	assert.deepEqual(models.efforts, SIX);
	assert.equal(models.effort, "medium");
	assert.equal(models.defaultEffort, "high", "the default the model in use was set up with, from the snapshot");
});

test("the model in use is named by the snapshot, under its provider's name", () => {
	const models = pcModels({ list: list(), snap: snapOf(wire("b", FIVE), "high") });
	assert.deepEqual(models.current, { provider: "p", providerName: "Provider", id: "b", name: "B", reasoning: true, vision: true });
	const entry = models.providers[0].models.find((model) => model.id === "c");
	assert.deepEqual(entry.thinkingLevels, THREE, "the picker's rows keep the model's own levels");
	assert.equal(entry.defaultThinkingLevel, "high");
});

test("a model that cannot reason shows no effort, and a switch starts from the PC's own default", () => {
	const models = pcModels({ list: list({ thinkingLevel: "low" }), snap: snapOf(wire("plain", ["off"], { reasoning: false }), "off") });
	assert.deepEqual(models.efforts, []);
	assert.equal(models.effort, "off");
	assert.equal(models.defaultEffort, "");
	assert.equal(models.base, "low");
	// Without a default in the PC's answer the desktop's fallback is used.
	assert.equal(pcModels({ list: list(null), snap: snapOf(wire("plain", ["off"], { reasoning: false }), "off") }).base, FALLBACK_LEVEL);
});

test("before anything is read, nothing is current", () => {
	const models = pcModels({ list: null, snap: null });
	assert.equal(models.current, null);
	assert.deepEqual(models.providers, []);
	assert.deepEqual(models.efforts, []);
});

test("the picker shows, for each model, the level it would get if chosen now", () => {
	const models = pcModels({ list: list(), snap: snapOf(wire("a", SIX), "xhigh") });
	const row = (id) => models.providers[0].models.find((model) => model.id === id);
	assert.equal(levelAfterSwitch(models, row("b")), "high", "xhigh is not on B: the nearest weaker level");
	assert.equal(levelAfterSwitch(models, row("a")), "xhigh");
	assert.equal(levelAfterSwitch(models, row("plain")), "", "no effort on a model that cannot reason");
});

test("choosing another model changes the name, the levels and the level at once", () => {
	const a = wire("a", SIX);
	const models = pcModels({ list: list(), snap: snapOf(a, "max") });
	const snap = switchSnap(models, "p", "c");
	assert.equal(snap.model.id, "c");
	assert.deepEqual(snap.thinking, { supported: true, levels: THREE, level: "high" }, "max is not on C: the nearest weaker one");
	const after = pcModels({ list: list(), snap });
	assert.equal(after.current.name, "C");
	assert.deepEqual(after.efforts, THREE);
	assert.equal(after.effort, "high");
	assert.equal(after.defaultEffort, "high");
});

test("the level goes through a chain of switches the way the PC keeps it", () => {
	let models = pcModels({ list: list(), snap: snapOf(wire("a", SIX), "medium") });
	const go = (id) => (models = pcModels({ list: list(), snap: switchSnap(models, "p", id) }));
	assert.equal(go("c").effort, "high", "C lacks medium: the nearest stronger one, as clampThinkingLevel does");
	assert.equal(go("b").effort, "high", "the level in use is kept when the model offers it");
	// A model that cannot reason: nothing to choose, and the next switch starts from the PC's default (medium here).
	const plain = go("plain");
	assert.deepEqual(plain.efforts, []);
	assert.equal(plain.effort, "off");
	assert.equal(go("a").effort, "medium");
});

// The PC's model_changed event (host.ts: modelState, stamped with the slot): the same { model, thinking } as GET /api/state.
const changed = (model, level, extra = {}) => ({ slot: "s1", model, thinking: { level, levels: model ? model.thinkingLevels : [], supported: model ? model.reasoning : false }, ...extra });

test("the PC's model_changed event becomes the chat's snapshot, and the page shows its model, levels and level", () => {
	const before = pcModels({ list: list(), snap: snapOf(wire("a", SIX), "max") });
	assert.equal(before.current.id, "a");
	const c = wire("c", THREE, { defaultThinkingLevel: "low" });
	const snap = snapFromEvent(changed(c, "high"));
	assert.deepEqual(snap, { model: c, thinking: { supported: true, levels: THREE, level: "high" } }, "the slot is the page's business, not the snapshot's");
	const after = pcModels({ list: list(), snap });
	assert.equal(after.current.name, "C");
	assert.deepEqual(after.efforts, THREE);
	assert.equal(after.effort, "high");
	assert.equal(after.defaultEffort, "low", "the default the new model was set up with");
	assert.equal(after.base, "high", "the next switch starts from the level now in use");
});

test("a model change that leaves the level as it is still replaces the levels of the old model", () => {
	// The case the level event could not tell: high stays high, but the model and its levels are another's.
	const before = pcModels({ list: list(), snap: snapOf(wire("a", SIX), "high") });
	assert.deepEqual(before.efforts, SIX);
	const after = pcModels({ list: list(), snap: snapFromEvent(changed(wire("b", FIVE), "high")) });
	assert.equal(after.current.id, "b");
	assert.deepEqual(after.efforts, FIVE);
	assert.equal(after.effort, "high");
	assert.equal(after.defaultEffort, "high");
});

test("an event for a model that cannot reason shows no effort; one without a model shows none current", () => {
	const plain = pcModels({ list: list({ thinkingLevel: "low" }), snap: snapFromEvent(changed(wire("plain", ["off"], { reasoning: false }), "off")) });
	assert.deepEqual(plain.efforts, []);
	assert.equal(plain.effort, "off");
	assert.equal(plain.defaultEffort, "");
	assert.equal(plain.base, "low");
	const none = snapFromEvent({ slot: "s1", model: null, thinking: { level: "off", levels: ["off"], supported: false } });
	assert.deepEqual(none, { model: null, thinking: { supported: false, levels: ["off"], level: "off" } });
	assert.equal(pcModels({ list: list(), snap: none }).current, null);
});

test("an event that does not carry a state is not taken for one", () => {
	assert.equal(snapFromEvent(undefined), null);
	assert.equal(snapFromEvent({ slot: "s1" }), null, "no thinking");
	assert.equal(snapFromEvent({ slot: "s1", model: wire("a", SIX), thinking: { levels: SIX } }), null, "no level in use");
	assert.equal(snapFromEvent({ slot: "s1", model: wire("a", SIX), thinking: { level: 3, levels: SIX } }), null, "a level that is not a name");
	assert.equal(snapFromEvent({ slot: "s1", thinking: { level: "high", levels: SIX } }), null, "no model, not even a null one");
	assert.equal(snapFromEvent({ slot: "s1", model: { name: "x" }, thinking: { level: "high", levels: SIX } }), null, "a model without an id");
	// Levels that are not names are dropped, not shown.
	assert.deepEqual(snapFromEvent({ model: wire("a", SIX), thinking: { level: "high", levels: ["low", 7, "high"], supported: true } }).thinking.levels, ["low", "high"]);
});

test("a model the page cannot predict leaves the PC's answer to decide", () => {
	const models = pcModels({ list: list(), snap: snapOf(wire("a", SIX), "medium") });
	assert.equal(switchSnap(models, "p", "missing"), null);
	assert.equal(switchSnap(models, "other", "a"), null);
	// An older PC does not send the levels of the models in its list.
	const old = pcModels({ list: { providers: [{ id: "p", name: "P", models: [{ provider: "p", id: "z", name: "Z", reasoning: true, input: ["text"] }] }] }, snap: snapOf(wire("a", SIX), "medium") });
	assert.equal(switchSnap(old, "p", "z"), null);
});
