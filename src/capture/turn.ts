import { createHash } from "node:crypto";
import type { CompletionPayload, CompletionStatus, TurnSnapshot, TurnToolCall } from "../types.ts";

const TITLE_MAX = 80;
const DETAIL_MAX = 120;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

function coerceObj(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return asRecord(value);
}

function partText(part: unknown, types: Set<string>): string {
	if (typeof part === "string") return part;
	const rec = asRecord(part);
	if (!rec) return "";
	if (typeof rec.type === "string" && types.has(rec.type) && typeof rec.text === "string") {
		return rec.text;
	}
	return "";
}

function userTextFrom(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const text = partText(part, new Set(["text", "input_text"]));
		if (text) parts.push(text);
	}
	return parts.join("");
}

function toolName(part: Record<string, unknown>): string {
	if (typeof part.name === "string" && part.name) return part.name;
	const fn = asRecord(part.function);
	if (fn && typeof fn.name === "string" && fn.name) return fn.name;
	return "";
}

function toolDetail(input: unknown): string {
	const obj = coerceObj(input);
	if (obj) {
		if (typeof obj.command === "string" && obj.command) return clip(obj.command, DETAIL_MAX);
		if (typeof obj.path === "string" && obj.path) return clip(obj.path, DETAIL_MAX);
	}
	try {
		return clip(JSON.stringify(input ?? {}), DETAIL_MAX);
	} catch {
		return "";
	}
}

function statusFromStop(reason: unknown): CompletionStatus {
	if (reason === "error") return "failed";
	if (reason === "aborted") return "stopped";
	if (reason === "max_iterations" || reason === "budget") return "budget";
	return "completed";
}

function collectAssistant(
	messages: unknown[],
	start: number,
): { text: string; tools: TurnToolCall[]; status: CompletionStatus } {
	const tools: TurnToolCall[] = [];
	const texts: string[] = [];
	let lastStop: unknown;
	for (let i = start; i < messages.length; i++) {
		const msg = asRecord(messages[i]);
		if (!msg || msg.role !== "assistant") continue;
		lastStop = msg.stopReason ?? msg.stop_reason;
		const content = msg.content;
		if (typeof content === "string") {
			if (content) texts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		const chunk: string[] = [];
		for (const part of content) {
			const rec = asRecord(part);
			if (!rec) {
				if (typeof part === "string" && part) chunk.push(part);
				continue;
			}
			const type = rec.type;
			if (type === "text" || type === "output_text") {
				if (typeof rec.text === "string" && rec.text) chunk.push(rec.text);
			} else if (type === "toolCall" || type === "tool_use" || type === "functionCall") {
				const name = toolName(rec);
				if (name) tools.push({ name, detail: toolDetail(rec.input ?? rec.arguments) });
			}
		}
		if (chunk.length > 0) texts.push(chunk.join(""));
	}
	return { text: texts.join("\n"), tools, status: statusFromStop(lastStop) };
}

export function extractTurn(args: {
	messages: unknown[];
	sessionId: string;
	cwd: string;
	origin: CompletionPayload["origin"];
}): TurnSnapshot {
	const { messages, sessionId, cwd, origin } = args;
	let lastUser = -1;
	for (let i = 0; i < messages.length; i++) {
		const msg = asRecord(messages[i]);
		if (msg?.role === "user") lastUser = i;
	}
	const userText = lastUser === -1 ? "" : userTextFrom(asRecord(messages[lastUser])?.content);
	const following = collectAssistant(messages, lastUser + 1);
	const firstLine = userText.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return {
		title: firstLine ? clip(firstLine, TITLE_MAX) : "OMP session",
		userText,
		assistantText: following.text,
		tools: following.tools,
		status: following.status,
		sessionId,
		cwd,
		origin,
	};
}

export function fingerprintTurn(snapshot: TurnSnapshot): string {
	const tools = snapshot.tools.map((tool) => tool.name).join(",");
	const payload = `${snapshot.title}|${snapshot.userText}|${snapshot.assistantText}|${tools}`;
	return createHash("sha256").update(payload).digest("hex");
}
