import { basename } from "node:path";
import { shouldSkipCompletion } from "./capture/skip.ts";
import { extractTurn, fingerprintTurn } from "./capture/turn.ts";
import type { CompletionPayload, SessionInfo, SkipReason, TelegramConfig, TurnSnapshot } from "./types.ts";

export function originFromMode(mode: string | undefined): CompletionPayload["origin"] {
	if (mode === "tui" || mode === "rpc" || mode === "print" || mode === "cli") return mode;
	return "unknown";
}

function asSessionMode(mode: string | undefined): SessionInfo["mode"] {
	if (mode === "tui" || mode === "rpc" || mode === "json" || mode === "print" || mode === "unknown") return mode;
	return "unknown";
}

export function sessionInfoFromCtx(ctx: {
	cwd: string;
	mode?: string;
	sessionManager: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
	sessionName?: string;
}): SessionInfo {
	const sessionId = ctx.sessionManager.getSessionId?.() || `pid-${process.pid}`;
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return {
		sessionId,
		pid: process.pid,
		cwd: ctx.cwd,
		title: ctx.sessionName?.trim() || basename(ctx.cwd) || sessionId,
		sessionFile: sessionFile || undefined,
		mode: asSessionMode(ctx.mode),
	};
}

function isMessageEntry(value: unknown): value is { type: "message"; message: unknown } {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || !("message" in value)) return false;
	return value.type === "message";
}

export function collectMessages(
	ctx: { sessionManager: { getBranch?: () => unknown[] } },
	eventMessages: unknown[],
): unknown[] {
	if (Array.isArray(eventMessages) && eventMessages.length > 0) return eventMessages;
	const branch = ctx.sessionManager.getBranch?.();
	if (!Array.isArray(branch) || branch.length === 0) return [];
	const mapped: unknown[] = [];
	let sawMessage = false;
	for (const entry of branch) {
		if (isMessageEntry(entry)) {
			sawMessage = true;
			mapped.push(entry.message);
		}
	}
	if (sawMessage) return mapped;
	return branch;
}

export function planCompletion(args: {
	cfg: TelegramConfig;
	stopHookActive: boolean;
	messages: unknown[];
	sessionId: string;
	cwd: string;
	origin: CompletionPayload["origin"];
	lastFingerprint?: string;
	lastPostedAt?: number;
	now?: number;
	force?: boolean;
}): { skip: SkipReason } | { post: TurnSnapshot } {
	if (!args.cfg.enabled) return { skip: "disabled" };
	if (!args.cfg.botToken) return { skip: "no_token" };
	if (!args.cfg.channelId) return { skip: "no_channel" };
	if (args.stopHookActive) return { skip: "stop_hook_active" };

	const snapshot = extractTurn({
		messages: args.messages,
		sessionId: args.sessionId,
		cwd: args.cwd,
		origin: args.origin,
	});
	if (
		!snapshot ||
		(!snapshot.assistantText.trim() && !snapshot.userText.trim() && snapshot.tools.length === 0)
	) {
		return { skip: "empty" };
	}

	const reason = shouldSkipCompletion({
		cfg: args.cfg,
		stopHookActive: args.stopHookActive,
		snapshot,
		lastFingerprint: args.lastFingerprint,
		lastPostedAt: args.lastPostedAt,
		now: args.now ?? Date.now(),
	});
	if (reason === "empty") return { skip: "empty" };
	if (reason && !(args.force && (reason === "duplicate" || reason === "cooldown"))) {
		return { skip: reason };
	}
	return { post: snapshot };
}

export { fingerprintTurn };
