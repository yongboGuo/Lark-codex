# Message and Session Model

## Principle

A Feishu conversation maps to a native Codex session.

## Initial mapping

### P2P
- key: `p2p:<chat_id>`
- default behavior: one active Codex session per direct chat

### Group thread
- key: `group:<chat_id>:thread:<thread_id>`
- default behavior: one active Codex session per thread

### Group non-thread
- key: `chat:<chat_id>`
- acceptable only later; not preferred for v1

## Session lifecycle

- first message with no binding -> create native Codex session
- normal follow-up -> resume existing native Codex session
- `/new` -> create a fresh native Codex session and replace current binding
- `/resume` -> reconnect to a known native session
- `/stop` -> stop the active run without deleting binding

## Stored metadata only

The bridge stores only:
- conversation key
- native Codex session id
- workspace
- timestamps

It does not store a synthetic message transcript as the session source of truth.
