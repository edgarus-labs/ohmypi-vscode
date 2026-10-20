export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Log-ready description of a failure: the stack (or `name: message`), followed by
 * the string `code`/`command` fields that OMP request errors and Node system errors carry.
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const text = error.stack ?? `${error.name}: ${error.message}`;
	const fields: Record<string, unknown> = { ...error };
	const tags = ["code", "command"].flatMap(key => (typeof fields[key] === "string" && fields[key] ? [`${key}=${fields[key]}`] : []));
	return tags.length === 0 ? text : `${text} [${tags.join(" ")}]`;
}
