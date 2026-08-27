#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { ensureBroker } from "./broker/ensure.ts";
import { configProblems, ensureDataDir, loadConfig } from "./config.ts";
import { pidPath, socketPath } from "./paths.ts";

function probeSocket(path: string): Promise<boolean> {
	if (!existsSync(path)) return Promise.resolve(false);
	return new Promise((resolve) => {
		const sock = connect({ path });
		const finish = (ok: boolean) => {
			sock.removeAllListeners();
			sock.destroy();
			resolve(ok);
		};
		sock.once("connect", () => finish(true));
		sock.once("error", () => finish(false));
		sock.setTimeout(500, () => finish(false));
	});
}

async function printStatus(opts: { doctor: boolean }): Promise<void> {
	const cfg = loadConfig();
	const problems = configProblems(cfg);
	const connected = await probeSocket(socketPath(cfg.dataDir));
	console.log(`Telegram ${cfg.enabled ? "on" : "off"} · broker ${connected ? "connected" : "not running"}`);
	console.log(`Channel: ${cfg.channelId || "(unset)"}`);
	if (opts.doctor) {
		console.log(
			cfg.discussionGroupId
				? `Discussion group: ${cfg.discussionGroupId}`
				: "Discussion group: (unset; broker uses getChat.linkedChatId)",
		);
	} else if (cfg.discussionGroupId) {
		console.log(`Discussion: ${cfg.discussionGroupId}`);
	}
	console.log(`Token: ${cfg.botToken ? "set" : "missing"}`);
	console.log(`Data dir: ${cfg.dataDir}`);
	if (problems.length > 0) {
		console.log("Problems:");
		for (const problem of problems) console.log(`  ${problem}`);
	}
}

function stopBroker(): void {
	const cfg = loadConfig();
	const file = pidPath(cfg.dataDir);
	if (!existsSync(file)) {
		console.log("broker not running");
		return;
	}
	const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) {
		console.log("broker not running");
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
		console.log(`broker stop signal sent (${pid})`);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
			console.log("broker not running");
			return;
		}
		throw error;
	}
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";

if (cmd === "status") {
	await printStatus({ doctor: false });
} else if (cmd === "doctor") {
	await printStatus({ doctor: true });
} else if (cmd === "broker" && argv[1] === "start") {
	const cfg = loadConfig();
	ensureDataDir(cfg.dataDir);
	await ensureBroker({ dataDir: cfg.dataDir, pluginRoot: join(import.meta.dir, "..") });
	console.log("broker started");
} else if (cmd === "broker" && argv[1] === "stop") {
	stopBroker();
} else {
	console.log("Usage: omp-telegram [status|doctor|broker start|broker stop]");
	process.exitCode = 1;
}
