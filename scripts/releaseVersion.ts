/** `edgarus-labs.{product}.{target}.v{version}.vsix`, the name of every packaged VSIX. */
export function vsixFileName(version: string): string {
	return `edgarus-labs.ohmypi.vscode.v${version}.vsix`;
}

export interface ReleaseVersions {
	/** The release tag (`v{version}`); absent for builds that are not tagged. */
	tag?: string;
	packageVersion: string;
	vsixFile: string;
	vsixPackageVersion: string;
	vsixManifestVersion: string;
}

/**
 * Every disagreement between the release version and the versions the package carries. The release
 * version comes from the tag when there is one, otherwise from package.json.
 */
export function releaseVersionMismatches(versions: ReleaseVersions): string[] {
	const mismatches: string[] = [];
	let expected = versions.packageVersion;
	let source = `package.json version ${versions.packageVersion}`;
	if (versions.tag !== undefined) {
		if (!versions.tag.startsWith("v") || versions.tag.length === 1) {
			return [`tag "${versions.tag}" is not v followed by the release version`];
		}
		expected = versions.tag.slice(1);
		source = `tag ${versions.tag}`;
		if (versions.packageVersion !== expected) {
			mismatches.push(`package.json version ${versions.packageVersion} does not match ${source}`);
		}
	}
	if (versions.vsixFile !== vsixFileName(expected)) {
		mismatches.push(`file name ${versions.vsixFile} is not ${vsixFileName(expected)} (${source})`);
	}
	if (versions.vsixPackageVersion !== expected) {
		mismatches.push(`extension/package.json version ${versions.vsixPackageVersion} does not match ${source}`);
	}
	if (versions.vsixManifestVersion !== expected) {
		mismatches.push(`extension.vsixmanifest version ${versions.vsixManifestVersion} does not match ${source}`);
	}
	return mismatches;
}

export function singleVsix(files: string[]): string {
	const vsixFiles = files.filter(file => file.endsWith(".vsix"));
	if (vsixFiles.length !== 1) {
		throw new Error(`expected exactly one .vsix file, found ${vsixFiles.length}: ${vsixFiles.join(", ")}`);
	}
	return vsixFiles[0];
}
