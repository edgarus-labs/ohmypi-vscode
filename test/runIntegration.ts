import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { writeNodeLauncher } from "./fixtures/launcher";

/** The VS Code release the suite runs against unless `--vscode-version` or `OMP_IT_VSCODE_VERSION` names another. */
const DEFAULT_VSCODE_VERSION = "1.140.0";

/** The repository root: the nearest ancestor of the compiled runner holding `package.json`. */
function repositoryRoot(): string {
	for (let dir = __dirname; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		if (path.dirname(dir) === dir) throw new Error(`No package.json above ${__dirname}`);
	}
}

/**
 * `--vscode-version=<version>` (or `OMP_IT_VSCODE_VERSION`); `min` is the lowest
 * release `engines.vscode` admits, e.g. `1.106.0` for `^1.106.0`.
 */
function vscodeVersion(root: string): string {
	const requested = process.argv.find(arg => arg.startsWith("--vscode-version="))?.slice("--vscode-version=".length) ?? process.env.OMP_IT_VSCODE_VERSION ?? DEFAULT_VSCODE_VERSION;
	if (requested !== "min") return requested;
	const engine: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines?.vscode;
	const minimum = typeof engine === "string" ? /^\^?(\d+\.\d+\.\d+)$/.exec(engine)?.[1] : undefined;
	if (!minimum) throw new Error(`Cannot derive the minimum VS Code version from engines.vscode ${JSON.stringify(engine)}`);
	return minimum;
}

async function main(): Promise<void> {
	const root = repositoryRoot();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-it-"));
	const workspace = path.join(scratch, "workspace");
	const sessions = path.join(scratch, "sessions");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(sessions, { recursive: true });
	fs.writeFileSync(path.join(workspace, "sample.txt"), "alpha\nbeta\n");
	fs.mkdirSync(path.join(workspace, ".vscode"));
	const real = process.argv.includes("--real");
	const executable = real ? (process.env.OMP_IT_EXECUTABLE ?? "") : fakeOmpExecutable(root, scratch);
	fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({ "omp.startup": "newSession", "omp.logLevel": "debug" }));
	const userSettings = path.join(scratch, "user-data", "User");
	fs.mkdirSync(userSettings, { recursive: true });
	fs.writeFileSync(path.join(userSettings, "settings.json"), JSON.stringify({ "omp.executablePath": executable }));
	try {
		const vscodeExecutablePath =
			process.env.OMP_IT_VSCODE ?? (await downloadAndUnzipVSCode({ version: vscodeVersion(root), cachePath: path.join(root, ".vscode-test") }));
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: process.env.OMP_IT_EXTENSION_PATH ?? root,
			extensionTestsPath: path.join(__dirname, "integration", "index.js"),
			launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", path.join(scratch, "user-data"), "--no-sandbox", "--disable-gpu"],
			extensionTestsEnv: {
				FAKE_OMP_SESSION_DIR: sessions,
				FAKE_OMP_LOG: path.join(scratch, "fake-omp.log"),
				OMP_IT_WORKSPACE: workspace,
				OMP_IT_SUITE: real ? "real.test.js" : "extension.test.js",
			},
		});
	} finally {
		removeScratch(scratch);
	}
}

/** Deletes the run's workspace, sessions, fake-OMP log and VS Code profile unless `--keep-scratch` asks to inspect them. */
function removeScratch(scratch: string): void {
	if (process.argv.includes("--keep-scratch")) {
		console.log(`Kept the integration scratch directory ${scratch}`);
		return;
	}
	try {
		// VS Code's helper processes may still hold files in its profile for a moment after the run.
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (error) {
		console.warn(`Could not remove the integration scratch directory ${scratch}: ${String(error)}`);
	}
}

/** Windows cannot spawn the fake script directly, so it gets a `.cmd` launcher there. */
function fakeOmpExecutable(root: string, scratch: string): string {
	const script = path.join(root, "test", "fixtures", "fake-omp.mjs");
	return process.platform === "win32" ? writeNodeLauncher(scratch, "fake-omp", script) : script;
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
