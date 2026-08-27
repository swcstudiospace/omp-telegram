import { describe, expect, test } from "bun:test";
import type { TurnSnapshot } from "../types.ts";
import { extractTurn, fingerprintTurn } from "./turn.ts";

const args = {
	sessionId: "sess-abcdefgh",
	cwd: "/tmp/proj",
	origin: "tui" as const,
};

describe("extractTurn", () => {
	test("user+assistant+tool_use extracts title/tools/text", () => {
		const snapshot = extractTurn({
			...args,
			messages: [
				{ role: "user", content: "ignore earlier" },
				{ role: "assistant", content: [{ type: "text", text: "old reply" }] },
				{
					role: "user",
					content: [
						{ type: "text", text: "Fix the " },
						{ type: "input_text", text: "login bug" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "tool_use", name: "bash", input: { command: "ls -la" } },
						{ type: "toolCall", name: "read", input: { path: "/tmp/a.ts" } },
						{ type: "functionCall", name: "search", arguments: { query: "auth" } },
						{ type: "text", text: "" },
						{ type: "text", text: "Patched login." },
					],
					stopReason: "stop",
				},
			],
		});
		expect(snapshot.title).toBe("Fix the login bug");
		expect(snapshot.userText).toBe("Fix the login bug");
		expect(snapshot.assistantText).toBe("Patched login.");
		expect(snapshot.tools).toEqual([
			{ name: "bash", detail: "ls -la" },
			{ name: "read", detail: "/tmp/a.ts" },
			{ name: "search", detail: '{"query":"auth"}' },
		]);
		expect(snapshot.status).toBe("completed");
		expect(snapshot.sessionId).toBe(args.sessionId);
		expect(snapshot.cwd).toBe(args.cwd);
		expect(snapshot.origin).toBe("tui");
	});

	test("empty messages", () => {
		const snapshot = extractTurn({ ...args, messages: [] });
		expect(snapshot).toEqual({
			title: "OMP session",
			userText: "",
			assistantText: "",
			tools: [],
			status: "completed",
			sessionId: args.sessionId,
			cwd: args.cwd,
			origin: "tui",
		});
	});

	test("stopReason maps error aborted budget", () => {
		const failed = extractTurn({
			...args,
			messages: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: [{ type: "text", text: "no" }], stopReason: "error" },
			],
		});
		expect(failed.status).toBe("failed");
		const stopped = extractTurn({
			...args,
			messages: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: "halt", stopReason: "aborted" },
			],
		});
		expect(stopped.status).toBe("stopped");
		const budget = extractTurn({
			...args,
			messages: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: "limit", stopReason: "max_iterations" },
			],
		});
		expect(budget.status).toBe("budget");
	});
});

describe("fingerprintTurn", () => {
	test("fingerprint stable", () => {
		const snapshot: TurnSnapshot = {
			title: "Fix the login bug",
			userText: "Fix the login bug",
			assistantText: "Patched login.",
			tools: [
				{ name: "bash", detail: "ls -la" },
				{ name: "read", detail: "/tmp/a.ts" },
			],
			status: "completed",
			sessionId: "sess-1",
			cwd: "/tmp/proj",
			origin: "tui",
		};
		const a = fingerprintTurn(snapshot);
		const b = fingerprintTurn({ ...snapshot, sessionId: "other", cwd: "/elsewhere", status: "failed" });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprintTurn({ ...snapshot, title: "changed" })).not.toBe(a);
	});
});
