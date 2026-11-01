import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureHttpDispatcher } from "../src/platform/process/http-dispatcher.ts";
import { CustomProviderManager } from "../src/providers/models/custom-provider-manager.ts";
import {
	groupCredentialId,
	layeredProviderName,
	type MergeCandidate,
	modelCredentialId,
	newGroupId,
	resolveProviderLayers,
	suggestProviderMerges,
	toLayeredEntry,
	withGroupValues,
} from "../src/providers/models/layers.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const directories: string[] = [];
const servers: Server[] = [];

function createDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "myharness-provider-layers-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Document = Record<string, unknown>;

async function runtimeFor(document: Document) {
	const directory = createDirectory();
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, JSON.stringify(document), "utf8");
	const runtime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath,
		modelsStorePath: join(directory, "models-store.json"),
		allowModelNetwork: false,
	});
	return { runtime, modelsPath, manager: new CustomProviderManager(modelsPath) };
}

/** What every model really uses for a request; this is what must not change when the configuration is reorganized. */
async function whatModelsUse(runtime: ModelRuntime) {
	const used: Record<string, unknown> = {};
	for (const model of runtime.getModels()) {
		const auth = await runtime.getAuth(model).catch(() => undefined);
		used[`${model.provider}/${model.id}`] = {
			baseUrl: model.baseUrl,
			api: model.api,
			key: auth?.auth.apiKey ?? null,
			headers: auth?.auth.headers ?? null,
		};
	}
	return used;
}

/** The shape of a real configuration of several relays: same host under different names, per-format addresses. */
const RELAYS = {
	providers: {
		sudocode: {
			name: "relay-pro",
			baseUrl: "https://api.relay-one.example/v1",
			api: "openai-completions",
			authMode: "apiKey",
			models: [{ id: "gpt-a" }],
		},
		plus: {
			name: "relay-plus",
			baseUrl: "https://api.relay-one.example/v1",
			api: "openai-completions",
			authMode: "apiKey",
			models: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-c" }],
		},
		claude: {
			name: "relay-claude",
			baseUrl: "https://api.relay-one.example",
			api: "anthropic-messages",
			authMode: "apiKey",
			models: [{ id: "claude-a" }],
		},
		zen: {
			name: "zen-muse",
			baseUrl: "https://zen.relay-two.example/go/v1",
			api: "openai-responses",
			authMode: "apiKey",
			models: [{ id: "muse", headers: { "x-extra": "kept" } }],
		},
		"zen-ds": {
			name: "zen-ds",
			baseUrl: "https://zen.relay-two.example/go",
			api: "anthropic-messages",
			authMode: "apiKey",
			models: [{ id: "ds" }],
		},
		alone: {
			name: "alone",
			baseUrl: "https://alone.example/v1",
			api: "openai-completions",
			authMode: "apiKey",
			models: [{ id: "only" }],
		},
	},
};

