import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BrokerToClient,
	IncomingComment,
	SessionInfo,
	TelegramConfig,
	TelegramTransport,
} from "../types.ts";
import { createBrokerServer } from "./server.ts";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

function isolate(): string {
	const dir = join(tmpdir(), `omp-tg-srv-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pngWithSize(width: number, height: number): Uint8Array {
	const u = new Uint8Array(24);
	u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	u.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(u.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return u;
}

function cfg(dataDir: string): TelegramConfig {
	return {
		enabled: true,
		botToken: "test-token",
		channelId: "-100111",
		discussionGroupId: "-100222",
		allowedUserIds: [],
		photoWidth: 1080,
		photoMaxHeight: 8500,
		captionPreviewChars: 400,
		dataDir,
	};
}

function session(id: string, title: string): SessionInfo {
	return { sessionId: id, pid: 1, cwd: "/tmp", title };
}

function mockApi(): TelegramTransport & {
	photos: number;
	messages: Array<{ chatId: string | number; text: string }>;
} {
	const messages: Array<{ chatId: string | number; text: string }> = [];
	const api: TelegramTransport & {
		photos: number;
		messages: Array<{ chatId: string | number; text: string }>;
	} = {
		photos: 0,
		messages,
		getMe: async () => ({ id: 1, username: "bot" }),
		getChat: async () => ({ id: -100111, type: "channel", linkedChatId: -100222 }),
		sendPhoto: async (args) => {
			api.photos += 1;
			return { chatId: Number(args.chatId), messageId: 10, date: 1 };
		},
		sendDocument: async (args) => {
			return { chatId: Number(args.chatId), messageId: 11, date: 1 };
		},
		sendMessage: async (args) => {
			messages.push({ chatId: args.chatId, text: args.text });
			return { chatId: Number(args.chatId), messageId: 99, date: 1 };
		},
		getFile: async (fileId) => ({ filePath: "a.jpg", bytes: new Uint8Array([1, 2, 3]) }),
		getUpdates: async () => [],
	};
	return api;
}

function comment(over: Partial<IncomingComment> = {}): IncomingComment {
	return {
		chatId: -100222,
		messageId: 50,
		date: 1,
		from: { id: 9, isBot: false },
		text: "continue please",
		images: [],
		isBot: false,
		replyToForwardOrigin: { type: "channel", chatId: -100111, messageId: 10 },
		replyToIsAutomaticForward: true,
		...over,
	};
}

describe("createBrokerServer", () => {
	test("two sessions: completion posts once; comment prompts only A; bot ignored; /stop aborts; offline sendMessage", async () => {
		const dataDir = isolate();
		const api = mockApi();
		const server = await createBrokerServer({ config: cfg(dataDir), api, dataDir });
		servers.push(server);

		const sessionA = session("sess-aaaaaaaaaaaaaaaaA", "Alpha");
		const sessionB = session("sess-bbbbbbbbbbbbbbbbB", "Beta");
		const toA: BrokerToClient[] = [];
		const toB: BrokerToClient[] = [];
		const sendA = (msg: BrokerToClient) => {
			toA.push(msg);
		};
		const sendB = (msg: BrokerToClient) => {
			toB.push(msg);
		};

		await server.handleClientLine(
			JSON.stringify({ v: 1, id: "1", type: "register", session: sessionA }),
			sendA,
		);
		await server.handleClientLine(
			JSON.stringify({ v: 1, id: "2", type: "register", session: sessionB }),
			sendB,
		);
		expect(toA.at(-1)).toMatchObject({ type: "ok", id: "1" });
		expect(toB.at(-1)).toMatchObject({ type: "ok", id: "2" });

		const pngPath = join(dataDir, "turn.png");
		writeFileSync(pngPath, pngWithSize(8, 8));
		await server.handleClientLine(
			JSON.stringify({
				v: 1,
				id: "3",
				type: "completion",
				sessionId: sessionA.sessionId,
				payload: {
					title: "done",
					why: "stop",
					preview: "hello",
					pngPath,
					status: "completed",
					origin: "tui",
					fingerprint: "fp",
				},
			}),
			sendA,
		);
		expect(api.photos).toBe(1);
		expect(toA.at(-1)).toMatchObject({ type: "ok", id: "3", data: { messageId: 10 } });

		const beforeA = toA.length;
		const beforeB = toB.length;
		await server.handleUpdate({ updateId: 1, message: comment() });
		const promptsA = toA.slice(beforeA).filter((m) => m.type === "prompt");
		const promptsB = toB.slice(beforeB).filter((m) => m.type === "prompt");
		expect(promptsA).toHaveLength(1);
		expect(promptsA[0]).toMatchObject({
			type: "prompt",
			sessionId: sessionA.sessionId,
			text: "continue please",
		});
		expect(promptsB).toHaveLength(0);

		const afterPromptA = toA.length;
		await server.handleUpdate({
			updateId: 2,
			message: comment({ isBot: true, from: { id: 1, isBot: true }, text: "bot noise", messageId: 51 }),
		});
		expect(toA.slice(afterPromptA).some((m) => m.type === "prompt" || m.type === "abort")).toBe(false);
		expect(toB.slice(beforeB).some((m) => m.type === "prompt" || m.type === "abort")).toBe(false);

		await server.handleUpdate({
			updateId: 3,
			message: comment({ text: "/stop", messageId: 52 }),
		});
		const abortsA = toA.filter((m) => m.type === "abort");
		const abortsB = toB.filter((m) => m.type === "abort");
		expect(abortsA).toHaveLength(1);
		expect(abortsA[0]).toMatchObject({ type: "abort", sessionId: sessionA.sessionId });
		expect(abortsB).toHaveLength(0);

		await server.handleClientLine(
			JSON.stringify({ v: 1, id: "4", type: "unregister", sessionId: sessionA.sessionId }),
			sendA,
		);
		const msgCount = api.messages.length;
		await server.handleUpdate({
			updateId: 4,
			message: comment({ text: "are you there", messageId: 53 }),
		});
		expect(api.messages.length).toBe(msgCount + 1);
		expect(api.messages.at(-1)?.text).toContain("offline");
	});
});
