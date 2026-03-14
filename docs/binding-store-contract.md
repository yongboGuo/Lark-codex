# Binding Store Contract

## Design intent

The binding store persists the minimal metadata needed to map a Feishu conversation to a native Codex session.

It exists to answer one question reliably:

> Given a Feishu conversation key, which native Codex session should this message go to?

It must remain small and boring.

It must not:
- become a transcript store
- become a memory system
- store synthetic assistant conversation truth
- duplicate Codex-native session state beyond minimal routing metadata

## Core principle

- **Codex** owns conversation/session truth
- **Binding store** owns only routing metadata
- **Bridge runtime** may keep temporary active-run state separately

## What the binding store persists

Each record should contain only:
- `conversationKey`
- `codexSessionId`
- `project`
- timestamps
- optional small audit metadata if truly useful

## Proposed TypeScript contract

```ts
export interface SessionBinding {
  conversationKey: string;
  codexSessionId: string;
  project: string;
  createdAt: string;
  updatedAt: string;
}

export interface BindingStore {
  get(conversationKey: string): Promise<SessionBinding | null>;
  put(binding: SessionBinding): Promise<void>;
  delete(conversationKey: string): Promise<void>;
  list(): Promise<SessionBinding[]>;
}
```

## Semantics

### `get(conversationKey)`
Returns the current binding for a conversation, or `null` if none exists.

Rules:
- no implicit creation
- no fallback mutation
- a missing binding is a normal state

### `put(binding)`
Creates or replaces the binding for a conversation.

Rules:
- `conversationKey` is unique
- overwrite is allowed and expected for `/new`
- `createdAt` should remain stable if updating an existing record
- `updatedAt` should always refresh on mutation

### `delete(conversationKey)`
Deletes the binding.

Rules:
- should be idempotent
- should not delete native Codex sessions
- binding deletion is metadata-only

### `list()`
Returns all bindings.

Uses:
- debugging
- admin/status tooling
- future repair utilities

## Data rules

### Unique key
There must be only one binding per `conversationKey`.

### No fake session ids
`codexSessionId` must always be a real native Codex session id.

### Project explicitness
`project` must be explicit even if it equals the default project.

This keeps the stored binding self-describing.

## Example record

```json
{
  "conversationKey": "p2p:oc_xxx",
  "codexSessionId": "8f1d2a3b-...",
  "project": "/path/to/project",
  "createdAt": "2026-03-22T03:00:00.000Z",
  "updatedAt": "2026-03-22T03:12:00.000Z"
}
```

## Recommended storage model for v1

For v1, a JSON-backed file store is acceptable.

Example shape:

```json
{
  "bindings": [
    {
      "conversationKey": "p2p:oc_xxx",
      "codexSessionId": "session_123",
      "project": "/path/to/project",
      "createdAt": "2026-03-22T03:00:00.000Z",
      "updatedAt": "2026-03-22T03:12:00.000Z"
    }
  ]
}
```

## v1 implementation guidance

- write the whole file atomically when possible
- create parent directory if missing
- tolerate missing file by returning an empty binding set
- fail clearly on malformed JSON

## Non-goals

The binding store should not keep:
- full message history
- user prompts
- assistant responses
- active run stream logs
- long-term memory facts

## Boundary with active run state

Keep active run state separate.

### Binding store
Persistent, slow-changing metadata:
- conversation key
- session id
- project
- timestamps

### Active run store
Ephemeral execution metadata:
- run id
- startedAt
- current status
- cancellation state

Do not mix them into one record unless there is a very strong reason.

## Failure handling

If persistence fails:
- surface a clear internal error
- do not silently proceed as if binding succeeded
- avoid half-written state where possible

If stored binding points to a missing Codex session:
- that is not a store corruption by itself
- let orchestrator decide whether to report, repair, or replace

## Strong v1 rule

The binding store is only a conversation-key -> native-session binding table.

If it starts storing synthetic transcript state, it is already doing too much.