describe("the rule of the layers", () => {
	const entry = {
		name: "key",
		baseUrl: "https://key.example/v1",
		api: "openai-completions",
		models: [{ id: "m", baseUrl: "https://model.example/v1", api: "anthropic-messages" }],
	};

	it("takes each field from the highest layer that has it, separately", () => {
		const both = resolveProviderLayers("key", { ...entry, layered: true }, { baseUrl: "https://top.example/v1" });
		expect(both.baseUrl).toBe("https://top.example/v1");
		expect(both.api).toBe("openai-completions");
		expect(both.models?.[0]).toMatchObject({ baseUrl: "https://top.example/v1", api: "openai-completions" });

		const noGroup = resolveProviderLayers("key", { ...entry, layered: true }, undefined);
		expect(noGroup.models?.[0]).toMatchObject({ baseUrl: "https://key.example/v1", api: "openai-completions" });

		const onlyModel = resolveProviderLayers(
			"key",
			{ layered: true, models: [{ id: "m", baseUrl: "https://model.example/v1", api: "anthropic-messages" }] },
			{},
		);
		expect(onlyModel.models?.[0]).toMatchObject({ baseUrl: "https://model.example/v1", api: "anthropic-messages" });
	});

	it("leaves an entry from before the layers exactly as it is: there a model's own value wins", () => {
		expect(resolveProviderLayers("key", entry, undefined)).toBe(entry);
	});

	it("never guesses: a field nobody set stays empty", () => {
		const resolved = resolveProviderLayers("key", { layered: true, models: [{ id: "m" }] }, undefined);
		expect(resolved.baseUrl).toBeUndefined();
		expect(resolved.api).toBeUndefined();
		expect(resolved.models?.[0]?.baseUrl).toBeUndefined();
		expect(resolved.models?.[0]?.api).toBeUndefined();
	});

	it("keeps a covered value in the file while another value applies", () => {
		const stored = { ...entry, layered: true };
		resolveProviderLayers("key", stored, { baseUrl: "https://top.example/v1" });
		expect(stored.baseUrl).toBe("https://key.example/v1");
		expect(stored.models[0]?.baseUrl).toBe("https://model.example/v1");
	});

	it("names an entry of a group by both, unless its own name already says it", () => {
		expect(layeredProviderName("relay", "relay-plus")).toBe("relay-plus");
		expect(layeredProviderName("relay", "cheap")).toBe("relay · cheap");
		expect(layeredProviderName(undefined, "cheap")).toBe("cheap");
	});
});

describe("moving an old entry under the layered rule", () => {
	const effective = (config: ReturnType<typeof toLayeredEntry>) =>
		resolveProviderLayers("id", config, undefined).models?.map((model) => [model.id, model.baseUrl, model.api]);

	it("holds a shared value on the entry and clears it from the models", () => {
		const layered = toLayeredEntry({
			baseUrl: "https://a/v1",
			api: "openai-completions",
			models: [
				{ id: "x", baseUrl: "https://a/v1" },
				{ id: "y", api: "openai-completions" },
			],
		});
		expect(layered).toMatchObject({ layered: true, baseUrl: "https://a/v1", api: "openai-completions" });
		expect(layered.models?.[0]?.baseUrl).toBeUndefined();
		expect(layered.models?.[1]?.api).toBeUndefined();
	});

	it("gives each model its own value when they disagree, so nothing it uses changes", () => {
		const layered = toLayeredEntry({
			baseUrl: "https://a/v1",
			api: "openai-completions",
			models: [{ id: "x" }, { id: "y", baseUrl: "https://a", api: "anthropic-messages" }],
		});
		expect(layered.baseUrl).toBeUndefined();
		expect(layered.api).toBeUndefined();
		expect(effective(layered)).toEqual([
			["x", "https://a/v1", "openai-completions"],
			["y", "https://a", "anthropic-messages"],
		]);
	});

	it("writes down what the old rule borrowed from the first model", () => {
		const layered = toLayeredEntry({
			models: [{ id: "x", baseUrl: "https://a/v1", api: "openai-completions" }, { id: "y" }],
		});
		expect(effective(layered)).toEqual([
			["x", "https://a/v1", "openai-completions"],
			["y", "https://a/v1", "openai-completions"],
		]);
	});

	it("does nothing to an entry that is already layered", () => {
		const entry = { layered: true, models: [{ id: "x" }] };
		expect(toLayeredEntry(entry)).toBe(entry);
	});

	it("carries a group's values into an entry that leaves it", () => {
		const left = withGroupValues(
			{ layered: true, baseUrl: "https://own/v1", models: [{ id: "x" }] },
			{
				baseUrl: "https://top/v1",
				api: "anthropic-messages",
			},
		);
		expect(left).toMatchObject({ baseUrl: "https://top/v1", api: "anthropic-messages" });
	});
});

