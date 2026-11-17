// What the page says about the connection to the PC (web/js/link-status.js): every state of the link, the words for it,
// and the delay shown beside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLatency, latencyMoved, linkInfo, linkWords } from "../web/js/link-status.js";

const NOW = 1_000_000;
const paired = { name: "Home PC", kind: "account", pcId: "pc1", port: 47821 };
const link = (patch = {}) => ({ paired, status: "none", error: "", host: "", route: "", trying: [], since: 0, retryAt: 0, lost: 0, fatal: false, rtt: 0, fails: null, pcVersion: "", ...patch });

// The words, in English with the page's translation function replaced by a plain fill-in.
const t = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key]))) : text);
const routeName = (route) => ({ relay: "Through Google Drive", direct: "Direct connection", lan: "Local network" })[route] || "";
const words = (patch, options) => linkWords(linkInfo(link(patch), { now: NOW, ...options }), { t, routeName });

test("no PC chosen: nothing to say", () => {
	const info = linkInfo({ paired: null, status: "none" }, { now: NOW });
	assert.equal(info.phase, "none");
	assert.equal(info.tone, "off");
	assert.deepEqual(linkWords(info, { t, routeName }), { title: "Not connected", detail: "" });
	assert.equal(linkInfo(null).phase, "none");
});

test("the first try is connecting, and says for how long and which ways are being tried", () => {
	const info = linkInfo(link({ status: "connecting", since: NOW - 7400, trying: ["direct", "relay"] }), { now: NOW });
	assert.equal(info.phase, "connecting");
	assert.equal(info.tone, "busy");
	assert.equal(info.elapsed, 7);
	assert.deepEqual(info.trying, ["direct", "relay"]);
	assert.deepEqual(words({ status: "connecting", since: NOW - 7400, trying: ["direct", "relay"] }), { title: "Connecting…", detail: "7 s · trying Direct connection / Through Google Drive" });
});

test("a connection that had been up and broke is reconnecting, not connecting", () => {
	const info = linkInfo(link({ status: "connecting", lost: NOW - 5000, since: NOW - 1000 }), { now: NOW });
	assert.equal(info.phase, "reconnecting");
	assert.equal(words({ status: "connecting", lost: NOW - 5000, since: NOW - 1000 }).title, "Reconnecting…");
});

test("a try that failed with another planned counts down to it", () => {
	const info = linkInfo(link({ status: "offline", error: "The connection to the PC ended.", retryAt: NOW + 3200, lost: NOW - 10 }), { now: NOW });
	assert.equal(info.phase, "retrying");
	assert.equal(info.retryIn, 4);
	assert.deepEqual(words({ status: "offline", error: "The connection to the PC ended.", retryAt: NOW + 3200 }), { title: "Trying again in 4 s", detail: "The connection to the PC ended." });
	// Never "0 s": a try that is due within the second still says 1.
	assert.equal(linkInfo(link({ status: "offline", retryAt: NOW + 200 }), { now: NOW }).retryIn, 1);
});

test("nothing planned: not reachable, with the reason", () => {
	const info = linkInfo(link({ status: "offline", error: "HTTP 500" }), { now: NOW });
	assert.equal(info.phase, "offline");
	assert.equal(info.tone, "warn");
	assert.deepEqual(words({ status: "offline", error: "HTTP 500" }), { title: "Not reachable", detail: "HTTP 500" });
	// A retry time in the past is no plan.
	assert.equal(linkInfo(link({ status: "offline", retryAt: NOW - 1 }), { now: NOW }).phase, "offline");
});

test("a PC that refuses this phone is refused, and no retry is promised", () => {
	const info = linkInfo(link({ status: "offline", fatal: true, error: "The PC no longer accepts this phone." }), { now: NOW });
	assert.equal(info.phase, "refused");
	assert.equal(info.tone, "bad");
	assert.equal(info.retryIn, 0);
	assert.equal(words({ status: "offline", fatal: true, error: "No." }).title, "The PC refused this phone");
});

