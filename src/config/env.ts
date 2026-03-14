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
  };
  codex: {
    bin: string;
    home: string;
    sessionsDir: string;
    profileMode: "isolated" | "personal";
    backendMode: "spawn" | "terminal";
    sandboxMode: "workspace-write" | "danger-full-access";
    runTimeoutMs: number;
    spawnStatusIntervalMs: number;
    terminalRenderMode: "markdown" | "plain";
    terminalFlushIdleMs: number;
    terminalFlushMaxChars: number;
    terminalStartupTimeoutMs: number;
  };
  workspace: {
    root: string;
    defaultWorkspace: string;
  };
  storePath: string;
}

export function loadConfig(): AppConfig {
  const jsonConfig = loadJsonConfig(process.env.BRIDGE_CONFIG_JSON);
  const nodeEnv = optional("NODE_ENV", "development");
  const workspaceRoot = path.resolve(readSetting("WORKSPACE_ROOT", process.cwd(), jsonConfig));
  const defaultWorkspace = path.resolve(readSetting("DEFAULT_WORKSPACE", process.cwd(), jsonConfig));
  const relativeWorkspace = path.relative(workspaceRoot, defaultWorkspace);
  if (relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
    throw new Error(`DEFAULT_WORKSPACE must stay under WORKSPACE_ROOT: ${defaultWorkspace}`);
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
      connectionMode: "websocket"
    },
    codex: {
      bin: readSetting("CODEX_BIN", "/opt/node/bin/codex", jsonConfig),
      home: readSetting("CODEX_HOME", defaultCodexHome, jsonConfig),
      sessionsDir: readSetting("CODEX_SESSIONS_DIR", path.join(defaultCodexHome, "sessions"), jsonConfig),
      profileMode: codexProfileMode,
      backendMode: codexBackendMode === "terminal" ? "terminal" : "spawn",
      sandboxMode:
        readSetting("CODEX_SANDBOX_MODE", "workspace-write", jsonConfig) === "danger-full-access"
          ? "danger-full-access"
          : "workspace-write",
      runTimeoutMs: readIntegerSetting("CODEX_RUN_TIMEOUT_MS", "600000", jsonConfig, { min: 0 }),
      spawnStatusIntervalMs: readIntegerSetting("SPAWN_STATUS_INTERVAL_MS", "15000", jsonConfig, {
        min: 0
      }),
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
    workspace: {
      root: workspaceRoot,
      defaultWorkspace
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
