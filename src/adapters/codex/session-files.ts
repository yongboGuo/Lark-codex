import fs from "node:fs/promises";
import path from "node:path";

export async function findSessionFile(
  sessionsDir: string,
  sessionId: string
): Promise<string | undefined> {
  const yearDirs = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const yearDir of yearDirs) {
    if (!yearDir.isDirectory()) continue;
    const yearPath = path.join(sessionsDir, yearDir.name);
    const monthDirs = await fs.readdir(yearPath, { withFileTypes: true }).catch(() => []);
    for (const monthDir of monthDirs) {
      if (!monthDir.isDirectory()) continue;
      const monthPath = path.join(yearPath, monthDir.name);
      const dayDirs = await fs.readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const dayDir of dayDirs) {
        if (!dayDir.isDirectory()) continue;
        const dayPath = path.join(monthPath, dayDir.name);
        const files = await fs.readdir(dayPath, { withFileTypes: true }).catch(() => []);
        const match = files.find((file) => file.isFile() && file.name.includes(sessionId));
        if (match) {
          return path.join(dayPath, match.name);
        }
      }
    }
  }
  return undefined;
}
