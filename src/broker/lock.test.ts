import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath } from "../paths.ts";
import { releaseBrokerLock, tryAcquireBrokerLock } from "./lock.ts";

const dirs: string[] = [];

function isolate(): string {
	const dir = join(tmpdir(), `omp-tg-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tryAcquireBrokerLock", () => {
	test("second tryAcquire returns undefined while first held; after release succeeds", () => {
		const dir = isolate();
		const first = tryAcquireBrokerLock(dir);
		expect(first).toBeDefined();
		expect(tryAcquireBrokerLock(dir)).toBeUndefined();
		releaseBrokerLock(first!.fd);
		const second = tryAcquireBrokerLock(dir);
		expect(second).toBeDefined();
		releaseBrokerLock(second!.fd);
	});

	test("stale pid lock is stolen", () => {
		const dir = isolate();
		writeFileSync(lockPath(dir), "2147483647\n");
		const got = tryAcquireBrokerLock(dir);
		expect(got).toBeDefined();
		releaseBrokerLock(got!.fd);
	});
});
