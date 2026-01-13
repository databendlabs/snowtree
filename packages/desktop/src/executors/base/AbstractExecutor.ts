/**
 * AbstractExecutor - Base class for CLI tool executors
 * Inspired by vibe-kanban's StandardCodingAgentExecutor
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import type { Logger } from '../../infrastructure/logging/logger';
import type { ConfigManager } from '../../infrastructure/config/configManager';
import type { SessionManager } from '../../features/session/SessionManager';
import { getShellPath } from '../../infrastructure/command/shellPath';
import { findNodeExecutable } from '../../infrastructure/utils/nodeFinder';
import { cliLogger } from '../../infrastructure/logging/cliLogger';
import type { CliTool } from '../../infrastructure/logging/cliLogger';
import { DiffMetadataExtractor } from './DiffMetadataExtractor';

import type {
  ExecutorTool,
  ExecutorSpawnOptions,
  ExecutorProcess,
  ExecutorAvailability,
  ExecutorOutputEvent,
  ExecutorExitEvent,
  ExecutorErrorEvent,
  ExecutorSpawnedEvent,
  ExecutorEvents,
  NormalizedEntry,
} from '../types';

const execAsync = promisify(exec);

interface AvailabilityCache {
  result: ExecutorAvailability;
  timestamp: number;
}

/**
 * Abstract base class for CLI tool executors
 * Provides common functionality for spawning and managing CLI processes
 */
export abstract class AbstractExecutor extends EventEmitter {
  protected processes: Map<string, ExecutorProcess> = new Map();
  protected availabilityCache: AvailabilityCache | null = null;
  protected readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private cliOperationByPanel = new Map<string, { operationId: string; startMs: number }>();
  private pendingToolOpByPanel = new Map<string, Array<{ operationId: string; startMs: number; kind: 'git.command' | 'cli.command'; toolUseId?: string }>>();
  private pendingToolOpByPanelId = new Map<string, Map<string, { startMs: number; kind: 'git.command' | 'cli.command'; operationId?: string }>>();
  protected runtimeMetaByPanel = new Map<string, { cliModel?: string; cliReasoningEffort?: string; cliSandbox?: string; cliAskForApproval?: string }>();
  private pendingQuestions = new Map<string, { toolUseId: string; questions: unknown }>();
  private activeThinkingByPanel = new Map<string, { seq: number; thinkingId: string }>();
  private terminationByPanel = new Map<string, { reason: 'interrupted' | 'terminated'; atMs: number }>();

  constructor(
    protected sessionManager: SessionManager,
    protected logger?: Logger,
    protected configManager?: ConfigManager
  ) {
    super();
    this.setMaxListeners(50);
  }

  // ============================================================================
  // Abstract Methods - Must be implemented by subclasses
  // ============================================================================

  /** Get the executor tool type */
  abstract getToolType(): ExecutorTool;

  /** Get the CLI tool name for display */
  abstract getToolName(): string;

  /** Get the CLI command name (e.g., 'claude', 'codex') */
  abstract getCommandName(): string;

  /** Get custom executable path from config */
  abstract getCustomExecutablePath(): string | undefined;

  /** Test CLI availability */
  abstract testAvailability(customPath?: string): Promise<ExecutorAvailability>;

  /** Build command arguments */
  abstract buildCommandArgs(options: ExecutorSpawnOptions): string[];

  /** Initialize CLI environment (returns env vars) */
  abstract initializeEnvironment(options: ExecutorSpawnOptions): Promise<Record<string, string>>;

  /** Clean up resources when process ends */
  abstract cleanupResources(sessionId: string): Promise<void>;

  /** Parse CLI output and emit events */
  abstract parseOutput(data: string, panelId: string, sessionId: string): void;

  // ============================================================================
  // Common Methods
  // ============================================================================

  /**
   * Some executors run a long-lived background process (e.g. `codex app-server`).
   * In those cases, the spawn command should be marked Done once the process is ready,
   * rather than staying Running until the process exits.
   */
  protected shouldFinalizeSpawnCommandOnSpawn(): boolean {
    return false;
  }

