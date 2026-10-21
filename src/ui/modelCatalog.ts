import type { ModelView } from "../omp/api";
import { compactTokens } from "../shared/format";
import { modelKey } from "./modelPreferences";

export interface CatalogEntry {
	model: ModelView;
	/** {@link modelKey} of the model. */
	key: string;
	/** The model's name, followed by the part of its id that tells it apart when another model of its provider has the same name. */
	label: string;
}

export interface ProviderGroup {
	provider: string;
	entries: CatalogEntry[];
}

export interface CatalogOptions {
	/** Model keys. */
	favorites: readonly string[];
	/** Model keys, most recent first. */
	recents: readonly string[];
	favoritesOnly: boolean;
	recentOnly: boolean;
	/** Provider of the model in use; its group comes first. */
	currentProvider?: string;
}

const SEPARATORS = "-_./:@ ";
const SEPARATOR = /[-_./:@ ]/;

/** Orders text ignoring case, with runs of digits compared by value so `GPT-5` sorts before `GPT-10`. */
function compareNatural(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (isDigit(a[i]) && isDigit(b[j])) {
			const startA = i;
			const startB = j;
			while (i < a.length && isDigit(a[i])) i++;
			while (j < b.length && isDigit(b[j])) j++;
			const numberA = a.slice(startA, i).replace(/^0+/, "");
			const numberB = b.slice(startB, j).replace(/^0+/, "");
			if (numberA.length !== numberB.length) return numberA.length - numberB.length;
			if (numberA !== numberB) return numberA < numberB ? -1 : 1;
			continue;
		}
		const charA = a[i].toUpperCase();
		const charB = b[j].toUpperCase();
		if (charA !== charB) return charA < charB ? -1 : 1;
		i++;
		j++;
	}
	return a.length - i - (b.length - j);
}

function isDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}

/** `5.5.0` as numbers; no parts when OMP gives no revision or one that is not dotted numbers. */
function revisionOf(entry: CatalogEntry): number[] {
	const revision = entry.model.identity?.revision ?? "";
	return /^\d+(\.\d+)*$/.test(revision) ? revision.split(".").map(Number) : [];
}

function compareRevisions(a: number[], b: number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

const byName = (a: CatalogEntry, b: CatalogEntry) =>
	compareNatural(a.model.name, b.model.name) || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0);

/**
 * Models grouped by family (vendor class and family, as OMP reports them), the family with the newest
 * revision first; within a family the newest revision first, then by name. Models without a family come
 * last, by name.
 */
