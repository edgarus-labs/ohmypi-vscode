import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "../omp/paths";

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Win32 device namespace (`\\?\…`, `\\.\…`). */
const DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;

/** Absolute filesystem path for a tool path argument; `undefined` for URLs/internal schemes. */
export function resolveToolPath(raw: string, cwd: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed || SCHEME_URL.test(trimmed)) return undefined;
	return path.resolve(cwd, expandHome(trimmed, os.homedir()));
}

/**
 * Comparison key of an absolute path: Windows paths are case-insensitive and VS Code lowercases the
 * drive letter in `Uri.fsPath`, so there the key is the normalized path in lower case.
 */
export function pathKey(filePath: string): string {
	return process.platform === "win32" ? path.win32.normalize(filePath).toLowerCase() : filePath;
}

/** Whether the absolute `filePath` is one of `roots` or below one. Win32 device paths never are. */
export function isWithinRoots(filePath: string, roots: readonly string[], pathApi: path.PlatformPath = path): boolean {
	if (DEVICE_PATH.test(filePath)) return false;
	return roots.some(root => {
		const relative = pathApi.relative(root, filePath);
		return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
	});
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
