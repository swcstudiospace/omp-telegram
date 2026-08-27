import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { lockPath } from "../paths.ts";

const held = new Map<number, string>();

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLockPid(path: string): number | undefined {
	try {
		const n = Number(readFileSync(path, "utf8").trim());
		if (Number.isInteger(n) && n > 0) return n;
	} catch {
		// unreadable or empty
	}
	return undefined;
}

function acquireExclusive(path: string): { fd: number } | undefined {
	try {
		const fd = openSync(path, "wx", 0o600);
		writeSync(fd, `${process.pid}\n`);
		held.set(fd, path);
		return { fd };
	} catch {
		return undefined;
	}
}

export function tryAcquireBrokerLock(dataDir: string): { fd: number } | undefined {
	const path = lockPath(dataDir);
	const first = acquireExclusive(path);
	if (first) return first;
	const pid = readLockPid(path);
	if (pid !== undefined && pidAlive(pid)) return undefined;
	try {
		unlinkSync(path);
	} catch {
		return undefined;
	}
	return acquireExclusive(path);
}

export function releaseBrokerLock(fd: number): void {
	const path = held.get(fd);
	held.delete(fd);
	try {
		closeSync(fd);
	} catch {
		// already closed
	}
	if (!path) return;
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}
