# Feishu DM V1 Event Flow

## Scope

This document defines the initial DM-only event flow for v1.

V1 assumptions:
- Feishu direct messages only
- text input only
- text output only
- one DM conversation binds to one native Codex session
- no cards required
- no file/image handling required yet

## Goal

For a Feishu DM message:
1. receive the event
2. normalize it
3. resolve the conversation key
4. route it as command or Codex turn
5. send back a visible text reply

## Happy path: first normal DM

### Step 1 — Feishu event arrives
Transport receives a Feishu websocket event for a p2p message.

### Step 2 — normalize inbound payload
The Feishu adapter extracts:
- `eventId`
- `messageId`
- `chatId`
- `chatType = "p2p"`
- `senderOpenId`
- `text`

### Step 3 — dedup check
Use at least `eventId` and `messageId` to avoid duplicate processing on redelivery.

### Step 4 — resolve conversation key
For v1 DM:

```text
conversationKey = p2p:<chatId>
```

### Step 5 — parse command or turn
If text starts with `/`, route to command path.
Otherwise route to Codex turn path.

### Step 6 — binding lookup
The orchestrator asks the binding store:
- is there already a binding for `p2p:<chatId>`?

If no:
- create a new native Codex session
- persist the new binding

If yes:
- reuse the existing native Codex session id

### Step 7 — run Codex turn
The orchestrator sends the normalized user text into the native Codex session.

### Step 8 — project output back to Feishu
For v1 minimal mode:
- final text reply is enough
- optional streaming can be added later

### Step 9 — complete
The active run state is cleared.
The conversation binding remains.

## Happy path: follow-up DM

Flow is the same, except Step 6 finds an existing binding.

Result:
- same conversation key
- same native Codex session id
- no transcript replay
- actual native session continuity

## Command flow: `/status`

### Input
User sends:

```text
/status
```

### Behavior
1. normalize message
2. resolve `conversationKey = p2p:<chatId>`
3. look up binding
4. reply with:
   - conversation key
   - native Codex session id if bound
   - workspace
   - active run state if any

## Command flow: `/new`

### Input
User sends:

```text
/new
```

### Behavior
1. normalize message
2. resolve conversation key
3. create a fresh native Codex session
4. replace the stored binding for this conversation
5. reply with the new native session id and workspace

## Command flow: `/stop`

### Input
User sends:

```text
/stop
```

### Behavior
1. normalize message
2. resolve conversation key
3. find active run state for the conversation
4. if none exists, reply clearly: no active run
5. if one exists, call Codex adapter stop/cancel
6. reply with cancellation result

Important:
- `/stop` affects the run, not the session binding

## Error flows

### Parse failure
If Feishu event cannot be normalized:
- log safely
- drop the event
- do not crash the receive loop

### Missing binding on normal turn
This is not an error.
Create a new native Codex session.

### Missing bound native session
If binding exists but native Codex session no longer exists:
- report the problem clearly
- do not silently fake continuity
- orchestrator may later offer a repair path, but not hide the error in v1

### Outbound reply failure
If Feishu send fails:
- surface a transport error to logs
- keep run/binding semantics explicit
- do not pretend the user received a reply

### Codex runtime failure
If Codex run fails:
- send a bounded user-visible error reply if possible
- clear active run state
- keep existing binding unless the failure proves the session is invalid

## V1 sequence sketch

```text
Feishu websocket event
  -> Feishu adapter normalize
  -> dedup check
  -> orchestrator.handleInbound(message)
  -> resolve conversation key
  -> parse command vs turn
  -> binding lookup / create if needed
  -> Codex adapter runTurn(...)
  -> final text reply to Feishu
  -> clear active run state
```

## Strong v1 constraints

- DM only
- text only
- final text reply is sufficient
- one active run per conversation
- native Codex session id remains the only session truth
- no synthetic transcript replay

## Suggested first manual tests

1. Send first DM -> verify new native Codex session is created
2. Send second DM -> verify same native session is reused
3. Send `/status` -> verify session id is visible
4. Send `/new` -> verify new native session replaces old binding
5. Start long task then `/stop` -> verify run stops and binding remains
