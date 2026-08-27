import { join } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BrokerClient, ensureBroker } from "./broker/client.ts";
import { renderLongPhoto } from "./capture/long-photo.ts";
import { formatStatus, parseTelegramArgs } from "./commands.ts";
import { configProblems, loadConfig } from "./config.ts";
import { collectMessages, fingerprintTurn, originFromMode, planCompletion, sessionInfoFromCtx } from "./session.ts";
import type { CommentImage, CompletionPayload, RosterEntry, SessionInfo, TelegramConfig } from "./types.ts";

const TELEGRAM_COMPLETIONS = [
	{ value: "status", label: "status — channel, sessions, problems" },
	{ value: "on", label: "on — connect this session" },
	{ value: "off", label: "off — disconnect this session" },
	{ value: "post", label: "post — force a completion photo" },
];

export function commentToUserContent(
	text: string,
	images: CommentImage[] = [],
): string | (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [];
	if (text) blocks.push({ type: "text", text });
	for (const image of images) {
		if (!image.bytes || image.bytes.byteLength === 0) continue;
		blocks.push({
			type: "image",
			data: Buffer.from(image.bytes).toString("base64"),
			mimeType: image.mimeType || "image/jpeg",
		});
	}
	if (blocks.length === 0) return text;
	if (blocks.length === 1 && blocks[0]?.type === "text") return text;
	return blocks;
}

