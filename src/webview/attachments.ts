import type { Attachment } from "./protocol";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;
/** Keeps one prompt's base64 images well below what a single webview message and RPC frame carry. */
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
/** Image formats model providers accept. */
const SUPPORTED_IMAGE_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };

/** Images already attached to the next prompt or still being read. */
export interface ImageBudget {
	count: number;
	bytes: number;
}

/** Splits image files into those of a supported format that fit the per-image, count and total limits and messages for the rest. */
export function admitImages<T extends { name: string; size: number; type: string }>(
	budget: ImageBudget,
	files: readonly T[],
): { accepted: T[]; rejected: string[] } {
	let { count, bytes } = budget;
	const accepted: T[] = [];
	const rejected: string[] = [];
	for (const file of files) {
		const reason = !SUPPORTED_IMAGE_TYPES[file.type]
			? "only PNG, JPEG, GIF and WebP images are supported"
			: file.size > MAX_IMAGE_BYTES
				? "larger than 10 MB"
				: count >= MAX_IMAGES
					? `at most ${MAX_IMAGES} images per prompt`
					: bytes + file.size > MAX_TOTAL_IMAGE_BYTES
						? "images in one prompt may total at most 20 MB"
						: undefined;
		if (reason) {
			rejected.push(`Image ${file.name || "from clipboard"} was not attached: ${reason}.`);
			continue;
		}
		accepted.push(file);
		count++;
		bytes += file.size;
	}
	return { accepted, rejected };
}

const INLINE_MAX_LINES = 10;
const INLINE_MAX_CHARS = 1000;

/** Long pastes become a removable attachment instead of flooding the input. */
export function classifyPaste(text: string): "inline" | "attachment" {
	return text.length > INLINE_MAX_CHARS || text.split("\n").length > INLINE_MAX_LINES ? "attachment" : "inline";
}

/** Appends `incoming`, skipping files that are already attached. */
export function mergeAttachments(current: readonly Attachment[], incoming: readonly Attachment[]): Attachment[] {
	const known = new Set(current.flatMap(attachment => (attachment.kind === "file" ? [attachment.path] : [])));
	return [...current, ...incoming.filter(attachment => attachment.kind !== "file" || !known.has(attachment.path))];
}
