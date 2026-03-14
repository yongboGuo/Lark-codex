import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import pty from "node-pty";
import xterm from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage } from "../../types/domain.js";
import {
  CodexBackend,
  CodexRunHandle,
  CodexRunHooks,
  CodexTurnOptions,
  CodexTurnResult
} from "./backend.js";
import { findSessionFile } from "./session-files.js";
import {
  hasPrompt,
  normalizeTerminalDelta,
  renderTerminalForFeishu
} from "./terminal-normalizer.js";

interface ActiveProcess {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
  timeout?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

const CREATE_SESSION_PROMPT =
  "Initialize a new bridge session. Reply with exactly: READY";
const STREAMED_OUTPUT_DEDUPE_WINDOW = 4;

export function createCodexBackend(config: AppConfig["codex"]): CodexBackend {
  const spawnBackend = new SpawnCodexBackend(config);
  if (config.backendMode === "terminal") {
    return new TerminalCodexBackend(config, spawnBackend);
  }
  return spawnBackend;
}

class SpawnCodexBackend implements CodexBackend {
  readonly mode = "spawn" as const;
  private readonly activeRuns = new Map<string, ActiveProcess>();

  constructor(private readonly config: AppConfig["codex"]) {}

  async createSession(project: string, options?: CodexTurnOptions): Promise<string> {
    const handle = await this.executeTurn({
      prompt: CREATE_SESSION_PROMPT,
      project,
      options
    });
    const result = await handle.done;
    return result.sessionId;
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle> {
    return this.executeTurn({
      prompt: input.text,
      project,
      sessionId,
      options,
      hooks
    });
  }

  async stop(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    if (active.timeout) clearTimeout(active.timeout);
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (!active.child.killed) {
        active.child.kill("SIGKILL");
      }
    }, 2_000).unref();
    return true;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }

