/**
 * The three layers of a provider in models.json: the provider group (one relay or service), its keys (each a provider
 * entry, which is also what the runtime calls a provider) and their models.
 *
 * Each of Base URL, API format and API key is looked up from the top down and the first layer that has a value wins, so a
 * value set high up applies to everything below it and a layer left empty lets the layers below decide for themselves. A
 * value that is covered stays where it is and applies again once the layer above is cleared.
 *
 * An entry without `layered: true` was written before these layers existed: there a model's own value wins over its
 * entry's, as models.json has always documented. `toLayeredEntry` turns such an entry into the layered form without
 * changing what any of its models uses.
 */

import type { ModelsJsonModel, ModelsJsonProvider, ModelsJsonProviderGroup } from "./config.ts";

type LayeredField = "api" | "baseUrl";
const LAYERED_FIELDS: readonly LayeredField[] = ["api", "baseUrl"];

/** Where the API key of the top layer is stored: the credential store's IDs cannot clash, provider IDs have no colon. */
export const groupCredentialId = (groupId: string): string => `group:${groupId}`;

/** Where the API key of one model is stored. */
export const modelCredentialId = (providerId: string, modelId: string): string => `model:${providerId}:${modelId}`;

/** The source reported for an entry that only its models have keys for. */
export const MODEL_KEY_SOURCE = "model API key";

/** What other surfaces call an entry of a group: the name alone already says which group when it starts with it. */
export function layeredProviderName(groupName: string | undefined, entryName: string): string {
	if (!groupName) return entryName;
	return entryName.toLowerCase().startsWith(groupName.toLowerCase()) ? entryName : `${groupName} · ${entryName}`;
}

/**
 * Compiles the layers down to what the runtime reads: an entry whose fields and models hold the values that really apply,
 * in the shape where a model's value is simply used when it has one. Entries that use neither a group nor the layered
 * rule are returned as they are.
 */
export function resolveProviderLayers(
	providerId: string,
	entry: ModelsJsonProvider,
	group: ModelsJsonProviderGroup | undefined,
): ModelsJsonProvider {
	if (!group && !entry.layered) return entry;
	const resolved: ModelsJsonProvider = { ...entry };
	for (const field of LAYERED_FIELDS) {
		const value = group?.[field] ?? entry[field];
		if (value) resolved[field] = value;
		else delete resolved[field];
	}
	if (group) resolved.name = layeredProviderName(group.name, entry.name ?? providerId);
	if (entry.models) {
		resolved.models = entry.models.map((model) => {
			const next: ModelsJsonModel = { ...model };
			for (const field of LAYERED_FIELDS) {
				const value =
					group?.[field] ?? (entry.layered ? (entry[field] ?? model[field]) : (model[field] ?? entry[field]));
				if (value) next[field] = value;
				else delete next[field];
			}
			return next;
		});
	}
	return resolved;
}

/** What one model of an entry written before the layers really uses, including the old fallback to the first model. */
function legacyEffectiveValues(entry: ModelsJsonProvider): Array<Partial<Record<LayeredField, string>>> {
	let first: Partial<Record<LayeredField, string>> | undefined;
	return (entry.models ?? []).map((model) => {
		const values = {
			api: model.api ?? entry.api ?? first?.api,
			baseUrl: model.baseUrl ?? entry.baseUrl ?? first?.baseUrl,
		};
		if (values.baseUrl && !first) first = values;
		return values;
	});
}

/**
 * The same entry under the layered rule, with every model still using exactly what it used: when its models disagree
 * about a field the entry leaves it empty and each model holds its own value, otherwise the entry holds it. Secrets and
 * unknown fields are untouched.
 */
