import { describe, expect, test } from "bun:test";
import { collectMessages, originFromMode, planCompletion, sessionInfoFromCtx } from "./session.ts";
import type { TelegramConfig } from "./types.ts";

function cfg(init?: Partial<TelegramConfig>): TelegramConfig {
	return {
		enabled: true,
		botToken: "token",
		channelId: "-1001",
		discussionGroupId: "",
		allowedUserIds: [],
		photoWidth: 1080,
		photoMaxHeight: 8500,
		captionPreviewChars: 400,
		dataDir: "/tmp/omp-telegram-test",
		...init,
	};
}

const happyMessages = [
	{ role: "user", content: [{ type: "text", text: "ship it" }] },
	{ role: "assistant", content: [{ type: "text", text: "done" }] },
];

describe("sessionInfoFromCtx", () => {
	test("uses getSessionId when present", () => {
		const info = sessionInfoFromCtx({
			cwd: "/tmp/demo-project",
			mode: "tui",
			sessionName: "Demo",
			sessionManager: {
				getSessionId: () => "sess-abc",
				getSessionFile: () => "/tmp/sess.jsonl",
			},
		});
		expect(info.sessionId).toBe("sess-abc");
		expect(info.pid).toBe(process.pid);
		expect(info.cwd).toBe("/tmp/demo-project");
		expect(info.title).toBe("Demo");
		expect(info.sessionFile).toBe("/tmp/sess.jsonl");
		expect(info.mode).toBe("tui");
	});

	test("falls back to pid- when getSessionId missing", () => {
		const info = sessionInfoFromCtx({
			cwd: "/tmp/x",
			sessionManager: {},
		});
		expect(info.sessionId).toBe(`pid-${process.pid}`);
	});
});

describe("collectMessages", () => {
	test("prefers event messages when nonempty", () => {
		const event = [{ role: "user", content: "hi" }];
		const got = collectMessages(
			{
				sessionManager: {
					getBranch: () => [{ type: "message", message: { role: "assistant", content: "nope" } }],
				},
			},
			event,
		);
		expect(got).toBe(event);
	});

	test("maps getBranch message entries when events empty", () => {
		const user = { role: "user", content: "hi" };
		const assistant = { role: "assistant", content: "yo" };
		const got = collectMessages(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", message: user },
						{ type: "message", message: assistant },
					],
				},
			},
			[],
		);
		expect(got).toEqual([user, assistant]);
	});
});

describe("originFromMode", () => {
	test("maps tui/rpc/print", () => {
		expect(originFromMode("tui")).toBe("tui");
		expect(originFromMode("rpc")).toBe("rpc");
		expect(originFromMode("print")).toBe("print");
		expect(originFromMode("json")).toBe("unknown");
		expect(originFromMode(undefined)).toBe("unknown");
	});
});

describe("planCompletion", () => {
	test("skips stop_hook", () => {
		const planned = planCompletion({
			cfg: cfg(),
			stopHookActive: true,
			messages: happyMessages,
			sessionId: "s1",
			cwd: "/tmp/x",
			origin: "tui",
		});
		expect(planned).toEqual({ skip: "stop_hook_active" });
	});

	test("skips empty", () => {
		const planned = planCompletion({
			cfg: cfg(),
			stopHookActive: false,
			messages: [],
			sessionId: "s1",
			cwd: "/tmp/x",
			origin: "tui",
		});
		expect(planned).toEqual({ skip: "empty" });
	});

	test("posts happy path", () => {
		const planned = planCompletion({
			cfg: cfg(),
			stopHookActive: false,
			messages: happyMessages,
			sessionId: "s1",
			cwd: "/tmp/x",
			origin: "tui",
		});
		expect("post" in planned).toBe(true);
		if ("post" in planned) {
			expect(planned.post.sessionId).toBe("s1");
			expect(planned.post.cwd).toBe("/tmp/x");
			expect(planned.post.origin).toBe("tui");
			expect(planned.post.userText.length + planned.post.assistantText.length).toBeGreaterThan(0);
		}
	});
});