  private async executeTurn(params: {
    prompt: string;
    project: string;
    sessionId?: string;
    options?: CodexTurnOptions;
    hooks?: CodexRunHooks;
  }): Promise<CodexRunHandle> {
    const runId = randomUUID();
    await ensureProject(params.project);

    const args = ["exec", "--json", "--skip-git-repo-check", "--cd", params.project];

    if (params.options?.searchEnabled) {
      args.push("--search");
    }
    if (params.options?.model) {
      args.push("-m", params.options.model);
    }
    if (params.options?.profile) {
      args.push("-p", params.options.profile);
    }

    if (this.config.sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--full-auto");
    }

    if (params.sessionId) {
      args.push("resume", params.sessionId, params.prompt);
    } else {
      args.push(params.prompt);
    }

    const child = spawn(this.config.bin, args, {
      cwd: params.project,
      env: {
        ...process.env,
        CODEX_HOME: this.config.home,
        HOME: process.env.HOME || path.dirname(this.config.home)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const active: ActiveProcess = { child, cancelled: false };
    void params.hooks?.onStatus?.(
      params.sessionId ? `resuming Codex session ${params.sessionId}...` : "starting a new Codex session..."
    );
    if (this.config.runTimeoutMs > 0) {
      active.timeout = setTimeout(() => {
        active.cancelled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 2_000).unref();
      }, this.config.runTimeoutMs);
      active.timeout.unref();
    }
    if (this.config.spawnStatusIntervalMs > 0) {
      active.heartbeat = setInterval(() => {
        void params.hooks?.onStatus?.(`Codex is still working...\nrun=${runId}`);
      }, this.config.spawnStatusIntervalMs);
      active.heartbeat.unref();
    }
    this.activeRuns.set(runId, active);

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      let sessionId = params.sessionId;
      let finalOutput = "";
      let stderr = "";
      let settled = false;
      let lastStreamedOutput = "";
      const streamedOutputs: string[] = [];

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (active.timeout) clearTimeout(active.timeout);
        if (active.heartbeat) clearInterval(active.heartbeat);
        this.activeRuns.delete(runId);
        fn();
      };

      const stdoutLines = readline.createInterface({ input: child.stdout as Readable });
      stdoutLines.on("line", (line) => {
        const event = parseJsonLine(line);
        if (!event) return;

        if (typeof event.thread_id === "string" && !sessionId) {
          sessionId = event.thread_id;
          return;
        }

        if (event.type === "turn.started") {
          void params.hooks?.onStatus?.("Codex is thinking...");
          return;
        }

        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          if (typeof event.item.text === "string") {
            finalOutput = event.item.text;
            const normalized = event.item.text.trim();
            if (
              normalized &&
              event.item.text !== lastStreamedOutput &&
              !streamedOutputs.includes(normalized)
            ) {
              lastStreamedOutput = event.item.text;
              streamedOutputs.push(normalized);
              if (streamedOutputs.length > STREAMED_OUTPUT_DEDUPE_WINDOW) {
                streamedOutputs.shift();
              }
              void params.hooks?.onUpdate?.(event.item.text);
            }
          }
        }
      });

      const stderrLines = readline.createInterface({ input: child.stderr as Readable });
      stderrLines.on("line", (line) => {
        stderr += `${line}\n`;
        if (line.includes("failed to connect to websocket")) {
          void params.hooks?.onStatus?.("Codex upstream websocket failed, retrying...");
        }
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("close", (code, signal) => {
        stdoutLines.close();
        stderrLines.close();

        if (!sessionId) {
          finish(() => reject(new Error("Codex did not emit a session id.")));
          return;
        }
        const resolvedSessionId = sessionId;

        if (active.cancelled || signal === "SIGTERM" || signal === "SIGKILL") {
          finish(() =>
            resolve({
              runId,
              sessionId: resolvedSessionId,
              output: finalOutput || "Run cancelled or timed out.",
              status: "cancelled"
            })
          );
          return;
        }

        if (code !== 0) {
          finish(() =>
            reject(
              new Error(
                stderr.trim() ||
                  `Codex exited with code ${code ?? "unknown"} for session ${resolvedSessionId}`
              )
            )
          );
          return;
        }

        finish(() =>
          resolve({
            runId,
            sessionId: resolvedSessionId,
            output: finalOutput || "Codex completed without a final message.",
            status: "completed"
          })
        );
      });
    });

    return { runId, done };
  }
}

class TerminalCodexBackend implements CodexBackend {
  readonly mode = "terminal" as const;
  private readonly terminals = new Map<string, TerminalSession>();

  constructor(
    private readonly config: AppConfig["codex"],
    private readonly spawnBackend: SpawnCodexBackend
  ) {}

  async createSession(project: string, options?: CodexTurnOptions): Promise<string> {
    return this.spawnBackend.createSession(project, options);
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle> {
    const resolvedSessionId = sessionId || (await this.createSession(project, options));
    const runId = randomUUID();
    const done = (async () => {
      await hooks?.onStatus?.("starting terminal session...");
      const terminal = await this.getOrCreateTerminal(resolvedSessionId, project);
      const handle = terminal.runTurn(input.text, runId, hooks);
      return handle.done;
    })();
    return { runId, done };
  }

  async stop(runId: string): Promise<boolean> {
    for (const terminal of this.terminals.values()) {
      if (terminal.currentRunId === runId) {
        await terminal.stop();
        return true;
      }
    }
    return false;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }

  private async getOrCreateTerminal(sessionId: string, project: string): Promise<TerminalSession> {
    const existing = this.terminals.get(sessionId);
    if (existing && existing.isAlive()) {
      await existing.ready();
      return existing;
    }
    if (existing) {
      this.terminals.delete(sessionId);
    }

    const terminal = new TerminalSession({
      codex: this.config,
      sessionId,
      project
    });
    this.terminals.set(sessionId, terminal);
    try {
      await terminal.ready();
      return terminal;
    } catch (error) {
      this.terminals.delete(sessionId);
      throw error;
    }
  }
}

interface TerminalSessionOptions {
  codex: AppConfig["codex"];
  sessionId: string;
  project: string;
}

class TerminalSession {
  readonly sessionId: string;
  readonly project: string;
  currentRunId?: string;

