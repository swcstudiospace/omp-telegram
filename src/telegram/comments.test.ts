import { describe, expect, test } from "bun:test";
import type { BoundPost, IncomingComment } from "../types.ts";
import {
	isAllowedComment,
	parseCommentCommand,
	resolveBoundSession,
	sameChatId,
} from "./comments.ts";

function comment(over: Partial<IncomingComment> = {}): IncomingComment {
	return {
		chatId: -100222,
		messageId: 50,
		date: 1,
		from: { id: 9, isBot: false, username: "ada" },
		text: "hello",
		images: [],
		isBot: false,
		...over,
	};
}

function binding(over: Partial<BoundPost> = {}): BoundPost {
	return {
		sessionId: "sess-aaaa1111",
		channelId: "-100111",
		channelMessageId: 10,
		discussionChatId: "-100222",
		discussionMessageId: 40,
		postedAt: 1,
		title: "t",
		...over,
	};
}

describe("isAllowedComment", () => {
	test("rejects bots via isBot or from.isBot", () => {
		expect(isAllowedComment(comment({ isBot: true }), [])).toBe(false);
		expect(
			isAllowedComment(comment({ from: { id: 1, isBot: true }, isBot: false }), []),
		).toBe(false);
	});

	test("empty allowlist accepts any non-bot", () => {
		expect(isAllowedComment(comment(), [])).toBe(true);
		expect(isAllowedComment(comment({ from: undefined }), [])).toBe(true);
	});

	test("non-empty allowlist requires from.id", () => {
		expect(isAllowedComment(comment({ from: { id: 9, isBot: false } }), [9, 10])).toBe(true);
		expect(isAllowedComment(comment({ from: { id: 8, isBot: false } }), [9, 10])).toBe(false);
		expect(isAllowedComment(comment({ from: undefined }), [9])).toBe(false);
	});
});

describe("sameChatId", () => {
	test("matches numeric ids as number or digit string", () => {
		expect(sameChatId(-100111, "-100111")).toBe(true);
		expect(sameChatId("-100111", -100111)).toBe(true);
		expect(sameChatId(-100111, -100222)).toBe(false);
		expect(sameChatId("abc", "abc")).toBe(true);
	});
});

describe("resolveBoundSession", () => {
	const posts = [binding(), binding({ sessionId: "other", channelMessageId: 99, discussionMessageId: 77 })];

	test("matches Bot API 7+ forward_origin channel message id", () => {
		const found = resolveBoundSession(
			comment({
				replyToForwardOrigin: { type: "channel", chatId: -100111, messageId: 10 },
			}),
			posts,
		);
		expect(found?.sessionId).toBe("sess-aaaa1111");
	});

	test("matches legacy forward_from_message_id", () => {
		const found = resolveBoundSession(
			comment({
				replyToForwardFromChatId: -100111,
				replyToForwardFromMessageId: 10,
			}),
			posts,
		);
		expect(found?.sessionId).toBe("sess-aaaa1111");
	});

	test("matches replyToMessageId against discussionMessageId", () => {
		const found = resolveBoundSession(comment({ replyToMessageId: 40 }), posts);
		expect(found?.sessionId).toBe("sess-aaaa1111");
	});

	test("matches messageThreadId against discussionMessageId", () => {
		const found = resolveBoundSession(comment({ messageThreadId: 40 }), posts);
		expect(found?.sessionId).toBe("sess-aaaa1111");
	});

	test("matches replyToMessageId against channelMessageId", () => {
		const found = resolveBoundSession(comment({ replyToMessageId: 10 }), [binding({ discussionMessageId: undefined })]);
		expect(found?.sessionId).toBe("sess-aaaa1111");
	});

	test("unmatched returns undefined", () => {
		expect(resolveBoundSession(comment({ replyToMessageId: 12345 }), posts)).toBeUndefined();
		expect(resolveBoundSession(comment(), posts)).toBeUndefined();
	});

	test("forward origin chat id must match when present", () => {
		expect(
			resolveBoundSession(
				comment({
					replyToForwardOrigin: { type: "channel", chatId: -100999, messageId: 10 },
				}),
				posts,
			),
		).toBeUndefined();
	});
});

describe("parseCommentCommand", () => {
	test("stop and stop@bot abort", () => {
		expect(parseCommentCommand("/stop")).toEqual({ kind: "abort" });
		expect(parseCommentCommand("/stop@omp_bot")).toEqual({ kind: "abort" });
		expect(parseCommentCommand("  /stop@omp_bot now ")).toEqual({ kind: "abort" });
	});

	test("sessions and status", () => {
		expect(parseCommentCommand("/sessions")).toEqual({ kind: "status" });
		expect(parseCommentCommand("/status")).toEqual({ kind: "status" });
		expect(parseCommentCommand("/status@omp_bot")).toEqual({ kind: "status" });
	});

	test("empty and unknown slash ignore", () => {
		expect(parseCommentCommand("")).toEqual({ kind: "ignore" });
		expect(parseCommentCommand("   ")).toEqual({ kind: "ignore" });
		expect(parseCommentCommand("/help")).toEqual({ kind: "ignore" });
		expect(parseCommentCommand("/start")).toEqual({ kind: "ignore" });
	});

	test("plain text is a prompt", () => {
		expect(parseCommentCommand("  keep going  ")).toEqual({ kind: "prompt", text: "keep going" });
	});
});
