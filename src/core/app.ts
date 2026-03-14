import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { CodexBackend } from "../adapters/codex/backend.js";
import { createCodexBackend } from "../adapters/codex/codex-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, SessionBinding } from "../types/domain.js";
import { getSessionSummary, listRecentSessions } from "../adapters/codex/session-files.js";
import { listTrustedProjects } from "../adapters/codex/project-files.js";
import { getCodexRuntimeMeta } from "../adapters/codex/runtime-meta.js";

export class App {
  private readonly store: BindingStore;
  private readonly codex: CodexBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly config: AppConfig) {
    this.store = new BindingStore(path.resolve(this.config.storePath));
    this.codex = createCodexBackend(this.config.codex);
  }

  async start(): Promise<void> {
    console.log("codex-feishu-bridge starting", {
      nodeEnv: this.config.nodeEnv,
      configPath: this.config.configPath,
      projectAllowedRoots: this.config.project.allowedRoots,
      defaultProject: this.config.project.defaultProject,
      codexBin: this.config.codex.bin,
      codexHome: this.config.codex.home,
      codexProfileMode: this.config.codex.profileMode,
      codexBackendMode: this.codex.mode,
      codexSandboxMode: this.config.codex.sandboxMode
    });
    if (this.config.codex.profileMode === "personal" && this.codex.mode === "spawn") {
      console.warn(
        "Using CODEX_PROFILE_MODE=personal with spawn backend. This shares ~/.codex with your interactive Codex and may cause instability."
      );
    }
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(async (message) => {
      try {
        let streamed = false;
        let lastUpdateText: string | undefined;
        const sendUpdateSafely = async (update: string): Promise<void> => {
          try {
            await this.feishu?.send({
              chatId: message.chatId,
              text: update,
              replyToMessageId: message.messageId,
              threadId: message.threadId
            });
            streamed = true;
            lastUpdateText = update;
          } catch (error) {
            console.error("failed to send Feishu update", {
              messageId: message.messageId,
              chatId: message.chatId,
              threadId: message.threadId,
              textPreview: this.previewText(update),
              error
            });
          }
        };

        const text = await this.handleIncoming(message, sendUpdateSafely);
        if ((text && text !== lastUpdateText) || !streamed) {
          await this.feishu?.send({
            chatId: message.chatId,
            text,
            replyToMessageId: message.messageId,
            threadId: message.threadId
          });
        }
        console.log("bridge handled message", {
          messageId: message.messageId,
          chatId: message.chatId,
          threadId: message.threadId,
          streamed,
          finalPreview: this.previewText(text)
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown bridge error.";
        try {
          await this.feishu?.send({
            chatId: message.chatId,
            text: `bridge error: ${text}`,
            replyToMessageId: message.messageId,
            threadId: message.threadId
          });
        } catch (sendError) {
          console.error("failed to send bridge error to Feishu", sendError);
        }
      }
    });
  }

  async handleIncoming(
    message: IncomingMessage,
    onUpdate?: (text: string) => Promise<void>
  ): Promise<string> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const command = parseCommand(message);
    if (command?.name === "help") {
      return [
        "# Bridge Help",
        "",
        "- `/help` show commands",
        "- `/status` show current session and run state",
        "- `/new` create and bind a fresh Codex session",
        "- `/session [list [-n N|--all] [--all-projects] [--project]|-h|--help]` show the current bound session, list recent sessions, or show session help",
        "- `/resume [--last|<session-id>|-n N|-h|--all] [--all-projects] [-C|--cd <dir>]` bind the latest session by default, optionally switching project",
        "- `/stop` stop the current active run",
        "- `/project [list [--all|--trusted]|bind [-n N|-m|--mkdir <path>|<path>]|-h]` show, list, or bind projects",
        "- `/approvals [auto|full-access]` show or change Codex approvals",
        "- `/search [on|off]` show or change live web search for this conversation",
        "- `/model [name|clear]` show or change the Codex model for this conversation",
        "- `/profile [name|clear]` show or change the Codex profile for this conversation"
      ].join("\n");
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);
    let sentEarlyUpdate = false;
    const sendEarlyUpdate = async (text: string): Promise<void> => {
      if (!onUpdate || sentEarlyUpdate) return;
      sentEarlyUpdate = true;
      await onUpdate(text);
    };

    if (command?.name === "status") {
      const project = existing?.project || this.config.project.defaultProject;
      const sessionId = existing?.codexSessionId || "(none)";
      const session =
        existing?.codexSessionId
          ? await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId)
          : undefined;
      const trustedProjects = await this.listTrustedProjects();
      const runtimeMeta = await getCodexRuntimeMeta(this.config.codex.home);
      const agentsPath = path.join(project, "AGENTS.md");
      const hasAgents = await fs
        .stat(agentsPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      return [
        "# Bridge Status",
        "",
        `- **conversation**: \`${key}\``,
        `- **session**: \`${sessionId}\``,
        `- **project**: \`${project}\``,
        `- **trusted**: \`${trustedProjects.includes(project) ? "yes" : "no"}\``,
        `- **backend**: \`${this.codex.mode}\``,
        `- **codex**: \`${runtimeMeta.version || "(unknown)"}\``,
        `- **sandbox**: \`${this.config.codex.sandboxMode}\``,
        `- **auth**: \`${runtimeMeta.authMode || "(unknown)"}\``,
        `- **agents.md**: \`${hasAgents ? agentsPath : "<none>"}\``,
        `- **search**: \`${existing?.searchEnabled ? "on" : "off"}\``,
        `- **model**: \`${existing?.model || "(default)"}\``,
        `- **profile**: \`${existing?.profile || "(default)"}\``,
        `- **run**: \`${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}\``,
        `- **session time**: ${session?.createdAt || "(unknown)"}`,
        `- **session cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **session about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
    }

    if (command?.name === "resume") {
      if (activeRun) {
        return `Cannot resume while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const resumeArgs = [...command.args];
      const cdIndex = resumeArgs.findIndex((arg) => arg === "-C" || arg === "--cd");
      let resumeProject = existing?.project || this.config.project.defaultProject;
      let projectExplicitlySelected = false;
      if (cdIndex >= 0) {
        const requestedProject = resumeArgs[cdIndex + 1];
        if (!requestedProject) {
          return "Usage: `/resume ... [-C|--cd <dir>]`";
        }
        resumeProject = await this.resolveProject(
          requestedProject,
          existing?.project || this.config.project.defaultProject
        );
        projectExplicitlySelected = true;
        resumeArgs.splice(cdIndex, 2);
      }

      const allProjects = this.consumeFlag(resumeArgs, "--all-projects");
      const sortByProject = this.consumeFlag(resumeArgs, "--project");
      if (resumeArgs[0] === "-h" || resumeArgs[0] === "--help") {
        return this.resumeHelpText();
      }
      if (resumeArgs[0] === "--last") {
        resumeArgs.shift();
      }
      if (resumeArgs[0] === "--all") {
        const sessions = await this.listScopedSessions(
          this.config.codex.sessionAllDefaultCount,
          resumeProject,
          allProjects
        );
        if (sessions.length === 0) {
          return this.noSessionsText(resumeProject, allProjects);
        }
        return this.renderSessionList(
          allProjects ? "Resume All Projects" : "Resume Current Project",
          this.sortSessionsForDisplay(sessions, sortByProject),
          existing?.codexSessionId,
          sortByProject
        );
      }
      if ((resumeArgs[0] || "").startsWith("-") && resumeArgs[0] !== "-n") {
        return [
          "# Resume",
          "",
          `- **error**: unsupported bridge option \`${resumeArgs[0]}\``,
          "- **supported**: `/resume`, `/resume --last`, `/resume -n N`, `/resume <session-id>`, `/resume --all`, `/resume --all-projects`, `/resume --project`, `/resume -h`, `/resume ... -C <dir>`",
          "- Use a normal follow-up message after `/resume ...` if you want to continue the bound session."
        ].join("\n");
      }

      let targetSessionId =
        resumeArgs[0] ||
        (await this.findMostRecentSessionId(
          resumeProject,
          projectExplicitlySelected ? false : allProjects
        )) ||
        existing?.codexSessionId;
      let resumeSource = resumeArgs[0] ? "explicit" : "latest";
      let resumeWarning: string | undefined;
      let resumeIndex: number | undefined;

      if (resumeArgs[0] === "-n") {
        const index = Number(resumeArgs[1] || "");
        if (!Number.isInteger(index) || index < 1) {
          return "Usage: `/resume -n <index>` where `<index>` is an integer >= 1.";
        }
        const sessions = this.sortSessionsForDisplay(
          await this.listScopedSessions(
            Math.min(index, this.config.codex.sessionAllDefaultCount),
            resumeProject,
            allProjects
          ),
          sortByProject
        );
        const selected = sessions[index - 1];
        if (!selected) {
          return `session index out of range: ${index}. Use \`/session list${allProjects ? " --all-projects" : ""} --all\` first.`;
        }
        targetSessionId = selected.sessionId;
        resumeSource = "indexed";
        resumeIndex = index;
        resumeWarning =
          "Index-based resume depends on the current recent-session ordering and may change as new sessions are created.";
      }

      if (!targetSessionId) {
        return `No native Codex session found${allProjects ? "" : " for the current project"}. Use \`/session list${allProjects ? " --all-projects" : ""}\` or \`/resume <session-id>\`.`;
      }
      await sendEarlyUpdate(`resolving session ${targetSessionId} for project \`${resumeProject}\`...`);
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return `session not found: ${targetSessionId}`;
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, targetSessionId);
      const binding = this.makeBinding(
        key,
        targetSessionId,
        resumeProject,
        existing
      );
      await this.store.put(binding);
      return [
        "# Resume Session",
        "",
        `- **source**: \`${resumeSource}\``,
        ...(resumeIndex ? [`- **index**: \`${resumeIndex}\``] : []),
        `- **session**: \`${binding.codexSessionId}\``,
        `- **project**: \`${binding.project}\``,
        `- **time**: ${session?.createdAt || "(unknown)"}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`,
        ...(resumeWarning ? [`- **warning**: ${resumeWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "session") {
      const sessionArgs = [...command.args];
      const allProjects = this.consumeFlag(sessionArgs, "--all-projects");
      const sortByProject = this.consumeFlag(sessionArgs, "--project");
      if (sessionArgs[0] === "-h" || sessionArgs[0] === "--help") {
        return this.sessionsHelpText();
      }
      const isLegacyNumericList = sessionArgs.length === 1 && /^\d+$/.test(sessionArgs[0] || "");
      const isList = sessionArgs[0] === "list" || isLegacyNumericList;
      if (isList) {
        const listArgs = sessionArgs[0] === "list" ? sessionArgs.slice(1) : sessionArgs;
        const limit = this.parseSessionsListLimit(listArgs);
        const currentProject = existing?.project || this.config.project.defaultProject;
        const sessions = await this.listScopedSessions(limit, currentProject, allProjects);
        if (sessions.length === 0) {
          return this.noSessionsText(currentProject, allProjects);
        }
        return this.renderSessionList(
          allProjects ? "All Project Sessions" : "Current Project Sessions",
          this.sortSessionsForDisplay(sessions, sortByProject),
          existing?.codexSessionId,
          sortByProject
        );
      }

      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list`.";
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId);
      return [
        "# Current Session",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **project**: \`${existing.project || this.config.project.defaultProject}\``,
        `- **time**: ${session?.createdAt || "(unknown)"}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
    }

    const binding = existing;
    if (command?.name === "new") {
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const project = binding?.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`creating a new Codex session for project \`${project}\`...`);
      const sessionId = await this.codex.createSession(project, this.resolveTurnOptions(binding));
      const nextBinding = this.makeBinding(key, sessionId, project, binding);
      await this.store.put(nextBinding);
      return [
        "# New Session",
        "",
        `- **session**: \`${sessionId}\``,
        `- **project**: \`${nextBinding.project}\``,
        `- **search**: \`${nextBinding.searchEnabled ? "on" : "off"}\``,
        `- **model**: \`${nextBinding.model || "(default)"}\``,
        `- **profile**: \`${nextBinding.profile || "(default)"}\``
      ].join("\n");
    }

    if (command?.name === "stop") {
      if (!activeRun) {
        return "No active run for this conversation.";
      }
      await sendEarlyUpdate(`stopping run \`${activeRun.runId}\`...`);
      this.activeRuns.set(key, { ...activeRun, status: "stopping" });
      const stopped = await this.codex.stop(activeRun.runId);
      return stopped
        ? `# Stop Run\n\n- **run**: \`${activeRun.runId}\`\n- **status**: \`stop requested\``
        : "Run already finished before stop completed.";
    }

    if (command?.name === "project") {
      const currentProject = binding?.project || this.config.project.defaultProject;
      const trustedProjects = await this.listTrustedProjects();
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.projectHelpText();
      }
      if (command.args.length === 0) {
        return [
          "# Project",
          "",
          `- **project**: \`${currentProject}\``,
          `- **trusted**: \`${trustedProjects.includes(currentProject) ? "yes" : "no"}\``,
          `- **allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`
        ].join("\n");
      }

      if (command.args[0] === "list") {
        const mode = command.args.includes("--trusted")
          ? "trusted"
          : command.args.includes("--all")
            ? "all"
            : "default";
        const projects = await this.listProjects(mode, currentProject, trustedProjects);
        if (projects.length === 0) {
          return "# Projects\n\n- No projects found.";
        }
        return this.renderProjectList("Projects", projects, currentProject);
      }

      if (command.args[0] !== "bind") {
        return this.projectHelpText();
      }
      if (activeRun) {
        return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }

      const bindArgs = command.args.slice(1);
      const mkdirIndex = bindArgs.findIndex((arg) => arg === "-m" || arg === "--mkdir");
      const createMissing = mkdirIndex >= 0;
      const projectArgs = [...bindArgs];
      if (mkdirIndex >= 0) {
        projectArgs.splice(mkdirIndex, 1);
      }

      let project: string | undefined;
      let bindWarning: string | undefined;
      if (projectArgs[0] === "-n") {
        const index = Number(projectArgs[1] || "");
        if (!Number.isInteger(index) || index < 1) {
          return "Usage: `/project bind -n <index>` where `<index>` is an integer >= 1.";
        }
        const projects = await this.listProjects("default", currentProject, trustedProjects);
        const selected = projects[index - 1];
        if (!selected) {
          return `project index out of range: ${index}. Use \`/project list\` first.`;
        }
        project = selected.project;
        bindWarning =
          "Index-based bind uses the current `/project list` ordering and may change as projects are added or updated.";
      } else {
        const requested = projectArgs.join(" ").trim();
        if (!requested) {
          return this.projectHelpText();
        }
        project = await this.resolveProject(requested, currentProject, createMissing);
      }

      const nextBinding = binding
        ? { ...binding, project, updatedAt: new Date().toISOString() }
        : this.makeBinding(key, undefined, project);
      await sendEarlyUpdate(`binding project \`${project}\`...`);
      await this.store.put(nextBinding);
      return [
        "# Project",
        "",
        `- **project**: \`${project}\``,
        `- **trusted**: \`${trustedProjects.includes(project) ? "yes" : "no"}\``,
        ...(bindWarning ? [`- **warning**: ${bindWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "approvals") {
      if (command.args.length === 0) {
        return [
          "# Approvals",
          "",
          `- **mode**: \`${this.config.codex.sandboxMode}\``,
          "- **choices**: `auto`, `full-access`"
        ].join("\n");
      }
      if (activeRun) {
        return `Cannot change approvals while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextMode = this.parseApprovalMode(command.args.join(" "));
      if (!nextMode) {
        return [
          "# Approvals",
          "",
          `- **error**: unknown mode \`${command.args.join(" ")}\``,
          "- **choices**: `auto`, `full-access`"
        ].join("\n");
      }
      await sendEarlyUpdate(`switching approvals to \`${nextMode}\`...`);
      this.config.codex.sandboxMode = nextMode;
      await this.persistJsonSetting("CODEX_SANDBOX_MODE", nextMode);
      return [
        "# Approvals",
        "",
        `- **mode**: \`${nextMode}\``,
        nextMode === "danger-full-access"
          ? "- Codex will use `--dangerously-bypass-approvals-and-sandbox` on new runs."
          : "- Codex will use `--full-auto` on new runs."
      ].join("\n");
    }

    if (command?.name === "search") {
      const enabled = binding?.searchEnabled ?? this.config.project.defaultSearchEnabled;
      if (command.args.length === 0) {
        return `# Search\n\n- **mode**: \`${enabled ? "on" : "off"}\``;
      }
      if (activeRun) {
        return `Cannot change search while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const normalized = command.args[0]?.toLowerCase();
      if (!["on", "off"].includes(normalized || "")) {
        return "# Search\n\n- **usage**: `/search [on|off]`";
      }
      const nextBinding = binding
        ? { ...binding, searchEnabled: normalized === "on", updatedAt: new Date().toISOString() }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            { searchEnabled: normalized === "on" }
          );
      await sendEarlyUpdate(`switching search ${normalized}...`);
      await this.store.put(nextBinding);
      return `# Search\n\n- **mode**: \`${nextBinding.searchEnabled ? "on" : "off"}\``;
    }

    if (command?.name === "model") {
      const current = binding?.model || "(default)";
      if (command.args.length === 0) {
        return `# Model\n\n- **model**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change model while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = command.args.join(" ").trim();
      const nextBinding = binding
        ? {
            ...binding,
            model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue,
            updatedAt: new Date().toISOString()
          }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            {
              model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue
            }
          );
      await sendEarlyUpdate(
        `switching model to \`${nextBinding.model || "(default)"}\`...`
      );
      await this.store.put(nextBinding);
      return `# Model\n\n- **model**: \`${nextBinding.model || "(default)"}\``;
    }

    if (command?.name === "profile") {
      const current = binding?.profile || "(default)";
      if (command.args.length === 0) {
        return `# Profile\n\n- **profile**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change profile while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = command.args.join(" ").trim();
      const nextBinding = binding
        ? {
            ...binding,
            profile: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue,
            updatedAt: new Date().toISOString()
          }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            {
              profile: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue
            }
          );
      await sendEarlyUpdate(
        `switching profile to \`${nextBinding.profile || "(default)"}\`...`
      );
      await this.store.put(nextBinding);
      return `# Profile\n\n- **profile**: \`${nextBinding.profile || "(default)"}\``;
    }

    if (activeRun) {
      return [
        "# Active Run",
        "",
        `- **run**: \`${activeRun.runId}\``,
        `- **status**: \`${activeRun.status}\``
      ].join("\n");
    }

    const project = binding?.project || this.config.project.defaultProject;
    await sendEarlyUpdate(`sending prompt to Codex for project \`${project}\`...`);
    const provisionalRunId = `pending:${randomUUID()}`;
    this.activeRuns.set(key, {
      conversationKey: key,
      codexSessionId: binding?.codexSessionId || "(pending)",
      runId: provisionalRunId,
      startedAt: new Date().toISOString(),
      status: "starting"
    });

    try {
      const handle = await this.codex.runTurn(
        message,
        binding?.codexSessionId,
        project,
        this.resolveTurnOptions(binding),
        {
          onStatus: onUpdate,
          onUpdate
        }
      );
      this.activeRuns.set(key, {
        conversationKey: key,
        codexSessionId: binding?.codexSessionId || "(pending)",
        runId: handle.runId,
        startedAt: new Date().toISOString(),
        status: "running"
      });
      const result = await handle.done;

      const nextBinding =
        binding && binding.codexSessionId === result.sessionId
          ? { ...binding, updatedAt: new Date().toISOString() }
          : this.makeBinding(key, result.sessionId, project, binding);
      await this.store.put(nextBinding);
      return this.codex.mode === "terminal" && onUpdate ? "" : result.output;
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private makeBinding(
    conversationKey: string,
    codexSessionId: string | undefined,
    project: string,
    defaults?: Partial<SessionBinding>
  ): SessionBinding {
    const now = new Date().toISOString();
    return {
      conversationKey,
      codexSessionId,
      project,
      searchEnabled: defaults?.searchEnabled ?? this.config.project.defaultSearchEnabled,
      model: defaults?.model,
      profile: defaults?.profile,
      createdAt: defaults?.createdAt || now,
      updatedAt: now
    };
  }

  private resolveTurnOptions(binding?: Partial<SessionBinding>) {
    return {
      searchEnabled: binding?.searchEnabled ?? this.config.project.defaultSearchEnabled,
      model: binding?.model,
      profile: binding?.profile
    };
  }

  private async resolveProject(
    requested: string,
    currentProject: string,
    createMissing = false
  ): Promise<string> {
    const resolved = path.resolve(
      requested.startsWith("/")
        ? requested
        : path.resolve(currentProject || this.config.project.defaultProject, requested)
    );
    const allowed = this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, resolved);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (!allowed) {
      throw new Error(
        `Project must stay under one of: ${this.config.project.allowedRoots.join(", ")}`
      );
    }

    let stats = await fs.stat(resolved).catch(() => null);
    if (!stats && createMissing) {
      await fs.mkdir(resolved, { recursive: true });
      stats = await fs.stat(resolved).catch(() => null);
    }
    if (!stats?.isDirectory()) {
      throw new Error(`Project does not exist: ${resolved}`);
    }
    return resolved;
  }

  private parseApprovalMode(value: string): AppConfig["codex"]["sandboxMode"] | undefined {
    const normalized = value.trim().toLowerCase();
    if (["auto", "workspace-write", "workspace", "safe"].includes(normalized)) {
      return "workspace-write";
    }
    if (["full-access", "danger-full-access", "danger", "bypass"].includes(normalized)) {
      return "danger-full-access";
    }
    return undefined;
  }

  private async persistJsonSetting(name: string, value: string): Promise<void> {
    if (!this.config.configPath) return;
    const raw = await fs.readFile(this.config.configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed[name] = value;
    await fs.writeFile(this.config.configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }

  private async findMostRecentSessionId(
    project: string,
    allProjects = false
  ): Promise<string | undefined> {
    const sessions = await this.listScopedSessions(1, project, allProjects);
    return sessions[0]?.sessionId;
  }

  private async listScopedSessions(
    limit: number,
    project: string,
    allProjects = false
  ): Promise<Awaited<ReturnType<typeof listRecentSessions>>> {
    return listRecentSessions(
      this.config.codex.sessionsDir,
      Math.max(1, limit),
      allProjects
        ? undefined
        : {
            cwd: project,
            includeUnknownCwd: true
          }
    );
  }

  private async listTrustedProjects(): Promise<string[]> {
    const trusted = await listTrustedProjects(this.config.codex.home);
    return trusted.filter((project) => this.isAllowedProject(project));
  }

  private async listProjects(
    mode: "default" | "all" | "trusted",
    currentProject: string,
    trustedProjects?: string[]
  ): Promise<ProjectListEntry[]> {
    const trusted = trustedProjects || (await this.listTrustedProjects());
    const bindings = await this.store.list();
    const seen = new Set<string>();
    const boundProjects: ProjectListEntry[] = bindings
      .filter((binding) => this.isAllowedProject(binding.project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((binding) => {
        if (seen.has(binding.project)) return false;
        seen.add(binding.project);
        return true;
      })
      .map((binding) => ({
        project: binding.project,
        bound: true,
        trusted: trusted.includes(binding.project),
        updatedAt: binding.updatedAt
      }));

    const trustedOnly: ProjectListEntry[] = trusted
      .filter((project) => !seen.has(project))
      .map((project) => ({
        project,
        bound: false,
        trusted: true
      }));

    const currentEntry: ProjectListEntry = {
      project: currentProject,
      bound: Boolean(bindings.find((binding) => binding.project === currentProject)),
      trusted: trusted.includes(currentProject),
      updatedAt: bindings.find((binding) => binding.project === currentProject)?.updatedAt
    };

    if (mode === "trusted") {
      const trustedList = [...boundProjects.filter((item) => item.trusted), ...trustedOnly];
      if (!trustedList.find((item) => item.project === currentProject) && currentEntry.trusted) {
        trustedList.unshift(currentEntry);
      }
      return trustedList;
    }

    const defaultList = [...boundProjects];
    if (!defaultList.find((item) => item.project === currentProject) && this.isAllowedProject(currentProject)) {
      defaultList.unshift(currentEntry);
    }
    if (mode === "default") {
      return defaultList;
    }
    return [...defaultList, ...trustedOnly];
  }

  private previewText(value: string, maxLength = 120): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
  }

  private isAllowedProject(project: string): boolean {
    return this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, project);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  }

  private projectHelpText(): string {
    return [
      "# Project",
      "",
      "Inspect the current bound project, browse known projects, or bind one.",
      "",
      "## Usage",
      "",
      "- `/project`",
      "- `/project list`",
      "- `/project list --all`",
      "- `/project list --trusted`",
      "- `/project bind <path>`",
      "- `/project bind -m <path>`",
      "- `/project bind -n 3`",
      "- `/project -h`",
      "",
      "## Notes",
      "",
      "- `/project list` shows the normal project list used by `/project bind -n N`.",
      "- `/project list --all` includes trusted Codex projects that are not currently bound in the bridge store.",
      "- `/project list --trusted` shows trusted Codex projects from `config.toml` under the allowed roots.",
      "- `/project bind -n <index>` uses the current `/project list` ordering.",
      `- **allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`,
      "- Missing projects are rejected unless you use `-m` or `--mkdir`."
    ].join("\n");
  }

  private resumeHelpText(): string {
    return [
      "# Resume",
      "",
      "Resume a previous session.",
      "",
      "## Usage",
      "",
      "- `/resume`",
      "- `/resume --last`",
      "- `/resume -n 3`",
      "- `/resume <session-id>`",
      "- `/resume --all-projects`",
      "- `/resume --all --all-projects --project`",
      "- `/resume --last -C subdir`",
      "- `/resume -h`",
      "- `/resume --all`",
      "",
      "## Notes",
      "",
      "- `/resume` and `/resume --last` both bind the most recent recorded native Codex session for the current project.",
      "- `/resume -n <index>` binds the Nth session from the current `/session list` ordering.",
      "- `/resume <session-id>` binds a specific native session id.",
      "- `-C, --cd <dir>` switches the bound project while resuming the session.",
      "- `--all-projects` expands browsing beyond the current project.",
      "- `--project` sorts list output by project name, then time.",
      "- `/resume --all` shows the recent sessions list for the current project in Feishu instead of opening an interactive picker.",
      `- In Feishu, use \`/session list --all\` for the default current-project list of \`${this.config.codex.sessionAllDefaultCount}\` sessions, or \`/session list --all --all-projects\` to browse across projects.`,
      "- Index-based resume is order-dependent and should be treated as a convenience, not a stable identifier.",
      "- Native Codex flags like `--config`, `--remote`, `--image`, `--model`, `--sandbox`, and prompt arguments are not exposed on this bridge command."
    ].join("\n");
  }

  private sessionsHelpText(): string {
    return [
      "# Session",
      "",
      "Inspect the current bound session or browse recent native Codex sessions.",
      "",
      "## Usage",
      "",
      "- `/session`",
      "- `/session list`",
      "- `/session list -n 12`",
      "- `/session list --all`",
      "- `/session list --all-projects`",
      "- `/session list --all --all-projects --project`",
      "- `/session -h`",
      "",
      "## Notes",
      "",
      "- `/session` shows the current bound session for this conversation.",
      "- `/session list` shows recent native Codex sessions for the current project.",
      "- `--all-projects` expands the list across `CODEX_SESSIONS_DIR`.",
      "- `--project` sorts list output by project name, then time.",
      `- \`/session list\` defaults to \`${this.config.codex.sessionListDefaultCount}\` sessions for the current project.`,
      `- \`/session list --all\` uses the default count \`${this.config.codex.sessionAllDefaultCount}\` for the current project.`,
      `- \`-n\` accepts values from \`1\` to \`${this.config.codex.sessionAllDefaultCount}\`.`,
      "- Use `/resume <session-id>` to bind one of the listed sessions."
    ].join("\n");
  }

  private parseSessionsListLimit(args: string[]): number {
    if (args[0] === "--all") {
      return this.config.codex.sessionAllDefaultCount;
    }
    if (args.length === 1 && /^\d+$/.test(args[0] || "")) {
      return Math.min(
        this.config.codex.sessionListDefaultCount,
        Math.max(1, Number(args[0]) || this.config.codex.sessionListDefaultCount)
      );
    }
    const flagIndex = args.findIndex((arg) => arg === "-n" || arg === "--count");
    const raw = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
    return Math.min(
      this.config.codex.sessionListDefaultCount,
      Math.max(1, Number(raw || String(this.config.codex.sessionListDefaultCount)) || this.config.codex.sessionListDefaultCount)
    );
  }

  private consumeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  }

  private noSessionsText(project: string, allProjects: boolean): string {
    return allProjects
      ? `No native Codex sessions found under ${this.config.codex.sessionsDir}`
      : `No native Codex sessions found for current project \`${project}\` under ${this.config.codex.sessionsDir}`;
  }

  private renderSessionList(
    title: string,
    sessions: Awaited<ReturnType<typeof listRecentSessions>>,
    boundSessionId?: string,
    sortedByProject = false
  ): string {
    const lines = [
      `# ${title}`,
      "",
      sortedByProject ? "- sorted by: `project`, `time desc`" : "- sorted by: `time desc`",
      ""
    ];
    for (const [index, session] of sessions.entries()) {
      const flags = [session.sessionId === boundSessionId ? "bound" : ""].filter(Boolean);
      lines.push(
        `${index + 1}. \`${session.sessionId}\`${flags.length ? ` (${flags.join(", ")})` : ""}`
      );
      lines.push(`   - project: \`${escapeMarkdownCell(session.cwd || "(unknown)")}\``);
      lines.push(`   - time: ${escapeMarkdownCell(session.createdAt || "(unknown)")}`);
      lines.push(`   - about: ${escapeMarkdownCell(session.preview || "(no preview)")}`);
    }
    return lines.join("\n");
  }

  private sortSessionsForDisplay(
    sessions: Awaited<ReturnType<typeof listRecentSessions>>,
    byProject: boolean
  ): Awaited<ReturnType<typeof listRecentSessions>> {
    if (!byProject) {
      return sessions;
    }
    return [...sessions].sort((a, b) => {
      const projectCompare = (a.cwd || "").localeCompare(b.cwd || "");
      if (projectCompare !== 0) return projectCompare;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
  }

  private renderProjectList(
    title: string,
    projects: ProjectListEntry[],
    currentProject: string
  ): string {
    const lines = [`# ${title}`, ""];
    for (const [index, item] of projects.entries()) {
      const flags = [
        item.project === currentProject ? "current" : "",
        item.bound ? "bound" : "",
        item.trusted ? "trusted" : ""
      ].filter(Boolean);
      lines.push(`${index + 1}. \`${item.project}\`${flags.length ? ` (${flags.join(", ")})` : ""}`);
      if (item.updatedAt) {
        lines.push(`   - updated: ${item.updatedAt}`);
      }
    }
    return lines.join("\n");
  }
}

interface ProjectListEntry {
  project: string;
  bound: boolean;
  trusted: boolean;
  updatedAt?: string;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
