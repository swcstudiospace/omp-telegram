import { basename } from "node:path";
import type { RosterEntry, TelegramConfig } from "./types.ts";

export type TelegramCmd = "status" | "on" | "off" | "post" | "help";

export function parseTelegramArgs(args: string): { cmd: TelegramCmd; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { cmd: "status", rest: "" };
	const parts = trimmed.split(/\s+/);
	if (parts[0]?.toLowerCase() === "telegram" || parts[0]?.toLowerCase() === "tg") {
		parts.shift();
	}
	if (parts.length === 0) return { cmd: "status", rest: "" };
	const head = parts[0]!.toLowerCase();
	const rest = parts.slice(1).join(" ");
	if (head === "status" || head === "on" || head === "off" || head === "post" || head === "help") {
		return { cmd: head, rest };
	}
	return { cmd: "help", rest: trimmed };
}

function sessionTail(sessionId: string): string {
	if (sessionId.length <= 8) return sessionId;
	return sessionId.slice(-8);
}

export function formatRoster(entries: RosterEntry[]): string {
	if (entries.length === 0) return "(no sessions)";
	return entries
		.map((entry) => {
			const idle = entry.idle ? "idle" : "busy";
			const title = entry.title.trim() || "(untitled)";
			return `${sessionTail(entry.sessionId)}  ${basename(entry.cwd)}  ${idle}  ${title}`;
		})
		.join("\n");
}

export function formatStatus(args: {
	cfg: TelegramConfig;
	connected: boolean;
	roster: RosterEntry[];
	problems: string[];
}): string {
	const lines: string[] = [
		`Telegram ${args.cfg.enabled ? "on" : "off"} · ${args.connected ? "connected" : "disconnected"}`,
	];
	if (args.cfg.channelId) lines.push(`Channel: ${args.cfg.channelId}`);
	if (args.cfg.discussionGroupId) lines.push(`Discussion: ${args.cfg.discussionGroupId}`);
	if (args.problems.length > 0) {
		lines.push("Problems:");
		for (const problem of args.problems) lines.push(`  ${problem}`);
	}
	lines.push("Sessions:");
	lines.push(formatRoster(args.roster));
	return lines.join("\n");
}
