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
- `/session`
- `/stop`
- `/project`
- `/approvals`

## Status

Working v1 bridge:

- Feishu long-connection receive/send
- DM receive plus interactive-card replies
- conversation to native Codex session binding
- `/help` `/status` `/new` `/resume` `/session` `/stop` `/project` `/approvals`
- `/search` `/model` `/profile`
- `/git` `/pwd` `/ls` `/cat` `/tree` `/find` `/rg`
- `/project bind <path>` to rebind a conversation to another directory under `PROJECT_ALLOWED_ROOTS`
- `/approvals auto|full-access` to switch the Codex sandbox mode used for future runs
- backend modes: `spawn` now, `app-server` and `terminal` reserved as experimental

## Run

1. Copy `.env.example` to `.env` and fill in Feishu credentials.
2. Install dependencies with `npm install`.
3. Start the bridge with `npm run dev`.

For a full local install from the current checkout, including package install, build, user unit install, and hard restart:

```bash
./install.sh
```

Or:

```bash
npm run install:local
```

## User Service

- Repo-owned systemd template: `deploy/systemd/codex-feishu-bridge.service.in`
- User config templates: `deploy/config/bridge.env.example` and `deploy/config/config.json`
- Optional startup-ready notification: set `FEISHU_STARTUP_NOTIFY_CHAT_ID` in `bridge.env`
  to get a one-time Feishu message after the websocket is connected and outbound
  message sending is working.
- Install or update the user service with:

```bash
./install.sh
```

- `install.sh` renders the current checkout path into the unit, writes the unit to:
  `~/.config/systemd/user/codex-feishu-bridge.service`
- `install.sh` builds a detached package payload, installs the global `codex-feishu-bridge`
  binary under your npm prefix, and points the user service at that binary.
- It preserves existing `~/.config/codex-feishu-bridge/bridge.env` and `config.json` if they
  already exist.
- Machine-specific proxy or custom CA settings should live in
  `~/.config/codex-feishu-bridge/bridge.env`, not in the repo-owned systemd unit template.
- Project access is controlled by `PROJECT_ALLOWED_ROOTS`. `DEFAULT_PROJECT` must stay under
  one of those allowed roots.
- `DEFAULT_SEARCH_ENABLED=true` makes new conversations and `/new` sessions default to live web search enabled.
- On a fresh install, `~/.config/codex-feishu-bridge/config.json` defaults
  `CODEX_SANDBOX_MODE` to `danger-full-access`. Change that file if you want
  `workspace-write` instead.
- The script asks for confirmation, then installs or updates the unit, reloads user systemd,
  enables the service, and performs a hard restart.

For local testing without Feishu, run `npm run cli -- --chat-id test-terminal`. This uses the same binding logic as Feishu `p2p:<chat_id>` conversations, so the chosen `chatId` becomes the reusable bridge conversation key.

## Backend Mode

- `CODEX_BACKEND_MODE=spawn` is the supported mode. Each turn spawns `codex exec` or `codex exec resume`, while the bridge persists the native session id.
- `spawn` now emits lightweight progress updates such as session start, thinking, long-run heartbeat, and upstream websocket retry notices when Codex exposes them.
- `CODEX_BACKEND_MODE=app-server` is experimental. It keeps a local `codex app-server` subprocess per bound native session and talks to it over stdio JSON-RPC for `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt`.
- `CODEX_BACKEND_MODE=terminal` is experimental. It is intended for a terminal-derived Codex experience projected into Feishu, but the current Codex interactive CLI is still a full-screen TUI and not yet reliable enough to use as the default backend.
- `CODEX_SANDBOX_MODE=workspace-write` maps to Codex `--full-auto`.
- `CODEX_SANDBOX_MODE=danger-full-access` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
- The checked-in user-service JSON template defaults to `danger-full-access`.
- `CODEX_RUN_TIMEOUT_MS` controls the maximum lifetime of one active Codex run before the bridge terminates it.
- `SPAWN_STATUS_INTERVAL_MS` controls the heartbeat interval for long-running `spawn` turns. Set it to `0` to disable heartbeats.
- `FEISHU_SEND_RETRY_MAX_ATTEMPTS`, `FEISHU_SEND_RETRY_BASE_DELAY_MS`, `FEISHU_SEND_RETRY_MULTIPLIER`, and `FEISHU_SEND_RETRY_MAX_DELAY_MS` control retry/backoff for transient Feishu send failures such as `502`, `429`, and short network errors. `FEISHU_SEND_RETRY_MAX_ATTEMPTS=0` means one send attempt with no retry.
- Outbound Feishu replies currently use interactive cards with a schema `2.0` markdown body, card title, chat-list summary, and per-reply header template color.
- `TERMINAL_FLUSH_IDLE_MS` controls the quiet window before terminal output is projected back to Feishu as one reply.
- `TERMINAL_FLUSH_MAX_CHARS` caps one terminal-mode Feishu reply so noisy screens do not flood the chat.
- Numeric config values must be integers. Invalid values now fail fast during startup.

## Feishu Rendering

- Inbound Feishu messages support both plain `text` and rich `post` payloads.
- Outbound replies use Feishu interactive cards.
- The card body keeps the same markdown content string the bridge generates, plus a raw fenced markdown appendix for clients that do not render every markdown feature consistently.
- Long replies are split on markdown block boundaries so fenced code blocks stay valid across chunks.

## Codex Profile Mode

- `CODEX_PROFILE_MODE=isolated` gives the bridge its own Codex home. This is the default in development and is the safest mode for testing.
- `CODEX_PROFILE_MODE=personal` points the bridge at your personal `~/.codex` so Feishu and your local terminal can reuse the same Codex sessions.
- `personal + spawn` is currently a compatibility mode, not the safest one. It may interfere with an interactive Codex instance that is already running against the same home.

## Session Binding

- Feishu does not provide a native Codex session id. The bridge binds a Feishu conversation key to a Codex session id in its local store.
- `p2p` chats bind on `p2p:<chat_id>`.
- If a conversation already has a bound session, the bridge reuses it.
- If a run is already active for that conversation, the bridge rejects a second concurrent turn instead of guessing which live run to reuse.
