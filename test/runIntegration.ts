import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
	const root = path.resolve(__dirname, "..", "..");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-it-"));
	const workspace = path.join(scratch, "workspace");
	const sessions = path.join(scratch, "sessions");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(sessions, { recursive: true });
	fs.writeFileSync(path.join(workspace, "sample.txt"), "alpha\nbeta\n");
	fs.mkdirSync(path.join(workspace, ".vscode"));
	const real = process.env.OMP_IT_REAL === "1";
	const executable = real ? (process.env.OMP_IT_EXECUTABLE ?? "") : path.join(root, "test", "fixtures", "fake-omp.mjs");
	fs.writeFileSync(
		path.join(workspace, ".vscode", "settings.json"),
		JSON.stringify({ "omp.executablePath": executable, "omp.startup": "newSession", "omp.logLevel": "debug" }),
	);
	const vscodeExecutablePath = process.env.OMP_IT_VSCODE ?? (await downloadAndUnzipVSCode({ version: "stable", cachePath: path.join(root, ".vscode-test") }));
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
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
