// Files the user adds to a message: read once here into what a send needs.
//   image  → base64 bytes, scaled down when large (a phone photo is 12 MP; models read about 1.5 MP)
//   text   → the file's text (code, notes, CSV, JSON…), which the phone's own agent puts into the message
//   binary → anything else; only the PC can take those (they are uploaded to it as files)
import { t } from "/shared/i18n.js";
import { uid } from "/shared/util.js";
import { bytesToBase64 } from "./native.js";

const IMAGE_MAX_SIDE = 1568;
const IMAGE_KEEP_BYTES = 900 * 1024;
export const TEXT_MAX_BYTES = 400 * 1024;
/** The largest file the phone sends to the PC: as base64 inside one sealed request it stays under the link's 40 MiB limit. */
export const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

const TEXT_EXT = new Set(
	"txt md markdown rst log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm css scss less js mjs cjs jsx ts tsx vue svelte py rb php java kt kts swift c h cc cpp hpp cs go rs dart lua pl r sql sh bash zsh ps1 bat cmd gradle properties tex bib srt vtt diff patch makefile dockerfile gitignore".split(" "),
);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const extension = (name) => (/\.([^./\\]+)$/.exec(name || "")?.[1] || "").toLowerCase();

function isTextFile(file) {
	if (/^text\//.test(file.type) || /(json|xml|yaml|javascript|typescript|x-sh|sql|csv)/.test(file.type)) return true;
	const ext = extension(file.name);
	return TEXT_EXT.has(ext) || TEXT_EXT.has(String(file.name || "").toLowerCase());
}

function loadImage(blob) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(t("This picture could not be read.")));
		};
		image.src = url;
	});
}

async function prepareImage(file) {
	const type = IMAGE_TYPES.has(file.type) ? file.type : "image/jpeg";
	const image = await loadImage(file);
	const longest = Math.max(image.naturalWidth, image.naturalHeight);
	if (IMAGE_TYPES.has(file.type) && file.type !== "image/gif" && longest <= IMAGE_MAX_SIDE && file.size <= IMAGE_KEEP_BYTES) {
		return { mimeType: type, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())), width: image.naturalWidth, height: image.naturalHeight };
	}
	const scale = Math.min(1, IMAGE_MAX_SIDE / longest);
	const width = Math.max(1, Math.round(image.naturalWidth * scale));
	const height = Math.max(1, Math.round(image.naturalHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	// A transparent picture saved as JPEG would turn black: it gets a white ground.
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, width, height);
	context.drawImage(image, 0, 0, width, height);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
	if (!blob) throw new Error(t("This picture could not be read."));
	return { mimeType: "image/jpeg", data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), width, height };
}

/**
 * Read one picked file. Resolves with
 *   { id, type: "image"|"text"|"binary", name, size, mimeType, data?, text?, file }
 * `file` is kept for the PC side, which uploads the original bytes.
 */
export async function prepareFile(file) {
	const base = { id: uid("att"), name: file.name || t("file"), size: file.size, mimeType: file.type || "application/octet-stream", file };
	if (/^image\//.test(file.type) && file.type !== "image/svg+xml") {
		const image = await prepareImage(file);
		return { ...base, type: "image", mimeType: image.mimeType, data: image.data };
	}
	if (isTextFile(file) && file.size <= TEXT_MAX_BYTES) {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(await file.arrayBuffer());
		// A file that decodes into replacement characters is not text after all.
		if ((text.match(/�/g) || []).length < Math.max(8, text.length / 200)) return { ...base, type: "text", text };
	}
	return { ...base, type: "binary" };
}

/** A picture that arrived as base64 (shared from another app, a screenshot of the browser). */
export function imageAttachment({ name, mimeType, data }) {
	return { id: uid("att"), type: "image", name: name || "image", size: Math.round((data.length * 3) / 4), mimeType, data };
}

export async function fileToBase64(file) {
	return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}
