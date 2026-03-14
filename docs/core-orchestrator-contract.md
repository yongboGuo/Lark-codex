# Core Orchestrator Contract

## Design intent

The core orchestrator is the bridge center.

It connects:
- the **Feishu adapter** on the transport side
- the **Codex adapter** on the runtime side
- the **binding store** on the persistence side

Its job is to:
1. receive normalized inbound messages
2. resolve the target conversation key and binding
3. decide whether the input is a control command or a Codex-bound user turn
4. invoke the right Codex session/run operation
5. project progress and final output back through Feishu

It must not:
- become a second assistant platform
- store synthetic conversation truth
- re-interpret Codex session identity
- hide session/run semantics behind vague abstractions

## Core principle

- **Feishu** provides transport metadata and presentation
- **Codex** provides native conversation truth and execution
- **Orchestrator** provides routing, binding resolution, and lifecycle control

## Responsibilities

### Owns
- conversation key resolution
- command routing
- binding lookup and update
- active-run coordination
- mapping Codex stream events to Feishu outputs
- failure propagation to user-visible replies

### Does not own
- raw Feishu transport lifecycle
- native Codex session implementation details
- full conversation history as truth
- long-term memory or knowledge system

## Proposed TypeScript contract

```ts
export interface Orchestrator {
  handleInbound(message: FeishuInboundMessage): Promise<void>;
}

export interface ConversationResolver {
  resolve(message: FeishuInboundMessage): ConversationResolution;
}

export interface ConversationResolution {
  conversationKey: string;
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
}

export interface CommandDecision {
  kind: "command" | "turn";
  command?: "help" | "status" | "new" | "resume" | "stop" | "project";
  args?: string[];
}

export interface ActiveRunCoordinator {
  get(conversationKey: string): Promise<ActiveRunState | null>;
  start(run: ActiveRunState): Promise<void>;
  finish(conversationKey: string): Promise<void>;
  markStopping(conversationKey: string): Promise<void>;
}

export interface BindingRepository {
  get(conversationKey: string): Promise<SessionBinding | null>;
  put(binding: SessionBinding): Promise<void>;
  delete?(conversationKey: string): Promise<void>;
  list?(): Promise<SessionBinding[]>;
}
```

## Main flow

### 1. Receive inbound message
The orchestrator receives a normalized `FeishuInboundMessage` from the Feishu adapter.

### 2. Resolve conversation identity
The orchestrator computes a stable `conversationKey`.

Initial policy:
- p2p -> `p2p:<chat_id>`
- group thread -> `group:<chat_id>:thread:<thread_id>`
- group non-thread -> later / restricted

### 3. Decide command vs turn
The orchestrator parses the input:
- `/help` `/status` `/new` `/resume` `/stop` `/project` -> command path
- everything else -> Codex turn path

### 4. Resolve or create binding
For non-command turns:
- if binding exists -> resume that native Codex session
- if binding does not exist -> create a new native Codex session and persist binding

For `/new`:
- explicitly create a new native Codex session
- replace current binding for the conversation

### 5. Coordinate active run state
Only one active run should exist per conversation key unless later design explicitly allows otherwise.

Rules:
- if a run is already active, reject or queue clearly
- `/stop` targets the active run for that conversation
- active run state is runtime metadata only, not conversation truth

### 6. Relay Codex events to Feishu
The orchestrator consumes `CodexStreamEvent` and maps them to Feishu output:
- `run.started` -> optional typing/status signal
- `assistant.delta` -> optional stream update
- `assistant.message` -> textual progress/final chunk
- `run.completed` -> final reply
- `run.failed` -> clear error reply
- `run.cancelled` -> clear cancellation reply

### 7. Finalize run state
On terminal event:
- clear active run state
- preserve session binding unless command semantics say otherwise

## Command semantics

### `/help`
Return supported commands and short usage.

### `/status`
Return:
- conversation key
- native Codex session id if bound
- project
- active run state if any

### `/new`
Create a fresh native Codex session and replace current binding.

### `/resume`
Reconnect to a known native Codex session.
Initial v1 may support:
- latest bound session only
- explicit session id later

### `/stop`
Stop the current active run for the conversation.
Do not delete the session binding.

### `/project`
Show current project.
Later may support controlled switching within configured root.

## Strong v1 policies

### 1. One conversation -> one native Codex session
Unless user explicitly uses `/new` or `/resume`.

### 2. One conversation -> one active run at a time
No hidden parallelism in v1.

### 3. No synthetic conversation replay
If no native session exists, create one.
If resume fails, report it clearly.

### 4. No hidden fallback session creation on resume failure
Resume errors should remain explicit.

## Error model

The orchestrator should turn internal failures into user-visible, bounded errors.

Examples:
- project invalid
- no active run to stop
- bound session missing in Codex
- Codex launch failure
- transport send failure

Principle:
- fail clearly
- do not silently switch semantics
- do not fake successful continuity

## Suggested implementation split

### `conversation-resolver.ts`
Resolves normalized Feishu message -> conversation key and reply context.

### `command-dispatcher.ts`
Parses and routes commands.

### `binding-service.ts`
Gets/puts binding records.

### `run-coordinator.ts`
Tracks active runs and enforces one-run-per-conversation policy.

### `event-projector.ts`
Maps Codex stream events into Feishu outbound messages.

### `orchestrator.ts`
Top-level coordination of the whole flow.

## Boundary rules

### Feishu adapter boundary
The Feishu adapter may know:
- event ids
- message ids
- reply threading metadata

The orchestrator may use those for routing/presentation, but Feishu remains transport only.

### Codex adapter boundary
The Codex adapter may know:
- native session ids
- run ids
- runtime stream events

The orchestrator may bind and project those, but must not redefine them.

## Minimal persistence model

The orchestrator depends on two small stores.

### Binding store
Persistent:
- conversation key -> native Codex session id
- project
- timestamps

### Active run store
Ephemeral or lightly persisted:
- conversation key -> active run id
- native session id
- status
- timestamps

## Non-goals

The orchestrator should not grow into:
- a general workflow engine
- a memory layer
- a plugin shell
- a multi-agent runtime

## Strong v1 rule

The orchestrator is a router and lifecycle coordinator, not a second brain.

Codex remains the only conversation/execution brain in the system.
