import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { withAbsoluteAttachmentPaths } from "../src/config/paths/attachments.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { attachmentName, splitAttachmentText } from "../src/modes/web/wire.ts";

it("gives the Agent the full path of a stored attachment and leaves everything else in the message alone", () => {
	const root = resolve("/data root");
	const full = (path: string) => JSON.stringify(resolve(root, path).split(sep).join("/"));
	const relativeRef = "workspaces/w/sessions/s/uploads/id/attachment-top/sub/a.txt";
	const header = "Attached files (use read to inspect):";
	const old = resolve("/old/uploads/id/attachment-a.txt");
	const message = `${header}\n${JSON.stringify(relativeRef)}\n${JSON.stringify(old)}\n\n"workspaces/not/a/reference"\nhi`;
	expect(withAbsoluteAttachmentPaths(message, root)).toBe(
		`${header}\n${full(relativeRef)}\n${JSON.stringify(old)}\n\n"workspaces/not/a/reference"\nhi`,
	);
	// The name read back from the full path is the same as the one from the history's path.
	expect(attachmentName(JSON.parse(full(relativeRef)))).toBe("top/sub/a.txt");
	// Text the user wrote: not at the very start, or not a reference, stays as typed.
	for (const text of [`hi\n${header}\n"workspaces/x"`, `${header}\nnot json\n"workspaces/x"`, "workspaces/x", ""])
		expect(withAbsoluteAttachmentPaths(text, root)).toBe(text);
	expect(withAbsoluteAttachmentPaths(`${header}\n"../outside"`, root)).toBe(`${header}\n"../outside"`);
});

it("names a file of an uploaded folder by its place in the folder", () => {
	expect(attachmentName("workspaces/w/sessions/s/uploads/id/attachment-top/sub/a.txt")).toBe("top/sub/a.txt");
	expect(attachmentName("C:\\data\\uploads\\id\\attachment-top\\attachment-b.txt")).toBe("top/attachment-b.txt");
	// A lone file and anything outside an uploads folder read as before.
	expect(attachmentName("workspaces/w/sessions/s/uploads/id/attachment-a.txt")).toBe("a.txt");
	expect(attachmentName("C:/attachment-dir/plain/attachment-a.txt")).toBe("a.txt");
});

