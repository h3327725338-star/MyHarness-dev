// What the build takes from the rest of the repository must exist, the Android version number must only grow, and
// every phone-only string needs its Chinese text.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promptsModule, versionCode } from "../build.mjs";
import { coreEntry, mobileDir, promptFiles, sharedFiles } from "../shared-files.mjs";

test("the version code grows with the version", () => {
	assert.equal(versionCode("0.0.8"), 8);
	assert.equal(versionCode("0.1.0"), 100);
	assert.equal(versionCode("1.2.3"), 10203);
	assert.ok(versionCode("0.0.9") > versionCode("0.0.8"));
	assert.ok(versionCode("0.1.0") > versionCode("0.0.99"));
	assert.ok(versionCode("1.0.0") > versionCode("0.99.99"));
});

test("the app's version is one Android can order", () => {
	const own = JSON.parse(readFileSync(join(mobileDir, "package.json"), "utf8"));
	assert.match(own.version, /^\d+\.\d{1,2}\.\d{1,2}$/);
	assert.ok(versionCode(own.version) > 0);
});

test("every file shared with the desktop page exists", () => {
	const files = sharedFiles();
	assert.ok(files.length > 15);
	for (const [address, source] of files) assert.ok(existsSync(source), `${address} → ${source} is missing`);
	for (const [name, source] of Object.entries(promptFiles())) assert.ok(existsSync(source), `prompt ${name} → ${source} is missing`);
	assert.ok(existsSync(coreEntry));
});

test("the embedded prompts are complete", () => {
	const text = promptsModule();
	const PROMPTS = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	assert.ok(PROMPTS.identity.includes("MyHarness"), "identity prompt");
	for (const [name, value] of Object.entries(PROMPTS)) assert.ok(value.trim().length > 20, `prompt ${name} is empty`);
});

test("every phone-only string has a Chinese translation", async () => {
	// t("…") and N_("…") literals in the phone's own modules; the desktop's table covers the strings both share.
	const { MOBILE_ZH } = await import("../web/js/locale-zh.js");
	const desktop = (await import("../../coding-agent/web/js/locales/zh-CN.js")).zhCN;
	const asIs = new Set(["Bing", "DuckDuckGo", "Google", "Tavily", "OpenAI Chat Completions"]);
	const missing = [];
	const dir = join(mobileDir, "web", "js");
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".js") && !/bundle|generated|locale-zh/.test(name))) {
		const source = readFileSync(join(dir, file), "utf8");
		for (const match of source.matchAll(/\b(?:t|N_)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
			const key = JSON.parse(`"${match[1]}"`);
			if (!asIs.has(key) && !(key in MOBILE_ZH) && !(key in desktop)) missing.push(`${file}: ${key}`);
		}
	}
	assert.deepEqual(missing, []);
});