function filterCompletions(prefix: string): { value: string; label: string }[] | null {
	const needle = prefix.trim().toLowerCase();
	const filtered = TELEGRAM_COMPLETIONS.filter((item) => item.value.startsWith(needle));
	return filtered.length > 0 ? filtered : null;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function tokenChannelProblems(cfg: TelegramConfig): string[] {
	return configProblems({ ...cfg, enabled: true }).filter((problem) => problem !== "disabled");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRosterEntry(value: unknown): value is RosterEntry {
	if (!value || typeof value !== "object") return false;
	if (!("sessionId" in value) || !("cwd" in value) || !("title" in value)) return false;
	if (!("pid" in value) || !("idle" in value) || !("lastSeenAt" in value) || !("connected" in value)) return false;
	return (
		typeof value.sessionId === "string" &&
		typeof value.cwd === "string" &&
		typeof value.title === "string" &&
		typeof value.pid === "number" &&
		typeof value.idle === "boolean" &&
		typeof value.lastSeenAt === "number" &&
		typeof value.connected === "boolean"
	);
}

async function rosterOf(client: BrokerClient | undefined): Promise<RosterEntry[]> {
	if (!client) return [];
	try {
		const data: unknown = await client.status();
		if (!data || typeof data !== "object" || !("roster" in data) || !Array.isArray(data.roster)) return [];
		return data.roster.filter(isRosterEntry);
	} catch {
		return [];
	}
}

export default function telegram(pi: ExtensionAPI): void {
	pi.setLabel("Telegram");
	const pluginRoot = join(import.meta.dir, "..");
	let cfg = loadConfig();
	let client: BrokerClient | undefined;
	let lastFingerprint: string | undefined;
	let lastPostedAt: number | undefined;
	let enabledOverride: boolean | undefined;
	let abort = (): void => {};
	let liveCtx: ExtensionContext | undefined;
	let session: SessionInfo | undefined;

	function enabled(): boolean {
		return enabledOverride ?? cfg.enabled;
	}

	function effectiveCfg(): TelegramConfig {
		return { ...cfg, enabled: enabled() };
	}

	async function disconnect(): Promise<void> {
		const current = client;
		client = undefined;
		if (!current) return;
		try {
			await current.unregister();
		} catch (error) {
			pi.logger.warn(`telegram unregister failed: ${errorMessage(error)}`);
		}
		try {
			await current.close();
		} catch (error) {
			pi.logger.warn(`telegram close failed: ${errorMessage(error)}`);
		}
	}

	function bindClient(next: BrokerClient, ctx: ExtensionContext): void {
		next.onPrompt((prompt) => {
			try {
				const current = liveCtx ?? ctx;
				const content = commentToUserContent(prompt.text, prompt.images ?? []);
				if (current.isIdle()) pi.sendUserMessage(content);
				else pi.sendUserMessage(content, { deliverAs: "followUp" });
			} catch (error) {
				pi.logger.warn(`telegram prompt failed: ${errorMessage(error)}`);
			}
		});
		next.onAbort(() => {
			try {
				abort();
			} catch (error) {
				pi.logger.warn(`telegram abort failed: ${errorMessage(error)}`);
			}
		});
	}

	async function connectBroker(ctx: ExtensionContext): Promise<boolean> {
		cfg = loadConfig();
		if (!enabled()) return false;
		if (tokenChannelProblems(cfg).length > 0) return false;
		session = sessionInfoFromCtx(ctx);
		try {
			await ensureBroker({ dataDir: cfg.dataDir, pluginRoot });
			const next = await BrokerClient.connect({ dataDir: cfg.dataDir, session });
			await next.register();
			bindClient(next, ctx);
			client = next;
			if (ctx.hasUI) ctx.ui.notify("Telegram connected", "info");
			return true;
		} catch (error) {
			pi.logger.warn(`telegram connect failed: ${errorMessage(error)}`);
			notify(ctx, `Telegram connect failed: ${errorMessage(error)}`, "warning");
			return false;
		}
	}

	async function postTurn(
		ctx: ExtensionContext,
		eventMessages: unknown[],
		stopHookActive: boolean,
		force: boolean,
	): Promise<boolean> {
		if (!client) return false;
		const info = session ?? sessionInfoFromCtx(ctx);
		const planned = planCompletion({
			cfg: effectiveCfg(),
			stopHookActive,
			messages: collectMessages(ctx, eventMessages),
			sessionId: info.sessionId,
			cwd: ctx.cwd,
			origin: originFromMode(ctx.mode),
			lastFingerprint,
			lastPostedAt,
			force,
		});
		if ("skip" in planned) return false;
		try {
			const photo = await renderLongPhoto(planned.post, {
				dataDir: cfg.dataDir,
				width: cfg.photoWidth,
				maxHeight: cfg.photoMaxHeight,
			});
			const payload: CompletionPayload = {
				title: planned.post.title,
				why: planned.post.status,
				preview: planned.post.assistantText.slice(0, cfg.captionPreviewChars),
				pngPath: photo.path,
				status: planned.post.status,
				origin: planned.post.origin,
				fingerprint: fingerprintTurn(planned.post),
			};
			await client.completion(payload);
			lastFingerprint = payload.fingerprint;
			lastPostedAt = Date.now();
			return true;
		} catch (error) {
			pi.logger.warn(`telegram completion failed: ${errorMessage(error)}`);
			return false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		abort = () => ctx.abort();
		session = sessionInfoFromCtx(ctx);
		ctx.setInterval(() => {
			liveCtx = ctx;
			abort = () => ctx.abort();
			if (!client) return;
			void client.heartbeat(ctx.isIdle(), session?.title);
		}, 15_000);
		if (!enabled()) return;
		if (tokenChannelProblems(cfg).length > 0) return;
		await connectBroker(ctx);
	});

	pi.on("session_stop", async (event, ctx) => {
		liveCtx = ctx;
		abort = () => ctx.abort();
		await postTurn(ctx, event.messages ?? [], event.stop_hook_active, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		liveCtx = ctx;
		await disconnect();
	});

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		liveCtx = ctx;
		abort = () => ctx.abort();
		cfg = loadConfig();
		const { cmd } = parseTelegramArgs(args);
		if (cmd === "help") {
			notify(ctx, "Usage: /telegram [status|on|off|post]");
			return;
		}
		if (cmd === "off") {
			enabledOverride = false;
			await disconnect();
			notify(ctx, "Telegram off");
			return;
		}
		if (cmd === "on") {
			enabledOverride = true;
			const ok = await connectBroker(ctx);
			if (!ok) {
				const problems = tokenChannelProblems(cfg);
				notify(
					ctx,
					problems.length > 0 ? `Telegram on failed\n${problems.join("\n")}` : "Telegram on failed",
					"warning",
				);
				return;
			}
			notify(ctx, "Telegram on");
			return;
		}
		if (cmd === "post") {
			if (!client) {
				notify(ctx, "Telegram is not connected", "warning");
				return;
			}
			const posted = await postTurn(ctx, [], false, true);
			notify(ctx, posted ? "Telegram posted" : "Telegram post skipped (empty)", posted ? "info" : "warning");
			return;
		}
		notify(
			ctx,
			formatStatus({
				cfg: effectiveCfg(),
				connected: Boolean(client),
				roster: await rosterOf(client),
				problems: configProblems(effectiveCfg()),
			}),
		);
	}

	const command = {
		description: "Telegram channel bridge (status|on|off|post)",
		getArgumentCompletions: (prefix: string) => filterCompletions(prefix),
		handler: handleCommand,
	};
	pi.registerCommand("telegram", command);
	pi.registerCommand("tg", command);
}
