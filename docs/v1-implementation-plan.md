# V1 Implementation Plan

## Goal

Deliver a first working version of `codex-feishu-bridge` that:

- receives Feishu DM text messages
- binds each DM conversation to a real native Codex session
- sends user input into Codex
- returns Codex output to Feishu
- supports a minimal command set
- does not introduce a second conversation/session truth layer

## V1 success criteria

A v1 build is successful when all of the following work:

1. Feishu bot can receive a DM text message.
2. The bridge normalizes it and resolves a conversation key.
3. If no binding exists, the bridge creates a real native Codex session.
4. If a binding exists, the bridge resumes that native Codex session.
5. The bridge sends the user turn to Codex.
6. The bridge returns a visible reply to Feishu.
7. `/status` reports the bound native session id and workspace.
8. `/new` creates and rebinds a fresh native Codex session.
9. `/stop` cancels the active run without deleting the binding.

## Explicit non-goals for v1

- group-chat support as a first-class path
- rich interactive card UX as a requirement
- image/file input support
- multi-provider backend support
- long-term memory features
- synthetic transcript storage
- multi-run parallelism per conversation

## Build order

## Phase 1 — foundation

### 1. Environment + config
Implement:
- env loading
- required config validation
- workspace root restriction
- Feishu credentials config
- Codex binary/home/session path config

Deliverables:
- `src/config/env.ts`
- startup validation with clear errors

### 2. Domain types and boundaries
Implement/refine:
- inbound Feishu message type
- outbound Feishu message type
- session binding type
- active run state type
- Codex adapter interfaces

Deliverables:
- `src/types/`
- contracts reflected in code, not only docs

## Phase 2 — persistence and routing core

### 3. Binding store
Implement:
- persistent binding store
- get/put/list operations
- simple JSON-backed storage first

Rules:
- store only minimal binding metadata
- do not store synthetic transcript history

Deliverables:
- `src/store/binding-store.ts`

### 4. Conversation resolver
Implement:
- p2p conversation key policy
- thread-aware structure for future extension
- reply context extraction

Deliverables:
- `src/core/conversation-resolver.ts`

### 5. Command parser + dispatcher
Implement:
- `/help`
- `/status`
- `/new`
- `/resume` (minimal/latest-bound version for v1)
- `/stop`
- `/workspace`

Deliverables:
- `src/core/command-dispatcher.ts`

## Phase 3 — Codex side

### 6. Real Codex adapter (non-streaming first)
Implement:
- create native session
- resume native session
- send one turn
- capture final output
- stop active run

Recommendation:
- start with the simplest reliable Codex integration path
- if possible, preserve native session ids directly

Deliverables:
- `src/adapters/codex/codex-adapter.ts`
- `src/adapters/codex/codex-process.ts`
- `src/adapters/codex/codex-session-registry.ts`

### 7. Active run coordinator
Implement:
- one-run-per-conversation enforcement
- run start/finish bookkeeping
- stop targeting by conversation key

Deliverables:
- `src/core/run-coordinator.ts`

## Phase 4 — Feishu side

### 8. Feishu adapter (DM text only first)
Implement:
- websocket connection
- inbound event parsing
- dedup by event/message id
- outbound text reply sending

Recommendation:
- start with plain text replies
- do not make cards mandatory in v1

Deliverables:
- `src/adapters/feishu/feishu-adapter.ts`
- `src/adapters/feishu/feishu-ws-client.ts`
- `src/adapters/feishu/feishu-event-parser.ts`
- `src/adapters/feishu/feishu-sender.ts`

## Phase 5 — orchestration

### 9. Core orchestrator
Implement:
- inbound handling
- command vs turn routing
- binding resolution / creation
- Codex invocation
- Feishu reply projection
- error propagation

Deliverables:
- `src/core/orchestrator.ts`
- `src/core/event-projector.ts`

### 10. App entrypoint
Wire together:
- config
- Feishu adapter
- Codex adapter
- stores
- orchestrator

Deliverables:
- `src/index.ts`

## Phase 6 — streaming and polish

### 11. Streaming output
Add:
- partial output forwarding from Codex events
- readable chunking policy
- final output consolidation

V1 allowance:
- if streaming is unstable, final-output-only mode is acceptable first

### 12. Basic operational hardening
Add:
- startup health check
- clear logging
- explicit error messages
- restart-safe binding loading
- proxy-env handling if needed

## Minimal testing plan

## Manual tests

### Test 1 — first DM creates session
- send a normal DM message
- verify a native Codex session is created
- verify binding is persisted
- verify reply comes back to Feishu

### Test 2 — follow-up reuses session
- send another DM in same conversation
- verify same native session id is reused
- verify `/status` shows same session id

### Test 3 — `/new`
- send `/new`
- verify a different native session id is created
- verify binding is replaced

### Test 4 — `/stop`
- trigger a longer run
- send `/stop`
- verify active run is cancelled
- verify session binding remains intact

### Test 5 — restart resilience
- restart the bridge
- send `/status`
- verify stored binding survives restart

### Test 6 — bad config
- remove one required env value
- verify startup fails clearly and early

## Suggested implementation sequence

1. make config and types strict
2. make binding store real
3. make real Codex adapter work locally from CLI/manual invocation
4. make orchestrator work against a local fake Feishu adapter
5. swap in real Feishu websocket adapter
6. add `/status`, `/new`, `/stop`
7. add streaming
8. harden logs and restart behavior

## V1 exit criteria

V1 is done when:
- DM text in/out works reliably
- native Codex session ids are preserved and visible via `/status`
- no synthetic conversation replay is used
- one-run-per-conversation policy is enforced
- restart does not destroy existing bindings
- common failure modes are user-visible and understandable

## After v1

Reasonable next steps:
- group thread support
- image/file passthrough
- better streaming UX
- workspace switching with guardrails
- optional cards for `/help` and `/status`
- more robust session discovery for `/resume`
