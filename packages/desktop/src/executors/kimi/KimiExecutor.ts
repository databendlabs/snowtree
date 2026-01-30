/**
 * KimiExecutor - Kimi CLI executor
 * Runs Kimi CLI in print + stream-json mode and parses JSONL output
 */

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

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
import { cliLogger } from '../../infrastructure/logging/cliLogger';
import { KimiMessageParser } from './KimiMessageParser';

const execAsync = promisify(exec);

export class KimiExecutor extends AbstractExecutor {
  private messageParser: KimiMessageParser;
  private jsonFragmentByPanel = new Map<string, { buf: string; startedAtMs: number }>();
  private sessionIdByPanel = new Map<string, string>();
  private agentSessionEmitted = new Set<string>();

  constructor(
    sessionManager: SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(sessionManager, logger, configManager);
    this.messageParser = new KimiMessageParser();

    this.on('exit', (data: { sessionId: string; exitCode: number | null }) => {
      const session = this.sessionManager.getSession(data.sessionId);
      if (!session || session.status === 'stopped') return;
      if (data.exitCode === null) return;

      if (data.exitCode === 0) {
        this.sessionManager.updateSessionStatus(data.sessionId, 'waiting');
      } else {
        this.sessionManager.updateSessionStatus(data.sessionId, 'error', `Kimi CLI exited with code ${data.exitCode}`);
      }
    });
  }

  getToolType(): ExecutorTool {
    return 'kimi';
  }

  getToolName(): string {
    return 'Kimi CLI';
  }

  protected getSpawnTransport(): 'pty' | 'stdio' {
    return 'stdio';
  }

  getCommandName(): string {
    return 'kimi';
  }

  getCustomExecutablePath(): string | undefined {
    return this.configManager?.getConfig()?.kimiExecutablePath as string | undefined;
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

  async spawn(options: ExecutorSpawnOptions): Promise<void> {
    const sessionId = this.getOrCreateSessionId(options);
    const nextOptions: ExecutorSpawnOptions = {
      ...options,
      agentSessionId: sessionId,
      isResume: options.isResume || Boolean(options.agentSessionId),
    };

    if (!this.agentSessionEmitted.has(options.panelId)) {
      this.agentSessionEmitted.add(options.panelId);
      this.emit('agentSessionId', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        agentSessionId: sessionId,
      });
    }

    return super.spawn(nextOptions);
  }

  buildCommandArgs(options: ExecutorSpawnOptions): string[] {
    const { prompt, worktreePath } = options;
    const imagePaths =
      Array.isArray((options as unknown as { imagePaths?: unknown }).imagePaths)
        ? ((options as unknown as { imagePaths: unknown[] }).imagePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        : [];

    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--work-dir', worktreePath,
    ];

    const sessionId = this.getOrCreateSessionId(options);
    args.push('--session', sessionId);

    if (typeof options.model === 'string' && options.model.trim()) {
      args.push('--model', options.model.trim());
    }

    const basePrompt = String(prompt ?? '');
    const promptWithAttachments =
      imagePaths.length > 0
        ? [
            basePrompt,
            '',
            'Attached images:',
            ...imagePaths.map((p) => {
              const rel = path.relative(worktreePath, p);
              const displayPath = rel.startsWith('..') ? p : rel;
              return `@${displayPath}`;
            }),
          ]
            .filter(Boolean)
            .join('\n')
        : basePrompt;

    if (promptWithAttachments.length > 0 || imagePaths.length > 0) {
      args.push('--prompt', promptWithAttachments);
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
      }
    }
    this.logger?.verbose(`Cleaned up Kimi resources for session ${sessionId}`);
  }

  parseOutput(data: string, panelId: string, sessionId: string): void {
    const trimmed = String(data ?? '').trim();
    if (!trimmed) return;

    try {
      const prior = this.jsonFragmentByPanel.get(panelId);
      const combined = prior ? `${prior.buf}\n${trimmed}` : trimmed;
      const message = JSON.parse(combined) as Record<string, unknown>;
      this.jsonFragmentByPanel.delete(panelId);

      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: message,
        timestamp: new Date(),
      } as ExecutorOutputEvent);

      const entries = this.messageParser.parseMessage(message);
      for (const entry of entries) {
        this.handleNormalizedEntry(panelId, sessionId, entry);
      }
    } catch (parseError) {
      if (trimmed.startsWith('{')) {
        const existing = this.jsonFragmentByPanel.get(panelId);
        const startedAtMs = existing?.startedAtMs ?? Date.now();
        const nextBuf = existing ? `${existing.buf}\n${trimmed}` : trimmed;
        const ageMs = Date.now() - startedAtMs;

        if (nextBuf.length > 256_000) {
          this.logger?.warn(`[Kimi] Dropping oversized JSON fragment (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)} len=${nextBuf.length})`);
          this.jsonFragmentByPanel.delete(panelId);
          return;
        }

        this.jsonFragmentByPanel.set(panelId, { buf: nextBuf, startedAtMs });
        if (ageMs > 1500) {
          const snippet = nextBuf.length > 220 ? `${nextBuf.slice(0, 220)}…` : nextBuf;
          this.logger?.warn(`[Kimi] Buffering partial JSON (${Math.round(ageMs)}ms) (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${snippet}`);
        }
        return;
      }

      cliLogger.info('Kimi', panelId, `Non-JSON output: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? '...' : ''}`);
      this.emit('output', {
        panelId,
        sessionId,
        type: 'stdout',
        data: trimmed,
        timestamp: new Date(),
      } as ExecutorOutputEvent);
    }
  }

  private getOrCreateSessionId(options: ExecutorSpawnOptions): string {
    const provided = typeof options.agentSessionId === 'string' ? options.agentSessionId.trim() : '';
    if (provided) {
      this.sessionIdByPanel.set(options.panelId, provided);
      return provided;
    }

    const existing = this.sessionIdByPanel.get(options.panelId);
    if (existing) return existing;

    const created = randomUUID();
    this.sessionIdByPanel.set(options.panelId, created);
    return created;
  }
}

export default KimiExecutor;
