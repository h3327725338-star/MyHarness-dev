import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * Reopening Settings → Connections (or `/settings` → Mail / GitHub Connect) must never replay an earlier
 * sign-in toast from `store.mailEvent` / `store.githubEvent`; only events arriving while the view is open
 * should trigger toasts, including rapid same-millisecond events.
 */
it.skipIf(!installed.length)(
	"does not replay stale mailbox or GitHub connection toasts when reopening Connections",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-connect-toast-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			unattended: true,
		});
		let mailReads = 0;
		let githubReads = 0;
		const mailAccounts: Array<{ provider: string; email: string; name?: string }> = [];
		let githubAccount: { login: string } | null = null;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			const snap = {
				slot: "test",
				mode: "coding",
				cwd: "C:/fixture",
				session: { id: "chat", file: "test.jsonl", persisted: true },
				flags: {},
				active: false,
				model: { id: "test", name: "Test", input: ["text"] },
				dialogs: [],
				surface: { widgets: {}, statuses: {} },
				queue: { steering: [], followUp: [] },
				thinking: { levels: [], supported: false },
				trust: {},
				run: {},
				app: {},
				workspace: { name: "fixture", rootPath: "C:/fixture" },
			};
			server.route("GET", "/api/boot", () => ({ phase: "ready", dialogs: [] }));
			server.route("GET", "/api/state", () => snap);
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.route("GET", "/api/modes/state", () => ({ coding: {}, general: {} }));
			server.route("GET", "/api/workspaces", () => ({ workspaces: [], sessions: {} }));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/api/settings", () => ({
				items: [],
				menu: [
					{ id: "mail-connect", label: "Mail Connect", description: "Connect mailboxes" },
					{ id: "github-connect", label: "GitHub Connect", description: "Connect GitHub" },
				],
			}));
			server.route("POST", "/api/settings/usage", () => ({ ok: true }));
			server.route("GET", "/api/sync/state", () => ({ status: null }));
			server.route("GET", "/api/web-prefs", () => ({ prefs: null }));
			server.route("PUT", "/api/web-prefs", () => ({ ok: true }));
			server.route("GET", "/api/github", () => {
				githubReads += 1;
				return {
					account: githubAccount,
					source: githubAccount ? "app" : null,
					needsReauthorization: false,
					clientIdConfigured: true,
					clientIdFromEnvironment: false,
					pending: null,
					error: null,
				};
			});
			server.route("GET", "/api/mail", () => {
				mailReads += 1;
				return {
					accounts: mailAccounts,
					providers: {
						google: {
							label: "Gmail",
							redirectHost: "127.0.0.1",
							configured: true,
							clientSecretSet: true,
							fromEnvironment: false,
							source: "own",
						},
						microsoft: {
							label: "Outlook",
							redirectHost: "localhost",
							configured: false,
							clientSecretSet: false,
							fromEnvironment: false,
							source: null,
						},
					},
					pending: null,
					error: null,
				};
			});
			server.route("GET", "/api/test/counts", () => ({ mailReads, githubReads }));
			server.route("POST", "/api/test/mail-done", ({ body }) => {
				const email = String((body as { email?: string })?.email || "user@example.com");
				const account = { provider: "google", email };
				mailAccounts.push(account);
				server.broadcast("mail_event", { type: "done", verified: false, account });
				return { ok: true };
			});
			server.route("POST", "/api/test/mail-rapid", ({ body }) => {
				const email = String((body as { email?: string })?.email || "rapid@example.com");
				const account = { provider: "google", email };
				mailAccounts.push(account);
				server.broadcast("mail_event", { type: "prompt", provider: "google", url: "https://example.test/auth" });
				server.broadcast("mail_event", { type: "done", verified: false, account });
				return { ok: true };
			});
			server.route("POST", "/api/test/github-done", () => {
				githubAccount = { login: "octocat" };
				server.broadcast("github_event", { type: "done", verified: false, account: githubAccount, source: "app" });
				return { ok: true };
			});

			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import { h, render } from "/vendor/preact.js";
import { html, Overlay } from "/js/ui.js";
import { SettingsModal } from "/js/overlays-settings.js";
import { CommandPanel } from "/js/command-panel.js";
import { Toasts } from "/js/app.js";
import { boot, dismissToast, setView, state, useStore } from "/js/store.js";
import { setLang } from "/js/lang.js";

window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const postTest = async (url, body) => {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-myharness-web": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	check(res.ok, url + " -> " + res.status);
};
const until = async (fn, ms = 6000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await wait(25);
	}
	return false;
};