  private readonly ptyProcess: pty.IPty;
  private readonly emulator: InstanceType<typeof xterm.Terminal>;
  private rawBuffer = "";
  private alive = true;
  private startupDone = false;
  private startupPromise: Promise<void>;
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private pending?: PendingTerminalRun;
  private startupChunkCount = 0;

  constructor(private readonly options: TerminalSessionOptions) {
    this.sessionId = options.sessionId;
    this.project = options.project;

    this.startupPromise = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });

    const args = ["--no-alt-screen", "--cd", this.project];
    if (this.options.codex.sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--full-auto");
    }
    args.push("resume", this.sessionId);

    this.ptyProcess = pty.spawn(this.options.codex.bin, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd: this.project,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codex.home,
        HOME: process.env.HOME || path.dirname(this.options.codex.home)
      }
    });
    this.emulator = new xterm.Terminal({
      cols: 100,
      rows: 28,
      allowProposedApi: true
    });
    this.emulator.onData((data) => {
      this.ptyProcess.write(data);
    });

    this.ptyProcess.onData((chunk) => {
      this.emulator.write(chunk);
      this.rawBuffer += chunk;
      this.startupChunkCount += 1;

      if (!this.startupDone && this.promptVisible()) {
        this.startupDone = true;
        this.logStartupDebug("ready");
        this.startupResolve();
      }

      if (this.pending) {
        if (this.pending.idleTimer) clearTimeout(this.pending.idleTimer);
        this.pending.idleTimer = setTimeout(
          () => this.tryResolvePending(),
          this.options.codex.terminalFlushIdleMs
        );
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.alive = false;
      const error = new Error(
        `Terminal Codex session exited (code=${exitCode}, signal=${signal}) for session ${this.sessionId}`
      );
      if (!this.startupDone) {
        this.startupReject(error);
      }
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        if (pending.idleTimer) clearTimeout(pending.idleTimer);
        pending.reject(error);
      }
    });

    setTimeout(() => {
      if (!this.startupDone) {
        this.logStartupDebug("timeout");
        this.startupReject(
          new Error(`Timed out waiting for interactive Codex terminal startup: ${this.sessionId}`)
        );
      }
    }, this.options.codex.terminalStartupTimeoutMs).unref();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async ready(): Promise<void> {
    await this.startupPromise;
  }

  runTurn(prompt: string, runId: string, hooks?: CodexRunHooks): CodexRunHandle {
    if (this.pending) {
      throw new Error(`Terminal session ${this.sessionId} is already busy.`);
    }

    this.currentRunId = runId;
    const marker = this.rawBuffer.length;
    const baselineScreen = this.visibleScreenText();

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      this.pending = {
        runId,
        prompt,
        marker,
        baselineScreen,
        hooks,
        lastOutput: "",
        resolve: (result) => {
          this.currentRunId = undefined;
          resolve(result);
        },
        reject: (error) => {
          this.currentRunId = undefined;
          reject(error);
        }
      };
      // Clear any draft text or suggested slash command left in the input line.
      this.ptyProcess.write("\u0015");
      this.ptyProcess.write(prompt);
      this.ptyProcess.write("\r\n");
    });

    return { runId, done };
  }

  async stop(): Promise<void> {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.idleTimer) clearTimeout(pending.idleTimer);
      this.ptyProcess.write("\u0003");
      pending.resolve({
        runId: pending.runId,
        sessionId: this.sessionId,
        output: formatTerminalOutput("Run cancelled.", this.options.codex.terminalRenderMode),
        status: "cancelled"
      });
    }
    this.ptyProcess.kill();
    this.emulator.dispose();
    this.alive = false;
  }

  private tryResolvePending(): void {
    if (!this.pending) return;
    const pending = this.pending;
    const rawDelta = this.rawBuffer.slice(pending.marker);
    const deltaSnapshot = normalizeTerminalDelta(rawDelta, pending.prompt);
    const screenDelta = stripScreenPrefix(this.visibleScreenText(), pending.baselineScreen);
    const screenSnapshot = normalizeTerminalDelta(screenDelta, pending.prompt);
    const snapshot = deltaSnapshot.cleaned ? deltaSnapshot : screenSnapshot.cleaned ? screenSnapshot : deltaSnapshot;
    if (!snapshot.cleaned) return;
    const rendered = limitTerminalOutput(
      renderTerminalForFeishu(snapshot, this.options.codex.terminalRenderMode),
      this.options.codex.terminalFlushMaxChars
    );

    if (rendered !== pending.lastOutput) {
      pending.lastOutput = rendered;
      void pending.hooks?.onUpdate?.(rendered);
    }

    if (!snapshot.hasPrompt && !this.promptVisible()) return;

    this.pending = undefined;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.resolve({
      runId: pending.runId,
      sessionId: this.sessionId,
      output: rendered,
      status: "completed"
    });
  }

  private cleanedTail(): string {
    return simplifyTerminalBytes(this.rawBuffer.slice(-8000));
  }

  private visibleScreenText(): string {
    const lines: string[] = [];
    const buffer = this.emulator.buffer.active;
    const total = Math.min(this.emulator.rows + 20, buffer.length);
    const start = Math.max(0, buffer.length - total);
    for (let y = start; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  private promptVisible(): boolean {
    return hasPrompt(this.visibleScreenText()) || hasPrompt(this.cleanedTail());
  }

  private logStartupDebug(reason: "ready" | "timeout"): void {
    const visible = this.visibleScreenText().trim();
    const cleanedTail = normalizeWhitespaceForLog(this.cleanedTail());
    const rawTail = escapeControlForLog(this.rawBuffer.slice(-4000));
    const rawHead = escapeControlForLog(this.rawBuffer.slice(0, 1200));

    console.warn("terminal startup debug", {
      reason,
      sessionId: this.sessionId,
      project: this.project,
      startupDone: this.startupDone,
      startupChunkCount: this.startupChunkCount,
      rawBytes: this.rawBuffer.length,
      hasPromptInCleanedTail: hasPrompt(this.cleanedTail()),
      hasPromptInVisibleScreen: hasPrompt(this.visibleScreenText()),
      cleanedTail,
      visibleScreen: visible || "(empty)",
      rawHead,
      rawTail
    });
  }
}

interface PendingTerminalRun {
  runId: string;
  prompt: string;
  marker: number;
  baselineScreen: string;
  idleTimer?: NodeJS.Timeout;
  hooks?: CodexRunHooks;
  lastOutput: string;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

async function ensureProject(project: string): Promise<void> {
  const stats = await fs.stat(project).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Project does not exist: ${project}`);
  }
}

function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function formatTerminalOutput(text: string, mode: "markdown" | "plain"): string {
  if (mode === "plain") return text || "(no clean terminal output)";
  return ["**Codex Terminal**", "```text", text || "(no clean terminal output)", "```"].join("\n");
}

function limitTerminalOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const suffix = "\n\n[terminal output truncated]";
  const budget = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, budget).trimEnd()}${suffix}`;
}

function normalizeWhitespaceForLog(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n").trim();
}

function escapeControlForLog(text: string): string {
  return text
    .replace(/\u001b/g, "\\u001b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n\n");
}

function simplifyTerminalBytes(text: string): string {
  return stripAnsi(text)
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function stripScreenPrefix(current: string, baseline: string): string {
  const currentLines = current.split("\n");
  const baselineLines = baseline.split("\n");
  let idx = 0;
  while (idx < currentLines.length && idx < baselineLines.length && currentLines[idx] === baselineLines[idx]) {
    idx += 1;
  }
  return currentLines.slice(idx).join("\n");
}