function newestFirst(entries: CatalogEntry[]): CatalogEntry[] {
	const families = new Map<string, CatalogEntry[]>();
	const rest: CatalogEntry[] = [];
	for (const entry of entries) {
		const family = entry.model.identity?.family;
		if (!family) {
			rest.push(entry);
			continue;
		}
		const name = `${entry.model.identity?.class ?? ""}/${family}`;
		families.set(name, [...(families.get(name) ?? []), entry]);
	}
	const sorted = [...families].map(([name, members]) => {
		members.sort((a, b) => compareRevisions(revisionOf(b), revisionOf(a)) || byName(a, b));
		return { name, members, newest: revisionOf(members[0]) };
	});
	sorted.sort((a, b) => compareRevisions(b.newest, a.newest) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	return [...sorted.flatMap(family => family.members), ...rest.sort(byName)];
}

/** Length of the longest prefix all `ids` share that ends right after a separator. */
function commonPrefix(ids: string[]): number {
	const first = ids[0];
	let length = 0;
	while (length < first.length && ids.every(id => id[length] === first[length])) length++;
	while (length > 0 && !SEPARATORS.includes(first[length - 1])) length--;
	return length;
}

/** Length of the longest suffix all `ids` share past `prefix` that starts at a separator. */
function commonSuffix(ids: string[], prefix: number): number {
	const first = ids[0];
	let length = 0;
	while (length < first.length - prefix && ids.every(id => length < id.length - prefix && id[id.length - 1 - length] === first[first.length - 1 - length])) {
		length++;
	}
	while (length > 0 && !SEPARATORS.includes(first[first.length - length])) length--;
	return length;
}

/**
 * For models of one provider that share a display name: the part of the id that differs, cut at separators;
 * the full id when that would leave an entry with nothing or when the parts would start alike, as with
 * `gpt-5` and `gpt-5-codex`, whose cut parts `5` and `5-codex` would not tell them apart at a glance.
 */
function variants(models: ModelView[]): Map<string, string> {
	const sameName = new Map<string, ModelView[]>();
	for (const model of models) {
		const name = `${model.provider}\0${model.name.toUpperCase()}`;
		sameName.set(name, [...(sameName.get(name) ?? []), model]);
	}
	const result = new Map<string, string>();
	for (const group of sameName.values()) {
		if (group.length < 2) continue;
		const ids = group.map(model => model.id);
		const prefix = commonPrefix(ids);
		const suffix = commonSuffix(ids, prefix);
		const remainders = ids.map(id => id.slice(prefix, id.length - suffix));
		const heads = new Set(remainders.map(remainder => remainder.split(SEPARATOR)[0].toLowerCase()));
		const useFull = remainders.some(remainder => !remainder) || heads.size < remainders.length;
		group.forEach((model, index) => {
			result.set(modelKey(model), useFull ? ids[index] : remainders[index]);
		});
	}
	return result;
}

/**
 * The models to offer, one group per provider (the current provider first, then by name). Under the Recent
 * filter a group lists its models in the order they were picked; otherwise by family, newest first. The
 * Favorites and Recent filters keep only favorites and recent picks; both on keep models that are both.
 */
export function catalogGroups(models: readonly ModelView[], options: CatalogOptions): ProviderGroup[] {
	const unique = new Map<string, ModelView>();
	for (const model of models) if (!unique.has(modelKey(model))) unique.set(modelKey(model), model);
	const labels = variants([...unique.values()]);
	const favorites = new Set(options.favorites);
	const recentRank = new Map(options.recents.map((key, index) => [key, index] as const));
	const groups = new Map<string, CatalogEntry[]>();
	for (const [key, model] of unique) {
		if (options.favoritesOnly && !favorites.has(key)) continue;
		if (options.recentOnly && !recentRank.has(key)) continue;
		const variant = labels.get(key);
		const entry = { model, key, label: variant ? `${model.name} (${variant})` : model.name };
		groups.set(model.provider, [...(groups.get(model.provider) ?? []), entry]);
	}
	return [...groups]
		.sort(
			([a], [b]) =>
				Number(b === options.currentProvider) - Number(a === options.currentProvider) ||
				a.localeCompare(b, undefined, { sensitivity: "base" }) ||
				(a < b ? -1 : a > b ? 1 : 0),
		)
		.map(([provider, entries]) => ({
			provider,
			entries: options.recentOnly ? entries.sort((a, b) => (recentRank.get(a.key) ?? 0) - (recentRank.get(b.key) ?? 0)) : newestFirst(entries),
		}));
}

/** What a picker row shows beside a model's name (context window and price per million tokens) and below it. */
export function modelItemText(model: ModelView): { description: string; detail: string } {
	const summary: string[] = [];
	if (model.contextWindow) summary.push(compactTokens(model.contextWindow));
	if (model.cost) summary.push(`$${+model.cost.input.toFixed(6)} / $${+model.cost.output.toFixed(6)}`);
	const detail = [`${model.provider}/${model.id}`];
	if (model.maxTokens) detail.push(`out ${compactTokens(model.maxTokens)}`);
	if (model.thinkingEfforts.length > 0) detail.push(`reasoning: ${model.thinkingEfforts.join(", ")}`);
	else if (model.reasoning) detail.push("reasoning");
	if (model.input.length > 0) detail.push(`in: ${model.input.join(", ")}`);
	return { description: summary.join(" · "), detail: detail.join(" · ") };
}
