// A QR Code encoder (ISO/IEC 18004, model 2), enough for what the app shows: a short text (a pairing link) in byte
// mode, any version, with the mask chosen by the standard's penalty rules. No dependencies and no DOM: `qrMatrix`
// returns the modules, `qrSvgPath` one SVG path for them. The phone-link settings page draws it (phone-link-page.js).

/** Error-correction codewords per block, by level and version (index 0 unused). */
const ECC_PER_BLOCK = {
	L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
/** Number of error-correction blocks, by level and version. */
const BLOCKS = {
	L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
/** The two format bits of each level. */
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Modules that carry data or error correction in a version (everything but the fixed patterns). */
function rawDataModules(version) {
	let count = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		count -= (25 * align - 10) * align - 55;
		if (version >= 7) count -= 36;
	}
	return count;
}

const dataCodewords = (version, level) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[level][version] * BLOCKS[level][version];

// ---- Reed–Solomon over GF(2^8) with the polynomial x^8 + x^4 + x^3 + x^2 + 1 --------------------------
function multiply(x, y) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function divisor(degree) {
	const result = new Uint8Array(degree);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = multiply(result[j], root);
			if (j + 1 < degree) result[j] ^= result[j + 1];
		}
		root = multiply(root, 2);
	}
	return result;
}

function remainder(data, generator) {
	const result = new Uint8Array(generator.length);
	for (const byte of data) {
		const factor = byte ^ result[0];
		result.copyWithin(0, 1);
		result[result.length - 1] = 0;
		for (let i = 0; i < generator.length; i++) result[i] ^= multiply(generator[i], factor);
	}
	return result;
}

/** Splits the data into blocks, adds each block's error correction and interleaves them. */
function withErrorCorrection(data, version, level) {
	const blocks = BLOCKS[level][version];
	const eccLength = ECC_PER_BLOCK[level][version];
	const total = Math.floor(rawDataModules(version) / 8);
	const shortBlocks = blocks - (total % blocks);
	const shortLength = Math.floor(total / blocks);
	const generator = divisor(eccLength);
	const parts = [];
	for (let i = 0, at = 0; i < blocks; i++) {
		const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
		const chunk = data.subarray(at, at + length);
		at += length;
		parts.push({ data: chunk, ecc: remainder(chunk, generator) });
	}
	const out = [];
	for (let i = 0; i <= shortLength - eccLength; i++) for (const part of parts) if (i < part.data.length) out.push(part.data[i]);
	for (let i = 0; i < eccLength; i++) for (const part of parts) out.push(part.ecc[i]);
	return out;
}

/** The text as codewords: byte mode header, the UTF-8 bytes, terminator and padding. */
function encodeBytes(bytes, version, level) {
	const capacity = dataCodewords(version, level) * 8;
	const bits = [];
	const push = (value, length) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(4, 4);
	push(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) push(byte, 8);
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const out = new Uint8Array(bits.length / 8);
	bits.forEach((bit, index) => {
		out[index >>> 3] |= bit << (7 - (index & 7));
	});
	return out;
}

function alignmentPositions(version, size) {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const positions = [6];
	for (let position = size - 7; positions.length < count; position -= step) positions.splice(1, 0, position);
	return positions;
}

const MASKS = [
	(x, y) => (x + y) % 2 === 0,
	(_x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The standard's four penalty rules; the mask with the lowest score reads best. */
function penalty(modules, size) {
	let score = 0;
	const line = (get) => {
		let run = 1;
		for (let i = 1; i < size; i++) {
			if (get(i) === get(i - 1)) run += 1;
			else {
				if (run >= 5) score += run - 2;
				run = 1;
			}
		}
		if (run >= 5) score += run - 2;
		// A finder-like 1:1:3:1:1 with four light modules on one side.
		for (let i = 0; i + 11 <= size; i++) {
			const at = (k) => get(i + k);
			const core = (o) => at(o) && !at(o + 1) && at(o + 2) && at(o + 3) && at(o + 4) && !at(o + 5) && at(o + 6);
			if ((core(0) && !at(7) && !at(8) && !at(9) && !at(10)) || (!at(0) && !at(1) && !at(2) && !at(3) && core(4))) score += 40;
		}
	};
	for (let y = 0; y < size; y++) line((x) => modules[y][x]);
	for (let x = 0; x < size; x++) line((y) => modules[y][x]);
	let dark = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y][x]) dark += 1;
			if (x + 1 < size && y + 1 < size && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += 3;
		}
	}
	const total = size * size;
	score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
	return score;
}

/**
 * The QR code of a text. `level` is the error correction: "L", "M" (default), "Q" or "H".
 * Returns `{ size, version, modules }` where `modules[y][x]` is true for a dark module (no quiet zone included).
 * Throws when the text does not fit the largest code.
 */
export function qrMatrix(text, { level = "M" } = {}) {
	if (!(level in LEVEL_BITS)) throw new Error(`Unknown QR error correction level: ${level}`);
	const bytes = new TextEncoder().encode(String(text));
	let version = 1;
	while (version <= 40 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, level) * 8) version += 1;
	if (version > 40) throw new Error("The text is too long for a QR code.");
	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
	const set = (x, y, dark) => {
		modules[y][x] = dark;
		fixed[y][x] = true;
	};

	// Timing patterns, the three finders with their separators, the alignment patterns.
	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || y < 0 || x >= size || y >= size) continue;
				const ring = Math.max(Math.abs(dx), Math.abs(dy));
				set(x, y, ring !== 2 && ring !== 4);
			}
		}
	}
	const align = alignmentPositions(version, size);
	align.forEach((cx, i) => {
		align.forEach((cy, j) => {
			if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		});
	});

	const drawFormat = (mask) => {
		const data = (LEVEL_BITS[level] << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) set(8, i, bit(i));
		set(8, 7, bit(6));
		set(8, 8, bit(7));
		set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
		set(8, size - 8, true);
	};
	drawFormat(0);
	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) === 1;
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			set(a, b, dark);
			set(b, a, dark);
		}
	}

	// The codewords, in the zigzag from the bottom right corner.
	const codewords = withErrorCorrection(encodeBytes(bytes, version, level), version, level);
	let index = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < size; step++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - step : step;
				if (fixed[y][x] || index >= codewords.length * 8) continue;
				modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
				index += 1;
			}
		}
	}

	const applyMask = (mask) => {
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
	};
	let best = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(mask);
		drawFormat(mask);
		const score = penalty(modules, size);
		if (score < bestScore) {
			best = mask;
			bestScore = score;
		}
		applyMask(mask);
	}
	applyMask(best);
	drawFormat(best);
	return { size, version, mask: best, modules };
}

/** One SVG path (`d`) for the dark modules, with `margin` light modules around; the view box is `size + 2 * margin`. */
export function qrSvgPath(matrix, margin = 4) {
	const parts = [];
	for (let y = 0; y < matrix.size; y++) {
		for (let x = 0; x < matrix.size; x++) {
			if (!matrix.modules[y][x]) continue;
			let run = 1;
			while (x + run < matrix.size && matrix.modules[y][x + run]) run += 1;
			parts.push(`M${x + margin} ${y + margin}h${run}v1h${-run}z`);
			x += run - 1;
		}
	}
	return { d: parts.join(""), box: matrix.size + margin * 2 };
}
