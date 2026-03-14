import fs from "node:fs/promises";
import path from "node:path";

export async function listTrustedProjects(codexHome: string): Promise<string[]> {
  const configPath = path.join(codexHome, "config.toml");
  const raw = await fs.readFile(configPath, "utf8").catch(() => "");
  if (!raw) return [];

  const lines = raw.split(/\r?\n/);
  const trusted: string[] = [];
  let currentProject: string | undefined;

  for (const line of lines) {
    const projectMatch = line.match(/^\[projects\."(.+)"\]\s*$/);
    if (projectMatch) {
      currentProject = projectMatch[1];
      continue;
    }
    const trustMatch = line.match(/^trust_level\s*=\s*"([^"]+)"\s*$/);
    if (trustMatch && currentProject && trustMatch[1] === "trusted") {
      trusted.push(path.resolve(currentProject));
      currentProject = undefined;
    }
  }

  return Array.from(new Set(trusted));
}
