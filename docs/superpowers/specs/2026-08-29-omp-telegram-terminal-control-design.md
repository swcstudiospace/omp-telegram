# OMP Telegram Terminal Control Design

## Summary

Build a proper `omp` extension that lets one Telegram bot track open OMP sessions, post completion notifications into a single Telegram channel or group workflow, include terminal-end evidence with each completion, and route approved reply commands back into the bound running session.

The selected architecture is a broker-centered control plane:

- OMP sessions stay lightweight and register with a local broker.
- The broker is the single authority for session roster, Telegram bindings, command routing, capture requests, and audit logging.
- Telegram operators target a session by replying to that session's Telegram completion post.
- Recognized OMP commands such as `/goal` and `/advisor` are routed back into the bound session.
- Guarded shell execution is available through an explicit `/exec ...` path with policy enforcement and auditing.
- Terminal completion evidence is produced from a managed PTY transcript rendered into an image, not from OS-level desktop screenshots.

## Goals

- Track multiple live OMP sessions through one Telegram bot.
- Post a completion notification for each relevant session completion.
- Include the ending state of the terminal that actually ran the session.
- Allow approved operators to send commands back to the running session from Telegram.
- Keep session targeting simple and safe by using reply-only routing.
- Make the extension production-friendly with persistence, auditability, and failure handling.

## Non-Goals

- Full raw TTY streaming over Telegram.
- Arbitrary remote shell access without policy controls.
- Session targeting by free-form natural language.
- First-release job queue orchestration across hosts.
- GUI or desktop screenshot capture as the primary evidence mechanism.

## Requirements

### Functional

1. The extension must register each OMP session with a local broker process.
2. The broker must maintain a live roster of active sessions with heartbeat state.
3. The extension must post completion notifications to Telegram for bound sessions.
4. Each completion must include terminal-end evidence derived from the session that produced the completion.
5. Telegram replies to a session post must resolve to the bound OMP session.
6. Telegram replies containing recognized OMP commands such as `/goal ...` and `/advisor ...` must be converted into structured input for the bound session.
7. Plain text Telegram replies must continue the bound session as a normal follow-up prompt.
8. Telegram replies containing `/stop` and `/status` must invoke broker-level control behavior.
9. Telegram replies containing `/exec ...` must route through a guarded shell execution path with access checks and audit logging.
10. The broker must acknowledge accepted, rejected, offline, and failed commands back into Telegram.

### Operational

1. The bot must support one shared Telegram control surface for multiple sessions.
2. Only allowed Telegram users may issue control commands when an allowlist is configured.
3. The system must preserve enough local state to recover message bindings and offsets after broker restart.
4. If Telegram polling or posting fails transiently, the broker must stay alive and retry.
5. If terminal capture fails, completion posting must still happen with an explicit capture-failed indication.

## User Experience

### Completion Flow

1. A session starts and registers with the broker.
2. The broker observes heartbeats and keeps the session roster current.
3. When the session reaches a relevant completion point, the session emits a completion event.
4. The broker requests the latest terminal-ending capture for that session.
5. The broker renders or assembles the Telegram post payload.
6. Telegram receives a completion post that includes the session summary and terminal evidence.
7. Operators reply to that post to continue or control that specific session.

### Operator Flow

Operators use reply-only targeting:

- Reply with `/goal ...` to set or update the session goal.
- Reply with `/advisor ...` to invoke the advisor workflow for that session.
- Reply with plain text to continue the session naturally.
- Reply with `/exec ...` to run an allowed shell action through the guarded execution path.
- Reply with `/stop` to request stop or abort behavior.
- Reply with `/status` to inspect session availability and routing state.

The broker always replies with an acknowledgement or error message so operators can see whether the command was accepted, rejected, or could not be delivered.

## Architecture

### Components

#### 1. OMP Extension Runtime

Responsibilities:

- Register the current session with the broker.
- Send heartbeats and completion events.
- Accept broker-routed commands for the active session.
- Expose terminal capture metadata or transcript access to the broker-facing runtime.

The extension should remain focused on session lifecycle integration and should avoid owning Telegram-specific persistence or control logic.

#### 2. Broker Daemon

Responsibilities:

- Maintain the authoritative live session registry.
- Persist Telegram post bindings and broker offsets.
- Parse Telegram updates and route replies to the correct bound session.
- Request terminal captures and post completions to Telegram.
- Enforce allowed-user checks and guarded shell policies.
- Persist audit events for remote actions.

This is the system boundary that makes the feature a proper extension rather than a thin ad hoc message relay.

#### 3. Telegram Adapter

Responsibilities:

- Poll updates.
- Post photos, documents, and text messages.
- Resolve linked discussion chats when needed.
- Download images attached to Telegram replies.

Telegram remains transport-only. Business rules stay in the broker.

#### 4. Terminal Capture Adapter

Responsibilities:

- Manage a PTY-backed transcript for the session terminal.
- Preserve a rolling buffer of visible terminal output.
- Expose dimensions, transcript path, and capture metadata.
- Render the final visible rows into a terminal-style image at completion time.

## Terminal Evidence Strategy

### Chosen Approach

Use a managed PTY transcript plus renderer, not desktop screenshots.

Rationale:

- Works reliably on headless Linux hosts.
- Avoids dependence on a visible GUI terminal window.
- Produces reproducible terminal evidence from the actual session output.
- Supports policy controls, replay, and automated tests.

### Capture Model

Each live session must have a terminal adapter that records:

- PTY or transcript identifier
- current terminal width and height
- rolling visible buffer
- capture timestamp
- rendered image path for the latest completion snapshot

