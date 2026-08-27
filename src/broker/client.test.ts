import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo, TelegramConfig, TelegramTransport } from "../types.ts";
import { BrokerClient } from "./client.ts";
import { createBrokerServer } from "./server.ts";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const clients: BrokerClient[] = [];

function isolate(): string {
	const dir = join(tmpdir(), `omp-tg-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
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

function mockApi(): TelegramTransport {
	return {
		getMe: async () => ({ id: 1, username: "bot" }),
		getChat: async () => ({ id: -100111, type: "channel", linkedChatId: -100222 }),
		sendPhoto: async (args) => ({ chatId: Number(args.chatId), messageId: 10, date: 1 }),
		sendDocument: async (args) => ({ chatId: Number(args.chatId), messageId: 11, date: 1 }),
		sendMessage: async (args) => ({ chatId: Number(args.chatId), messageId: 99, date: 1 }),
		getFile: async (fileId) => ({ filePath: "a.jpg", bytes: new Uint8Array([1]) }),
		getUpdates: async () => [],
	};
}

describe("BrokerClient", () => {
	test("register then completion roundtrip ok", async () => {
		const dataDir = isolate();
		const server = await createBrokerServer({ config: cfg(dataDir), api: mockApi(), dataDir });
		servers.push(server);

		const session: SessionInfo = {
			sessionId: "sess-ccccccccccccccccC",
			pid: 3,
			cwd: "/tmp/c",
			title: "Client",
		};
		const client = await BrokerClient.connect({ dataDir, session });
		clients.push(client);
		await client.register();

		const pngPath = join(dataDir, "turn.png");
		writeFileSync(pngPath, pngWithSize(8, 8));
		const result = await client.completion({
			title: "done",
			why: "stop",
			preview: "hello",
			pngPath,
			status: "completed",
			origin: "tui",
			fingerprint: "fp",
		});
		expect(result).toMatchObject({ messageId: 10, chatId: -100111 });
	});
});
