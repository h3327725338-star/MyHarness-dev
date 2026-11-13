import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const { qrMatrix, qrSvgPath } = await import(new URL("../web/js/qr-code.js", import.meta.url).href);

/** The matrix as one line, the way the codes below were checked with a real QR reader (ZXing) when they were recorded. */
function fingerprint(text: string, level = "M"): { version: number; hash: string } {
	const matrix = qrMatrix(text, { level });
	const line = `${matrix.size} ${matrix.modules.map((row: boolean[]) => row.map((dark) => (dark ? 1 : 0)).join("")).join("")}`;
	return { version: matrix.version, hash: createHash("sha256").update(line).digest("hex").slice(0, 16) };
}

const PAIRING =
	"myharness://link?v=1&h=192.168.1.23,10.8.0.2&p=47821&d=dv_Ab3kQ9xLm2pRt&k=Zk9yQ2x3b1F4d0tQa1ZtN2hYc0w0ZkR1T2pJeUJ6QWE&n=LAB-PC";

describe("QR code encoder", () => {
	it("draws the same codes a QR reader decoded when they were recorded", () => {
		expect(fingerprint("A")).toEqual({ version: 1, hash: "a0dff01ceb1a8d05" });
		expect(fingerprint("hello world")).toEqual({ version: 1, hash: "9c68b9e89f5c9d0e" });
		expect(fingerprint(PAIRING)).toEqual({ version: 8, hash: "ab9922f87eac0715" });
	});

	it("has the three finder patterns, the timing lines and the dark module", () => {
		const { size, modules } = qrMatrix(PAIRING);
		expect(size).toBe(8 * 4 + 17);
		const finder = (left: number, top: number) => {
			for (let y = 0; y < 7; y++) {
				for (let x = 0; x < 7; x++) {
					const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
					expect(modules[top + y][left + x]).toBe(ring !== 2);
				}
			}
		};
		finder(0, 0);
		finder(size - 7, 0);
		finder(0, size - 7);
		for (let i = 8; i < size - 8; i++) {
			expect(modules[6][i]).toBe(i % 2 === 0);
			expect(modules[i][6]).toBe(i % 2 === 0);
		}
		expect(modules[size - 8][8]).toBe(true);
	});

	it("grows with the text and with the error correction level", () => {
		expect(qrMatrix("x".repeat(14)).version).toBe(1);
		expect(qrMatrix("x".repeat(15)).version).toBe(2);
		expect(qrMatrix("x".repeat(213)).version).toBe(10);
		expect(qrMatrix("x".repeat(2331)).version).toBe(40);
		expect(qrMatrix(PAIRING, { level: "L" }).version).toBeLessThan(qrMatrix(PAIRING, { level: "H" }).version);
		expect(() => qrMatrix("x".repeat(2332))).toThrow(/too long/);
		expect(() => qrMatrix("x", { level: "Z" })).toThrow(/level/);
	});

	it("counts bytes, not characters", () => {
		expect(qrMatrix("电脑".repeat(2)).version).toBe(1);
		expect(qrMatrix("电".repeat(5)).version).toBe(2);
	});

	it("writes one path with the quiet zone around it", () => {
		const matrix = qrMatrix("A");
		const { d, box } = qrSvgPath(matrix);
		expect(box).toBe(matrix.size + 8);
		expect(d.startsWith("M4 4h7v1h-7z")).toBe(true);
		const dark = matrix.modules.flat().filter(Boolean).length;
		const drawn = [...d.matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
		expect(drawn).toBe(dark);
	});
});
