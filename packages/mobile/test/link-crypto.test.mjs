// The phone's half of the link encryption must agree with the PC's half bit for bit.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pc from "../../coding-agent/src/modes/web/phone-link/crypto.ts";
import { pairingUri } from "../../coding-agent/src/modes/web/phone-link/gateway.ts";
import * as phone from "../web/js/link-crypto.js";

test("both sides use the same protocol name and additional data", () => {
	assert.equal(phone.LINK_PROTOCOL, pc.LINK_PROTOCOL);
	assert.deepEqual([...phone.linkAad("call", "req", "dev-123456", "abc")], [...pc.linkAad("call", "req", "dev-123456", "abc")]);
});

test("what the phone seals the PC opens, and the other way round", async () => {
	const key = pc.newKey();
	const phoneKey = await phone.importKey(pc.toBase64Url(key));
	const value = { s: "session", q: 7, m: "POST", p: "/api/prompt", b: { text: "你好，电脑 👋" } };
	const sealed = await phone.seal(phoneKey, phone.linkAad("call", "req", "dev-123456"), value);
	assert.deepEqual(pc.open(key, pc.linkAad("call", "req", "dev-123456"), sealed), value);
	const answer = pc.seal(key, pc.linkAad("call", "res", "dev-123456", sealed.n), { status: 200, json: { ok: true } });
	assert.deepEqual(await phone.open(phoneKey, phone.linkAad("call", "res", "dev-123456", sealed.n), answer), { status: 200, json: { ok: true } });
});

test("a message does not open under another operation, direction, device, binding or key", async () => {
	const key = pc.newKey();
	const phoneKey = await phone.importKey(pc.toBase64Url(key));
	const sealed = pc.seal(key, pc.linkAad("events", "evt", "dev-123456", "s1"), { i: 1 });
	assert.deepEqual(await phone.open(phoneKey, phone.linkAad("events", "evt", "dev-123456", "s1"), sealed), { i: 1 });
	await assert.rejects(phone.open(phoneKey, phone.linkAad("call", "evt", "dev-123456", "s1"), sealed));
	await assert.rejects(phone.open(phoneKey, phone.linkAad("events", "res", "dev-123456", "s1"), sealed));
	await assert.rejects(phone.open(phoneKey, phone.linkAad("events", "evt", "dev-654321", "s1"), sealed));
	await assert.rejects(phone.open(phoneKey, phone.linkAad("events", "evt", "dev-123456", "s2"), sealed));
	const other = await phone.importKey(pc.toBase64Url(pc.newKey()));
	await assert.rejects(phone.open(other, phone.linkAad("events", "evt", "dev-123456", "s1"), sealed));
	const flipped = { n: sealed.n, c: (sealed.c[0] === "A" ? "B" : "A") + sealed.c.slice(1) };
	await assert.rejects(phone.open(phoneKey, phone.linkAad("events", "evt", "dev-123456", "s1"), flipped));
});

test("base64url is the same on both sides", () => {
	const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) % 256);
	assert.equal(phone.toBase64Url(bytes), pc.toBase64Url(bytes));
	assert.deepEqual([...phone.fromBase64Url(pc.toBase64Url(bytes))], [...bytes]);
	assert.throws(() => phone.fromBase64Url("a+b/"));
});

test("the phone reads the pairing code the PC writes", () => {
	const key = pc.toBase64Url(pc.newKey());
	const uri = pairingUri({ hosts: ["192.168.1.23", "10.8.0.2"], port: 47821, deviceId: "dv_Ab3kQ9xL", key, name: "书房的电脑 & more" });
	assert.deepEqual(phone.parsePairing(uri), { hosts: ["192.168.1.23", "10.8.0.2"], port: 47821, deviceId: "dv_Ab3kQ9xL", key, name: "书房的电脑 & more" });
	assert.equal(phone.parsePairing(`  ${uri}\n`).port, 47821);
});

test("a wrong or damaged pairing code is refused with a reason", () => {
	const key = pc.toBase64Url(pc.newKey());
	const good = { hosts: ["192.168.1.23"], port: 47821, deviceId: "dv_Ab3kQ9xL", key, name: "PC" };
	assert.throws(() => phone.parsePairing("https://example.com/"), /not a MyHarness pairing code/);
	assert.throws(() => phone.parsePairing("hello"), /not a MyHarness pairing code/);
	assert.throws(() => phone.parsePairing(pairingUri(good).replace("v=1", "v=2")), /newer MyHarness/);
	assert.throws(() => phone.parsePairing(pairingUri({ ...good, key: key.slice(0, 20) })), /incomplete/);
	assert.throws(() => phone.parsePairing(pairingUri({ ...good, port: 0 })), /incomplete/);
	assert.throws(() => phone.parsePairing(pairingUri({ ...good, hosts: [] })), /incomplete/);
	assert.throws(() => phone.parsePairing(pairingUri({ ...good, hosts: ["evil.example/path?x="] })), /incomplete/);
});
