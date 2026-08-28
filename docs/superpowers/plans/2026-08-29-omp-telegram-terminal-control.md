# OMP Telegram Terminal Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add broker-routed Telegram control for live OMP sessions, terminal-end capture images on completion, and a guarded `/exec` path without turning Telegram into a raw terminal bridge.

**Architecture:** Keep `src/index.ts` focused on OMP session lifecycle and broker connectivity. Move Telegram command classification, command auditing, terminal capture orchestration, and completion-post assembly into the broker layer, with a new `src/terminal/` module handling rolling transcript state and image rendering from terminal output.

**Tech Stack:** Bun, TypeScript, OMP extension API, existing broker socket protocol, Telegram Bot API, PNG raster rendering already used by `src/capture/`.

---

## File Map

- Modify: `src/types.ts`
  - Extend protocol, session metadata, capture metadata, audit record types, and Telegram command unions.
- Modify: `src/telegram/comments.ts`
  - Classify reply-only Telegram commands into prompt, OMP command, broker command, and guarded shell command variants.
- Modify: `src/telegram/comments.test.ts`
  - Add parser coverage for `/goal`, `/advisor`, `/exec`, `/post`, and invalid slash commands.
- Modify: `src/broker/client.ts`
  - Support additional broker-to-session messages for routed commands and terminal snapshot requests.
- Modify: `src/broker/server.ts`
  - Route recognized commands, persist audits, request terminal captures, and enrich completion posting.
- Modify: `src/broker/server.test.ts`
  - Add behavior coverage for command routing, offline replies, denied `/exec`, and completion capture fallback.
- Modify: `src/index.ts`
  - Accept routed OMP commands, wire a terminal adapter into the broker client, and answer snapshot requests.
- Modify: `src/config.ts`
  - Add guarded shell policy config and defaults.
- Modify: `src/config.test.ts`
  - Cover new config parsing and policy defaults.
- Modify: `src/telegram/post.ts`
  - Support terminal evidence attachments and clearer completion captions when capture falls back.
- Modify: `src/telegram/post.test.ts`
  - Cover single-image, dual-image, and fallback posting choices.
- Create: `src/terminal/transcript.ts`
  - Maintain a rolling terminal buffer and snapshot shape.
- Create: `src/terminal/transcript.test.ts`
  - Verify rolling-window behavior, width handling, and snapshot truncation.
- Create: `src/terminal/render.ts`
  - Render terminal transcript snapshots into Telegram-safe PNG images using the existing PNG helpers.
- Create: `src/terminal/render.test.ts`
  - Verify rendered image shape and visible-line extraction.
- Create: `src/terminal/session.ts`
  - Provide session-side helpers for recording output and answering broker snapshot requests.

## Task 1: Extend Shared Types And Protocol

**Files:**
- Modify: `src/types.ts`
- Test: `src/broker/client.test.ts`

- [ ] **Step 1: Write the failing protocol tests**

```ts
import { describe, expect, test } from "bun:test";
import type { BrokerToClient, ClientToBroker } from "./types.ts";

describe("terminal control protocol", () => {
  test("accepts command dispatch messages", () => {
    const msg: BrokerToClient = {
      v: 1,
      type: "command",
      sessionId: "sess-1",
      commandId: "cmd-1",
      command: { kind: "omp", name: "goal", text: "/goal ship this" },
    };
    expect(msg.command.kind).toBe("omp");
  });

  test("accepts terminal snapshot responses", () => {
    const msg: ClientToBroker = {
      v: 1,
      id: "1",
      type: "terminal_snapshot",
      sessionId: "sess-1",
      snapshot: {
        cols: 120,
        rows: 40,
        lines: ["$ omp", "done"],
        capturedAt: 1,
      },
    };
    expect(msg.snapshot.lines.at(-1)).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/broker/client.test.ts`
Expected: FAIL with type errors because `command` and `terminal_snapshot` protocol shapes do not exist yet.

- [ ] **Step 3: Extend `src/types.ts` with command and terminal models**

