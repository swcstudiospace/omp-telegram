import type { BoundPost, IncomingComment } from "../types.ts";

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

export function parseCommentCommand(
	text: string,
): { kind: "abort" } | { kind: "prompt"; text: string } | { kind: "status" } | { kind: "ignore" } {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "ignore" };
	if (trimmed.startsWith("/")) {
		const cmd = trimmed.replace(/^\/([A-Za-z0-9_]+)(?:@\S+)?/, "/$1").split(/\s+/)[0]?.toLowerCase();
		if (cmd === "/stop") return { kind: "abort" };
		if (cmd === "/sessions" || cmd === "/status") return { kind: "status" };
		return { kind: "ignore" };
	}
	return { kind: "prompt", text: trimmed };
}
