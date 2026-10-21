/** The part of `vscode.Memento` the store uses. */
export interface DismissalMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

const STORAGE_KEY = "omp.dismissedTodos";
const LIMIT = 100;

/**
 * Todo lists the user closed, by the key the chat derives from their content; persisted (newest first, at most
 * {@link LIMIT}) so a closed list stays hidden across reloads until its content changes.
 */
export class TodoDismissals {
	readonly #memento: DismissalMemento;

	constructor(memento: DismissalMemento) {
		this.#memento = memento;
	}

	list(): string[] {
		const stored = this.#memento.get<unknown>(STORAGE_KEY);
		return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
	}

	async add(key: string): Promise<void> {
		await this.#memento.update(STORAGE_KEY, [key, ...this.list().filter(other => other !== key)].slice(0, LIMIT));
	}
}
