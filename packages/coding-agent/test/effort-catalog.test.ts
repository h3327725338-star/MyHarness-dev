import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultThinkingLevel, getSupportedThinkingLevels, type Model } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/manager.ts";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { CustomProviderManager } from "../src/providers/models/custom-provider-manager.ts";
import {
	effortPresetModelIds,
	normalizeEffortModelId,
	resolveEffortConfiguration,
	resolveEffortPreset,
} from "../src/providers/models/effort-catalog.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const {
	applyEffortLookup,
	applyEffortPreset,
	buildModel,
	compatWithEffort,
	effortSent,
	modelDraft,
	offeredLevels,
	seedFromDetected,
	updateFromDetection,
} = await import(new URL("../web/js/provider-models.js", import.meta.url).href);

const asModel = (id: string) => ({ id, ...resolveEffortPreset(id) }) as Model<any>;
describe("maintained reasoning presets and defaults", () => {
	it.each([
		["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
		["claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]],
		["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
		["deepseek-flash", ["off", "low", "high", "max"]],
		["deepseek-v4.1-flash-1017", ["off", "low", "high", "max"]],
		["deepseek-ai/DeepSeek-V4.1-Flash-1017", ["off", "low", "high", "max"]],
		["qwen3.8-max", ["off", "low", "medium", "xhigh"]],
		["glm-5.3", ["low", "high", "max"]],
		["kimi-k3.1-pro", ["low", "high", "max"]],
		["MiniMax-M3.1-Flash", ["low", "medium", "high", "xhigh", "max"]],
		["grok-4.7", ["low", "medium", "high", "xhigh"]],
		["muse-spark-1.3-contributor", ["minimal", "low", "medium", "high", "xhigh"]],
		["mistral-large-4-0", ["low", "medium", "high"]],
	])("provides documented distinct levels for %s", (id, levels) => {
		expect(getSupportedThinkingLevels(asModel(id as string))).toEqual(levels);
	});
	it("never extrapolates new versions or snapshots", () => {
		for (const id of [
			"gpt-999",
			"gpt-6-astra-unknown",
			"kimi-k4",
			"gemini-5",
			"gpt-5.5-2099-01-01",
			"deepseek-v4.1-flash-9999",
		])
			expect(resolveEffortPreset(id)).toBeUndefined();
	});
	it("normalizes only case and the leading vendor path before the exact match", () => {
		const bare = resolveEffortPreset("glm-5.3-flash");
		expect(bare).toBeDefined();
		for (const id of [
			"z-ai/glm-5.3-flash",
			"Z-AI/GLM-5.3-Flash",
			"  z-ai/glm-5.3-flash  ",
			"models/glm-5.3-flash",
			"accounts/fireworks/models/glm-5.3-flash",
			"openrouter/z-ai/glm-5.3-flash",
		])
			expect(resolveEffortPreset(id), id).toEqual(bare);
		expect(getSupportedThinkingLevels(asModel("z-ai/glm-5.3-flash"))).toEqual(["low", "high", "max"]);
		expect(resolveEffortPreset("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toEqual(
			resolveEffortPreset("deepseek-v4.1-flash-1017"),
		);
		// Not guessed: suffixes, other spellings, a different or longer name, a path that ends in a slash.
		for (const id of [
			"z-ai/glm-5.3-flash:free",
			"z-ai/glm-5.3-flash-fp8",
			"z-ai/glm-5.3-flash-2099-01-01",
			"z-ai/glm-5.3\u2011flash",
			"z-ai/glm-5.3-fla",
			"z-ai/glm-5-3-flash",
			"claude-opus-4.6",
			"z-ai/glm-5.3-flash/",
			"z-ai/",
			"/",
			"",
		])
			expect(resolveEffortPreset(id), id).toBeUndefined();
		expect(normalizeEffortModelId(" Vendor/Sub/Model-X ")).toBe("model-x");
	});
	it("lists each model once, already normalized", () => {
		const ids = effortPresetModelIds();
		expect(ids.length).toBeGreaterThan(50);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((id) => normalizeEffortModelId(id) !== id)).toEqual([]);
	});
	it("resolves a prefixed ID like the bare one in every mode decision", () => {
		for (const definition of [
			{ reasoning: true },
			{ reasoning: false },
			{ reasoning: true, thinkingLevelMap: { medium: null, xhigh: "xhigh" } },
			{ thinkingLevelMode: "manual" as const },
		]) {
			expect(resolveEffortConfiguration({ id: "z-ai/glm-5.3-flash", ...definition })).toEqual(
				resolveEffortConfiguration({ id: "glm-5.3-flash", ...definition }),
			);
		}
		expect(resolveEffortConfiguration({ id: "z-ai/glm-5.3-flash" }).mode).toBe("catalog");
		expect(resolveEffortConfiguration({ id: "z-ai/glm-5.3-flash" }).preset).toBeDefined();
	});
	it("keeps the model default and manual level map across form edits and refresh", () => {
		const original = {
			id: "gpt-6.1-sol",
			reasoning: true,
			thinkingLevelMode: "manual",
			defaultThinkingLevel: "low",
			thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
		};
		const draft = modelDraft(original);
		const refreshed = updateFromDetection(draft, {
			reasoning: true,
			thinkingSource: "official",
			thinkingLevelMap: { low: null },
		});
		expect(buildModel(refreshed)).toMatchObject(original);
		const model = { ...asModel(original.id), defaultThinkingLevel: "low" as const };
		expect(getDefaultThinkingLevel(model)).toBe("low");
		expect(getDefaultThinkingLevel({ ...model, reasoning: false })).toBe("off");
	});
	it("preserves defaults while a catalog preset is loading and keeps discovered unknown capabilities", () => {
		const loading = modelDraft({ id: "gpt-6.1-sol", thinkingLevelMode: "catalog", defaultThinkingLevel: "max" });
		expect(buildModel(loading).defaultThinkingLevel).toBe("max");
		const discovered = modelDraft({
			id: "unknown",
			thinkingLevelMode: "catalog",
			reasoning: true,
			thinkingLevelMap: { low: null, max: "max" },
		});
		expect(buildModel(discovered)).toMatchObject({ reasoning: true, thinkingLevelMap: { low: null, max: "max" } });
		expect(getSupportedThinkingLevels(asModel("claude-mythos-preview"))).not.toContain("off");
	});
	it("recognizes the screenshot's legacy DeepSeek configuration without enabling aliases", () => {
		const original = {
			id: "deepseek-v4.1-flash-1017",
			reasoning: true,
			defaultThinkingLevel: "low",
			thinkingLevelMap: { minimal: null, medium: null, max: "max" },
		};
		const resolved = resolveEffortConfiguration(original);
		expect(resolved.mode).toBe("catalog");
		const ready = applyEffortPreset(modelDraft(original), resolved);
		expect(offeredLevels(ready)).toEqual(["off", "low", "high", "max"]);
		expect(ready.raw.thinkingLevelAliases).toEqual({ minimal: "low", medium: "high", xhigh: "high", ultra: "max" });
		const saved = buildModel(ready);
		expect(saved).toMatchObject({ thinkingLevelMode: "catalog", defaultThinkingLevel: "low" });
		// The legacy fields stay next to the mode, so a version without `thinkingLevelMode` still shows reasoning.
		expect(saved.reasoning).toBe(true);
		expect(saved.thinkingLevelMap).toEqual(resolveEffortPreset(original.id)!.thinkingLevelMap);
		expect(saved.thinkingLevelAliases).toBeUndefined();
		const reloaded = applyEffortPreset(modelDraft(saved), resolveEffortConfiguration(saved));
		expect(offeredLevels(reloaded)).toEqual(["off", "low", "high", "max"]);
		const beforeLookup = buildModel(modelDraft(original));
		expect(beforeLookup.thinkingLevelMode).toBeUndefined();
		expect(resolveEffortConfiguration(beforeLookup).mode).toBe("catalog");
	});
	it("retains explicit manual choices, custom values and legacy differences", () => {
		const id = "deepseek-v4.1-flash-1017";
		const map = { minimal: null, medium: null, max: "max" };
		for (const definition of [
			{ id, reasoning: true, thinkingLevelMode: "manual" as const, thinkingLevelMap: map },
			{ id, reasoning: false },
			{ id, reasoning: true, thinkingLevelMap: { ...map, low: null } },
			{ id, reasoning: true, thinkingLevelMap: { ...map, high: "provider-high" } },
		]) {
			const resolved = resolveEffortConfiguration(definition);
			expect(resolved.mode).toBe("manual");
			expect(applyEffortPreset(modelDraft(definition), resolved).thinkingLevelMode).toBe("manual");
		}
		const manual = { ...modelDraft({ id }), thinkingLevelMode: "manual", effortModeChosen: "manual" };
		expect(applyEffortPreset(manual, { mode: "catalog", preset: resolveEffortPreset(id) })).toBe(manual);
		expect(offeredLevels(manual)).toHaveLength(7);
	});
	it("applies presets to discovered IDs and drops them when changed to an unknown ID", () => {
		const seeded = seedFromDetected({ id: "deepseek-v4.1-flash-1017", reasoning: true });
		expect(seeded.thinkingLevelMode).toBe("catalog");
		const ready = applyEffortPreset(seeded, resolveEffortConfiguration(buildModel(seeded)));
		expect(offeredLevels(ready)).toEqual(["off", "low", "high", "max"]);
		const changed = applyEffortPreset({ ...ready, id: "future-deepseek" }, { mode: "catalog", preset: undefined });
		expect(changed.presetKnown).toBe(false);
		expect(changed.reasoning).toBe(false);
		expect(changed.raw.thinkingLevelMap).toBeUndefined();
	});
	it("composes, saves and reloads the exact DeepSeek model with only its four actual levels", async () => {
		const root = await mkdtemp(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "deepseek-preset-"));
		try {
			const id = "deepseek-v4.1-flash-1017";
			const definition = {
				id,
				reasoning: true,
				defaultThinkingLevel: "low",
				thinkingLevelMap: { minimal: null, medium: null, max: "max" },
			};
			const path = join(root, "models.json");
			const write = async (model: object) =>
				writeFile(
					path,
					JSON.stringify({
						providers: {
							relay: {
								api: "openai-completions",
								baseUrl: "https://example.invalid/v1",
								apiKey: "local",
								models: [model],
							},
						},
					}),
				);
			await write(definition);
			const credentials = AuthStorage.inMemory();
			const load = () => ModelRuntime.create({ credentials, modelsPath: path, allowModelNetwork: false });
			let runtime = await load();
			let model = runtime.getModel("relay", id)!;
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			expect(getDefaultThinkingLevel(model)).toBe("low");
			// A preset describes the model's levels; it never opts an unknown relay into `reasoning_effort` (models.md).
			expect(
				(model.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort,
			).toBeUndefined();
			await write(buildModel(applyEffortPreset(modelDraft(definition), resolveEffortConfiguration(definition))));
			runtime = await load();
			model = runtime.getModel("relay", id)!;
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			const manager = new CustomProviderManager(path);
			await manager.mergeDiscoveredModels(
				"relay",
				[{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DS", reasoning: true }],
				"openai-completions",
			);
			runtime = await load();
			expect(getSupportedThinkingLevels(runtime.getModel("relay", "deepseek-ai/DeepSeek-V4.1-Flash-1017")!)).toEqual(
				["off", "low", "high", "max"],
			);
			await write({
				...definition,
				thinkingLevelMode: "manual",
				thinkingLevelMap: { ...definition.thinkingLevelMap, low: null },
			});
			await manager.mergeDiscoveredModels(
				"relay",
				[
					{
						id,
						name: id,
						reasoning: true,
						thinkingSource: "official",
						thinkingLevelMap: resolveEffortPreset(id)!.thinkingLevelMap,
					},
				],
				"openai-completions",
			);
			runtime = await load();
			expect(getSupportedThinkingLevels(runtime.getModel("relay", id)!)).toEqual(["off", "high", "max"]);
			expect(JSON.parse(await readFile(path, "utf8")).providers.relay.models[0].thinkingLevelMode).toBe("manual");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("applies the preset to a prefixed relay ID and keeps the legacy fields for older versions", async () => {
		const id = "z-ai/glm-5.3-flash";
		const levels = ["low", "high", "max"];
		const typed = modelDraft({ id, name: "GLM-5.3 Flash" });
		expect(typed.thinkingLevelMode).toBe("catalog");
		const ready = applyEffortPreset(typed, resolveEffortConfiguration(buildModel(typed)));
		expect(ready).toMatchObject({ presetKnown: true, thinkingLevelMode: "catalog", reasoning: true });
		expect(offeredLevels(ready)).toEqual(levels);
		const saved = buildModel(ready);
		expect(saved).toMatchObject({ id, name: "GLM-5.3 Flash", thinkingLevelMode: "catalog", reasoning: true });
		expect(saved.thinkingLevelMap).toEqual(resolveEffortPreset(id)!.thinkingLevelMap);
		// A version that does not know `thinkingLevelMode` reads only these two fields.
		expect(
			getSupportedThinkingLevels({
				id,
				reasoning: saved.reasoning,
				thinkingLevelMap: saved.thinkingLevelMap,
			} as Model<any>),
		).toEqual(levels);
		// A lookup still running (or a manual draft) saves no stale copy of a preset.
		expect(buildModel(typed).reasoning).toBeUndefined();
		expect(buildModel(typed).thinkingLevelMap).toBeUndefined();
		// Switching to an unknown ID drops the copy again.
		const unknown = applyEffortPreset({ ...ready, id: "z-ai/glm-9" }, { mode: "catalog", preset: undefined });
		expect(unknown.presetMap).toBeUndefined();
		expect(buildModel(unknown).thinkingLevelMap).toBeUndefined();

		const root = await mkdtemp(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "prefixed-preset-"));
		try {
			const path = join(root, "models.json");
			const load = async (model: object) => {
				await writeFile(
					path,
					JSON.stringify({
						providers: {
							"command-code": {
								api: "openai-completions",
								baseUrl: "https://example.invalid/v1",
								apiKey: "local",
								models: [model],
							},
						},
					}),
				);
				const runtime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					modelsPath: path,
					allowModelNetwork: false,
				});
				return runtime.getModel("command-code", id)!;
			};
			// New version: the preset wins in catalog mode, also over a saved copy that differs.
			expect(getSupportedThinkingLevels(await load(saved))).toEqual(levels);
			expect(getSupportedThinkingLevels(await load({ ...saved, thinkingLevelMap: { minimal: null } }))).toEqual(
				levels,
			);
			// An entry from before `thinkingLevelMode` existed, holding the same copy, resolves to the same levels.
			const { thinkingLevelMode: _mode, ...legacy } = saved;
			expect(getSupportedThinkingLevels(await load(legacy))).toEqual(levels);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		["glm-5.3-flashx", ["low", "high", "max"]],
		["glm-5.3-flashx-legal", ["low", "high", "max"]],
		["glm-5.2", ["off", "high", "max"]],
		["zai-glm-5-3-flash", ["low", "high", "max"]],
		["grok-4.3", ["off", "low", "medium", "high"]],
		["grok-4.5-latest", ["low", "medium", "high"]],
		["qwen4-max-preview", ["low", "medium", "xhigh"]],
		["qwen4.0-max-preview", ["low", "medium", "xhigh"]],
		["k3.1-pro", ["low", "high", "max"]],
		["gpt-oss-20b", ["low", "medium", "high"]],
		["gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
		["gemini-robotics-er-2-preview", ["minimal", "low", "medium", "high"]],
		["muse-spark-1.2", ["minimal", "low", "medium", "high", "xhigh"]],
	])("lists %s with the levels its vendor documents", (id, levels) => {
		expect(getSupportedThinkingLevels(asModel(id))).toEqual(levels);
	});
	it("names what GLM 5.2 accepts without offering it as a level of its own", () => {
		expect(resolveEffortPreset("glm-5.2")!.thinkingLevelAliases).toEqual({
			low: "high",
			medium: "high",
			xhigh: "max",
		});
	});
	it("puts a model the list calls non-reasoning on the preset when the table lists it, in the form", () => {
		const id = "z-ai/glm-5.3-flash";
		const seeded = seedFromDetected({ id, reasoning: false });
		expect(seeded).toMatchObject({ thinkingLevelMode: "manual", seededManual: true, reasoning: false });
		const ready = applyEffortLookup(seeded, resolveEffortConfiguration(buildModel(seeded)));
		expect(ready).toMatchObject({
			thinkingLevelMode: "catalog",
			presetKnown: true,
			reasoning: true,
			seededManual: false,
		});
		expect(offeredLevels(ready)).toEqual(["low", "high", "max"]);
		expect(buildModel(ready)).toMatchObject({ thinkingLevelMode: "catalog", reasoning: true });
		expect(buildModel(ready).seededManual).toBeUndefined();
		// The table does not list it: what the list said stays.
		const unknown = seedFromDetected({ id: "relay/plain-chat", reasoning: false });
		const kept = applyEffortLookup(unknown, resolveEffortConfiguration(buildModel(unknown)));
		expect(kept).toMatchObject({ thinkingLevelMode: "manual", reasoning: false, presetAvailable: false });
		expect(buildModel(kept)).toMatchObject({ thinkingLevelMode: "manual", reasoning: false });
		// Touched by the user since: theirs, the preset is only pointed out.
		const touched = { ...seedFromDetected({ id, reasoning: false }), touched: { reasoning: true }, reasoning: true };
		const own = applyEffortLookup(touched, resolveEffortConfiguration(buildModel(touched)));
		expect(own).toMatchObject({ thinkingLevelMode: "manual", presetAvailable: true });
		expect(own.presetKnown).toBeUndefined();
	});
	it("leaves a saved manual override alone and only says that the table lists the model", () => {
		const saved = {
			id: "z-ai/glm-5.3-flash",
			reasoning: true,
			thinkingLevelMode: "manual",
			thinkingLevelMap: { minimal: null, medium: null, max: "max" },
		};
		const draft = modelDraft(saved);
		const looked = applyEffortLookup(draft, resolveEffortConfiguration(saved as never));
		expect(looked).toMatchObject({ thinkingLevelMode: "manual", presetAvailable: true });
		expect(offeredLevels(looked).filter((level: string) => looked.levels[level])).toEqual([
			"off",
			"low",
			"high",
			"max",
		]);
		expect(buildModel(looked)).toEqual(buildModel(draft));
		expect(applyEffortLookup(looked, resolveEffortConfiguration(saved as never))).toBe(looked);
		const unlisted = modelDraft({ ...saved, id: "relay/own-model" });
		expect(
			applyEffortLookup(unlisted, resolveEffortConfiguration({ ...saved, id: "relay/own-model" } as never))
				.presetAvailable,
		).toBe(false);
	});
	it("adds a discovered model the list calls non-reasoning on the preset when the table lists it", async () => {
		const root = await mkdtemp(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "discovered-preset-"));
		try {
			const path = join(root, "models.json");
			await writeFile(
				path,
				JSON.stringify({
					providers: {
						relay: {
							api: "openai-completions",
							baseUrl: "https://example.invalid/v1",
							apiKey: "local",
							models: [],
						},
					},
				}),
			);
			const manager = new CustomProviderManager(path);
			await manager.mergeDiscoveredModels(
				"relay",
				[
					{ id: "z-ai/glm-5.3-flash", name: "GLM", reasoning: false },
					{ id: "relay/plain-chat", name: "Plain", reasoning: false },
					{ id: "relay/unknown-thinker", name: "Thinker", reasoning: true },
				] as never,
				"openai-completions",
			);
			const models = JSON.parse(await readFile(path, "utf8")).providers.relay.models;
			expect(models[0]).toMatchObject({ id: "z-ai/glm-5.3-flash", thinkingLevelMode: "catalog", reasoning: true });
			expect(models[0].thinkingLevelMap).toEqual(resolveEffortPreset("glm-5.3-flash")!.thinkingLevelMap);
			expect(models[1]).toMatchObject({ id: "relay/plain-chat", thinkingLevelMode: "manual", reasoning: false });
			expect(models[2]).toMatchObject({
				id: "relay/unknown-thinker",
				thinkingLevelMode: "catalog",
				reasoning: true,
			});
			expect(models[2].thinkingLevelMap).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("writes the provider switch to compat.supportsReasoningEffort and reads it back", () => {
		expect(compatWithEffort(undefined, false)).toBeUndefined();
		expect(compatWithEffort({ supportsStore: false }, false)).toEqual({ supportsStore: false });
		expect(compatWithEffort({ supportsReasoningEffort: false }, false)).toEqual({ supportsReasoningEffort: false });
		expect(compatWithEffort(undefined, true)).toEqual({ supportsReasoningEffort: true });
		expect(compatWithEffort({ supportsStore: false }, true)).toEqual({
			supportsStore: false,
			supportsReasoningEffort: true,
		});
		// Turning an earlier `true` off is written out, so a service the built-in rules would send it to stops getting it.
		expect(compatWithEffort({ supportsStore: false, supportsReasoningEffort: true }, false)).toEqual({
			supportsStore: false,
			supportsReasoningEffort: false,
		});

		const api = "openai-completions";
		expect(effortSent({ api, providerCompat: undefined, modelCompat: undefined })).toBe(false);
		expect(effortSent({ api, providerCompat: { supportsReasoningEffort: true } })).toBe(true);
		expect(
			effortSent({
				api,
				providerCompat: { supportsReasoningEffort: true },
				modelCompat: { supportsReasoningEffort: false },
			}),
		).toBe(false);
		expect(effortSent({ api, modelCompat: { supportsReasoningEffort: true } })).toBe(true);
		// Not applicable: another API format, or a format that sends the level its own way.
		expect(effortSent({ api: "anthropic-messages", providerCompat: undefined })).toBeNull();
		expect(effortSent({ api, providerCompat: { thinkingFormat: "openrouter" } })).toBeNull();
		expect(effortSent({ api, providerCompat: { thinkingFormat: "openai" } })).toBe(false);
		// An address MyHarness recognizes keeps its built-in default: nothing is claimed unless a setting says so.
		expect(effortSent({ api, baseUrl: "https://api.deepseek.com/v1" })).toBeNull();
		expect(effortSent({ api, baseUrl: "https://API.OpenAI.com/v1" })).toBeNull();
		expect(
			effortSent({ api, baseUrl: "https://api.deepseek.com", providerCompat: { supportsReasoningEffort: false } }),
		).toBe(false);
		expect(effortSent({ api, baseUrl: "https://relay.example/v1" })).toBe(false);
	});
	it("keeps reasoning for a model already in the form that a detection found to reason", () => {
		const detected = updateFromDetection(modelDraft({ id: "m1" }), {
			id: "m1",
			reasoning: true,
			thinkingSource: "unconfirmed",
		});
		expect(detected.reasoning).toBe(true);
		const saved = buildModel(detected);
		expect(saved.reasoning).toBe(true);
		expect(saved.thinkingLevelMap).toBeUndefined();
		// Nothing stated and nothing detected: the fields stay out, as before.
		expect(buildModel(modelDraft({ id: "m2" })).reasoning).toBeUndefined();
	});
	it("puts reasoning_effort in the request body only when the provider switch is on", async () => {
		const { streamSimple } = await import("@myharness/ai/compat");
		const id = "z-ai/glm-5.3-flash";
		const root = await mkdtemp(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "effort-payload-"));
		try {
			const path = join(root, "models.json");
			const bodyFor = async (compat: object | undefined, baseUrl = "https://example.invalid/v1") => {
				await writeFile(
					path,
					JSON.stringify({
						providers: {
							"command-code": {
								api: "openai-completions",
								baseUrl,
								apiKey: "local",
								...(compat ? { compat } : {}),
								models: [{ id, thinkingLevelMode: "catalog" }],
							},
						},
					}),
				);
				const runtime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					modelsPath: path,
					allowModelNetwork: false,
				});
				const model = runtime.getModel("command-code", id)!;
				let body: Record<string, unknown> | undefined;
				const result = streamSimple(
					model,
					{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
					{
						apiKey: "local",
						reasoning: "high",
						onPayload: (payload) => {
							body = payload as Record<string, unknown>;
							throw new Error("stop before any network request");
						},
					},
				);
				await result.result();
				return body;
			};
			expect((await bodyFor(undefined))?.reasoning_effort).toBeUndefined();
			expect((await bodyFor({ supportsReasoningEffort: false }))?.reasoning_effort).toBeUndefined();
			expect((await bodyFor({ supportsReasoningEffort: true }))?.reasoning_effort).toBe("high");
			// The form says nothing about an address exactly when the request builder sends the level there unasked.
			const api = "openai-completions";
			for (const baseUrl of [
				"https://api.openai.com/v1",
				"https://api.deepseek.com/v1",
				"https://api.cloudflare.com/client/v4/accounts/a/ai/v1",
				"https://gateway.ai.cloudflare.com/v1/a/b/compat",
				"https://api.x.ai/v1",
				"https://api.moonshot.cn/v1",
				"https://api.together.xyz/v1",
				"https://integrate.api.nvidia.com/v1",
				"https://relay.example/v1",
			]) {
				const sentUnasked = (await bodyFor(undefined, baseUrl))?.reasoning_effort !== undefined;
				expect([baseUrl, effortSent({ api, baseUrl })]).toEqual([baseUrl, sentUnasked ? null : false]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("persists new-chat selection independently and clears deleted references", () => {
		const settings = SettingsManager.inMemory();
		settings.setNewChatModel({ provider: "p", model: "m", thinkingLevel: "low" });
		settings.setDefaultModelAndProvider("other", "temporary");
		settings.setDefaultThinkingLevel("max");
		expect(settings.getNewChatModel()).toEqual({ provider: "p", model: "m", thinkingLevel: "low" });
		settings.clearModelReferences("p", "m");
		expect(settings.getNewChatModel()).toBeUndefined();
	});
});
