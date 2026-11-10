// Pictures, video and sound a reply shows inside its text: `![caption](path "layout")`. This file is the part with no
// DOM (what counts as such a reference, and which layout it asks for); reply-media.js loads and draws them.
import { localLinkPath } from "./local-file-links.js";

/** File types the server sends for a reply (src/modes/web/routes-files.ts, GET /api/files/media). */
const KINDS = {
	image: "png jpg jpeg gif webp bmp ico svg",
	video: "mp4 m4v webm ogv mov",
	audio: "mp3 wav ogg oga m4a flac aac",
};
const KIND_BY_EXTENSION = new Map(Object.entries(KINDS).flatMap(([kind, list]) => list.split(" ").map((extension) => [extension, kind])));

/** "image", "video" or "audio" for a local path with such a file type; null for anything else (a web address too). */
export function mediaKind(target) {
	const local = localLinkPath(target);
	if (!local) return null;
	let name = local;
	// An artifact's download address carries the file's path as a parameter.
	if (/^\/api\/artifacts\/download\?/i.test(local)) {
		try {
			name = new URL(local, "http://localhost").searchParams.get("path") || "";
		} catch {
			return null;
		}
	}
	const extension = /\.([a-z\d]{2,5})$/i.exec(name.trim())?.[1]?.toLowerCase();
	return (extension && KIND_BY_EXTENSION.get(extension)) || null;
}

/**
 * How a picture sits in the text, the way a word processor offers it:
 * - block: on a line of its own, at the left (the default);
 * - center: on a line of its own, centred;
 * - wide: across the whole width of the reply;
 * - left / right: at that side with the text flowing around it;
 * - inline: inside the line of text, at the height of the text.
 * Several pictures written in one paragraph stand side by side (see the paragraph renderer in markdown.js).
 */
const LAYOUTS = new Map(
	Object.entries({
		block: "block",
		center: "center",
		centre: "center",
		wide: "wide",
		full: "wide",
		left: "left",
		"wrap-left": "left",
		right: "right",
		"wrap-right": "right",
		inline: "inline",
	}),
);
const SIZES = new Map(Object.entries({ small: 30, medium: 50, large: 75 }));

/**
 * The words in the quotes after the path: one layout and one width (a percentage of the reply's width, or
 * small / medium / large), in any order. A title with any other word in it is an ordinary title (a tooltip), and the
 * picture gets the default layout.
 */
export function parseMediaLayout(title) {
	const words = String(title ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
	let layout;
	let width;
	for (const word of words) {
		const percent = /^(\d{1,3})%$/.exec(word);
		if (LAYOUTS.has(word) && !layout) layout = LAYOUTS.get(word);
		else if (percent && width === undefined) width = Math.min(100, Math.max(10, Number(percent[1])));
		else if (SIZES.has(word) && width === undefined) width = SIZES.get(word);
		else return { layout: "block", width: undefined, title: String(title ?? "").trim() };
	}
	return { layout: layout || "block", width, title: "" };
}

const unescapeLabel = (text) => text.replace(/\\([\\[\]!])/g, "$1");

/**
 * Reads `![caption](path "layout")` at the start of `src`, or returns null when it is not a local picture, video or
 * sound (marked then reads it by the standard rules, and an image from the web stays a link).
 *
 * The path is taken as written, which the standard rules do not allow for a Windows path: they end the address at the
 * first space (`C:/Users/user/My Drive/a.png`) and drop the backslash before punctuation (`C:\Users\user\.cache\_a.png`).
 * Here the address runs to the bracket that closes it, brackets inside it are counted, `<...>` around it is accepted,
 * and no backslash is removed.
 */
export function scanMedia(src) {
	if (!src.startsWith("![")) return null;
	let at = 2;
	while (at < src.length && src[at] !== "]" && src[at] !== "\n") at += src[at] === "\\" ? 2 : 1;
	if (src[at] !== "]" || src[at + 1] !== "(") return null;
	const alt = unescapeLabel(src.slice(2, at));
	const open = at + 2;
	let depth = 0;
	let close = -1;
	for (let i = open; i < src.length; i++) {
		const char = src[i];
		if (char === "\n") break;
		if (char === "<" && src.slice(open, i).trim() === "") {
			const end = src.indexOf(">", i);
			if (end === -1 || src.slice(i, end).includes("\n")) break;
			i = end;
		} else if ((char === '"' || char === "'") && /\s/.test(src[i - 1] || "")) {
			// A quoted title: brackets inside it do not count. Without its closing quote this is not a title.
			const end = src.indexOf(char, i + 1);
			if (end !== -1 && !src.slice(i, end).includes("\n") && /^\s*\)/.test(src.slice(end + 1))) i = end;
		} else if (char === "(") depth++;
		else if (char === ")") {
			if (depth === 0) {
				close = i;
				break;
			}
			depth--;
		}
	}
	if (close === -1) return null;
	const inner = src.slice(open, close).trim();
	const titled = /^(.*?)\s+(?:"([^"]*)"|'([^']*)')$/s.exec(inner);
	let target = (titled ? titled[1] : inner).trim();
	const title = titled ? (titled[2] ?? titled[3] ?? "") : "";
	if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
	const kind = target ? mediaKind(target) : null;
	if (!kind) return null;
	return { raw: src.slice(0, close + 1), alt, target, title, kind };
}

/** The file's own name, shown while it loads and when it cannot be shown. */
export function mediaName(target) {
	const local = localLinkPath(target) || target;
	let name = local;
	if (/^\/api\/artifacts\/download\?/i.test(local)) {
		try {
			name = new URL(local, "http://localhost").searchParams.get("path") || local;
		} catch {
			name = local;
		}
	}
	return name.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || name;
}
