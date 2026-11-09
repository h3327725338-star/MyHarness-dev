/**
 * Web API routes for Providers: enable/disable, stored API keys, OAuth login
 * and user-defined (models.json) providers. Credentials never leave the
 * server: the browser only receives labels and the last four characters.
 */

import { dirname, join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@myharness/ai";
import { NebiusSetupError, NebiusSetupUseCase } from "../../application/use-cases/nebius-setup.ts";
import { ProviderSettingsUseCase } from "../../application/use-cases/provider-settings.ts";
import {
	DEFAULT_IP_FAMILY,
	DEFAULT_KEEP_ALIVE_SECONDS,
	IP_FAMILIES,
	MAX_KEEP_ALIVE_SECONDS,
	MIN_KEEP_ALIVE_SECONDS,
} from "../../platform/process/http-dispatcher.ts";
import { modelsJsonProviderLacksBaseUrl } from "../../providers/models/composer.ts";
import type { ModelsJsonProvider, ModelsJsonProviderGroup } from "../../providers/models/config.ts";
import {
	CUSTOM_PROVIDER_API_TYPES,
	type CustomProviderApiType,
	CustomProviderManager,
	detectSpecifiedModels,
	ProviderModelDiscoveryError,
} from "../../providers/models/custom-provider-manager.ts";
import {
	groupCredentialId,
	type MergeCandidate,
	modelCredentialId,
	suggestProviderMerges,
	toLayeredEntry,
} from "../../providers/models/layers.ts";
import { NEBIUS_API_KEYS_URL, NEBIUS_CONSOLE_URL, NEBIUS_PROVIDER_ID } from "../../providers/models/nebius-preset.ts";
import { providerSpendLedger } from "../../providers/runtime/provider-spend.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import type { WebHostHub } from "./hub.ts";

/**
 * A key written into models.json (literal or shell command) counts as a credential "Remove credentials" can delete.
 * The literal "local" means "no authentication" and is not a credential.
 */
function hasConfigKey(status: { source?: string }, config: ModelsJsonProvider | undefined): boolean {
	return (
		(status.source === "models_json_key" || status.source === "models_json_command") &&
		typeof config?.apiKey === "string" &&
		config.apiKey !== "local"
	);
}

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function str(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `"${name}" must be a non-empty string`);
	return value;
}

class LoginCancelled extends Error {}

const HIDDEN = "__hidden__";

/** A key typed for a layer: a field holding only spaces is a mistake, not "no key". */
function typedLayerKey(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	if (!value.trim()) throw new HttpError(400, "The API key is empty. Type the key, or leave the field empty.");
	return value.trim();
}

/** What the top layer of a provider sets, as sent by the page; an empty field is left out. */
function groupFields(payload: Record<string, unknown>): ModelsJsonProviderGroup {
	const fields: ModelsJsonProviderGroup = {};
	if (typeof payload.name === "string" && payload.name.trim()) fields.name = payload.name.trim();
	if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) {
		const baseUrl = payload.baseUrl.trim();
		let protocol = "";
		try {
			protocol = new URL(baseUrl).protocol;
		} catch {}
		if (protocol !== "http:" && protocol !== "https:")
			throw new HttpError(400, "The Base URL must be a full http:// or https:// address.");
		fields.baseUrl = baseUrl;
	}
	if (typeof payload.api === "string" && payload.api) {
		if (!(CUSTOM_PROVIDER_API_TYPES as readonly string[]).includes(payload.api))
			throw new HttpError(400, `Unknown API format: ${payload.api}`);
		fields.api = payload.api;
	}
	return fields;
}

/** models.json may hold literal keys: the browser only sees a placeholder for apiKey / model headers. Provider-level custom headers are shown and edited as plain text (user choice: simplest plaintext KV). */
function redactProvider(config: ModelsJsonProvider): ModelsJsonProvider {
	const copy = structuredClone(config);
	if (copy.apiKey) copy.apiKey = HIDDEN;
	for (const model of copy.models ?? [])
		if (model.headers) for (const key of Object.keys(model.headers)) model.headers[key] = HIDDEN;
	return copy;
}

/** Restore hidden placeholders from the stored provider so an edit that did not touch secrets keeps them. */
function restoreSecrets(incoming: ModelsJsonProvider, stored: ModelsJsonProvider | undefined): ModelsJsonProvider {
	const copy = structuredClone(incoming);
	if (copy.apiKey === HIDDEN) {
		if (stored?.apiKey) copy.apiKey = stored.apiKey;
		else delete copy.apiKey;
	}
	if (copy.headers) {
		for (const key of Object.keys(copy.headers)) {
			if (copy.headers[key] !== HIDDEN) continue;
			const previous = stored?.headers?.[key];
			if (previous !== undefined) copy.headers[key] = previous;
			else delete copy.headers[key];
		}
	}
	copy.models?.forEach((model, index) => {
		if (!model.headers) return;
		const previousModel = stored?.models?.find((candidate) => candidate.id === model.id) ?? stored?.models?.[index];
		for (const key of Object.keys(model.headers)) {
			if (model.headers[key] !== HIDDEN) continue;
			const previous = previousModel?.headers?.[key];
			if (previous !== undefined) model.headers[key] = previous;
			else delete model.headers[key];
		}
	});
	return copy;
}

