import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { isAllowedComment, parseCommentCommand, resolveBoundSession } from "../telegram/comments.ts";
import { buildCaption, postCompletion } from "../telegram/post.ts";
import { isDiscussionAutoForward } from "../telegram/updates.ts";
import { socketPath } from "../paths.ts";
import type {
	BoundPost,
	BrokerToClient,
	ClientToBroker,
	CommentImage,
	IncomingComment,
	RosterEntry,
	SessionId,
	SessionInfo,
	TelegramConfig,
	TelegramTransport,
	TelegramUpdate,
} from "../types.ts";
import {
	findByChannelMessage,
	loadBindings,
	rememberDiscussionForward,
	saveBindings,
	upsertBinding,
} from "./bindings.ts";

const HEARTBEAT_MS = 90_000;

type SessionSlot = {
	session: SessionInfo;
	idle: boolean;
	lastSeenAt: number;
	send?: (msg: BrokerToClient) => void;
};

type UnixSocket = {
	write(data: string | Uint8Array): number;
	end(data?: string | Uint8Array): void;
};

function pngDimensions(png: Uint8Array): { width: number; height: number } {
	if (png.byteLength < 24) throw new Error("invalid png");
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function sessionTail(sessionId: string): string {
	return sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
}

function guessMime(filePath: string): string {
	const p = filePath.toLowerCase();
	if (p.endsWith(".png")) return "image/png";
	if (p.endsWith(".gif")) return "image/gif";
	if (p.endsWith(".webp")) return "image/webp";
	if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
	return "image/jpeg";
}

function safeError(err: unknown, token: string): string {
	const msg = err instanceof Error ? err.message : "error";
	if (token && msg.includes(token)) return msg.split(token).join("[token]");
	return msg;
}

function formatRoster(entries: RosterEntry[]): string {
	const online = entries.filter((e) => e.connected);
	if (online.length === 0) return "No sessions online.";
	return online
		.map((e) => {
			const tail = sessionTail(e.sessionId);
			const state = e.idle ? "idle" : "busy";
			return `${e.title || tail} ${state} (${tail})`;
		})
		.join("\n");
}

function originMessageId(comment: IncomingComment): number | undefined {
	return comment.replyToForwardOrigin?.messageId ?? comment.replyToForwardFromMessageId;
}

function hasReply(comment: IncomingComment): boolean {
	return (
		comment.replyToMessageId !== undefined ||
		comment.replyToForwardOrigin !== undefined ||
		comment.replyToForwardFromMessageId !== undefined
	);
}

function isConnected(slot: SessionSlot, now = Date.now()): boolean {
	return !!slot.send && now - slot.lastSeenAt <= HEARTBEAT_MS;
}

async function downloadImages(
	api: TelegramTransport,
	comment: IncomingComment,
): Promise<CommentImage[]> {
	const images: CommentImage[] = [];
	for (const img of comment.images) {
		try {
			const file = await api.getFile(img.fileId);
			images.push({
				fileId: img.fileId,
				mimeType: guessMime(file.filePath),
				bytes: file.bytes,
			});
		} catch {
			images.push({ fileId: img.fileId, mimeType: "image/jpeg" });
		}
	}
	return images;
}

export async function createBrokerServer(opts: {
	config: TelegramConfig;
	api: TelegramTransport;
	dataDir: string;
}): Promise<{
	close(): Promise<void>;
	roster(): RosterEntry[];
	handleUpdate(update: TelegramUpdate): Promise<void>;
	handleClientLine(line: string, send: (msg: BrokerToClient) => void): Promise<void>;
}> {
	const { api, dataDir } = opts;
	const config = opts.config;
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	let discussionGroupId = config.discussionGroupId;
	if (!discussionGroupId) {
		try {
			const chat = await api.getChat(config.channelId);
			if (chat.linkedChatId) discussionGroupId = String(chat.linkedChatId);
		} catch {
			// channel lookup is best-effort
		}
	}
	void discussionGroupId;

	const sessions = new Map<SessionId, SessionSlot>();
	const sockets = new Set<UnixSocket>();
	const buffers = new WeakMap<UnixSocket, string>();

	function roster(): RosterEntry[] {
		const now = Date.now();
		const entries: RosterEntry[] = [];
		for (const slot of sessions.values()) {
			entries.push({
				...slot.session,
				idle: slot.idle,
				lastSeenAt: slot.lastSeenAt,
				connected: isConnected(slot, now),
			});
		}
		return entries;
	}

	function persistBindings(bindings: BoundPost[]): void {
		saveBindings(dataDir, bindings);
	}

	async function handleClientLine(line: string, send: (msg: BrokerToClient) => void): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			send({ v: 1, id: "0", type: "error", error: "invalid json" });
			return;
		}
		if (!parsed || typeof parsed !== "object") {
			send({ v: 1, id: "0", type: "error", error: "invalid message" });
			return;
		}
		const msg = parsed as ClientToBroker;
		const id = typeof msg.id === "string" ? msg.id : "0";
		if (msg.v !== 1) {
			send({ v: 1, id, type: "error", error: "invalid message" });
			return;
		}

		switch (msg.type) {
			case "register": {
				const session = msg.session;
				if (!session || typeof session.sessionId !== "string") {
					send({ v: 1, id, type: "error", error: "invalid session" });
					return;
				}
				sessions.set(session.sessionId, {
					session: { ...session },
					idle: false,
					lastSeenAt: Date.now(),
					send,
				});
				send({ v: 1, id, type: "ok" });
				return;
			}
			case "heartbeat": {
				const slot = sessions.get(msg.sessionId);
				if (!slot) {
					send({ v: 1, id, type: "error", error: "unknown session" });
					return;
				}
				slot.idle = msg.idle;
				slot.lastSeenAt = Date.now();
				slot.send = send;
				if (typeof msg.title === "string") slot.session.title = msg.title;
				send({ v: 1, id, type: "ok" });
				return;
			}
			case "unregister": {
				const slot = sessions.get(msg.sessionId);
				if (slot && slot.send === send) slot.send = undefined;
				sessions.delete(msg.sessionId);
				send({ v: 1, id, type: "ok" });
				return;
			}
			case "status": {
				send({ v: 1, id, type: "ok", data: roster() });
				return;
			}
			case "completion": {
				const slot = sessions.get(msg.sessionId);
				if (!slot) {
					send({ v: 1, id, type: "error", error: "unknown session" });
					return;
				}
				slot.lastSeenAt = Date.now();
				slot.send = send;
				const payload = msg.payload;
				if (!payload || typeof payload.pngPath !== "string") {
					send({ v: 1, id, type: "error", error: "png missing" });
					return;
				}
				const file = Bun.file(payload.pngPath);
				if (!(await file.exists())) {
					send({ v: 1, id, type: "error", error: "png missing" });
					return;
				}
				let png: Uint8Array;
				let height: number;
				try {
					png = new Uint8Array(await file.arrayBuffer());
					height = pngDimensions(png).height;
				} catch (err) {
					send({ v: 1, id, type: "error", error: safeError(err, config.botToken) });
					return;
				}
				try {
					const caption = buildCaption({
						session: slot.session,
						payload,
						previewLimit: config.captionPreviewChars,
					});
					const sent = await postCompletion({
						api,
						config: { channelId: config.channelId, photoMaxHeight: config.photoMaxHeight },
						png,
						filename: basename(payload.pngPath) || "turn.png",
						caption,
						pngHeight: height,
					});
					const bindings = loadBindings(dataDir);
					upsertBinding(bindings, {
						sessionId: msg.sessionId,
						channelId: config.channelId,
						channelMessageId: sent.messageId,
						postedAt: Date.now(),
						title: payload.title,
					});
					persistBindings(bindings);
					send({ v: 1, id, type: "ok", data: sent });
				} catch (err) {
					send({ v: 1, id, type: "error", error: safeError(err, config.botToken) });
				}
				return;
			}
			default: {
				send({ v: 1, id, type: "error", error: "invalid message" });
			}
		}
	}

	async function reply(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
		try {
			await api.sendMessage({ chatId, text, replyToMessageId });
		} catch {
			// never throw out of handleUpdate
		}
	}

	async function handleUpdate(update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (!message) return;

		if (isDiscussionAutoForward(message, config.channelId)) {
			const originId = originMessageId(message);
			if (originId !== undefined) {
				const bindings = loadBindings(dataDir);
				if (findByChannelMessage(bindings, originId)) {
					rememberDiscussionForward(
						bindings,
						originId,
						String(message.chatId),
						message.messageId,
					);
					persistBindings(bindings);
				}
			}
		}

		if (!isAllowedComment(message, config.allowedUserIds)) return;

		const bindings = loadBindings(dataDir);
		const bound = resolveBoundSession(message, bindings);
		const cmd = parseCommentCommand(message.text);

		if (!bound) {
			if (hasReply(message)) {
				await reply(message.chatId, "Not an OMP session post.", message.messageId);
				return;
			}
			if (cmd.kind === "status" || /^\/(?:sessions|status)\b/i.test(message.text.trim())) {
				await reply(message.chatId, formatRoster(roster()), message.messageId);
			}
			return;
		}

		if (cmd.kind === "ignore") return;

		const slot = sessions.get(bound.sessionId);
		const connected = slot ? isConnected(slot) : false;
		const tail = sessionTail(bound.sessionId);

		if (cmd.kind === "abort") {
			if (connected && slot?.send) {
				slot.send({
					v: 1,
					type: "abort",
					sessionId: bound.sessionId,
					commentId: message.messageId,
					chatId: message.chatId,
				});
			} else {
				await reply(message.chatId, "session offline", message.messageId);
			}
			return;
		}

		if (cmd.kind === "status") {
			await reply(message.chatId, formatRoster(roster()), message.messageId);
			return;
		}

		if (cmd.kind === "prompt") {
			if (connected && slot?.send) {
				const images = await downloadImages(api, message);
				slot.send({
					v: 1,
					type: "prompt",
					sessionId: bound.sessionId,
					text: cmd.text,
					commentId: message.messageId,
					chatId: message.chatId,
					images,
				});
			} else {
				const online = roster()
					.filter((e) => e.connected)
					.map((e) => e.title || sessionTail(e.sessionId))
					.join(", ");
				await reply(
					message.chatId,
					`Session ${tail} is offline. Online: ${online || "none"}`,
					message.messageId,
				);
			}
		}
	}

	const sock = socketPath(dataDir);
	if (existsSync(sock)) {
		try {
			unlinkSync(sock);
		} catch {
			// listen will fail if still present
		}
	}

	const listener = Bun.listen<UnixSocket>({
		unix: sock,
		socket: {
			open(socket) {
				sockets.add(socket);
				buffers.set(socket, "");
			},
			data(socket, data) {
				const chunk = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				let buf = `${buffers.get(socket) ?? ""}${chunk}`;
				for (;;) {
					const nl = buf.indexOf("\n");
					if (nl < 0) break;
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					const send = (msg: BrokerToClient) => {
						try {
							socket.write(`${JSON.stringify(msg)}\n`);
						} catch {
							// drop
						}
					};
					void handleClientLine(line, send).catch(() => {
						send({ v: 1, id: "0", type: "error", error: "internal" });
					});
				}
				buffers.set(socket, buf);
			},
			close(socket) {
				sockets.delete(socket);
				for (const slot of sessions.values()) {
					if (slot.send) {
						try {
							// identity is the closure from this socket; drop matching senders
						} catch {
							// ignore
						}
					}
				}
			},
			error(socket) {
				sockets.delete(socket);
			},
		},
	});

	// Track senders by wrapping writes so close can drop the right session slots.
	const senders = new Map<UnixSocket, (msg: BrokerToClient) => void>();

	async function close(): Promise<void> {
		try {
			listener.stop(true);
		} catch {
			// already stopped
		}
		for (const socket of sockets) {
			try {
				socket.end();
			} catch {
				// ignore
			}
		}
		sockets.clear();
		senders.clear();
		try {
			unlinkSync(sock);
		} catch {
			// already gone
		}
	}

	return { close, roster, handleUpdate, handleClientLine };
}
