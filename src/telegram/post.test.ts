import { describe, expect, test } from "bun:test";
import type { CompletionPayload, SentMessage, SessionInfo, TelegramTransport } from "../types.ts";
import { buildCaption, postCompletion } from "./post.ts";

const session: SessionInfo = {
	sessionId: "abcdef0123456789",
	pid: 1,
	cwd: "/tmp/<cwd>",
	title: "session title",
};

const payload: CompletionPayload = {
	title: 'Done & "ok"',
	why: "because",
	preview: "if a < b && c > d",
	pngPath: "/tmp/x.png",
	status: "completed",
	origin: "tui",
	fingerprint: "fp",
};

function sent(over: Partial<SentMessage> = {}): SentMessage {
	return { chatId: -100111, messageId: 1, date: 1, ...over };
}

function mockApi(): TelegramTransport & { methods: string[] } {
	const methods: string[] = [];
	const api = {
		methods,
		getMe: async () => ({ id: 1 }),
		getChat: async () => ({ id: -100111, type: "channel" as const }),
		sendPhoto: async () => {
			methods.push("sendPhoto");
			return sent();
		},
		sendDocument: async () => {
			methods.push("sendDocument");
			return sent({ messageId: 2 });
		},
		sendMessage: async () => sent(),
		getFile: async () => ({ filePath: "x", bytes: new Uint8Array() }),
		getUpdates: async () => [],
	};
	return api;
}

describe("buildCaption", () => {
	test("escapes HTML in title cwd and preview", () => {
		const caption = buildCaption({ session, payload, previewLimit: 400 });
		expect(caption).toContain("<b>OMP</b>");
		expect(caption).toContain("<code>23456789</code>");
		expect(caption).toContain("✅");
		expect(caption).toContain("📌 Done &amp; &quot;ok&quot;");
		expect(caption).toContain("<code>/tmp/&lt;cwd&gt;</code>");
		expect(caption).toContain("if a &lt; b &amp;&amp; c &gt; d");
		expect(caption).toContain("↪ Comment on this post to continue this session.");
		expect(caption).not.toContain("<cwd>");
		expect(caption).not.toContain("Done & ");
	});

	test("truncates preview to limit", () => {
		const caption = buildCaption({
			session,
			payload: { ...payload, preview: "abcdefghij" },
			previewLimit: 4,
		});
		expect(caption).toContain("abcd");
		expect(caption).not.toContain("abcde");
	});
});

describe("postCompletion", () => {
	const config = { channelId: "-100111", photoMaxHeight: 8500 };

	test("short photo uses sendPhoto", async () => {
		const api = mockApi();
		await postCompletion({
			api,
			config,
			png: new Uint8Array(16),
			filename: "turn.png",
			caption: "c",
			pngHeight: 1000,
		});
		expect(api.methods).toEqual(["sendPhoto"]);
	});

	test("tall image uses sendDocument", async () => {
		const api = mockApi();
		await postCompletion({
			api,
			config,
			png: new Uint8Array(16),
			filename: "turn.png",
			caption: "c",
			pngHeight: 8500,
		});
		expect(api.methods).toEqual(["sendDocument"]);
	});

	test("oversize bytes uses sendDocument", async () => {
		const api = mockApi();
		await postCompletion({
			api,
			config,
			png: new Uint8Array(9_000_001),
			filename: "turn.png",
			caption: "c",
			pngHeight: 100,
		});
		expect(api.methods).toEqual(["sendDocument"]);
	});

	test("sendPhoto throw falls back to sendDocument", async () => {
		const api = mockApi();
		api.sendPhoto = async () => {
			api.methods.push("sendPhoto");
			throw new Error("PHOTO_INVALID_DIMENSIONS");
		};
		const result = await postCompletion({
			api,
			config,
			png: new Uint8Array(16),
			filename: "turn.png",
			caption: "c",
			pngHeight: 100,
		});
		expect(api.methods).toEqual(["sendPhoto", "sendDocument"]);
		expect(result.messageId).toBe(2);
	});
});
