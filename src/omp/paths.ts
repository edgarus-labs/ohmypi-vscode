import * as path from "node:path";

/** `~`, `~/rest` or `~\rest` resolved under `home` (joined with `pathApi`); any other path is returned unchanged. */
export function expandHome(raw: string, home: string, pathApi: path.PlatformPath = path): string {
	return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? pathApi.join(home, raw.slice(1)) : raw;
}
