import * as Lark from "@larksuiteoapi/node-sdk";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage, OutgoingMessage } from "../../types/domain.js";

type MessageHandler = (message: IncomingMessage) => Promise<void>;
const FEISHU_POST_SOFT_LIMIT = 3500;

export class FeishuGateway {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private readonly recentMessages = new Map<string, number>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly config: AppConfig["feishu"]) {
    this.client = this.createClient();
    this.wsClient = this.createWsClient();
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.cleanupTimer = setInterval(() => this.evictDedupCache(), 60_000);
    this.cleanupTimer.unref();

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        console.log("Feishu raw receive event", {
          eventId: data?.event_id,
          messageId: data?.message?.message_id,
          chatId: data?.message?.chat_id,
          chatType: data?.message?.chat_type,
          messageType: data?.message?.message_type,
          hasContent: typeof data?.message?.content === "string",
          senderOpenId: data?.sender?.sender_id?.open_id
        });
        const message = normalizeIncoming(data);
        if (!message) {
          console.warn("Feishu inbound event ignored", {
            eventId: data?.event_id,
            messageId: data?.message?.message_id,
            reason: describeIgnoredMessage(data)
          });
          return;
        }
        if (message.senderOpenId && message.senderOpenId === this.config.botOpenId) {
          console.log("Feishu inbound event ignored", {
            eventId: data?.event_id,
            messageId: message.messageId,
            reason: "message from bot itself"
          });
          return;
        }

        const dedupKey = message.messageId;
        if (this.recentMessages.has(dedupKey)) return;
        this.recentMessages.set(dedupKey, Date.now());

        console.log("Feishu inbound message", {
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          threadId: message.threadId,
          textPreview: previewText(message.text)
        });

        void onMessage(message).catch((error: unknown) => {
          console.error("failed to process Feishu message", error);
        });
      },
      "im.message.message_read_v1": async () => {
        // No-op. Registering the event avoids repeated SDK warnings for read receipts.
      }
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log("Feishu websocket client connected.");
  }

  async send(message: OutgoingMessage): Promise<void> {
    const text = message.text || "";
    for (const chunk of splitMessageText(text, FEISHU_POST_SOFT_LIMIT)) {
      await this.sendChunkWithRetry(message.chatId, chunk);
    }
  }

  async sendStartupReady(text: string): Promise<void> {
    if (!this.config.startupNotifyChatId) return;
    await this.send({
      chatId: this.config.startupNotifyChatId,
      text
    });
  }

  exampleIncoming(text: string): IncomingMessage {
    return {
      messageId: "local-example",
      chatId: "local-chat",
      chatType: "p2p",
      text
    };
  }

  private evictDedupCache(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, timestamp] of this.recentMessages) {
      if (timestamp < cutoff) {
        this.recentMessages.delete(key);
      }
    }
  }

  private async sendChunkWithRetry(chatId: string, chunk: string): Promise<void> {
    let lastError: unknown;
    const configuredAttempts = this.config.sendRetryMaxAttempts;
    const attempts = Math.max(1, configuredAttempts);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id"
          },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: buildMarkdownPostContent(chunk)
          }
        });
        console.log("Feishu outbound message sent", {
          chatId,
          attempt,
          textPreview: previewText(chunk)
        });
        return;
      } catch (error) {
        lastError = error;
        if (shouldResetFeishuClient(error)) {
          this.client = this.createClient();
        }
        if (!shouldRetryFeishuError(error) || attempt >= attempts) {
          break;
        }
        const delayMs = computeRetryDelayMs(
          attempt,
          this.config.sendRetryBaseDelayMs,
          this.config.sendRetryMultiplier,
          this.config.sendRetryMaxDelayMs
        );
        console.warn(
          `Feishu send retry ${attempt}/${Math.max(0, attempts - 1)} in ${delayMs}ms: ${formatFeishuError(error)}`
        );
        await sleep(delayMs);
      }
    }

    throw new Error(
      `Feishu send failed after ${attempts} attempt${attempts === 1 ? "" : "s"}${configuredAttempts === 0 ? " (retry disabled)" : ""}: ${formatFeishuError(lastError)}`
    );
  }

  private createClient(): Lark.Client {
    return new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret
    });
  }

  private createWsClient(): Lark.WSClient {
    return new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret
    });
  }
}