  /** Get CLI tool type for logging */
  protected getCliLogType(): CliTool {
    const type = this.getToolType();
    if (type === 'claude') return 'Claude';
    if (type === 'codex') return 'Codex';
    return 'CLI';
  }

  /** Get executable path */
  async getExecutablePath(): Promise<string> {
    const customPath = this.getCustomExecutablePath();
    if (customPath) {
      this.logger?.info(`[${this.getCommandName()}] Using custom path: ${customPath}`);
      return customPath;
    }
    return this.getCommandName();
  }

  /** Get cached availability */
  async getCachedAvailability(): Promise<ExecutorAvailability> {
    if (
      this.availabilityCache &&
      Date.now() - this.availabilityCache.timestamp < this.CACHE_TTL
    ) {
      return this.availabilityCache.result;
    }

    const result = await this.testAvailability();
    this.availabilityCache = { result, timestamp: Date.now() };
    return result;
  }

  /** Clear availability cache */
  clearAvailabilityCache(): void {
    this.availabilityCache = null;
  }

  /** Get enhanced system environment */
  protected async getSystemEnvironment(): Promise<Record<string, string>> {
    const shellPath = getShellPath();
    const nodePath = await findNodeExecutable();
    const nodeDir = path.dirname(nodePath);
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const enhancedPath = nodeDir + pathSeparator + shellPath;

    return {
      ...process.env,
      PATH: enhancedPath,
    } as Record<string, string>;
  }