function TestHost() {
	const open = useStore((s) => s.view.settingsOpen);
	return html\`
		<\${Overlay} show=\${!!open}>\${open ? html\`<\${SettingsModal} />\` : null}<//>
		<\${CommandPanel} />
		<\${Toasts} />
	\`;
}

const clearToasts = async () => {
	for (const item of [...state.toasts]) dismissToast(item.id);
	await until(() => state.toasts.length === 0 && document.querySelectorAll(".toast").length === 0);
};

try {
	setLang("en");
	await boot();
	await until(() => state.connected);
	render(html\`<\${TestHost} />\`, document.getElementById("app"));

	// 1. Open Settings -> Connections initially: no toast should appear.
	setView({ settingsOpen: true, settingsSection: "connect" });
	await until(() => document.querySelector(".svc-page"));
	await wait(80);
	check(state.toasts.length === 0, "initial open showed unexpected toast: " + JSON.stringify(state.toasts));

	// 2. Live mail_event done while Connections is open: toast appears once.
	await postTest("/api/test/mail-done", { email: "first@example.com" });
	check(await until(() => state.toasts.some((t) => t.message.includes("first@example.com"))), "live mail_event did not show toast");
	check(state.toasts.filter((t) => t.message.includes("first@example.com")).length === 1, "live mail_event showed duplicate toasts");
	check(await until(() => document.querySelector(".svc-page")?.textContent.includes("first@example.com")), "connected mailbox was not reloaded");

	// 3. Close Settings and reopen Connections: old mail toast must NOT replay, nor double-reload.
	await clearToasts();
	setView({ settingsOpen: false });
	await until(() => !document.querySelector(".svc-page"));
	const beforeReopen = await fetch("/api/test/counts").then((r) => r.json());
	setView({ settingsOpen: true, settingsSection: "connect" });
	await until(() => document.querySelector(".svc-page")?.textContent.includes("first@example.com"));
	await wait(120);
	check(state.toasts.length === 0, "reopening Settings replayed stale mail toast: " + JSON.stringify(state.toasts));
	const afterReopen = await fetch("/api/test/counts").then((r) => r.json());
	check(afterReopen.mailReads - beforeReopen.mailReads === 1, "expected 1 /api/mail reload on reopen, got " + (afterReopen.mailReads - beforeReopen.mailReads));

	// 4. Switch to Appearance and back to Connections: still no toast.
	setView({ settingsSection: "appearance" });
	await until(() => !document.querySelector(".svc-page"));
	setView({ settingsSection: "connect" });
	await until(() => document.querySelector(".svc-page")?.textContent.includes("first@example.com"));
	await wait(120);
	check(state.toasts.length === 0, "switching back to Connections replayed stale mail toast: " + JSON.stringify(state.toasts));

	// 5. Live github_event done while Connections is open: shows once, does not replay on reopen.
	await postTest("/api/test/github-done");
	check(await until(() => state.toasts.some((t) => t.message.includes("GitHub connected"))), "live github_event did not show toast");
	await clearToasts();
	setView({ settingsOpen: false });
	await until(() => !document.querySelector(".svc-page"));
	setView({ settingsOpen: true, settingsSection: "connect" });
	await until(() => document.querySelector(".svc-page")?.textContent.includes("@octocat"));
	await wait(120);
	check(state.toasts.length === 0, "reopening Settings replayed stale GitHub toast: " + JSON.stringify(state.toasts));
	setView({ settingsOpen: false });
	await until(() => !document.querySelector(".svc-page"));

	// 6. CommandPanel /settings -> Mail Connect & GitHub Connect must NOT replay stale store events either.
	setView({ cmd: { name: "settings", arg: "", nonce: Date.now() } });
	await until(() => document.querySelector(".cp"));
	const openRow = async (label) => {
		let row;
		await until(() => {
			row = [...document.querySelectorAll(".cp-row")].find((el) => el.textContent.includes(label));
			return !!row;
		});
		check(!!row, "missing command panel row: " + label);
		row.click();
	};
	await openRow("Mail Connect");
	await until(() => document.querySelector(".cp-title")?.textContent.includes("Mail Connect"));
	await wait(120);
	check(state.toasts.length === 0, "opening /settings Mail Connect replayed stale mail toast: " + JSON.stringify(state.toasts));

	// Rapid same-millisecond prompt + done events while Mail Connect is open must still deliver done toast.
	await postTest("/api/test/mail-rapid", { email: "rapid@example.com" });
	check(await until(() => state.toasts.some((t) => t.message.includes("rapid@example.com"))), "rapid mail_event missed done toast");
	await clearToasts();

	// Navigate back and open GitHub Connect: must not replay stale githubEvent.
	document.querySelector('.cp-head button[aria-label="Back"]').click();
	await until(() => !document.querySelector(".cp-title")?.textContent.includes("Mail Connect"));
	await openRow("GitHub Connect");
	await until(() => document.querySelector(".cp-title")?.textContent.includes("GitHub Connect"));
	await wait(120);
	check(state.toasts.length === 0, "opening /settings GitHub Connect replayed stale GitHub toast: " + JSON.stringify(state.toasts));

	check(window.__errors.length === 0, "page errors: " + window.__errors.join(" / "));
	document.body.insertAdjacentHTML("beforeend", '<p id="ready">passed</p>');
} catch (error) {
	document.body.insertAdjacentHTML("beforeend", '<p id="ready">FAILED: ' + String(error?.stack || error).replace(/</g, "(") + "</p>");
}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Connections toast regression",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);
