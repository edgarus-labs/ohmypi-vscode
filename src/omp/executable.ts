import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ExecutableFs {
	isExecutableFile(candidate: string): boolean;
}

const nodeFs: ExecutableFs = {
	isExecutableFile(candidate) {
		try {
			if (!fs.statSync(candidate).isFile()) return false;
			if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
};

/**
 * Locate the `omp` executable. A configured path must exist; otherwise PATH is
 * searched, then `~/.local/bin` and `~/.bun/bin`.
 * @throws Error naming every location that was tried.
 */
export function resolveExecutable(
	configured: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExecutableFs = nodeFs,
): string {
	const win = platform === "win32";
	const pathApi = win ? path.win32 : path.posix;
	const home = (win ? env.USERPROFILE : env.HOME) ?? env.HOME ?? os.homedir();
	const trimmed = configured?.trim();

	if (trimmed) {
		const expanded =
			trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? pathApi.join(home, trimmed.slice(1))
				: trimmed;
		if (fileSystem.isExecutableFile(expanded)) return expanded;
		throw new Error(
			`The omp executable configured in omp.executablePath was not found or is not executable: ${expanded}`,
		);
	}

	const names = win ? ["omp.exe", "omp.cmd", "omp"] : ["omp"];
	const pathValue = win ? (env.Path ?? env.PATH ?? env.path) : env.PATH;
	const dirs = (pathValue ?? "").split(win ? ";" : ":").filter(dir => dir.length > 0);
	dirs.push(pathApi.join(home, ".local", "bin"), pathApi.join(home, ".bun", "bin"));

	const tried: string[] = [];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = pathApi.join(dir, name);
			if (fileSystem.isExecutableFile(candidate)) return candidate;
			tried.push(candidate);
		}
	}
	throw new Error(
		`Could not find the omp executable. Install oh-my-pi or set omp.executablePath. Tried:\n${tried.map(p => `  ${p}`).join("\n")}`,
	);
}