  /** Spawn a CLI process */
  async spawn(options: ExecutorSpawnOptions): Promise<void> {
    const { panelId, sessionId, worktreePath, prompt, isResume } = options;
    const tool = this.getCliLogType();

    try {
      // Check availability
      const availability = await this.getCachedAvailability();
      if (!availability.available) {
        await this.handleNotAvailable(availability, panelId, sessionId);
        throw new Error(`${this.getToolName()} not available: ${availability.error}`);
      }

      // Build command
      const args = this.buildCommandArgs(options);
      const cliEnv = await this.initializeEnvironment(options);
      const systemEnv = await this.getSystemEnvironment();
      const env = { ...systemEnv, ...cliEnv };
      const command = await this.getExecutablePath();

      const operationId = randomUUID();
      const startMs = Date.now();
      this.cliOperationByPanel.set(panelId, { operationId, startMs });

      // Log request
      cliLogger.request({
        tool,
        panelId,
        worktreePath,
        command,
        args,
      });

      const displayCommand = this.buildDisplayCommand(command, args);
      const optionRecord = options as unknown as Record<string, unknown>;
      const runtimeMeta = {
        cliModel: typeof optionRecord.model === 'string' ? optionRecord.model : undefined,
        cliSandbox: typeof optionRecord.sandbox === 'string' ? optionRecord.sandbox : undefined,
        cliAskForApproval: typeof optionRecord.askForApproval === 'string' ? optionRecord.askForApproval : undefined,
        cliReasoningEffort: typeof optionRecord.reasoningEffort === 'string' ? optionRecord.reasoningEffort : undefined,
      };
      this.runtimeMetaByPanel.set(panelId, runtimeMeta);
      this.recordTimelineCommand({
        sessionId,
        panelId,
        kind: 'cli.command',
        status: 'started',
        command: displayCommand,
        cwd: worktreePath,
        tool: this.getToolType(),
        meta: {
          operationId,
          cliCommand: command,
          cliArgs: args,
          cliIsResume: Boolean(isResume),
          ...runtimeMeta,
        }
      });

      // Spawn PTY process
      const ptyProcess = await this.spawnPtyProcess(command, args, worktreePath, env);

      // Store process
      const executorProcess: ExecutorProcess = {
        pty: ptyProcess,
        panelId,
        sessionId,
        worktreePath,
      };
      this.processes.set(panelId, executorProcess);

      // Set up handlers
      this.setupProcessHandlers(ptyProcess, panelId, sessionId);

      // Build display command
      const displayArgs = args.map((arg, i) => {
        if (i > 0 && (args[i - 1] === '-p' || args[i - 1] === '--prompt')) {
          const truncated = arg.length > 50 ? arg.substring(0, 50) + '...' : arg;
          return `"${truncated}"`;
        }
        return arg.includes(' ') ? `"${arg}"` : arg;
      });
      const fullCommand = `${command} ${displayArgs.join(' ')}`;

      // Emit spawned event
      this.emit('spawned', { panelId, sessionId, fullCommand } as ExecutorSpawnedEvent);

      if (this.shouldFinalizeSpawnCommandOnSpawn()) {
        const op = this.cliOperationByPanel.get(panelId);
        if (op) {
          const durationMs = Date.now() - op.startMs;
          this.recordTimelineCommand({
            sessionId,
            panelId,
            kind: 'cli.command',
            status: 'finished',
            command: undefined,
            cwd: undefined,
            tool: this.getToolType(),
            durationMs,
            meta: { operationId: op.operationId }
          });
          this.cliOperationByPanel.delete(panelId);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      cliLogger.error(tool, panelId, 'Failed to spawn process', error instanceof Error ? error : undefined);

      this.emit('error', { panelId, sessionId, error: errorMessage } as ExecutorErrorEvent);
      throw error;
    }
  }

  /** Spawn PTY process with fallback */
  protected async spawnPtyProcess(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>
  ): Promise<pty.IPty> {
    if (!pty) {
      throw new Error('node-pty not available');
    }

    this.logger?.verbose(`Executing: ${command} ${args.join(' ')}`);
    this.logger?.verbose(`Working directory: ${cwd}`);

    let ptyProcess: pty.IPty;
    let attempt = 0;
    let lastError: unknown;
    const toolName = this.getToolName().toLowerCase();
    const needsNodeFallbackKey = `${toolName}NeedsNodeFallback`;

    while (attempt < 2) {
      try {
        // Add delay on Linux for multiple processes
        if (os.platform() === 'linux' && this.processes.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (attempt === 0 && !(global as unknown as Record<string, boolean>)[needsNodeFallbackKey]) {
          ptyProcess = pty.spawn(command, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd,
            env,
          });
        } else {
          // Node.js fallback
          this.logger?.verbose(`Using Node.js fallback for ${this.getToolName()}`);
          const nodePath = await findNodeExecutable();
          const nodeArgs = ['--no-warnings', '--enable-source-maps', command, ...args];
          ptyProcess = pty.spawn(nodePath, nodeArgs, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd,
            env,
          });
        }

        return ptyProcess;
      } catch (error) {
        lastError = error;
        attempt++;

        if (attempt === 1) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (
            errorMsg.includes('No such file or directory') ||
            errorMsg.includes('env: node:') ||
            errorMsg.includes('ENOENT')
          ) {
            (global as unknown as Record<string, boolean>)[needsNodeFallbackKey] = true;
            continue;
          }
        }
        break;
      }
    }

    throw lastError;
  }