describe("recognizing one service", () => {
	const candidate = (id: string, url: string, extra: Partial<MergeCandidate> = {}): MergeCandidate => ({
		id,
		name: id,
		baseUrls: [url],
		keyTokens: [],
		...extra,
	});

	it("goes by the address, whatever the entries are called, and starts those ticked", () => {
		const [suggestion, ...others] = suggestProviderMerges([
			candidate("pro", "https://api.relay.example/v1"),
			candidate("plus", "https://api.relay.example/v1"),
			candidate("anthropic-side", "https://api.relay.example"),
			candidate("alone", "https://alone.example/v1"),
		]);
		expect(others).toEqual([]);
		expect(suggestion?.members.map((member) => [member.id, member.sure])).toEqual([
			["pro", true],
			["plus", true],
			["anthropic-side", true],
		]);
		expect(suggestion?.name).toBe("relay");
	});

	it("only offers another host of the same main domain or the same key, unticked", () => {
		const [domain] = suggestProviderMerges([
			candidate("a", "https://api.relay.example/v1"),
			candidate("b", "https://api.relay.example/v1"),
			candidate("c", "https://cdn.relay.example/v1"),
		]);
		expect(domain?.members.find((member) => member.id === "c")?.sure).toBe(false);

		const [key] = suggestProviderMerges([
			candidate("a", "https://one.example/v1", { keyTokens: ["same"] }),
			candidate("b", "https://two.example/v1", { keyTokens: ["same"] }),
		]);
		expect(key?.members.map((member) => member.sure)).toEqual([false, false]);
	});

	it("does not offer entries that only share a hosting platform, an IP or nothing", () => {
		expect(
			suggestProviderMerges([
				candidate("a", "https://one.workers.dev/v1"),
				candidate("b", "https://two.workers.dev/v1"),
				candidate("c", "http://127.0.0.1:8000/v1"),
				candidate("d", "http://127.0.0.2:8000/v1"),
				candidate("e", "https://else.example/v1"),
			]),
		).toEqual([]);
	});

	it("reads second-level endings as part of the main domain", () => {
		expect(
			suggestProviderMerges([
				candidate("a", "https://a.example.com.cn/v1"),
				candidate("b", "https://b.other.com.cn/v1"),
			]),
		).toEqual([]);
	});

	it("offers an entry to the group that already has its address, and leaves the group's own keys out", () => {
		const [suggestion] = suggestProviderMerges([
			candidate("in-group", "https://api.relay.example/v1", { groupId: "relay" }),
			candidate("new", "https://api.relay.example"),
		]);
		expect(suggestion?.groupId).toBe("relay");
		expect(suggestion?.members.map((member) => member.id)).toEqual(["new"]);
	});

	it("leaves a cluster spanning two groups to the user", () => {
		expect(
			suggestProviderMerges([
				candidate("a", "https://api.relay.example/v1", { groupId: "one" }),
				candidate("b", "https://api.relay.example/v1", { groupId: "two" }),
			]),
		).toEqual([]);
	});

	it("keeps the suggestion's key the same while the same entries are suggested", () => {
		const entries = [candidate("b", "https://api.relay.example/v1"), candidate("a", "https://api.relay.example/v1")];
		expect(suggestProviderMerges(entries)[0]?.key).toBe(suggestProviderMerges([...entries].reverse())[0]?.key);
	});

	it("makes a usable, unique ID for a group", () => {
		expect(newGroupId("Relay One", new Set())).toBe("relay-one");
		expect(newGroupId("Relay One", new Set(["relay-one"]))).toBe("relay-one-2");
		expect(newGroupId("中转站", new Set())).toBe("provider");
	});
});

