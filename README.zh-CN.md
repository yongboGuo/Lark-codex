# Lark-codex

[English](./README.md) | 简体中文

Lark-codex 用来把飞书/Lark 聊天消息接到你本机运行的 Codex 上。

它可以让你：

- 在飞书里直接给 Codex 发任务
- 在飞书里收到进度和最终结果
- 在聊天里切换项目目录
- 创建、续接、停止 Codex 会话
- 在私聊、群聊、线程里使用同一套桥接能力

## 这个项目解决什么问题

Codex 本身更适合在终端里使用，但很多场景希望直接从飞书里驱动它。

Lark-codex 的职责很简单：

- 飞书负责交互
- Codex 负责执行
- 原生 Codex session 仍然是唯一真实会话状态
- 桥接层只保存轻量的绑定信息和运行状态

## 主要功能

- 支持私聊
- 支持群聊和线程
- 支持在聊天中切换项目
- 支持新建 / 续接 / 停止 Codex 会话
- 支持三种回包模式：`reply`、`text`、`interactive`
- 支持 `allowedOpenIds`、`allowedChatIds` 访问控制
- 支持 `app-server` 模式下的审批 / 用户输入回传
- 支持 `/git`、`/ls`、`/rg`、`/cat` 等本地命令

## 工作方式

1. 用户在飞书里发消息
2. Lark-codex 通过飞书长连接收到事件
3. 桥接层解析当前会话和绑定项目
4. 消息被送进 Codex
5. 进度和最终结果再发回飞书

## 环境要求

- Node.js 20+
- 本机已经安装并可用的 `codex`
- 一个开启了机器人能力的飞书自建应用
- 飞书事件订阅已经切到“长连接模式”

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备本地配置

模板文件：

- `deploy/config/bridge.env.example`
- `deploy/config/config.json`

本地运行配置：

- `~/.config/lark-codex/bridge.env`
- `~/.config/lark-codex/config.json`

### 3. 填写飞书必填项

在 `bridge.env` 中填写：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID`

### 4. 本地启动

```bash
npm run dev
```

### 5. 或安装成本机服务

```bash
./install.sh --yes
```

macOS 走 `launchd`，Linux 走 `systemd`。

## 推荐的首次配置流程

1. 先启动桥接服务
2. 在飞书里私聊机器人
3. 发送 `/whoami`
4. 拿到你真实的 `sender open_id`
5. 把它填进 `allowedOpenIds`
6. 再发 `/status`
7. 再发 `/new`
8. 再发送普通任务

## 常用聊天命令

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

## 项目切换

直接切到某个目录：

```text
/project bind /absolute/path/to/project
```

先列出候选项目，再按序号切换：

```text
/project list
/project bind -n 3
```

目录不存在时直接创建并切换：

```text
/project bind -m /absolute/path/to/new-project
```

当前实现里的重要行为：

- 切换项目后，会自动清空旧项目绑定的 session
- 切完项目后，通常用 `/new` 新开一个会话
- 如果你要接回该项目已有会话，用 `/resume --project <path>`

## 配置说明

重点飞书配置：

- `feishu.allowAllOpenIds`
- `feishu.allowedOpenIds`
- `feishu.allowedChatIds`
- `feishu.groupRequireMention`
- `feishu.groupRequireCommandPrefix`
- `feishu.commandPrefix`
- `feishu.replyMode`

重点 Codex 配置：

- `codex.profileMode`
- `codex.backendMode`
- `codex.sandboxMode`
- `project.defaultPath`
- `project.allowedRoots`
- `project.defaultSearchEnabled`

## 回包模式

- `reply`：回复原始飞书消息
- `text`：直接在会话里发送纯文本
- `interactive`：发送交互卡片

## 部署方式

### macOS

- LaunchAgent 模板：`deploy/launchd/com.lark-codex.bridge.plist.in`
- 安装后路径：`~/Library/LaunchAgents/com.lark-codex.bridge.plist`

### Linux

- systemd 模板：`deploy/systemd/lark-codex.service.in`
- 安装后路径：`~/.config/systemd/user/lark-codex.service`

## 验证

```bash
npm run check
npm run build
```

## 安全说明

这个仓库里不应该出现你的真实密钥或个人标识。

不要提交：

- 飞书应用密钥
- 真实的 `open_id` / `chat_id`
- `~/.config/lark-codex/` 下的本地运行配置

仓库里只保留占位符，真实配置只放本机。
