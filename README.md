# Lark-codex

Feishu/Lark-native bridge for real Codex sessions.

`Lark-codex` forwards Feishu messages into Codex, keeps Codex native sessions as the source of truth, and returns progress plus final results back into Feishu conversations.

## What Changed From Upstream

- Rebranded from `codex-feishu-bridge` to `lark-codex`
- Added sender and chat allowlists
- Added group and thread support instead of DM-only handling
- Added group trigger controls with `@bot` mention and/or command prefix
- Added `/whoami` for allowlist onboarding and diagnostics
- Added outbound reply modes: `reply`, `text`, `interactive`
- Kept Codex native session binding, approvals, and project/session controls

## Key Features

- Feishu websocket ingress plus outbound replies
- DM conversations and group threads mapped to Codex sessions
- Codex backends: `app-server`, `spawn`, `terminal`
- Feishu-side approvals and user input replies for `app-server`
- Project binding, session resume, model/profile/search controls
- Local command passthrough: `/git`, `/pwd`, `/ls`, `/cat`, `/tree`, `/find`, `/rg`

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Prepare config:

- env template: `deploy/config/bridge.env.example`
- json template: `deploy/config/config.json`
- install location: `~/.config/lark-codex/`

3. Required env values:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID`

4. Recommended access control defaults:

- `FEISHU_ALLOW_ALL_OPEN_IDS=false`
- `FEISHU_ALLOWED_OPEN_IDS=ou_xxx,ou_yyy`
- `FEISHU_ALLOWED_CHAT_IDS=oc_xxx`

5. Start locally:

```bash
npm run dev
```

6. Or install as a user service:

```bash
./install.sh
```

## Group And Thread Behavior

- DM messages are handled directly.
- Group messages are supported.
- Group threads use `group:<chat_id>:thread:<thread_id>` as the conversation key.
- Non-threaded group chats fall back to `chat:<chat_id>`.
- By default, group messages require an explicit `@bot` mention.
- You can additionally require a command prefix such as `codex`.
- Plain slash commands like `/status` and `/whoami` are also accepted.

## Reply Modes

- `reply`: reply to the original Feishu message using plain text, best for chat-like interaction
- `text`: send plain text messages to the chat without reply threading
- `interactive`: send interactive cards, closer to the original upstream style

Set this with `FEISHU_REPLY_MODE` or `feishu.replyMode` in `config.json`.

## Useful Commands

- `/help`
- `/status`
- `/whoami`
- `/new`
- `/resume`
- `/session`
- `/stop`
- `/project`
- `/approvals`
- `/search`
- `/model`
- `/profile`
- `/git`
- `/log`

Use `/whoami` first in Feishu to capture:

- `sender open_id`
- `chat id`
- `thread id`
- resolved `conversation key`

That makes it easy to fill `allowedOpenIds` and `allowedChatIds`.

## Config Notes

The checked-in `deploy/config/config.json` now includes:

- `feishu.allowAllOpenIds`
- `feishu.allowedOpenIds`
- `feishu.allowedChatIds`
- `feishu.groupRequireMention`
- `feishu.groupRequireCommandPrefix`
- `feishu.commandPrefix`
- `feishu.replyMode`

Default local paths were also renamed:

- Codex home: `~/.lark-codex`
- Sessions: `~/.lark-codex/sessions`
- Binding store: `~/.local/share/lark-codex/bindings.json`
- Service env/config: `~/.config/lark-codex/`

## Service Install

- systemd template: `deploy/systemd/lark-codex.service.in`
- installed unit: `~/.config/systemd/user/lark-codex.service`
- installed binary: `lark-codex`

`install.sh` builds the package, installs the binary, writes the user service, preserves existing local config, and restarts the service.

## Local Testing

For CLI-only testing without Feishu:

```bash
npm run cli -- --chat-id test-terminal
```

That uses the same binding rules as a `p2p:<chat_id>` conversation.

## Validation

```bash
npm run check
npm run build
```
