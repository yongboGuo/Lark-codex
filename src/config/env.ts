import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";

if (!process.env.FEISHU_APP_ID) {
  loadEnv();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  nodeEnv: string;
  configPath?: string;
  feishu: {
    appId: string;
    appSecret: string;
    botOpenId: string;
    connectionMode: "websocket";
    sendRetryMaxAttempts: number;
    sendRetryBaseDelayMs: number;
    sendRetryMultiplier: number;
    sendRetryMaxDelayMs: number;
  };
  codex: {
    bin: string;
    home: string;
    sessionsDir: string;
    profileMode: "isolated" | "personal";
    backendMode: "spawn" | "terminal" | "app-server";
    sandboxMode: "workspace-write" | "danger-full-access";
    sessionListDefaultCount: number;
    sessionAllDefaultCount: number;
    runTimeoutMs: number;
    spawnStatusIntervalMs: number;
    statusIncludeProject: boolean;
    terminalRenderMode: "markdown" | "plain";
    terminalFlushIdleMs: number;
    terminalFlushMaxChars: number;
    terminalStartupTimeoutMs: number;
  };
  project: {
    allowedRoots: string[];
    defaultProject: string;
    defaultSearchEnabled: boolean;
  };
  storePath: string;
}

export function loadConfig(): AppConfig {
  const jsonConfig = loadJsonConfig(process.env.BRIDGE_CONFIG_JSON);
  const nodeEnv = optional("NODE_ENV", "development");
  const defaultProject = path.resolve(readSetting("DEFAULT_PROJECT", process.cwd(), jsonConfig));
  const projectAllowedRoots = parseRootsSetting(
    readSetting("PROJECT_ALLOWED_ROOTS", "", jsonConfig),
    defaultProject
  );
  if (!isUnderAnyRoot(defaultProject, projectAllowedRoots)) {
    throw new Error(
      `DEFAULT_PROJECT must stay under PROJECT_ALLOWED_ROOTS: ${defaultProject}`
    );
  }

  const homeDir = process.env.HOME || "/tmp";
  const codexProfileMode =
    readSetting("CODEX_PROFILE_MODE", nodeEnv === "development" ? "isolated" : "personal", jsonConfig) ===
    "personal"
      ? "personal"
      : "isolated";
  const defaultCodexHome =
    codexProfileMode === "personal"
      ? path.join(homeDir, ".codex")
      : path.join(
          homeDir,
          nodeEnv === "development" ? ".codex-feishu-bridge-dev" : ".codex-feishu-bridge"
        );

  const codexBackendMode = readSetting("CODEX_BACKEND_MODE", "spawn", jsonConfig);
  return {
    configPath: jsonConfig?.__path,
    nodeEnv,
    port: readIntegerSetting("PORT", "3300", jsonConfig, { min: 1 }),
    logLevel: readSetting("LOG_LEVEL", "info", jsonConfig),
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET"),
      botOpenId: required("FEISHU_BOT_OPEN_ID"),
      connectionMode: "websocket",
      sendRetryMaxAttempts: readIntegerSetting("FEISHU_SEND_RETRY_MAX_ATTEMPTS", "5", jsonConfig, {
        min: 0
      }),
      sendRetryBaseDelayMs: readIntegerSetting("FEISHU_SEND_RETRY_BASE_DELAY_MS", "1000", jsonConfig, {
        min: 0
      }),
      sendRetryMultiplier: readNumberSetting("FEISHU_SEND_RETRY_MULTIPLIER", "2", jsonConfig, {
        min: 1
      }),
      sendRetryMaxDelayMs: readIntegerSetting("FEISHU_SEND_RETRY_MAX_DELAY_MS", "10000", jsonConfig, {
        min: 0
      })
    },
    codex: {
      bin: readSetting("CODEX_BIN", "codex", jsonConfig),
      home: readSetting("CODEX_HOME", defaultCodexHome, jsonConfig),
      sessionsDir: readSetting("CODEX_SESSIONS_DIR", path.join(defaultCodexHome, "sessions"), jsonConfig),
      profileMode: codexProfileMode,
      backendMode:
        codexBackendMode === "terminal"
          ? "terminal"
          : codexBackendMode === "app-server"
            ? "app-server"
            : "spawn",
      sandboxMode:
        readSetting("CODEX_SANDBOX_MODE", "workspace-write", jsonConfig) === "danger-full-access"
          ? "danger-full-access"
          : "workspace-write",
      sessionListDefaultCount: readIntegerSetting(
        "CODEX_SESSION_LIST_DEFAULT_COUNT",
        "20",
        jsonConfig,
        { min: 1 }
      ),
      sessionAllDefaultCount: readIntegerSetting(
        "CODEX_SESSION_ALL_DEFAULT_COUNT",
        "100",
        jsonConfig,
        { min: 1 }
      ),
      runTimeoutMs: readIntegerSetting("CODEX_RUN_TIMEOUT_MS", "600000", jsonConfig, { min: 0 }),
      spawnStatusIntervalMs: readIntegerSetting("SPAWN_STATUS_INTERVAL_MS", "15000", jsonConfig, {
        min: 0
      }),
      statusIncludeProject: readBooleanSetting("STATUS_INCLUDE_PROJECT", true, jsonConfig),
      terminalRenderMode:
        readSetting("TERMINAL_RENDER_MODE", "markdown", jsonConfig) === "plain" ? "plain" : "markdown",
      terminalFlushIdleMs: readIntegerSetting("TERMINAL_FLUSH_IDLE_MS", "3000", jsonConfig, { min: 0 }),
      terminalFlushMaxChars: readIntegerSetting("TERMINAL_FLUSH_MAX_CHARS", "4000", jsonConfig, {
        min: 0
      }),
      terminalStartupTimeoutMs: readIntegerSetting(
        "TERMINAL_STARTUP_TIMEOUT_MS",
        "30000",
        jsonConfig,
        { min: 1 }
      )
    },
    project: {
      allowedRoots: projectAllowedRoots,
      defaultProject,
      defaultSearchEnabled: readBooleanSetting("DEFAULT_SEARCH_ENABLED", false, jsonConfig)
    },
    storePath: readSetting("STORE_PATH", ".data/bindings.json", jsonConfig)
  };
}

