/**
 * Lexical coloring of code for reading: comments, strings, numbers, keywords, JSON, YAML and INI keys and XML tags,
 * by language family. It never parses, so cut or invalid code still colors; an unknown language gets strings and
 * numbers only, plain text none, and the tokens always cover the whole text in order.
 */

export type TokenKind = "text" | "comment" | "string" | "number" | "keyword" | "key" | "tag";

/** `code.slice(start, end)` is one token. */
export interface CodeToken {
	start: number;
	end: number;
	kind: TokenKind;
}

interface Syntax {
	lineComments: string[];
	/** Line comments start only at a line start or after whitespace (`#` inside a word is no comment). */
	commentsAfterSpace: boolean;
	blockComment?: { open: string; close: string };
	quotes: string;
	/** Quotes without escapes; a doubled quote stands for one. */
	rawQuotes: string;
	tripleQuotes: boolean;
	backtickEscapes: boolean;
	jsonKeys: boolean;
	/** Characters after a word at a line start that make it a key (YAML `:`, INI `=`/`:`). */
	keySeparators?: string;
	xml: boolean;
	/** Shell: the first word of a command and `$variables` are colored. */
	commands: boolean;
	/** Command words after which another command follows (`sudo`, `xargs`, …). */
	openers: Record<string, true>;
	keywords: Record<string, true>;
	ignoreCase: boolean;
}

const ALIASES: Record<string, string> = {
	cs: "csharp",
	"c#": "csharp",
	csharp: "csharp",
	js: "javascript",
	jsx: "javascript",
	javascript: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	typescript: "typescript",
	py: "python",
	python: "python",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	shell: "bash",
	console: "bash",
	ps: "powershell",
	ps1: "powershell",
	psm1: "powershell",
	pwsh: "powershell",
	powershell: "powershell",
	json: "json",
	jsonc: "json",
	json5: "json",
	xml: "xml",
	html: "xml",
	xaml: "xml",
	csproj: "xml",
	props: "xml",
	svg: "xml",
	razor: "xml",
	cshtml: "xml",
	vsct: "xml",
	slnx: "xml",
	yaml: "yaml",
	yml: "yaml",
	sql: "sql",
	go: "go",
	golang: "go",
	rs: "rust",
	rust: "rust",
	c: "c",
	h: "c",
	cpp: "c",
	hpp: "c",
	cc: "c",
	java: "c",
	kt: "c",
	kotlin: "c",
	swift: "c",
	php: "c",
	ini: "ini",
	toml: "ini",
	env: "ini",
	properties: "ini",
	editorconfig: "ini",
	gitignore: "bash",
	dockerfile: "bash",
	makefile: "bash",
	bat: "bash",
	cmd: "bash",
	css: "c",
	scss: "c",
	less: "c",
	dart: "c",
	scala: "c",
	groovy: "c",
	gradle: "c",
	proto: "c",
	graphql: "c",
	gql: "c",
	rb: "python",
	ruby: "python",
	lua: "python",
	r: "python",
	tf: "python",
	hcl: "python",
	pl: "python",
	perl: "python",
	vue: "xml",
	svelte: "xml",
	htm: "xml",
	xsd: "xml",
	xslt: "xml",
	plist: "xml",
	nuspec: "xml",
	targets: "xml",
	resx: "xml",
	config: "xml",
	axaml: "xml",
};

const PLAIN: Record<string, true> = words("text txt plain plaintext md markdown diff patch log output");

function words(list: string): Record<string, true> {
	return Object.fromEntries(list.split(" ").map(word => [word, true]));
}

function syntax(overrides: Partial<Syntax>): Syntax {
	return {
		lineComments: [],
		commentsAfterSpace: false,
		quotes: "\"'",
		rawQuotes: "",
		tripleQuotes: false,
		backtickEscapes: false,
		jsonKeys: false,
		xml: false,
		commands: false,
		openers: {},
		keywords: {},
		ignoreCase: false,
		...overrides,
	};
}

function cLike(keywords: string, quotes = "\"'"): Syntax {
	return syntax({ lineComments: ["//"], blockComment: { open: "/*", close: "*/" }, quotes, keywords: words(keywords) });
}

