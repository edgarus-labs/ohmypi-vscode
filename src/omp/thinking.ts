import type { Logger } from "./api";
import type { OmpRpcClient } from "./client";

/** OMP's per-turn effort selector (`ConfiguredThinkingLevel` "auto"). */
export const AUTO_THINKING = "auto";

const JOURNAL_TIMEOUT_MS = 60_000;

/**
 * Selectors offered for `levels` (OMP's discovered efforts). OMP's discovery omits its
 * `auto` selector; OMP offers it (after `off`) for every reasoning model, as in
 * `getAvailableEffortSelectors`.
 */
export function selectableLevels(levels: string[], reasoning: boolean): string[] {
	if (!reasoning || levels.length === 0 || levels.includes(AUTO_THINKING)) return levels;
	const afterOff = levels.indexOf("off") + 1;
	return [...levels.slice(0, afterOff), AUTO_THINKING, ...levels.slice(afterOff)];
}

/**
 * The user's selector for the bound session. `get_state` reports only the effective level
 * (`effective`), so `auto` is recovered from the newest journaled `thinking_level_change`
 * entry (`configured`, else its level); an unreadable journal falls back to `effective`.
 */
export async function journaledThinkingSelector(client: OmpRpcClient, effective: string | undefined, logger: Logger): Promise<string | undefined> {
	try {
		const { entries } = await client.request("get_entries", undefined, { timeoutMs: JOURNAL_TIMEOUT_MS });
		const latest = entries.findLast(entry => entry.type === "thinking_level_change");
		return latest?.configured ?? latest?.thinkingLevel ?? effective;
	} catch (error) {
		logger.warn("Reading the effort selector from the session journal failed; showing the effective level", error);
		return effective;
	}
}