describe("old configurations keep working", () => {
	it("keeps every model's address, format, key and headers through saving, merging and leaving", async () => {
		const { runtime, manager, modelsPath } = await runtimeFor(RELAYS);
		await runtime.setLayerApiKeys(Object.keys(RELAYS.providers).map((id) => [id, `key-of-${id}`] as const));
		const before = await whatModelsUse(runtime);
		expect(Object.keys(before)).toHaveLength(8);
		expect(before["plus/gpt-a"]).toMatchObject({
			baseUrl: "https://api.relay-one.example/v1",
			api: "openai-completions",
			key: "key-of-plus",
		});

		// What saving from the page writes.
		for (const { id, config } of await manager.list()) await manager.upsert(id, toLayeredEntry(config), id);
		await runtime.reloadConfig();
		expect(await whatModelsUse(runtime)).toEqual(before);

		const untouched = readFileSync(modelsPath, "utf8");
		const change = await manager.mergeProviders({ ids: ["sudocode", "plus", "claude"], name: "Relay One" });
		expect(change).toEqual({ groupId: "relay-one", moved: [], emptied: [] });
		expect(readFileSync(`${modelsPath}.before-merge.bak`, "utf8")).toBe(untouched);
		await runtime.reloadConfig();
		expect(runtime.getError()).toBeUndefined();
		expect(await whatModelsUse(runtime)).toEqual(before);
		// The provider IDs did not change, so settings and old chats that point at them still resolve.
		expect(runtime.getModel("plus", "gpt-b")).toBeDefined();
		expect((await manager.get("plus"))?.group).toBe("relay-one");

		await manager.leaveGroup("plus");
		await runtime.reloadConfig();
		expect(await whatModelsUse(runtime)).toEqual(before);
		expect((await manager.get("plus"))?.group).toBeUndefined();
	});

	it("keeps entries that mix formats on their models the same as well", async () => {
		const document = {
			providers: {
				mixed: {
					baseUrl: "https://relay.example/v1",
					api: "openai-completions",
					models: [{ id: "chat" }, { id: "claude", baseUrl: "https://relay.example", api: "anthropic-messages" }],
				},
				borrowed: {
					models: [
						{ id: "first", baseUrl: "https://other.example/v1", api: "openai-responses" },
						{ id: "second" },
					],
				},
			},
		};
		const { runtime, manager } = await runtimeFor(document);
		await runtime.setLayerApiKeys([
			["mixed", "key-mixed"],
			["borrowed", "key-borrowed"],
		]);
		const before = await whatModelsUse(runtime);
		expect(before["borrowed/second"]).toMatchObject({ baseUrl: "https://other.example/v1", api: "openai-responses" });
		for (const { id, config } of await manager.list()) await manager.upsert(id, toLayeredEntry(config), id);
		await runtime.reloadConfig();
		expect(await whatModelsUse(runtime)).toEqual(before);
	});

	it("does not touch models.json by reading or by running", async () => {
		const { runtime, modelsPath } = await runtimeFor(RELAYS);
		const content = readFileSync(modelsPath, "utf8");
		await runtime.reloadConfig();
		await whatModelsUse(runtime);
		expect(readFileSync(modelsPath, "utf8")).toBe(content);
		expect(existsSync(`${modelsPath}.before-merge.bak`)).toBe(false);
	});
});

