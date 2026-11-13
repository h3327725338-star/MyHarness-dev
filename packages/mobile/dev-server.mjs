#!/usr/bin/env node
/**
 * Shows the phone page in a desktop browser, straight from the source files (no copy, no APK):
 *
 *   node packages/mobile/dev-server.mjs [--port 8765]
 *
 * Open the printed address and switch the browser's DevTools to a phone-sized viewport. What the Android shell
 * provides natively is replaced here by the closest thing a browser allows:
 *   - network requests to other sites go through `/__native/http` on this server (the app uses its own HTTP client);
 *   - the built-in browser pane shows a placeholder (web pages cannot be embedded in a page);
 *   - keys are kept in the browser's localStorage instead of the Android Keystore.
 * It listens on 127.0.0.1 only and answers the request proxy only to its own page.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { bundleCore, googleOAuthModule, promptsModule } from "./build.mjs";
import { sharedFiles, webDir } from "./shared-files.mjs";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

export async function startDevServer({ port = 8765, quiet = false } = {}) {
	const shared = new Map(sharedFiles().map(([target, source]) => [`/${target}`, source]));
	const bundleDir = mkdtempSync(join(tmpdir(), "myharness-mobile-"));
	const bundleFile = join(bundleDir, "core.bundle.js");
	await bundleCore(bundleFile);

	const sendFile = (res, file) => {
		if (!existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
			return;
		}
		res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
		createReadStream(file).pipe(res);
	};

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			const self = `http://${req.headers.host}`;
			if (url.pathname === "/__native/http") {
				if (req.method !== "POST" || (req.headers.origin && req.headers.origin !== self) || req.headers["sec-fetch-site"] === "cross-site") {
					res.writeHead(403).end();
					return;
				}
				const chunks = [];
				for await (const chunk of req) chunks.push(chunk);
				const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const controller = new AbortController();
				res.on("close", () => controller.abort());
				const method = String(input.method || "GET").toUpperCase();
				const body = input.bodyBase64 != null ? Buffer.from(input.bodyBase64, "base64") : input.bodyText != null ? input.bodyText : undefined;
				let upstream;
				try {
					upstream = await fetch(input.url, { method, headers: input.headers || {}, body: method === "GET" || method === "HEAD" ? undefined : body, signal: controller.signal, redirect: "follow" });
				} catch (error) {
					res.writeHead(200, { "x-mh-error": encodeURIComponent(error?.cause?.message || error?.message || "Request failed") }).end();
					return;
				}
				const headers = [...upstream.headers.entries()].filter(([name]) => name !== "content-encoding" && name !== "content-length");
				res.writeHead(200, {
					"x-mh-status": String(upstream.status),
					"x-mh-url": encodeURIComponent(upstream.url),
					"x-mh-headers": Buffer.from(JSON.stringify(headers), "utf8").toString("base64"),
					"cache-control": "no-store",
				});
				if (upstream.body) {
					try {
						for await (const chunk of upstream.body) res.write(chunk);
					} catch {
						// The page aborted or the upstream connection ended early: the stream simply ends.
					}
				}
				res.end();
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405).end();
				return;
			}
			if (url.pathname === "/js/core.bundle.js") return sendFile(res, bundleFile);
			if (url.pathname === "/js/oauth.generated.js") {
				res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" }).end(googleOAuthModule());
				return;
			}
			if (url.pathname === "/js/prompts.generated.js") {
				res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" }).end(promptsModule());
				return;
			}
			if (url.pathname === "/build-info.json") {
				const pkg = JSON.parse(readFileSync(join(webDir, "..", "package.json"), "utf8"));
				res.writeHead(200, { "content-type": TYPES[".json"] }).end(JSON.stringify({ version: pkg.version, dev: true }));
				return;
			}
			const sharedSource = shared.get(decodeURIComponent(url.pathname));
			if (sharedSource) return sendFile(res, sharedSource);
			const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
			const root = resolve(webDir);
			const file = resolve(join(root, normalize(relative)));
			if (file !== root && !file.startsWith(root + sep)) {
				res.writeHead(403).end();
				return;
			}
			sendFile(res, file);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
			res.end(String(error?.message || error));
		}
	});
	await new Promise((ready, failed) => {
		server.once("error", failed);
		server.listen(port, "127.0.0.1", ready);
	});
	const address = `http://localhost:${server.address().port}/`;
	if (!quiet) console.log(`MyHarness phone page: ${address}`);
	return { server, address, close: () => new Promise((done) => server.close(done)) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
	const at = process.argv.indexOf("--port");
	await startDevServer({ port: at > 0 ? Number(process.argv[at + 1]) : 8765 });
}
