import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturesDir } from "../paths.ts";
import type { LongPhoto, TurnSnapshot } from "../types.ts";
import { CELL_W, encodePng, rasterize } from "./png.ts";

const DEFAULT_WIDTH = 1080;
const DEFAULT_MAX_HEIGHT = 8500;
const DEFAULT_COLS = 120;
const PAD = 16;
const ASSISTANT_CAP = 14000;
const BG = 0x0d1117ff;
const FG = 0xe6edf3ff;
const ACCENT = 0x58a6ffff;

function wrapText(text: string, cols: number): string[] {
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

export function layoutLines(snapshot: TurnSnapshot, cols: number): string[] {
	const lines: string[] = [`OMP  ${snapshot.sessionId.slice(-8)}  ${snapshot.status}`];
	lines.push(...wrapText(snapshot.cwd, cols));
	lines.push("");
	lines.push(...wrapText(`> ${snapshot.userText}`, cols));
	lines.push("");
	for (const tool of snapshot.tools) {
		lines.push(...wrapText(`* ${tool.name}  ${tool.detail}`, cols));
	}
	if (snapshot.tools.length > 0) lines.push("");
	if (snapshot.assistantText) lines.push(...wrapText(snapshot.assistantText, cols));
	return lines;
}

function pickCols(width: number): number {
	const fitted = Math.floor((width - PAD * 2) / CELL_W);
	if (fitted >= DEFAULT_COLS) return DEFAULT_COLS;
	return Math.max(1, fitted);
}

export async function renderLongPhoto(
	snapshot: TurnSnapshot,
	opts: { dataDir: string; width?: number; maxHeight?: number },
): Promise<LongPhoto> {
	const widthHint = opts.width ?? DEFAULT_WIDTH;
	void (opts.maxHeight ?? DEFAULT_MAX_HEIGHT);
	const capped =
		snapshot.assistantText.length > ASSISTANT_CAP
			? { ...snapshot, assistantText: snapshot.assistantText.slice(0, ASSISTANT_CAP) }
			: snapshot;
	const cols = pickCols(widthHint);
	const lines = layoutLines(capped, cols);
	const { rgba, width, height } = rasterize(lines, { cols, pad: PAD, bg: BG, fg: FG, accent: ACCENT });
	const png = encodePng(width, height, rgba);
	const dir = capturesDir(opts.dataDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${snapshot.sessionId}-${Date.now()}.png`);
	writeFileSync(path, png);
	return { png, width, height, path };
}
