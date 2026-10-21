import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write an executable named `name` into `dir` that runs `script` with the
 * current Node, shaped like an installed launcher: a `.cmd` shim on Windows
 * (as npm installs `omp.cmd`), a shell script elsewhere.
 * @returns The launcher path.
 */
export function writeNodeLauncher(dir: string, name: string, script: string): string {
	if (process.platform === "win32") {
		const file = path.join(dir, `${name}.cmd`);
		fs.writeFileSync(file, `@"${process.execPath}" "${script}" %*\r\n`);
		return file;
	}
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
	return file;
}
