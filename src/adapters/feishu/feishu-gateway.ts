import * as Lark from "@larksuiteoapi/node-sdk";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage, OutgoingMessage } from "../../types/domain.js";

type MessageHandler = (message: IncomingMessage) => Promise<void>;
const FEISHU_TEXT_SOFT_LIMIT = 4000;

export class FeishuGateway {
  private readonly client: Lark.Client;
  private readonly wsClient: Lark.WSClient;
  private readonly recentMessages = new Map<string, number>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly config: AppConfig["feishu"]) {
    const baseConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret
    };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient(baseConfig);
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.cleanupTimer = setInterval(() => this.evictDedupCache(), 60_000);
    this.cleanupTimer.unref();

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const message = normalizeIncoming(data);
        if (!message) return;
        if (message.senderOpenId && message.senderOpenId === this.config.botOpenId) return;

        const dedupKey = `${data.event_id ?? "event"}:${message.messageId}`;
        if (this.recentMessages.has(dedupKey)) return;
        this.recentMessages.set(dedupKey, Date.now());

        void onMessage(message).catch((error: unknown) => {
          console.error("failed to process Feishu message", error);
        });
      }
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log("Feishu websocket client connected.");
  }

  async send(message: OutgoingMessage): Promise<void> {
    const text = message.text || "";
    for (const chunk of splitMessageText(text, FEISHU_TEXT_SOFT_LIMIT)) {
      await this.sendChunkWithRetry(message.chatId, chunk);
    }
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
            msg_type: "text",
            content: JSON.stringify({ text: chunk })
          }
        });
        return;
      } catch (error) {
        lastError = error;
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
}

function normalizeIncoming(data: any): IncomingMessage | undefined {
  if (!data?.message?.message_id || !data?.message?.chat_id || typeof data?.message?.content !== "string") {
    return undefined;
  }

  const content = parseJson(data.message.content);
  const text = typeof content?.text === "string" ? content.text.trim() : "";
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

function splitMessageText(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitAt = pickSplitPoint(remaining, maxChars);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [text];
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
    maybe.code === "ECONNRESET" ||
    maybe.code === "ECONNABORTED" ||
    maybe.code === "ETIMEDOUT" ||
    maybe.code === "EAI_AGAIN" ||
    maybe.code === "ENOTFOUND" ||
    maybe.code === "ERR_NETWORK" ||
    maybe.code === "ERR_BAD_RESPONSE"
  );
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
