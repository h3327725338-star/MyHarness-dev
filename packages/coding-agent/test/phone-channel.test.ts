import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionConversationDir, UNBOUND_WORKSPACE_ID } from "../src/config/paths/index.ts";
import { PhoneChannel, type PhoneRegistration } from "../src/sync/phone/channel.ts";
import { MemoryPhonePort } from "../src/sync/phone/port.ts";
import type { SyncRecord } from "../src/sync/types.ts";

// The phone's own code (packages/mobile/web/js/account-view.js) reads what the PC wrote and writes what the PC reads.
interface PhoneEntry {
	id: string;
	ts: number;
	message: Record<string, unknown>;
}
interface PhoneView {
	settings: { providers: Array<{ id: string; apiKey: string }>; model: unknown };
	chats: Array<{ key: string; hash: string; title: string; origin?: string; rank: number }>;
}
interface AccountView {
	mergeViews(views: unknown[]): PhoneView;
	listPcs(presences: unknown[], now?: number): Array<{ id: string; online: boolean; accepts: boolean }>;
	chatFromJsonl(text: string): { entries: PhoneEntry[]; leaf: string | null; title: string };
	linesForPc(
		entries: PhoneEntry[],
		parent: string | null,
	): { lines: Array<Record<string, unknown>>; leaf: string | null };
}
const phone = (await import("../../mobile/web/js/account-view.js" as string)) as AccountView;

const PC = { id: "6a0c1f7e-0000-4000-8000-0000000000aa", name: "Desk" };
const SESSION = "2026-11-13T00-00-00-000Z_s1";

