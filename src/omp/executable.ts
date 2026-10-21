import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "./paths";

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

/** What Windows can spawn: executables directly, `.cmd`/`.bat` launchers through cmd.exe. */
const WINDOWS_LAUNCHABLE = /\.(exe|com|cmd|bat)$/i;

/**
 * Locate the `omp` executable. A configured path must be absolute (after `~`
 * expansion) and exist; on Windows it must also end in `.exe`, `.com`, `.cmd`
 * or `.bat`. Otherwise PATH is searched, then `~/.local/bin` and `~/.bun/bin`.
 * @throws Error naming the rejected configured path or every location that was tried.
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
		const expanded = expandHome(trimmed, home, pathApi);
		if (!pathApi.isAbsolute(expanded)) {
			throw new Error(`omp.executablePath must be an absolute path or start with ~, but is relative: ${expanded}`);
		}
		if (win && !WINDOWS_LAUNCHABLE.test(expanded)) {
			throw new Error(`omp.executablePath must name a .exe, .com, .cmd or .bat file on Windows: ${expanded}`);
		}
		if (fileSystem.isExecutableFile(expanded)) return expanded;
		throw new Error(
			`The omp executable configured in omp.executablePath was not found or is not executable: ${expanded}`,
		);
	}

	const names = win ? ["omp.exe", "omp.cmd"] : ["omp"];
	const pathValue = win ? (env.Path ?? env.PATH ?? env.path) : env.PATH;
	const raw = pathValue ?? "";
	// Windows allows quoting a Path entry, which may then contain `;`; the quotes are not part of the directory.
	const entries = win ? (raw.match(/(?:"[^"]*"|[^;"])+/g) ?? []).map(dir => dir.replaceAll('"', "")) : raw.split(":");
	const dirs = entries.filter(dir => dir.length > 0);
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
