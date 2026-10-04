import * as esbuild from "esbuild";
import { globSync } from "glob";

const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const watch = args.has("--watch");

/** @type {esbuild.BuildOptions[]} */
const builds = args.has("--tests")
	? [
			{
				entryPoints: globSync("test/**/*.ts"),
				outdir: "out/test",
				outbase: "test",
				bundle: true,
				platform: "node",
				format: "cjs",
				target: "node20",
				sourcemap: true,
				external: ["vscode", "mocha", "@vscode/test-electron", "glob"],
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

for (const options of builds) {
	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
	} else {
		await esbuild.build(options);
	}
}
