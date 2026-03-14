# Codex Adapter Contract

## Design intent

The Codex adapter is a thin wrapper around native Codex session operations.

It answers only these questions:

1. How to create a native Codex session
2. How to resume an existing native Codex session
3. How to send one new user turn into that session
4. How to stream events/output while it runs
5. How to stop or cancel the current run safely

It must not:

- invent fake session continuity
- store synthetic transcript state as the source of truth
- become a second orchestration layer above Codex

## Core principle

- **Codex native session** = conversation source of truth
- **Bridge binding store** = routing metadata only
- **Feishu** = control surface and presentation layer

## Proposed TypeScript contract

```ts
export type CodexSessionId = string;
export type CodexRunId = string;

export interface CodexSessionRef {
  sessionId: CodexSessionId;
  workspace: string;
}

export interface CodexCreateSessionInput {
  workspace: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexResumeSessionInput {
  sessionId: CodexSessionId;
  workspace: string;
}

export interface CodexAttachment {
  kind: "image" | "file";
  path: string;
  mimeType?: string;
  name?: string;
}

export interface CodexTurnInput {
  sessionId: CodexSessionId;
  workspace: string;
  userText: string;
  attachments?: CodexAttachment[];
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export type CodexStreamEvent =
  | { type: "run.started"; runId: CodexRunId; sessionId: CodexSessionId }
  | { type: "run.stdout"; runId: CodexRunId; chunk: string }
  | { type: "run.stderr"; runId: CodexRunId; chunk: string }
  | { type: "assistant.delta"; runId: CodexRunId; text: string }
  | { type: "assistant.message"; runId: CodexRunId; text: string }
  | { type: "tool.started"; runId: CodexRunId; name: string; detail?: string }
  | { type: "tool.finished"; runId: CodexRunId; name: string; detail?: string }
  | { type: "run.completed"; runId: CodexRunId; sessionId: CodexSessionId; finalText: string }
  | { type: "run.failed"; runId: CodexRunId; sessionId: CodexSessionId; error: string }
  | { type: "run.cancelled"; runId: CodexRunId; sessionId: CodexSessionId };

export interface CodexRunHandle {
  runId: CodexRunId;
  sessionId: CodexSessionId;
  cancel(): Promise<void>;
  done: Promise<CodexFinalResult>;
}

export interface CodexFinalResult {
  runId: CodexRunId;
  sessionId: CodexSessionId;
  status: "completed" | "failed" | "cancelled";
  finalText?: string;
  error?: string;
}

export interface CodexAdapter {
  createSession(input: CodexCreateSessionInput): Promise<CodexSessionRef>;
  resumeSession(input: CodexResumeSessionInput): Promise<CodexSessionRef>;
  runTurn(
    input: CodexTurnInput,
    onEvent: (event: CodexStreamEvent) => Promise<void> | void
  ): Promise<CodexRunHandle>;
  stopRun(runId: CodexRunId): Promise<void>;
  getSession(sessionId: CodexSessionId): Promise<CodexSessionRef | null>;
}
```

## Method semantics

### `createSession(input)`

Creates a **real native Codex session**.

Rules:
- must return a real Codex session id
- must not create a bridge-only fake session id
- workspace must be explicit

### `resumeSession(input)`

Reattaches to an existing native Codex session.

Rules:
- if session does not exist, fail clearly
- do not silently create a new session
- do not replay message history to simulate resume

### `runTurn(input, onEvent)`

Sends one new user turn into a native Codex session and streams events while it runs.

Rules:
- one call = one turn against one native session
- emit structured stream events, not just a final blob
- terminal state must always resolve `done`

### `stopRun(runId)`

Stops the active run only.

Rules:
- stop the run, not delete the session
- if already finished, be harmless / idempotent

### `getSession(sessionId)`

Checks whether a native session exists and is referenceable.

Useful for:
- validating bindings
- `/status`
- repair or debugging flows later

## Session vs run

Keep this distinction explicit:

- **session** = long-lived Codex conversation identity
- **run** = one active execution/turn inside that session

Implications:
- one Feishu conversation binds to one Codex **session**
- `/stop` targets the current **run**
- `/new` creates a fresh **session**

## Minimum event model for v1

If needed, v1 can start with a reduced stream shape:

```ts
type CodexStreamEvent =
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | { type: "assistant.message"; runId: string; text: string }
  | { type: "run.completed"; runId: string; sessionId: string; finalText: string }
  | { type: "run.failed"; runId: string; sessionId: string; error: string }
  | { type: "run.cancelled"; runId: string; sessionId: string };
```

That is enough for:
- progress indication
- streaming assistant text
- final answer delivery
- failure and cancellation handling

Tool-level stream events can be added later.

## Bridge persistence rules

The bridge may store only minimal metadata like:

```ts
interface SessionBinding {
  conversationKey: string;
  codexSessionId: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
}

interface ActiveRunState {
  conversationKey: string;
  runId: string;
  codexSessionId: string;
  startedAt: string;
  status: "running" | "stopping";
}
```

The bridge should not store:
- full synthetic transcript as session truth
- bridge-generated fake session ids
- replayable assistant history used to mimic continuity

## Failure semantics

### Create / resume failures

Return clear hard errors for cases like:
- session not found
- invalid workspace
- Codex binary unavailable
- launch timeout

### Turn failures

Emit `run.failed` with a useful message:
- startup failure
- process exit
- parse failure
- timeout
- terminal tool/runtime failure

### Cancellation

If the user sends `/stop`:
- adapter attempts to cancel the active run
- terminal state must become `run.cancelled` or `run.completed`
- no silent disappearance

## Suggested implementation split

To keep the bridge clean, split the implementation into:

### `codex-process.ts`
Low-level process spawning and stdout/stderr handling.

### `codex-session-registry.ts`
Maps active `runId` to child process state and cancellation hooks.

### `codex-event-parser.ts`
Converts raw Codex output into structured stream events.

### `codex-adapter.ts`
Implements the public `CodexAdapter` contract.

## Backend control modes

There are two likely implementation modes.

### Mode A — CLI process wrapping

The bridge shells out to Codex CLI directly.

Pros:
- simpler start
- fewer moving parts

Cons:
- more brittle if CLI output changes
- weaker introspection and control

### Mode B — structured backend interface

The bridge talks to a more structured Codex backend/app-server session interface.

Pros:
- cleaner semantics for session, run, stop, resume
- less parsing fragility

Cons:
- more setup and dependency on backend support

## Recommendation

If a reliable structured Codex backend exists, prefer it.
Otherwise start with CLI wrapping, but preserve this contract so the internals can be swapped later.

## Strong v1 rule

Every bridge-visible session id must be a **real Codex session id**.

Internal IDs are acceptable only for:
- run tracking
- locks
- dedup

They must not replace native Codex session identity.
