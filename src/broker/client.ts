import { socketPath } from "../paths.ts";
import type {
	BrokerToClient,
	ClientToBroker,
	CompletionPayload,
	SessionInfo,
} from "../types.ts";

type PromptHandler = (msg: Extract<BrokerToClient, { type: "prompt" }>) => void;
type AbortHandler = (msg: Extract<BrokerToClient, { type: "abort" }>) => void;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
};

type SocketHandle = {
	write(data: string | Uint8Array): number;
	end(data?: string | Uint8Array): void;
};

const BACKOFF_MIN = 100;
const BACKOFF_MAX = 5_000;

export class BrokerClient {
	#dataDir: string;
	#session: SessionInfo;
	#socket?: SocketHandle;
	#n = 0;
	#pending = new Map<string, Pending>();
	#buf = "";
	#prompt?: PromptHandler;
	#abort?: AbortHandler;
	#closed = false;
	#registered = false;
	#backoff = BACKOFF_MIN;
	#reconnectTimer?: Timer;
	#connecting?: Promise<void>;

	private constructor(dataDir: string, session: SessionInfo) {
		this.#dataDir = dataDir;
		this.#session = session;
	}

	static async connect(opts: { dataDir: string; session: SessionInfo }): Promise<BrokerClient> {
		const client = new BrokerClient(opts.dataDir, opts.session);
		await client.#connect();
		return client;
	}

	onPrompt(handler: PromptHandler): void {
		this.#prompt = handler;
	}

	onAbort(handler: AbortHandler): void {
		this.#abort = handler;
	}

	async register(): Promise<void> {
		await this.#rpc((id) => ({
			v: 1,
			id,
			type: "register",
			session: this.#session,
		}));
		this.#registered = true;
	}

	async heartbeat(idle: boolean, title?: string): Promise<void> {
		await this.#rpc((id) => ({
			v: 1,
			id,
			type: "heartbeat",
			sessionId: this.#session.sessionId,
			idle,
			...(title !== undefined ? { title } : {}),
		}));
	}

	async completion(payload: CompletionPayload): Promise<unknown> {
		return this.#rpc((id) => ({
			v: 1,
			id,
			type: "completion",
			sessionId: this.#session.sessionId,
			payload,
		}));
	}

	async unregister(): Promise<void> {
		this.#registered = false;
		await this.#rpc((id) => ({
			v: 1,
			id,
			type: "unregister",
			sessionId: this.#session.sessionId,
		}));
	}

	async status(): Promise<unknown> {
		return this.#rpc((id) => ({ v: 1, id, type: "status" }));
	}

	close(): void {
		this.#closed = true;
		this.#registered = false;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		this.#failPending(new Error("closed"));
		const socket = this.#socket;
		this.#socket = undefined;
		try {
			socket?.end();
		} catch {
			// ignore
		}
	}

	#nextId(): string {
		this.#n += 1;
		return String(this.#n);
	}

	async #connect(): Promise<void> {
		if (this.#closed) throw new Error("closed");
		if (this.#socket) return;
		if (this.#connecting) return this.#connecting;
		this.#connecting = this.#connectOnce().finally(() => {
			this.#connecting = undefined;
		});
		return this.#connecting;
	}

	async #connectOnce(): Promise<void> {
		const socket = await Bun.connect({
			unix: socketPath(this.#dataDir),
			socket: {
				data: (_socket, data) => {
					this.#onData(data);
				},
				close: () => {
					this.#onDead();
				},
				error: () => {
					this.#onDead();
				},
			},
		});
		this.#socket = socket;
		this.#backoff = BACKOFF_MIN;
		if (this.#registered && !this.#closed) {
			try {
				await this.#rpc((id) => ({
					v: 1,
					id,
					type: "register",
					session: this.#session,
				}));
			} catch {
				// next rpc/heartbeat will retry
			}
		}
	}

	#onDead(): void {
		if (!this.#socket && this.#pending.size === 0) {
			if (!this.#closed) this.#scheduleReconnect();
			return;
		}
		this.#socket = undefined;
		this.#failPending(new Error("disconnected"));
		if (!this.#closed) this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#reconnectTimer || this.#connecting) return;
		const delay = this.#backoff;
		this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#connect().catch(() => this.#scheduleReconnect());
		}, delay);
	}

	#failPending(err: Error): void {
		for (const pending of this.#pending.values()) pending.reject(err);
		this.#pending.clear();
	}

	#onData(data: string | ArrayBuffer | Uint8Array): void {
		const chunk = typeof data === "string" ? data : new TextDecoder().decode(data);
		this.#buf += chunk;
		for (;;) {
			const nl = this.#buf.indexOf("\n");
			if (nl < 0) break;
			const line = this.#buf.slice(0, nl).trim();
			this.#buf = this.#buf.slice(nl + 1);
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			this.#dispatch(parsed);
		}
	}

	#dispatch(parsed: unknown): void {
		if (!parsed || typeof parsed !== "object") return;
		const msg = parsed as BrokerToClient;
		if (msg.type === "prompt") {
			if (msg.sessionId === this.#session.sessionId) this.#prompt?.(msg);
			return;
		}
		if (msg.type === "abort") {
			if (msg.sessionId === this.#session.sessionId) this.#abort?.(msg);
			return;
		}
		if (msg.type === "ok" || msg.type === "error") {
			const pending = this.#pending.get(msg.id);
			if (!pending) return;
			this.#pending.delete(msg.id);
			if (msg.type === "ok") pending.resolve(msg.data);
			else pending.reject(new Error(msg.error));
		}
	}

	async #rpc(build: (id: string) => ClientToBroker): Promise<unknown> {
		if (this.#closed) throw new Error("closed");
		if (!this.#socket) await this.#connect();
		const socket = this.#socket;
		if (!socket) throw new Error("disconnected");
		const id = this.#nextId();
		const msg = build(id);
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		try {
			socket.write(`${JSON.stringify(msg)}\n`);
		} catch (err) {
			this.#pending.delete(id);
			this.#onDead();
			reject(err instanceof Error ? err : new Error("write failed"));
		}
		return promise;
	}
}