```ts
export type RoutedOmpCommand = {
  kind: "omp";
  name: "goal" | "advisor";
  text: string;
};

export type RoutedShellCommand = {
  kind: "exec";
  argv: string[];
  text: string;
};

export type RoutedPromptCommand = {
  kind: "prompt";
  text: string;
};

export type RoutedControlCommand = {
  kind: "control";
  name: "stop" | "status" | "post";
};

export type RoutedCommand =
  | RoutedOmpCommand
  | RoutedShellCommand
  | RoutedPromptCommand
  | RoutedControlCommand;

export type TerminalSnapshot = {
  cols: number;
  rows: number;
  lines: string[];
  capturedAt: number;
};
```

- [ ] **Step 4: Extend broker message unions**

```ts
export type ClientToBroker =
  | { v: 1; id: string; type: "register"; session: SessionInfo }
  | { v: 1; id: string; type: "heartbeat"; sessionId: SessionId; idle: boolean; title?: string }
  | { v: 1; id: string; type: "completion"; sessionId: SessionId; payload: CompletionPayload }
  | { v: 1; id: string; type: "terminal_snapshot"; sessionId: SessionId; snapshot: TerminalSnapshot }
  | { v: 1; id: string; type: "unregister"; sessionId: SessionId }
  | { v: 1; id: string; type: "status" };

export type BrokerToClient =
  | { v: 1; id: string; type: "ok"; data?: unknown }
  | { v: 1; id: string; type: "error"; error: string }
  | { v: 1; type: "prompt"; sessionId: SessionId; text: string; commentId: number; chatId: number; images: CommentImage[] }
  | { v: 1; type: "abort"; sessionId: SessionId; commentId: number; chatId: number }
  | { v: 1; type: "command"; sessionId: SessionId; commandId: string; command: RoutedCommand }
  | { v: 1; type: "terminal_snapshot_request"; sessionId: SessionId; requestId: string };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/broker/client.test.ts`
Expected: PASS for the new protocol shape coverage.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/broker/client.test.ts
git commit -m "feat: define Telegram terminal control protocol"
```

## Task 2: Classify Telegram Reply Commands

**Files:**
- Modify: `src/telegram/comments.ts`
- Modify: `src/telegram/comments.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
test("goal and advisor become omp commands", () => {
  expect(parseCommentCommand("/goal ship it")).toEqual({
    kind: "omp",
    name: "goal",
    text: "/goal ship it",
  });
  expect(parseCommentCommand("/advisor review options")).toEqual({
    kind: "omp",
    name: "advisor",
    text: "/advisor review options",
  });
});

test("exec becomes guarded shell command", () => {
  expect(parseCommentCommand("/exec git status")).toEqual({
    kind: "exec",
    argv: ["git", "status"],
    text: "/exec git status",
  });
});

