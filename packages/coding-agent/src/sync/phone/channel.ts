/**
 * The computer's side of the phone channel (`MyHarness/phone-v1/`, see port.ts): while this computer is signed in
 * with Google it
 *
 * - says it is on (`pcs/<deviceId>.json`, every minute), so a phone lists it among the computers it can connect to;
 * - describes its chats, Providers and keys, web search sources, memories, bookmarks and new-tab shortcuts for phones
 *   (`views/`, view.ts) whenever they changed;
 * - applies what phones sent (`outbox/`, importer.ts) and removes each file once it is applied. Of the computers
 *   that are on, the one with the smallest device id does this, so two computers rarely apply the same file; when
 *   they do, the result is the same (importer.ts);
 * - reads the phones of the account (`phones/`) and hands them to the phone link, which then accepts their
 *   connections (modes/web/phone-link/).
 *
 * Nothing here runs a model or a tool, and nothing a phone sent can grant trust or start a command on this computer.
 */

import { gzipSync } from "node:zlib";
import type { SyncRecord } from "../types.ts";
import { applyOutboxFile, isMissingChatError, isWaitError, parseOutboxFile } from "./importer.ts";
import type { PhoneDrivePort } from "./port.ts";
import {
	buildPhoneBookmarks,
	buildPhoneChats,
	buildPhoneMemories,
	buildPhoneSpeedDial,
	type PhoneDialPack,
	type PhoneMemoryPack,
	type PhoneProvider,
	type PhoneSearch,
	type PhoneView,
	rankOf,
} from "./view.ts";

export const PHONE_CHANNEL_VERSION = 1;
const TICK_MS = 10_000;
const PRESENCE_MS = 60_000;
/** A computer that has not said it is on for this long is treated as off. */
export const PRESENCE_FRESH_MS = 3 * 60_000;
const VIEW_MIN_MS = 20_000;
const MEMORIES_MIN_MS = 60_000;
/**
 * How often the list of the account's phones is looked at. One listing per pass; a registration file is downloaded
 * again only when it changed. Short, because a phone that just signed in waits for this computer to know it before
 * its first connection can be answered (the phone waits about 25 seconds for an answer).
 */
const PHONES_MS = 8_000;
/** A view is written while sync still downloads only when the last one is this old. */
const VIEW_STALE_MS = 5 * 60_000;
/**
 * A phone file still waiting for a chat after this long names a chat that will not come (it was removed on another
 * computer): its lines then become a chat of their own rather than holding up the phone's later files.
 */
const ORPHAN_AFTER_MS = 6 * 60 * 60_000;

export interface PcPresence {
	version: 1;
	deviceId: string;
	name: string;
	appVersion: string;
	lastSeenAt: string;
	startedAt: string;
	/** Whether this computer accepts connections from the account's phones (Settings → Phone). */
	accepts: boolean;
	/** The local network address of the phone link, when it listens there. */
	lan: { addresses: string[]; port: number } | null;
}

export interface PhoneRegistration {
	phoneId: string;
	name: string;
	/** base64url, 32 bytes. */
	key: string;
	createdAt: string;
}

export interface PhoneChannelOptions {
	agentDir: string;
	dataRoot: string;
	appVersion: string;
	/** The Drive of the account this computer is signed in with; null while it is not. */
	port: () => PhoneDrivePort | null;
	device: () => { id: string; name: string };
	committed: () => Readonly<Record<string, SyncRecord>>;
	caughtUp: () => boolean;
	providers: () => Promise<PhoneProvider[]>;
	defaults: () => { model: { provider: string; id: string } | null; thinkingLevel: string | null };
	/** The web search sources switched on here and their saved keys; absent, the view says nothing about search. */
	search?: () => PhoneSearch;
	link: () => { accepts: boolean; lan: { addresses: string[]; port: number } | null };
	isSessionActive?: (workspaceId: string, sessionId: string) => boolean;
	onPhones?: (phones: PhoneRegistration[]) => void;
	onImported?: (info: { sessionsChanged: boolean; settingsChanged: boolean }) => void;
	now?: () => number;
}

