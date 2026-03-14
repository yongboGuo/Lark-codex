import path from "node:path";
import { CodexBackend } from "../adapters/codex/backend.js";
import { createCodexBackend } from "../adapters/codex/codex-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, SessionBinding } from "../types/domain.js";

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
      codexBackendMode: this.codex.mode
    });
    if (this.config.codex.profileMode === "personal" && this.codex.mode === "spawn") {
      console.warn(
        "Using CODEX_PROFILE_MODE=personal with spawn backend. This shares ~/.codex with your interactive Codex and may cause instability."
      );
    }
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(async (message) => {
      try {
        const text = await this.handleIncoming(message);
        await this.feishu?.send({
          chatId: message.chatId,
          text,
          replyToMessageId: message.messageId,
          threadId: message.threadId
        });
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

  async handleIncoming(message: IncomingMessage): Promise<string> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const command = parseCommand(message);
    if (command?.name === "help") {
      return [
        "/help - show commands",
        "/status - show current session and run state",
        "/new - create and bind a fresh Codex session",
        "/resume <session-id> - bind an existing Codex session",
        "/stop - stop the current active run",
        "/workspace - show the bound workspace"
      ].join("\n");
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);

    if (command?.name === "status") {
      return existing
        ? [
            `conversation=${key}`,
            `session=${existing.codexSessionId}`,
            `workspace=${existing.workspace}`,
            `backend=${this.codex.mode}`,
            `run=${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}`
          ].join("\n")
        : [
            `conversation=${key}`,
            "session=(none)",
            `workspace=${this.config.workspace.defaultWorkspace}`,
            `backend=${this.codex.mode}`,
            `run=${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}`
          ].join("\n");
    }

    if (command?.name === "resume") {
      if (activeRun) {
        return `Cannot resume while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const targetSessionId = command.args[0] || existing?.codexSessionId;
      if (!targetSessionId) {
        return "No bound session to resume. Use /resume <session-id>.";
      }
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return `session not found: ${targetSessionId}`;
      }
      const binding = this.makeBinding(key, targetSessionId, existing?.workspace || this.config.workspace.defaultWorkspace);
      await this.store.put(binding);
      return `resumed session=${binding.codexSessionId}\nworkspace=${binding.workspace}`;
    }

    if (command?.name === "new") {
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const sessionId = await this.codex.createSession(this.config.workspace.defaultWorkspace);
      const binding = this.makeBinding(key, sessionId, this.config.workspace.defaultWorkspace);
      await this.store.put(binding);
      return `new session created\nsession=${sessionId}\nworkspace=${binding.workspace}`;
    }

    if (command?.name === "stop") {
      if (!activeRun) {
        return "No active run for this conversation.";
      }
      this.activeRuns.set(key, { ...activeRun, status: "stopping" });
      const stopped = await this.codex.stop(activeRun.runId);
      return stopped
        ? `stop requested for run=${activeRun.runId}`
        : "Run already finished before stop completed.";
    }

    const binding = existing;
    if (command?.name === "workspace") {
      return `workspace=${binding?.workspace || this.config.workspace.defaultWorkspace}`;
    }

    if (activeRun) {
      return `A run is already active for this conversation.\nrun=${activeRun.runId}\nstatus=${activeRun.status}`;
    }

    const workspace = binding?.workspace || this.config.workspace.defaultWorkspace;
    const handle = await this.codex.runTurn(message, binding?.codexSessionId, workspace);
    this.activeRuns.set(key, {
      conversationKey: key,
      codexSessionId: binding?.codexSessionId || "(pending)",
      runId: handle.runId,
      startedAt: new Date().toISOString(),
      status: "running"
    });

    try {
      const result = await handle.done;

      const nextBinding =
        binding && binding.codexSessionId === result.sessionId
          ? { ...binding, updatedAt: new Date().toISOString() }
          : this.makeBinding(key, result.sessionId, workspace);
      await this.store.put(nextBinding);
      return result.output;
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private makeBinding(conversationKey: string, codexSessionId: string, workspace: string): SessionBinding {
    const now = new Date().toISOString();
    return { conversationKey, codexSessionId, workspace, createdAt: now, updatedAt: now };
  }
}
