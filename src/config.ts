import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { agentDir, configPath, defaultDataDir } from "./paths.ts";
import type { TelegramConfig } from "./types.ts";

const DEFAULT_PHOTO_WIDTH = 1080;
const DEFAULT_PHOTO_MAX_HEIGHT = 8500;
const DEFAULT_CAPTION_PREVIEW = 400;

export function defaultConfig(): TelegramConfig {
	return {
		enabled: true,
		botToken: "",
		channelId: "",
		discussionGroupId: "",
		allowedUserIds: [],
		photoWidth: DEFAULT_PHOTO_WIDTH,
		photoMaxHeight: DEFAULT_PHOTO_MAX_HEIGHT,
		captionPreviewChars: DEFAULT_CAPTION_PREVIEW,
		dataDir: defaultDataDir(),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asIdList(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids: number[] = [];
	for (const item of value) {
		const n = typeof item === "number" ? item : Number(item);
		if (Number.isInteger(n) && n !== 0) ids.push(n);
	}
	return ids;
}

function parseCsvIds(raw: string | undefined): number[] | undefined {
	if (!raw?.trim()) return undefined;
	const ids: number[] = [];
	for (const part of raw.split(/[,\s]+/)) {
		if (!part) continue;
		const n = Number(part);
		if (Number.isInteger(n) && n !== 0) ids.push(n);
	}
	return ids;
}

function mergeFile(file: Record<string, unknown> | undefined, defaults: TelegramConfig): TelegramConfig {
	if (!file) return defaults;
	return {
		enabled: asBoolean(file.enabled) ?? defaults.enabled,
		botToken: asString(file.botToken) || defaults.botToken,
		channelId: asString(file.channelId) || asString(file.chatId) || defaults.channelId,
		discussionGroupId: asString(file.discussionGroupId) || defaults.discussionGroupId,
		allowedUserIds: asIdList(file.allowedUserIds) ?? defaults.allowedUserIds,
		photoWidth: asNumber(file.photoWidth) ?? defaults.photoWidth,
		photoMaxHeight: asNumber(file.photoMaxHeight) ?? defaults.photoMaxHeight,
		captionPreviewChars: asNumber(file.captionPreviewChars) ?? defaults.captionPreviewChars,
		dataDir: asString(file.dataDir) || defaults.dataDir,
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
	const file = mergeFile(asRecord(readJson(configPath())), defaultConfig());
	const allowed = parseCsvIds(env.TELEGRAM_ALLOWED_USERS) ?? file.allowedUserIds;
	const channelId =
		env.TELEGRAM_CHANNEL_ID?.trim() || env.TELEGRAM_CHAT_ID?.trim() || file.channelId;
	const discussionGroupId =
		env.TELEGRAM_DISCUSSION_GROUP_ID?.trim() || env.TELEGRAM_DISCUSSION_CHAT_ID?.trim() || file.discussionGroupId;
	const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || file.botToken;
	const dataDir = env.OMP_TELEGRAM_DIR?.trim() || file.dataDir;
	return {
		...file,
		botToken,
		channelId,
		discussionGroupId,
		allowedUserIds: allowed,
		dataDir,
	};
}

export function ensureDataDir(dataDir: string): void {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(agentDir(), { recursive: true, mode: 0o700 });
}

export function configProblems(cfg: TelegramConfig): string[] {
	const problems: string[] = [];
	if (!cfg.enabled) problems.push("disabled");
	if (!cfg.botToken) problems.push("missing TELEGRAM_BOT_TOKEN");
	if (!cfg.channelId) problems.push("missing TELEGRAM_CHANNEL_ID / TELEGRAM_CHAT_ID");
	return problems;
}
