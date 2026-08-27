import { deflateSync } from "node:zlib";

export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const CELL_W = 6;
export const CELL_H = 8;

const BG = 0x0d1117ff;
const FG = 0xe6edf3ff;
const ACCENT = 0x58a6ffff;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** 5×7 glyphs for U+0020..U+007E; 7 row bitmasks per glyph, bit 4 = leftmost pixel. */
const FONT = Buffer.from(
	"000000000000000808080800080014140000000000141f141f1400000d140c0516000011020408110000081408150a0000080800000000000408080808040008040404040800" +
		"0815080000000000081f080000000000000008081000001f0000000000000000000800010204081000000e11131519110e040c040404040e0e11010608101f1f02040201110e" +
		"02060a121f02021f101e0101110e0608101e11110e1f0102040808080e11110e11110e0e11110f01020c000800000800000008000008081002040804020000001f001f000000" +
		"080402040800000e1102040004000e11171517100e0e11111f1111111e11111e11111e0e11101010110e1e11111111111e1f10101e10101f1f10101e1010100e11101711110f" +
		"1111111f1111110e04040404040e0702020202120c111214181412111010101010101f111b1515111111111915131111110e11111111110e1e11111e1010100e11111115120d" +
		"1e11111e1412110e11100e01110e1f0404040404041111111111110e11111111110a041111111515150a11110a040a111111110a040404041f01020408101f0e08080808080e" +
		"100804020100000e02020202020e040a11000000000000000000001f0804000000000000000e010f110f10101e1111111e00000e1010110e01010f1111110f00000e111f100e" +
		"0609081c08080800000f11110f0110101e1111111108000c0404040e04000602020218101012141814120c04040404040e00001a1515151500001e1111111100000e1111110e" +
		"00001e11111e1000000f11110f010000161810101000000e100e011e08081e080809060000111111110f00001111110a040000111515150a0000110a040a1100001111110f01" +
		"00001f0204081f06080818080806040404040404040c02020302020c00000915120000",
	"hex",
);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const part of parts) n += part.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const part of parts) {
		out.set(part, o);
		o += part.length;
	}
	return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + data.length + 4);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out[4] = type.charCodeAt(0);
	out[5] = type.charCodeAt(1);
	out[6] = type.charCodeAt(2);
	out[7] = type.charCodeAt(3);
	out.set(data, 8);
	const crcSrc = out.subarray(4, 8 + data.length);
	view.setUint32(8 + data.length, crc32(crcSrc));
	return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
	const stride = width * 4;
	const raw = new Uint8Array(height * (1 + stride));
	for (let y = 0; y < height; y++) {
		const dst = y * (1 + stride);
		raw[dst] = 0;
		const src = y * stride;
		raw.set(rgba.subarray(src, src + stride), dst + 1);
	}
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

export function pngSize(png: Uint8Array): { width: number; height: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function wrapLine(text: string, cols: number): string[] {
	const width = Math.max(1, cols);
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length <= width) {
			out.push(paragraph);
			continue;
		}
		let rest = paragraph;
		while (rest.length > width) {
			let cut = rest.lastIndexOf(" ", width);
			if (cut <= 0) cut = width;
			out.push(rest.slice(0, cut));
			rest = rest.slice(cut).trimStart();
		}
		if (rest.length > 0 || out.length === 0) out.push(rest);
	}
	return out;
}

function wrapAll(lines: string[], cols: number): string[] {
	const out: string[] = [];
	for (const line of lines) out.push(...wrapLine(line, cols));
	return out;
}

export function measureText(lines: string[], cols: number): { width: number; height: number } {
	const wrapped = wrapAll(lines, cols);
	const rows = Math.max(wrapped.length, 1);
	return { width: cols * CELL_W, height: rows * CELL_H };
}

function unpack(color: number): [number, number, number, number] {
	return [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff];
}

function glyphRows(ch: number): number {
	if (ch < 0x20 || ch > 0x7e) ch = 0x3f;
	return (ch - 0x20) * GLYPH_H;
}

function inkFor(line: string, fg: number, accent: number): number {
	if (line.startsWith("OMP ") || line.startsWith(">") || line.startsWith("* ")) return accent;
	return fg;
}

export function rasterize(
	lines: string[],
	opts: { cols: number; pad?: number; bg?: number; fg?: number; accent?: number },
): { rgba: Uint8Array; width: number; height: number } {
	const cols = Math.max(1, opts.cols);
	const pad = opts.pad ?? 16;
	const bg = opts.bg ?? BG;
	const fg = opts.fg ?? FG;
	const accent = opts.accent ?? ACCENT;
	const wrapped = wrapAll(lines, cols);
	const rows = Math.max(wrapped.length, 1);
	const width = pad * 2 + cols * CELL_W;
	const height = pad * 2 + rows * CELL_H;
	const rgba = new Uint8Array(width * height * 4);
	const [br, bgc, bb, ba] = unpack(bg);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = br;
		rgba[i + 1] = bgc;
		rgba[i + 2] = bb;
		rgba[i + 3] = ba;
	}
	const put = (x: number, y: number, color: number) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const i = (y * width + x) * 4;
		const [r, g, b, a] = unpack(color);
		rgba[i] = r;
		rgba[i + 1] = g;
		rgba[i + 2] = b;
		rgba[i + 3] = a;
	};
	for (let row = 0; row < wrapped.length; row++) {
		const line = wrapped[row] ?? "";
		const color = inkFor(line, fg, accent);
		const y0 = pad + row * CELL_H;
		for (let col = 0; col < line.length && col < cols; col++) {
			const code = line.charCodeAt(col);
			const base = glyphRows(code);
			const x0 = pad + col * CELL_W;
			for (let gy = 0; gy < GLYPH_H; gy++) {
				const bits = FONT[base + gy] ?? 0;
				for (let gx = 0; gx < GLYPH_W; gx++) {
					if (bits & (1 << (4 - gx))) put(x0 + gx, y0 + gy, color);
				}
			}
		}
	}
	return { rgba, width, height };
}
