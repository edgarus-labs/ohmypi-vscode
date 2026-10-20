/** The part of `vscode.Memento` the preferences use. */
export interface PreferenceMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

/** How many recently picked models are kept. */
export const RECENT_LIMIT = 20;

const FAVORITES = "omp.modelPicker.favorites";
const RECENTS = "omp.modelPicker.recents";
const FAVORITES_ONLY = "omp.modelPicker.favoritesOnly";
const RECENT_ONLY = "omp.modelPicker.recentOnly";

/** One percent-escaped part of a key, as `encodeURIComponent` writes it. */
const ESCAPED_PART = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+$/;

/** A model's key in stored lists: `provider/id`, both parts percent-escaped so ids holding `/` stay unambiguous. */
export function modelKey(model: { provider: string; id: string }): string {
	return `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`;
}

/**
 * Favorite and recently picked models and the model picker's filters, kept in a memento (the extension's
 * `globalState`). Stored values that are not what the picker writes read as empty.
 */
export class ModelPreferences {
	readonly #memento: PreferenceMemento;

	constructor(memento: PreferenceMemento) {
		this.#memento = memento;
	}

	get favorites(): readonly string[] {
		return this.#keys(FAVORITES);
	}

	/** Most recent first. */
	get recents(): readonly string[] {
		return this.#keys(RECENTS);
	}

	get favoritesOnly(): boolean {
		return this.#memento.get(FAVORITES_ONLY) === true;
	}

	get recentOnly(): boolean {
		return this.#memento.get(RECENT_ONLY) === true;
	}

	/** Adds `key` to the favorites or removes it; resolves to whether it is a favorite now. */
	async toggleFavorite(key: string): Promise<boolean> {
		const favorites = this.#keys(FAVORITES);
		const favorite = !favorites.includes(key);
		await this.#memento.update(FAVORITES, favorite ? [...favorites, key] : favorites.filter(candidate => candidate !== key));
		return favorite;
	}

	/** Moves `key` to the front of the recent picks, dropping the oldest beyond {@link RECENT_LIMIT}. */
	async recordPicked(key: string): Promise<void> {
		const recents = [key, ...this.#keys(RECENTS).filter(candidate => candidate !== key)].slice(0, RECENT_LIMIT);
		await this.#memento.update(RECENTS, recents);
	}

	async setFavoritesOnly(on: boolean): Promise<void> {
		await this.#memento.update(FAVORITES_ONLY, on);
	}

	async setRecentOnly(on: boolean): Promise<void> {
		await this.#memento.update(RECENT_ONLY, on);
	}

	#keys(name: string): string[] {
		const stored = this.#memento.get<unknown>(name);
		if (!Array.isArray(stored)) return [];
		const keys = new Set<string>();
		for (const value of stored) {
			if (typeof value !== "string") continue;
			const parts = value.split("/");
			if (parts.length === 2 && parts.every(part => ESCAPED_PART.test(part))) keys.add(value);
		}
		return [...keys];
	}
}
