import { IncomingMessage } from "../../types/domain.js";

export interface CodexTurnResult {
  runId: string;
  sessionId: string;
  output: string;
  status: "completed" | "cancelled";
}

export interface CodexRunHandle {
  runId: string;
  done: Promise<CodexTurnResult>;
}

export interface CodexRunHooks {
  onStatus?: (text: string) => Promise<void> | void;
  onUpdate?: (text: string) => Promise<void> | void;
}

export interface CodexBackend {
  readonly mode: "spawn" | "terminal";
  createSession(workspace: string): Promise<string>;
  runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    workspace: string,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle>;
  stop(runId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<boolean>;
}