export interface PhoneChannelStatus {
	running: boolean;
	lastViewAt: string | null;
	lastImportAt: string | null;
	importer: boolean;
	phones: number;
	lastError: string | null;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

/** A phone's registration file (packages/mobile/web/js/account.js), or null when it is not one. */
function parseRegistration(data: Uint8Array): PhoneRegistration | null {
	try {
		const value = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
		if (
			typeof value.phoneId === "string" &&
			/^[A-Za-z0-9_-]{6,64}$/u.test(value.phoneId) &&
			typeof value.key === "string" &&
			/^[A-Za-z0-9_-]{43}$/u.test(value.key)
		) {
			return {
				phoneId: value.phoneId,
				name: typeof value.name === "string" ? value.name.slice(0, 80) : "",
				key: value.key,
				createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
			};
		}
	} catch {
		// A registration that cannot be read is not a phone.
	}
	return null;
}

export class PhoneChannel {
	private readonly options: PhoneChannelOptions;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private ticking: Promise<void> | undefined;
	/** Set while a turn runs when another should follow at once (phonesSoon). */
	private again = false;
	private readonly startedAt: string;
	private lastPresenceAt = 0;
	private lastPresenceText = "";
	private lastViewAt = 0;
	private lastViewText = "";
	private lastMemoriesAt = 0;
	private lastMemoriesText = "";
	private lastDialText = "";
	private lastPhonesAt = 0;
	/** Registration files as last downloaded, by name: their modified time and what they said. */
	private phoneFiles = new Map<string, { modifiedTime: string; phone: PhoneRegistration | null }>();
	private lastImportAt: string | null = null;
	private phones: PhoneRegistration[] = [];
	private lastError: string | null = null;
	private importer = false;
	private spaceReady = false;
	private spacePort: PhoneDrivePort | null = null;

	constructor(options: PhoneChannelOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.startedAt = new Date(this.now()).toISOString();
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.schedule(1500);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.ticking?.catch(() => undefined);
	}

	/** Something a phone shows changed here (a chat, a setting): describe it at the next turn instead of the next minute. */
	poke(): void {
		if (!this.running) return;
		this.schedule(1000);
	}

	/** A phone this PC does not know yet is trying to connect (it signed in a moment ago): read `phones/` at the next turn. */
	phonesSoon(): void {
		if (!this.running || this.now() - this.lastPhonesAt < 2_000) return;
		this.lastPhonesAt = 0;
		// A turn under way may have read them already: the next one then starts right after it.
		if (this.ticking) this.again = true;
		else this.schedule(0);
	}

	status(): PhoneChannelStatus {
		return {
			running: this.running,
			lastViewAt: this.lastViewAt ? new Date(this.lastViewAt).toISOString() : null,
			lastImportAt: this.lastImportAt,
			importer: this.importer,
			phones: this.phones.length,
			lastError: this.lastError,
		};
	}

	/** The phones of the account, as last read from Drive. */
	knownPhones(): PhoneRegistration[] {
		return [...this.phones];
	}

	private schedule(delay: number): void {
		if (!this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.ticking = this.tick().finally(() => {
				this.ticking = undefined;
				const again = this.again;
				this.again = false;
				this.schedule(again ? 0 : TICK_MS);
			});
		}, delay);
		this.timer.unref?.();
	}

