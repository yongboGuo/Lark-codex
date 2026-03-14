# codex-feishu-bridge

Thin Feishu-native relay for Codex native sessions.

## Goal

`codex-feishu-bridge` forwards Feishu input into real Codex sessions and sends Codex output back to Feishu. Codex native sessions are the single source of truth for conversation state.

## Principles

- Feishu is the control surface.
- Codex is the execution engine.
- Codex native sessions are the only session truth.
- The bridge stores only bindings and runtime metadata.
- Do not replay message history to simulate continuity.
- Do not create a second assistant/session abstraction above Codex.

## Scope

### In scope
- Feishu bot websocket ingress
- DM-first message handling
- Feishu conversation/thread to Codex session binding
- Create/resume/stop native Codex sessions
- Stream Codex output back to Feishu
- Minimal command set for control and status
- Small local metadata store for bindings and active-run locks

### Out of scope (initially)
- Broad plugin platform
- Independent long-term memory system
- Synthetic conversation storage
- Multi-provider orchestration
- Heavy card UX or product shell behavior

## Initial command ideas

- `/help`
- `/status`
- `/new`
- `/resume`
- `/stop`
- `/workspace`

## Status

Working v1 bridge:

- Feishu long-connection receive/send
- DM text in / text out
- conversation to native Codex session binding
- `/help` `/status` `/new` `/resume <session-id>` `/stop` `/workspace`
- backend modes: `spawn` now, `tcl` reserved as experimental

## Run

1. Copy `.env.example` to `.env` and fill in Feishu credentials.
2. Install dependencies with `npm install`.
3. Start the bridge with `npm run dev`.

## Backend Mode

- `CODEX_BACKEND_MODE=spawn` is the supported mode. Each turn spawns `codex exec` or `codex exec resume`, while the bridge persists the native session id.
- `CODEX_BACKEND_MODE=tcl` is intentionally blocked for now. The current Codex interactive CLI is a full-screen TUI without a stable machine protocol, so PTY automation is too brittle to treat as production-safe.
- `CODEX_RUN_TIMEOUT_MS` controls the maximum lifetime of one active Codex run before the bridge terminates it.

## Codex Profile Mode

- `CODEX_PROFILE_MODE=isolated` gives the bridge its own Codex home. This is the default in development and is the safest mode for testing.
- `CODEX_PROFILE_MODE=personal` points the bridge at your personal `~/.codex` so Feishu and your local terminal can reuse the same Codex sessions.
- `personal + spawn` is currently a compatibility mode, not the safest one. It may interfere with an interactive Codex instance that is already running against the same home.
