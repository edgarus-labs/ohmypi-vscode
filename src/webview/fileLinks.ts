import type { WebviewMessage } from "./protocol";

export interface FileLinkTarget {
	path: string;
	line?: number;
}

/** `:12`, `:12:5` or `#L12` / `#L12-L20` after a path; group 1 or 2 is the line. */
const LOCATION = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DRIVE = /^[A-Za-z]:[\\/]/;
/** Rooted at `/`, `./`, `../`, `~/`, a drive or a UNC share: any last segment names a file. */
const ANCHORED = /^(?:\/(?!\/)|\.\.?[\\/]|~[\\/]|[A-Za-z]:[\\/]|\\\\(?!\\))/;
/** Whitespace, backticks, controls and glob characters never occur in a path worth linking. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not valid in a path link
const NOT_IN_PATH = /[\s`*?|\u0000-\u001f]/;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Lower-case extensions a bare file name (no directory part) must end with. Extensions that are also common
 * member names (`log`, `map`, `env`, `lock`, `props`, `diff`, …) are left out so `console.log` or `process.env` stay code.
 */
const BARE_NAME_EXTENSIONS: Record<string, true> = Object.fromEntries(
	(
		"ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx markdown txt rst css scss sass less html htm xml svg " +
		"yml yaml toml ini cfg py pyi ipynb rs go java kt kts scala groovy gradle cs csproj fsproj vbproj sln " +
		"fsx vb c cc cpp cxx h hh hpp hxx swift dart rb php lua sh bash zsh fish ps1 psm1 psd1 bat " +
		"sql graphql gql proto vue svelte astro exs erl hrl hs clj cljs zig nim tf tfvars nix csv tsv png jpg jpeg " +
		"gif webp ico pdf wasm vsix"
	)
		.split(" ")
		.map(extension => [extension, true]),
);
const BARE_NAME = /^[A-Za-z0-9_@+-][\w.@+-]*\.([a-z0-9]{1,8})$/;

/**
 * The file a piece of chat text names, or `undefined` when it does not look like a file path:
 * - anchored paths (`/a/b`, `./a`, `../a`, `~/a`, `C:\a`, `d:/a`, `\\server\share\a`) with a non-empty last segment,
 *   except a single segment under `/` without an extension (`/rules` is a slash command);
 * - relative paths with a directory part whose last segment has a 1–8 character alphanumeric extension (`src/a.ts`);
 * - bare names whose extension is in {@link BARE_NAME_EXTENSIONS} (`extension.ts`, not `omp.extraArgs` or `console.log`).
 * Each may end in `:line`, `:line:col` or `#Lline`. URLs and other `scheme:` texts, `//host` paths,
 * texts with whitespace, backticks or glob characters, and paths ending in a separator are never files.
 */
export function fileLinkTarget(text: string): FileLinkTarget | undefined {
	if (!text || NOT_IN_PATH.test(text)) return undefined;
	const location = LOCATION.exec(text);
	const path = location ? text.slice(0, location.index) : text;
	const lineNumber = Number(location?.[1] ?? location?.[2] ?? 0);
	if (!path || /[\\/]$/.test(path) || (SCHEME.test(path) && !DRIVE.test(path))) return undefined;
	const linked = ANCHORED.test(path)
		? !/^\/[^\\/]*$/.test(path) || EXTENSION.test(path)
		: /[\\/]/.test(path)
			? !path.startsWith("/") && EXTENSION.test(path.split(/[\\/]/).pop() ?? "")
			: BARE_NAME_EXTENSIONS[BARE_NAME.exec(path)?.[1] ?? ""] === true;
	if (!linked) return undefined;
	return lineNumber > 0 ? { path, line: lineNumber } : { path };
}

/**
 * Click or Enter on any `.file-link` or `.web-link` below `root` asks the host to open its file or URL
 * (the host decides whether the URL may open) instead of navigating.
 */
export function listenForLinks(root: HTMLElement, post: (message: WebviewMessage) => void): void {
	const open = (event: Event) => {
		const link = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".file-link, .web-link") : null;
		if (!link || !root.contains(link)) return;
		const url = link.classList.contains("web-link") ? link.dataset.url : undefined;
		const path = url === undefined ? link.dataset.path : undefined;
		if (!url && !path) return;
		event.preventDefault();
		event.stopPropagation();
		if (url) {
			post({ type: "openExternal", url });
			return;
		}
		const line = Number(link.dataset.line);
		if (path) post(line > 0 ? { type: "openFile", path, line } : { type: "openFile", path });
	};
	root.addEventListener("click", open);
	root.addEventListener("keydown", event => {
		if (event.key === "Enter") open(event);
	});
}
