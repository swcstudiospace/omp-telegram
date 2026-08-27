import { describe, expect, test } from "bun:test";
import { formatRoster, formatStatus, parseTelegramArgs } from "./commands.ts";
import { defaultConfig } from "./config.ts";
import type { RosterEntry } from "./types.ts";

function entry(init?: Partial<RosterEntry>): RosterEntry {
	return {
		sessionId: "abcdef0123456789",
		pid: 42,
		cwd: "/tmp/demo-project",
		title: "Ship telegram bridge",
		idle: true,
		lastSeenAt: 0,
		connected: true,
		...init,
	};
}

describe("parseTelegramArgs", () => {
	test("empty is status", () => {
		expect(parseTelegramArgs("")).toEqual({ cmd: "status", rest: "" });
		expect(parseTelegramArgs("   ")).toEqual({ cmd: "status", rest: "" });
	});

	test("known commands", () => {
		expect(parseTelegramArgs("on")).toEqual({ cmd: "on", rest: "" });
		expect(parseTelegramArgs("off extra")).toEqual({ cmd: "off", rest: "extra" });
		expect(parseTelegramArgs("POST now")).toEqual({ cmd: "post", rest: "now" });
		expect(parseTelegramArgs("help")).toEqual({ cmd: "help", rest: "" });
	});

	test("strips leading telegram/tg token", () => {
		expect(parseTelegramArgs("telegram off")).toEqual({ cmd: "off", rest: "" });
		expect(parseTelegramArgs("tg status")).toEqual({ cmd: "status", rest: "" });
	});

	test("unknown is help", () => {
		expect(parseTelegramArgs("wat")).toEqual({ cmd: "help", rest: "wat" });
	});
});

describe("formatRoster", () => {
	test("contains session tails, cwd basename, idle/busy, title", () => {
		const text = formatRoster([
			entry(),
			entry({
				sessionId: "zzzzzzzzdeadbeef",
				cwd: "/home/me/other",
				idle: false,
				title: "Busy turn",
			}),
		]);
		expect(text).toContain("23456789");
		expect(text).toContain("demo-project");
		expect(text).toContain("idle");
		expect(text).toContain("Ship telegram bridge");
		expect(text).toContain("deadbeef");
		expect(text).toContain("other");
		expect(text).toContain("busy");
		expect(text).toContain("Busy turn");
	});

	test("empty roster", () => {
		expect(formatRoster([])).toBe("(no sessions)");
	});
});

describe("formatStatus", () => {
	test("lists missing token", () => {
		const cfg = defaultConfig();
		const text = formatStatus({
			cfg,
			connected: false,
			roster: [],
			problems: ["missing TELEGRAM_BOT_TOKEN"],
		});
		expect(text).toContain("missing TELEGRAM_BOT_TOKEN");
		expect(text).toContain("disconnected");
		expect(text).toContain("Telegram on");
	});
});
