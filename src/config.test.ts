import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const dirs: string[] = [];

function isolate(): { agent: string; data: string } {
	const root = join(tmpdir(), `omp-tg-cfg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const agent = join(root, "agent");
	const data = join(root, "telegram");
	mkdirSync(agent, { recursive: true });
	dirs.push(root);
	return { agent, data };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("env overrides telegram.json", () => {
		const { agent, data } = isolate();
		writeFileSync(
			join(agent, "telegram.json"),
			JSON.stringify({
				channelId: "-100111",
				discussionGroupId: "-100222",
				allowedUserIds: [1],
				botToken: "from-file",
			}),
		);
		const cfg = loadConfig({
			PI_CODING_AGENT_DIR: agent,
			OMP_TELEGRAM_DIR: data,
			TELEGRAM_BOT_TOKEN: "from-env",
			TELEGRAM_CHANNEL_ID: "-100333",
			TELEGRAM_DISCUSSION_GROUP_ID: "-100444",
			TELEGRAM_ALLOWED_USERS: "9,10",
		});
		expect(cfg.botToken).toBe("from-env");
		expect(cfg.channelId).toBe("-100333");
		expect(cfg.discussionGroupId).toBe("-100444");
		expect(cfg.allowedUserIds).toEqual([9, 10]);
		expect(cfg.dataDir).toBe(data);
		expect(cfg.enabled).toBe(true);
	});

	test("TELEGRAM_CHAT_ID fills channel when CHANNEL_ID unset", () => {
		const { agent, data } = isolate();
		const cfg = loadConfig({
			PI_CODING_AGENT_DIR: agent,
			OMP_TELEGRAM_DIR: data,
			TELEGRAM_CHAT_ID: "-100555",
		});
		expect(cfg.channelId).toBe("-100555");
		expect(cfg.botToken).toBe("");
	});
});
