import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SkipReason, TelegramConfig, TurnSnapshot } from "../types.ts";
import { shouldSkipCompletion } from "./skip.ts";
import { fingerprintTurn } from "./turn.ts";

const CHILD_KEYS = ["PI_ULTRATHINK_CHILD", "PI_AIO_CHILD", "PI_CODING_AGENT_CHILD"] as const;

const saved: Partial<Record<(typeof CHILD_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of CHILD_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of CHILD_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function cfg(init?: Partial<TelegramConfig>): TelegramConfig {
	return {
		enabled: true,
		botToken: "tok",
		channelId: "-1001",
		discussionGroupId: "",
		allowedUserIds: [],
		photoWidth: 1080,
		photoMaxHeight: 8500,
		captionPreviewChars: 400,
		dataDir: "/tmp/telegram",
		...init,
	};
}

function snapshot(init?: Partial<TurnSnapshot>): TurnSnapshot {
	return {
		title: "Fix login",
		userText: "Fix login",
		assistantText: "done",
		tools: [],
		status: "completed",
		sessionId: "sess-1",
		cwd: "/tmp",
		origin: "tui",
		...init,
	};
}

function skip(init: Parameters<typeof shouldSkipCompletion>[0]): SkipReason | undefined {
	return shouldSkipCompletion(init);
}

describe("shouldSkipCompletion", () => {
	test("disabled", () => {
		expect(skip({ cfg: cfg({ enabled: false, botToken: "" }), stopHookActive: false, snapshot: snapshot() })).toBe(
			"disabled",
		);
	});

	test("no_token", () => {
		expect(skip({ cfg: cfg({ botToken: "" }), stopHookActive: false, snapshot: snapshot() })).toBe("no_token");
	});

	test("no_channel", () => {
		expect(skip({ cfg: cfg({ channelId: "" }), stopHookActive: false, snapshot: snapshot() })).toBe("no_channel");
	});

	test("child_session", () => {
		process.env.PI_CODING_AGENT_CHILD = "1";
		expect(skip({ cfg: cfg(), stopHookActive: false, snapshot: snapshot() })).toBe("child_session");
	});

	test("stop_hook_active", () => {
		expect(skip({ cfg: cfg(), stopHookActive: true, snapshot: snapshot() })).toBe("stop_hook_active");
	});

	test("empty", () => {
		expect(
			skip({
				cfg: cfg(),
				stopHookActive: false,
				snapshot: snapshot({ assistantText: "  ", tools: [] }),
			}),
		).toBe("empty");
	});

	test("duplicate", () => {
		const snap = snapshot();
		const now = 1_000_000;
		expect(
			skip({
				cfg: cfg(),
				stopHookActive: false,
				snapshot: snap,
				lastFingerprint: fingerprintTurn(snap),
				lastPostedAt: now - 10_000,
				now,
			}),
		).toBe("duplicate");
	});

	test("cooldown", () => {
		const now = 1_000_000;
		expect(
			skip({
				cfg: cfg(),
				stopHookActive: false,
				snapshot: snapshot(),
				lastFingerprint: "other",
				lastPostedAt: now - 1_000,
				now,
			}),
		).toBe("cooldown");
	});

	test("happy path undefined", () => {
		expect(skip({ cfg: cfg(), stopHookActive: false, snapshot: snapshot() })).toBeUndefined();
	});
});
