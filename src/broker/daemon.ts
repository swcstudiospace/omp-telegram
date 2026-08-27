import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { configProblems, ensureDataDir, loadConfig } from "../config.ts";
import { logPath, offsetPath, pidPath, socketPath } from "../paths.ts";
import { createTelegramApi } from "../telegram/api.ts";
import { nextOffset } from "../telegram/updates.ts";
import { createBrokerServer } from "./server.ts";
import { releaseBrokerLock, tryAcquireBrokerLock } from "./lock.ts";

function appendLog(dataDir: string, line: string): void {
	try {
		appendFileSync(logPath(dataDir), `${line}\n`);
	} catch {
		// logging must never crash the daemon
	}
}

function readOffset(dataDir: string): number {
	try {
		const parsed: unknown = JSON.parse(readFileSync(offsetPath(dataDir), "utf8"));
		if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
		if (parsed && typeof parsed === "object" && "offset" in parsed) {
			const n = (parsed as { offset: unknown }).offset;
			if (typeof n === "number" && Number.isFinite(n)) return n;
		}
	} catch {
		// missing or corrupt
	}
	return 0;
}

async function main(): Promise<void> {
	const cfg = loadConfig();
	const problems = configProblems(cfg);
	if (!cfg.botToken || !cfg.channelId) {
		ensureDataDir(cfg.dataDir);
		appendLog(cfg.dataDir, `broker exit: ${problems.join("; ") || "missing token/channel"}`);
		process.exit(1);
	}

	ensureDataDir(cfg.dataDir);
	const lock = tryAcquireBrokerLock(cfg.dataDir);
	if (!lock) process.exit(0);

	writeFileSync(pidPath(cfg.dataDir), `${process.pid}\n`, { mode: 0o600 });

	const api = createTelegramApi(cfg.botToken);
	const server = await createBrokerServer({ config: cfg, api, dataDir: cfg.dataDir });

	let offset = readOffset(cfg.dataDir);
	let running = true;
	const ac = new AbortController();

	const shutdown = async (): Promise<void> => {
		if (!running) return;
		running = false;
		ac.abort();
		try {
			await server.close();
		} catch {
			// ignore
		}
		releaseBrokerLock(lock.fd);
		try {
			unlinkSync(socketPath(cfg.dataDir));
		} catch {
			// ignore
		}
		try {
			unlinkSync(pidPath(cfg.dataDir));
		} catch {
			// ignore
		}
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	while (running) {
		try {
			const updates = await api.getUpdates({ offset, timeout: 30, signal: ac.signal });
			if (!running) break;
			for (const update of updates) {
				try {
					await server.handleUpdate(update);
				} catch {
					// keep polling
				}
			}
			const next = nextOffset(updates, offset);
			if (next !== offset) {
				offset = next;
				writeFileSync(offsetPath(cfg.dataDir), `${JSON.stringify({ offset })}\n`);
			}
		} catch {
			if (!running) break;
			await Bun.sleep(1_000);
		}
	}
}

void main().catch(() => {
	process.exit(1);
});
