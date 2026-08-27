import type { SkipReason, TelegramConfig, TurnSnapshot } from "../types.ts";
import { fingerprintTurn } from "./turn.ts";

const DUPLICATE_MS = 120_000;
const COOLDOWN_MS = 8_000;

function childSession(): boolean {
	return Boolean(
		process.env.PI_ULTRATHINK_CHILD || process.env.PI_AIO_CHILD || process.env.PI_CODING_AGENT_CHILD,
	);
}

export function shouldSkipCompletion(args: {
	cfg: TelegramConfig;
	stopHookActive: boolean;
	snapshot: TurnSnapshot;
	lastFingerprint?: string;
	lastPostedAt?: number;
	now?: number;
}): SkipReason | undefined {
	const { cfg, stopHookActive, snapshot } = args;
	if (!cfg.enabled) return "disabled";
	if (!cfg.botToken) return "no_token";
	if (!cfg.channelId) return "no_channel";
	if (childSession()) return "child_session";
	if (stopHookActive) return "stop_hook_active";
	if (!snapshot.assistantText.trim() && snapshot.tools.length === 0) return "empty";
	const now = args.now ?? Date.now();
	if (
		args.lastFingerprint === fingerprintTurn(snapshot) &&
		args.lastPostedAt !== undefined &&
		now - args.lastPostedAt < DUPLICATE_MS
	) {
		return "duplicate";
	}
	if (args.lastPostedAt !== undefined && now - args.lastPostedAt < COOLDOWN_MS) return "cooldown";
	return undefined;
}
