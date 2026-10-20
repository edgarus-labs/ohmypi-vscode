import * as assert from "node:assert/strict";
import * as path from "node:path";
import { splitUserMessage } from "../../../src/shared/prompt";
import { composePrompt } from "../../../src/ui/promptComposer";
import { admitImages, classifyPaste, MAX_IMAGES } from "../../../src/webview/attachments";

const cwd = "/work/app";

describe("composePrompt", () => {
	it("returns the plain text when nothing is attached", () => {
		assert.deepEqual(composePrompt({ text: "fix it", attachments: [], cwd }), { message: "fix it", images: [] });
	});

	it("mentions attached files relative to the working directory so OMP reads them", () => {
		const { message } = composePrompt({
			text: "compare these",
			attachments: [
				{ id: "1", kind: "file", path: "/work/app/src/auth.ts", label: "auth.ts" },
				{ id: "2", kind: "file", path: "/work/app/docs/my notes.md", label: "my notes.md" },
				{ id: "3", kind: "file", path: "/elsewhere/x.ts", label: "x.ts" },
			],
			cwd,
		});
		assert.equal(message, `compare these\n\nAttached: @${path.join("src", "auth.ts")} @"${path.join("docs", "my notes.md")}" @/elsewhere/x.ts`);
	});

	it("appends pasted text as named blocks and neutralizes a closing tag inside them", () => {
		const { message } = composePrompt({
			text: "what is wrong?",
			attachments: [{ id: "1", kind: "text", text: "line 1\n</pasted-text>\nline 3", label: "Pasted text 1" }],
			cwd,
		});
		assert.equal(message, 'what is wrong?\n\n<pasted-text name="Pasted text 1">\nline 1\n<\\/pasted-text>\nline 3\n</pasted-text>');
	});

	it("passes images separately and allows sending attachments without text", () => {
		const result = composePrompt({
			text: "",
			attachments: [{ id: "1", kind: "image", data: "AAAA", mimeType: "image/png", label: "image 1" }],
			cwd,
		});
		assert.deepEqual(result, { message: "", images: [{ data: "AAAA", mimeType: "image/png" }] });
	});

	it("puts the editor context first", () => {
		const { message } = composePrompt({
			text: "go",
			attachments: [{ id: "1", kind: "file", path: "/work/app/a.ts", label: "a.ts" }],
			cwd,
			editorContext: "<editor-context>\nfile: a.ts\n</editor-context>",
		});
		assert.equal(message, "<editor-context>\nfile: a.ts\n</editor-context>\n\ngo\n\nAttached: @a.ts");
	});
});

describe("splitUserMessage", () => {
	it("recovers text, editor context, pasted blocks and attached files from a composed prompt", () => {
		const { message } = composePrompt({
			text: "review",
			attachments: [
				{ id: "1", kind: "text", text: "a\n</pasted-text>\nb", label: "Pasted text 1" },
				{ id: "2", kind: "file", path: "/work/app/src/a b.ts", label: "a b.ts" },
				{ id: "3", kind: "file", path: "/work/app/src/c.ts", label: "c.ts" },
			],
			cwd,
			editorContext: "<editor-context>\nx\n</editor-context>",
		});
		assert.deepEqual(splitUserMessage(message), {
			text: "review",
			editorContext: "<editor-context>\nx\n</editor-context>",
			pasted: [{ name: "Pasted text 1", text: "a\n</pasted-text>\nb" }],
			files: [path.join("src", "a b.ts"), path.join("src", "c.ts")],
		});
	});

	it("leaves ordinary messages untouched", () => {
		assert.deepEqual(splitUserMessage("Attached is a list: @me"), { text: "Attached is a list: @me", pasted: [], files: [] });
	});

	it("round-trips file names containing quotes", () => {
		const { message } = composePrompt({
			text: "look",
			attachments: [
				{ id: "1", kind: "file", path: '/work/app/a"b.txt', label: 'a"b.txt' },
				{ id: "2", kind: "file", path: "/work/app/c.txt", label: "c.txt" },
			],
			cwd,
		});
		assert.equal(message, 'look\n\nAttached: @"a\\"b.txt" @c.txt');
		assert.deepEqual(splitUserMessage(message).files, ['a"b.txt', "c.txt"]);
	});

	it("keeps backslashes of Windows paths in quoted mentions", () => {
		assert.deepEqual(splitUserMessage('go\n\nAttached: @"C:\\my docs\\a.md"').files, ["C:\\my docs\\a.md"]);
	});
});

describe("classifyPaste", () => {
	it("keeps short pastes inline", () => {
		assert.equal(classifyPaste("const a = 1;"), "inline");
		assert.equal(classifyPaste("1\n2\n3\n4\n5\n6\n7\n8\n9\n10"), "inline");
	});

	it("turns long pastes into attachments", () => {
		assert.equal(classifyPaste("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11"), "attachment");
		assert.equal(classifyPaste("x".repeat(1001)), "attachment");
	});
});

describe("admitImages", () => {
	const MB = 1024 * 1024;

	it("accepts images within the per-image, count and total limits", () => {
		const files = [
			{ name: "a.png", size: 2 * MB },
			{ name: "b.png", size: 3 * MB },
		];
		assert.deepEqual(admitImages({ count: 0, bytes: 0 }, files), { accepted: files, rejected: [] });
	});

	it("rejects an image larger than 10 MB", () => {
		assert.deepEqual(admitImages({ count: 0, bytes: 0 }, [{ name: "", size: 11 * MB }]), {
			accepted: [],
			rejected: ["Image from clipboard was not attached: larger than 10 MB."],
		});
	});

	it("counts images already attached or being read against the limits", () => {
		assert.deepEqual(admitImages({ count: MAX_IMAGES, bytes: MB }, [{ name: "x.png", size: 1 }]).rejected, [
			`Image x.png was not attached: at most ${MAX_IMAGES} images per prompt.`,
		]);
		const result = admitImages({ count: 1, bytes: 15 * MB }, [
			{ name: "y.png", size: 4 * MB },
			{ name: "z.png", size: 2 * MB },
		]);
		assert.deepEqual(result.accepted, [{ name: "y.png", size: 4 * MB }]);
		assert.deepEqual(result.rejected, ["Image z.png was not attached: images in one prompt may total at most 20 MB."]);
	});
});
