import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const roots: string[] = [];
const servers: WebHttpServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "myharness-reply-media-"));
	const outside = mkdtempSync(join(tmpdir(), "myharness-reply-media-out-"));
	roots.push(root, outside);
	mkdirSync(join(root, "My Drive"));
	writeFileSync(join(root, "My Drive", "chart 1.png"), PNG);
	writeFileSync(join(outside, "slide.png"), PNG);
	writeFileSync(join(root, "clip.mp4"), Buffer.from("0123456789"));
	writeFileSync(join(root, "notes.txt"), "secret");
	writeFileSync(join(root, "paper.pdf"), "%PDF-1.4");
	const server = new WebHttpServer();
	servers.push(server);
	registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
	const { port } = await server.listen(0);
	const media = (path: string, headers?: Record<string, string>) =>
		fetch(`http://127.0.0.1:${port}/api/files/media?path=${encodeURIComponent(path)}`, { headers });
	return { root, outside, media };
}

describe("media a reply shows inside its text", () => {
	it("serves an image by the path the reply wrote: relative, absolute, with spaces, with either slash", async () => {
		const { root, outside, media } = await setup();
		const relative = await media("My Drive/chart 1.png");
		expect(relative.status).toBe(200);
		expect(relative.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await relative.arrayBuffer()).equals(PNG)).toBe(true);
		expect((await media(join(outside, "slide.png"))).status).toBe(200);
		expect((await media(join(root, "My Drive", "chart 1.png").replaceAll("\\", "/"))).status).toBe(200);
	});

	it("serves nothing but images, video and audio", async () => {
		const { media } = await setup();
		expect((await media("notes.txt")).status).toBe(415);
		expect((await media("paper.pdf")).status).toBe(415);
		expect((await media("My Drive")).status).toBe(400);
		expect((await media("missing.png")).status).toBe(404);
		expect((await media("https://example.com/a.png")).status).toBe(400);
		expect((await media("//server/share/a.png")).status).toBe(400);
	});

	it("answers 304 for a file the page already holds until the file changes", async () => {
		const { root, media } = await setup();
		const first = await media("My Drive/chart 1.png");
		const etag = first.headers.get("etag") ?? "";
		expect(etag).not.toBe("");
		await first.arrayBuffer();
		expect((await media("My Drive/chart 1.png", { "if-none-match": etag })).status).toBe(304);
		const file = join(root, "My Drive", "chart 1.png");
		writeFileSync(file, Buffer.concat([PNG, Buffer.from([0])]));
		utimesSync(file, new Date(), new Date(Date.now() + 5000));
		const changed = await media("My Drive/chart 1.png", { "if-none-match": etag });
		expect(changed.status).toBe(200);
		await changed.arrayBuffer();
	});

	it("lets a video seek with a byte range", async () => {
		const { media } = await setup();
		const part = await media("clip.mp4", { range: "bytes=2-5" });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-type")).toBe("video/mp4");
		expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await part.text()).toBe("2345");
	});
});
