import { afterEach, describe, expect, test } from "bun:test";
import { createTelegramApi, parseIncomingComment } from "./api.ts";

const CHANNEL_ID = -1001111111111;
const DISCUSSION_ID = -1002222222222;

const commentJson = {
	message_id: 88,
	from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
	chat: { id: DISCUSSION_ID, title: "OMP comments", type: "supergroup" },
	date: 1_700_000_100,
	text: "keep going",
	message_thread_id: 55,
	reply_to_message: {
		message_id: 55,
		from: { id: 136817688, is_bot: true, first_name: "Channel" },
		sender_chat: { id: CHANNEL_ID, title: "OMP", type: "channel" },
		chat: { id: DISCUSSION_ID, title: "OMP comments", type: "supergroup" },
		date: 1_700_000_050,
		is_automatic_forward: true,
		forward_origin: {
			type: "channel",
			date: 1_700_000_040,
			chat: { id: CHANNEL_ID, title: "OMP", type: "channel" },
			message_id: 17,
		},
		forward_from_chat: { id: CHANNEL_ID, title: "OMP", type: "channel" },
		forward_from_message_id: 17,
		photo: [
			{ file_id: "small", width: 90, height: 90, file_size: 800 },
			{ file_id: "large", width: 1280, height: 720, file_size: 80_000 },
		],
		caption: "OMP turn",
	},
};

describe("parseIncomingComment", () => {
	test("parses reply to automatic channel forward with forward_origin", () => {
		const comment = parseIncomingComment(commentJson);
		expect(comment).toEqual({
			chatId: DISCUSSION_ID,
			messageId: 88,
			date: 1_700_000_100,
			from: { id: 42, isBot: false, username: "ada", firstName: "Ada" },
			text: "keep going",
			images: [],
			replyToMessageId: 55,
			replyToIsAutomaticForward: true,
			replyToForwardOrigin: { type: "channel", chatId: CHANNEL_ID, messageId: 17 },
			replyToForwardFromChatId: CHANNEL_ID,
			replyToForwardFromMessageId: 17,
			messageThreadId: 55,
			isBot: false,
		});
	});

	test("parses legacy forward_from_chat without forward_origin", () => {
		const comment = parseIncomingComment({
			message_id: 9,
			from: { id: 7, is_bot: false, first_name: "Bo" },
			chat: { id: DISCUSSION_ID, type: "supergroup" },
			date: 2,
			text: "legacy",
			reply_to_message: {
				message_id: 8,
				chat: { id: DISCUSSION_ID, type: "supergroup" },
				date: 1,
				is_automatic_forward: true,
				forward_from_chat: { id: CHANNEL_ID, type: "channel" },
				forward_from_message_id: 3,
			},
		});
		expect(comment?.replyToIsAutomaticForward).toBe(true);
		expect(comment?.replyToForwardOrigin).toBeUndefined();
		expect(comment?.replyToForwardFromChatId).toBe(CHANNEL_ID);
		expect(comment?.replyToForwardFromMessageId).toBe(3);
		expect(comment?.replyToMessageId).toBe(8);
	});

	test("takes largest photo and image documents; ignores sticker and voice", () => {
		const photo = parseIncomingComment({
			message_id: 1,
			chat: { id: 1, type: "supergroup" },
			date: 1,
			from: { id: 2, is_bot: false, first_name: "A" },
			photo: [
				{ file_id: "a", width: 10, height: 10 },
				{ file_id: "b", width: 320, height: 240 },
				{ file_id: "c", width: 80, height: 80 },
			],
			sticker: { file_id: "sticker" },
			voice: { file_id: "voice" },
			caption: "pic",
		});
		expect(photo?.text).toBe("pic");
		expect(photo?.images).toEqual([{ fileId: "b" }]);

		const doc = parseIncomingComment({
			message_id: 2,
			chat: { id: 1, type: "supergroup" },
			date: 1,
			document: { file_id: "png", mime_type: "image/png", file_name: "x.png" },
		});
		expect(doc?.images).toEqual([{ fileId: "png" }]);

		const pdf = parseIncomingComment({
			message_id: 3,
			chat: { id: 1, type: "supergroup" },
			date: 1,
			document: { file_id: "pdf", mime_type: "application/pdf" },
		});
		expect(pdf?.images).toEqual([]);
	});

	test("maps a discussion auto-forward's own origin onto replyTo fields", () => {
		const auto = parseIncomingComment({
			message_id: 55,
			chat: { id: DISCUSSION_ID, type: "supergroup" },
			date: 1,
			is_automatic_forward: true,
			forward_origin: {
				type: "channel",
				chat: { id: CHANNEL_ID, type: "channel" },
				message_id: 17,
			},
			from: { id: 136817688, is_bot: true, first_name: "Channel" },
		});
		expect(auto?.isBot).toBe(true);
		expect(auto?.replyToIsAutomaticForward).toBe(true);
		expect(auto?.replyToForwardOrigin).toEqual({
			type: "channel",
			chatId: CHANNEL_ID,
			messageId: 17,
		});
		expect(auto?.replyToMessageId).toBeUndefined();
	});

	test("returns undefined without chat or message_id", () => {
		expect(parseIncomingComment({})).toBeUndefined();
		expect(parseIncomingComment(null)).toBeUndefined();
	});
});