it("stores arbitrary file bytes inside the originating session without overwriting", async () => {
	const root = mkdtempSync(join(tmpdir(), "myharness-import-"));
	const server = new WebHttpServer();
	const host = {
		inputTouched: false,
		session: {
			sessionManager: { getCwd: () => root, getSessionFile: () => join(root, "conversation", "session.jsonl") },
		},
	};
	try {
		registerFileRoutes(server, host as unknown as WebHost);
		const { port } = await server.listen(0);
		const upload = async (body: unknown) => {
			const response = await fetch(`http://127.0.0.1:${port}/api/files/upload`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: response.status, data: (await response.json()) as { name: string; path: string } };
		};
		const bytes = Buffer.from([0, 255, 12, 42]);
		const first = await upload({ name: "../../CON.bin", data: bytes.toString("base64") });
		const second = await upload({ name: "../../CON.bin", data: "" });
		expect(first.status).toBe(200);
		expect(first.data.name).toBe("CON.bin");
		expect(relative(root, first.data.path)).not.toMatch(/^\.\./);
		expect(readFileSync(first.data.path)).toEqual(bytes);
		expect(first.data.path).not.toBe(second.data.path);
		expect(host.inputTouched).toBe(true);
		expect((await upload({ name: "bad", data: "%%%=" })).status).toBe(400);
		expect((await upload({ name: 1, data: "" })).status).toBe(400);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps the tree of an uploaded folder and refuses paths that would leave it", async () => {
	const root = mkdtempSync(join(tmpdir(), "myharness-import-folder-"));
	const server = new WebHttpServer();
	const host = {
		inputTouched: false,
		session: {
			sessionManager: { getCwd: () => root, getSessionFile: () => join(root, "conversation", "session.jsonl") },
		},
	};
	try {
		registerFileRoutes(server, host as unknown as WebHost);
		const { port } = await server.listen(0);
		const call = async (path: string, body: unknown) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: response.status, data: (await response.json()) as any };
		};
		const send = async (folderId: string, path: string, text: string) => {
			const bytes = Buffer.from(text);
			const begun = await call("/api/files/upload/begin", { name: "ignored", size: bytes.length, folderId, path });
			expect(begun.status).toBe(200);
			const { uploadId } = begun.data;
			await call("/api/files/upload/chunk", { uploadId, offset: 0, data: bytes.toString("base64") });
			return (await call("/api/files/upload/finish", { uploadId })).data;
		};
		const files = ["a.txt", "sub/a.txt", "sub/deep/a.txt.part", "sub/deep/a.txt", "CON.txt", "b?.txt", "b_.txt"];
		const planned = await call("/api/files/upload/folder", {
			name: "top",
			files: files.map((path) => ({ path, size: 1 })),
		});
		expect(planned.status).toBe(200);
		const { folderId } = planned.data;

		// Same names in different folders stay apart, and their paths show which is which.
		const first = await send(folderId, "a.txt", "1");
		const second = await send(folderId, "sub/a.txt", "2");
		expect(first.name).toBe("top/a.txt");
		expect(second.name).toBe("top/sub/a.txt");
		expect(readFileSync(first.path, "utf8")).toBe("1");
		expect(readFileSync(second.path, "utf8")).toBe("2");
		expect(dirname(dirname(second.path))).toBe(dirname(first.path));
		expect(dirname(second.path).endsWith("sub")).toBe(true);
		expect(dirname(first.path).endsWith("attachment-top")).toBe(true);

		// A file really named `<name>.part` is not mistaken for the part file of its neighbour.
		const realPart = await send(folderId, "sub/deep/a.txt.part", "3");
		const neighbour = await send(folderId, "sub/deep/a.txt", "4");
		expect(readFileSync(realPart.path, "utf8")).toBe("3");
		expect(readFileSync(neighbour.path, "utf8")).toBe("4");

		// Names Windows cannot store are cleaned, and two that end up the same stay two files.
		const device = await send(folderId, "CON.txt", "5");
		expect(device.name).toBe("top/_CON.txt");
		const question = await send(folderId, "b?.txt", "6");
		const underscore = await send(folderId, "b_.txt", "7");
		expect(new Set([question.path, underscore.path]).size).toBe(2);
		expect(readFileSync(question.path, "utf8")).toBe("6");
		expect(readFileSync(underscore.path, "utf8")).toBe("7");

		// The history keeps only these paths; they read back as the same names and their files are served.
		const history = splitAttachmentText(
			`Attached files (use read to inspect):\n${JSON.stringify(second.path)}\n\nhi`,
		);
		expect(history.attachments).toEqual([{ path: second.path, name: "top/sub/a.txt" }]);
		const info = await fetch(`http://127.0.0.1:${port}/api/uploads/info?path=${encodeURIComponent(second.path)}`, {
			headers: { "x-myharness-web": "1" },
		});
		expect(((await info.json()) as { name: string; exists: boolean }).name).toBe("top/sub/a.txt");
		const download = await fetch(
			`http://127.0.0.1:${port}/api/uploads/download?path=${encodeURIComponent(second.path)}`,
			{ headers: { "x-myharness-web": "1" } },
		);
		expect(download.headers.get("content-disposition")).toContain("''a.txt");

		// Every planned file was taken, so the plan is gone; a path that was never planned cannot be written anywhere.
		expect((await call("/api/files/upload/begin", { name: "x", size: 1, folderId, path: "a.txt" })).status).toBe(404);
		const other = (await call("/api/files/upload/folder", { name: "top", files: [{ path: "ok.txt", size: 1 }] }))
			.data;
		expect(
			(await call("/api/files/upload/begin", { name: "x", size: 1, folderId: other.folderId, path: "../../evil" }))
				.status,
		).toBe(400);
		for (const path of ["../evil.txt", "sub/../../evil.txt", "/abs.txt", "sub\\evil.txt", "", "./a.txt"]) {
			const refused = await call("/api/files/upload/folder", { name: "top", files: [{ path, size: 1 }] });
			expect(refused.status, path).toBe(400);
		}
		expect((await call("/api/files/upload/folder", { name: "top", files: [] })).status).toBe(400);
		const twice = [
			{ path: "a.txt", size: 1 },
			{ path: "a.txt", size: 1 },
		];
		expect((await call("/api/files/upload/folder", { name: "top", files: twice })).status).toBe(400);

		// A path past Windows' 260 characters is neither refused nor renamed, and reads back like any other.
		const long = "n".repeat(120);
		const deep = `${long}/${long}/${long}.txt`;
		const planned2 = (await call("/api/files/upload/folder", { name: "top", files: [{ path: deep, size: 1 }] })).data;
		const stored = await send(planned2.folderId, deep, "8");
		expect(stored.path.length).toBeGreaterThan(260);
		expect(stored.name).toBe(`top/${deep}`);
		expect(readFileSync(stored.path, "utf8")).toBe("8");
		const read = await fetch(`http://127.0.0.1:${port}/api/uploads/read?path=${encodeURIComponent(stored.path)}`, {
			headers: { "x-myharness-web": "1" },
		});
		expect(((await read.json()) as { content: string }).content).toBe("8");
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("stores a large file sent in ordered chunks and refuses gaps, oversize files and unknown uploads", async () => {
	const root = mkdtempSync(join(tmpdir(), "myharness-import-chunks-"));
	const server = new WebHttpServer();
	const host = {
		inputTouched: false,
		session: {
			sessionManager: { getCwd: () => root, getSessionFile: () => join(root, "conversation", "session.jsonl") },
		},
	};
	try {
		registerFileRoutes(server, host as unknown as WebHost);
		const { port } = await server.listen(0);
		const call = async (path: string, body: unknown) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: response.status, data: (await response.json()) as any };
		};
		const bytes = Buffer.from("0123456789abcdef");
		const begun = await call("/api/files/upload/begin", { name: "notes.zip", size: bytes.length });
		const { uploadId } = begun.data;
		expect(begun.status).toBe(200);
		const chunk = (offset: number, part: Buffer) =>
			call("/api/files/upload/chunk", { uploadId, offset, data: part.toString("base64") });
		expect((await chunk(0, bytes.subarray(0, 6))).status).toBe(200);
		// A chunk past what was written would leave a hole.
		expect((await chunk(10, bytes.subarray(10))).status).toBe(400);
		expect((await call("/api/files/upload/finish", { uploadId })).status).toBe(409);
		expect((await chunk(6, bytes.subarray(6))).status).toBe(200);
		const done = await call("/api/files/upload/finish", { uploadId });
		expect(done.status).toBe(200);
		expect(done.data.name).toBe("notes.zip");
		expect(readFileSync(done.data.path)).toEqual(bytes);
		expect(host.inputTouched).toBe(true);
		expect((await call("/api/files/upload/finish", { uploadId })).status).toBe(404);
		expect((await call("/api/files/upload/begin", { name: "big.iso", size: 500 * 1024 * 1024 + 1 })).status).toBe(
			413,
		);
		const empty = await call("/api/files/upload/begin", { name: "empty.txt", size: 0 });
		const emptyDone = await call("/api/files/upload/finish", { uploadId: empty.data.uploadId });
		expect(readFileSync(emptyDone.data.path)).toEqual(Buffer.alloc(0));
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
