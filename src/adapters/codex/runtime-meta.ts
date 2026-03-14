import fs from "node:fs/promises";
import path from "node:path";

export interface CodexRuntimeMeta {
  version?: string;
  authMode?: string;
}

export async function getCodexRuntimeMeta(codexHome: string): Promise<CodexRuntimeMeta> {
  const [version, authMode] = await Promise.all([
    readCodexVersion(codexHome),
    readAuthMode(codexHome)
  ]);
  return { version, authMode };
}

async function readCodexVersion(codexHome: string): Promise<string | undefined> {
  const filePath = path.join(codexHome, "version.json");
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { latest_version?: string };
    return parsed.latest_version;
  } catch {
    return undefined;
  }
}

async function readAuthMode(codexHome: string): Promise<string | undefined> {
  const filePath = path.join(codexHome, "auth.json");
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { auth_mode?: string };
    return parsed.auth_mode;
  } catch {
    return undefined;
  }
}