  /** Set up process event handlers */
  protected setupProcessHandlers(ptyProcess: pty.IPty, panelId: string, sessionId: string): void {
    let buffer = '';
    let lineCount = 0;

    ptyProcess.onData((data: string) => {
      buffer += data;

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          lineCount++;
          this.parseOutput(line, panelId, sessionId);
        }
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      // Process remaining buffer
      if (buffer.trim()) {
        this.parseOutput(buffer, panelId, sessionId);
      }

      this.processes.delete(panelId);
      await this.cleanupResources(sessionId);

      const op = this.cliOperationByPanel.get(panelId);
      if (op) {
        const durationMs = Date.now() - op.startMs;
        const runtime = this.runtimeMetaByPanel.get(panelId) || {};
        this.recordTimelineCommand({
          sessionId,
          panelId,
          kind: 'cli.command',
          status: typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'finished',
          command: undefined,
          cwd: undefined,
          tool: this.getToolType(),
          durationMs,
          exitCode: typeof exitCode === 'number' ? exitCode : undefined,
          meta: { operationId: op.operationId, ...runtime }
        });
        this.cliOperationByPanel.delete(panelId);
      }

      // Clean up any pending tool operations that didn't get a result
      // This happens when the process exits before tool_result messages arrive
      const byId = this.pendingToolOpByPanelId.get(panelId);
      if (byId && byId.size > 0) {
        const isError = typeof exitCode === 'number' && exitCode !== 0;
        for (const [toolUseId, toolOp] of byId.entries()) {
          const durationMs = Date.now() - toolOp.startMs;
          this.recordTimelineCommand({
            sessionId,
            panelId,
            kind: toolOp.kind,
            status: isError ? 'failed' : 'finished',
            durationMs,
            tool: this.getToolType(),
            meta: { operationId: toolOp.operationId || toolUseId },
          });
        }
        this.pendingToolOpByPanelId.delete(panelId);
      }
      this.pendingToolOpByPanel.delete(panelId);
      this.activeThinkingByPanel.delete(panelId);

      this.emit('exit', { panelId, sessionId, exitCode, signal } as ExecutorExitEvent);
      cliLogger.complete(this.getCliLogType(), panelId, exitCode);
    });
  }

  protected async handleNormalizedEntry(panelId: string, sessionId: string, entry: NormalizedEntry): Promise<void> {
    const entryMeta = {
      ...(entry.metadata || {}),
      panelId,
      sessionId,
      tool: this.getToolType(),
    };
    const enriched: NormalizedEntry = { ...entry, metadata: entryMeta };

    this.emit('entry', enriched);

    const meta = (enriched.metadata || {}) as Record<string, unknown>;
    const modelFromMeta = typeof meta.model === 'string' ? meta.model : undefined;
    const sandboxFromMeta = typeof meta.sandbox === 'string' ? meta.sandbox : undefined;
    const approvalFromMeta = typeof meta.approval_policy === 'string' ? meta.approval_policy : undefined;
    const reasoningFromMeta = typeof meta.reasoningEffort === 'string'
      ? meta.reasoningEffort
      : typeof meta.reasoning_effort === 'string'
        ? meta.reasoning_effort
        : undefined;

    if (modelFromMeta || sandboxFromMeta || approvalFromMeta || reasoningFromMeta) {
      const current = this.runtimeMetaByPanel.get(panelId) || {};
      this.runtimeMetaByPanel.set(panelId, {
        ...current,
        cliModel: modelFromMeta || current.cliModel,
        cliSandbox: sandboxFromMeta || current.cliSandbox,
        cliAskForApproval: approvalFromMeta || current.cliAskForApproval,
        cliReasoningEffort: reasoningFromMeta || current.cliReasoningEffort,
      });
    }

    const action = enriched.actionType;
    if (enriched.entryType === 'tool_use' && action?.type) {
      const operationId = enriched.id || randomUUID();
      // Use toolUseId from Claude's message for linking with tool_result
      const toolUseId = enriched.toolUseId || operationId;
      const display = (enriched.content || '').trim();
      if (!display) return;

      const kind: 'git.command' | 'cli.command' =
        action.type === 'command_run' && action.command && /^(git|gh)\b/.test(action.command.trim())
          ? 'git.command'
          : 'cli.command';

      const startMs = Date.now();
      const stack = this.pendingToolOpByPanel.get(panelId) || [];
      stack.push({ operationId, startMs, kind, toolUseId });
      this.pendingToolOpByPanel.set(panelId, stack);

      // Use toolUseId as key for direct lookup by tool_result
      const byId = this.pendingToolOpByPanelId.get(panelId) || new Map();
      byId.set(toolUseId, { startMs, kind, operationId });
      this.pendingToolOpByPanelId.set(panelId, byId);

      const cwd = this.sessionManager.getSession(sessionId)?.worktreePath;
      const runtime = this.runtimeMetaByPanel.get(panelId) || {};

      // Extract diff metadata for Edit, Write, Bash rm, and Codex tools
      const extractor = new DiffMetadataExtractor({ cwd: cwd || process.cwd() });
      const diffMetadata = await extractor.extract(
        enriched.toolName || '',
        enriched.metadata
      );

      // Build diff meta for timeline
      const diffMeta = diffMetadata && diffMetadata.length > 0
        ? {
            // For single file, use flat structure (backwards compatible)
            ...(diffMetadata.length === 1 ? {
              oldString: diffMetadata[0].oldString,
              newString: diffMetadata[0].newString,
              filePath: diffMetadata[0].filePath,
              isDelete: diffMetadata[0].isDelete,
              isNewFile: diffMetadata[0].isNewFile,
            } : {
              // For multiple files (e.g., rm file1 file2)
              diffFiles: diffMetadata,
            }),
          }
        : {};

      this.recordTimelineCommand({
        sessionId,
        panelId,
        kind,
        status: 'started',
        command: display,
        cwd,
        tool: this.getToolType(),
        meta: {
          operationId,
          source: 'agent',
          toolName: enriched.toolName,
          agentActionType: action.type,
          agentPath: 'path' in action ? (action as { path?: string }).path : undefined,
          agentQuery: 'query' in action ? (action as { query?: string }).query : undefined,
          agentUrl: 'url' in action ? (action as { url?: string }).url : undefined,
          ...runtime,
          ...diffMeta,
        }
      });
      return;
    }

    // Handle thinking events
    if (enriched.entryType === 'thinking') {
      // Codex app-server emits short single-line "phase" markers ("Searching", "Respond", etc.)
      // as thinking updates. They're useful as transient status but too noisy for the timeline.
      if (this.getToolType() === 'codex') {
        const text = (enriched.content || '').trim();
        if (!text) return;
        if (!text.includes('\n') && text.length <= 120) return;
      }
      this.recordTimelineThinking({
        sessionId,
        panelId,
        thinkingId: enriched.id,  // Use entry ID as thinking_id for streaming updates
        content: enriched.content || '',
        isStreaming: Boolean(enriched.metadata?.streaming),
      });
      return;
    }

    // Handle user_question events (AskUserQuestion tool)
    if (enriched.entryType === 'user_question') {
      this.recordTimelineUserQuestion({
        sessionId,
        panelId,
        toolUseId: (enriched.metadata?.tool_use_id as string) || '',
        questions: enriched.metadata?.questions,
      });

      // Store pending question for later answer
      this.pendingQuestions.set(panelId, {
        toolUseId: (enriched.metadata?.tool_use_id as string) || '',
        questions: enriched.metadata?.questions,
      });
      return;
    }

    // Handle tool_result for non-command tools (Read, Edit, Grep, etc.)
    if (enriched.entryType === 'tool_result' && enriched.toolStatus && enriched.toolStatus !== 'pending') {
      // Use toolUseId from Claude's message to find the matching tool_use
      const toolUseId = enriched.toolUseId;
      const byId = this.pendingToolOpByPanelId.get(panelId);
      const opFromId = toolUseId && byId ? byId.get(toolUseId) : undefined;
      if (toolUseId && byId) byId.delete(toolUseId);
      if (byId && byId.size === 0) this.pendingToolOpByPanelId.delete(panelId);

      let kind: 'git.command' | 'cli.command' | undefined = opFromId?.kind;
      let startMs: number | undefined = opFromId?.startMs;
      let operationId: string | undefined = opFromId?.operationId || enriched.id || undefined;

      if (!kind || !startMs) {
        const stack = this.pendingToolOpByPanel.get(panelId);
        // Try to find matching entry by toolUseId first
        let matchIdx = -1;
        if (toolUseId && stack) {
          matchIdx = stack.findIndex(item => item.toolUseId === toolUseId);
        }
        const matched = matchIdx >= 0 ? stack?.splice(matchIdx, 1)[0] : stack?.pop();
        if (stack && stack.length === 0) this.pendingToolOpByPanel.delete(panelId);
        if (!matched) {
          // This is a non-command tool result (Read, Edit, Grep, etc.)
          // Record it as a tool_result event instead of command
          this.recordTimelineToolResult({
            sessionId,
            panelId,
            toolUseId: toolUseId || enriched.id,
            toolName: enriched.toolName,
            content: enriched.content,
            isError: enriched.toolStatus === 'failed',
            exitCode: undefined,
          });
          return;
        }
        kind = matched.kind;
        startMs = matched.startMs;
        operationId = matched.operationId;
      }

      if (!kind || !startMs) return;
      const durationMs = Date.now() - startMs;
      const cwd = this.sessionManager.getSession(sessionId)?.worktreePath;
      const meta = (enriched.metadata || {}) as Record<string, unknown>;
      const exitCode = typeof meta.exit_code === 'number'
        ? (meta.exit_code as number)
        : typeof meta.exitCode === 'number'
          ? (meta.exitCode as number)
          : undefined;
      this.recordTimelineCommand({
        sessionId,
        panelId,
        kind,
        status: enriched.toolStatus === 'failed' ? 'failed' : 'finished',
        command: undefined,
        cwd,
        tool: this.getToolType(),
        durationMs,
        exitCode,
        meta: {
          operationId,
          // Include error content as stderr so it displays in the UI
          stderr: enriched.toolStatus === 'failed' && enriched.content ? enriched.content : undefined,
        }
      });
    }
  }

  private recordTimelineCommand(args: {
    sessionId: string;
    panelId?: string;
    kind: 'cli.command' | 'git.command';
    status: 'started' | 'finished' | 'failed';
    command?: string;
    cwd?: string;
    tool?: ExecutorTool;
    durationMs?: number;
    exitCode?: number;
    meta?: Record<string, unknown>;
  }): void {
    try {
      this.sessionManager.addTimelineEvent({
        session_id: args.sessionId,
        panel_id: args.panelId,
        kind: args.kind,
        status: args.status,
        command: args.command,
        cwd: args.cwd,
        duration_ms: args.durationMs,
        exit_code: args.exitCode,
        tool: args.tool,
        meta: args.meta,
      });
    } catch {
      // Best-effort audit log; never break execution.
    }
  }

  private recordTimelineThinking(args: {
    sessionId: string;
    panelId?: string;
    thinkingId: string;
    content: string;
    isStreaming: boolean;
  }): void {
    try {
      this.sessionManager.addTimelineEvent({
        session_id: args.sessionId,
        panel_id: args.panelId,
        kind: 'thinking',
        tool: this.getToolType(),
        thinking_id: args.thinkingId,  // Use this for UPSERT
        content: args.content,
        is_streaming: args.isStreaming ? 1 : 0,
      });
    } catch {
      // Best-effort audit log; never break execution.
    }
  }

  protected recordTimelineUserQuestion(args: {
    sessionId: string;
    panelId?: string;
    toolUseId: string;
    questions: unknown;
  }): void {
    try {
      this.sessionManager.addTimelineEvent({
        session_id: args.sessionId,
        panel_id: args.panelId,
        kind: 'user_question',
        tool_use_id: args.toolUseId,
        questions: typeof args.questions === 'string' ? args.questions : JSON.stringify(args.questions),
        status: 'pending',
      });
    } catch {
      // Best-effort audit log; never break execution.
    }
  }

  private recordTimelineToolResult(args: {
    sessionId: string;
    panelId?: string;
    toolUseId?: string;
    toolName?: string;
    content?: string;
    isError: boolean;
    exitCode?: number;
  }): void {
    try {
      this.sessionManager.addTimelineEvent({
        session_id: args.sessionId,
        panel_id: args.panelId,
        kind: 'tool_result',
        tool_use_id: args.toolUseId,
        tool_name: args.toolName,
        content: args.content,
        is_error: args.isError ? 1 : 0,
        exit_code: args.exitCode,
      });
    } catch {
      // Best-effort audit log; never break execution.
    }
  }

  private buildDisplayCommand(command: string, args: string[]): string {
    const displayArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const current = args[i];
      displayArgs.push(current.includes(' ') ? `"${current}"` : current);
    }
    return `${command} ${displayArgs.join(' ')}`.trim();
  }

  /** Handle CLI not available */
  protected async handleNotAvailable(
    availability: ExecutorAvailability,
    panelId: string,
    sessionId: string
  ): Promise<void> {
    this.logger?.error(`${this.getToolName()} not available: ${availability.error}`);

    const message = [
      `Error: ${availability.error}`,
      '',
      `${this.getToolName()} is not installed or not found in PATH.`,
      '',
      `Please install ${this.getToolName()}:`,
      '1. Follow installation instructions for your platform',
      `2. Verify: "${this.getCommandName()} --version"`,
      '',
      `PATH searched: ${getShellPath()}`,
    ].join('\n');

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: {
        type: 'session',
        data: {
          status: 'error',
          message: `${this.getToolName()} not available`,
          details: message,
        },
      },
      timestamp: new Date(),
    } as ExecutorOutputEvent);

    this.sessionManager.addSessionError(
      sessionId,
      `${this.getToolName()} not available`,
      availability.error || 'Unknown error'
    );
  }

  /** Send input to process */
  sendInput(panelId: string, input: string): void {
    const process = this.processes.get(panelId);
    if (!process) {
      throw new Error(`No process found for panel ${panelId}`);
    }
    process.pty.write(input);
  }

  /** Answer a pending user question (from AskUserQuestion tool) */
  async answerQuestion(panelId: string, answers: Record<string, string | string[]>): Promise<void> {
    const tool = this.getCliLogType();

    const process = this.processes.get(panelId);
    if (!process) {
      cliLogger.error(tool, panelId, `No process found for panel ${panelId}`);
      throw new Error(`No process found for panel ${panelId}`);
    }

    // Try to get pending question from memory first
    let pending = this.pendingQuestions.get(panelId);

    // If not in memory, try to recover from database (e.g., after page refresh)
    if (!pending) {
      const timelineEvents = this.sessionManager.getTimelineEvents(process.sessionId);
      // Find the most recent pending user_question for this panel
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const event = timelineEvents[i];
        if (event.kind === 'user_question' && event.panel_id === panelId && event.status === 'pending') {
          pending = {
            toolUseId: event.tool_use_id || '',
            questions: event.questions,
          };
          break;
        }
      }
    }

    if (!pending) {
      cliLogger.error(tool, panelId, `No pending question for panel ${panelId}`);
      throw new Error(`No pending question for panel ${panelId}`);
    }

    // Construct tool_result message for the AskUserQuestion tool
    // Format: answers directly as the content (not wrapped in {answers: ...})
    const toolResult = JSON.stringify({
      type: 'tool_result',
      tool_use_id: pending.toolUseId,
      content: JSON.stringify(answers),
    });

    // Write to CLI stdin
    process.pty.write(toolResult + '\n');

    // Update Timeline status to 'answered'
    try {
      this.sessionManager.addTimelineEvent({
        session_id: process.sessionId,
        panel_id: panelId,
        kind: 'user_question',
        tool_use_id: pending.toolUseId,
        questions: typeof pending.questions === 'string' ? pending.questions : JSON.stringify(pending.questions),
        status: 'answered',
        answers: JSON.stringify(answers),
      });
    } catch (err) {
      cliLogger.error(tool, panelId, 'Failed to update timeline event', err instanceof Error ? err : undefined);
    }

    // Clean up
    this.pendingQuestions.delete(panelId);
  }

  /**
   * Update the question status in the timeline without requiring a running process.
   * Used when the process has exited and we need to resume the session.
   */
  async updateQuestionStatus(panelId: string, sessionId: string, answers: Record<string, string | string[]>): Promise<void> {
    const tool = this.getCliLogType();

    // Try to get pending question from memory first
    let pending = this.pendingQuestions.get(panelId);

    // If not in memory, try to recover from database
    if (!pending) {
      const timelineEvents = this.sessionManager.getTimelineEvents(sessionId);
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const event = timelineEvents[i];
        if (event.kind === 'user_question' && event.panel_id === panelId && event.status === 'pending') {
          pending = {
            toolUseId: event.tool_use_id || '',
            questions: event.questions,
          };
          break;
        }
      }
    }

    if (!pending) {
      return;
    }

    // Update Timeline status to 'answered'
    try {
      this.sessionManager.addTimelineEvent({
        session_id: sessionId,
        panel_id: panelId,
        kind: 'user_question',
        tool_use_id: pending.toolUseId,
        questions: typeof pending.questions === 'string' ? pending.questions : JSON.stringify(pending.questions),
        status: 'answered',
        answers: JSON.stringify(answers),
      });
    } catch (err) {
      cliLogger.error(tool, panelId, 'Failed to update timeline event', err instanceof Error ? err : undefined);
    }

    // Clean up
    this.pendingQuestions.delete(panelId);
  }

  /** Kill a process */
  protected getTerminationReason(panelId: string): 'interrupted' | 'terminated' | undefined {
    return this.terminationByPanel.get(panelId)?.reason;
  }

  private clearTermination(panelId: string): void {
    this.terminationByPanel.delete(panelId);
  }

  private finalizeInFlightOps(panelId: string, sessionId: string, reason: 'interrupted' | 'terminated'): void {
    const terminationMeta = { termination: reason };

    const cliOp = this.cliOperationByPanel.get(panelId);
    if (cliOp) {
      const durationMs = Date.now() - cliOp.startMs;
      const runtime = this.runtimeMetaByPanel.get(panelId) || {};
      this.recordTimelineCommand({
        sessionId,
        panelId,
        kind: 'cli.command',
        status: 'failed',
        durationMs,
        tool: this.getToolType(),
        meta: { operationId: cliOp.operationId, ...runtime, ...terminationMeta },
      });
      this.cliOperationByPanel.delete(panelId);
    }

    const byId = this.pendingToolOpByPanelId.get(panelId);
    if (byId) {
      for (const [toolUseId, op] of byId.entries()) {
        const durationMs = Date.now() - op.startMs;
        this.recordTimelineCommand({
          sessionId,
          panelId,
          kind: op.kind,
          status: 'failed',
          durationMs,
          tool: this.getToolType(),
          meta: { operationId: op.operationId || toolUseId, ...terminationMeta },
        });
      }
      this.pendingToolOpByPanelId.delete(panelId);
    }
    this.pendingToolOpByPanel.delete(panelId);
    this.activeThinkingByPanel.delete(panelId);
    this.pendingQuestions.delete(panelId);
  }

  async kill(panelId: string, reason: 'interrupted' | 'terminated' = 'terminated'): Promise<void> {
    const process = this.processes.get(panelId);
    if (!process) return;

    const { sessionId } = process;
    const pid = process.pty.pid;

    this.terminationByPanel.set(panelId, { reason, atMs: Date.now() });
    this.finalizeInFlightOps(panelId, sessionId, reason);

    await this.cleanupResources(sessionId);

    if (pid) {
      await this.killProcessTree(pid);
    }

    this.processes.delete(panelId);
    this.emit('exit', { panelId, sessionId, exitCode: null, signal: 9 } as ExecutorExitEvent);
    this.clearTermination(panelId);
  }

  /** Kill process tree */
  protected async killProcessTree(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        await execAsync(`taskkill /pid ${pid} /T /F`);
      } else {
        // Kill process group
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }

        // Force kill after timeout
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already dead
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Check if process is running */
  isRunning(panelId: string): boolean {
    return this.processes.has(panelId);
  }

  /** Get running process count */
  getProcessCount(): number {
    return this.processes.size;
  }

  /** Cleanup all processes */
  async cleanup(): Promise<void> {
    const panelIds = Array.from(this.processes.keys());
    await Promise.all(panelIds.map(id => this.kill(id)));
  }
}

export default AbstractExecutor;