	/** One turn: presence, phones, outbox, views. Each part fails on its own; the next turn tries again. */
	async tick(): Promise<void> {
		const port = this.options.port();
		if (!port) {
			this.spaceReady = false;
			return;
		}
		try {
			if (!this.spaceReady || this.spacePort !== port) {
				await port.ensurePhoneSpace();
				this.spaceReady = true;
				this.spacePort = port;
			}
			await this.writePresence(port);
			await this.readPhones(port);
			await this.processOutbox(port);
			await this.writeViews(port);
			this.lastError = null;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async writePresence(port: PhoneDrivePort): Promise<void> {
		const device = this.options.device();
		const link = this.options.link();
		const presence: PcPresence = {
			version: 1,
			deviceId: device.id,
			name: device.name,
			appVersion: this.options.appVersion,
			lastSeenAt: new Date(this.now()).toISOString(),
			startedAt: this.startedAt,
			accepts: link.accepts,
			lan: link.lan,
		};
		const signature = JSON.stringify({ ...presence, lastSeenAt: "" });
		if (signature === this.lastPresenceText && this.now() - this.lastPresenceAt < PRESENCE_MS) return;
		await port.phoneWrite("pcs", `${device.id}.json`, encode(presence));
		this.lastPresenceAt = this.now();
		this.lastPresenceText = signature;
	}

	private async readPhones(port: PhoneDrivePort): Promise<void> {
		if (this.now() - this.lastPhonesAt < PHONES_MS && this.lastPhonesAt) return;
		this.lastPhonesAt = this.now();
		const files = await port.phoneList("phones");
		const phones: PhoneRegistration[] = [];
		const seen = new Map<string, { modifiedTime: string; phone: PhoneRegistration | null }>();
		for (const file of files) {
			if (!file.name.endsWith(".json")) continue;
			const version = `${file.modifiedTime ?? ""}|${file.size ?? ""}`;
			let known = this.phoneFiles.get(file.name);
			if (!known || known.modifiedTime !== version) {
				const data = await port.phoneRead("phones", file.name);
				if (!data) continue;
				known = { modifiedTime: version, phone: parseRegistration(data) };
			}
			seen.set(file.name, known);
			if (known.phone) phones.push(known.phone);
		}
		this.phoneFiles = seen;
		this.phones = phones;
		this.options.onPhones?.(phones);
	}

	/** Whether this computer is the one that applies phones' changes now: the smallest id of the computers that are on. */
	private async isImporter(port: PhoneDrivePort): Promise<boolean> {
		const me = this.options.device().id;
		const files = await port.phoneList("pcs");
		const fresh = files
			.filter((file) => file.name.endsWith(".json"))
			.filter((file) => {
				const at = Date.parse(file.modifiedTime ?? file.createdTime ?? "");
				return Number.isFinite(at) && this.now() - at < PRESENCE_FRESH_MS;
			})
			.map((file) => file.name.slice(0, -5));
		if (!fresh.includes(me)) fresh.push(me);
		return fresh.sort()[0] === me;
	}

	private async processOutbox(port: PhoneDrivePort): Promise<void> {
		const files = (await port.phoneList("outbox")).filter((file) => file.name.endsWith(".json"));
		if (files.length === 0) {
			this.importer = await this.isImporter(port).catch(() => false);
			return;
		}
		this.importer = await this.isImporter(port);
		if (!this.importer) return;
		// One phone's files in the order it wrote them; a phone whose file has to wait holds its later files too.
		const waiting = new Set<string>();
		const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
		let sessionsChanged = false;
		let settingsChanged = false;
		for (const file of sorted) {
			// `<phoneId>__<time base 36>__<random>.json` (port.ts).
			const phone = file.name.split("__")[0] ?? "";
			if (waiting.has(phone)) continue;
			const data = await port.phoneRead("outbox", file.name);
			if (!data) continue;
			const parsed = parseOutboxFile(data);
			if (!parsed) {
				await port.phoneDelete("outbox", file.name);
				continue;
			}
			const context = {
				dataRoot: this.options.dataRoot,
				agentDir: this.options.agentDir,
				...(this.options.isSessionActive ? { isSessionActive: this.options.isSessionActive } : {}),
			};
			const age = this.now() - (Date.parse(file.createdTime ?? file.modifiedTime ?? "") || this.now());
			try {
				let result: Awaited<ReturnType<typeof applyOutboxFile>>;
				try {
					result = await applyOutboxFile(context, parsed);
				} catch (error) {
					if (!isMissingChatError(error) || age < ORPHAN_AFTER_MS) throw error;
					result = await applyOutboxFile({ ...context, orphanAsNew: true }, parsed);
				}
				sessionsChanged ||= result.sessionsChanged;
				settingsChanged ||= result.settingsChanged;
				await port.phoneDelete("outbox", file.name);
				this.lastImportAt = new Date(this.now()).toISOString();
			} catch (error) {
				if (!isWaitError(error)) throw error;
				waiting.add(phone);
			}
		}
		if (sessionsChanged || settingsChanged) {
			this.options.onImported?.({ sessionsChanged, settingsChanged });
			// The phone sees its change come back in the view at the next turn.
			this.lastViewText = "";
		}
	}

	private async writeViews(port: PhoneDrivePort): Promise<void> {
		const now = this.now();
		const device = this.options.device();
		const committed = this.options.committed();
		const caughtUp = this.options.caughtUp();
		if (now - this.lastViewAt >= VIEW_MIN_MS && (caughtUp || now - this.lastViewAt >= VIEW_STALE_MS)) {
			const providers = await this.options.providers().catch(() => [] as PhoneProvider[]);
			const defaults = this.options.defaults();
			const view: Omit<PhoneView, "writtenAt"> = {
				version: 1,
				device: { id: device.id, name: device.name, version: this.options.appVersion },
				settings: {
					rank: rankOf(committed, "settings"),
					providers,
					model: defaults.model,
					thinkingLevel: defaults.thinkingLevel,
					...(this.options.search ? { search: this.options.search() } : {}),
				},
				chats: await buildPhoneChats({
					dataRoot: this.options.dataRoot,
					agentDir: this.options.agentDir,
					committed,
				}),
				bookmarks: {
					rank: rankOf(committed, "browser", "browser-bookmarks.json"),
					items: buildPhoneBookmarks(this.options.agentDir),
				},
			};
			const text = JSON.stringify(view);
			if (text !== this.lastViewText) {
				const written: PhoneView = { ...view, writtenAt: new Date(now).toISOString() };
				await port.phoneWrite("views", `${device.id}.json.gz`, gzipSync(Buffer.from(JSON.stringify(written))));
				this.lastViewText = text;
			}
			// The new-tab shortcuts go in a file of their own: with their icons they are far larger than the rest, and a
			// phone downloads a view again whenever a chat changed.
			const dial: Omit<PhoneDialPack, "writtenAt"> = {
				version: 1,
				device,
				rank: rankOf(committed, "browser", "browser-speed-dial.json"),
				items: buildPhoneSpeedDial(this.options.agentDir),
			};
			const dialText = JSON.stringify(dial);
			if (dialText !== this.lastDialText) {
				const written: PhoneDialPack = { ...dial, writtenAt: new Date(now).toISOString() };
				await port.phoneWrite("views", `${device.id}.dial.json.gz`, gzipSync(Buffer.from(JSON.stringify(written))));
				this.lastDialText = dialText;
			}
			this.lastViewAt = now;
		}
		if (now - this.lastMemoriesAt >= MEMORIES_MIN_MS && (caughtUp || now - this.lastMemoriesAt >= VIEW_STALE_MS)) {
			const entries = buildPhoneMemories(this.options.dataRoot);
			const pack: Omit<PhoneMemoryPack, "writtenAt"> = {
				version: 1,
				device,
				rank: rankOf(committed, "memory"),
				entries,
			};
			const text = JSON.stringify(pack);
			if (text !== this.lastMemoriesText) {
				const written: PhoneMemoryPack = { ...pack, writtenAt: new Date(now).toISOString() };
				await port.phoneWrite(
					"views",
					`${device.id}.memories.json.gz`,
					gzipSync(Buffer.from(JSON.stringify(written))),
				);
				this.lastMemoriesText = text;
			}
			this.lastMemoriesAt = now;
		}
	}
}