export function toLayeredEntry(entry: ModelsJsonProvider): ModelsJsonProvider {
	if (entry.layered) return entry;
	const layered: ModelsJsonProvider = { ...entry, layered: true };
	const models = entry.models ?? [];
	if (models.length === 0) return layered;
	const effective = legacyEffectiveValues(entry);
	const nextModels: ModelsJsonModel[] = models.map((model) => ({ ...model }));
	for (const field of LAYERED_FIELDS) {
		const values = new Set(effective.map((value) => value[field]));
		const shared = values.size === 1 ? effective[0]?.[field] : undefined;
		if (shared) layered[field] = shared;
		else if (values.size > 1) delete layered[field];
		nextModels.forEach((model, index) => {
			const value = values.size > 1 ? effective[index]?.[field] : undefined;
			if (value) model[field] = value;
			else delete model[field];
		});
	}
	layered.models = nextModels;
	return layered;
}

/**
 * What an entry has to hold itself once its group is gone, so that its models keep using what they use now: the group's
 * values move down into the entry.
 */
export function withGroupValues(
	entry: ModelsJsonProvider,
	group: ModelsJsonProviderGroup | undefined,
): ModelsJsonProvider {
	const next = toLayeredEntry(entry);
	if (!group) return next;
	const copy: ModelsJsonProvider = { ...next };
	for (const field of LAYERED_FIELDS) {
		const value = group[field];
		if (value) copy[field] = value;
	}
	return copy;
}

/** A provider entry or a whole group, as the merge suggestions see it. */
export interface MergeCandidate {
	id: string;
	name: string;
	/** Set when the entry already belongs to this group. */
	groupId?: string;
	/** Every address the entry's requests go to. */
	baseUrls: readonly string[];
	/** Opaque values that are equal only when two entries hold the same API key. They never leave the server. */
	keyTokens: readonly string[];
}

export interface MergeSuggestionMember {
	id: string;
	name: string;
	host: string;
	/** The same address: ticked from the start. The others only look related, the user ticks them. */
	sure: boolean;
}

export interface MergeSuggestion {
	/** Stays the same while the same entries are suggested, so that a dismissal holds. */
	key: string;
	/** A name to start from, taken from the address. */
	name: string;
	/** The group these entries would join, when one of them already belongs to a group. */
	groupId?: string;
	members: MergeSuggestionMember[];
}

function hostOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).host.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

/** Second-level endings under which the registered name is the third label from the right. */
const SECOND_LEVEL_ENDINGS = new Set([
	"com.cn",
	"net.cn",
	"org.cn",
	"co.uk",
	"org.uk",
	"co.jp",
	"com.hk",
	"com.tw",
	"com.sg",
]);
/** Platforms where each customer has their own subdomain, so a shared ending says nothing about who runs it. */
const SHARED_PLATFORM_ENDINGS = new Set([
	"workers.dev",
	"pages.dev",
	"vercel.app",
	"netlify.app",
	"hf.space",
	"github.io",
	"onrender.com",
	"railway.app",
	"fly.dev",
	"deno.dev",
]);

/** The registered domain of a host, or undefined for an IP address, localhost or a shared platform. */
function mainDomain(host: string): string | undefined {
	const name = host.replace(/:\d+$/u, "");
	if (/^[\d.]+$/u.test(name) || name.startsWith("[") || !name.includes(".")) return undefined;
	const labels = name.split(".");
	const lastTwo = labels.slice(-2).join(".");
	if (SHARED_PLATFORM_ENDINGS.has(lastTwo)) return undefined;
	return SECOND_LEVEL_ENDINGS.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
}

/** The name a suggestion starts from: `api.example.com` gives `example`. */
function suggestedName(host: string): string {
	const domain = mainDomain(host);
	return domain ? (domain.split(".")[0] ?? domain) : host;
}

/**
 * Finds entries that look like the same service, whatever they are called. The same host counts as the same service; a
 * shared registered domain or the same API key only makes it look related, and those members start unticked. Entries of
 * one group stay together, and a cluster that would join two groups is left to the user.
 */
