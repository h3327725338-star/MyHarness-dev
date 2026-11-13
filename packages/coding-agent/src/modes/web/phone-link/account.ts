/**
 * Phones signed in with this PC's Google account.
 *
 * This file connects two services to the Web UI server: the phone channel (sync/phone/channel.ts: this PC says it is
 * on, describes its chats, Providers, memories and bookmarks for phones, and applies what phones send) and the remote
 * link (remote.ts: connections from any network). Both run only while Google Drive sync is connected, and both stop
 * with the server.
 *
 * What a phone gets of this PC's Providers is decided here: only Providers a phone can call itself (the four protocols
 * of PHONE_APIS), and only with a key saved in MyHarness (auth.json or models.json). A key that comes from an
 * environment variable, a command, or a subscription login (OAuth) never leaves this PC.
 */

import { hostname } from "node:os";
import type { Model as AnyModel, Api } from "@myharness/ai/compat";

type Model = AnyModel<Api>;

import type { ModelRuntime } from "../../../providers/runtime/provider-runtime.ts";
import { ModeStateStore } from "../../../session/mode-state.ts";
import { PhoneChannel, type PhoneRegistration } from "../../../sync/phone/channel.ts";
import { PHONE_APIS, type PhoneModel, type PhoneProvider } from "../../../sync/phone/view.ts";
import type { SyncService } from "../../../sync/service.ts";
import type { PhoneLinkGateway } from "./gateway.ts";
import { PhoneRemoteLink } from "./remote.ts";
import type { PhoneLinkStore } from "./store.ts";

/** Sources of a key that may be given to the account's phones. */
const SHAREABLE_KEY_SOURCES = new Set(["stored", "models_json_key"]);

const stringRecord = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) if (typeof entry === "string") out[name] = entry;
	return Object.keys(out).length ? out : undefined;
};

function phoneModel(model: Model): PhoneModel {
	return {
		id: model.id,
		name: model.name || model.id,
		reasoning: !!model.reasoning,
		vision: (model.input ?? []).includes("image"),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as Record<string, unknown> } : {}),
		...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
	};
}

/** This PC's Providers as a phone can use them: protocol, address, saved key and models. */
export async function phoneProviders(runtime: ModelRuntime): Promise<PhoneProvider[]> {
	runtime.reloadCredentials();
	const available = await runtime.getAvailable();
	const grouped = new Map<string, Model[]>();
	for (const model of available) {
		if (!PHONE_APIS.has(model.api)) continue;
		const list = grouped.get(model.provider) ?? [];
		list.push(model);
		grouped.set(model.provider, list);
	}
	const providers: PhoneProvider[] = [];
	for (const [providerId, models] of grouped) {
		if (runtime.isUsingOAuth(providerId)) continue;
		const status = runtime.getProviderAuthStatus(providerId);
		if (!status.configured || !status.source || !SHAREABLE_KEY_SOURCES.has(status.source)) continue;
		let apiKey = "";
		let baseUrl = "";
		const kept: PhoneModel[] = [];
		for (const model of models) {
			const auth = await runtime.getAuth(model).catch(() => undefined);
			const key = auth?.auth.apiKey;
			if (!key) continue;
			// A model with a key of its own (Provider > key > model layers) is left out rather than given the wrong key.
			if (apiKey && key !== apiKey) continue;
			apiKey = key;
			baseUrl ||= auth.auth.baseUrl || model.baseUrl;
			kept.push(phoneModel(model));
		}
		if (!apiKey || !baseUrl || kept.length === 0) continue;
		const first = models[0]!;
		providers.push({
			id: providerId,
			name: runtime.getProvider(providerId)?.name ?? providerId,
			api: first.api,
			baseUrl,
			...(stringRecord(first.headers) ? { headers: stringRecord(first.headers) } : {}),
			apiKey,
			models: kept,
		});
	}
	return providers.sort((a, b) => a.name.localeCompare(b.name));
}

export interface AccountPhonesOptions {
	agentDir: string;
	dataRoot: string;
	appVersion: string;
	sync: SyncService;
	store: PhoneLinkStore;
	gateway: PhoneLinkGateway;
	runtime: () => ModelRuntime;
	defaults: () => { provider: string | null; model: string | null; thinkingLevel: string | null };
	isSessionActive: (workspaceId: string, sessionId: string) => boolean;
	/** Chats, Providers or settings arrived from a phone. */
	onImported: (info: { sessionsChanged: boolean; settingsChanged: boolean }) => void;
	/** The phones or their connections changed: the settings page reads the status again. */
	onChange: () => void;
}

export class AccountPhones {
	readonly channel: PhoneChannel;
	readonly remote: PhoneRemoteLink;
	private readonly options: AccountPhonesOptions;

	constructor(options: AccountPhonesOptions) {
		this.options = options;
		const { sync, store, gateway } = options;
		const connected = () => sync.phonePort() !== null;
		this.channel = new PhoneChannel({
			agentDir: options.agentDir,
			dataRoot: options.dataRoot,
			appVersion: options.appVersion,
			port: () => sync.phonePort(),
			device: () => {
				const device = sync.device();
				return { id: device.id, name: device.name || hostname() };
			},
			committed: () => sync.committedRecords(),
			caughtUp: () => sync.caughtUp(),
			providers: () => phoneProviders(options.runtime()),
			defaults: () => {
				const chosen = new ModeStateStore(options.agentDir).get("general").model;
				const fallback = options.defaults();
				const model =
					chosen ??
					(fallback.provider && fallback.model ? { provider: fallback.provider, id: fallback.model } : null);
				return { model, thinkingLevel: fallback.thinkingLevel };
			},
			link: () => ({
				accepts: store.remote,
				lan: gateway.listening ? { addresses: gateway.addresses(), port: gateway.port } : null,
			}),
			isSessionActive: options.isSessionActive,
			onPhones: (phones) => this.takePhones(phones),
			onImported: (info) => options.onImported(info),
		});
		this.remote = new PhoneRemoteLink({
			gateway,
			store,
			port: () => sync.phonePort(),
			deviceId: () => (connected() ? sync.device().id : null),
			allowed: connected,
			onChange: options.onChange,
			onUnknownPhone: () => this.channel.phonesSoon(),
			log: (message) => console.warn(message),
		});
	}

	start(): void {
		this.channel.start();
		this.remote.start();
	}

	async stop(): Promise<void> {
		await this.remote.stop();
		await this.channel.stop();
	}

	/** Something phones show changed here, or sync connected: look at Drive soon. */
	poke(): void {
		this.channel.poke();
		this.remote.poke();
	}

	private takePhones(phones: PhoneRegistration[]): void {
		const changed = this.options.store.syncAccountPhones(
			phones.map((phone) => ({ phoneId: phone.phoneId, name: phone.name, key: phone.key })),
		);
		if (changed) {
			this.options.onChange();
			this.remote.poke();
		}
	}

	status() {
		return { channel: this.channel.status(), remote: this.remote.status() };
	}
}
