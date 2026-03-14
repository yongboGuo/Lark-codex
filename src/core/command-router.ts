import { IncomingMessage } from "../types/domain.js";

export type CommandName = "help" | "status" | "new" | "resume" | "stop" | "workspace";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

export function parseCommand(message: IncomingMessage): ParsedCommand | undefined {
  const text = message.text.trim();
  if (!text.startsWith("/")) return undefined;
  const [head, ...args] = text.slice(1).split(/\s+/);
  if (["help", "status", "new", "resume", "stop", "workspace"].includes(head)) {
    return { name: head as CommandName, args };
  }
  return undefined;
}