test("post stays broker control", () => {
  expect(parseCommentCommand("/post")).toEqual({ kind: "control", name: "post" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/telegram/comments.test.ts`
Expected: FAIL because `parseCommentCommand()` only returns `abort`, `status`, `prompt`, or `ignore`.

- [ ] **Step 3: Implement parser upgrades in `src/telegram/comments.ts`**

```ts
function tokenizeCommand(text: string): { cmd: string; rest: string } | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return {
    cmd: match[1]!.toLowerCase(),
    rest: (match[2] ?? "").trim(),
  };
}

function splitExec(rest: string): string[] {
  return rest.split(/\s+/).filter(Boolean);
}

export function parseCommentCommand(text: string): RoutedCommand | { kind: "ignore" } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "ignore" };

  const parsed = tokenizeCommand(trimmed);
  if (!parsed) return { kind: "prompt", text: trimmed };

  if (parsed.cmd === "stop") return { kind: "control", name: "stop" };
  if (parsed.cmd === "status" || parsed.cmd === "sessions") return { kind: "control", name: "status" };
  if (parsed.cmd === "post") return { kind: "control", name: "post" };
  if (parsed.cmd === "goal" || parsed.cmd === "advisor") {
    return { kind: "omp", name: parsed.cmd, text: trimmed };
  }
  if (parsed.cmd === "exec") {
    const argv = splitExec(parsed.rest);
    return argv.length > 0 ? { kind: "exec", argv, text: trimmed } : { kind: "ignore" };
  }

  return { kind: "ignore" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/telegram/comments.test.ts`
Expected: PASS with coverage for OMP, control, exec, and prompt parsing.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/comments.ts src/telegram/comments.test.ts
git commit -m "feat: classify Telegram session reply commands"
```

## Task 3: Route Commands Through The Broker Client And Extension

**Files:**
- Modify: `src/broker/client.ts`
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing dispatch tests**

```ts
test("broker command events call the registered handler", async () => {
  const received: unknown[] = [];
  client.onCommand((msg) => received.push(msg.command));
  injectLine(client, {
    v: 1,
    type: "command",
    sessionId: "sess-1",
    commandId: "cmd-1",
    command: { kind: "omp", name: "goal", text: "/goal ship this" },
  });
  expect(received).toEqual([{ kind: "omp", name: "goal", text: "/goal ship this" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/index.test.ts`
Expected: FAIL because there is no command handler on the broker client or session runtime.

- [ ] **Step 3: Add broker client hooks**

```ts
type CommandHandler = (msg: Extract<BrokerToClient, { type: "command" }>) => void;
type SnapshotHandler = (msg: Extract<BrokerToClient, { type: "terminal_snapshot_request" }>) => void;

onCommand(handler: CommandHandler): void {
  this.#command = handler;
}

onTerminalSnapshotRequest(handler: SnapshotHandler): void {
  this.#snapshot = handler;
}
```

- [ ] **Step 4: Dispatch the new broker messages**

```ts
if (msg.type === "command") {
  if (msg.sessionId === this.#session.sessionId) this.#command?.(msg);
  return;
}

if (msg.type === "terminal_snapshot_request") {
  if (msg.sessionId === this.#session.sessionId) this.#snapshot?.(msg);
  return;
}
```

- [ ] **Step 5: Wire `src/index.ts` to execute routed OMP commands**

```ts
next.onCommand((msg) => {
  const current = liveCtx ?? ctx;
  if (msg.command.kind === "prompt") {
    pi.sendUserMessage(msg.command.text, current.isIdle() ? undefined : { deliverAs: "followUp" });
    return;
  }
  if (msg.command.kind === "omp") {
    pi.sendUserMessage(msg.command.text, current.isIdle() ? undefined : { deliverAs: "followUp" });
  }
});
```

- [ ] **Step 6: Add a terminal snapshot response RPC helper**

```ts
async terminalSnapshot(snapshot: TerminalSnapshot): Promise<void> {
  await this.#rpc((id) => ({
    v: 1,
    id,
    type: "terminal_snapshot",
    sessionId: this.#session.sessionId,
    snapshot,
  }));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test src/index.test.ts src/broker/client.test.ts`
Expected: PASS with command and snapshot-dispatch coverage.

- [ ] **Step 8: Commit**

```bash
git add src/broker/client.ts src/index.ts src/index.test.ts src/types.ts
git commit -m "feat: route broker commands into live OMP sessions"
```

## Task 4: Add Rolling Terminal Transcript Capture

**Files:**
- Create: `src/terminal/transcript.ts`
- Create: `src/terminal/transcript.test.ts`
- Create: `src/terminal/session.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing transcript tests**

```ts
import { describe, expect, test } from "bun:test";
import { createTranscriptBuffer } from "./transcript.ts";

describe("createTranscriptBuffer", () => {
  test("keeps only the newest visible rows", () => {
    const t = createTranscriptBuffer({ cols: 10, rows: 3 });
    t.push("one\ntwo\nthree\nfour");
    expect(t.snapshot().lines).toEqual(["two", "three", "four"]);
  });

  test("wraps long lines to the configured cols", () => {
    const t = createTranscriptBuffer({ cols: 4, rows: 3 });
    t.push("abcdef");
    expect(t.snapshot().lines).toEqual(["abcd", "ef"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/terminal/transcript.test.ts`
Expected: FAIL because the transcript module does not exist.

- [ ] **Step 3: Create the transcript buffer**

```ts
export function createTranscriptBuffer(opts: { cols: number; rows: number }) {
  const state = { cols: opts.cols, rows: opts.rows, lines: [] as string[] };

  return {
    push(chunk: string) {
      for (const raw of chunk.replace(/\r\n/g, "\n").split("\n")) {
        const line = raw || "";
        for (let i = 0; i < line.length || i === 0; i += state.cols) {
          state.lines.push(line.slice(i, i + state.cols));
        }
      }
      if (state.lines.length > state.rows) {
        state.lines.splice(0, state.lines.length - state.rows);
      }
    },
    snapshot() {
      return {
        cols: state.cols,
        rows: state.rows,
        lines: [...state.lines],
        capturedAt: Date.now(),
      };
    },
  };
}
```

- [ ] **Step 4: Add a session-side adapter shell**

```ts
export function createSessionTerminal(opts: { cols: number; rows: number }) {
  const transcript = createTranscriptBuffer(opts);
  return {
    recordOutput(chunk: string) {
      transcript.push(chunk);
    },
    snapshot() {
      return transcript.snapshot();
    },
  };
}
```

- [ ] **Step 5: Wire the adapter into `src/index.ts`**

```ts
const terminal = createSessionTerminal({ cols: 120, rows: 40 });

next.onTerminalSnapshotRequest(async () => {
  await next.terminalSnapshot(terminal.snapshot());
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/terminal/transcript.test.ts src/index.test.ts`
Expected: PASS with stable rolling-window transcript behavior.

- [ ] **Step 7: Commit**

```bash
git add src/terminal/transcript.ts src/terminal/transcript.test.ts src/terminal/session.ts src/index.ts src/index.test.ts
git commit -m "feat: capture rolling terminal transcript state"
```

## Task 5: Render Terminal Snapshots Into Images

**Files:**
- Create: `src/terminal/render.ts`
- Create: `src/terminal/render.test.ts`
- Modify: `src/capture/png.ts`

- [ ] **Step 1: Write the failing renderer tests**

```ts
import { describe, expect, test } from "bun:test";
import { renderTerminalSnapshot } from "./render.ts";

describe("renderTerminalSnapshot", () => {
  test("renders a png for visible terminal lines", async () => {
    const out = await renderTerminalSnapshot({
      cols: 80,
      rows: 3,
      lines: ["$ omp", "working", "done"],
      capturedAt: 1,
    });
    expect(out.height).toBeGreaterThan(0);
    expect(out.png.byteLength).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/terminal/render.test.ts`
Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Implement the terminal snapshot renderer**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturesDir } from "../paths.ts";
import { encodePng, rasterize } from "../capture/png.ts";
import type { LongPhoto, TerminalSnapshot } from "../types.ts";

export async function renderTerminalSnapshot(
  snapshot: TerminalSnapshot,
  opts: { dataDir: string; title: string; sessionId: string },
): Promise<LongPhoto> {
  const lines = [`Terminal  ${opts.sessionId.slice(-8)}`, "", ...snapshot.lines];
  const { rgba, width, height } = rasterize(lines, {
    cols: Math.max(snapshot.cols, 80),
    pad: 16,
    bg: 0x0d1117ff,
    fg: 0xe6edf3ff,
    accent: 0x58a6ffff,
  });
  const png = encodePng(width, height, rgba);
  const dir = capturesDir(opts.dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.sessionId}-terminal-${Date.now()}.png`);
  writeFileSync(path, png);
  return { png, width, height, path };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/terminal/render.test.ts`
Expected: PASS with a concrete PNG artifact produced from terminal lines.

- [ ] **Step 5: Commit**

```bash
git add src/terminal/render.ts src/terminal/render.test.ts
git commit -m "feat: render terminal transcript snapshots as images"
```

## Task 6: Enrich Completion Posting With Terminal Evidence

**Files:**
- Modify: `src/broker/server.ts`
- Modify: `src/telegram/post.ts`
- Modify: `src/telegram/post.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write the failing posting tests**

```ts
test("posts terminal evidence as a second artifact when provided", async () => {
  const api = fakeTelegram();
  await postCompletionBundle({
    api,
    config: { channelId: "-1001", photoMaxHeight: 8500 },
    summary: fakeSummary(),
    terminal: fakeTerminal(),
  });
  expect(api.calls).toEqual(["sendPhoto", "sendPhoto"]);
});

test("falls back to summary-only posting when terminal render fails", async () => {
  const api = fakeTelegram();
  await postCompletionBundle({
    api,
    config: { channelId: "-1001", photoMaxHeight: 8500 },
    summary: fakeSummary(),
    terminal: undefined,
    captureFailed: "terminal unavailable",
  });
  expect(api.lastCaption).toContain("terminal capture unavailable");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/telegram/post.test.ts src/broker/server.test.ts`
Expected: FAIL because posting currently supports only one completion artifact.

- [ ] **Step 3: Add a bundled posting helper**

```ts
export async function postCompletionBundle(args: {
  api: TelegramTransport;
  config: Pick<TelegramConfig, "channelId" | "photoMaxHeight">;
  summary: { png: Uint8Array; filename: string; caption: string; height: number };
  terminal?: { png: Uint8Array; filename: string; caption: string; height: number };
  captureFailed?: string;
}): Promise<{ primary: SentMessage; terminal?: SentMessage }> {
  const caption = args.captureFailed
    ? `${args.summary.caption}\n\n<i>Terminal capture unavailable: ${escapeHtml(args.captureFailed)}</i>`
    : args.summary.caption;

  const primary = await postCompletion({
    api: args.api,
    config: args.config,
    png: args.summary.png,
    filename: args.summary.filename,
    caption,
    pngHeight: args.summary.height,
  });

  const terminal = args.terminal
    ? await postCompletion({
        api: args.api,
        config: args.config,
        png: args.terminal.png,
        filename: args.terminal.filename,
        caption: "<b>Terminal Ending</b>",
        pngHeight: args.terminal.height,
      })
    : undefined;

  return { primary, terminal };
}
```

- [ ] **Step 4: Request and render terminal evidence inside `src/broker/server.ts`**

```ts
const snapshot = await requestTerminalSnapshot(slot);
const terminalPhoto = snapshot
  ? await renderTerminalSnapshot(snapshot, {
      dataDir,
      title: payload.title,
      sessionId: msg.sessionId,
    })
  : undefined;

const sent = await postCompletionBundle({
  api,
  config: { channelId: config.channelId, photoMaxHeight: config.photoMaxHeight },
  summary: {
    png,
    filename: basename(payload.pngPath) || "turn.png",
    caption,
    height,
  },
  terminal: terminalPhoto && {
    png: terminalPhoto.png,
    filename: basename(terminalPhoto.path),
    caption: "<b>Terminal Ending</b>",
    height: terminalPhoto.height,
  },
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/telegram/post.test.ts src/broker/server.test.ts`
Expected: PASS with dual-artifact and fallback posting coverage.

- [ ] **Step 6: Commit**

```bash
git add src/broker/server.ts src/telegram/post.ts src/telegram/post.test.ts src/types.ts
git commit -m "feat: attach terminal evidence to Telegram completions"
```

## Task 7: Add Guarded `/exec` Policy And Audit Records

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/broker/server.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write the failing config and policy tests**

```ts
test("loads allowed exec prefixes from env", () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHANNEL_ID: "-1001",
    TELEGRAM_EXEC_ALLOWLIST: "git status,git diff,npm test",
  });
  expect(cfg.execAllowlist).toEqual([
    ["git", "status"],
    ["git", "diff"],
    ["npm", "test"],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL because the config has no `/exec` policy fields.

- [ ] **Step 3: Add config defaults and parsing**

```ts
function parseCommandList(raw: string | undefined): string[][] | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim().split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length > 0);
}

export function defaultConfig(): TelegramConfig {
  return {
    enabled: true,
    botToken: "",
    channelId: "",
    discussionGroupId: "",
    allowedUserIds: [],
    execAllowlist: [],
    photoWidth: DEFAULT_PHOTO_WIDTH,
    photoMaxHeight: DEFAULT_PHOTO_MAX_HEIGHT,
    captionPreviewChars: DEFAULT_CAPTION_PREVIEW,
    dataDir: defaultDataDir(),
  };
}
```

- [ ] **Step 4: Enforce `/exec` policy in the broker**

```ts
function isAllowedExec(argv: string[], allowlist: string[][]): boolean {
  return allowlist.some((allowed) =>
    allowed.every((part, index) => argv[index] === part),
  );
}

if (cmd.kind === "exec") {
  if (!isAllowedExec(cmd.argv, config.execAllowlist)) {
    await reply(message.chatId, `exec denied: ${cmd.argv.join(" ")}`, message.messageId);
    appendAudit({
      kind: "exec_denied",
      sessionId: bound.sessionId,
      text: cmd.text,
      senderId: message.from?.id,
    });
    return;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/config.test.ts src/broker/server.test.ts`
Expected: PASS with allowlist parsing and denial coverage.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/broker/server.ts src/types.ts
git commit -m "feat: enforce guarded Telegram exec policy"
```

## Task 8: Add Broker Auditing And End-To-End Coverage

**Files:**
- Modify: `src/broker/server.ts`
- Modify: `src/broker/bindings.ts`
- Modify: `src/broker/server.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing integration tests**

```ts
test("replying with /goal routes to the bound live session and records an audit event", async () => {
  const broker = await createBrokerServer({ config, api, dataDir });
  await broker.handleClientLine(registerLine("sess-1"), send);
  await broker.handleUpdate(goalReplyUpdate());
  expect(sentToSession).toContainEqual({
    type: "command",
    command: { kind: "omp", name: "goal", text: "/goal ship this" },
  });
  expect(readAuditLog(dataDir)).toContainEqual(
    expect.objectContaining({ kind: "omp", sessionId: "sess-1" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/broker/server.test.ts`
Expected: FAIL because the broker does not yet persist audit events or route structured commands.

- [ ] **Step 3: Add append-only broker audit logging**

```ts
function appendAudit(dataDir: string, entry: CommandAuditRecord): void {
  appendFileSync(auditPath(dataDir), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
```

- [ ] **Step 4: Emit audit entries for accepted, offline, denied, and failed paths**

```ts
appendAudit(dataDir, {
  at: Date.now(),
  sessionId: bound.sessionId,
  senderId: message.from?.id,
  chatId: message.chatId,
  messageId: message.messageId,
  parsedKind: cmd.kind,
  text: message.text,
  result: connected ? "accepted" : "offline",
});
```

- [ ] **Step 5: Run the focused tests and project checks**

Run: `bun test src/broker/server.test.ts src/telegram/comments.test.ts src/terminal/transcript.test.ts src/terminal/render.test.ts`
Expected: PASS

Run: `bun test`
Expected: PASS across the suite

Run: `bunx tsc --noEmit`
Expected: PASS with no type errors

- [ ] **Step 6: Commit**

```bash
git add src/broker/server.ts src/broker/bindings.ts src/broker/server.test.ts package.json
git commit -m "test: cover Telegram terminal control end to end"
```

## Task 9: Final Operator Docs And Validation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-omp-telegram-terminal-control-design.md`
- Modify: `.omp-plugin/plugin.json`
- Modify: `package.json`

- [ ] **Step 1: Add operator-facing command docs**

```md
## Operator Commands

- Reply with `/goal ...` to set session goals
- Reply with `/advisor ...` to request advisor help
- Reply with plain text to continue the session
- Reply with `/exec ...` for allowed shell commands only
- Reply with `/stop` to abort
- Reply with `/status` to inspect session state
```

- [ ] **Step 2: Update extension metadata**

```json
{
  "description": "Control multiple OMP sessions from Telegram with completion screenshots, terminal evidence, and reply-based command routing."
}
```

- [ ] **Step 3: Run final validation**

Run: `bun test`
Expected: PASS

Run: `bunx tsc --noEmit`
Expected: PASS

Run: `git status --short`
Expected: only the intended doc and metadata files remain modified

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-29-omp-telegram-terminal-control-design.md .omp-plugin/plugin.json package.json
git commit -m "docs: document Telegram terminal control operations"
```

## Spec Coverage Check

- Session tracking and multi-session control: Tasks 1, 3, 8
- Reply-only targeting: Tasks 2, 8
- Recognized OMP commands `/goal` and `/advisor`: Tasks 2, 3, 8
- Guarded `/exec`: Task 7
- Terminal-end screenshot evidence: Tasks 4, 5, 6
- Telegram completion posting and fallback behavior: Task 6
- Persistence and auditability: Tasks 7, 8
- Failure handling and validation: Tasks 6, 7, 8, 9

