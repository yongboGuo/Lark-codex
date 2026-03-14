export type FeishuConversationKey = string;
export type CodexSessionId = string;

export interface SessionBinding {
  conversationKey: FeishuConversationKey;
  codexSessionId?: CodexSessionId;
  project: string;
  searchEnabled?: boolean;
  model?: string;
  profile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRun {
  conversationKey: FeishuConversationKey;
  codexSessionId: CodexSessionId;
  runId: string;
  startedAt: string;
  status: "starting" | "running" | "stopping";
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
  threadId?: string;
  rootId?: string;
  senderOpenId?: string;
  text: string;
}

export interface OutgoingMessage {
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  replyToMessageId?: string;
  threadId?: string;
}
