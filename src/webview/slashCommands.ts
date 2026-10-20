import type { SlashCommandView } from "../omp/api";

/** Rows the autocomplete list renders at most. */
export const MAX_SLASH_ROWS = 50;

export interface SlashSuggestion {
	/** Command name without `/`, or subcommand name. */
	name: string;
	/** Replacement for the current token. */
	insert: string;
	/** The alias whose prefix matched the query. */
	alias?: string;
	hint?: string;
	description?: string;
	/** Source of non-builtin commands (e.g. `skill`). */
	badge?: string;
}

/** Suggestions for the token around the caret, which spans `start`..`end` of the text. */
export interface SlashMenu {
	level: "command" | "subcommand";
	start: number;
	end: number;
	items: SlashSuggestion[];
}

interface Candidate {
	name: string;
	aliases: readonly string[];
	suggestion: Omit<SlashSuggestion, "alias">;
}

/**
 * Candidates whose name starts with `query`, then those with an alias starting with it, then those
 * whose name contains it; case-insensitive, each group in the given order, capped at {@link MAX_SLASH_ROWS}.
 */
function rank(candidates: readonly Candidate[], query: string): SlashSuggestion[] {
	const needle = query.toLowerCase();
	const groups: SlashSuggestion[][] = [[], [], []];
	for (const candidate of candidates) {
		const name = candidate.name.toLowerCase();
		if (name.startsWith(needle)) {
			groups[0].push(candidate.suggestion);
			continue;
		}
		const alias = candidate.aliases.find(each => each.toLowerCase().startsWith(needle));
		if (alias !== undefined) groups[1].push({ ...candidate.suggestion, alias });
		else if (name.includes(needle)) groups[2].push(candidate.suggestion);
	}
	return groups.flat().slice(0, MAX_SLASH_ROWS);
}

/** End of the whitespace-free token that contains `caret`. */
function tokenEnd(text: string, caret: number): number {
	const match = /\s/.exec(text.slice(caret));
	return match ? caret + match.index : text.length;
}

/** The command a typed first token names exactly (name before alias), ignoring case. */
function findCommand(commands: readonly SlashCommandView[], typed: string): SlashCommandView | undefined {
	const wanted = typed.toLowerCase();
	return (
		commands.find(command => command.name.toLowerCase() === wanted) ??
		commands.find(command => command.aliases.some(alias => alias.toLowerCase() === wanted))
	);
}

/**
 * The autocomplete for `text` with the caret at `caret`: commands while the caret is in a first token
 * that starts with `/`, subcommands while it is in the token after `/name ` of a command that has any.
 */
export function slashMenu(text: string, caret: number, commands: readonly SlashCommandView[]): SlashMenu | undefined {
	if (commands.length === 0 || !text.startsWith("/")) return undefined;
	const before = text.slice(0, caret);
	if (/^\/\S*$/.test(before)) {
		const candidates = commands.map(command => ({
			name: command.name,
			aliases: command.aliases,
			suggestion: {
				name: command.name,
				insert: `/${command.name} `,
				hint: command.hint,
				description: command.description,
				badge: command.source === "builtin" ? undefined : command.source,
			},
		}));
		return { level: "command", start: 0, end: tokenEnd(text, caret), items: rank(candidates, before.slice(1)) };
	}
	const second = /^\/(\S+) +(\S*)$/.exec(before);
	if (!second) return undefined;
	const command = findCommand(commands, second[1]);
	if (!command || command.subcommands.length === 0) return undefined;
	const candidates = command.subcommands.map(subcommand => ({
		name: subcommand.name,
		aliases: [],
		suggestion: { name: subcommand.name, insert: `${subcommand.name} `, hint: subcommand.usage, description: subcommand.description },
	}));
	return { level: "subcommand", start: caret - second[2].length, end: tokenEnd(text, caret), items: rank(candidates, second[2]) };
}

/** `text` with the menu's token replaced by the suggestion, and the caret right after it. */
export function acceptSuggestion(text: string, menu: SlashMenu, item: SlashSuggestion): { text: string; caret: number } {
	const rest = text.slice(menu.end);
	const head = text.slice(0, menu.start) + item.insert;
	return { text: head + (rest.startsWith(" ") ? rest.slice(1) : rest), caret: head.length };
}

/** The text up to its first whitespace. */
export function firstToken(text: string): string {
	return text.slice(0, tokenEnd(text, 0));
}
