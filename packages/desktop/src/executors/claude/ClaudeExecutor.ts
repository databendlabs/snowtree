/**
 * ClaudeExecutor - Claude Code CLI executor
 * Handles spawning and communicating with Claude Code CLI
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import { AbstractExecutor } from '../base/AbstractExecutor';
import type {
  ExecutorTool,
  ExecutorSpawnOptions,
  ExecutorAvailability,
  ExecutorOutputEvent,
  ClaudeMessage,
} from '../types';
import type { Logger } from '../../infrastructure/logging/logger';
import type { ConfigManager } from '../../infrastructure/config/configManager';
import type { SessionManager } from '../../features/session/SessionManager';
import { findExecutableInPath } from '../../infrastructure/command/shellPath';
import { ClaudeMessageParser } from './ClaudeMessageParser';
import { cliLogger } from '../../infrastructure/logging/cliLogger';

const execAsync = promisify(exec);

interface ClaudeSpawnOptions extends ExecutorSpawnOptions {
  systemPrompt?: string;
  permissionMode?: string;
}

/**
 * Claude Code CLI Executor
 */
export class ClaudeExecutor extends AbstractExecutor {
  private messageParser: ClaudeMessageParser;
  private jsonFragmentByPanel = new Map<string, { buf: string; startedAtMs: number }>();
  private internalWarningLastMsByKey = new Map<string, number>();

  constructor(
    sessionManager: SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(sessionManager, logger, configManager);
    this.messageParser = new ClaudeMessageParser();
  }

  // ============================================================================
  // Abstract Method Implementations
  // ============================================================================

  getToolType(): ExecutorTool {
    return 'claude';
  }

  getToolName(): string {
    return 'Claude Code';
  }

  getCommandName(): string {
    return 'claude';
  }

  getCustomExecutablePath(): string | undefined {
    return this.configManager?.getConfig()?.claudeExecutablePath;
  }

