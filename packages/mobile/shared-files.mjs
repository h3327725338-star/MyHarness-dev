/**
 * Files of the desktop Web UI that the phone page uses unchanged, and where each one is served in the phone page.
 * `build.mjs` copies them into the app; `dev-server.mjs` serves them from their source. Keeping one list means the
 * preview in a desktop browser and the page inside the app can never disagree about which files exist.
 *
 * The phone page has no copy of these modules: a fix in the desktop file reaches the phone with the next build.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const mobileDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(mobileDir, "..", "..");
const desktopWeb = join(repoRoot, "packages", "coding-agent", "web");
const exportVendor = join(repoRoot, "packages", "coding-agent", "src", "exports", "html", "vendor");

/** Desktop modules without any tie to the desktop page's state (`store.js`) or to its server. */
const SHARED_JS = [
	"icons.js",
	"i18n.js",
	"lang.js",
	"locales/zh-CN.js",
	"util.js",
	"search.js",
	"scheduling.js",
	"turns.js",
	"ui.js",
	"list-presence.js",
];

const SHARED_CSS = ["tokens.css", "base.css"];

const VENDOR = ["preact.js", "preact-hooks.js", "htm.js", "LICENSE.preact", "LICENSE.htm", "LICENSE.heroicons"];

const VENDOR_MD = ["marked.min.js", "highlight.min.js"];

/** `[address in the phone page, source file]` for every shared file. */
export function sharedFiles() {
	return [
		...SHARED_JS.map((name) => [`shared/${name}`, join(desktopWeb, "js", name)]),
		...SHARED_CSS.map((name) => [`shared/css/${name}`, join(desktopWeb, "css", name)]),
		...VENDOR.map((name) => [`vendor/${name}`, join(desktopWeb, "vendor", name)]),
		...VENDOR_MD.map((name) => [`vendor-md/${name}`, join(exportVendor, name)]),
		["favicon.svg", join(desktopWeb, "favicon.svg")],
	];
}

/** The phone assistant's own prompt resources, embedded into the page as `js/prompts.generated.js`. */
export function promptFiles() {
	const prompts = join(repoRoot, "system-prompts");
	return {
		identity: join(prompts, "mobile", "identity.md"),
		outputLanguage: join(prompts, "common", "global", "output-language.md"),
		title: join(prompts, "common", "tasks", "conversation-title.md"),
	};
}

/** Where the desktop defines MyHarness's own OAuth apps; the phone signs in to Google with the same one. */
export const oauthAppsFile = join(repoRoot, "packages", "coding-agent", "src", "providers", "credentials", "oauth-apps.ts");
export const coreEntry = join(mobileDir, "src", "core.ts");
export const webDir = join(mobileDir, "web");
export const wwwDir = join(mobileDir, "android", "app", "src", "main", "assets", "www");
