import { describe, expect, test } from "bun:test";
import { commentToUserContent } from "./index.ts";

describe("commentToUserContent", () => {
	test("text-only stays a string", () => {
		expect(commentToUserContent("hello", [])).toBe("hello");
	});

	test("images with bytes become content blocks", () => {
		const bytes = Uint8Array.from([1, 2, 3, 4]);
		const content = commentToUserContent("see this", [
			{ fileId: "f1", mimeType: "image/png", bytes },
			{ fileId: "f2", mimeType: "image/jpeg" },
		]);
		expect(Array.isArray(content)).toBe(true);
		if (!Array.isArray(content)) return;
		expect(content[0]).toEqual({ type: "text", text: "see this" });
		expect(content[1]).toEqual({
			type: "image",
			data: Buffer.from(bytes).toString("base64"),
			mimeType: "image/png",
		});
		expect(content).toHaveLength(2);
	});
});
