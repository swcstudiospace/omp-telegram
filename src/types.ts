/** Shared wire + domain types. Do not put I/O in this file. */

export const PROTOCOL_VERSION = 1 as const;

export type SessionId = string;

export type SessionInfo = {
	sessionId: SessionId;
	pid: number;
	cwd: string;
	title: string;
	sessionFile?: string;
	mode?: "tui" | "rpc" | "json" | "print" | "unknown";
};

export type CompletionStatus = "completed" | "stopped" | "failed" | "budget";

export type CompletionPayload = {
	title: string;
	why: string;
	preview: string;
	pngPath: string;
	status: CompletionStatus;
	origin: "tui" | "cli" | "rpc" | "print" | "unknown";
	fingerprint: string;
};

export type CommentImage = {
	fileId: string;
	mimeType: string;
	bytes?: Uint8Array;
};

export type BoundPost = {
	sessionId: SessionId;
	channelId: string;
	channelMessageId: number;
	discussionChatId?: string;
	discussionMessageId?: number;
	postedAt: number;
	title: string;
};

export type TelegramConfig = {
	enabled: boolean;
	botToken: string;
	channelId: string;
	discussionGroupId: string;
	allowedUserIds: number[];
	photoWidth: number;
	photoMaxHeight: number;
	captionPreviewChars: number;
	dataDir: string;
};

export type ChatInfo = {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	linkedChatId?: number;
};

export type SentMessage = {
	chatId: number;
	messageId: number;
	date: number;
};

export type ChannelOrigin = {
	type: "channel";
	chatId: number;
	messageId: number;
};

export type TelegramUser = {
	id: number;
	isBot: boolean;
	username?: string;
	firstName?: string;
};

export type IncomingComment = {
	chatId: number;
	messageId: number;
	date: number;
	from?: TelegramUser;
	text: string;
	images: Array<{ fileId: string }>;
	replyToMessageId?: number;
	replyToIsAutomaticForward?: boolean;
	replyToForwardOrigin?: ChannelOrigin;
	replyToForwardFromChatId?: number;
	replyToForwardFromMessageId?: number;
	messageThreadId?: number;
	isBot: boolean;
};

export type TelegramTransport = {
	getMe(): Promise<{ id: number; username?: string; canReadAllGroupMessages?: boolean }>;
	getChat(chatId: string | number): Promise<ChatInfo>;
	sendPhoto(args: {
		chatId: string | number;
		png: Uint8Array;
		filename: string;
		caption: string;
		replyToMessageId?: number;
		messageThreadId?: number;
	}): Promise<SentMessage>;
	sendDocument(args: {
		chatId: string | number;
		png: Uint8Array;
		filename: string;
		caption: string;
		replyToMessageId?: number;
		messageThreadId?: number;
	}): Promise<SentMessage>;
	sendMessage(args: {
		chatId: string | number;
		text: string;
		replyToMessageId?: number;
		messageThreadId?: number;
	}): Promise<SentMessage>;
	getFile(fileId: string): Promise<{ filePath: string; bytes: Uint8Array }>;
	getUpdates(args: {
		offset?: number;
		timeout?: number;
		signal?: AbortSignal;
	}): Promise<TelegramUpdate[]>;
};

export type TelegramUpdate = {
	updateId: number;
	message?: IncomingComment;
	channelPost?: {
		chatId: number;
		messageId: number;
		date: number;
		text?: string;
	};
};

export type ClientToBroker =
	| { v: 1; id: string; type: "register"; session: SessionInfo }
	| { v: 1; id: string; type: "heartbeat"; sessionId: SessionId; idle: boolean; title?: string }
	| { v: 1; id: string; type: "completion"; sessionId: SessionId; payload: CompletionPayload }
	| { v: 1; id: string; type: "unregister"; sessionId: SessionId }
	| { v: 1; id: string; type: "status" };

export type BrokerToClient =
	| { v: 1; id: string; type: "ok"; data?: unknown }
	| { v: 1; id: string; type: "error"; error: string }
	| {
			v: 1;
			type: "prompt";
			sessionId: SessionId;
			text: string;
			commentId: number;
			chatId: number;
			images: CommentImage[];
	  }
	| { v: 1; type: "abort"; sessionId: SessionId; commentId: number; chatId: number };

export type BrokerMessage = ClientToBroker | BrokerToClient;

export type RosterEntry = SessionInfo & {
	idle: boolean;
	lastSeenAt: number;
	connected: boolean;
};

export type TurnToolCall = {
	name: string;
	detail: string;
};

export type TurnSnapshot = {
	title: string;
	userText: string;
	assistantText: string;
	tools: TurnToolCall[];
	status: CompletionStatus;
	sessionId: SessionId;
	cwd: string;
	origin: CompletionPayload["origin"];
};

export type LongPhoto = {
	png: Uint8Array;
	width: number;
	height: number;
	path: string;
};

export type SkipReason =
	| "disabled"
	| "no_token"
	| "no_channel"
	| "child_session"
	| "stop_hook_active"
	| "empty"
	| "duplicate"
	| "cooldown";
