import type {
	CompletionPayload,
	CompletionStatus,
	SentMessage,
	SessionInfo,
	TelegramConfig,
	TelegramTransport,
} from "../types.ts";

const PHOTO_BYTE_LIMIT = 9_000_000;

const STATUS_EMOJI: Record<CompletionStatus, string> = {
	completed: "✅",
	stopped: "⏹",
	failed: "❌",
	budget: "💸",
};

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function buildCaption(args: {
	session: SessionInfo;
	payload: CompletionPayload;
	previewLimit: number;
}): string {
	const tail = args.session.sessionId.slice(-8);
	const title = args.payload.title || args.session.title;
	const preview =
		args.previewLimit > 0 && args.payload.preview.length > args.previewLimit
			? args.payload.preview.slice(0, args.previewLimit)
			: args.payload.preview;
	const emoji = STATUS_EMOJI[args.payload.status] ?? "•";
	const lines = [
		`<b>OMP</b> · <code>${escapeHtml(tail)}</code> · ${emoji}`,
		`📌 ${escapeHtml(title)}`,
		`<code>${escapeHtml(args.session.cwd)}</code>`,
	];
	if (preview) lines.push(escapeHtml(preview));
	lines.push("↪ Comment on this post to continue this session.");
	return lines.join("\n");
}

export async function postCompletion(args: {
	api: TelegramTransport;
	config: Pick<TelegramConfig, "channelId" | "photoMaxHeight">;
	png: Uint8Array;
	filename: string;
	caption: string;
	pngHeight: number;
}): Promise<SentMessage> {
	const sendArgs = {
		chatId: args.config.channelId,
		png: args.png,
		filename: args.filename,
		caption: args.caption,
	};
	const tooTall = args.pngHeight >= args.config.photoMaxHeight;
	const tooHeavy = args.png.byteLength > PHOTO_BYTE_LIMIT;
	if (tooTall || tooHeavy) {
		return args.api.sendDocument(sendArgs);
	}
	try {
		return await args.api.sendPhoto(sendArgs);
	} catch {
		return args.api.sendDocument(sendArgs);
	}
}

