/**
 * CodexExecutor - OpenAI Codex CLI executor
 * Handles spawning and communicating with Codex CLI via JSON-RPC
 */

import { exec } from 'child_process';
import { promisify } from 'util';

import { AbstractExecutor } from '../base/AbstractExecutor';
import type {
  ExecutorTool,
  ExecutorSpawnOptions,
  ExecutorAvailability,
  ExecutorOutputEvent,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from '../types';
import type { Logger } from '../../infrastructure/logging/logger';
import type { ConfigManager } from '../../infrastructure/config/configManager';
import type { SessionManager } from '../../features/session/SessionManager';
import { findExecutableInPath } from '../../infrastructure/command/shellPath';
import { CodexMessageParser } from './CodexMessageParser';
import { cliLogger } from '../../infrastructure/logging/cliLogger';

const execAsync = promisify(exec);

interface CodexSpawnOptions extends ExecutorSpawnOptions {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  askForApproval?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * Codex CLI Executor using app-server mode with JSON-RPC
 */
export class CodexExecutor extends AbstractExecutor {
  private messageParser: CodexMessageParser;
  private requestId = 0;
  private conversationIdByPanel = new Map<string, { conversationId: string; rolloutPath?: string }>();
  private rpcOpById = new Map<string | number, { panelId: string; sessionId: string; startMs: number; kind: 'cli.command' }>();
  private pendingUserTurnRpcIdsByPanel = new Map<string, string[]>();
  private warnedSilentTurnRpcIds = new Set<string>();
  private turnIdleTimerByPanel = new Map<string, NodeJS.Timeout>();
  private lastTurnActivityMsByPanel = new Map<string, number>();
  private recentCodexActivityByPanel = new Map<string, string[]>();
  private jsonFragmentByPanel = new Map<string, { buf: string; startedAtMs: number }>();
  private internalWarningLastMsByKey = new Map<string, number>();
  private pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    label: string;
  }> = new Map();

  constructor(
    sessionManager: SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(sessionManager, logger, configManager);
    this.messageParser = new CodexMessageParser();
  }

  // ============================================================================
  // Abstract Method Implementations
  // ============================================================================

  getToolType(): ExecutorTool {
    return 'codex';
  }

  getToolName(): string {
    return 'Codex';
  }

  protected shouldFinalizeSpawnCommandOnSpawn(): boolean {
    // `codex app-server` is a long-lived process; the “Running” indicator should
    // reflect per-turn activity, not the server process lifetime.
    return true;
  }

  getCommandName(): string {
    return 'codex';
  }

  getCustomExecutablePath(): string | undefined {
    return this.configManager?.getConfig()?.codexExecutablePath;
  }

  async testAvailability(customPath?: string): Promise<ExecutorAvailability> {
    try {
      const resolved = customPath || (await findExecutableInPath('codex')) || 'codex';
      const command = resolved.includes(' ') ? `"${resolved}"` : resolved;
      const env = await this.getSystemEnvironment();
      const { stdout } = await execAsync(`${command} --version`, {
        timeout: 30000,
        env,
      });

      const version = stdout.trim();
      return {
        available: true,
        version,
        path: resolved,
      };
    } catch (error) {
      // Fallback to npx if no explicit custom path is set.
      if (!customPath) {
        try {
          const env = await this.getSystemEnvironment();
          const { stdout } = await execAsync('npx -y @openai/codex@latest --version', {
            timeout: 30000,
            env,
          });
          const version = stdout.trim();
          return {
            available: true,
            version,
            path: 'npx -y @openai/codex@latest',
          };
        } catch {
          // fall through
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: errorMessage,
      };
    }
  }

  buildCommandArgs(options: ExecutorSpawnOptions): string[] {
    void options;
    // Codex uses app-server mode for JSON-RPC communication.
    // NOTE: `codex app-server` does not accept `--sandbox` / `--ask-for-approval` flags.
    // Those policies must be sent via JSON-RPC (e.g. `newConversation` overrides).
    return ['app-server'];
  }

  async initializeEnvironment(options: ExecutorSpawnOptions): Promise<Record<string, string>> {
    const { worktreePath } = options;
    const env: Record<string, string> = {};

    env.PWD = worktreePath;
    env.NODE_NO_WARNINGS = '1';
    env.NO_COLOR = '1';
    env.RUST_LOG = 'error';

    // Add OpenAI API key if configured
    const apiKey = this.configManager?.getConfig()?.openaiApiKey;
    if (apiKey) {
      env.OPENAI_API_KEY = apiKey;
    }

    return env;
  }

  async cleanupResources(sessionId: string): Promise<void> {
    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Process terminated'));
    }
    this.pendingRequests.clear();

    // Finalize any outstanding RPC ops (otherwise the timeline will keep showing "running").
    // IMPORTANT: do this before clearing per-panel turn queues, since those rely on `rpcOpById`.
    for (const [id, op] of Array.from(this.rpcOpById.entries())) {
      if (op.sessionId !== sessionId) continue;
      const termination = this.getTerminationReason(op.panelId) || 'terminated';
      this.finishRpcTimeline(id, 'failed', {
        termination,
      });
    }

    for (const [panelId, proc] of this.processes) {
      if (proc.sessionId === sessionId) {
        this.clearTurnIdleTimer(panelId);
        this.lastTurnActivityMsByPanel.delete(panelId);
        const termination = this.getTerminationReason(panelId) || 'terminated';
        const pending = this.pendingUserTurnRpcIdsByPanel.get(panelId);
        if (pending?.length) {
          for (const rpcId of pending) this.finishRpcTimeline(rpcId, 'failed', {
            termination,
          });
        }
        this.pendingUserTurnRpcIdsByPanel.delete(panelId);
        this.conversationIdByPanel.delete(panelId);
      }
    }
    this.logger?.verbose(`Cleaned up Codex resources for session ${sessionId}`);
  }

  parseOutput(data: string, panelId: string, sessionId: string): void {
    const trimmed = String(data ?? '').trim();
    if (!trimmed) return;

    this.trackRecentCodexActivity(panelId, trimmed);

    // Codex runs under a PTY; long JSON-RPC requests can be echoed back and occasionally include
    // terminal control bytes or get split across lines. Maintain a small per-panel buffer and
    // parse any complete JSON objects we can extract.
    const prior = this.jsonFragmentByPanel.get(panelId);
    const combined = prior ? `${prior.buf}\n${trimmed}` : trimmed;
    const processed = this.processCodexMixedOutput(combined, panelId, sessionId);

    if (processed.partialJson) {
      const startedAtMs = prior?.startedAtMs ?? Date.now();
      // Prevent unbounded growth if output is not actually JSON.
      if (processed.partialJson.length > 256_000) {
        this.logger?.warn(`[Codex] Dropping oversized JSON fragment (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)} len=${processed.partialJson.length})`);
        this.maybeEmitInternalWarning(
          panelId,
          sessionId,
          'codex-json-fragment',
          `Dropped an oversized Codex JSON fragment (len=${processed.partialJson.length}). This can cause missing timeline items. Check dev logs for details.`,
          60_000
        );
        this.jsonFragmentByPanel.delete(panelId);
      } else {
        // If we keep buffering for a while, surface a single warning.
        const ageMs = Date.now() - startedAtMs;
        if (ageMs > 2000 && !prior) {
          const snippet = processed.partialJson.length > 220 ? `${processed.partialJson.slice(0, 220)}…` : processed.partialJson;
          this.logger?.warn(`[Codex] Buffering partial JSON (${Math.round(ageMs)}ms) (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${snippet}`);
          this.maybeEmitInternalWarning(
            panelId,
            sessionId,
            'codex-json-fragment',
            `Buffering partial Codex JSON output (>2s). Output may be incomplete until parsing recovers. Check dev logs for details.`,
            60_000
          );
        }
        this.jsonFragmentByPanel.set(panelId, { buf: processed.partialJson, startedAtMs });
      }
    } else {
      this.jsonFragmentByPanel.delete(panelId);
    }
  }

  // ============================================================================
  // JSON-RPC Protocol Methods
  // ============================================================================

  private stripAnsiAndControlNoise(text: string): string {
    // Remove ANSI CSI sequences (e.g. \x1b[...m, \x1b[?2004h) and stray NULs that can appear in PTY echo.
    // Keep it conservative to avoid changing real JSON content.
    return text
      .replace(/\u0000/g, '')
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  private maybeEmitInternalWarning(
    panelId: string,
    sessionId: string,
    code: string,
    message: string,
    minIntervalMs = 30_000
  ): void {
    const key = `${panelId}:${code}`;
    const now = Date.now();
    const last = this.internalWarningLastMsByKey.get(key) || 0;
    if (now - last < minIntervalMs) return;
    this.internalWarningLastMsByKey.set(key, now);

    // Route to timeline via a thinking entry (multi-line so it isn't filtered as a short Codex phase marker).
    const content = `Snowtree warning (${code}):\n${message}`;
    void this.handleNormalizedEntry(panelId, sessionId, {
      id: `snowtree:warn:${code}:${now}`,
      timestamp: new Date().toISOString(),
      entryType: 'thinking',
      content,
      metadata: { streaming: false, internal: true, code },
    });
  }

  private processCodexMixedOutput(
    raw: string,
    panelId: string,
    sessionId: string
  ): { partialJson?: string } {
    const cleaned = this.stripAnsiAndControlNoise(raw).trim();
    if (!cleaned) return {};

    const extracted = this.extractTopLevelJsonObjects(cleaned);
    if (extracted.objects.length > 0) {
      for (const obj of extracted.objects) {
        if (!this.tryHandleCodexJson(obj, panelId, sessionId)) {
          // Not JSON; emit as stdout for visibility
          const out = obj.trim();
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

      const noise = extracted.noise.trim();
      if (noise) {
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stdout',
          data: noise,
          timestamp: new Date(),
        } as ExecutorOutputEvent);
      }

      return extracted.partial ? { partialJson: extracted.partial } : {};
    }

    if (this.tryHandleCodexJson(cleaned, panelId, sessionId)) {
      return {};
    }

    // Likely a partial JSON object; keep buffering only for lines that look like JSON-RPC.
    if (cleaned.startsWith('{') && cleaned.includes("\"method\"")) {
      return { partialJson: cleaned };
    }

    this.emit('output', {
      panelId,
      sessionId,
      type: 'stdout',
      data: cleaned,
      timestamp: new Date(),
    } as ExecutorOutputEvent);

    return {};
  }

  private tryHandleCodexJson(payload: string, panelId: string, sessionId: string): boolean {
    try {
      const message = JSON.parse(payload);

      // Handle JSON-RPC response
      if ('id' in message && (message.result !== undefined || message.error)) {
        this.handleRpcResponse(message as JsonRpcResponse);
        return true;
      }

      // Handle JSON-RPC notification
      if ('method' in message && !('id' in message)) {
        this.handleRpcNotification(message as JsonRpcNotification, panelId, sessionId);
        return true;
      }

      // Handle JSON-RPC request (from server)
      if ('method' in message && 'id' in message) {
        // When running under a PTY, our outbound JSON-RPC requests are echoed back to stdout.
        // Ignore these request-shaped echoes; responding to them corrupts the protocol.
        const m = message as { id: string | number; method: string };
        const normalizedId = this.normalizeRpcId(m.id);
        const clientMethods = new Set([
          'initialize',
          'newConversation',
          'resumeConversation',
          'addConversationListener',
          'sendUserMessage',
        ]);
        if (clientMethods.has(m.method)) return true;
        if (this.pendingRequests.has(m.id) || this.pendingRequests.has(normalizedId)) return true;
        this.handleRpcRequest(message as JsonRpcRequest, panelId, sessionId);
        return true;
      }

      // Generic JSON message
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: message,
        timestamp: new Date(),
      } as ExecutorOutputEvent);
      return true;
    } catch {
      // If this looks like JSON-RPC but failed to parse, emit a warning with a short snippet.
      // This helps diagnose protocol desync or partial-line issues without flooding the logs.
      const t = payload.trim();
      if (t.startsWith('{') && t.includes('"method"')) {
        const methodMatch = t.match(/"method"\s*:\s*"([^"]+)"/);
        const idMatch = t.match(/"id"\s*:\s*(?:"([^"]+)"|(\d+))/);
        const method = methodMatch ? methodMatch[1] : '';
        const id = idMatch ? (idMatch[1] || idMatch[2] || '') : '';
        const summary = method ? `rpc:${method}${id ? `#${id}` : ''}` : 'rpc:unknown';

        // When running under a PTY, our outbound JSON-RPC requests are commonly echoed back.
        // If the echoed line gets wrapped/contaminated with terminal control characters, it may
        // become invalid JSON. These echoes are non-actionable and should not alarm users.
        const clientMethods = new Set([
          'initialize',
          'newConversation',
          'resumeConversation',
          'addConversationListener',
          'sendUserMessage',
          'initialized',
        ]);
        if (clientMethods.has(method)) {
          this.logger?.verbose?.(`[Codex] Ignoring unparseable PTY-echo of client request (${summary}) (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)})`);
          return true;
        }

        const snippet = t.length > 220 ? `${t.slice(0, 220)}…` : t;
        this.logger?.warn(`[Codex] Failed to parse JSON line (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)}): ${snippet}`);
        this.maybeEmitInternalWarning(
          panelId,
          sessionId,
          'codex-json-parse',
          `Failed to parse Codex JSON-RPC output (${summary}). This can cause missing assistant messages/commands. Check dev logs for details.`,
          60_000
        );
      }
      return false;
    }
  }

  private extractTopLevelJsonObjects(input: string): { objects: string[]; noise: string; partial?: string } {
    const objects: string[] = [];
    let noise = '';
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (start === -1) {
        if (ch === '{') {
          start = i;
          depth = 1;
          inString = false;
          escape = false;
        } else {
          noise += ch;
        }
        continue;
      }

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        depth++;
        continue;
      }

      if (ch === '}') {
        depth--;
        if (depth === 0) {
          objects.push(input.slice(start, i + 1));
          start = -1;
        }
      }
    }

    if (start !== -1) {
      return { objects, noise, partial: input.slice(start) };
    }

    return { objects, noise };
  }

  private nextRequestId(): string {
    return String(++this.requestId);
  }

  private normalizeRpcId(id: string | number): string {
    return typeof id === 'string' ? id : String(id);
  }

  private handleRpcResponse(response: JsonRpcResponse): void {
    const normalizedId = this.normalizeRpcId(response.id);
    const pending = this.pendingRequests.get(response.id) || this.pendingRequests.get(normalizedId);
    if (!pending) {
      // In PTY mode, our own outbound responses (e.g. approvals) can be echoed back.
      this.logger?.verbose(`Received response for unknown request: ${normalizedId}`);
      return;
    }

    const op = this.rpcOpById.get(response.id) || this.rpcOpById.get(normalizedId);

    this.pendingRequests.delete(response.id);
    this.pendingRequests.delete(normalizedId);

    if (!response.error && op && (pending.label === 'newConversation' || pending.label === 'resumeConversation')) {
      const result = response.result as Record<string, unknown> | undefined;
      const model = result && typeof result.model === 'string' ? result.model : undefined;
      const reasoningEffort = result && typeof result.reasoning_effort === 'string'
        ? result.reasoning_effort
        : result && typeof result.reasoningEffort === 'string'
          ? result.reasoningEffort
          : undefined;
      if (model || reasoningEffort) {
        this.handleNormalizedEntry(op.panelId, op.sessionId, {
          id: `codex:meta:${String(response.id)}`,
          timestamp: new Date().toISOString(),
          entryType: 'system_message',
          content: '',
          metadata: {
            model,
            reasoning_effort: reasoningEffort,
          },
        });
      }
    }

    // For `sendUserMessage`, the RPC response is just an ack; keep it Running until the turn completes.
    if (pending.label === 'sendUserMessage') {
      if (response.error && op?.panelId) {
        this.dropPendingUserTurn(op.panelId, normalizedId);
        this.finishRpcTimeline(response.id, 'failed');
        this.finishRpcTimeline(normalizedId, 'failed');
      }
    } else {
      this.finishRpcTimeline(response.id, response.error ? 'failed' : 'finished');
      this.finishRpcTimeline(normalizedId, response.error ? 'failed' : 'finished');
    }

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleRpcNotification(
    notification: JsonRpcNotification,
    panelId: string,
    sessionId: string
  ): void {
    const { method, params } = notification;

    if (method === 'turn/started') {
      this.logger?.info(`[Codex] turn started (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)})`);
    } else if (method === 'turn/completed') {
      this.logger?.info(`[Codex] turn completed (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)})`);
    } else if (method === 'error') {
      this.logger?.warn(`[Codex] turn error notification (panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)})`);
    }

    // Codex can keep streaming deltas (reasoning/assistant text) after commands finish.
    // Treat non-terminal notifications as activity so the UI stays in "Running".
    if (method !== 'turn/completed' && method !== 'error') {
      this.noteTurnActivity(panelId, sessionId);
    }

    // Keep the per-prompt RPC entry Running until the turn completes.
    if (method === 'turn/completed') {
      this.finishNextPendingUserTurn(panelId, 'finished');
      if (!this.pendingUserTurnRpcIdsByPanel.get(panelId)?.length) {
        // Debounce to avoid flipping to Waiting while final deltas are still flushing.
        this.scheduleTurnIdle(panelId, sessionId);
      }
    } else if (method === 'error') {
      const willRetry = typeof (params as { willRetry?: unknown; will_retry?: unknown })?.willRetry === 'boolean'
        ? Boolean((params as { willRetry: boolean }).willRetry)
        : typeof (params as { will_retry?: unknown })?.will_retry === 'boolean'
          ? Boolean((params as { will_retry: boolean }).will_retry)
          : false;
      if (!willRetry) {
        this.finishNextPendingUserTurn(panelId, 'failed');
        if (!this.pendingUserTurnRpcIdsByPanel.get(panelId)?.length) {
          const err = (params as { error?: unknown })?.error as { message?: unknown } | undefined;
          const msg = err && typeof err.message === 'string' ? err.message : 'Codex error';
          this.sessionManager.updateSessionStatus(sessionId, 'error', msg);
        }
      }
    }

    // v2 notifications (Codex app-server).
    const entry = this.messageParser.parseV2Notification(method, params, panelId);
    if (entry) this.handleNormalizedEntry(panelId, sessionId, entry);
  }

  private handleRpcRequest(
    request: JsonRpcRequest,
    panelId: string,
    sessionId: string
  ): void {
    const { method, params, id } = request;

    // Handle approval requests
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      // Auto-approve for now (can be enhanced with approval service)
      this.sendRpcResponse(panelId, id, { decision: 'approved' });
      return;
    }

    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      void params;
      // Auto-accept (v2 approval decision)
      this.sendRpcResponse(panelId, id, { decision: 'accept' });
      return;
    }

    // Ignore unknown requests. In app-server mode, the server should not send arbitrary requests.
    // (Request-shaped JSON is commonly PTY-echo of our own outbound messages.)
    this.logger?.verbose(`Unhandled Codex request: ${method}`);
  }

  private sendRpcMessage(panelId: string, message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    const process = this.processes.get(panelId);
    if (!process) {
      throw new Error(`No Codex process found for panel ${panelId}`);
    }

    const data = JSON.stringify(message) + '\n';
    process.pty.write(data);
  }

  private sendRpcResponse(panelId: string, id: string | number, result: unknown): void {
    this.sendRpcMessage(panelId, {
      id,
      result,
    });
  }

  private recordRpcTimelineStart(panelId: string, sessionId: string, id: string | number, method: string, params?: unknown): void {
    const startMs = Date.now();
    this.rpcOpById.set(id, { panelId, sessionId, startMs, kind: 'cli.command' });

    // Record the raw JSON-RPC request we send to the Codex app-server (no synthetic `codex.rpc …` formatting).
    // This keeps the audit log transparent and avoids us "processing" commands for display.
    const display = JSON.stringify({ id, method, params });
    const cwd = this.sessionManager.getSession(sessionId)?.worktreePath;
    const runtime = this.runtimeMetaByPanel.get(panelId) || {};
    this.sessionManager.addTimelineEvent({
      session_id: sessionId,
      panel_id: panelId,
      kind: 'cli.command',
      status: 'started',
      command: display,
      cwd,
      tool: this.getToolType(),
      meta: { operationId: `rpc:${String(id)}`, rpcMethod: method, ...runtime },
    });
  }

  private finishRpcTimeline(id: string | number, status: 'finished' | 'failed', meta?: Record<string, unknown>): void {
    const op = this.rpcOpById.get(id);
    if (!op) return;
    this.rpcOpById.delete(id);
    const durationMs = Date.now() - op.startMs;
    this.sessionManager.addTimelineEvent({
      session_id: op.sessionId,
      panel_id: op.panelId,
      kind: 'cli.command',
      status,
      duration_ms: durationMs,
      tool: this.getToolType(),
      meta: { operationId: `rpc:${String(id)}`, rpcId: String(id), ...(meta || {}) },
    });
  }

  // formatRpcDisplay removed: timeline shows raw JSON-RPC.

  private async sendRpcRequest<T>(panelId: string, method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId();
    const request: JsonRpcRequest = {
      id,
      method,
      params,
    };

    {
      const proc = this.processes.get(panelId);
      if (proc) this.recordRpcTimelineStart(panelId, proc.sessionId, id, method, params);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, label: method });
      this.sendRpcMessage(panelId, request);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.finishRpcTimeline(id, 'failed');
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private enqueuePendingUserTurn(panelId: string, rpcId: string): void {
    const q = this.pendingUserTurnRpcIdsByPanel.get(panelId) || [];
    q.push(rpcId);
    this.pendingUserTurnRpcIdsByPanel.set(panelId, q);
  }

  private dropPendingUserTurn(panelId: string, rpcId: string): void {
    const q = this.pendingUserTurnRpcIdsByPanel.get(panelId);
    if (!q?.length) return;
    const next = q.filter((id) => id !== rpcId);
    if (next.length === 0) this.pendingUserTurnRpcIdsByPanel.delete(panelId);
    else this.pendingUserTurnRpcIdsByPanel.set(panelId, next);
  }

  private finishNextPendingUserTurn(panelId: string, status: 'finished' | 'failed'): void {
    const q = this.pendingUserTurnRpcIdsByPanel.get(panelId);
    if (!q?.length) return;
    const rpcId = q.shift();
    if (!rpcId) return;
    if (q.length === 0) this.pendingUserTurnRpcIdsByPanel.delete(panelId);
    this.finishRpcTimeline(rpcId, status);
  }

  private clearTurnIdleTimer(panelId: string): void {
    const timer = this.turnIdleTimerByPanel.get(panelId);
    if (timer) clearTimeout(timer);
    this.turnIdleTimerByPanel.delete(panelId);
  }

  private noteTurnActivity(panelId: string, sessionId: string): void {
    this.lastTurnActivityMsByPanel.set(panelId, Date.now());
    this.clearTurnIdleTimer(panelId);

    // Align UI "Running" with Codex streaming output.
    const session = this.sessionManager.getSession(sessionId);
    if (session && session.status !== 'running' && session.status !== 'initializing' && session.status !== 'stopped') {
      this.sessionManager.updateSessionStatus(sessionId, 'running');
    }
  }

  private scheduleTurnIdle(panelId: string, sessionId: string): void {
    this.clearTurnIdleTimer(panelId);
    const scheduledAt = Date.now();
    this.turnIdleTimerByPanel.set(panelId, setTimeout(() => {
      this.turnIdleTimerByPanel.delete(panelId);

      const lastActivity = this.lastTurnActivityMsByPanel.get(panelId) || 0;
      if (lastActivity > scheduledAt) return;
      if (this.pendingUserTurnRpcIdsByPanel.get(panelId)?.length) return;

      const session = this.sessionManager.getSession(sessionId);
      if (!session || session.status === 'stopped') return;
      this.sessionManager.updateSessionStatus(sessionId, 'waiting');
    }, 250));
  }

  // ============================================================================
  // Codex-specific Methods
  // ============================================================================

  /**
   * Initialize Codex app-server connection
   */
  async initialize(panelId: string): Promise<void> {
    await this.sendRpcRequest(panelId, 'initialize', {
      clientInfo: {
        name: 'snowtree',
        title: 'snowtree',
        version: '0.1.0',
      }
    });

    // Send initialized notification
    this.sendRpcMessage(panelId, {
      method: 'initialized',
    } as JsonRpcNotification);
  }

  /**
   * Create a new Codex conversation
   */
  async newConversation(
    panelId: string,
    params: {
      cwd?: string;
      model?: string;
      sandbox?: string;
      approvalPolicy?: string;
    }
  ): Promise<{ conversationId: string; rolloutPath?: string }> {
    return this.sendRpcRequest(panelId, 'newConversation', params);
  }

  /**
   * Send a user message to Codex
   */
  async sendUserMessage(
    panelId: string,
    conversationId: string,
    message: string
  ): Promise<void> {
    const rpcId = this.nextRequestId();
    this.enqueuePendingUserTurn(panelId, rpcId);
    this.warnedSilentTurnRpcIds.delete(rpcId);

    const request: JsonRpcRequest = {
      id: rpcId,
      method: 'sendUserMessage',
      params: {
        conversationId,
        items: [{ type: 'text', data: { text: message } }],
      }
    };

    {
      const proc = this.processes.get(panelId);
      if (proc) this.recordRpcTimelineStart(panelId, proc.sessionId, rpcId, 'sendUserMessage', request.params);
    }

    await new Promise<void>((resolve, reject) => {
      // `sendUserMessage` response is just an ack; the actual turn completion is tracked via `turn/completed`.
      // In practice the ack can arrive late (or be dropped). Treat an ack timeout as non-fatal to avoid
      // spurious "Request sendUserMessage timed out" errors while the agent may still be running.
      this.pendingRequests.set(rpcId, { resolve: (() => resolve()) as unknown as (value: unknown) => void, reject, label: 'sendUserMessage' });
      this.sendRpcMessage(panelId, request);
      const proc = this.processes.get(panelId);
      const sid = proc?.sessionId || '';
      if (sid) this.noteTurnActivity(panelId, sid);
      this.scheduleSilentTurnWarning(panelId, sid, rpcId);
      setTimeout(() => {
        if (this.pendingRequests.has(rpcId)) {
          this.pendingRequests.delete(rpcId);
          // Keep the pending turn; `turn/completed` will finalize the timeline entry.
          resolve();
        }
      }, 30000);
    });
  }

  private scheduleSilentTurnWarning(panelId: string, sessionId: string, rpcId: string): void {
    const warnAfterMs = 15_000;
    setTimeout(() => {
      if (!sessionId) return;
      const pending = this.pendingUserTurnRpcIdsByPanel.get(panelId) || [];
      if (!pending.includes(rpcId)) return;
      if (this.warnedSilentTurnRpcIds.has(rpcId)) return;

      const last = this.lastTurnActivityMsByPanel.get(panelId) || 0;
      const now = Date.now();
      if (last && now - last < warnAfterMs) return;

      this.warnedSilentTurnRpcIds.add(rpcId);
      const convo = this.conversationIdByPanel.get(panelId)?.conversationId;
      const recent = (this.recentCodexActivityByPanel.get(panelId) || []).slice(-6).join(' | ');
      this.logger?.warn(
        `[Codex] No events received for ${Math.round(warnAfterMs / 1000)}s after sendUserMessage ` +
        `(panel=${panelId.slice(0, 8)} session=${sessionId.slice(0, 8)} rpcId=${rpcId}` +
        `${convo ? ` convo=${convo.slice(0, 8)}` : ''}). ` +
        `Recent: ${recent || '(none)'}`
      );
    }, warnAfterMs);
  }

  private trackRecentCodexActivity(panelId: string, line: string): void {
    const current = this.recentCodexActivityByPanel.get(panelId) || [];
    const trimmed = line.trim();
    if (!trimmed) return;

    let summary = trimmed;
    if (trimmed.startsWith('{')) {
      const methodMatch = trimmed.match(/"method"\s*:\s*"([^"]+)"/);
      const idMatch = trimmed.match(/"id"\s*:\s*(?:"([^"]+)"|(\d+))/);
      const method = methodMatch ? methodMatch[1] : '';
      const id = idMatch ? (idMatch[1] || idMatch[2] || '') : '';
      if (method) {
        summary = `rpc:${method}${id ? `#${id}` : ''}`;
      } else if (id && (trimmed.includes('"result"') || trimmed.includes('"error"'))) {
        summary = `rpc:response#${id}`;
      } else {
        summary = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
      }
    } else {
      summary = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }

    current.push(summary);
    if (current.length > 24) current.splice(0, current.length - 24);
    this.recentCodexActivityByPanel.set(panelId, current);
  }

  /**
   * Add listener for conversation events
   */
  async addConversationListener(panelId: string, conversationId: string): Promise<void> {
    await this.sendRpcRequest(panelId, 'addConversationListener', {
      conversationId,
      experimentalRawEvents: false,
    });
  }

  /**
   * Resume an existing conversation
   */
  async resumeConversation(
    panelId: string,
    sessionPath: string
  ): Promise<{ conversationId: string; rolloutPath?: string }> {
    return this.sendRpcRequest(panelId, 'resumeConversation', {
      path: sessionPath,
    });
  }

  /**
   * Spawn the app-server process and start/resume a conversation.
   */
  async spawn(options: ExecutorSpawnOptions): Promise<void> {
    const { panelId, worktreePath, prompt } = options;
    const codexOptions = options as CodexSpawnOptions;
    const isResume = Boolean(options.isResume);
    const resumePath = typeof options.agentSessionId === 'string' ? options.agentSessionId : '';

    // Spawn the app-server process
    await super.spawn(options);

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Initialize connection
    await this.initialize(panelId);

    // Plan mode - use read-only sandbox to prevent code modifications
    const sandbox = options.planMode ? 'read-only' : codexOptions.sandbox;

    const overrides = {
      cwd: worktreePath,
      model: codexOptions.model,
      sandbox,
      approvalPolicy: codexOptions.askForApproval,
    };

    // Create or resume conversation
    const convo = isResume && resumePath
      ? await this.resumeConversation(panelId, resumePath)
      : await this.newConversation(panelId, overrides);

    if (!convo || typeof convo !== 'object') {
      throw new Error(`Codex ${isResume && resumePath ? 'resumeConversation' : 'newConversation'} returned ${convo === null ? 'null' : typeof convo}`);
    }

    const conversationId = convo.conversationId;
    if (!conversationId) {
      throw new Error('Codex did not return a conversationId');
    }
    const rolloutPath = convo.rolloutPath ? String(convo.rolloutPath) : undefined;
    this.conversationIdByPanel.set(panelId, { conversationId, rolloutPath });

    // Persist resume token (rollout path) for future runs
    if (rolloutPath) {
      this.emit('agentSessionId', { panelId, sessionId: options.sessionId, agentSessionId: rolloutPath });
    }

    // Add listener for events
    await this.addConversationListener(panelId, conversationId);

    // Send initial prompt
    if (prompt) {
      await this.sendUserMessage(panelId, conversationId, prompt);
    }
  }

  sendInput(panelId: string, input: string): void {
    const convo = this.conversationIdByPanel.get(panelId);
    if (!convo?.conversationId) {
      throw new Error(`Codex conversation not initialized for panel ${panelId}`);
    }
    void this.sendUserMessage(panelId, convo.conversationId, input);
  }
}

export default CodexExecutor;
