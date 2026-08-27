import { describe, expect, test } from "bun:test";
import { encodePng, pngSize, rasterize } from "./png.ts";

describe("encodePng", () => {
	test("magic bytes \\x89PNG", () => {
		const rgba = new Uint8Array([0x0d, 0x11, 0x17, 0xff]);
		const png = encodePng(1, 1, rgba);
		expect(png[0]).toBe(0x89);
		expect(String.fromCharCode(png[1]!, png[2]!, png[3]!)).toBe("PNG");
		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	});

	test("pngSize roundtrip", () => {
		const width = 12;
		const height = 7;
		const rgba = new Uint8Array(width * height * 4);
		const png = encodePng(width, height, rgba);
		expect(pngSize(png)).toEqual({ width, height });
	});
});

describe("rasterize", () => {
	test("taller when more lines", () => {
		const opts = { cols: 40, pad: 4, bg: 0x0d1117ff, fg: 0xe6edf3ff, accent: 0x58a6ffff };
		const short = rasterize(["one"], opts);
		const tall = rasterize(["one", "two", "three", "four"], opts);
		expect(tall.height).toBeGreaterThan(short.height);
		const png = encodePng(tall.width, tall.height, tall.rgba);
		expect(pngSize(png)).toEqual({ width: tall.width, height: tall.height });
	});
});
