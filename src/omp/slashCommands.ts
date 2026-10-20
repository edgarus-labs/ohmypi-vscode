import { isRecord } from "../shared/guards";
import type { SlashCommandView } from "./api";

const UNKNOWN_SOURCE = "unknown";

const isName = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Normalizes OMP's `commands` payload (`get_available_commands` result or
 * `available_commands_update` frame) into views, keeping OMP order. Entries
 * without a usable name are dropped; malformed optional fields fall back to
 * empty defaults. Returns `undefined` when the payload is not a list at all.
 */
export function toSlashCommands(value: unknown): SlashCommandView[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const commands: SlashCommandView[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isName(entry.name)) continue;
		const view: SlashCommandView = {
			name: entry.name,
			source: isName(entry.source) ? entry.source : UNKNOWN_SOURCE,
			aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(isName) : [],
			subcommands: Array.isArray(entry.subcommands) ? entry.subcommands.flatMap(toSubcommand) : [],
		};
		const description = optionalString(entry.description);
		if (description !== undefined) view.description = description;
		const hint = isRecord(entry.input) ? optionalString(entry.input.hint) : undefined;
		if (hint !== undefined) view.hint = hint;
		commands.push(view);
	}
	return commands;
}

function toSubcommand(value: unknown): SlashCommandView["subcommands"] {
	if (!isRecord(value) || !isName(value.name)) return [];
	const sub: { name: string; description?: string; usage?: string } = { name: value.name };
	const description = optionalString(value.description);
	if (description !== undefined) sub.description = description;
	const usage = optionalString(value.usage);
	if (usage !== undefined) sub.usage = usage;
	return [sub];
}
