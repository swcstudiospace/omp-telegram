import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundPost } from "../types.ts";
import {
	findByChannelMessage,
	loadBindings,
	rememberDiscussionForward,
	saveBindings,
	upsertBinding,
} from "./bindings.ts";

const dirs: string[] = [];

function isolate(): string {
	const dir = join(tmpdir(), `omp-tg-bind-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sample(over: Partial<BoundPost> = {}): BoundPost {
	return {
		sessionId: "sess-a",
		channelId: "-100111",
		channelMessageId: 42,
		postedAt: 1_700_000_000_000,
		title: "turn",
		...over,
	};
}

describe("bindings", () => {
	test("save/load roundtrip", () => {
		const dir = isolate();
		expect(loadBindings(dir)).toEqual([]);
		const bindings = [sample(), sample({ sessionId: "sess-b", channelMessageId: 43, title: "b" })];
		saveBindings(dir, bindings);
		expect(loadBindings(dir)).toEqual(bindings);
	});

	test("rememberDiscussionForward fills discussionMessageId on matching channelMessageId", () => {
		const bindings = [sample(), sample({ sessionId: "sess-b", channelMessageId: 99, title: "other" })];
		rememberDiscussionForward(bindings, 42, "-100222", 7);
		expect(findByChannelMessage(bindings, 42)?.discussionChatId).toBe("-100222");
		expect(findByChannelMessage(bindings, 42)?.discussionMessageId).toBe(7);
		expect(findByChannelMessage(bindings, 99)?.discussionMessageId).toBeUndefined();
	});

	test("upsertBinding inserts then updates by channelMessageId", () => {
		const bindings: BoundPost[] = [];
		upsertBinding(bindings, sample());
		upsertBinding(bindings, sample({ title: "updated", postedAt: 2 }));
		expect(bindings).toHaveLength(1);
		expect(bindings[0]?.title).toBe("updated");
		expect(bindings[0]?.postedAt).toBe(2);
	});
});
