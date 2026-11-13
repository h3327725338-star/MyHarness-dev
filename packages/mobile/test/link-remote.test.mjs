// What the phone tells about a direct connection attempt (web/js/link-remote.js): only the kinds of addresses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateKinds } from "../web/js/link-remote.js";

test("the kinds of addresses a session description offers, and nothing of the addresses", () => {
	const sdp = [
		"v=0",
		"a=candidate:1 1 udp 2122260223 4f2b1c3a-1111-2222-3333-444455556666.local 54321 typ host generation 0",
		"a=candidate:2 1 udp 1686052607 203.0.113.7 40000 typ srflx raddr 0.0.0.0 rport 0",
		"a=candidate:3 1 udp 1686052351 2001:db8::7 40001 typ srflx raddr :: rport 0",
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
	].join("\r\n");
	assert.deepEqual(candidateKinds(sdp), { ipv4: true, ipv6: true, hidden: true });
	assert.deepEqual(candidateKinds("a=candidate:1 1 udp 1 192.168.1.5 5000 typ host\n"), { ipv4: true, ipv6: false, hidden: false });
	assert.deepEqual(candidateKinds(""), { ipv4: false, ipv6: false, hidden: false });
	assert.deepEqual(candidateKinds(undefined), { ipv4: false, ipv6: false, hidden: false });
});