const SYNTAXES: Record<string, Syntax> = {
	csharp: cLike(
		"abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double dynamic else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long nameof namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using value var virtual void volatile when where while with yield",
	),
	javascript: cLike(
		"async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
		"\"'`",
	),
	typescript: cLike(
		"abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in instanceof interface is keyof let namespace never new null number of override private protected public readonly return satisfies static string super switch this throw true try type typeof undefined unknown var void while with yield",
		"\"'`",
	),
	c: cLike(
		"auto bool boolean break case catch char class const continue default define do double else enum extends extern false final finally float for fun goto if implements import include inline int interface long namespace new null nullptr override package private protected public return short signed sizeof static struct super switch template this throw throws true try typedef typename union unsigned using val var virtual void volatile while",
	),
	go: cLike(
		"break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
		"\"'`",
	),
	rust: cLike(
		"as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
	),
	python: syntax({
		lineComments: ["#"],
		tripleQuotes: true,
		keywords: words(
			"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self",
		),
	}),
	bash: syntax({
		lineComments: ["#"],
		commentsAfterSpace: true,
		quotes: "\"'`",
		rawQuotes: "'",
		commands: true,
		openers: words("if then else elif do while until time sudo exec nohup env xargs"),
		keywords: words("alias case cd declare do done echo elif else esac exit export fi for function if in local readonly return select set source then time unset until while"),
	}),
	powershell: syntax({
		lineComments: ["#"],
		commentsAfterSpace: true,
		blockComment: { open: "<#", close: "#>" },
		rawQuotes: "'",
		backtickEscapes: true,
		commands: true,
		keywords: words("begin break catch class continue do dynamicparam else elseif end enum filter finally for foreach from function if in param process return switch throw trap try until using while"),
		ignoreCase: true,
	}),
	sql: syntax({
		lineComments: ["--"],
		blockComment: { open: "/*", close: "*/" },
		keywords: words(
			"add all alter and as asc begin between by case check column commit constraint count create cross default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then top transaction union unique update values view when where with",
		),
		ignoreCase: true,
	}),
	json: syntax({ jsonKeys: true, keywords: words("true false null") }),
	yaml: syntax({ lineComments: ["#"], commentsAfterSpace: true, rawQuotes: "'", keySeparators: ":", keywords: words("true false null yes no on off ~") }),
	ini: syntax({ lineComments: ["#", ";"], commentsAfterSpace: true, rawQuotes: "'", keySeparators: "=:", keywords: words("true false") }),
	xml: syntax({ blockComment: { open: "<!--", close: "-->" }, rawQuotes: "\"'", xml: true }),
};

