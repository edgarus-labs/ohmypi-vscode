import * as fs from "node:fs";
import * as path from "node:path";
import { createVSIX } from "@vscode/vsce";
import { readVSIXPackage } from "@vscode/vsce/out/zip.js";
import { releaseVersionMismatches, singleVsix, vsixFileName } from "./releaseVersion.ts";

const outDir = "dist-vsix";
const [command, tag] = process.argv.slice(2);
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

async function verify(tag) {
	const vsixFile = singleVsix(fs.readdirSync(outDir));
	const { manifest, xmlManifest } = await readVSIXPackage(path.join(outDir, vsixFile));
	const mismatches = releaseVersionMismatches({
		tag,
		packageVersion,
		vsixFile,
		vsixPackageVersion: manifest.version,
		vsixManifestVersion: xmlManifest.PackageManifest.Metadata[0].Identity[0].$.Version,
	});
	if (mismatches.length > 0) {
		for (const mismatch of mismatches) console.error(`Version mismatch: ${mismatch}`);
		process.exit(1);
	}
	console.log(`${vsixFile}: package.json, VSIX manifests and file name agree with ${tag ?? packageVersion}`);
}

switch (command) {
	case "name":
		console.log(vsixFileName(packageVersion));
		break;
	case "package":
		fs.mkdirSync(outDir, { recursive: true });
		await createVSIX({ packagePath: path.join(outDir, vsixFileName(packageVersion)), dependencies: false });
		break;
	case "verify":
		await verify(tag);
		break;
	default:
		console.error("usage: node scripts/vsix.mjs name | package | verify [tag]");
		process.exit(2);
}