describe("phone channel on the PC", () => {
	let dataRoot: string;
	let agentDir: string;
	let drive: MemoryPhonePort;
	let committed: Record<string, SyncRecord>;
	let chatFile: string;
	let phones: PhoneRegistration[];
	let imported: Array<{ sessionsChanged: boolean; settingsChanged: boolean }>;
	let clock: number;

	const channel = () =>
		new PhoneChannel({
			agentDir,
			dataRoot,
			appVersion: "0.0.9",
			port: () => drive,
			device: () => PC,
			committed: () => committed,
			caughtUp: () => true,
			providers: async () => [
				{
					id: "zai",
					name: "Z.ai",
					api: "openai-completions",
					baseUrl: "https://api.z.ai/v1",
					apiKey: "test-key-not-real",
					models: [
						{
							id: "glm-5",
							name: "GLM 5",
							reasoning: true,
							vision: false,
							contextWindow: 200000,
							maxTokens: 8192,
						},
					],
				},
			],
			defaults: () => ({ model: { provider: "zai", id: "glm-5" }, thinkingLevel: "medium" }),
			link: () => ({ accepts: true, lan: null }),
			onPhones: (list) => {
				phones = list;
			},
			onImported: (info) => imported.push(info),
			now: () => clock,
		});

	const readGz = (folder: "views", name: string) =>
		JSON.parse(gunzipSync(drive.folders.get(folder)!.get(name)!.data).toString("utf8"));

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "mh-phone-channel-data-"));
		agentDir = mkdtempSync(join(tmpdir(), "mh-phone-channel-agent-"));
		drive = new MemoryPhonePort();
		phones = [];
		imported = [];
		clock = Date.now();
		const dir = getSessionConversationDir(dataRoot, UNBOUND_WORKSPACE_ID, "s1");
		mkdirSync(dir, { recursive: true });
		chatFile = join(dir, `${SESSION}.jsonl`);
		const lines = [
			{
				type: "session",
				version: 3,
				id: "s1",
				mode: "general",
				timestamp: "2026-11-13T00:00:00.000Z",
				cwd: dataRoot,
				workspaceId: UNBOUND_WORKSPACE_ID,
			},
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-13T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-11-13T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "你好！" }],
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{ type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-11-13T00:00:03.000Z", name: "问候" },
		];
		const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		writeFileSync(chatFile, text);
		committed = {
			"session:unbound/s1": {
				key: "session:unbound/s1",
				kind: "session",
				id: "unbound/s1",
				hash: createHash("sha256").update(text).digest("hex"),
				size: text.length,
				vector: { pc: 3 },
				updatedAt: "2026-11-13T00:00:03.000Z",
			},
		};
	});

	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("says it is on and describes its chats and Providers the way the phone reads them", async () => {
		const pc = channel();
		await pc.tick();
		const presence = JSON.parse(Buffer.from(drive.folders.get("pcs")!.get(`${PC.id}.json`)!.data).toString("utf8"));
		expect(phone.listPcs([presence])).toEqual([expect.objectContaining({ id: PC.id, online: true, accepts: true })]);
		const view = phone.mergeViews([readGz("views", `${PC.id}.json.gz`)]);
		expect(view.settings.providers).toEqual([expect.objectContaining({ id: "zai", apiKey: "test-key-not-real" })]);
		expect(view.settings.model).toEqual({ provider: "zai", id: "glm-5" });
		expect(view.chats).toEqual([
			expect.objectContaining({
				key: "session:unbound/s1",
				title: "问候",
				rank: 3,
				hash: committed["session:unbound/s1"]!.hash,
			}),
		]);
		expect(drive.folders.get("views")!.has(`${PC.id}.memories.json.gz`)).toBe(true);
	});

	it("applies what a phone sent: a continued chat, a new chat and a Provider, once each", async () => {
		const pc = channel();
		await pc.tick();
		const view = phone.mergeViews([readGz("views", `${PC.id}.json.gz`)]);
		const parsed = phone.chatFromJsonl(readFileSync(chatFile, "utf8"));
		expect(parsed.entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
		expect(parsed.leaf).toBe("i1");
		expect(parsed.title).toBe("问候");

		// The phone answers in the PC's chat (its first line hangs on the PC's last line) and starts a chat of its own.
		const continued = phone.linesForPc(
			[
				{
					id: "e-p1",
					ts: Date.parse("2026-11-13T01:00:00Z"),
					message: { role: "user", content: [{ type: "text", text: "再见" }], timestamp: 3 },
				},
				{
					id: "e-p2",
					ts: Date.parse("2026-11-13T01:00:05Z"),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "再见！" }],
						stopReason: "stop",
						timestamp: 4,
					},
				},
			],
			parsed.leaf,
		);
		const started = phone.linesForPc(
			[
				{
					id: "e-n1",
					ts: Date.parse("2026-11-13T02:00:00Z"),
					message: { role: "user", content: [{ type: "text", text: "手机上开的" }], timestamp: 5 },
				},
			],
			null,
		);
		const outbox = {
			version: 1,
			phoneId: "phonetest01",
			createdAt: new Date().toISOString(),
			ops: [
				{
					type: "chat.append",
					chatId: "c-1",
					key: view.chats[0]!.key,
					createdAt: "2026-11-13T00:00:00Z",
					entries: continued.lines,
				},
				{ type: "chat.append", chatId: "c-mpj2-7", createdAt: "2026-11-13T02:00:00Z", entries: started.lines },
				{
					type: "provider.save",
					provider: {
						id: "phone-added",
						name: "Phone added",
						api: "openai-completions",
						baseUrl: "https://example.test/v1",
						models: [{ id: "m1", name: "M1" }],
					},
					apiKey: "phone-key-not-real",
				},
			],
		};
		const name = `phonetest01__${Date.now().toString(36)}__ab12.json`;
		await drive.phoneCreate("outbox", name, Buffer.from(JSON.stringify(outbox)));
		await drive.phoneWrite(
			"phones",
			"phonetest01.json",
			Buffer.from(JSON.stringify({ phoneId: "phonetest01", name: "Pixel", key: "A".repeat(43), createdAt: "x" })),
		);
		// Registrations are looked at every few seconds, not on every pass.
		clock += 31_000;
		await pc.tick();

		expect(drive.folders.get("outbox")!.size).toBe(0);
		expect(imported.at(-1)).toEqual({ sessionsChanged: true, settingsChanged: true });
		expect(phones.map((entry) => entry.phoneId)).toEqual(["phonetest01"]);

		const after = phone.chatFromJsonl(readFileSync(chatFile, "utf8"));
		expect(after.entries.map((entry) => entry.id)).toEqual(["u1", "a1", "e-p1", "e-p2"]);
		const newChatDir = getSessionConversationDir(dataRoot, UNBOUND_WORKSPACE_ID, "phone-c-mpj2-7");
		const newChat = readFileSync(join(newChatDir, readdirSync(newChatDir)[0]!), "utf8");
		expect(newChat.split("\n")[0]).toContain('"type":"session"');
		expect(phone.chatFromJsonl(newChat).entries.map((entry) => entry.id)).toEqual(["e-n1"]);
		const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(models.providers["phone-added"]).toMatchObject({
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
		});
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain("phone-key-not-real");

		// The same file a second time (two PCs that both applied it): nothing doubles.
		const before = readFileSync(chatFile, "utf8");
		await drive.phoneCreate(
			"outbox",
			`phonetest01__${(Date.now() + 1).toString(36)}__ab13.json`,
			Buffer.from(JSON.stringify(outbox)),
		);
		await pc.tick();
		expect(readFileSync(chatFile, "utf8")).toBe(before);
		expect(readdirSync(newChatDir)).toHaveLength(1);
		expect(existsSync(join(agentDir, "models.json"))).toBe(true);
	});

	it("knows a phone soon after it signs in, and downloads a registration again only when it changed", async () => {
		const reads: string[] = [];
		const read = drive.phoneRead.bind(drive);
		drive.phoneRead = async (folder, name) => {
			if (folder === "phones") reads.push(name);
			return read(folder, name);
		};
		const pc = channel();
		await pc.tick();
		expect(phones).toEqual([]);
		const register = (key: string) =>
			drive.phoneWrite(
				"phones",
				"phonetest03.json",
				Buffer.from(JSON.stringify({ phoneId: "phonetest03", name: "Pixel", key, createdAt: "x" })),
			);
		await register("B".repeat(43));
		// The next pass after a few seconds, not half a minute later.
		clock += 9_000;
		await pc.tick();
		expect(phones.map((entry) => entry.key)).toEqual(["B".repeat(43)]);
		clock += 9_000;
		await pc.tick();
		expect(reads).toEqual(["phonetest03.json"]);
		// Signed in again: a new key in the same file.
		clock += 1;
		await register("C".repeat(43));
		clock += 9_000;
		await pc.tick();
		expect(phones.map((entry) => entry.key)).toEqual(["C".repeat(43)]);
		expect(reads).toEqual(["phonetest03.json", "phonetest03.json"]);
	});

	it("lets lines for a chat that never arrives wait, then keeps them as a chat of their own", async () => {
		const pc = channel();
		await pc.tick();
		const lines = phone.linesForPc(
			[
				{
					id: "e-o1",
					ts: Date.parse("2026-11-13T03:00:00Z"),
					message: { role: "user", content: [{ type: "text", text: "孤儿" }], timestamp: 6 },
				},
			],
			"gone-leaf",
		);
		const outbox = {
			version: 1,
			phoneId: "phonetest02",
			createdAt: new Date().toISOString(),
			ops: [
				{
					type: "chat.append",
					chatId: "c-orphan-1",
					key: "session:unbound/deleted",
					createdAt: "2026-11-13T03:00:00Z",
					entries: lines.lines,
				},
			],
		};
		await drive.phoneCreate(
			"outbox",
			`phonetest02__${Date.now().toString(36)}__cd34.json`,
			Buffer.from(JSON.stringify(outbox)),
		);
		await pc.tick();
		// Not yet: sync may still bring the chat.
		expect(drive.folders.get("outbox")!.size).toBe(1);
		clock += 7 * 60 * 60_000;
		await pc.tick();
		expect(drive.folders.get("outbox")!.size).toBe(0);
		const dir = getSessionConversationDir(dataRoot, UNBOUND_WORKSPACE_ID, "phone-c-orphan-1");
		const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
		const parsed = phone.chatFromJsonl(text);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(["e-o1"]);
		// Its first line hung on a line this chat does not have: it starts the chat instead.
		expect(text).toContain('"id":"e-o1","parentId":null');
	});
});
