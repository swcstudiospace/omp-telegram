import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bindingsPath } from "../paths.ts";
import type { BoundPost } from "../types.ts";

function asBinding(value: unknown): BoundPost | undefined {
	if (!value || typeof value !== "object") return undefined;
	const o = value as Record<string, unknown>;
	if (typeof o.sessionId !== "string" || typeof o.channelId !== "string") return undefined;
	if (typeof o.channelMessageId !== "number" || typeof o.postedAt !== "number") return undefined;
	if (typeof o.title !== "string") return undefined;
	const binding: BoundPost = {
		sessionId: o.sessionId,
		channelId: o.channelId,
		channelMessageId: o.channelMessageId,
		postedAt: o.postedAt,
		title: o.title,
	};
	if (typeof o.discussionChatId === "string") binding.discussionChatId = o.discussionChatId;
	if (typeof o.discussionMessageId === "number") binding.discussionMessageId = o.discussionMessageId;
	return binding;
}

export function loadBindings(dataDir: string): BoundPost[] {
	const path = bindingsPath(dataDir);
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return [];
		const out: BoundPost[] = [];
		for (const item of parsed) {
			const binding = asBinding(item);
			if (binding) out.push(binding);
		}
		return out;
	} catch {
		return [];
	}
}

export function saveBindings(dataDir: string, bindings: BoundPost[]): void {
	const path = bindingsPath(dataDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(bindings)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export function upsertBinding(bindings: BoundPost[], binding: BoundPost): BoundPost[] {
	const i = bindings.findIndex((b) => b.channelMessageId === binding.channelMessageId);
	if (i >= 0) bindings[i] = { ...bindings[i], ...binding };
	else bindings.push(binding);
	return bindings;
}

export function findByChannelMessage(
	bindings: BoundPost[],
	channelMessageId: number,
): BoundPost | undefined {
	return bindings.find((b) => b.channelMessageId === channelMessageId);
}

export function rememberDiscussionForward(
	bindings: BoundPost[],
	channelMessageId: number,
	discussionChatId: string,
	discussionMessageId: number,
): BoundPost[] {
	for (const binding of bindings) {
		if (binding.channelMessageId === channelMessageId) {
			binding.discussionChatId = discussionChatId;
			binding.discussionMessageId = discussionMessageId;
		}
	}
	return bindings;
}
