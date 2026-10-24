import * as assert from "node:assert/strict";
import { releaseVersionMismatches, singleVsix, vsixFileName } from "../../../scripts/releaseVersion";

const matching = {
	tag: "v1.4.1",
	packageVersion: "1.4.1",
	vsixFile: "edgarus-labs.ohmypi.vscode.v1.4.1.vsix",
	vsixPackageVersion: "1.4.1",
	vsixManifestVersion: "1.4.1",
};

describe("vsixFileName", () => {
	it("names the package edgarus-labs.ohmypi.vscode.v{version}.vsix", () => {
		assert.equal(vsixFileName("1.4.1"), "edgarus-labs.ohmypi.vscode.v1.4.1.vsix");
	});
});

describe("releaseVersionMismatches", () => {
	it("accepts a tag, package.json, VSIX manifests and file name that agree", () => {
		assert.deepEqual(releaseVersionMismatches(matching), []);
	});

	it("checks a build without a tag against the package.json version", () => {
		assert.deepEqual(releaseVersionMismatches({ ...matching, tag: undefined }), []);
		assert.equal(releaseVersionMismatches({ ...matching, tag: undefined, vsixManifestVersion: "1.4.0" }).length, 1);
	});

	it("reports every source that disagrees with the tag", () => {
		const mismatches = releaseVersionMismatches({
			tag: "v1.5.0",
			packageVersion: "1.4.1",
			vsixFile: "edgarus-labs.ohmypi.vscode.v1.4.1.vsix",
			vsixPackageVersion: "1.4.2",
			vsixManifestVersion: "1.4.3",
		});
		assert.equal(mismatches.length, 4);
		assert.match(mismatches[0], /package\.json version 1\.4\.1/);
		assert.match(mismatches[1], /file name edgarus-labs\.ohmypi\.vscode\.v1\.4\.1\.vsix .*v1\.5\.0/);
		assert.match(mismatches[2], /extension\/package\.json version 1\.4\.2/);
		assert.match(mismatches[3], /extension\.vsixmanifest version 1\.4\.3/);
	});

	it("rejects a tag that is not v followed by the version", () => {
		assert.match(releaseVersionMismatches({ ...matching, tag: "1.4.1" }).join("\n"), /tag "1\.4\.1"/);
	});
});

describe("singleVsix", () => {
	it("returns the only .vsix file and rejects none or several", () => {
		assert.equal(singleVsix(["notes.txt", "a.vsix"]), "a.vsix");
		assert.throws(() => singleVsix([]), /exactly one \.vsix/);
		assert.throws(() => singleVsix(["a.vsix", "b.vsix"]), /exactly one \.vsix.*a\.vsix, b\.vsix/);
	});
});
