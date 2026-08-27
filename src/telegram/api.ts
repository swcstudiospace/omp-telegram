import type {
	ChatInfo,
	IncomingComment,
	SentMessage,
	TelegramTransport,
	TelegramUpdate,
	TelegramUser,
} from "../types.ts";

const CHAT_TYPES: Record<string, true> = {
	private: true,
	group: true,
	supergroup: true,
	channel: true,
};

export function createTelegramApi(botToken: string): TelegramTransport {
	const apiBase = `https://api.telegram.org/bot${botToken}`;
	const fileBase = `https://api.telegram.org/file/bot${botToken}`;

	async function callJson(method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const res = await fetchSafe(`${apiBase}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal,
		}, botToken);
		return unwrap(res, botToken);
	}

	async function callMultipart(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		png: Uint8Array,
		filename: string,
	): Promise<unknown> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.set(key, value);
		form.set(fileField, new Blob([png], { type: "image/png" }), filename);
		const res = await fetchSafe(`${apiBase}/${method}`, { method: "POST", body: form }, botToken);
		return unwrap(res, botToken);
	}

	return {
		async getMe() {
			const result = asRecord(await callJson("getMe"));
			const id = asFiniteNumber(result?.id);
			if (id === undefined) throw new Error("getMe: missing id");
			return {
				id,
				username: asOptionalString(result?.username),
				canReadAllGroupMessages:
					typeof result?.can_read_all_group_messages === "boolean"
						? result.can_read_all_group_messages
						: undefined,
			};
		},

		async getChat(chatId) {
			const result = asRecord(await callJson("getChat", { chat_id: chatId }));
			const id = asFiniteNumber(result?.id);
			if (id === undefined) throw new Error("getChat: missing id");
			const typeRaw = result?.type;
			const type: ChatInfo["type"] =
				typeof typeRaw === "string" && CHAT_TYPES[typeRaw]
					? (typeRaw as ChatInfo["type"])
					: "group";
			return {
				id,
				type,
				title: asOptionalString(result?.title),
				username: asOptionalString(result?.username),
				linkedChatId: asFiniteNumber(result?.linked_chat_id),
			};
		},

		async sendPhoto(args) {
			return parseSent(
				await callMultipart(
					"sendPhoto",
					mediaFields(args),
					"photo",
					args.png,
					args.filename,
				),
			);
		},

		async sendDocument(args) {
			return parseSent(
				await callMultipart(
					"sendDocument",
					mediaFields(args),
					"document",
					args.png,
					args.filename,
				),
			);
		},

		async sendMessage(args) {
			const body: Record<string, unknown> = {
				chat_id: args.chatId,
				text: args.text,
			};
			if (args.replyToMessageId !== undefined) body.reply_to_message_id = args.replyToMessageId;
			if (args.messageThreadId !== undefined) body.message_thread_id = args.messageThreadId;
			return parseSent(await callJson("sendMessage", body));
		},

		async getFile(fileId) {
			const result = asRecord(await callJson("getFile", { file_id: fileId }));
			const filePath = asOptionalString(result?.file_path);
			if (!filePath) throw new Error("getFile: missing file_path");
			const res = await fetchSafe(`${fileBase}/${filePath}`, { method: "GET" }, botToken);
			if (!res.ok) {
				throw new Error(`getFile download failed: ${res.status}`);
			}
			const buf = new Uint8Array(await res.arrayBuffer());
			return { filePath, bytes: buf };
		},

		async getUpdates(args) {
			const result = await callJson(
				"getUpdates",
				{
					offset: args.offset,
					timeout: args.timeout,
					allowed_updates: ["message", "channel_post", "edited_message"],
				},
				args.signal,
			);
			if (!Array.isArray(result)) return [];
			const updates: TelegramUpdate[] = [];
			for (const item of result) {
				const rec = asRecord(item);
				const updateId = asFiniteNumber(rec?.update_id);
				if (updateId === undefined) continue;
				const message =
					parseIncomingComment(rec?.message) ?? parseIncomingComment(rec?.edited_message);
				const channelPost = parseChannelPost(rec?.channel_post);
				updates.push({ updateId, message, channelPost });
			}
			return updates;
		},
	};
}

export function parseIncomingComment(raw: unknown): IncomingComment | undefined {
	const rec = asRecord(raw);
	if (!rec) return undefined;
	const chat = asRecord(rec.chat);
	const chatId = asFiniteNumber(chat?.id);
	const messageId = asFiniteNumber(rec.message_id);
	const date = asFiniteNumber(rec.date) ?? 0;
	if (chatId === undefined || messageId === undefined) return undefined;

	const from = parseUser(rec.from);
	const text =
		(typeof rec.text === "string" ? rec.text : undefined) ??
		(typeof rec.caption === "string" ? rec.caption : undefined) ??
		"";

	const reply = asRecord(rec.reply_to_message);
	const selfOrigin = parseChannelOrigin(rec.forward_origin);
	const replyOrigin = parseChannelOrigin(reply?.forward_origin);
	const selfForwardChat = asFiniteNumber(asRecord(rec.forward_from_chat)?.id);
	const replyForwardChat = asFiniteNumber(asRecord(reply?.forward_from_chat)?.id);
	const selfForwardMsg = asFiniteNumber(rec.forward_from_message_id);
	const replyForwardMsg = asFiniteNumber(reply?.forward_from_message_id);

	const comment: IncomingComment = {
		chatId,
		messageId,
		date,
		from,
		text,
		images: collectImages(rec),
		replyToMessageId: asFiniteNumber(reply?.message_id),
		replyToIsAutomaticForward: reply
			? reply.is_automatic_forward === true
			: rec.is_automatic_forward === true || undefined,
		replyToForwardOrigin: replyOrigin ?? (reply ? undefined : selfOrigin),
		replyToForwardFromChatId: reply ? replyForwardChat : selfForwardChat,
		replyToForwardFromMessageId: reply ? replyForwardMsg : selfForwardMsg,
		messageThreadId: asFiniteNumber(rec.message_thread_id),
		isBot: from?.isBot === true,
	};

	return comment;
}

function mediaFields(args: {
	chatId: string | number;
	caption: string;
	replyToMessageId?: number;
	messageThreadId?: number;
}): Record<string, string> {
	const fields: Record<string, string> = {
		chat_id: String(args.chatId),
		caption: args.caption,
		parse_mode: "HTML",
	};
	if (args.replyToMessageId !== undefined) {
		fields.reply_to_message_id = String(args.replyToMessageId);
	}
	if (args.messageThreadId !== undefined) {
		fields.message_thread_id = String(args.messageThreadId);
	}
	return fields;
}

function parseSent(raw: unknown): SentMessage {
	const rec = asRecord(raw);
	const chatId = asFiniteNumber(asRecord(rec?.chat)?.id);
	const messageId = asFiniteNumber(rec?.message_id);
	const date = asFiniteNumber(rec?.date) ?? 0;
	if (chatId === undefined || messageId === undefined) {
		throw new Error("send: missing chat or message id");
	}
	return { chatId, messageId, date };
}

function parseChannelPost(raw: unknown): TelegramUpdate["channelPost"] | undefined {
	const rec = asRecord(raw);
	if (!rec) return undefined;
	const chatId = asFiniteNumber(asRecord(rec.chat)?.id);
	const messageId = asFiniteNumber(rec.message_id);
	const date = asFiniteNumber(rec.date);
	if (chatId === undefined || messageId === undefined || date === undefined) return undefined;
	const text =
		typeof rec.text === "string" ? rec.text : typeof rec.caption === "string" ? rec.caption : undefined;
	return { chatId, messageId, date, text };
}

function parseUser(raw: unknown): TelegramUser | undefined {
	const rec = asRecord(raw);
	const id = asFiniteNumber(rec?.id);
	if (id === undefined) return undefined;
	return {
		id,
		isBot: rec?.is_bot === true,
		username: asOptionalString(rec?.username),
		firstName: asOptionalString(rec?.first_name),
	};
}

function parseChannelOrigin(raw: unknown): IncomingComment["replyToForwardOrigin"] {
	const rec = asRecord(raw);
	if (!rec || rec.type !== "channel") return undefined;
	const chatId = asFiniteNumber(asRecord(rec.chat)?.id);
	const messageId = asFiniteNumber(rec.message_id);
	if (chatId === undefined || messageId === undefined) return undefined;
	return { type: "channel", chatId, messageId };
}

function collectImages(rec: Record<string, unknown>): Array<{ fileId: string }> {
	const images: Array<{ fileId: string }> = [];
	if (Array.isArray(rec.photo) && rec.photo.length > 0) {
		let best: { fileId: string; score: number } | undefined;
		for (const item of rec.photo) {
			const photo = asRecord(item);
			const fileId = asOptionalString(photo?.file_id);
			if (!fileId) continue;
			const w = asFiniteNumber(photo?.width) ?? 0;
			const h = asFiniteNumber(photo?.height) ?? 0;
			const size = asFiniteNumber(photo?.file_size) ?? 0;
			const score = w * h || size;
			if (!best || score >= best.score) best = { fileId, score };
		}
		if (best) images.push({ fileId: best.fileId });
	}
	const doc = asRecord(rec.document);
	const mime = asOptionalString(doc?.mime_type);
	const docId = asOptionalString(doc?.file_id);
	if (docId && mime && mime.startsWith("image/")) {
		images.push({ fileId: docId });
	}
	return images;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redact(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("<redacted>");
}

async function fetchSafe(url: string, init: RequestInit, token: string): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redact(message, token));
	}
}

async function unwrap(res: Response, token: string): Promise<unknown> {
	let payload: unknown;
	try {
		payload = await res.json();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redact(`telegram HTTP ${res.status}: ${message}`, token));
	}
	const rec = asRecord(payload);
	if (!rec) throw new Error("telegram: invalid response");
	if (rec.ok === false) {
		const description =
			typeof rec.description === "string" && rec.description
				? redact(rec.description, token)
				: `telegram error ${typeof rec.error_code === "number" ? rec.error_code : res.status}`;
		throw new Error(description);
	}
	if (rec.ok !== true) throw new Error("telegram: missing ok");
	return rec.result;
}
