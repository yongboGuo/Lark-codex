import fs from "node:fs/promises";
import path from "node:path";
import { SessionBinding } from "../types/domain.js";

interface StoreShape {
  bindings: SessionBinding[];
}

export class BindingStore {
  constructor(private readonly filePath: string) {}

  async get(conversationKey: string): Promise<SessionBinding | undefined> {
    const data = await this.read();
    return data.bindings.find((item) => item.conversationKey === conversationKey);
  }

  async put(binding: SessionBinding): Promise<void> {
    const data = await this.read();
    const idx = data.bindings.findIndex((item) => item.conversationKey === binding.conversationKey);
    if (idx >= 0) data.bindings[idx] = binding;
    else data.bindings.push(binding);
    await this.write(data);
  }

  async list(): Promise<SessionBinding[]> {
    const data = await this.read();
    return data.bindings;
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoreShape;
    } catch (error) {
      return { bindings: [] };
    }
  }

  private async write(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}