At completion time, the broker should request a fresh terminal-ending snapshot and render it as a PNG suitable for Telegram posting.

### Posting Strategy

Preferred first release:

- Keep the existing completion long-photo behavior for the conversation summary.
- Attach terminal evidence either as:
  - a second image in the same completion flow, or
  - a merged image that combines summary and terminal ending when layout remains readable.

Selection rule:

- If the terminal ending adds distinct operator value, post it explicitly.
- If rendering limits or readability would degrade the summary, post two artifacts rather than forcing one overly tall image.

## Command Model

### Session Targeting

Use reply-only targeting.

The broker resolves the session exclusively from the Telegram post or discussion reply relationship. This avoids ambiguous global commands in busy channels and keeps the operator mental model simple: reply to the post you want to control.

### Recognized Command Classes

#### OMP Session Commands

Examples:

- `/goal ...`
- `/advisor ...`
- future structured OMP commands with slash syntax

Behavior:

- Parse the command name and argument payload.
- Transform it into structured OMP-side input for the bound session.
- Deliver it using the session’s broker connection.

#### Plain Follow-Up Prompts

Any non-command reply text is forwarded as a normal follow-up prompt to the bound OMP session.

#### Broker Control Commands

Examples:

- `/stop`
- `/status`
- `/post`

Behavior:

- Execute within broker control logic.
- Return a Telegram acknowledgement or status reply.

#### Guarded Shell Commands

Example:

- `/exec <command>`

Behavior:

- Parse as an explicit guarded shell action.
- Check sender authorization and command policy.
- Execute only through the approved shell bridge.
- Emit audit records and Telegram acknowledgements.

### Guardrails For `/exec`

The first release should enforce:

- allowed-user checks
- explicit `/exec` prefix
- allowlist or rule-based command policy
- command echo in Telegram acknowledgement
- execution result summary
- audit trail with sender, session, command, and outcome

The first release should not expose unrestricted shell passthrough.

## Data Model

### Session Registry

Persist or keep in authoritative broker memory:

- `sessionId`
- `title`
- `cwd`
- `pid`
- `mode`
- `idle`
- `lastSeenAt`
- `connected`
- terminal handle or transcript metadata

### Telegram Binding Record

Persist:

- Telegram channel id
- Telegram channel message id
- linked discussion chat id
- linked discussion message id or thread id
- bound `sessionId`
- post timestamp
- session title snapshot

### Command Audit Record

Persist:

- event timestamp
- Telegram sender id
- Telegram chat id
- Telegram message id
- bound `sessionId`
- parsed command kind
- original text
- policy decision
- dispatch result
- completion or error summary

### Capture Metadata

Persist:

- transcript path
- terminal dimensions
- capture timestamp
- rendered image path
- render mode
- fallback reason if capture failed

## Broker Protocol Changes

Add message types for:

- session terminal registration
- terminal snapshot request
- terminal snapshot response
- OMP command dispatch
- guarded shell dispatch
- command acknowledgement
- command rejection

The protocol must distinguish between:

- user prompt continuation
- recognized OMP command
- broker control command
- guarded shell command

## Failure Handling

### Telegram Failure

- Keep the broker alive if polling or posting fails.
- Retry polling after delay.
- Log posting failures with token-safe messages.
- Do not lose audit intent if a command was parsed but Telegram acknowledgement could not be posted.

### Offline Session

- If the bound session is offline, reply in Telegram with an explicit offline message.
- Include a brief roster hint when useful.
- Do not pretend the command was delivered.

### Capture Failure

- Post the completion even if terminal rendering fails.
- Mark the post or caption with capture-failed context.
- Preserve failure metadata for later diagnosis.

### Invalid Reply Target

- If a Telegram reply is not bound to an OMP session post, return a clear message such as "Not an OMP session post."

### Policy Denial

- If `/exec` is not allowed, reply with a concise denial reason.
- Record the denial in the audit log.

## Security Model

- Treat Telegram as a remote control surface.
- Default to allowed-user enforcement when configured.
- Keep slash-command parsing explicit and deterministic.
- Restrict direct shell execution to the `/exec` path only.
- Audit every remote control action.
- Avoid exposing raw terminal streams or credentials in Telegram output.

## Delivery Plan

### Slice 1: Command Routing

- Extend protocol and types for command routing.
- Upgrade Telegram reply parsing to recognize `/goal`, `/advisor`, `/exec`, `/stop`, `/status`, and plain follow-up text.
- Route recognized OMP commands back into the bound live session.
- Add Telegram acknowledgements for accepted, rejected, and offline outcomes.

### Slice 2: Terminal Evidence

- Add terminal adapter and transcript capture.
- Render terminal-ending images from transcript state.
- Attach terminal evidence to completion posting with fallback behavior.

### Slice 3: Guarded Shell And Hardening

- Add `/exec` policy enforcement and result reporting.
- Add richer audit records.
- Add regression coverage for failure paths and authorization behavior.
- Document operator usage and setup.

## Test Plan

Add or extend focused tests for:

- Telegram reply parsing for all command classes
- binding resolution for reply-only targeting
- broker routing for online and offline sessions
- OMP command dispatch payload shaping
- guarded shell policy acceptance and denial
- terminal transcript rendering
- completion posting with terminal evidence
- fallback behavior when capture fails
- end-to-end session reply control

## Open Implementation Notes

- The current codebase already has the right foundation: session registration, broker lifecycle, completion posting, and reply-based routing.
- The main structural additions are command classification, broker protocol expansion, and terminal transcript capture.
- The PTY adapter should be designed to fit the environments where OMP actually runs; if a true PTY hook is unavailable in some modes, the implementation should degrade to transcript mirroring without breaking completion posting.