describe("which key a request uses", () => {
	const layered = {
		providerGroups: { relay: { name: "Relay" } },
		providers: {
			one: {
				layered: true,
				group: "relay",
				name: "one",
				baseUrl: "https://relay.example/v1",
				api: "openai-completions",
				models: [{ id: "a" }, { id: "b" }],
			},
		},
	};

	const keyOf = async (runtime: ModelRuntime, modelId: string) => {
		const model = runtime.getModel("one", modelId);
		if (!model) throw new Error(`model ${modelId} is not offered`);
		return (await runtime.getAuth(model))?.auth.apiKey;
	};

	it("goes from the top down: provider, then key, then model", async () => {
		const { runtime } = await runtimeFor(layered);
		await runtime.setLayerApiKeys([[modelCredentialId("one", "a"), "model-key"]]);
		expect(await keyOf(runtime, "a")).toBe("model-key");

		await runtime.setLayerApiKeys([["one", "entry-key"]]);
		expect(await keyOf(runtime, "a")).toBe("entry-key");
		expect(await keyOf(runtime, "b")).toBe("entry-key");

		await runtime.setLayerApiKeys([[groupCredentialId("relay"), "group-key"]]);
		expect(await keyOf(runtime, "a")).toBe("group-key");
		expect(await keyOf(runtime, "b")).toBe("group-key");

		// Taking the upper key away brings the one below back: it was never deleted.
		await runtime.setLayerApiKeys([[groupCredentialId("relay"), undefined]]);
		expect(await keyOf(runtime, "a")).toBe("entry-key");
		await runtime.setLayerApiKeys([["one", undefined]]);
		expect(await keyOf(runtime, "a")).toBe("model-key");
	});

	it("offers only the models that have a key when the layers above have none", async () => {
		const { runtime } = await runtimeFor(layered);
		expect(await runtime.getAvailable()).toEqual([]);
		await runtime.setLayerApiKeys([[modelCredentialId("one", "a"), "model-key"]]);
		expect((await runtime.getAvailable()).map((model) => model.id)).toEqual(["a"]);
		expect(runtime.getProviderAuthStatus("one")).toMatchObject({ configured: true, source: "stored" });
		await runtime.setLayerApiKeys([["one", "entry-key"]]);
		expect((await runtime.getAvailable()).map((model) => model.id)).toEqual(["a", "b"]);
	});

	it("lets the key on top win over a key written in models.json", async () => {
		const { runtime } = await runtimeFor({
			providerGroups: { relay: { name: "Relay" } },
			providers: {
				one: {
					layered: true,
					group: "relay",
					authMode: "config",
					apiKey: "written-in-file",
					baseUrl: "https://relay.example/v1",
					api: "openai-completions",
					models: [{ id: "a" }],
				},
			},
		});
		expect(await keyOf(runtime, "a")).toBe("written-in-file");
		await runtime.setLayerApiKeys([[groupCredentialId("relay"), "group-key"]]);
		expect(await keyOf(runtime, "a")).toBe("group-key");
	});

	it("still lets a key written in models.json win over a stored key without the layer on top", async () => {
		const { runtime } = await runtimeFor({
			providers: {
				old: {
					authMode: "config",
					apiKey: "written-in-file",
					baseUrl: "https://relay.example/v1",
					api: "openai-completions",
					models: [{ id: "a" }],
				},
			},
		});
		await runtime.setLayerApiKeys([["old", "stored-key"]]);
		const model = runtime.getModel("old", "a");
		expect(model && (await runtime.getAuth(model))?.auth.apiKey).toBe("written-in-file");
	});

	it("only shows the last characters of a layer's key and tells equal keys apart by digest", async () => {
		const { runtime } = await runtimeFor(layered);
		await runtime.setLayerApiKeys([
			[groupCredentialId("relay"), "secret-group-1234"],
			["one", "secret-same"],
		]);
		const info = await runtime.getLayerApiKeyInfo(groupCredentialId("relay"));
		expect(info).toEqual({ suffix: "1234" });
		const digests = await runtime.getApiKeyDigests("one");
		expect(digests).toHaveLength(1);
		expect(JSON.stringify(digests)).not.toContain("secret");
	});

	it("follows a model that gets a new ID", async () => {
		const { runtime } = await runtimeFor(layered);
		await runtime.setLayerApiKeys([[modelCredentialId("one", "a"), "model-key"]]);
		await runtime.moveLayerApiKey(modelCredentialId("one", "a"), modelCredentialId("one", "renamed"));
		expect(await runtime.getLayerApiKeyInfo(modelCredentialId("one", "a"))).toBeUndefined();
		expect(await runtime.getLayerApiKeyInfo(modelCredentialId("one", "renamed"))).toEqual({ suffix: "-key" });
	});

	it("keeps a group's key working for an entry that leaves it", async () => {
		const { runtime, manager } = await runtimeFor(layered);
		await runtime.setLayerApiKeys([[groupCredentialId("relay"), "group-key"]]);
		const change = await manager.leaveGroup("one");
		expect(change).toEqual({ groupId: "relay", moved: [{ id: "one", fromGroup: "relay" }], emptied: ["relay"] });
		await runtime.reloadConfig();
		await runtime.adoptLayerApiKey(groupCredentialId("relay"), "one");
		await runtime.setLayerApiKeys([[groupCredentialId("relay"), undefined]]);
		expect(await keyOf(runtime, "a")).toBe("group-key");
	});
});

