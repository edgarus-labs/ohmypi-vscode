import { isRecord } from "../../shared/guards";

/** Why and where a debuggee stopped, from the DAP `stopped` event. */
export interface DebugStop {
	threadId?: number;
	reason: string;
	/** The adapter's explanation, e.g. the exception message. */
	text?: string;
}

/** What a debuggee did after an action: stopped again, ended, or kept running past the wait. */
export type DebugOutcome<S> = { kind: "stopped"; session: S; stop: DebugStop } | { kind: "ended" } | { kind: "running" };

interface Waiter<S> {
	sessionId: string | undefined;
	settle(outcome: DebugOutcome<S>): void;
}

/** DAP requests after which the debuggee runs. */
const RESUMING_REQUESTS: Record<string, true> = {
	continue: true,
	next: true,
	stepIn: true,
	stepOut: true,
	stepBack: true,
	reverseContinue: true,
	goto: true,
	restartFrame: true,
};

/**
 * Debug sessions as their adapters report them: which are stopped where, fed by a debug adapter
 * tracker's messages, and waits for the next stop or end after resuming one.
 */
export class DebugSessions<S extends { readonly id: string }> {
	readonly #sessions = new Map<string, { session: S; stop?: DebugStop }>();
	readonly #waiters = new Set<Waiter<S>>();

	track(session: S): void {
		this.#sessions.set(session.id, { session });
	}

	/** A message the adapter of session `sessionId` sent to VS Code. */
	onMessage(sessionId: string, message: unknown): void {
		if (!isRecord(message) || message.type !== "event") return;
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		const body = isRecord(message.body) ? message.body : {};
		switch (message.event) {
			case "stopped": {
				const text = typeof body.text === "string" ? body.text : typeof body.description === "string" ? body.description : undefined;
				const stop: DebugStop = {
					...(typeof body.threadId === "number" ? { threadId: body.threadId } : {}),
					reason: typeof body.reason === "string" ? body.reason : "unknown",
					...(text ? { text } : {}),
				};
				entry.stop = stop;
				for (const waiter of this.#waiters) waiter.settle({ kind: "stopped", session: entry.session, stop });
				return;
			}
			case "continued":
				if (body.allThreadsContinued === true || entry.stop?.threadId === undefined || body.threadId === entry.stop.threadId) entry.stop = undefined;
				return;
			case "terminated":
			case "exited":
				this.onEnded(sessionId);
		}
	}

	/** A message VS Code sent to the adapter of session `sessionId`: a request that resumes the debuggee ends its stop. */
	onClientMessage(sessionId: string, message: unknown): void {
		if (!isRecord(message) || message.type !== "request" || typeof message.command !== "string" || !Object.hasOwn(RESUMING_REQUESTS, message.command)) return;
		const entry = this.#sessions.get(sessionId);
		if (entry) entry.stop = undefined;
	}

	/** Session `sessionId` ended or its adapter exited. */
	onEnded(sessionId: string): void {
		this.#sessions.delete(sessionId);
		for (const waiter of this.#waiters) if (waiter.sessionId === undefined || waiter.sessionId === sessionId) waiter.settle({ kind: "ended" });
	}

	/** The stopped sessions, in the order they started. */
	stopped(): Array<{ session: S; stop: DebugStop }> {
		return [...this.#sessions.values()].flatMap(({ session, stop }) => (stop ? [{ session, stop }] : []));
	}

	/**
	 * Runs `act` and resolves with what follows: the next stop of any session, the end of session `sessionId`
	 * (of any session when omitted), or `running` once `timeoutMs` passed after `act` finished. The stop of
	 * `sessionId` is forgotten first, as `act` resumes it. Rejects with `act`'s failure or `signal`'s reason.
	 */
	async waitAfter(act: () => PromiseLike<unknown>, timeoutMs: number, signal: AbortSignal, sessionId?: string): Promise<DebugOutcome<S>> {
		signal.throwIfAborted();
		const entry = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
		if (entry) entry.stop = undefined;
		let timer: NodeJS.Timeout | undefined;
		let waiter: Waiter<S> | undefined;
		let onAbort: (() => void) | undefined;
		const outcome = new Promise<DebugOutcome<S>>((resolve, reject) => {
			waiter = { sessionId, settle: resolve };
			this.#waiters.add(waiter);
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([act(), outcome]);
			const timeout = new Promise<DebugOutcome<S>>(resolve => {
				timer = setTimeout(() => resolve({ kind: "running" }), timeoutMs);
			});
			return await Promise.race([outcome, timeout]);
		} finally {
			clearTimeout(timer);
			if (waiter) this.#waiters.delete(waiter);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
}
