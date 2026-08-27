import { homedir } from "node:os";
import { join } from "node:path";

export function ompRoot(): string {
	const fromEnv = process.env.PI_CONFIG_DIR?.trim() || process.env.OMP_CONFIG_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".omp");
}

export function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(ompRoot(), "agent");
}

export function defaultDataDir(): string {
	const fromEnv = process.env.OMP_TELEGRAM_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(ompRoot(), "telegram");
}

export function configPath(): string {
	return join(agentDir(), "telegram.json");
}

export function socketPath(dataDir: string): string {
	return join(dataDir, "broker.sock");
}

export function lockPath(dataDir: string): string {
	return join(dataDir, "broker.lock");
}

export function pidPath(dataDir: string): string {
	return join(dataDir, "broker.pid");
}

export function offsetPath(dataDir: string): string {
	return join(dataDir, "offset.json");
}

export function bindingsPath(dataDir: string): string {
	return join(dataDir, "bindings.json");
}

export function capturesDir(dataDir: string): string {
	return join(dataDir, "captures");
}

export function logPath(dataDir: string): string {
	return join(dataDir, "broker.log");
}
