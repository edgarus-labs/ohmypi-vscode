/** Object guard for untyped values (decoded wire frames, tool args/details); fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
