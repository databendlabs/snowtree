/**
 * GeminiExecutor - Gemini CLI executor
 * Handles spawning and communicating with Gemini CLI via stream-json output
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { AbstractExecutor } from '../base/AbstractExecutor';
import type {
  ExecutorTool,
  ExecutorSpawnOptions,
  ExecutorAvailability,
  ExecutorOutputEvent,
} from '../types';
import type { Logger } from '../../infrastructure/logging/logger';
import type { ConfigManager } from '../../infrastructure/config/configManager';
import type { SessionManager } from '../../features/session/SessionManager';
import { findExecutableInPath } from '../../infrastructure/command/shellPath';
import { GeminiMessageParser, type GeminiStreamEvent } from './GeminiMessageParser';
import { cliLogger } from '../../infrastructure/logging/cliLogger';

const execAsync = promisify(exec);

interface GeminiSpawnOptions extends ExecutorSpawnOptions {
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
}

export class GeminiExecutor extends AbstractExecutor {
  private messageParser: GeminiMessageParser;
  private jsonFragmentByPanel = new Map<string, { buf: string; startedAtMs: number }>();
  private internalWarningLastMsByKey = new Map<string, number>();

  constructor(
    sessionManager: SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(sessionManager, logger, configManager);
    this.messageParser = new GeminiMessageParser();
  }

  getToolType(): ExecutorTool {
    return 'gemini';
  }

  getToolName(): string {
    return 'Gemini CLI';
  }

  protected getSpawnTransport(): 'pty' | 'stdio' {
    return 'stdio';
  }

  getCommandName(): string {
    return 'gemini';
  }

  getCustomExecutablePath(): string | undefined {
    return this.configManager?.getConfig()?.geminiExecutablePath;
  }

  async testAvailability(customPath?: string): Promise<ExecutorAvailability> {
    try {
      const commandName = this.getCommandName();
      const resolved = customPath || (await findExecutableInPath(commandName)) || commandName;
      const command = resolved.includes(' ') ? `"${resolved}"` : resolved;
      const env = await this.getSystemEnvironment();
      const { stdout } = await execAsync(`${command} --version`, {
        timeout: 15000,
        env,
      });

      const version = stdout.trim();
      return {
        available: true,
        version,
        path: resolved,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: errorMessage,
      };
    }
  }

  buildCommandArgs(options: ExecutorSpawnOptions): string[] {
    const geminiOptions = options as GeminiSpawnOptions;
    const { prompt, isResume, agentSessionId, planMode, panelId, sessionId, worktreePath } = options;
    const imagePaths =
      Array.isArray((options as unknown as { imagePaths?: unknown }).imagePaths)
        ? ((options as unknown as { imagePaths: unknown[] }).imagePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        : [];

    const args: string[] = [
      '--output-format', 'stream-json',
    ];

    const requestedApprovalMode = planMode ? 'plan' : geminiOptions.approvalMode;
    const planAvailability = requestedApprovalMode === 'plan'
      ? this.resolvePlanAvailability(worktreePath)
      : null;
    const approvalMode = requestedApprovalMode === 'plan'
      ? planAvailability?.enabled
        ? 'plan'
        : 'default'
      : requestedApprovalMode || 'yolo';
    if (requestedApprovalMode === 'plan' && planAvailability && !planAvailability.enabled) {
      this.maybeEmitInternalWarning(
        panelId,
        sessionId,
        'gemini-plan-disabled',
        planAvailability.reason ||
          'Gemini plan mode is unavailable. Enable experimental.plan in ~/.gemini/settings.json or the workspace .gemini/settings.json.'
      );
    }
    if (approvalMode) {
      args.push('--approval-mode', approvalMode);
    }

    if (typeof options.model === 'string' && options.model.trim()) {
      args.push('--model', options.model.trim());
    }

    if (isResume && agentSessionId) {
      args.push('--resume', agentSessionId);
    }

    const basePrompt = String(prompt ?? '');
    const promptWithAttachments =
      imagePaths.length > 0
        ? [
            basePrompt,
            '',
            'Attached images:',
            ...imagePaths.map((p, i) => {
              const rel = path.relative(worktreePath, p);
              const displayPath = rel.startsWith('..') ? p : rel;
              return `[img${i + 1}] @${displayPath}`;
            }),
          ]
            .filter(Boolean)
            .join('\n')
        : basePrompt;

    if (promptWithAttachments.length > 0 || imagePaths.length > 0) {
      args.push(promptWithAttachments);
    }

    return args;
  }

  async initializeEnvironment(options: ExecutorSpawnOptions): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    env.PWD = options.worktreePath;
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0';
    return env;
  }

  async cleanupResources(sessionId: string): Promise<void> {
    for (const [panelId, proc] of this.processes) {
      if (proc.sessionId === sessionId) {
        this.jsonFragmentByPanel.delete(panelId);
        this.messageParser.clearPanel(panelId);
      }
    }
    this.logger?.verbose(`Cleaned up Gemini resources for session ${sessionId}`);
  }

  parseOutput(data: string, panelId: string, sessionId: string): void {
    const trimmed = String(data ?? '').trim();
    if (!trimmed) return;

    try {
      const prior = this.jsonFragmentByPanel.get(panelId);
      const combined = prior ? `${prior.buf}\n${trimmed}` : trimmed;
      const message = JSON.parse(combined) as GeminiStreamEvent;
      this.jsonFragmentByPanel.delete(panelId);

      cliLogger.info('Gemini', panelId, `Parsed JSON: type=${message.type}`);

      if (message.type === 'init' && message.session_id) {
        this.emit('agentSessionId', {
          panelId,
          sessionId,
          agentSessionId: message.session_id,
        });
      }

      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: message,
        timestamp: new Date(),
      } as ExecutorOutputEvent);

      const entry = this.messageParser.parseEvent(message, panelId);
      if (entry) {
        this.handleNormalizedEntry(panelId, sessionId, entry);
      }

      if (message.type === 'result') {
        const finalEntry = this.messageParser.flushAssistantMessage(panelId, message.timestamp);
        if (finalEntry) {
          this.handleNormalizedEntry(panelId, sessionId, finalEntry);
        }
        this.messageParser.clearPanel(panelId);

        const resultError = message.status === 'error' ? message.error?.message : null;
        if (message.status === 'error') {
          this.sessionManager.updateSessionStatus(sessionId, 'error', resultError || 'Gemini error');
        } else {
          this.sessionManager.updateSessionStatus(sessionId, 'waiting');
        }
      }
    } catch (parseError) {
      if (trimmed.startsWith('{')) {
        const existing = this.jsonFragmentByPanel.get(panelId);
        const startedAtMs = existing?.startedAtMs ?? Date.now();
        const nextBuf = existing ? `${existing.buf}\n${trimmed}` : trimmed;
        const ageMs = Date.now() - startedAtMs;

        if (nextBuf.length > 256_000) {
          this.logger?.warn(`[Gemini] Dropping oversized JSON fragment (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)} len=${nextBuf.length})`);
          this.maybeEmitInternalWarning(
            panelId,
            sessionId,
            'gemini-json-fragment',
            `Dropped an oversized Gemini JSON fragment (len=${nextBuf.length}). Output may be incomplete.`
          );
          this.jsonFragmentByPanel.delete(panelId);
          return;
        }

        this.jsonFragmentByPanel.set(panelId, { buf: nextBuf, startedAtMs });
        if (ageMs > 1500) {
          const snippet = nextBuf.length > 220 ? `${nextBuf.slice(0, 220)}…` : nextBuf;
          this.logger?.warn(`[Gemini] Buffering partial JSON (${Math.round(ageMs)}ms) (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${snippet}`);
          this.maybeEmitInternalWarning(
            panelId,
            sessionId,
            'gemini-json-fragment',
            `Buffering partial Gemini JSON output (>1.5s). Output may be incomplete until parsing recovers.`,
            60_000
          );
        }
        return;
      }

      const out = trimmed;
      if (out) {
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stdout',
          data: out,
          timestamp: new Date(),
        } as ExecutorOutputEvent);
      }
    }
  }

  private maybeEmitInternalWarning(
    panelId: string,
    sessionId: string,
    code: string,
    message: string,
    minIntervalMs = 60_000
  ): void {
    const key = `${panelId}:${code}`;
    const now = Date.now();
    const last = this.internalWarningLastMsByKey.get(key) || 0;
    if (now - last < minIntervalMs) return;
    this.internalWarningLastMsByKey.set(key, now);

    const content = `Snowtree warning (${code}):\n${message}`;
    void this.handleNormalizedEntry(panelId, sessionId, {
      id: `snowtree:warn:${code}:${now}`,
      timestamp: new Date().toISOString(),
      entryType: 'thinking',
      content,
      metadata: { streaming: false, internal: true, code },
    });
  }

  private resolvePlanAvailability(worktreePath: string): { enabled: boolean; reason?: string } {
    const userSettingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
    const workspaceSettingsPath = path.join(worktreePath, '.gemini', 'settings.json');

    const userSettings = this.readSettingsFile(userSettingsPath);
    const workspaceSettings = this.readSettingsFile(workspaceSettingsPath);

    const folderTrustEnabled = this.getFolderTrustEnabled(userSettings);
    const workspaceTrusted = folderTrustEnabled
      ? this.isWorkspaceTrusted(worktreePath, this.readTrustedFoldersConfig())
      : true;

    const workspacePlan = this.getExperimentalPlan(workspaceSettings);
    if (workspacePlan !== undefined) {
      if (!workspaceTrusted) {
        return {
          enabled: false,
          reason: 'Gemini plan mode is disabled because the workspace is not trusted.',
        };
      }
      return {
        enabled: workspacePlan,
        reason: workspacePlan
          ? undefined
          : 'Gemini plan mode is disabled in the workspace .gemini/settings.json.',
      };
    }

    if (!workspaceTrusted) {
      return {
        enabled: false,
        reason: 'Gemini plan mode is disabled because the workspace is not trusted.',
      };
    }

    const userPlan = this.getExperimentalPlan(userSettings);
    if (userPlan !== undefined) {
      return {
        enabled: userPlan,
        reason: userPlan
          ? undefined
          : 'Gemini plan mode requires experimental.plan=true in ~/.gemini/settings.json.',
      };
    }

    return {
      enabled: false,
      reason: 'Gemini plan mode requires experimental.plan=true in ~/.gemini/settings.json.',
    };
  }

  private readSettingsFile(filePath: string): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        parsed = JSON.parse(stripped);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private getExperimentalPlan(settings: Record<string, unknown> | null): boolean | undefined {
    if (!settings) return undefined;
    const experimental = settings.experimental;
    if (!experimental || typeof experimental !== 'object') return undefined;
    const plan = (experimental as Record<string, unknown>).plan;
    return typeof plan === 'boolean' ? plan : undefined;
  }

  private getFolderTrustEnabled(settings: Record<string, unknown> | null): boolean {
    if (!settings) return false;
    const security = settings.security;
    if (!security || typeof security !== 'object') return false;
    const folderTrust = (security as Record<string, unknown>).folderTrust;
    if (!folderTrust || typeof folderTrust !== 'object') return false;
    const enabled = (folderTrust as Record<string, unknown>).enabled;
    return typeof enabled === 'boolean' ? enabled : false;
  }

  private readTrustedFoldersConfig(): Record<string, unknown> | null {
    const customPath = process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
    const trustedPath = customPath || path.join(os.homedir(), '.gemini', 'trustedFolders.json');
    return this.readSettingsFile(trustedPath);
  }

  private isWorkspaceTrusted(worktreePath: string, trustConfig: Record<string, unknown> | null): boolean {
    if (!trustConfig) return false;
    const trustedPaths: string[] = [];
    const untrustedPaths: string[] = [];

    for (const [rulePath, trustLevel] of Object.entries(trustConfig)) {
      if (trustLevel === 'TRUST_FOLDER') {
        trustedPaths.push(rulePath);
      } else if (trustLevel === 'TRUST_PARENT') {
        trustedPaths.push(path.dirname(rulePath));
      } else if (trustLevel === 'DO_NOT_TRUST') {
        untrustedPaths.push(rulePath);
      }
    }

    const normalizedWorktree = path.resolve(worktreePath);
    for (const trustedPath of trustedPaths) {
      if (this.isWithinRoot(normalizedWorktree, trustedPath)) {
        return true;
      }
    }

    for (const untrustedPath of untrustedPaths) {
      if (path.resolve(untrustedPath) === normalizedWorktree) {
        return false;
      }
    }

    return false;
  }

  private isWithinRoot(pathToCheck: string, rootDirectory: string): boolean {
    const normalizedPathToCheck = path.resolve(pathToCheck);
    const normalizedRootDirectory = path.resolve(rootDirectory);
    const rootWithSeparator =
      normalizedRootDirectory === path.sep || normalizedRootDirectory.endsWith(path.sep)
        ? normalizedRootDirectory
        : `${normalizedRootDirectory}${path.sep}`;

    return (
      normalizedPathToCheck === normalizedRootDirectory ||
      normalizedPathToCheck.startsWith(rootWithSeparator)
    );
  }
}

export default GeminiExecutor;