  async testAvailability(customPath?: string): Promise<ExecutorAvailability> {
    try {
      const commandName = this.getCommandName();
      const resolved = customPath || (await findExecutableInPath(commandName)) || commandName;

      // Test with --version
      const command = resolved.includes(' ') ? `"${resolved}"` : resolved;
      const env = await this.getSystemEnvironment();
      const { stdout } = await execAsync(`${command} --version`, {
        timeout: 10000,
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
    const { prompt, isResume, agentSessionId } = options as ClaudeSpawnOptions;

    const args: string[] = [
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];

    // Plan mode uses --permission-mode plan to prevent code modifications
    // Otherwise use the specified permission mode or default to bypassPermissions
    let permissionMode: string;
    if (options.planMode) {
      permissionMode = 'plan';
    } else if (typeof options.permissionMode === 'string') {
      permissionMode = options.permissionMode;
    } else {
      permissionMode = 'bypassPermissions';
    }
    args.push('--permission-mode', permissionMode);

    if (typeof options.model === 'string' && options.model.trim()) {
      args.push('--model', options.model.trim());
    }

    // Resume or new session
    if (isResume && agentSessionId) {
      args.push('--resume', agentSessionId);
    }

    // Add prompt
    if (prompt) {
      args.push('-p', prompt);
    }

    return args;
  }

  async initializeEnvironment(options: ExecutorSpawnOptions): Promise<Record<string, string>> {
    const { worktreePath, sessionId } = options;
    const claudeOptions = options as ClaudeSpawnOptions;
    const env: Record<string, string> = {};

    // Set working directory
    env.PWD = worktreePath;

    // Add system prompt if provided
    if (claudeOptions.systemPrompt) {
      env.CLAUDE_SYSTEM_PROMPT = claudeOptions.systemPrompt;
    }

    // Add API key from config if available
    const apiKey = this.configManager?.getAnthropicApiKey();
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    // Disable color output for cleaner parsing
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0';

    return env;
  }

  async cleanupResources(sessionId: string): Promise<void> {
    // Claude doesn't need specific cleanup
    this.logger?.verbose(`Cleaning up Claude resources for session ${sessionId}`);
  }

  private stripAnsiAndControlNoise(text: string): string {
    return text
      .replace(/\u0000/g, '')
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
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

  parseOutput(data: string, panelId: string, sessionId: string): void {
    const trimmed = this.stripAnsiAndControlNoise(String(data ?? '')).trim();
    if (!trimmed) return;

    try {
      // Try to parse as JSON
      const prior = this.jsonFragmentByPanel.get(panelId);
      const combined = prior ? `${prior.buf}\n${trimmed}` : trimmed;
      const message = JSON.parse(combined) as ClaudeMessage;
      this.jsonFragmentByPanel.delete(panelId);

      // Log parsed message type for debugging
      const msgType = message.type || 'unknown';
      const stopReason = message.type === 'assistant' && message.message?.stop_reason;
      cliLogger.info('Claude', panelId, `Parsed JSON: type=${msgType}, stop_reason=${stopReason || 'N/A'}`);

      // Extract session ID if available - emit for panel manager to handle
      if ('session_id' in message && message.session_id) {
        this.emit('agentSessionId', {
          panelId,
          sessionId,
          agentSessionId: message.session_id,
        });
      }

      // Emit raw JSON output
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: message,
        timestamp: new Date(),
      } as ExecutorOutputEvent);

      // Parse and emit normalized entry
      const entry = this.messageParser.parseMessage(message);
      if (entry) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        const isStreaming = meta?.streaming;
        cliLogger.info('Claude', panelId, `Entry: ${entry.entryType}, streaming=${isStreaming}, contentLen=${typeof entry.content === 'string' ? entry.content.length : 0}`);
        this.handleNormalizedEntry(panelId, sessionId, entry);
      }

      // Extract and emit tool_use blocks from assistant messages
      if (message.type === 'assistant' && message.message?.content) {
        this.extractAndEmitToolCalls(message.message.content, panelId, sessionId);
      }

      // Extract and emit tool_result blocks from user messages
      if (message.type === 'user' && message.message?.content) {
        this.extractAndEmitToolResults(message.message.content, panelId, sessionId);
      }

      // Align session status semantics with Codex/Claude Code: per-turn completion
      // should transition the session out of "running" even if the process stays alive.
      if (message.type === 'result') {
        const resultError = message.is_error ? (message.error || 'Claude error') : null;
        cliLogger.info('Claude', panelId, `Result message: is_error=${message.is_error}, error=${resultError}`);
        if (message.is_error) {
          this.sessionManager.updateSessionStatus(sessionId, 'error', resultError || 'Claude error');
        } else {
          this.sessionManager.updateSessionStatus(sessionId, 'waiting');
        }
      }
    } catch (parseError) {
      // Claude is expected to be line-delimited JSON (stream-json). If we fail to parse and it looks like JSON,
      // buffer for the next line; otherwise treat as stdout but surface a warning to aid debugging.
      if (trimmed.startsWith('{') && (trimmed.includes('"type"') || trimmed.includes('"message"'))) {
        const existing = this.jsonFragmentByPanel.get(panelId);
        const startedAtMs = existing?.startedAtMs ?? Date.now();
        const nextBuf = existing ? `${existing.buf}\n${trimmed}` : trimmed;
        const ageMs = Date.now() - startedAtMs;

        if (nextBuf.length > 256_000) {
          this.logger?.warn(`[Claude] Dropping oversized JSON fragment (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)} len=${nextBuf.length})`);
          this.maybeEmitInternalWarning(
            panelId,
            sessionId,
            'claude-json-fragment',
            `Dropped an oversized Claude JSON fragment (len=${nextBuf.length}). This can cause missing messages/commands. Check dev logs for details.`
          );
          this.jsonFragmentByPanel.delete(panelId);
          return;
        }

        this.jsonFragmentByPanel.set(panelId, { buf: nextBuf, startedAtMs });
        if (ageMs > 1500) {
          const snippet = nextBuf.length > 220 ? `${nextBuf.slice(0, 220)}…` : nextBuf;
          this.logger?.warn(`[Claude] Buffering partial JSON (${Math.round(ageMs)}ms) (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${snippet}`);
          this.maybeEmitInternalWarning(
            panelId,
            sessionId,
            'claude-json-fragment',
            `Buffering partial Claude JSON output (>1.5s). Output may be incomplete until parsing recovers. Check dev logs for details.`
          );
        }
        return;
      }

      // Not JSON, emit as stdout and log
      cliLogger.info('Claude', panelId, `Non-JSON output: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? '...' : ''}`);
      if (trimmed.includes('Error') || trimmed.includes('Failed')) {
        this.logger?.warn(`[Claude] Non-JSON output in stream-json mode (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${trimmed.slice(0, 220)}${trimmed.length > 220 ? '…' : ''}`);
        this.maybeEmitInternalWarning(
          panelId,
          sessionId,
          'claude-non-json',
          `Received non-JSON output from Claude in stream-json mode. This may indicate a CLI crash or protocol mismatch. Check dev logs for details.`
        );
      }
      this.emit('output', {
        panelId,
        sessionId,
        type: 'stdout',
        data: trimmed,
        timestamp: new Date(),
      } as ExecutorOutputEvent);
    }
  }

  // ============================================================================
  // Claude-specific Methods
  // ============================================================================

  /**
   * Resume an existing Claude conversation
   */
  async resume(options: ExecutorSpawnOptions): Promise<void> {
    return this.spawn({
      ...options,
      isResume: true,
    });
  }

  /**
   * Send a follow-up message to an existing conversation
   */
  async sendFollowUp(panelId: string, message: string): Promise<void> {
    const process = this.processes.get(panelId);
    if (!process) {
      throw new Error(`No Claude process found for panel ${panelId}`);
    }

    this.sendInput(panelId, message + '\n');
  }

  /**
   * Extract tool_result blocks from user message content and emit them as tool_result entries
   */
  private extractAndEmitToolResults(
    content: Array<{ type: string; [key: string]: unknown }>,
    panelId: string,
    sessionId: string
  ): void {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const toolResultBlock = block as { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };
        const toolUseId = toolResultBlock.tool_use_id;

        cliLogger.info('Claude', panelId, `Extracted tool_result: tool_use_id=${toolUseId}, is_error=${toolResultBlock.is_error}`);

        // Create tool_result message for the parser
        const toolResultMessage = {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          result: toolResultBlock.content,
          is_error: toolResultBlock.is_error,
        };

        const entry = this.messageParser.parseMessage(toolResultMessage);
        if (entry) {
          this.handleNormalizedEntry(panelId, sessionId, entry);
        }
      }
    }
  }

  /**
   * Extract tool_use blocks from assistant message content and emit them as tool_use entries
   */
  private extractAndEmitToolCalls(
    content: Array<{ type: string; [key: string]: unknown }>,
    panelId: string,
    sessionId: string
  ): void {
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
        const toolName = toolUseBlock.name || 'unknown';
        const input = toolUseBlock.input || {};

        cliLogger.info('Claude', panelId, `Extracted tool_use: ${toolName}`);

        // Special handling for AskUserQuestion - create timeline event and store pending question
        if (toolName === 'AskUserQuestion') {
          const questions = input.questions;
          if (questions) {
            // Create a user_question normalized entry and let handleNormalizedEntry process it
            // This ensures pendingQuestions.set() is called correctly
            const userQuestionEntry = {
              id: toolUseBlock.id,
              timestamp: new Date().toISOString(),
              entryType: 'user_question' as const,
              content: '',
              metadata: {
                tool_use_id: toolUseBlock.id,
                questions,
              },
            };
            this.handleNormalizedEntry(panelId, sessionId, userQuestionEntry);
          }
          continue; // Skip regular tool_use handling
        }

        // Regular tool_use handling for other tools
        // Create and emit tool_use entry using the message parser
        const toolUseMessage = {
          type: 'tool_use' as const,
          tool_name: toolName,
          tool_use_id: toolUseBlock.id,  // Include tool_use_id for linking with tool_result
          input,
        };

        const entry = this.messageParser.parseMessage(toolUseMessage);
        if (entry) {
          this.handleNormalizedEntry(panelId, sessionId, entry);
        }
      }
    }
  }

  /**
   * Interrupt current operation (Ctrl+C)
   */
  interrupt(panelId: string): void {
    if (!this.processes.has(panelId)) return;
    this.sendInput(panelId, '\x03');
    cliLogger.info('Claude', panelId, 'Sent interrupt signal');
  }
}

export default ClaudeExecutor;
