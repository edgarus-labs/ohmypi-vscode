import { isRecord } from "./guards";

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

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
		sources.forEach(source => {
			add(source);
		});
	}
	add(details.sourcePath);
	return [...files.values()];
}
