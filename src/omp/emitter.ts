import type { Disposable, Event } from "./api";

/** Minimal typed event emitter producing `vscode.Event`-shaped subscriptions. */
export class Emitter<T> {
	readonly #listeners = new Set<(value: T) => void>();

	/**
	 * @param onListenerError receives listener exceptions; without it the first
	 * exception is rethrown after every listener has run.
	 */
	constructor(private readonly onListenerError?: (error: unknown) => void) {}

	readonly event: Event<T> = (listener): Disposable => {
		this.#listeners.add(listener);
		return { dispose: () => this.#listeners.delete(listener) };
	};

	fire(value: T): void {
		let firstError: { error: unknown } | undefined;
		for (const listener of [...this.#listeners]) {
			try {
				listener(value);
			} catch (error) {
				if (this.onListenerError) this.onListenerError(error);
				else firstError ??= { error };
			}
		}
		if (firstError) throw firstError.error;
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
