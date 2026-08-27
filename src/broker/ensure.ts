import { closeSync, existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureDataDir } from "../config.ts";
import { logPath, socketPath } from "../paths.ts";

async function sockUp(dataDir: string): Promise<boolean> {
	const sock = socketPath(dataDir);
	if (!existsSync(sock)) return false;
	try {
		const socket = await Bun.connect({
			unix: sock,
			socket: {
				data() {},
				error() {},
			},
		});
		try {
			socket.end();
		} catch {
			// ignore
		}
		return true;
	} catch {
		return false;
	}
}

export async function ensureBroker(opts: { dataDir: string; pluginRoot: string }): Promise<void> {
	ensureDataDir(opts.dataDir);
	if (await sockUp(opts.dataDir)) return;

	const log = logPath(opts.dataDir);
	const fd = openSync(log, "a", 0o600);
	try {
		const child = spawn(process.execPath, [join(opts.pluginRoot, "src/broker/daemon.ts")], {
			detached: true,
			stdio: ["ignore", fd, fd],
			env: process.env,
		});
		child.unref();
	} finally {
		try {
			closeSync(fd);
		} catch {
			// child holds the log fd
		}
	}

	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await sockUp(opts.dataDir)) return;
		await Bun.sleep(50);
	}
	throw new Error("telegram broker did not start");
}