export function registerProviderRoutes(
	server: WebHttpServer,
	host: WebHost,
	hub?: WebHostHub,
	options: { nebiusBaseUrl?: string } = {},
): void {
	const runtime = () => host.session.modelRuntime;
	const manager = () => new CustomProviderManager(runtime().getModelsConfigPath());
	const providerSettings = new ProviderSettingsUseCase({
		getSession: () => host.session,
		getSettingsManager: () => host.session.settingsManager,
	});
	let activeLogin: AbortController | undefined;

	/** Login interaction backed by browser dialogs; secrets are typed into the browser only. */
	const createInteraction = (apiKeyValue?: string): AuthInteraction => {
		const controller = new AbortController();
		activeLogin = controller;
		return {
			signal: controller.signal,
			prompt: async (prompt: AuthPrompt) => {
				if (apiKeyValue !== undefined && (prompt.type === "secret" || prompt.type === "text")) return apiKeyValue;
				if (prompt.type === "select") {
					const labels = prompt.options.map((option) => option.label);
					const answer = await host.dialogs.ask(
						"select",
						{ title: prompt.message, options: labels },
						{ signal: prompt.signal ?? controller.signal },
					);
					const chosen = prompt.options.find((option) => option.label === answer);
					if (!chosen) throw new LoginCancelled("Login cancelled");
					return chosen.id;
				}
				const answer = await host.dialogs.ask(
					"input",
					{
						title: prompt.message,
						placeholder:
							prompt.type === "manual_code" ? "Paste the authorization code or URL" : prompt.placeholder,
					},
					{ signal: prompt.signal ?? controller.signal },
				);
				if (typeof answer !== "string" || !answer) throw new LoginCancelled("Login cancelled");
				return answer;
			},
			notify: (event: AuthEvent) => {
				if (event.type === "auth_url") {
					openBrowser(event.url);
					host.broadcast("login_event", {
						type: "auth_url",
						url: event.url,
						instructions: event.instructions ?? null,
					});
				} else if (event.type === "device_code") {
					openBrowser(event.verificationUri);
					host.broadcast("login_event", {
						type: "device_code",
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						expiresInSeconds: event.expiresInSeconds ?? null,
					});
				} else if (event.type === "info") {
					host.broadcast("login_event", { type: "info", message: event.message, links: event.links ?? [] });
				} else if (event.type === "progress") {
					host.broadcast("login_event", { type: "progress", message: event.message });
				}
			},
		};
	};

	const afterCredentialChange = async () => {
		await host.session.reconcileModelAfterConfigChange();
		host.broadcast("models_changed", {});
	};

	/**
	 * Saves the key typed in the provider form. That form has one key field, so saving a key under the label the provider
	 * already has means "this is its key now": the stored entry is updated instead of adding a second one, which the
	 * credential store refuses as a duplicate label. Only a save that really added a key may be rolled back afterwards.
	 */
	const saveFormProviderKey = async (
		providerId: string,
		label: string,
		key: string,
	): Promise<{ id: string; created: boolean }> => {
		const overview = await runtime()
			.getProviderCredentialOverview(providerId)
			.catch(() => undefined);
		const existing = overview?.apiKeys.find(
			(candidate) => candidate.label.localeCompare(label, undefined, { sensitivity: "accent" }) === 0,
		);
		if (existing) {
			await runtime().replaceProviderApiKey(providerId, existing.id, createInteraction(key));
			return { id: existing.id, created: false };
		}
		return { id: (await runtime().addProviderApiKey(providerId, label, createInteraction(key))).id, created: true };
	};

	server.route("GET", "/api/providers", async () => {
		const rt = runtime();
		// Every session has its own runtime and each keeps the credentials it read from auth.json in memory. A key saved
		// by another session (this list is read from the first one) is on disk but not in this copy: read the file again,
		// so what the page shows and the missing-API-key check that draws it agree with what is really stored.
		rt.reloadCredentials();
		const disabled = new Set(host.session.settingsManager.getDisabledProviders());
		const configEntries = new Map(
			(
				await manager()
					.listResolved()
					.catch(() => [])
			).map((entry) => [entry.id, entry.config] as const),
		);
		const providers = [];
		for (const provider of rt.getProviders()) {
			const overview = await rt.getProviderCredentialOverview(provider.id).catch(() => undefined);
			const status = rt.getProviderAuthStatus(provider.id);
			// A credential that is stored counts as configured even when this runtime's model snapshot predates it. This is
			// the same rule getProviderAuthStatus applies for its "stored" source, which it can only see after a refresh.
			const storedCredential =
				!!overview && (overview.apiKeys.length > 0 || overview.hasOAuth || overview.runtimeOverride === true);
			const externalLogin = provider.auth.apiKey?.externalLogin?.();
			const configured = externalLogin ? !!(await rt.checkAuth(provider.id)) : status.configured || storedCredential;
			// A models.json provider saved without a Base URL is unfinished: it is off until the address is filled in.
			const missingBaseUrl = modelsJsonProviderLacksBaseUrl(configEntries.get(provider.id));
			providers.push({
				id: provider.id,
				name: provider.name,
				baseUrl: provider.baseUrl ?? null,
				enabled: !disabled.has(provider.id) && !missingBaseUrl,
				missingBaseUrl,
				configured,
				authSource: externalLogin
					? configured
						? "external"
						: null
					: status.configured
						? (status.source ?? null)
						: storedCredential
							? "stored"
							: null,
				externalLogin: externalLogin ?? null,
				supportsApiKeyLogin: typeof provider.auth.apiKey?.login === "function",
				supportsOAuth: provider.auth.oauth !== undefined,
				/** Defined in models.json: edited, renamed and deleted from its card. */
				custom: configEntries.has(provider.id),
				modelCount: provider.getModels().length,
				settings: (provider.settings ?? []).map((setting) => ({
					id: setting.id,
					label: setting.label,
					description: setting.description ?? null,
					placeholder: setting.placeholder ?? null,
					value: setting.get(),
				})),
				credentials: overview
					? {
							active: overview.active ?? null,
							apiKeys: overview.apiKeys.map((key) => ({
								id: key.id,
								label: key.label,
								suffix: key.suffix ?? null,
								active: key.active,
							})),
							hasOAuth: overview.hasOAuth,
							runtimeOverride: overview.runtimeOverride === true,
							/** Something "Remove credentials" can really delete: saved keys or logins, or a key in models.json. */
							removable:
								overview.apiKeys.length > 0 ||
								overview.hasOAuth ||
								overview.runtimeOverride === true ||
								hasConfigKey(status, configEntries.get(provider.id)),
						}
					: null,
			});
		}
		return { providers, modelsPath: rt.getModelsConfigPath() ?? null, error: rt.getError() ?? null };
	});

	server.route("POST", "/api/providers/enabled", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		if (typeof payload.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
		if (
			payload.enabled &&
			modelsJsonProviderLacksBaseUrl(
				await manager()
					.getResolved(id)
					.catch(() => undefined),
			)
		) {
			throw new HttpError(409, "The Base URL is not filled in. Enter it and save before enabling this provider.");
		}
		try {
			await providerSettings.setProviderEnabled(id, payload.enabled);
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
		await host.session.settingsManager.flush();
		host.broadcast("models_changed", {});
		return { ok: true };
	});

	server.route("POST", "/api/providers/setting", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		const settingId = str(payload.setting, "setting");
		if (typeof payload.value !== "string") throw new HttpError(400, "value must be a string");
		const setting = runtime()
			.getProviders()
			.find((provider) => provider.id === id)
			?.settings?.find((candidate) => candidate.id === settingId);
		if (!setting) throw new HttpError(404, `Unknown setting ${settingId} of provider ${id}`);
		try {
			await setting.set(payload.value);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		host.broadcast("models_changed", {});
		return { ok: true, value: setting.get() };
	});

	/** Recheck a login owned by the provider's program; never create a fake saved API key. */
	server.route("POST", "/api/providers/auth/check", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		const rt = runtime();
		const provider = rt.getProvider(id) ?? rt.getProviderCatalogProvider(id);
		if (!provider) throw new HttpError(404, `Unknown provider: ${id}`);
		if (!provider.auth.apiKey?.externalLogin)
			throw new HttpError(400, "This provider does not use an external program for sign-in.");
		try {
			rt.reloadCredentials();
			await rt.refresh({ allowNetwork: false });
			await afterCredentialChange();
			return { ok: true, configured: rt.getProviderAuthStatus(id).configured };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/providers/api-key/add", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		const key = str(payload.key, "key").trim();
		const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim() : "Default key";
		try {
			const saved = await runtime().addProviderApiKey(id, label, createInteraction(key));
			await afterCredentialChange();
			return { ok: true, active: saved.active };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/providers/api-key/replace", async ({ body }) => {
		const payload = asObject(body);
		try {
			await runtime().replaceProviderApiKey(
				str(payload.id, "id"),
				str(payload.keyId, "keyId"),
				createInteraction(str(payload.key, "key").trim()),
			);
			await afterCredentialChange();
			return { ok: true };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/providers/api-key/rename", async ({ body }) => {
		const payload = asObject(body);
		await runtime().renameProviderApiKey(
			str(payload.id, "id"),
			str(payload.keyId, "keyId"),
			str(payload.label, "label").trim(),
		);
		return { ok: true };
	});

	server.route("POST", "/api/providers/api-key/activate", async ({ body }) => {
		const payload = asObject(body);
		await runtime().activateProviderApiKey(str(payload.id, "id"), str(payload.keyId, "keyId"));
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/api-key/delete", async ({ body }) => {
		const payload = asObject(body);
		const replacement = typeof payload.replacementKeyId === "string" ? payload.replacementKeyId : undefined;
		await runtime().deleteProviderApiKey(str(payload.id, "id"), str(payload.keyId, "keyId"), replacement);
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/oauth/activate", async ({ body }) => {
		await runtime().activateProviderOAuth(str(asObject(body).id, "id"));
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/oauth/login", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		try {
			await runtime().login(id, "oauth", createInteraction());
			await afterCredentialChange();
			return { ok: true };
		} catch (error) {
			if (error instanceof LoginCancelled) return { ok: false, cancelled: true };
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		} finally {
			activeLogin = undefined;
			host.broadcast("login_event", { type: "done" });
		}
	});

	server.route("POST", "/api/providers/login/abort", () => {
		activeLogin?.abort();
		host.dialogs.dismissAll();
		return { ok: true };
	});

	/**
	 * Removes every credential MyHarness holds for the provider: saved API keys and logins, and a key written into its
	 * models.json entry. A failure restores models.json. If the provider is still configured afterwards (for example
	 * through an environment variable) the request fails with the reason instead of pretending it worked.
	 */
	server.route("POST", "/api/providers/logout", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		const custom = manager();
		const snapshot = await custom.snapshot().catch(() => undefined);
		try {
			const entry = await custom.get(id).catch(() => undefined);
			if (hasConfigKey(runtime().getProviderAuthStatus(id), entry)) await custom.removeApiKey(id);
			await runtime().deleteProviderCredentials(id);
			await runtime().reloadConfig();
			const configError = runtime().getError();
			if (configError) throw new Error(configError);
		} catch (error) {
			if (snapshot) await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		await afterCredentialChange();
		const after = runtime().getProviderAuthStatus(id);
		if (after.configured) {
			throw new HttpError(
				409,
				`Saved credentials were removed, but the provider is still signed in through ${after.label ?? after.source ?? "another source"}. Remove it there.`,
			);
		}
		return { ok: true };
	});

	// ---- User-defined providers (models.json) --------------------------------------------
	/** An entry that extends a provider an extension registered: its address also covers models the file does not list. */
	const overlaysRegisteredProvider = (id: string) => runtime().getRegisteredProviderIds().includes(id);

	/** A login, the ready-made Nebius entry and an extension's provider stay as they are: the layers do not apply to them. */
	const staysOutOfLayers = async (id: string) =>
		id === NEBIUS_PROVIDER_ID ||
		overlaysRegisteredProvider(id) ||
		(await runtime().getProviderCredentialOverview(id)).hasOAuth;

	/** Entries that could be the same service as another. */
	const mergeCandidates = async (): Promise<MergeCandidate[]> => {
		const rt = runtime();
		const custom = manager();
		const raw = new Map((await custom.list()).map((entry) => [entry.id, entry.config] as const));
		const groups = await custom.listGroups();
		const candidates: MergeCandidate[] = [];
		for (const { id, config } of await custom.listResolved()) {
			if (await staysOutOfLayers(id)) continue;
			const baseUrls = [config.baseUrl, ...(config.models ?? []).map((model) => model.baseUrl)];
			candidates.push({
				id,
				name: raw.get(id)?.name ?? id,
				groupId: config.group && Object.hasOwn(groups, config.group) ? config.group : undefined,
				baseUrls: baseUrls.filter((url): url is string => !!url),
				keyTokens: await rt.getApiKeyDigests(id),
			});
		}
		return candidates;
	};

	server.route("GET", "/api/providers/custom", async () => {
		const rt = runtime();
		rt.reloadCredentials();
		const custom = manager();
		const entries = await custom.list();
		const groups = await custom.listGroups();
		const modelKeysOf = async (entry: { id: string; config: ModelsJsonProvider }) => {
			const keys: Record<string, { suffix: string | null }> = {};
			for (const model of entry.config.models ?? []) {
				const info = await rt.getLayerApiKeyInfo(modelCredentialId(entry.id, model.id));
				if (info) keys[model.id] = info;
			}
			return keys;
		};
		return {
			path: rt.getModelsConfigPath() ?? null,
			apiTypes: [...CUSTOM_PROVIDER_API_TYPES],
			/** Per-provider connection settings: what applies when a provider does not set them, and the allowed range. */
			connectionDefaults: {
				keepAliveSeconds: DEFAULT_KEEP_ALIVE_SECONDS,
				keepAliveMin: MIN_KEEP_ALIVE_SECONDS,
				keepAliveMax: MAX_KEEP_ALIVE_SECONDS,
				ipFamily: DEFAULT_IP_FAMILY,
				ipFamilies: [...IP_FAMILIES],
			},
			// The page always edits the layered form: nothing a model uses differs from what the file says now.
			providers: await Promise.all(
				entries.map(async (entry) => ({
					id: entry.id,
					config: redactProvider((await staysOutOfLayers(entry.id)) ? entry.config : toLayeredEntry(entry.config)),
					modelKeys: await modelKeysOf(entry),
				})),
			),
			groups: await Promise.all(
				Object.entries(groups).map(async ([id, config]) => ({
					id,
					config,
					key: (await rt.getLayerApiKeyInfo(groupCredentialId(id))) ?? null,
				})),
			),
			mergeSuggestions: suggestProviderMerges(await mergeCandidates()),
			hiddenPlaceholder: HIDDEN,
		};
	});

	const reloadLayers = async () => {
		await runtime().reloadConfig();
		const configError = runtime().getError();
		if (configError) throw new Error(configError);
	};

	/** Runs a change to models.json and the keys of its layers; when anything fails the file is what it was before. */
	const changingLayers = async <T>(change: (custom: CustomProviderManager) => Promise<T>): Promise<T> => {
		const custom = manager();
		const snapshot = await custom.snapshot().catch(() => undefined);
		let result: T;
		try {
			result = await change(custom);
			await host.session.reconcileModelAfterConfigChange();
		} catch (error) {
			if (snapshot) await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			if (error instanceof HttpError) throw error;
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		host.broadcast("models_changed", {});
		host.broadcast("usage", host.usage());
		return result;
	};

	/**
	 * Saves the top layer of a provider. A provider that so far stands alone (`memberId`) becomes a group first, with that
	 * entry as its only key. `apiKey` sets the key of the whole provider, `removeApiKey` takes it away.
	 */
	server.route("POST", "/api/providers/group/save", async ({ body }) => {
		const payload = asObject(body);
		const fields = groupFields(payload);
		const typedKey = typedLayerKey(payload.apiKey);
		const id = await changingLayers(async (custom) => {
			const groupId =
				typeof payload.id === "string" && payload.id
					? payload.id
					: await custom.ensureGroupFor(str(payload.memberId, "memberId"));
			// A group always keeps a name: an emptied field leaves the name it had.
			const previous = (await custom.listGroups())[groupId];
			await custom.updateGroup(groupId, { ...fields, name: fields.name ?? previous?.name ?? groupId });
			await reloadLayers();
			if (typedKey) await runtime().setLayerApiKeys([[groupCredentialId(groupId), typedKey]]);
			else if (payload.removeApiKey === true)
				await runtime().setLayerApiKeys([[groupCredentialId(groupId), undefined]]);
			return groupId;
		});
		return { ok: true, id };
	});

	/** A key of a group that entries came out of stays with them, and a group left empty takes its key with it. */
	const settleGroupKeys = async (change: { moved: { id: string; fromGroup: string }[]; emptied: string[] }) => {
		for (const { id, fromGroup } of change.moved) await runtime().adoptLayerApiKey(groupCredentialId(fromGroup), id);
		await runtime().setLayerApiKeys(
			change.emptied.map((groupId) => [groupCredentialId(groupId), undefined] as const),
		);
	};

	/**
	 * Makes entries the keys of one provider: `groupId` to join an existing one, otherwise a new one called `name`. Every
	 * entry keeps its ID, its keys and its name, so settings and old chats that point at it keep working.
	 */
	server.route("POST", "/api/providers/group/merge", async ({ body }) => {
		const payload = asObject(body);
		const ids = Array.isArray(payload.ids)
			? payload.ids.filter((id): id is string => typeof id === "string" && !!id)
			: [];
		if (ids.length === 0) throw new HttpError(400, "Choose at least one provider to merge.");
		const id = await changingLayers(async (custom) => {
			const change = await custom.mergeProviders({
				ids,
				groupId: typeof payload.groupId === "string" && payload.groupId ? payload.groupId : undefined,
				name: typeof payload.name === "string" ? payload.name : undefined,
			});
			await settleGroupKeys(change);
			await reloadLayers();
			return change.groupId;
		});
		return { ok: true, id };
	});

	/** Takes a key out of its provider: it stands alone again and its models keep using what they use now. */
	server.route("POST", "/api/providers/group/leave", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		await changingLayers(async (custom) => {
			await settleGroupKeys(await custom.leaveGroup(id));
			await reloadLayers();
		});
		return { ok: true };
	});

	/**
	 * Checks the models the user named (`modelIds`) and nothing else, with exactly what the edit form holds right now,
	 * saved or not: API format, Base URL, authentication mode and a key that was just typed. Without a typed key the key
	 * already stored for the provider being edited is used. It only runs when the user asks for it: the model list is a
	 * free GET, and every thinking effort is tested with minimal real requests for these models (each level on its own,
	 * an undecided answer is tried up to three more times). Nothing is written; the form applies the answer. A model list
	 * that cannot be read is reported next to the result and does not stop the test.
	 */
	server.route("POST", "/api/providers/custom/detect", async ({ body }) => {
		const payload = asObject(body);
		const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
		const api = typeof payload.api === "string" ? payload.api : "";
		const existingId = typeof payload.id === "string" && payload.id ? payload.id : undefined;
		const authMode = payload.auth === "config" ? "config" : "key";
		if (!baseUrl) throw new HttpError(400, "Enter the Base URL first.");
		if (!(CUSTOM_PROVIDER_API_TYPES as readonly string[]).includes(api))
			throw new HttpError(400, "Choose an API type first.");
		let apiKey = typeof payload.apiKey === "string" && payload.apiKey.trim() ? payload.apiKey.trim() : undefined;
		let authType: "api_key" | "oauth" = "api_key";
		let headers: Record<string, string> | undefined;
		const stored = existingId
			? await manager()
					.get(existingId)
					.catch(() => undefined)
			: undefined;
		// Headers as edited in the form; a placeholder stands for the stored secret.
		const formHeaders =
			payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)
				? (payload.headers as Record<string, unknown>)
				: stored?.headers;
		if (formHeaders) {
			headers = {};
			for (const [name, value] of Object.entries(formHeaders)) {
				const resolved = value === HIDDEN ? stored?.headers?.[name] : value;
				if (typeof resolved === "string") headers[name] = resolved;
			}
		}
		if (!apiKey) {
			if (authMode === "config" && typeof payload.configApiKey === "string" && payload.configApiKey !== HIDDEN) {
				apiKey = payload.configApiKey.trim() || undefined;
			}
			if (!apiKey && existingId) {
				const auth = await runtime()
					.getAuth(existingId)
					.catch(() => undefined);
				apiKey = auth?.auth.apiKey;
				if (auth?.source === "OAuth") authType = "oauth";
			}
		}
		const modelIds = Array.isArray(payload.modelIds)
			? [...new Set(payload.modelIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()))]
			: [];
		if (!modelIds.some(Boolean)) throw new HttpError(400, "Enter at least one Model ID to detect.");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 60_000);
		try {
			const result = await detectSpecifiedModels({
				baseUrl,
				api: api as CustomProviderApiType,
				apiKey,
				authType,
				headers,
				signal: controller.signal,
				modelIds,
			});
			const listError = result.catalogError;
			return {
				ok: true,
				models: result.models,
				unlisted: result.unlisted ?? null,
				listError: listError
					? {
							code: listError.code,
							message: listError.message,
							status: listError.status ?? null,
							detail: listError.detail ?? null,
							url: listError.requestUrl ?? null,
						}
					: null,
			};
		} catch (error) {
			if (error instanceof ProviderModelDiscoveryError) {
				return {
					ok: false,
					code: error.code,
					message: error.message,
					status: error.status ?? null,
					detail: error.detail ?? null,
					url: error.requestUrl ?? null,
				};
			}
			return { ok: false, code: "connection", message: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	});

	server.route("POST", "/api/providers/custom/save", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id").trim();
		const previousId = typeof payload.previousId === "string" && payload.previousId ? payload.previousId : undefined;
		const config = payload.config;
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new HttpError(400, "config must be an object");
		// An API key typed in the form goes to the credential store (like the TUI does), not into models.json.
		const typedKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined;
		// A field holding only spaces is a mistake, not "no key": say so instead of saving without one.
		if (typedKey !== undefined && typedKey !== "" && !typedKey.trim())
			throw new HttpError(400, "The API key is empty. Type the key, or leave the field empty to save without one.");
		const newKey = typedKey?.trim() || undefined;
		const keyLabel =
			typeof payload.keyLabel === "string" && payload.keyLabel.trim() ? payload.keyLabel.trim() : "Default key";
		// A model's own key: a string sets it, null removes it. `modelKeyMoves` follows a Model ID that was edited.
		const modelKeyChanges: Array<readonly [string, string | undefined]> = [];
		for (const [modelId, value] of Object.entries(
			payload.modelKeys && typeof payload.modelKeys === "object"
				? (payload.modelKeys as Record<string, unknown>)
				: {},
		)) {
			const key = value === null ? undefined : typedLayerKey(value);
			if (key || value === null) modelKeyChanges.push([modelCredentialId(id, modelId), key]);
		}
		const modelKeyMoves = Object.entries(
			payload.modelKeyMoves && typeof payload.modelKeyMoves === "object"
				? (payload.modelKeyMoves as Record<string, unknown>)
				: {},
		).filter((move): move is [string, string] => typeof move[1] === "string" && !!move[1]);
		const custom = manager();
		const snapshot = await custom.snapshot().catch(() => undefined);
		let savedKey: { id: string; created: boolean } | undefined;
		// The entry as it was stored before this save: what is no longer in the new model list was deleted here.
		const referenceProvider = previousId ?? id;
		const stored = await custom.get(referenceProvider).catch(() => undefined);
		// An empty Base URL is saved as "not filled in yet", never as an address.
		const incoming = { ...(config as ModelsJsonProvider) };
		if (typeof incoming.baseUrl !== "string" || !incoming.baseUrl.trim()) delete incoming.baseUrl;
		else incoming.baseUrl = incoming.baseUrl.trim();
		try {
			// A new key added under a provider that so far stands alone makes that provider a group.
			if (typeof payload.attachTo === "string" && payload.attachTo)
				incoming.group = await custom.ensureGroupFor(payload.attachTo);
			await custom.upsert(id, restoreSecrets(incoming, stored), previousId);
			await runtime().reloadConfig();
			const configError = runtime().getError();
			if (configError) throw new Error(configError);
			if (newKey) savedKey = await saveFormProviderKey(id, keyLabel, newKey);
			for (const [from, to] of modelKeyMoves)
				await runtime().moveLayerApiKey(modelCredentialId(id, from), modelCredentialId(id, to));
			await runtime().setLayerApiKeys(modelKeyChanges);
			await host.session.reconcileModelAfterConfigChange();
		} catch (error) {
			// Only a key this save added is removed again; a replaced one keeps the value it was just given.
			if (savedKey?.created) {
				await runtime()
					.deleteProviderApiKey(id, savedKey.id)
					.catch(() => {});
			}
			if (snapshot) await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		// A model deleted by this save must not stay referenced by settings that pin one (default, sub-agent, compaction...).
		const keptModels = new Set((incoming.models ?? []).map((model) => model.id));
		const removedModels = (stored?.models ?? []).filter((model) => !keptModels.has(model.id));
		if (removedModels.length > 0) {
			for (const model of removedModels)
				host.session.settingsManager.clearModelReferences(referenceProvider, model.id);
			await host.session.settingsManager.flush();
			host.broadcast("settings_changed", {});
			await runtime()
				.setLayerApiKeys(removedModels.map((model) => [modelCredentialId(id, model.id), undefined] as const))
				.catch(() => {});
		}
		host.broadcast("models_changed", {});
		host.broadcast("usage", host.usage());
		// Without a Base URL the provider is saved but off: it offers no models until the address is filled in. What its
		// group sets counts as well.
		const missingBaseUrl = modelsJsonProviderLacksBaseUrl(await custom.getResolved(id).catch(() => undefined));
		return { ok: true, missingBaseUrl };
	});

	/** Chats that are working right now on a model of this provider: deleting it would cut them off. */
	const runningOn = (providerId: string) =>
		(hub?.all() ?? [host])
			.filter((candidate) => {
				const model = candidate.session.model;
				return model?.provider === providerId && (!candidate.session.isIdle || candidate.completionActive);
			})
			.map((candidate) => {
				const status = candidate.status;
				return { slot: candidate.slotId, name: status.name, firstMessage: status.firstMessage, cwd: status.cwd };
			});

	// ---- Nebius Token Factory, ready-made (providers/models/nebius-preset.ts) ------------------------------
	const nebiusSetup = new NebiusSetupUseCase({
		getSession: () => host.session,
		saveApiKey: (providerId, key) => saveFormProviderKey(providerId, "Token Factory", key),
		deleteApiKey: (providerId, keyId) => runtime().deleteProviderApiKey(providerId, keyId),
		refreshConversationNaming: () => host.refreshConversationNaming(),
		refreshSessionHandoff: () => host.refreshSessionHandoff(),
		baseUrl: options.nebiusBaseUrl,
	});
	const spendFile = () => {
		const modelsPath = runtime().getModelsConfigPath();
		return modelsPath ? join(dirname(modelsPath), "provider-spend.json") : undefined;
	};

	/** The Nebius card: whether it is set up, the console links and what this computer estimates it has spent there. */
	server.route("GET", "/api/providers/nebius", async () => {
		const entry = await manager()
			.get(NEBIUS_PROVIDER_ID)
			.catch(() => undefined);
		const file = spendFile();
		return {
			id: NEBIUS_PROVIDER_ID,
			configured: !!entry,
			hasKey: entry
				? !!(await runtime()
						.checkAuth(NEBIUS_PROVIDER_ID)
						.catch(() => undefined))
				: false,
			apiKeysUrl: NEBIUS_API_KEYS_URL,
			consoleUrl: NEBIUS_CONSOLE_URL,
			spend: file ? (providerSpendLedger(file).get(NEBIUS_PROVIDER_ID) ?? null) : null,
		};
	});

	/** Paste a key (or reuse the saved one) and set everything up; see NebiusSetupUseCase. */
	server.route("POST", "/api/providers/nebius/setup", async ({ body }) => {
		const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
		const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined;
		try {
			const result = await nebiusSetup.setup({ apiKey });
			host.broadcast("models_changed", {});
			host.broadcast("settings_changed", {});
			host.broadcast("usage", host.usage());
			return { ok: true, ...result };
		} catch (error) {
			if (error instanceof NebiusSetupError) return { ok: false, code: error.code, message: error.message };
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("GET", "/api/providers/custom/usage", ({ url }) => {
		const id = str(url.searchParams.get("id") ?? undefined, "id");
		return { running: runningOn(id) };
	});

	/**
	 * Removes the provider for good: its models.json entry, every stored API key / login, and the settings that point at
	 * it. If a step fails the models.json change is rolled back, so the provider is not left half deleted. Deleting
	 * works for the last provider too (MyHarness is then simply left without a model).
	 *
	 * When chats are running on the provider nothing is deleted until the caller confirms with `stopRunning: true`;
	 * those chats are then stopped first. Without that flag the answer lists the running chats.
	 */
	server.route("POST", "/api/providers/custom/delete", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		const running = runningOn(id);
		if (running.length > 0 && payload.stopRunning !== true) return { ok: false, running };
		if (
			!(await manager()
				.get(id)
				.catch(() => undefined))
		)
			throw new HttpError(404, "No such provider in models.json");
		await deleteEntries([id]);
		return { ok: true };
	});

	/** Removes a whole provider of several keys, on the same terms as deleting one entry. */
	server.route("POST", "/api/providers/group/delete", async ({ body }) => {
		const payload = asObject(body);
		const groupId = str(payload.id, "id");
		const members = (await manager().list())
			.filter((entry) => entry.config.group === groupId)
			.map((entry) => entry.id);
		if (members.length === 0) throw new HttpError(404, "No such provider in models.json");
		const running = members.flatMap(runningOn);
		if (running.length > 0 && payload.stopRunning !== true) return { ok: false, running };
		await deleteEntries(members);
		return { ok: true };
	});

	/** Stops the chats working on these entries and removes the entries, their keys and what points at them. */
	const deleteEntries = async (ids: readonly string[]) => {
		const removing = new Set(ids);
		for (const candidate of hub?.all() ?? [host]) {
			if (!removing.has(candidate.session.model?.provider ?? "")) continue;
			if (candidate.session.isCompacting) candidate.session.abortCompaction();
			if (candidate.session.isRetrying) candidate.session.abortRetry();
			await candidate.session.abort();
			await candidate.waitForCompletion().catch(() => {});
		}
		const custom = manager();
		const snapshot = await custom.snapshot();
		try {
			const layerKeys: string[] = [];
			for (const id of ids) {
				const entry = await custom.get(id);
				if (!(await custom.delete(id))) throw new HttpError(404, "No such provider in models.json");
				await runtime().deleteProviderCredentials(id);
				host.session.settingsManager.clearModelReferences(id, undefined, true);
				for (const model of entry?.models ?? []) layerKeys.push(modelCredentialId(id, model.id));
			}
			for (const groupId of await custom.removeEmptyGroups()) layerKeys.push(groupCredentialId(groupId));
			await runtime().setLayerApiKeys(layerKeys.map((id) => [id, undefined] as const));
			await host.session.settingsManager.flush();
			await runtime().reloadConfig();
			await host.session.reconcileModelAfterConfigChange();
			await host.session.settingsManager.flush();
		} catch (error) {
			await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			if (error instanceof HttpError) throw error;
			throw new HttpError(
				500,
				`Could not delete the provider: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		host.broadcast("models_changed", {});
	};
}
