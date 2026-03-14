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

export interface CodexBackend {
  readonly mode: "spawn" | "tcl";
  createSession(workspace: string): Promise<string>;
  runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    workspace: string
  ): Promise<CodexRunHandle>;
  stop(runId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<boolean>;
}
