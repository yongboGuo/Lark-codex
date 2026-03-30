# Lark-codex

English | [简体中文](./README.zh-CN.md)

Lark-codex connects Feishu/Lark chats to real Codex sessions running on your machine.

It lets you:

- send prompts to Codex from Feishu
- receive progress updates and final answers in Feishu
- switch projects from chat
- create, resume, and stop Codex sessions
- use the same bridge in DM and group/thread scenarios

## What This Project Solves

Codex is strong in the terminal, but many people want to use it from Feishu.

Lark-codex adds a practical bridge:

- Feishu is the chat surface
- Codex is the execution engine
- native Codex sessions stay the source of truth
- the bridge only stores lightweight bindings and runtime state

## Main Features

- DM support
- Group and thread support
- Project switching from chat
- Session create/resume/stop
- Reply modes: `reply`, `text`, `interactive`
- Access control with `allowedOpenIds` and `allowedChatIds`
- Feishu-side approval / input flow for `app-server`
- Local utility commands such as `/git`, `/ls`, `/rg`, `/cat`

## How It Works

1. A user sends a message in Feishu.
2. Lark-codex receives the event through Feishu long connection.
3. The bridge resolves the conversation and bound project.
4. The message is forwarded into Codex.
5. Progress and final output are sent back to Feishu.

## Requirements

- Node.js 20+
- `codex` installed and working locally
- A Feishu/Lark self-built app with bot ability enabled
- Feishu event subscription configured for long connection mode

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Prepare local config

Templates:

- `deploy/config/bridge.env.example`
- `deploy/config/config.json`

Local runtime paths:

- `~/.config/lark-codex/bridge.env`
- `~/.config/lark-codex/config.json`

### 3. Fill required Feishu values

In `bridge.env`:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID`

### 4. Start locally

```bash
npm run dev
```

### 5. Or install as a local service

```bash
./install.sh --yes
```

macOS supports `launchd`. Linux supports `systemd`.

## Recommended First-Time Setup

1. Start the bridge.
2. Open a DM with your bot in Feishu.
3. Send `/whoami`.
4. Copy your real `sender open_id`.
5. Put that value into `allowedOpenIds`.
6. Send `/status`.
7. Send `/new`.
8. Send a normal prompt.

## Common Chat Commands

- `/help`
- `/status`
- `/whoami`
- `/new`
- `/resume`
- `/session`
- `/stop`
- `/project`
- `/project list`
- `/project bind <path>`
- `/search [on|off]`
- `/model [name|clear]`
- `/profile [name|clear]`

## Project Switching

Switch to a project directly:

```text
/project bind /absolute/path/to/project
```

Switch using the list:

```text
/project list
/project bind -n 3
```

Create and bind a missing directory:

```text
/project bind -m /absolute/path/to/new-project
```

Important behavior:

- changing project clears the old bound session
- after switching project, use `/new` to start a fresh session
- or use `/resume --project <path>` to bind an existing session in that project

## Configuration Notes

Important Feishu settings:

- `feishu.allowAllOpenIds`
- `feishu.allowedOpenIds`
- `feishu.allowedChatIds`
- `feishu.groupRequireMention`
- `feishu.groupRequireCommandPrefix`
- `feishu.commandPrefix`
- `feishu.replyMode`

Important Codex settings:

- `codex.profileMode`
- `codex.backendMode`
- `codex.sandboxMode`
- `project.defaultPath`
- `project.allowedRoots`
- `project.defaultSearchEnabled`

## Reply Modes

- `reply`: reply to the original Feishu message
- `text`: send plain text messages to the chat
- `interactive`: send interactive cards

## Deployment

### macOS

- LaunchAgent template: `deploy/launchd/com.lark-codex.bridge.plist.in`
- Installed LaunchAgent: `~/Library/LaunchAgents/com.lark-codex.bridge.plist`

### Linux

- systemd template: `deploy/systemd/lark-codex.service.in`
- Installed user unit: `~/.config/systemd/user/lark-codex.service`

## Validation

```bash
npm run check
npm run build
```

## Security Note

This repository should not contain your real secrets.

Do not commit:

- Feishu app secrets
- personal `open_id` / `chat_id`
- local runtime config under `~/.config/lark-codex/`

Use placeholders in tracked files and keep real values in local config only.
