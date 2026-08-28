import type { BoundPost, IncomingComment, RoutedCommand } from "../types.ts";

export function sameChatId(a: string | number, b: string | number): boolean {
	const sa = String(a).trim();
	const sb = String(b).trim();
	if (sa === sb) return true;
	const na = Number(sa);
	const nb = Number(sb);
	if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
	return String(na) === String(nb);
}

export function isAllowedComment(comment: IncomingComment, allowedUserIds: number[]): boolean {
	if (comment.isBot || comment.from?.isBot) return false;
	if (allowedUserIds.length === 0) return true;
	const id = comment.from?.id;
	if (id === undefined) return false;
	return allowedUserIds.includes(id);
}

export function resolveBoundSession(
	comment: IncomingComment,
	bindings: BoundPost[],
): BoundPost | undefined {
	const origin = comment.replyToForwardOrigin;
	if (origin) {
		const found = bindings.find(
			(b) =>
				b.channelMessageId === origin.messageId &&
				sameChatId(origin.chatId, b.channelId),
		);
		if (found) return found;
	}

	if (comment.replyToForwardFromMessageId !== undefined) {
		const found = bindings.find((b) => {
			if (b.channelMessageId !== comment.replyToForwardFromMessageId) return false;
			if (
				comment.replyToForwardFromChatId !== undefined &&
				!sameChatId(comment.replyToForwardFromChatId, b.channelId)
			) {
				return false;
			}
			return true;
		});
		if (found) return found;
	}

	if (comment.replyToMessageId !== undefined) {
		const found = bindings.find((b) => b.discussionMessageId === comment.replyToMessageId);
		if (found) return found;
	}

	if (comment.messageThreadId !== undefined) {
		const found = bindings.find((b) => b.discussionMessageId === comment.messageThreadId);
		if (found) return found;
	}

	if (comment.replyToMessageId !== undefined) {
		const found = bindings.find((b) => b.channelMessageId === comment.replyToMessageId);
		if (found) return found;
	}

	return undefined;
}

function tokenizeCommand(text: string): { cmd: string; rest: string } | undefined {
	const trimmed = text.trim();
	const match = trimmed.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return {
		cmd: match[1]!.toLowerCase(),
		rest: (match[2] ?? "").trim(),
	};
}

function splitExec(rest: string): string[] {
	return rest.split(/\s+/).filter(Boolean);
}

export function parseCommentCommand(text: string): RoutedCommand | { kind: "ignore" } {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "ignore" };

	const parsed = tokenizeCommand(trimmed);
	if (!parsed) {
		return { kind: "prompt", text: trimmed };
	}

	if (parsed.cmd === "stop") return { kind: "control", name: "stop" };
	if (parsed.cmd === "status" || parsed.cmd === "sessions") return { kind: "control", name: "status" };
	if (parsed.cmd === "post") return { kind: "control", name: "post" };
	if (parsed.cmd === "goal" || parsed.cmd === "advisor") {
		return { kind: "omp", name: parsed.cmd, text: trimmed };
	}
	if (parsed.cmd === "exec") {
		const argv = splitExec(parsed.rest);
		return argv.length > 0 ? { kind: "exec", argv, text: trimmed } : { kind: "ignore" };
	}

	return { kind: "ignore" };
}
