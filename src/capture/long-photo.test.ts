import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSnapshot } from "../types.ts";
import { layoutLines, renderLongPhoto } from "./long-photo.ts";
import { pngSize } from "./png.ts";

const dirs: string[] = [];

function isolate(): string {
	const dir = join(tmpdir(), `omp-tg-photo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshot(init?: Partial<TurnSnapshot>): TurnSnapshot {
	return {
		title: "Fix login",
		userText: "Fix the login bug",
		assistantText: "Patched the handler.",
		tools: [{ name: "bash", detail: "ls -la" }],
		status: "completed",
		sessionId: "sess-abcdef12",
		cwd: "/tmp/proj",
		origin: "tui",
		...init,
	};
}

describe("layoutLines", () => {
	test("includes user text", () => {
		const lines = layoutLines(snapshot(), 80);
		expect(lines[0]).toBe("OMP  abcdef12  completed");
		expect(lines.join("\n")).toContain("Fix the login bug");
		expect(lines.join("\n")).toContain("* bash  ls -la");
		expect(lines.join("\n")).toContain("Patched the handler.");
	});
});

describe("renderLongPhoto", () => {
	test("writes PNG file with height > 20", async () => {
		const dataDir = isolate();
		const photo = await renderLongPhoto(snapshot(), { dataDir });
		expect(existsSync(photo.path)).toBe(true);
		expect(photo.path.endsWith(".png")).toBe(true);
		const size = pngSize(photo.png);
		expect(size.height).toBeGreaterThan(20);
		expect(size).toEqual({ width: photo.width, height: photo.height });
		expect(pngSize(readFileSync(photo.path))).toEqual(size);
	});
});
