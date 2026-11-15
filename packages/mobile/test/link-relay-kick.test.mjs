// The relay through Google Drive while the app is in the background: the page's timers come late there, so the app's
// shell says when a second has passed (link-remote.js: kick) and the relay does what is due.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openRelay } from "../web/js/link-remote.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the relay looks into Drive, writes its sign of life and its messages when told, without its timers", async () => {
	let time = 1e9;
	let listed = 0;
	const created = [];
	const files = [];
	const bodies = new Map();
	const drive = {
		phoneList: async () => {
			listed += 1;
			return files.slice();
		},
		phoneCreate: async (_folder, name, data) => {
			created.push({ name, text: new TextDecoder().decode(data) });
		},
		phoneRead: async (_folder, name) => bodies.get(name) ?? null,
		phoneDelete: async () => {},
	};
	// Timers that never come within this test stand for a page in the background.
	const relay = openRelay({ drive, pcId: "pc", phoneId: "ph", now: () => time, pollMs: 1e8, busyPollMs: 1e8 });
	let closed = false;
	relay.onClose(() => {
		closed = true;
	});
	try {
		relay.kick();
		await settle();
		assert.equal(listed, 1, "the first tick looks into Drive");
		relay.kick();
		await settle();
		assert.equal(listed, 1, "not again before a look is due");
		assert.equal(created.length, 0, "and no sign of life before one is due");

		time += 2e8;
		relay.kick();
		await settle();
		assert.equal(listed, 2);
		assert.equal(created.length, 1, "the sign of life is written at once, not on a timer");
		assert.deepEqual(JSON.parse(created[0].text).m, [{ t: "k" }]);

		// The PC's message is read on the next tick that is due: here the PC ends the connection.
		const conn = created[0].name.split("__")[3];
		const name = `m__ph__pc__${conn}__00000001.json`;
		bodies.set(name, new TextEncoder().encode(JSON.stringify({ v: 1, m: [{ t: "bye" }] })));
		files.push({ id: "f1", name, size: "0" });
		time += 2e8;
		relay.kick();
		await settle();
		assert.equal(closed, true, "the PC's message arrived without any timer of the page");
	} finally {
		relay.close();
	}
});
