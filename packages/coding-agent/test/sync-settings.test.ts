import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { portableApiKeysOf, withPortableApiKeys } from "../src/providers/credentials/auth-storage.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { mergeSettingsText, readSettingsRecords, writeSettingsRecord } from "../src/sync/settings-data.ts";
import { SyncLocalStore } from "../src/sync/store.ts";
import type { DrivePort, RemoteFile, RemoteFolder, SyncAppliedInfo } from "../src/sync/types.ts";

class FakeDrive implements DrivePort {
	readonly folders = new Map<string, Map<string, Uint8Array>>();
	objectDownloads = 0;

	constructor() {
		for (const name of ["root", "batches", "objects", "snapshots"]) this.folders.set(name, new Map());
	}

	list(folder: RemoteFolder): Promise<RemoteFile[]> {
		const entries = [...(this.folders.get(folder)?.entries() ?? [])].map(([name, data]) => ({
			id: `file-${name}`,
			name,
			size: data.byteLength,
		}));
		return Promise.resolve(entries.sort((a, b) => a.name.localeCompare(b.name)));
	}

	read(folder: RemoteFolder, name: string): Promise<Uint8Array | undefined> {
		return Promise.resolve(this.folders.get(folder)?.get(name));
	}

	write(folder: RemoteFolder, name: string, data: Uint8Array): Promise<RemoteFile> {
		this.folders.get(folder)!.set(name, data);
		return Promise.resolve({ id: `file-${name}`, name, size: data.byteLength });
	}

	uploadObject(hash: string, data: Uint8Array): Promise<void> {
		if (!this.folders.get("objects")!.has(hash)) this.folders.get("objects")!.set(hash, data);
		return Promise.resolve();
	}

	downloadObject(hash: string): Promise<Uint8Array | undefined> {
		this.objectDownloads += 1;
		return this.read("objects", hash);
	}

	ensureSpace(): Promise<{ folderId: string; folderName: string; syncId: string; url: string }> {
		if (!this.folders.get("root")!.has("identity.json")) {
			const identity = { version: 1, syncId: "space-1", createdAt: new Date(0).toISOString() };
			this.folders.get("root")!.set("identity.json", new TextEncoder().encode(JSON.stringify(identity)));
		}
		return Promise.resolve({ folderId: "folder-1", folderName: "MyHarness", syncId: "space-1", url: "u" });
	}
}

interface Device {
	agentDir: string;
	dataRoot: string;
	engine: SyncEngine;
	applied: SyncAppliedInfo[];
}

const roots: string[] = [];
const engines: SyncEngine[] = [];