/** The first word of a fence info string or file extension, lower case; `undefined` when there is none. */
function label(language: string | undefined): string | undefined {
	const word = language?.trim();
	if (!word) return undefined;
	const cut = word.search(/[ \t{:]/);
	return (cut > 0 ? word.slice(0, cut) : word).toLowerCase();
}

/** The language family `language` (a fence info string or file extension) belongs to; `undefined` when it is unknown or plain text. */
export function normalizeLanguage(language: string | undefined): string | undefined {
	const word = label(language);
	return word === undefined || PLAIN[word] === true || !Object.hasOwn(ALIASES, word) ? undefined : ALIASES[word];
}

const TELLTALES: Array<[RegExp, string]> = [
	[
		/^[ \t]*(using\s+[\w.]+;|namespace\s+[\w.]+|(public|internal|private|protected)\s+(static\s+|sealed\s+|abstract\s+|async\s+|override\s+|virtual\s+|readonly\s+)*(class|interface|record|struct|enum|void|var|[A-Z]\w*(<[^>]*>)?(\[\])?)\s)/m,
		"csharp",
	],
	[/^[ \t]*(def\s+\w+\(|class\s+\w+(\(.*\))?:|import\s+[\w.]+\s*$|from\s+[\w.]+\s+import\s)/m, "python"],
	[/^[ \t]*(const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w*\s*\(|export\s+(default\s+|const\s+|function\s+|class\s+)|import\s+.*\sfrom\s+['"])/m, "javascript"],
	[/^[ \t]*(package\s+\w+$|func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\()/m, "go"],
];

/** Whether `trimmed` (non-empty, no leading whitespace) opens like a JSON object or array and ends with its closer. */
function looksLikeJson(trimmed: string): boolean {
	const close = trimmed[0] === "{" ? "}" : trimmed[0] === "[" ? "]" : "";
	if (!close || trimmed.length < 2) return false;
	const next = trimmed[1];
	return trimmed.trimEnd().endsWith(close) && (/\s|\d/.test(next) || '"{[]}-'.includes(next));
}

/**
 * The language of unlabeled code: JSON for text that opens with `{` or `[` followed by a quote, bracket, brace,
 * digit, minus or whitespace and ends with the matching closer; XML for text that opens with `<` followed by a
 * letter, `?` or `!`; else the family with a telltale line (a using or namespace line or a member declaration,
 * def/import, const/function, func/package) anywhere in the text; `undefined` otherwise.
 */
export function guessLanguage(text: string): string | undefined {
	const trimmed = text.trimStart();
	if (!trimmed) return undefined;
	if (looksLikeJson(trimmed)) return "json";
	if (trimmed[0] === "<" && /^[\p{L}?!]/u.test(trimmed.slice(1, 2))) return "xml";
	return TELLTALES.find(([pattern]) => pattern.test(trimmed))?.[1];
}

/**
 * The tokens of `code` in `language` (any alias; see {@link normalizeLanguage}), covering it whole and in order;
 * plain text labels such as `txt` or `log` give one text token.
 */
export function tokenize(code: string, language: string | undefined): CodeToken[] {
	if (!code) return [];
	const word = label(language);
	if (word !== undefined && PLAIN[word] === true) return [{ start: 0, end: code.length, kind: "text" }];
	const family = word !== undefined && Object.hasOwn(ALIASES, word) ? ALIASES[word] : undefined;
	return new Lexer(code, family ? SYNTAXES[family] : syntax({})).run();
}

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const WHITESPACE = /\s/;

function isWordStart(c: string): boolean {
	return LETTER.test(c) || c === "_" || c === "$" || c === "@";
}

function isWordChar(c: string): boolean {
	return LETTER_OR_DIGIT.test(c) || c === "_";
}

class Lexer {
	readonly #s: string;
	readonly #x: Syntax;
	readonly #out: CodeToken[] = [];
	#i = 0;
	#textStart = 0;
	#inTag = false;
	#commandNext = true;

	constructor(code: string, syntax: Syntax) {
		this.#s = code;
		this.#x = syntax;
	}

	run(): CodeToken[] {
		while (this.#i < this.#s.length) {
			if (this.#x.xml) this.#xmlStep();
			else this.#step();
		}
		this.#flushText(this.#s.length);
		return this.#out;
	}

	#step(): void {
		const s = this.#s;
		const x = this.#x;
		const c = s[this.#i];
		const command = this.#commandNext;
		if (x.commands) {
			this.#commandNext = "\n;|&({`".includes(c) || (command && WHITESPACE.test(c));
			if (c === "$" && this.#i + 1 < s.length && (isWordChar(s[this.#i + 1]) || "{_?@#!*".includes(s[this.#i + 1]))) {
				this.#emit(this.#variableEnd(), "key");
				return;
			}
			if (command && (isWordStart(c) || c === "." || c === "/" || c === "~" || c === "\\")) {
				let end = this.#i + 1;
				while (end < s.length && (isWordChar(s[end]) || "-./\\:~+".includes(s[end]))) end++;
				this.#commandNext = x.openers[s.slice(this.#i, end)] === true;
				this.#emit(end, "keyword");
				return;
			}
		}
		if (x.blockComment && this.#at(x.blockComment.open)) {
			const end = s.indexOf(x.blockComment.close, this.#i + x.blockComment.open.length);
			this.#emit(end < 0 ? s.length : end + x.blockComment.close.length, "comment");
			return;
		}
		if (this.#atLineComment()) {
			this.#emit(this.#lineEnd(), "comment");
			return;
		}
		if (x.quotes.includes(c) && (x.keySeparators === undefined || this.#scalarStartsAt(this.#i))) {
			const end = this.#stringEnd();
			this.#emit(end, x.jsonKeys && this.#nextNonSpace(end) === ":" ? "key" : "string");
			return;
		}
		if (DIGIT.test(c) || (c === "-" && this.#i + 1 < s.length && DIGIT.test(s[this.#i + 1]) && !isWordChar(this.#prev()))) {
			if (isWordChar(this.#prev())) {
				this.#i++;
				return;
			}
			let end = this.#i + 1;
			while (end < s.length && (LETTER_OR_DIGIT.test(s[end]) || s[end] === "." || s[end] === "_")) end++;
			this.#emit(end, "number");
			return;
		}
		if (isWordStart(c)) {
			let end = this.#i + 1;
			while (end < s.length && isWordChar(s[end])) end++;
			const word = s.slice(this.#i, end);
			if (x.keySeparators !== undefined && this.#atLineStart() && x.keySeparators.includes(this.#nextNonSpace(end) || "\0")) {
				this.#emit(end, "key");
			} else if (x.keywords[x.ignoreCase ? word.toLowerCase() : word] === true) {
				this.#emit(end, "keyword");
			} else {
				this.#i = end;
			}
			return;
		}
		this.#i++;
	}

	#xmlStep(): void {
		const s = this.#s;
		const c = s[this.#i];
		const nameChar = (ch: string) => isWordChar(ch) || ch === ":" || ch === "-" || ch === ".";
		if (!this.#inTag) {
			if (this.#at("<!--")) {
				const end = s.indexOf("-->", this.#i + 4);
				this.#emit(end < 0 ? s.length : end + 3, "comment");
			} else if (c === "<") {
				let end = this.#i + 1;
				while (end < s.length && "/?!".includes(s[end])) end++;
				while (end < s.length && nameChar(s[end])) end++;
				this.#emit(end, "tag");
				this.#inTag = true;
			} else {
				this.#i++;
			}
			return;
		}
		if (c === ">" || this.#at("/>") || this.#at("?>")) {
			this.#emit(c === ">" ? this.#i + 1 : this.#i + 2, "tag");
			this.#inTag = false;
			return;
		}
		if (c === '"' || c === "'") {
			this.#emit(this.#stringEnd(), "string");
			return;
		}
		if (isWordStart(c)) {
			let end = this.#i + 1;
			while (end < s.length && nameChar(s[end])) end++;
			this.#emit(end, "key");
			return;
		}
		this.#i++;
	}

	/**
	 * Index just past the string starting at the current quote: its matching quote (escapes skipped unless the
	 * quote is raw, where a doubled quote stands for one; a shell `$'…'` string keeps its escapes), the line
	 * end for a single-line quote, or the text end.
	 */
	#stringEnd(): number {
		const s = this.#s;
		const quote = s[this.#i];
		const tripleQuote = quote.repeat(3);
		const triple = this.#x.tripleQuotes && this.#at(tripleQuote);
		const raw = this.#x.rawQuotes.includes(quote) && !(this.#x.commands && this.#prev() === "$");
		const escape = raw ? "" : this.#x.backtickEscapes ? "`" : "\\";
		let j = this.#i + (triple ? 3 : 1);
		while (j < s.length) {
			const c = s[j];
			if (escape && c === escape && j + 1 < s.length) {
				j += 2;
				continue;
			}
			if (triple) {
				if (s.startsWith(tripleQuote, j)) return j + 3;
			} else if (c === quote) {
				if (raw && s[j + 1] === quote) {
					j += 2;
					continue;
				}
				return j + 1;
			} else if (c === "\n") {
				return j;
			}
			j++;
		}
		return s.length;
	}

	/** Index just past the shell variable at the current `$`: a braced name to its brace, else the name with a scope prefix like `env:`. */
	#variableEnd(): number {
		const s = this.#s;
		if (s[this.#i + 1] === "{") {
			const close = s.indexOf("}", this.#i + 2);
			return close < 0 ? this.#lineEnd() : close + 1;
		}
		let j = this.#i + 2;
		while (j < s.length && (isWordChar(s[j]) || (s[j] === ":" && j + 1 < s.length && isWordChar(s[j + 1])))) j++;
		return j;
	}

	#at(what: string): boolean {
		return this.#s.startsWith(what, this.#i);
	}

	#lineEnd(): number {
		const end = this.#s.indexOf("\n", this.#i);
		return end < 0 ? this.#s.length : end;
	}

	#prev(): string {
		return this.#i === 0 ? " " : this.#s[this.#i - 1];
	}

	/** Whether only indentation or YAML list dashes precede the current position on its line. */
	#atLineStart(): boolean {
		for (let k = this.#i - 1; k >= 0 && this.#s[k] !== "\n"; k--) {
			if (!" \t-".includes(this.#s[k])) return false;
		}
		return true;
	}

	/** Whether a line comment starts here: one of the syntax's markers, after whitespace when the syntax requires it. */
	#atLineComment(): boolean {
		if (this.#x.commentsAfterSpace && !WHITESPACE.test(this.#prev())) return false;
		return this.#x.lineComments.some(marker => this.#at(marker));
	}

	/**
	 * Whether a quote at `at` opens a YAML or INI scalar: at line start after indent, after `[`, `{` or `,`, after
	 * `=` when it separates keys, or after `:` or `-` followed by whitespace; a tag (`!Sub`) or anchor (`&n`) in
	 * front of the scalar is skipped.
	 */
	#scalarStartsAt(at: number): boolean {
		const s = this.#s;
		let k = at - 1;
		while (k >= 0 && (s[k] === " " || s[k] === "\t")) k--;
		if (k < 0 || s[k] === "\n") return true;
		const p = s[k];
		const spaced = k < at - 1;
		if (spaced) {
			let token = k;
			while (token > 0 && !WHITESPACE.test(s[token - 1])) token--;
			if (s[token] === "!" || (token < k && s[token] === "&")) return this.#scalarStartsAt(token);
		}
		return p === "[" || p === "{" || p === "," || (p === "=" && this.#x.keySeparators?.includes("=") === true) || (spaced && (p === ":" || p === "-"));
	}

	/** The first character at or after `from` that is not a space or tab; `""` at the text end. */
	#nextNonSpace(from: number): string {
		let k = from;
		while (k < this.#s.length && (this.#s[k] === " " || this.#s[k] === "\t")) k++;
		return k < this.#s.length ? this.#s[k] : "";
	}

	#emit(end: number, kind: TokenKind): void {
		this.#flushText(this.#i);
		this.#out.push({ start: this.#i, end, kind });
		this.#i = end;
		this.#textStart = end;
	}

	#flushText(upTo: number): void {
		if (upTo > this.#textStart) this.#out.push({ start: this.#textStart, end: upTo, kind: "text" });
		this.#textStart = upTo;
	}
}
