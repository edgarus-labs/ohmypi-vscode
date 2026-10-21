import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

const argv = process.argv.slice(2);
const args = new Set(argv);
const production = args.has("--production");
const watch = args.has("--watch");
const outdirArg = argv.find(arg => arg.startsWith("--outdir="));
const testOutdir = outdirArg ? outdirArg.slice("--outdir=".length) : "out/test";
const outRelative = path.relative("out", testOutdir);
if (outRelative === "" || outRelative.startsWith("..") || path.isAbsolute(outRelative)) {
	throw new Error(`--outdir must name a directory inside out/ (got "${testOutdir}")`);
}

/** Files under `dir` (recursive, `/`-separated) whose name passes `accept`. */
function filesUnder(dir, accept) {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && accept(entry.name))
		.map(entry => path.join(entry.parentPath, entry.name).split(path.sep).join("/"))
		.sort();
}

const isTestFile = name => name.endsWith(".test.ts");

/** @type {esbuild.BuildOptions} */
const testDefaults = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	sourcemap: true,
};

/** @type {esbuild.BuildOptions[]} */
const builds = args.has("--tests")
	? [
			{
				// Unit tests run in plain Node: `vscode` resolves to the recording stub.
				...testDefaults,
				entryPoints: filesUnder("test/unit", isTestFile),
				outdir: path.join(testOutdir, "unit"),
				outbase: "test/unit",
				alias: { vscode: "./test/unit/stubs/vscode.ts" },
			},
			{
				// The integration runner and the suites it loads into a real VS Code.
				...testDefaults,
				entryPoints: ["test/runIntegration.ts", "test/integration/index.ts", ...filesUnder("test/integration", isTestFile)],
				outdir: testOutdir,
				outbase: "test",
				external: ["vscode", "mocha-host", "@vscode/test-electron"],
			},
		]
	: [
			{
				entryPoints: ["src/extension.ts"],
				outfile: "dist/extension.js",
				bundle: true,
				platform: "node",
				format: "cjs",
				target: "node20",
				external: ["vscode"],
				sourcemap: !production,
				minify: production,
			},
			{
				entryPoints: ["src/webview/main.ts"],
				outfile: "dist/webview.js",
				bundle: true,
				platform: "browser",
				format: "iife",
				target: "es2022",
				sourcemap: !production,
				minify: production,
			},
		];

// A fresh test output keeps compiled suites of deleted tests from running.
if (args.has("--tests") && !watch) fs.rmSync(testOutdir, { recursive: true, force: true });

for (const options of builds) {
	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
	} else {
		await esbuild.build(options);
	}
}