function device(drive: FakeDrive, name: string): Device {
	const root = mkdtempSync(join(tmpdir(), `myharness-sync-settings-${name}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dataRoot = join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	const store = new SyncLocalStore(agentDir);
	const applied: SyncAppliedInfo[] = [];
	const engine = new SyncEngine({
		agentDir,
		dataRoot,
		deviceId: `device-${name}`,
		deviceName: name,
		store,
		accountKey: "account-1",
		onApplied: (info) => applied.push(info),
	});
	engine.setDrive(drive);
	engines.push(engine);
	return { agentDir, dataRoot, engine, applied };
}

function writeJson(dir: string, file: string, value: unknown, at?: Date): void {
	const path = join(dir, file);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	if (at) utimesSync(path, at, at);
}

function readJson<T = Record<string, any>>(dir: string, file: string): T {
	return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

async function sync(...devices: Device[]): Promise<void> {
	for (const item of devices) await item.engine.runOnce();
}

const provider = (baseUrl: string, models: Array<Record<string, unknown>>) => ({
	baseUrl,
	api: "openai-completions",
	models,
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("configuration records", () => {
	it("merges two versions part by part and lets the chosen side win where both changed the same value", () => {
		const base = JSON.stringify({
			a: 1,
			b: { x: 1, y: 1 },
			list: [
				{ id: "m1", w: 1 },
				{ id: "m2", w: 1 },
			],
		});
		const here = JSON.stringify({
			a: 2,
			b: { x: 1, y: 5 },
			list: [
				{ id: "m1", w: 9 },
				{ id: "m2", w: 1 },
			],
		});
		const there = JSON.stringify({
			a: 3,
			b: { x: 7, y: 1 },
			list: [
				{ id: "m2", w: 1 },
				{ id: "m3", w: 1 },
			],
			c: true,
		});

		const hereWins = JSON.parse(mergeSettingsText(base, here, there, false)!);
		// `a` both changed: this side. `b.x` only there, `b.y` only here. m1 was changed here and removed there: here.
		expect(hereWins).toEqual({
			a: 2,
			b: { x: 7, y: 5 },
			list: [
				{ id: "m1", w: 9 },
				{ id: "m2", w: 1 },
				{ id: "m3", w: 1 },
			],
			c: true,
		});
		const thereWins = JSON.parse(mergeSettingsText(base, here, there, true)!);
		expect(thereWins.a).toBe(3);
		expect(thereWins.list.map((item: { id: string }) => item.id)).toEqual(["m2", "m3"]);

		// Without a common ancestor nothing counts as removed.
		const union = JSON.parse(mergeSettingsText(undefined, JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 }), true)!);
		expect(union).toEqual({ a: 1, b: 2 });
		// Removed there, untouched here, with an ancestor: it goes.
		expect(JSON.parse(mergeSettingsText('{"a":1,"b":2}', '{"a":1,"b":2}', '{"a":1}', false)!)).toEqual({ a: 1 });
		// A result that says what one side says is that side's own text, so nothing is rewritten for a new key order.
		expect(mergeSettingsText(undefined, '{"a":1,"b":2}', '{"b":2,"a":1}', true)).toBe('{"b":2,"a":1}');
		expect(mergeSettingsText(undefined, "not json", "{}", true)).toBeUndefined();
	});

	it("reads saved API keys without sign-ins and writes them back without touching a sign-in", () => {
		const auth = JSON.stringify({
			plain: { type: "api_key", key: "sk-plain-0001" },
			signedIn: { type: "oauth", access: "token-a", refresh: "token-r", expires: 1 },
		});
		const portable = portableApiKeysOf(auth);
		expect(Object.keys(portable)).toEqual(["plain"]);
		expect(portable.plain!.keys).toHaveLength(1);
		expect(portable.plain!.keys[0]!.credential).toEqual({ type: "api_key", key: "sk-plain-0001" });
		expect(JSON.stringify(portable)).not.toContain("token-");
		// Nothing to write when the file already holds these keys.
		expect(withPortableApiKeys(auth, portable)).toBeUndefined();

		const other = JSON.stringify({ signedIn: { type: "oauth", access: "token-b", refresh: "token-s", expires: 2 } });
		const withKeyForSignedIn = {
			...portable,
			signedIn: {
				activeId: "k1",
				keys: [{ id: "k1", label: "Work", credential: { type: "api_key" as const, key: "sk-x" } }],
			},
		};
		const next = JSON.parse(withPortableApiKeys(other, withKeyForSignedIn)!);
		expect(next.plain.type).toBe("api_key");
		expect(next.plain.key).toBe("sk-plain-0001");
		// This computer is signed in to that Provider: it stays signed in, the key is only added to choose from.
		expect(next.signedIn.type).toBe("oauth");
		expect(next.signedIn.access).toBe("token-b");
		// Reading the result gives exactly what was written: nothing bounces between two computers.
		expect(portableApiKeysOf(JSON.stringify(next))).toEqual(withKeyForSignedIn);

		// Every key of a Provider removed: the entry goes, a sign-in stays.
		const cleared = JSON.parse(withPortableApiKeys(JSON.stringify(next), {})!);
		expect(cleared.plain).toBeUndefined();
		expect(cleared.signedIn.type).toBe("oauth");
		expect(portableApiKeysOf(JSON.stringify(cleared))).toEqual({});
	});

	it("publishes only settings that mean the same on every computer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-sync-settings-unit-"));
		roots.push(dir);
		writeJson(dir, "settings.json", {
			defaultModel: "m1",
			subAgent: { enabled: true },
			shellPath: "C:\\tools\\sh.exe",
			npmCommand: ["pnpm"],
			// The proxy travels: a PC that needs one to reach the Providers needs it on every PC of the user.
			network: { proxy: "http://127.0.0.1:1" },
			lastChangelogVersion: "0.0.8",
		});
		const record = readSettingsRecords(dir).find((item) => item.id === "preferences")!;
		expect(JSON.parse(record.text)).toEqual({
			defaultModel: "m1",
			subAgent: { enabled: true },
			network: { proxy: "http://127.0.0.1:1" },
		});

		// A newer version's setting this one does not list is kept and published; a local-only one is never taken.
		const incoming = {
			defaultModel: "m2",
			subAgent: { enabled: true },
			network: { proxy: "http://127.0.0.1:1" },
			futureSetting: { on: true },
			shellPath: "X",
			npmCommand: ["npm"],
		};
		expect(await writeSettingsRecord(dir, "preferences", JSON.stringify(incoming))).toBe(true);
		const written = readJson(dir, "settings.json");
		expect(written.defaultModel).toBe("m2");
		expect(written.futureSetting).toEqual({ on: true });
		expect(written.shellPath).toBe("C:\\tools\\sh.exe");
		expect(written.network).toEqual({ proxy: "http://127.0.0.1:1" });
		expect(written.npmCommand).toEqual(["pnpm"]);
		expect(written.lastChangelogVersion).toBe("0.0.8");
		const again = readSettingsRecords(dir).find((item) => item.id === "preferences")!;
		expect(JSON.parse(again.text)).toEqual({
			defaultModel: "m2",
			subAgent: { enabled: true },
			network: { proxy: "http://127.0.0.1:1" },
			futureSetting: { on: true },
		});
		// The replaced file was copied first.
		expect(readdirSync(join(dir, "sync", "settings-backup")).some((name) => name.endsWith("_settings.json"))).toBe(
			true,
		);
		// The same content again writes nothing.
		expect(await writeSettingsRecord(dir, "preferences", again.text)).toBe(false);
	});
});

describe("model choices and folders as configuration records", () => {
	it("carries each chat mode's model, and keeps the local one where the other computer has none", async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-sync-mode-models-"));
		roots.push(dir);
		writeJson(dir, "chat-mode-state.json", {
			version: 1,
			coding: { lastSessionFile: "C:\\x\\a.jsonl", model: null, drafts: { s1: { text: "draft", attachments: [] } } },
			general: { lastSessionFile: null, model: { provider: "zai", id: "glm-5" }, drafts: {} },
			generalPersonalPrompt: "",
		});
		const record = readSettingsRecords(dir).find((item) => item.id === "mode-models")!;
		// Only the models: the last chat and the drafts are this computer's.
		expect(JSON.parse(record.text)).toEqual({ coding: null, general: { provider: "zai", id: "glm-5" } });

		expect(
			await writeSettingsRecord(
				dir,
				"mode-models",
				JSON.stringify({ coding: { provider: "openrouter", id: "x/y" }, general: null }),
			),
		).toBe(true);
		const state = readJson(dir, "chat-mode-state.json");
		expect(state.coding.model).toEqual({ provider: "openrouter", id: "x/y" });
		expect(state.general.model).toEqual({ provider: "zai", id: "glm-5" });
		expect(state.coding.drafts.s1.text).toBe("draft");
		expect(state.coding.lastSessionFile).toBe("C:\\x\\a.jsonl");
	});

	it("carries the skills folder file by file, without links, dependencies or paths that leave it", async () => {
		const from = mkdtempSync(join(tmpdir(), "myharness-sync-skills-a-"));
		const to = mkdtempSync(join(tmpdir(), "myharness-sync-skills-b-"));
		roots.push(from, to);
		mkdirSync(join(from, "skills", "review", "node_modules", "dep"), { recursive: true });
		writeFileSync(join(from, "skills", "review", "SKILL.md"), "# Review\n");
		writeFileSync(join(from, "skills", "review", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
		writeFileSync(join(from, "skills", "review", "node_modules", "dep", "index.js"), "x");
		writeFileSync(join(from, "skills", "notes.tmp"), "scratch");
		const record = readSettingsRecords(from).find((item) => item.id === "skills")!;
		const value = JSON.parse(record.text);
		expect(Object.keys(value.files).sort()).toEqual(["review/SKILL.md", "review/logo.png"]);
		expect(value.partial).toBeUndefined();

		// A file only the other computer has is removed when the record no longer lists it (after a backup)…
		mkdirSync(join(to, "skills", "old"), { recursive: true });
		writeFileSync(join(to, "skills", "old", "SKILL.md"), "# Old\n");
		expect(await writeSettingsRecord(to, "skills", record.text)).toBe(true);
		expect(readFileSync(join(to, "skills", "review", "SKILL.md"), "utf8")).toBe("# Review\n");
		expect([...readFileSync(join(to, "skills", "review", "logo.png"))]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255,
		]);
		expect(existsSync(join(to, "skills", "old", "SKILL.md"))).toBe(false);
		expect(existsSync(join(to, "sync", "settings-backup", "skills"))).toBe(true);

		// …but never from a record that says it is only part of the folder, and never outside the folder.
		writeFileSync(join(to, "skills", "keep.md"), "keep");
		const partial = JSON.stringify({
			files: { "../escape.md": "no", "C:/abs.md": "no", "new.md": "yes" },
			partial: true,
		});
		await writeSettingsRecord(to, "skills", partial);
		expect(readFileSync(join(to, "skills", "keep.md"), "utf8")).toBe("keep");
		expect(readFileSync(join(to, "skills", "new.md"), "utf8")).toBe("yes");
		expect(existsSync(join(to, "escape.md"))).toBe(false);
	});
});

describe("configuration sync between two computers", () => {
	it("brings Providers, keys, settings, model prompts and search keys to a computer that joins", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop");
		writeJson(a.agentDir, "models.json", {
			providers: { relay: provider("https://relay.example/v1", [{ id: "small", contextWindow: 100000 }]) },
		});
		writeJson(a.agentDir, "auth.json", {
			relay: { type: "api_key", key: "sk-relay-1111" },
			chat: { type: "oauth", access: "desktop-token", refresh: "desktop-refresh", expires: 5 },
		});
		writeJson(a.agentDir, "settings.json", {
			defaultProvider: "relay",
			defaultModel: "small",
			autoMemory: { model: "relay/small" },
			shellPath: "C:\\desktop\\sh.exe",
		});
		writeJson(a.agentDir, "model-prompts.json", { version: 1, prompts: { relay: { small: "Answer briefly." } } });
		writeJson(a.agentDir, "web-search-keys.json", { tavily: [{ id: "k1", label: "Main", key: "tvly-1" }] });
		await sync(a);

		// The laptop is a fresh install with a few values of its own.
		const b = device(drive, "laptop");
		writeJson(b.agentDir, "models.json", {
			providers: { local: provider("http://127.0.0.1:1234/v1", [{ id: "tiny" }]) },
		});
		writeJson(b.agentDir, "auth.json", {});
		writeJson(b.agentDir, "settings.json", { defaultModel: "tiny", theme: "dark", shellPath: "C:\\laptop\\sh.exe" });
		await sync(b);

		const models = readJson(b.agentDir, "models.json");
		expect(Object.keys(models.providers).sort()).toEqual(["local", "relay"]);
		expect(models.providers.relay.models[0].contextWindow).toBe(100000);
		const auth = readJson(b.agentDir, "auth.json");
		expect(auth.relay.key).toBe("sk-relay-1111");
		// A sign-in belongs to the computer it was made on.
		expect(auth.chat).toBeUndefined();
		expect(
			JSON.stringify([...drive.folders.get("batches")!.values()].map((data) => Buffer.from(data).toString("utf8"))),
		).not.toContain("desktop-token");
		const settings = readJson(b.agentDir, "settings.json");
		// Where both differ, a computer that joins takes what is on Drive; its own machine settings stay.
		expect(settings.defaultModel).toBe("small");
		expect(settings.defaultProvider).toBe("relay");
		expect(settings.autoMemory).toEqual({ model: "relay/small" });
		expect(settings.shellPath).toBe("C:\\laptop\\sh.exe");
		expect(settings.theme).toBe("dark");
		expect(readJson(b.agentDir, "model-prompts.json").prompts.relay.small).toBe("Answer briefly.");
		expect(readJson(b.agentDir, "web-search-keys.json").tavily[0].key).toBe("tvly-1");
		expect(b.applied.some((info) => info.settingsChanged)).toBe(true);
		expect(b.engine.status().conflicts).toHaveLength(0);

		// What only the laptop had goes back to the desktop, and then both rest.
		await sync(a, b, a);
		expect(Object.keys(readJson(a.agentDir, "models.json").providers).sort()).toEqual(["local", "relay"]);
		expect(readJson(a.agentDir, "settings.json").shellPath).toBe("C:\\desktop\\sh.exe");
		expect(readJson(a.agentDir, "auth.json").chat.access).toBe("desktop-token");
		const batches = drive.folders.get("batches")!.size;
		await sync(a, b, a, b);
		expect(drive.folders.get("batches")!.size).toBe(batches);
	});

	it("keeps both when two computers change different settings and takes the later change of the same one", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop");
		const b = device(drive, "laptop");
		writeJson(a.agentDir, "settings.json", {
			defaultModel: "m1",
			subAgent: { model: "x/one" },
			retry: { enabled: true },
		});
		await sync(a, b);
		expect(readJson(b.agentDir, "settings.json").defaultModel).toBe("m1");

		const earlier = new Date(Date.now() - 60_000);
		const later = new Date(Date.now() - 5_000);
		writeJson(
			a.agentDir,
			"settings.json",
			{ defaultModel: "desktop-choice", subAgent: { model: "x/two" }, retry: { enabled: true } },
			earlier,
		);
		writeJson(
			b.agentDir,
			"settings.json",
			{ defaultModel: "laptop-choice", subAgent: { model: "x/one" }, retry: { enabled: false } },
			later,
		);
		await sync(a, b, a, b);

		for (const item of [a, b]) {
			const settings = readJson(item.agentDir, "settings.json");
			// Both changed the default model: the laptop's change was the later one.
			expect(settings.defaultModel).toBe("laptop-choice");
			// Only the desktop changed the sub-agent model, only the laptop changed retry: both changes stay.
			expect(settings.subAgent).toEqual({ model: "x/two" });
			expect(settings.retry).toEqual({ enabled: false });
			expect(item.engine.status().conflicts).toHaveLength(0);
		}
	});

	it("removes a Provider everywhere when it is deleted on one computer, but not when a file goes missing", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop");
		const b = device(drive, "laptop");
		writeJson(a.agentDir, "models.json", {
			providers: {
				one: provider("https://one.example/v1", [{ id: "m" }]),
				two: provider("https://two.example/v1", [{ id: "m" }]),
			},
		});
		writeJson(a.agentDir, "auth.json", {
			one: { type: "api_key", key: "sk-one" },
			two: { type: "api_key", key: "sk-two" },
		});
		await sync(a, b);
		expect(Object.keys(readJson(b.agentDir, "models.json").providers).sort()).toEqual(["one", "two"]);

		writeJson(b.agentDir, "models.json", { providers: { one: provider("https://one.example/v1", [{ id: "m" }]) } });
		writeJson(b.agentDir, "auth.json", { one: { type: "api_key", key: "sk-one" } });
		await sync(b, a);
		expect(Object.keys(readJson(a.agentDir, "models.json").providers)).toEqual(["one"]);
		expect(readJson(a.agentDir, "auth.json").two).toBeUndefined();
		// What was replaced is kept as a copy.
		expect(
			readdirSync(join(a.agentDir, "sync", "settings-backup")).some((name) => name.endsWith("_models.json")),
		).toBe(true);

		// A file that disappears is not a decision to delete everything.
		rmSync(join(b.agentDir, "models.json"));
		await sync(b, a, b);
		expect(Object.keys(readJson(a.agentDir, "models.json").providers)).toEqual(["one"]);
		// The next change on the other computer brings the file back.
		writeJson(a.agentDir, "models.json", {
			providers: { one: provider("https://one.example/v1", [{ id: "m" }, { id: "m2" }]) },
		});
		await sync(a, b);
		expect(existsSync(join(b.agentDir, "models.json"))).toBe(true);
		expect(readJson(b.agentDir, "models.json").providers.one.models).toHaveLength(2);
	});
});

describe("small contents travel inside the batch", () => {
	it("does not download a small record one by one", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "desktop");
		const b = device(drive, "laptop");
		mkdirSync(join(a.dataRoot, "memory"), { recursive: true });
		for (let index = 0; index < 30; index += 1) {
			writeFileSync(
				join(a.dataRoot, "memory", `fact-${index}.md`),
				`---\nid: global/fact-${index}\nname: Fact ${index}\ndescription: shared\ntype: user\nscope: global\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nbody ${index}\n`,
			);
		}
		await sync(a);
		// The objects are still uploaded, for versions that do not read the batch's own contents.
		expect(drive.folders.get("objects")!.size).toBeGreaterThanOrEqual(30);
		await sync(b);
		expect(readdirSync(join(b.dataRoot, "memory")).filter((name) => name.startsWith("fact-"))).toHaveLength(30);
		expect(drive.objectDownloads).toBe(0);
	});
});