test("a PC the account says is off is named as off, not just unreachable", () => {
	const off = { online: false, accepts: true };
	assert.deepEqual(words({ status: "offline" }, { peer: off }), { title: "Not reachable", detail: "The PC is off, or MyHarness is closed there." });
	// The reason of the failure is a symptom of that: the hint replaces it (the connection page lists each way's reason).
	assert.deepEqual(words({ status: "offline", error: "HTTP 500" }, { peer: off }), { title: "Not reachable", detail: "The PC is off, or MyHarness is closed there." });
	const refuses = { online: true, accepts: false };
	assert.deepEqual(words({ status: "offline" }, { peer: refuses }), { title: "Not reachable", detail: "The PC does not accept phones right now." });
	// While retrying the same hint rides along.
	assert.equal(words({ status: "offline", retryAt: NOW + 2000 }, { peer: off }).detail, "The PC is off, or MyHarness is closed there.");
	// A PC that is on says nothing extra; and a connected link ignores a stale presence.
	assert.equal(linkInfo(link({ status: "offline" }), { peer: { online: true, accepts: true }, now: NOW }).peer, "");
	assert.equal(linkInfo(link({ status: "online", route: "relay" }), { peer: off, now: NOW }).peer, "");
});

test("connected names the way, the delay, the address and the PC's version", () => {
	const patch = { status: "online", route: "lan", host: "192.168.1.5", rtt: 42, pcVersion: "1.2.3", error: "stale", fails: { direct: "x" } };
	const info = linkInfo(link(patch), { now: NOW });
	assert.equal(info.phase, "online");
	assert.equal(info.tone, "ok");
	assert.equal(info.route, "lan");
	assert.equal(info.host, "192.168.1.5");
	assert.equal(info.version, "1.2.3");
	assert.equal(info.reason, "", "an old error is not shown while connected");
	assert.deepEqual(info.fails, {}, "nor the reasons of an old try");
	assert.deepEqual(words(patch), { title: "Connected", detail: "Local network · 42 ms" });
	assert.deepEqual(words({ status: "online", route: "relay", rtt: 1800 }), { title: "Connected", detail: "Through Google Drive · 1.8 s" });
	assert.deepEqual(words({ status: "online", route: "direct" }), { title: "Connected", detail: "Direct connection" }, "no delay known yet: none is made up");
});

test("while not connected, the way and the delay are not shown", () => {
	const info = linkInfo(link({ status: "offline", route: "relay", rtt: 900, host: "h" }), { now: NOW });
	assert.equal(info.route, "");
	assert.equal(info.rtt, 0);
	assert.equal(info.host, "");
});

test("each way's reason is kept for the connection page while it is not connected", () => {
	const fails = { lan: "Not on the PC's local network.", direct: "No direct path." };
	assert.deepEqual(linkInfo(link({ status: "offline", fails }), { now: NOW }).fails, fails);
});

test("latency in words", () => {
	assert.equal(formatLatency(0), "");
	assert.equal(formatLatency(undefined), "");
	assert.equal(formatLatency(42.4), "42 ms");
	assert.equal(formatLatency(999), "999 ms");
	assert.equal(formatLatency(1000), "1.0 s");
	assert.equal(formatLatency(1840), "1.8 s");
	assert.equal(formatLatency(12000), "12 s");
});

test("the shown delay is redrawn only when it moved enough to matter", () => {
	assert.equal(latencyMoved(0, 120), true);
	assert.equal(latencyMoved(100, 110), false);
	assert.equal(latencyMoved(100, 200), true);
	assert.equal(latencyMoved(2000, 2300), false);
	assert.equal(latencyMoved(2000, 3000), true);
	assert.equal(latencyMoved(100, 0), false);
});

test("the reason of a failed try is translated where it is shown; a message without an entry stays as it is", () => {
	const zh = { "The PC did not answer in time.": "电脑没有及时回应。" };
	const tZh = (text, params) => t(zh[text] ?? text, params);
	const said = (error) => linkWords(linkInfo(link({ status: "offline", error }), { now: NOW }), { t: tZh, routeName }).detail;
	assert.equal(said("The PC did not answer in time."), "电脑没有及时回应。");
	assert.equal(said("HTTP 502"), "HTTP 502");
	assert.equal(said(""), "");
});

test("every fixed message of a failed connection has a Chinese entry", async () => {
	const { readFileSync } = await import("node:fs");
	const { MOBILE_ZH } = await import("../web/js/locale-zh.js");
	const source = readFileSync(new URL("../web/js/link-remote.js", import.meta.url), "utf8");
	const messages = [...source.matchAll(/RemoteLinkError\(([^;]*?)\);/g)].flatMap((match) => [...match[1].matchAll(/"([^"]*[.?])"/g)].map((quoted) => quoted[1]));
	assert.ok(messages.length >= 8, `found ${messages.length}`);
	for (const message of messages) assert.ok(Object.hasOwn(MOBILE_ZH, message), `no Chinese entry: ${message}`);
});
