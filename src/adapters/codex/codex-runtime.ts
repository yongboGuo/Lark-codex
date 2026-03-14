import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage } from "../../types/domain.js";
import { CodexBackend, CodexRunHandle, CodexTurnResult } from "./backend.js";
import { findSessionFile } from "./session-files.js";

interface ActiveProcess {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
  timeout?: NodeJS.Timeout;
}

const CREATE_SESSION_PROMPT =
  "Initialize a new bridge session. Reply with exactly: READY";

export function createCodexBackend(config: AppConfig["codex"]): CodexBackend {
  if (config.backendMode === "tcl") {
    return new TclCodexBackend(config);
  }
  return new SpawnCodexBackend(config);
}

class SpawnCodexBackend implements CodexBackend {
  readonly mode = "spawn" as const;
  private readonly activeRuns = new Map<string, ActiveProcess>();

  constructor(private readonly config: AppConfig["codex"]) {}

  async createSession(workspace: string): Promise<string> {
    const handle = await this.executeTurn({
      prompt: CREATE_SESSION_PROMPT,
      workspace
    });
    const result = await handle.done;
    return result.sessionId;
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    workspace: string
  ): Promise<CodexRunHandle> {
    return this.executeTurn({
      prompt: input.text,
      workspace,
      sessionId
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
    workspace: string;
    sessionId?: string;
  }): Promise<CodexRunHandle> {
    const runId = randomUUID();
    await ensureWorkspace(params.workspace);

    const args = ["exec", "--json", "--skip-git-repo-check", "--cd", params.workspace];

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
      cwd: params.workspace,
      env: {
        ...process.env,
        CODEX_HOME: this.config.home,
        HOME: process.env.HOME || path.dirname(this.config.home)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const active: ActiveProcess = { child, cancelled: false };
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
    this.activeRuns.set(runId, active);

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      let sessionId = params.sessionId;
      let finalOutput = "";
      let stderr = "";
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (active.timeout) clearTimeout(active.timeout);
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

        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          if (typeof event.item.text === "string") {
            finalOutput = event.item.text;
          }
        }
      });

      const stderrLines = readline.createInterface({ input: child.stderr as Readable });
      stderrLines.on("line", (line) => {
        stderr += `${line}\n`;
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

class TclCodexBackend implements CodexBackend {
  readonly mode = "tcl" as const;

  constructor(private readonly config: AppConfig["codex"]) {
    void this.config;
  }

  async createSession(_workspace: string): Promise<string> {
    throw new Error(
      "CODEX_BACKEND_MODE=tcl is not implemented safely yet. The current Codex interactive CLI is a full-screen TUI without a stable machine protocol. Use CODEX_BACKEND_MODE=spawn."
    );
  }

  async runTurn(
    _input: IncomingMessage,
    _sessionId: string | undefined,
    _workspace: string
  ): Promise<CodexRunHandle> {
    throw new Error(
      "CODEX_BACKEND_MODE=tcl is not implemented safely yet. Use CODEX_BACKEND_MODE=spawn."
    );
  }

  async stop(_runId: string): Promise<boolean> {
    return false;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }
}

async function ensureWorkspace(workspace: string): Promise<void> {
  const stats = await fs.stat(workspace).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }
}

function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
}
