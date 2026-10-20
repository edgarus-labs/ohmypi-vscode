import type { TranscriptItem, TurnStatus, UsageView } from "./api";
import type { AssistantMessage, StopReason } from "./protocol";

export type TurnSummaryItem = Extract<TranscriptItem, { kind: "turn_summary" }>;

/** A token count OMP reported, or 0 for a missing or malformed one. */
function tokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Usage and last stop reason of the assistant messages of one turn. */
export class TurnTally {
	readonly usage: UsageView = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	#lastStop: StopReason | undefined;

	add(message: AssistantMessage): void {
		this.#lastStop = message.stopReason;
		const usage = message.usage;
		if (!usage) return;
		this.usage.input += tokens(usage.input);
		this.usage.output += tokens(usage.output);
		this.usage.cacheRead += tokens(usage.cacheRead);
		this.usage.cacheWrite += tokens(usage.cacheWrite);
		const cost = usage.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) this.usage.costUsd = (this.usage.costUsd ?? 0) + cost;
	}

	/** Whether the last reply asked for tools, so the agent was still working when it was recorded. */
	get calledTools(): boolean {
		return this.#lastStop === "toolUse";
	}

	/** The status the replies imply when OMP reported no outcome; `aborting` when the user asked to stop. */
	impliedStatus(aborting: boolean): TurnStatus {
		if (this.#lastStop === "aborted" || aborting) return "aborted";
		return this.#lastStop === "error" ? "error" : "completed";
	}

	summary(id: string, status: TurnStatus, durationMs: number | undefined): TurnSummaryItem {
		return { kind: "turn_summary", id, status, ...(durationMs === undefined ? {} : { durationMs }), usage: { ...this.usage } };
	}
}

interface StoredTurn {
	tally: TurnTally;
	/** Timestamp of the turn's first message. */
	startedAt: number | undefined;
	/** Latest timestamp of the turn's assistant and tool result messages. */
	lastAt: number | undefined;
	/** Item index after the turn's last assistant message and its tool calls. */
	end: number;
	/** Item id of the turn's last assistant message. */
	lastReplyId: string;
}

function timestampOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Splits a stored conversation into turns while it is mapped to items. A user message starts a turn
 * unless the run it follows was still calling tools: then it steered that run. A turn ends with an
 * assistant message that called no tools; another assistant message after it (background work waking
 * the agent) starts the next turn. The run the history ends in the middle of gets no summary.
 */
export class StoredTurns {
	#turn: StoredTurn | undefined;
	/** Set by a user message that starts the next turn: its timestamp, if any. */
	#prompt: { at: number | undefined } | undefined;
	readonly #summaries: Array<{ at: number; item: TurnSummaryItem }> = [];

	user(timestamp: unknown): void {
		if (this.#turn?.tally.calledTools) return;
		this.#close();
		this.#prompt = { at: timestampOf(timestamp) };
	}

	/** `end` is the item count once the message and its tool calls are mapped. */
	assistant(message: AssistantMessage, id: string, end: number): void {
		if (this.#turn !== undefined && !this.#turn.tally.calledTools) this.#close();
		if (this.#turn === undefined) {
			const startedAt = this.#prompt ? this.#prompt.at : timestampOf(message.timestamp);
			this.#prompt = undefined;
			this.#turn = { tally: new TurnTally(), startedAt, lastAt: undefined, end, lastReplyId: id };
		}
		this.#turn.tally.add(message);
		this.#turn.end = end;
		this.#turn.lastReplyId = id;
		this.#seen(message.timestamp);
	}

	toolResult(timestamp: unknown): void {
		this.#seen(timestamp);
	}

	/** `items` with the summary of every finished turn inserted after it. */
	withSummaries(items: readonly TranscriptItem[]): TranscriptItem[] {
		if (!this.#turn?.tally.calledTools) this.#close();
		const result: TranscriptItem[] = [];
		let next = 0;
		items.forEach((item, index) => {
			while (next < this.#summaries.length && this.#summaries[next].at === index) result.push(this.#summaries[next++].item);
			result.push(item);
		});
		for (; next < this.#summaries.length; next++) result.push(this.#summaries[next].item);
		return result;
	}

	#seen(timestamp: unknown): void {
		const at = timestampOf(timestamp);
		if (this.#turn && at !== undefined) this.#turn.lastAt = Math.max(this.#turn.lastAt ?? at, at);
	}

	#close(): void {
		const turn = this.#turn;
		this.#turn = undefined;
		this.#prompt = undefined;
		if (!turn) return;
		const { startedAt, lastAt } = turn;
		const durationMs = startedAt !== undefined && lastAt !== undefined && lastAt >= startedAt ? lastAt - startedAt : undefined;
		this.#summaries.push({ at: turn.end, item: turn.tally.summary(`${turn.lastReplyId}:turn`, turn.tally.impliedStatus(false), durationMs) });
	}
}