export function suggestProviderMerges(candidates: readonly MergeCandidate[]): MergeSuggestion[] {
	const hostsOf = new Map(
		candidates.map((candidate) => [
			candidate.id,
			[...new Set(candidate.baseUrls.map(hostOf).filter((host): host is string => !!host))],
		]),
	);
	const unit = (candidate: MergeCandidate): string =>
		candidate.groupId ? `group:${candidate.groupId}` : candidate.id;
	const parent = new Map<string, string>(candidates.map((candidate) => [unit(candidate), unit(candidate)]));
	const find = (id: string): string => {
		let root = id;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		return root;
	};
	const firstWithHost = new Map<string, string>();
	for (const candidate of candidates) {
		for (const host of hostsOf.get(candidate.id) ?? []) {
			const seen = firstWithHost.get(host);
			if (seen) parent.set(find(unit(candidate)), find(seen));
			else firstWithHost.set(host, unit(candidate));
		}
	}

	const clusters = new Map<string, MergeCandidate[]>();
	for (const candidate of candidates) {
		const root = find(unit(candidate));
		clusters.set(root, [...(clusters.get(root) ?? []), candidate]);
	}
	const domainsOf = (members: readonly MergeCandidate[]) =>
		new Set(
			members.flatMap((member) =>
				(hostsOf.get(member.id) ?? []).map(mainDomain).filter((domain): domain is string => !!domain),
			),
		);
	const tokensOf = (members: readonly MergeCandidate[]) => new Set(members.flatMap((member) => [...member.keyTokens]));

	const suggestions: MergeSuggestion[] = [];
	const taken = new Set<string>();
	const describe = (candidate: MergeCandidate, sure: boolean): MergeSuggestionMember => ({
		id: candidate.id,
		name: candidate.name,
		host: hostsOf.get(candidate.id)?.[0] ?? "",
		sure,
	});
	const groupsIn = (members: readonly MergeCandidate[]) => [
		...new Set(members.flatMap((member) => (member.groupId ? [member.groupId] : []))),
	];

	// Clusters with several units first: they are the ones the same address settles.
	const ordered = [...clusters.entries()].sort(
		([, a], [, b]) => new Set(b.map(unit)).size - new Set(a.map(unit)).size,
	);
	for (const [root, members] of ordered) {
		if (taken.has(root)) continue;
		const domains = domainsOf(members);
		const tokens = tokensOf(members);
		const related = ordered.filter(
			([otherRoot, others]) =>
				otherRoot !== root &&
				!taken.has(otherRoot) &&
				([...domainsOf(others)].some((domain) => domains.has(domain)) ||
					[...tokensOf(others)].some((token) => tokens.has(token))),
		);
		const relatedMembers = related.flatMap(([, others]) => others);
		const groups = groupsIn([...members, ...relatedMembers]);
		const hasSeveralUnits = new Set(members.map(unit)).size > 1;
		if (!hasSeveralUnits && relatedMembers.length === 0) continue;
		if (groups.length > 1) continue;
		taken.add(root);
		for (const [otherRoot] of related) taken.add(otherRoot);
		const groupId = groups[0];
		// Members of the group these would join are not suggested again.
		const outsideGroup = (member: MergeCandidate) => !groupId || member.groupId !== groupId;
		const sure = members.filter(outsideGroup);
		const maybe = relatedMembers.filter(outsideGroup);
		const list = [
			...sure.map((member) => describe(member, hasSeveralUnits)),
			...maybe.map((member) => describe(member, false)),
		];
		if (list.length === 0) continue;
		const firstHost = hostsOf.get(members[0]?.id ?? "")?.[0] ?? "";
		suggestions.push({
			key: [...list.map((member) => member.id)].sort().join("+"),
			name: suggestedName(firstHost),
			...(groupId ? { groupId } : {}),
			members: list,
		});
	}
	return suggestions;
}

/** An ID for a new group: the name in lowercase, or `provider` when nothing of it can be used, made unique. */
export function newGroupId(name: string, existing: ReadonlySet<string>): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/gu, "-")
			.replace(/^[^a-z0-9]+|-+$/gu, "") || "provider";
	if (!existing.has(base)) return base;
	for (let index = 2; ; index++) {
		const candidate = `${base}-${index}`;
		if (!existing.has(candidate)) return candidate;
	}
}
