/** `setStatus` key of OMP's tier router; the only status whose text is interpreted. */
export const TIER_STATUS_KEY = "tier";

const TIER_PREFIX = "tier: ";

/** `text` starts with `prefix` as a whole word: it is exactly `prefix` or a space follows it. */
function startsWithWord(text: string, prefix: string): boolean {
	return text.startsWith(prefix) && (text.length === prefix.length || text[prefix.length] === " ");
}

/**
 * Short text for the tier router's status: `router auto`, `router auto · <tier>`, `router off · subagents only`,
 * `router · classifier down` or the paused hint; any other text is returned unchanged.
 */
export function routerStatusText(text: string): string {
	if (startsWithWord(text, "tier-router: on")) return text.endsWith("(main off)") ? "router off · subagents only" : "router auto";
	if (isRouterPaused(text)) return "router paused · manual model, /tier-auto resumes";
	if (startsWithWord(text, "tier-router: service DOWN")) return "router · classifier down";
	if (text.startsWith(TIER_PREFIX)) {
		const tier = text.slice(TIER_PREFIX.length).split(" ")[0];
		return tier === "" ? text : `router auto · ${tier}`;
	}
	return text;
}

/** The router status says a manual model change paused it, so `/tier-auto` resumes it. */
export function isRouterPaused(text: string): boolean {
	return startsWithWord(text, "tier-router: paused");
}

/** The router status says it chooses the main model: on with main routing, or a tier verdict. */
export function isRouterRouting(text: string): boolean {
	return text.startsWith(TIER_PREFIX) || (startsWithWord(text, "tier-router: on") && !text.endsWith("(main off)"));
}

/** Text shown for an OMP status: the router mapping for the tier key, the raw text for any other key. */
export function statusDisplayText(key: string, text: string): string {
	return key === TIER_STATUS_KEY ? routerStatusText(text) : text;
}