describe("createTelegramApi", () => {
	const token = "TEST_TOKEN_DO_NOT_LEAK";
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];

	afterEach(() => {
		globalThis.fetch = originalFetch;
		calls.length = 0;
	});

	function jsonOk(result: unknown, status = 200): Response {
		return new Response(JSON.stringify({ ok: true, result }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	function install(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			calls.push({ url, init });
			return handler(url, init);
		}) as typeof fetch;
	}

	test("getChat maps linked_chat_id", async () => {
		install(() =>
			jsonOk({
				id: CHANNEL_ID,
				type: "channel",
				title: "OMP",
				username: "omp",
				linked_chat_id: DISCUSSION_ID,
			}),
		);
		const chat = await createTelegramApi(token).getChat(CHANNEL_ID);
		expect(chat).toEqual({
			id: CHANNEL_ID,
			type: "channel",
			title: "OMP",
			username: "omp",
			linkedChatId: DISCUSSION_ID,
		});
		expect(String(calls[0]?.init?.body)).toContain(String(CHANNEL_ID));
	});

	test("getUpdates parses message and edited_message; posts JSON allowed_updates", async () => {
		install(() =>
			jsonOk([
				{ update_id: 5, message: commentJson },
				{
					update_id: 6,
					edited_message: { ...commentJson, message_id: 89, text: "edited" },
				},
				{
					update_id: 7,
					channel_post: {
						message_id: 17,
						chat: { id: CHANNEL_ID, type: "channel" },
						date: 9,
						caption: "posted",
					},
				},
			]),
		);
		const updates = await createTelegramApi(token).getUpdates({ offset: 5, timeout: 20 });
		expect(updates[0]?.updateId).toBe(5);
		expect(updates[0]?.message?.text).toBe("keep going");
		expect(updates[1]?.message?.text).toBe("edited");
		expect(updates[2]?.channelPost).toEqual({
			chatId: CHANNEL_ID,
			messageId: 17,
			date: 9,
			text: "posted",
		});
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body).toEqual({
			offset: 5,
			timeout: 20,
			allowed_updates: ["message", "channel_post", "edited_message"],
		});
		expect(calls[0]?.url).toContain(`/bot${token}/getUpdates`);
	});

	test("sendPhoto uses multipart photo field and HTML caption", async () => {
		install(() =>
			jsonOk({
				message_id: 17,
				date: 9,
				chat: { id: CHANNEL_ID, type: "channel" },
			}),
		);
		const png = new Uint8Array([1, 2, 3]);
		const sent = await createTelegramApi(token).sendPhoto({
			chatId: CHANNEL_ID,
			png,
			filename: "turn.png",
			caption: "<b>OMP</b>",
		});
		expect(sent).toEqual({ chatId: CHANNEL_ID, messageId: 17, date: 9 });
		const body = calls[0]?.init?.body;
		expect(body).toBeInstanceOf(FormData);
		const form = body as FormData;
		expect(form.get("caption")).toBe("<b>OMP</b>");
		expect(form.get("parse_mode")).toBe("HTML");
		expect(form.get("chat_id")).toBe(String(CHANNEL_ID));
		expect(form.get("photo")).toBeInstanceOf(Blob);
		expect(form.get("document")).toBeNull();
	});

	test("ok:false throws description without the token", async () => {
		install(
			() =>
				new Response(
					JSON.stringify({
						ok: false,
						error_code: 401,
						description: `Unauthorized: token ${token} rejected`,
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		);
		let message = "";
		try {
			await createTelegramApi(token).getMe();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Unauthorized");
		expect(message).not.toContain(token);
		expect(message).toContain("<redacted>");
	});
});
