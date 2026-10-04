import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "../ui/guards";

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** Absolute filesystem path for a tool path argument; `undefined` for URLs/internal schemes. */
export function resolveToolPath(raw: string, cwd: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed || SCHEME_URL.test(trimmed)) return undefined;
	const expanded = trimmed === "~" || trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
	return path.resolve(cwd, expanded);
}

/** Raw path strings named by tool arguments (not yet resolved). */
export function toolArgPaths(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const found = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === "string" && value.trim()) found.add(value.trim());
	};
	add(args.path);
	add(args.file);
	if (Array.isArray(args.paths)) args.paths.forEach(add);
	add(args.oldPath);
	add(args.newPath);
	if (Array.isArray(args.edits)) for (const edit of args.edits) if (isRecord(edit)) add(edit.path);
	if (typeof args.input === "string") for (const match of args.input.matchAll(PATCH_HEADER)) add(match[1]);
	return [...found];
}

export interface ResultFile {
	path: string;
	oldText?: string;
}

/** Files reported by a tool result's `details` (edit/write/ast_edit shapes). */
export function toolResultFiles(details: unknown): ResultFile[] {
	if (!isRecord(details)) return [];
	const files = new Map<string, ResultFile>();
	const add = (value: unknown, oldText?: unknown) => {
		if (typeof value !== "string" || !value) return;
		const existing = files.get(value);
		if (existing) {
			if (existing.oldText === undefined && typeof oldText === "string") existing.oldText = oldText;
			return;
		}
		files.set(value, typeof oldText === "string" ? { path: value, oldText } : { path: value });
	};
	add(details.path, details.oldText);
	add(details.resolvedPath);
	if (Array.isArray(details.perFileResults)) {
		const sources: unknown[] = [];
		for (const entry of details.perFileResults) {
			if (!isRecord(entry)) continue;
			add(entry.path, entry.oldText);
			sources.push(entry.sourcePath);
		}
		sources.forEach(source => add(source));
	}
	add(details.sourcePath);
	return [...files.values()];
}

function lines(text: string | null): string[] {
	if (!text) return [];
	const parts = text.split(/\r?\n/);
	if (parts[parts.length - 1] === "") parts.pop();
	return parts;
}

/** Approximate `+a -d` line counts (multiset difference; ignores moves). */
export function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
	const counts = new Map<string, number>();
	for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of lines(after)) {
		const remaining = counts.get(line) ?? 0;
		if (remaining > 0) counts.set(line, remaining - 1);
		else added++;
	}
	let removed = 0;
	for (const remaining of counts.values()) removed += remaining;
	return { added, removed };
}