interface JsonConfigShape {
  __path?: string;
  [key: string]: unknown;
}

function readSetting(name: string, fallback: string, jsonConfig?: JsonConfigShape): string {
  const envValue = process.env[name];
  if (envValue) return envValue;
  const jsonValue = jsonConfig?.[name];
  if (typeof jsonValue === "string" && jsonValue.length > 0) return jsonValue;
  return fallback;
}

function readIntegerSetting(
  name: string,
  fallback: string,
  jsonConfig: JsonConfigShape | undefined,
  options: { min: number }
): number {
  const raw = readSetting(name, fallback, jsonConfig);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min) {
    throw new Error(`${name} must be an integer >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function readNumberSetting(
  name: string,
  fallback: string,
  jsonConfig: JsonConfigShape | undefined,
  options: { min: number }
): number {
  const raw = readSetting(name, fallback, jsonConfig);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.min) {
    throw new Error(`${name} must be a number >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function loadJsonConfig(configPath?: string): JsonConfigShape | undefined {
  if (!configPath) return undefined;
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing bridge config json: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw) as JsonConfigShape;
  parsed.__path = resolved;
  return parsed;
}

function readBooleanSetting(
  name: string,
  fallback: boolean,
  jsonConfig: JsonConfigShape | undefined
): boolean {
  const envValue = process.env[name];
  if (envValue) return parseBooleanSetting(name, envValue);
  const jsonValue = jsonConfig?.[name];
  if (typeof jsonValue === "boolean") return jsonValue;
  if (typeof jsonValue === "string" && jsonValue.trim()) {
    return parseBooleanSetting(name, jsonValue);
  }
  return fallback;
}

function parseBooleanSetting(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean: ${JSON.stringify(raw)}`);
}

function parseRootsSetting(raw: string, primaryRoot: string): string[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => path.resolve(part));
  return Array.from(new Set([path.resolve(primaryRoot), ...parts]));
}

function isUnderAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}
