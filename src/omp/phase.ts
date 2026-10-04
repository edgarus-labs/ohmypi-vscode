import type { PromptOutcome, SessionPhase } from "./api";
import type { PromptResultFrame } from "./protocol";

interface Ticket {
	admitted: boolean;
	resolve(outcome: PromptOutcome): void;
}

/**
 * Prompt tickets and the session phase machine documented on `SessionPhase`.
 * A prompt completes only through its own `prompt_result`, local completion
 * (`agentInvoked: false`), a command failure, or termination.
 */
export class PromptTracker {
	readonly #tickets = new Map<string, Ticket>();
	#runActive = false;
	#settlePending = false;
	#aborting = false;
	#phase: SessionPhase = "idle";

	constructor(private readonly onPhase: (phase: SessionPhase) => void) {}

	get phase(): SessionPhase {
		return this.#phase;
	}

	submit(id: string): Promise<PromptOutcome> {
		const { promise, resolve } = Promise.withResolvers<PromptOutcome>();
		this.#tickets.set(id, { admitted: false, resolve });
		this.#update();
		return promise;
	}

	/** Successful `prompt` response. */
	acknowledged(id: string, agentInvoked: boolean | undefined): void {
		const ticket = this.#tickets.get(id);
		if (!ticket) return;
		if (agentInvoked === false) this.#complete(id, { status: "local", sessionSettled: true });
		else ticket.admitted = true;
		this.#update();
	}

	/** Failed `prompt` response (not admitted). */
	rejected(id: string, error: string): void {
		this.#complete(id, { status: "error", error, sessionSettled: true });
		this.#update();
	}

	agentStart(): void {
		this.#runActive = true;
		this.#settlePending = true;
		this.#update();
	}

	agentEnd(yielded: boolean): void {
		if (yielded) {
			this.#runActive = false;
			if (this.#tickets.size === 0) this.#aborting = false;
		}
		this.#update();
	}

	promptResult(frame: PromptResultFrame): void {
		if (frame.id !== undefined) {
			this.#complete(frame.id, {
				status: frame.status,
				...(frame.error ? { error: frame.error.message } : {}),
				sessionSettled: frame.sessionSettled,
			});
		}
		if (frame.sessionSettled) {
			this.#settlePending = false;
			this.#runActive = false;
		} else if (frame.agentInvoked) {
			this.#settlePending = true;
		}
		if (this.#tickets.size === 0) this.#aborting = false;
		this.#update();
	}

	sessionSettled(): void {
		this.#settlePending = false;
		this.#runActive = false;
		if (this.#tickets.size === 0) this.#aborting = false;
		this.#update();
	}

	abortRequested(): void {
		if (this.#phase === "idle") return;
		this.#aborting = true;
		this.#update();
	}

	/** The process went away: every open prompt resolves with `error`. */
	terminate(error: string): void {
		for (const id of [...this.#tickets.keys()]) this.#complete(id, { status: "error", error, sessionSettled: true });
		this.#runActive = false;
		this.#settlePending = false;
		this.#aborting = false;
		this.#update();
	}

	#complete(id: string, outcome: PromptOutcome): void {
		const ticket = this.#tickets.get(id);
		if (!ticket) return;
		this.#tickets.delete(id);
		ticket.resolve(outcome);
	}

	#update(): void {
		const phase = this.#derive();
		if (phase === this.#phase) return;
		this.#phase = phase;
		this.onPhase(phase);
	}

	#derive(): SessionPhase {
		const busy = this.#tickets.size > 0 || this.#runActive;
		if (this.#aborting && busy) return "aborting";
		if (this.#runActive) return "running";
		if (this.#tickets.size > 0) {
			for (const ticket of this.#tickets.values()) if (ticket.admitted) return "running";
			return "submitting";
		}
		return this.#settlePending ? "yielded" : "idle";
	}
}