describe("what a model without a value does", () => {
	it("is not offered while no layer sets its address or format, and appears once one does", async () => {
		const { runtime, manager } = await runtimeFor({
			providerGroups: { relay: { name: "Relay" } },
			providers: {
				one: {
					layered: true,
					group: "relay",
					baseUrl: "https://relay.example/v1",
					models: [{ id: "no-format" }, { id: "own-format", api: "anthropic-messages" }],
				},
				two: { layered: true, group: "relay", api: "openai-completions", models: [{ id: "no-address" }] },
			},
		});
		expect(runtime.getModels().map((model) => model.id)).toEqual(["own-format"]);

		await manager.updateGroup("relay", {
			name: "Relay",
			api: "openai-completions",
			baseUrl: "https://top.example/v1",
		});
		await runtime.reloadConfig();
		const offered = runtime.getModels().map((model) => [model.id, model.baseUrl, model.api]);
		expect(offered).toEqual([
			["no-format", "https://top.example/v1", "openai-completions"],
			["own-format", "https://top.example/v1", "openai-completions"],
			["no-address", "https://top.example/v1", "openai-completions"],
		]);

		// The layer above cleared: each is back to what it set itself, and nothing was deleted.
		await manager.updateGroup("relay", { name: "Relay" });
		await runtime.reloadConfig();
		expect(runtime.getModels().map((model) => [model.id, model.baseUrl, model.api])).toEqual([
			["own-format", "https://relay.example/v1", "anthropic-messages"],
		]);
	});
});

describe("merging and leaving", () => {
	it("gives a standalone entry a group named after it, without changing what it uses", async () => {
		const { manager, runtime } = await runtimeFor(RELAYS);
		await runtime.setLayerApiKeys([["alone", "alone-key"]]);
		const before = await whatModelsUse(runtime);
		const groupId = await manager.ensureGroupFor("alone");
		expect(groupId).toBe("alone");
		expect((await manager.listGroups())[groupId]).toEqual({ name: "alone" });
		expect(await manager.ensureGroupFor("alone")).toBe(groupId);
		await runtime.reloadConfig();
		expect(await whatModelsUse(runtime)).toEqual(before);
		expect(runtime.getProvider("alone")?.name).toBe("alone");
	});

	it("moves an entry from one group to another with what it used, and drops the emptied group", async () => {
		const { manager, runtime } = await runtimeFor(RELAYS);
		const first = await manager.mergeProviders({ ids: ["sudocode", "plus"], name: "One" });
		await manager.updateGroup(first.groupId, { name: "One", baseUrl: "https://top.example/v1" });
		await runtime.setLayerApiKeys([[groupCredentialId(first.groupId), "group-key"]]);
		await runtime.reloadConfig();
		const before = await whatModelsUse(runtime);

		const second = await manager.mergeProviders({ ids: ["alone"], name: "Two" });
		const change = await manager.mergeProviders({ ids: ["sudocode", "plus"], groupId: second.groupId });
		expect(change.moved).toEqual([
			{ id: "sudocode", fromGroup: first.groupId },
			{ id: "plus", fromGroup: first.groupId },
		]);
		expect(change.emptied).toEqual([first.groupId]);
		for (const { id, fromGroup } of change.moved) await runtime.adoptLayerApiKey(groupCredentialId(fromGroup), id);
		await runtime.setLayerApiKeys([[groupCredentialId(first.groupId), undefined]]);
		await runtime.reloadConfig();
		expect(await whatModelsUse(runtime)).toEqual(before);
		expect(Object.keys(await manager.listGroups())).toEqual([second.groupId]);
	});

	it("refuses a group or entry that does not exist", async () => {
		const { manager } = await runtimeFor(RELAYS);
		await expect(manager.mergeProviders({ ids: ["nope"], name: "X" })).rejects.toThrow("nope");
		await expect(manager.mergeProviders({ ids: ["alone"], groupId: "nope" })).rejects.toThrow("nope");
		await expect(manager.updateGroup("nope", {})).rejects.toThrow("nope");
	});

	it("removes a deleted entry's secrets from the merge backup too", async () => {
		const { manager, modelsPath } = await runtimeFor({
			providers: {
				secret: {
					baseUrl: "https://a.example/v1",
					api: "openai-completions",
					apiKey: "literal-secret",
					models: [],
				},
				other: { baseUrl: "https://a.example/v1", api: "openai-completions", models: [] },
			},
		});
		await manager.mergeProviders({ ids: ["secret", "other"], name: "Both" });
		expect(readFileSync(`${modelsPath}.before-merge.bak`, "utf8")).toContain("literal-secret");
		await manager.delete("secret");
		expect(readFileSync(`${modelsPath}.before-merge.bak`, "utf8")).not.toContain("literal-secret");
	});
});

