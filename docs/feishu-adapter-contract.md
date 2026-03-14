# Feishu Adapter Contract

## Design intent

The Feishu adapter is the transport edge of the bridge.

Its job is to:

1. receive Feishu message events
2. normalize them into a stable internal input shape
3. send bridge output back to Feishu
4. expose only transport metadata needed for routing and presentation

It must not:

- implement Codex session logic
- become a workflow engine
- own conversation truth
- create an assistant-side session model separate from Codex

## Core principle

- **Feishu** = control surface
- **Codex** = conversation/session source of truth
- **Feishu adapter** = transport and presentation layer only

## Proposed TypeScript contract

```ts
export type FeishuChatType = "p2p" | "group" | "unknown";
export type FeishuMessageType = "text" | "image" | "file" | "post" | "unknown";

export interface FeishuInboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: FeishuChatType;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  senderOpenId?: string;
  senderName?: string;
  messageType: FeishuMessageType;
  text?: string;
  imageKeys?: string[];
  fileKeys?: string[];
  raw?: unknown;
}

export interface FeishuTextReply {
  kind: "text";
  text: string;
  replyToMessageId?: string;
}

export interface FeishuCardReply {
  kind: "card";
  card: unknown;
  replyToMessageId?: string;
}

export interface FeishuTypingUpdate {
  kind: "typing";
  action: "start" | "stop";
  chatId: string;
}

export interface FeishuStreamUpdate {
  kind: "stream";
  streamKey: string;
  textDelta?: string;
  finalText?: string;
  done?: boolean;
  replyToMessageId?: string;
}

export type FeishuOutgoing =
  | FeishuTextReply
  | FeishuCardReply
  | FeishuTypingUpdate
  | FeishuStreamUpdate;

export interface FeishuAdapter {
  start(onMessage: (message: FeishuInboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(outgoing: FeishuOutgoing): Promise<void>;
  ack(eventId: string): Promise<void>;
  fetchResource?(messageId: string, fileKey: string, type: "image" | "file"): Promise<string>;
}
```

## Method semantics

### `start(onMessage)`

Starts the Feishu transport and begins delivering normalized inbound messages.

Rules:
- one inbound event should become one normalized message callback
- adapter should deduplicate repeated deliveries when possible
- adapter should not block on Codex execution inside transport receive path

### `stop()`

Stops the Feishu connection cleanly.

Rules:
- close websocket or webhook resources gracefully
- no new inbound messages after resolution

### `send(outgoing)`

Sends a normalized bridge output back to Feishu.

Rules:
- transport-only responsibility
- do not mutate conversation/session meaning
- preserve reply/thread metadata when provided

### `ack(eventId)`

Acknowledges transport receipt when needed by the Feishu mode in use.

Rules:
- ack means transport received the event
- ack does not mean Codex processing completed

### `fetchResource(...)`

Optional helper for image/file download when later needed.

Rules:
- transport concern only
- returns local path or fetchable local artifact path
- no Codex-specific interpretation here

## Inbound normalization rules

The adapter should normalize Feishu events into a stable message shape.

At minimum preserve:
- `eventId`
- `messageId`
- `chatId`
- `chatType`
- `threadId`
- `rootId`
- `parentId`
- `senderOpenId`
- `messageType`
- `text`

The rest may remain in `raw` for debugging.

## Conversation key inputs

The Feishu adapter does not compute the final bridge conversation key, but it must preserve enough data for core routing.

Required routing inputs:
- p2p chat id
- group chat id
- thread id when present
- root / parent message ids when useful

## Presentation responsibilities

The adapter may support several output forms:

### Text reply
Use for:
- simple command output
- final answers
- fallback mode

### Card reply
Use for:
- optional richer status/help UI
- not required for v1

### Stream update
Use for:
- partial output projection
- progressive rendering during long Codex runs

### Typing update
Use for:
- lightweight liveness signal
- optional polish only

## Strong v1 recommendation

Start with only:
- inbound text messages
- outbound text replies
- optional minimal streaming later

Avoid making cards a hard dependency for the first working version.

## Error handling

### Inbound errors
If event parsing fails:
- log the raw event safely
- do not crash transport loop
- drop or reject malformed payload clearly

### Outbound errors
If sending fails:
- surface a transport error to core
- do not silently swallow failures
- make retries explicit rather than automatic and hidden

### Duplicate deliveries
Feishu may redeliver or reconnect.
The adapter should support dedup using at least:
- `eventId`
- `messageId`

## Thread and reply policy

The adapter should preserve thread semantics but not own session policy.

Rules:
- if a message is in a thread, preserve thread metadata on output when feasible
- if replying to a command, preserve `replyToMessageId` when supported
- do not collapse thread identity into a flat chat model inside the adapter

## Suggested implementation split

### `feishu-ws-client.ts`
Connection management and websocket lifecycle.

### `feishu-event-parser.ts`
Converts raw Feishu payloads into `FeishuInboundMessage`.

### `feishu-sender.ts`
Sends text/card/stream replies.

### `feishu-dedup-store.ts`
Optional lightweight dedup helper for `eventId` / `messageId`.

### `feishu-adapter.ts`
Implements the public `FeishuAdapter` contract.

## Websocket vs webhook

The contract should be transport-mode agnostic.

- websocket mode may be best for local always-on use
- webhook mode may be useful later for hosted deployment

The rest of the bridge should not care which mode is underneath.

## Non-goals

The Feishu adapter should not:
- decide project policy
- decide session binding policy
- interpret Codex run state beyond presentation needs
- own long-term history as conversation truth

## Strong v1 rule

Feishu metadata is for routing and presentation only.

Session truth stays outside the transport adapter and belongs to the Codex side plus the bridge's minimal binding store.