function normalizeIncoming(data: any): IncomingMessage | undefined {
  if (!data?.message?.message_id || !data?.message?.chat_id || typeof data?.message?.content !== "string") {
    return undefined;
  }

  const content = parseJson(data.message.content);
  const text = extractIncomingText(content).trim();
  if (!text) return undefined;

  return {
    messageId: data.message.message_id,
    chatId: data.message.chat_id,
    chatType: normalizeChatType(data.message.chat_type),
    threadId: data.message.thread_id,
    rootId: data.message.root_id,
    senderOpenId: data.sender?.sender_id?.open_id,
    text
  };
}

function normalizeChatType(value: string | undefined): "p2p" | "group" | "unknown" {
  if (value === "p2p") return "p2p";
  if (value === "group") return "group";
  return "unknown";
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractIncomingText(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  const title = typeof content.title === "string" ? content.title.trim() : "";
  if (title) {
    parts.push(title);
  }
  if (typeof content.text === "string") {
    const text = content.text.trim();
    if (text) parts.push(text);
    return parts.join("\n");
  }
  if (Array.isArray(content.content)) {
    const text = flattenFeishuPostContent(content.content);
    if (text) parts.push(text);
    return parts.join("\n");
  }
  return parts.join("\n");
}

function flattenFeishuPostContent(content: unknown[]): string {
  const lines: string[] = [];

  for (const block of content) {
    if (!Array.isArray(block)) continue;
    const parts: string[] = [];
    for (const item of block) {
      if (!item || typeof item !== "object") continue;
      const tag = typeof (item as { tag?: unknown }).tag === "string" ? (item as { tag: string }).tag : "";
      if (tag === "text") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) {
          parts.push(text);
        }
        continue;
      }
      if (tag === "a") {
        const text = (item as { text?: unknown }).text;
        const href = (item as { href?: unknown }).href;
        if (typeof text === "string" && text.trim()) {
          parts.push(text);
        } else if (typeof href === "string" && href.trim()) {
          parts.push(href);
        }
        continue;
      }
      if (tag === "at") {
        const userName = (item as { user_name?: unknown }).user_name;
        if (typeof userName === "string" && userName.trim()) {
          parts.push(`@${userName}`);
        }
      }
    }
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

function splitMessageText(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];

  const blocks = splitMarkdownBlocks(text);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (block.length > maxChars) {
      pushCurrent();
      chunks.push(...splitOversizedMarkdownBlock(block, maxChars));
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    pushCurrent();
    current = block;
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : [text];
}

function buildMarkdownPostContent(text: string): string {
  const rendered = text.trim();
  const fenced = wrapRawMarkdown(rendered);
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: "md", text: `${rendered}\n\n${fenced}` }]]
    }
  });
}

function wrapRawMarkdown(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(4, longestBacktickRun + 1));
  return `${fence}markdown\n${text}\n${fence}`;
}

function splitMarkdownBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  const lines = normalized.split("\n");
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = (): void => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const fenceInfo = parseFenceLine(line);
    if (fenceInfo && !inFence) {
      flush();
      inFence = true;
      fenceMarker = fenceInfo.marker;
      current.push(line);
      continue;
    }
    if (inFence) {
      current.push(line);
      if (fenceInfo && fenceInfo.marker === fenceMarker) {
        flush();
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }

  flush();
  return blocks;
}