describe("a real request", () => {
	beforeAll(() => configureHttpDispatcher());

	async function recordingServer() {
		const requests: Array<{ url: string; authorization?: string; apiKey?: string }> = [];
		const server = createServer((request, response) => {
			requests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				apiKey: request.headers["x-api-key"] as string | undefined,
			});
			request.resume();
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "stop here", type: "invalid_request_error" } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
		return { requests, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
	}

	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

	it("goes to the address, in the format and with the key the layers say", async () => {
		const { requests, base } = await recordingServer();
		// A rejected request may be sent once more by the provider's own fallback: only what was sent matters here.
		const sent = () => [...new Map(requests.map((request) => [JSON.stringify(request), request])).values()];
		const { runtime } = await runtimeFor({
			providerGroups: { relay: { name: "Relay" } },
			providers: {
				chat: {
					layered: true,
					group: "relay",
					baseUrl: `${base}/openai/v1`,
					api: "openai-completions",
					models: [{ id: "gpt-a", contextWindow: 8192, maxTokens: 1024 }],
				},
				claude: {
					layered: true,
					group: "relay",
					baseUrl: `${base}/anthropic`,
					api: "anthropic-messages",
					models: [{ id: "claude-a", contextWindow: 8192, maxTokens: 1024 }],
				},
				mixed: {
					layered: true,
					group: "relay",
					models: [
						{
							id: "own",
							baseUrl: `${base}/own/v1`,
							api: "openai-responses",
							contextWindow: 8192,
							maxTokens: 1024,
						},
					],
				},
			},
		});
		await runtime.setLayerApiKeys([
			["chat", "chat-key"],
			["claude", "claude-key"],
			[modelCredentialId("mixed", "own"), "own-key"],
		]);
		for (const [provider, id] of [
			["chat", "gpt-a"],
			["claude", "claude-a"],
			["mixed", "own"],
		] as const) {
			const model = runtime.getModel(provider, id);
			if (!model) throw new Error(`${provider}/${id} is not offered`);
			await runtime.completeSimple(model, context, { maxRetries: 0 });
		}
		expect(sent()).toEqual([
			{ url: "/openai/v1/chat/completions", authorization: "Bearer chat-key", apiKey: undefined },
			expect.objectContaining({ url: "/anthropic/v1/messages", apiKey: "claude-key" }),
			{ url: "/own/v1/responses", authorization: "Bearer own-key", apiKey: undefined },
		]);

		// A global key and address now apply to all of them; each keeps its own format.
		requests.length = 0;
		await runtime.setLayerApiKeys([[groupCredentialId("relay"), "group-key"]]);
		const chat = runtime.getModel("chat", "gpt-a");
		if (!chat) throw new Error("not offered");
		await runtime.completeSimple(chat, context, { maxRetries: 0 });
		expect(sent()).toEqual([
			{ url: "/openai/v1/chat/completions", authorization: "Bearer group-key", apiKey: undefined },
		]);
	}, 30_000);
});
