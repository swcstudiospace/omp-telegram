import type { IncomingComment, TelegramUpdate } from "../types.ts";
import { sameChatId } from "./comments.ts";

export function nextOffset(updates: TelegramUpdate[], previous = 0): number {
	if (updates.length === 0) return previous;
	let max = previous - 1;
	for (const update of updates) {
		if (update.updateId > max) max = update.updateId;
	}
	return max + 1;
}

export function isDiscussionAutoForward(comment: IncomingComment, channelId: string): boolean {
	const origin = comment.replyToForwardOrigin;
	if (origin?.type === "channel" && sameChatId(origin.chatId, channelId)) return true;
	if (comment.replyToIsAutomaticForward) {
		if (comment.replyToForwardFromChatId === undefined) return true;
		return sameChatId(comment.replyToForwardFromChatId, channelId);
	}
	if (comment.replyToForwardFromMessageId !== undefined) {
		if (comment.replyToForwardFromChatId === undefined) return true;
		return sameChatId(comment.replyToForwardFromChatId, channelId);
	}
	return false;
}
