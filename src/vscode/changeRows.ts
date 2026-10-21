import * as path from "node:path";
import type { TrackedChange } from "./changeModel";

export function changesSummary(count: number): string {
	return count === 0 ? "" : `${count} ${count === 1 ? "file" : "files"}`;
}

/** `M · src/auth · +3 −1`; the directory is relative to `cwd` when known. */
export function changeRowDescription(change: TrackedChange, cwd: string | undefined): string {
	const dir = path.dirname(change.path);
	const relative = cwd ? path.relative(cwd, dir) : dir;
	const parts: string[] = [change.status];
	if (relative && relative !== ".") parts.push(relative);
	if (change.status !== "D") parts.push(`+${change.added} −${change.removed}`);
	return parts.join(" · ");
}