function splitOversizedMarkdownBlock(block: string, maxChars: number): string[] {
  const fenceInfo = parseFenceLine(block.split("\n", 1)[0] || "");
  if (!fenceInfo) {
    return splitPlainTextBlock(block, maxChars);
  }

  const lines = block.split("\n");
  const closingIndex = findClosingFenceIndex(lines, fenceInfo.marker);
  if (closingIndex <= 0) {
    return splitPlainTextBlock(block, maxChars);
  }

  const opening = lines[0];
  const closing = lines[closingIndex];
  const body = lines.slice(1, closingIndex).join("\n");
  const wrapperCost = opening.length + closing.length + 2;
  const innerMax = Math.max(1, maxChars - wrapperCost);
  const innerChunks = splitPlainTextBlock(body, innerMax);
  return innerChunks.map((chunk) => `${opening}\n${chunk}\n${closing}`);
}

function splitPlainTextBlock(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitAt = pickSplitPoint(remaining, maxChars);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function parseFenceLine(line: string): { marker: string } | undefined {
  const match = line.match(/^(`{3,}|~{3,})/);
  if (!match) return undefined;
  return { marker: match[1] };
}

function findClosingFenceIndex(lines: string[], marker: string): number {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].startsWith(marker)) {
      return index;
    }
  }
  return -1;
}

function pickSplitPoint(text: string, maxChars: number): number {
  const slice = text.slice(0, maxChars);
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph >= Math.floor(maxChars * 0.5)) return paragraph + 2;
  const line = slice.lastIndexOf("\n");
  if (line >= Math.floor(maxChars * 0.5)) return line + 1;
  const space = slice.lastIndexOf(" ");
  if (space >= Math.floor(maxChars * 0.5)) return space + 1;
  return maxChars;
}

function formatFeishuError(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? error : "unknown error";
  }

  const parts = [error.message];
  const maybe = error as Error & {
    code?: string;
    response?: {
      status?: number;
      statusText?: string;
      data?: unknown;
    };
  };

  if (maybe.code) {
    parts.push(`code=${maybe.code}`);
  }
  if (maybe.response?.status) {
    parts.push(`status=${maybe.response.status}`);
  }
  if (maybe.response?.statusText) {
    parts.push(`statusText=${maybe.response.statusText}`);
  }
  if (maybe.response?.data !== undefined) {
    const body = compactValue(maybe.response.data);
    if (body) parts.push(`body=${body}`);
  }

  return parts.join(" | ");
}

function shouldRetryFeishuError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const maybe = error as Error & {
    code?: string;
    response?: {
      status?: number;
    };
  };

  const status = maybe.response?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;

  return (
    error.message.includes("tenant_access_token") ||
    error.message.includes("socket hang up") ||
    maybe.code === "ECONNRESET" ||
    maybe.code === "ECONNABORTED" ||
    maybe.code === "ETIMEDOUT" ||
    maybe.code === "EAI_AGAIN" ||
    maybe.code === "ENOTFOUND" ||
    maybe.code === "ERR_NETWORK" ||
    maybe.code === "ERR_BAD_RESPONSE"
  );
}

function shouldResetFeishuClient(error: unknown): boolean {
  return error instanceof Error && error.message.includes("tenant_access_token");
}

function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  multiplier: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.max(1, multiplier ** (attempt - 1));
  return Math.min(Math.round(exponential), maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactValue(value: unknown): string {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.replace(/\s+/g, " ").trim().slice(0, 400);
  } catch {
    return "";
  }
}

function previewText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function describeIgnoredMessage(data: any): string {
  if (!data?.message?.message_id) return "missing message id";
  if (!data?.message?.chat_id) return "missing chat id";
  if (typeof data?.message?.content !== "string") return "missing string content";

  const content = parseJson(data.message.content);
  if (!content) return "message content is not valid JSON";
  if (!extractIncomingText(content).trim()) {
    return `unsupported content keys: ${Object.keys(content).join(", ") || "(none)"}`;
  }
  if (!extractIncomingText(content).trim()) return "empty text";
  return "unknown";
}
