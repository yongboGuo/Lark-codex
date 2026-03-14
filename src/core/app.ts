import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { CodexBackend } from "../adapters/codex/backend.js";
import { createCodexBackend } from "../adapters/codex/codex-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, SessionBinding } from "../types/domain.js";
import { getSessionSummary, listRecentSessions } from "../adapters/codex/session-files.js";

export class App {
  private readonly store: BindingStore;
  private readonly codex: CodexBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly config: AppConfig) {
    this.store = new BindingStore(path.resolve(this.config.storePath));
    this.codex = createCodexBackend(this.config.codex);
  }

  async start(): Promise<void> {
    console.log("codex-feishu-bridge starting", {
      nodeEnv: this.config.nodeEnv,
      configPath: this.config.configPath,
      workspaceRoot: this.config.workspace.root,
      defaultWorkspace: this.config.workspace.defaultWorkspace,
      codexBin: this.config.codex.bin,
      codexHome: this.config.codex.home,
      codexProfileMode: this.config.codex.profileMode,
      codexBackendMode: this.codex.mode,
      codexSandboxMode: this.config.codex.sandboxMode
    });
    if (this.config.codex.profileMode === "personal" && this.codex.mode === "spawn") {
      console.warn(
        "Using CODEX_PROFILE_MODE=personal with spawn backend. This shares ~/.codex with your interactive Codex and may cause instability."
      );
    }
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(async (message) => {
      try {
        let streamed = false;
        let lastUpdateText: string | undefined;
        const text = await this.handleIncoming(message, async (update) => {
          streamed = true;
          lastUpdateText = update;
          await this.feishu?.send({
            chatId: message.chatId,
            text: update,
            replyToMessageId: message.messageId,
            threadId: message.threadId
          });
        });
        if ((text && text !== lastUpdateText) || !streamed) {
          await this.feishu?.send({
            chatId: message.chatId,
            text,
            replyToMessageId: message.messageId,
            threadId: message.threadId
          });
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown bridge error.";
        await this.feishu?.send({
          chatId: message.chatId,
          text: `bridge error: ${text}`,
          replyToMessageId: message.messageId,
          threadId: message.threadId
        });
      }
    });
  }

  async handleIncoming(
    message: IncomingMessage,
    onUpdate?: (text: string) => Promise<void>
  ): Promise<string> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const command = parseCommand(message);
    if (command?.name === "help") {
      return [
        "# Bridge Help",
        "",
        "- `/help` show commands",
        "- `/status` show current session and run state",
        "- `/new` create and bind a fresh Codex session",
        "- `/resume [<session-id>|-h|--all]` bind the most recent session by default, a specific session by id, or show resume help",
        "- `/sessions [n]` list recent native Codex session ids",
        "- `/stop` stop the current active run",
        "- `/workspace` show the bound workspace",
        "- `/workspace <path>` bind this conversation to a workspace under `WORKSPACE_ROOT`",
        "- `/approvals [auto|full-access]` show or change Codex approvals"
      ].join("\n");
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);

    if (command?.name === "status") {
      const workspace = existing?.workspace || this.config.workspace.defaultWorkspace;
      const sessionId = existing?.codexSessionId || "(none)";
      return [
        "# Bridge Status",
        "",
        `- **conversation**: \`${key}\``,
        `- **session**: \`${sessionId}\``,
        `- **workspace**: \`${workspace}\``,
        `- **backend**: \`${this.codex.mode}\``,
        `- **sandbox**: \`${this.config.codex.sandboxMode}\``,
        `- **run**: \`${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}\``
      ].join("\n");
    }

    if (command?.name === "resume") {
      if (activeRun) {
        return `Cannot resume while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.resumeHelpText();
      }
      if (command.args[0] === "--all") {
        return [
          "# Resume",
          "",
          "- Native `codex resume --all` shows all sessions in the interactive picker, disables cwd filtering, and shows the CWD column.",
          "- In this bridge, use `/sessions 20` to browse recent sessions across the configured `CODEX_SESSIONS_DIR`.",
          "- Then use `/resume <session-id>` to bind one of them."
        ].join("\n");
      }

      const targetSessionId =
        command.args[0] ||
        (await this.findMostRecentSessionId()) ||
        existing?.codexSessionId;
      if (!targetSessionId) {
        return "No native Codex session found. Use `/sessions` or `/resume <session-id>`.";
      }
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return `session not found: ${targetSessionId}`;
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, targetSessionId);
      const binding = this.makeBinding(
        key,
        targetSessionId,
        existing?.workspace || this.config.workspace.defaultWorkspace
      );
      await this.store.put(binding);
      return [
        "# Resume Session",
        "",
        `- **source**: \`${command.args[0] ? "explicit" : "latest"}\``,
        `- **session**: \`${binding.codexSessionId}\``,
        `- **workspace**: \`${binding.workspace}\``,
        `- **time**: ${session?.createdAt || "(unknown)"}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
    }

    if (command?.name === "sessions") {
      const limit = Math.min(20, Math.max(1, Number(command.args[0] || "8") || 8));
      const sessions = await listRecentSessions(this.config.codex.sessionsDir, limit);
      if (sessions.length === 0) {
        return `No native Codex sessions found under ${this.config.codex.sessionsDir}`;
      }
      const header = [
        "# Native Sessions",
        "",
        "| # | Bound | Session | Time | Cwd | About |",
        "|---|---|---|---|---|---|"
      ];
      const rows = sessions.map((session, index) => {
        const bound = session.sessionId === existing?.codexSessionId ? "yes" : "";
        return `| ${index + 1} | ${bound} | \`${escapeMarkdownCell(session.sessionId)}\` | ${escapeMarkdownCell(session.createdAt || "(unknown)")} | \`${escapeMarkdownCell(session.cwd || "(unknown)")}\` | ${escapeMarkdownCell(session.preview || "")} |`;
      });
      return [...header, ...rows].join("\n");
    }

    const binding = existing;
    if (command?.name === "new") {
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const workspace = binding?.workspace || this.config.workspace.defaultWorkspace;
      const sessionId = await this.codex.createSession(workspace);
      const nextBinding = this.makeBinding(key, sessionId, workspace);
      await this.store.put(nextBinding);
      return [
        "# New Session",
        "",
        `- **session**: \`${sessionId}\``,
        `- **workspace**: \`${nextBinding.workspace}\``
      ].join("\n");
    }

    if (command?.name === "stop") {
      if (!activeRun) {
        return "No active run for this conversation.";
      }
      this.activeRuns.set(key, { ...activeRun, status: "stopping" });
      const stopped = await this.codex.stop(activeRun.runId);
      return stopped
        ? `# Stop Run\n\n- **run**: \`${activeRun.runId}\`\n- **status**: \`stop requested\``
        : "Run already finished before stop completed.";
    }

    if (command?.name === "workspace") {
      const currentWorkspace = binding?.workspace || this.config.workspace.defaultWorkspace;
      if (command.args.length === 0) {
        return `# Workspace\n\n- **workspace**: \`${currentWorkspace}\``;
      }
      if (activeRun) {
        return `Cannot change workspace while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const requested = command.args.join(" ");
      const workspace = await this.resolveWorkspace(requested, currentWorkspace);
      const nextBinding = binding
        ? { ...binding, workspace, updatedAt: new Date().toISOString() }
        : this.makeBinding(key, undefined, workspace);
      await this.store.put(nextBinding);
      return `# Workspace\n\n- **workspace**: \`${workspace}\``;
    }

    if (command?.name === "approvals") {
      if (command.args.length === 0) {
        return [
          "# Approvals",
          "",
          `- **mode**: \`${this.config.codex.sandboxMode}\``,
          "- **choices**: `auto`, `full-access`"
        ].join("\n");
      }
      if (activeRun) {
        return `Cannot change approvals while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextMode = this.parseApprovalMode(command.args.join(" "));
      if (!nextMode) {
        return [
          "# Approvals",
          "",
          `- **error**: unknown mode \`${command.args.join(" ")}\``,
          "- **choices**: `auto`, `full-access`"
        ].join("\n");
      }
      this.config.codex.sandboxMode = nextMode;
      await this.persistJsonSetting("CODEX_SANDBOX_MODE", nextMode);
      return [
        "# Approvals",
        "",
        `- **mode**: \`${nextMode}\``,
        nextMode === "danger-full-access"
          ? "- Codex will use `--dangerously-bypass-approvals-and-sandbox` on new runs."
          : "- Codex will use `--full-auto` on new runs."
      ].join("\n");
    }

    if (activeRun) {
      return [
        "# Active Run",
        "",
        `- **run**: \`${activeRun.runId}\``,
        `- **status**: \`${activeRun.status}\``
      ].join("\n");
    }

    const workspace = binding?.workspace || this.config.workspace.defaultWorkspace;
    const provisionalRunId = `pending:${randomUUID()}`;
    this.activeRuns.set(key, {
      conversationKey: key,
      codexSessionId: binding?.codexSessionId || "(pending)",
      runId: provisionalRunId,
      startedAt: new Date().toISOString(),
      status: "starting"
    });

    try {
      const handle = await this.codex.runTurn(message, binding?.codexSessionId, workspace, {
        onStatus: onUpdate,
        onUpdate
      });
      this.activeRuns.set(key, {
        conversationKey: key,
        codexSessionId: binding?.codexSessionId || "(pending)",
        runId: handle.runId,
        startedAt: new Date().toISOString(),
        status: "running"
      });
      const result = await handle.done;

      const nextBinding =
        binding && binding.codexSessionId === result.sessionId
          ? { ...binding, updatedAt: new Date().toISOString() }
          : this.makeBinding(key, result.sessionId, workspace);
      await this.store.put(nextBinding);
      return this.codex.mode === "terminal" && onUpdate ? "" : result.output;
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private makeBinding(
    conversationKey: string,
    codexSessionId: string | undefined,
    workspace: string
  ): SessionBinding {
    const now = new Date().toISOString();
    return { conversationKey, codexSessionId, workspace, createdAt: now, updatedAt: now };
  }

  private async resolveWorkspace(requested: string, currentWorkspace: string): Promise<string> {
    const resolved = path.resolve(
      requested.startsWith("/")
        ? requested
        : path.resolve(currentWorkspace || this.config.workspace.defaultWorkspace, requested)
    );
    const relative = path.relative(this.config.workspace.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Workspace must stay under ${this.config.workspace.root}`);
    }

    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    return resolved;
  }

  private parseApprovalMode(value: string): AppConfig["codex"]["sandboxMode"] | undefined {
    const normalized = value.trim().toLowerCase();
    if (["auto", "workspace-write", "workspace", "safe"].includes(normalized)) {
      return "workspace-write";
    }
    if (["full-access", "danger-full-access", "danger", "bypass"].includes(normalized)) {
      return "danger-full-access";
    }
    return undefined;
  }

  private async persistJsonSetting(name: string, value: string): Promise<void> {
    if (!this.config.configPath) return;
    const raw = await fs.readFile(this.config.configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed[name] = value;
    await fs.writeFile(this.config.configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }

  private async findMostRecentSessionId(): Promise<string | undefined> {
    const sessions = await listRecentSessions(this.config.codex.sessionsDir, 1);
    return sessions[0]?.sessionId;
  }

  private resumeHelpText(): string {
    return [
      "# Resume",
      "",
      "Resume a previous session.",
      "",
      "## Usage",
      "",
      "- `/resume`",
      "- `/resume <session-id>`",
      "- `/resume -h`",
      "- `/resume --all`",
      "",
      "## Notes",
      "",
      "- `/resume` defaults to the most recent recorded native Codex session.",
      "- `/resume <session-id>` binds a specific native session id.",
      "- Native `codex resume --all` opens an interactive picker showing all sessions and the CWD column.",
      "- In Feishu, use `/sessions [n]` instead of a picker."
    ].join("\n");
  }
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
