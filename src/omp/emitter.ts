import type { Disposable, Event } from "./api";

/**
 * Minimal typed event emitter producing `vscode.Event`-shaped subscriptions.
 * Every subscription is separate, even of the same function; a subscription
 * disposed during `fire` misses the rest of that delivery, and an emitter
 * disposed once accepts no new listeners.
 */
export class Emitter<T> {
	readonly #listeners = new Set<{ listener: (value: T) => void }>();
	#disposed = false;

	/**
	 * @param onListenerError receives listener exceptions; without it, or when it
	 * throws itself, the first such exception is rethrown after every listener has run.
	 */
	constructor(private readonly onListenerError?: (error: unknown) => void) {}

	readonly event: Event<T> = (listener): Disposable => {
		if (this.#disposed) return { dispose: () => undefined };
		const subscription = { listener };
		this.#listeners.add(subscription);
		return { dispose: () => this.#listeners.delete(subscription) };
	};

	fire(value: T): void {
		let firstError: { error: unknown } | undefined;
		for (const subscription of [...this.#listeners]) {
			if (!this.#listeners.has(subscription)) continue;
			try {
				subscription.listener(value);
			} catch (error) {
				if (!this.onListenerError) {
					firstError ??= { error };
					continue;
				}
				try {
					this.onListenerError(error);
				} catch (handlerError) {
					firstError ??= { error: handlerError };
				}
			}
		}
		if (firstError) throw firstError.error;
	}

	dispose(): void {
		this.#disposed = true;
		this.#listeners.clear();
	}
}
