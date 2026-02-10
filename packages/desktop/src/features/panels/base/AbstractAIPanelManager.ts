import { AbstractExecutor } from '../../../executors';
import type { ExecutorSpawnOptions
} from '../../../executors/types';
import type { Logger } from '../../../infrastructure/logging/logger';
import type { ConfigManager } from '../../../infrastructure/config/configManager';
import type { ConversationMessage } from '../../../infrastructure/database/models';
import { AIPanelConfig, StartPanelConfig, ContinuePanelConfig, AIPanelState } from '@snowtree/core/types/aiPanelConfig';

/**
 * Mapping between a panel and its associated session
 */
export interface PanelMapping {
  panelId: string;
  sessionId: string;
  resumeId?: string;
  agentSessionId?: string;
  config?: Partial<AIPanelConfig>;
}

/**
 * Abstract base class for managing AI agent panels (Claude, Codex, etc.)
 * Uses the new Executor architecture
 */
export abstract class AbstractAIPanelManager {
  protected panelMappings = new Map<string, PanelMapping>();
  protected resumeIdToPanel = new Map<string, string>();
  protected promptStartTimes = new Map<string, number>();

  /**
   * Pending agent session IDs that haven't been confirmed yet.
   * Maps panelId -> { agentSessionId, agentCwd }
   * These are saved only after receiving the first assistant message to ensure
   * the CLI has successfully persisted the session.
   */
  protected pendingAgentSessionIds = new Map<string, {
    agentSessionId: string;
    agentCwd?: string;
  }>();

  constructor(
    protected executor: AbstractExecutor,
    protected sessionManager: import('../../session').SessionManager,
    protected logger?: Logger,
    protected configManager?: ConfigManager
  ) {
    this.setupEventHandlers();
    this.setupAnalyticsEventHandlers();
  }

  /**
   * Persist a pending session ID after confirmation
   */
  protected confirmAndPersistSessionId(panelId: string): void {
    const pending = this.pendingAgentSessionIds.get(panelId);
    if (!pending) return;

    this.logger?.verbose(`[${this.getAgentName()}PanelManager] Confirming session ID for panel ${panelId}: ${pending.agentSessionId}`);
    try {
      this.sessionManager.persistPanelAgentSessionId(panelId, pending.agentSessionId, {
        agentCwd: pending.agentCwd,
      });
      this.pendingAgentSessionIds.delete(panelId);
    } catch {
      // best-effort persistence
    }
  }

  /**
   * Discard a pending session ID that was never confirmed
   */
  protected discardPendingSessionId(panelId: string): void {
    const pending = this.pendingAgentSessionIds.get(panelId);
    if (!pending) return;

    this.logger?.verbose(`[${this.getAgentName()}PanelManager] Discarding unconfirmed session ID for panel ${panelId}: ${pending.agentSessionId}`);
    this.pendingAgentSessionIds.delete(panelId);

    // Clear from in-memory mapping since it was never confirmed
    const mapping = this.panelMappings.get(panelId);
    if (mapping) {
      mapping.agentSessionId = undefined;
    }
  }

  /**
   * Get the name of the AI agent (e.g., 'Claude', 'Codex')
   */
  protected abstract getAgentName(): string;

  /**
   * Extract agent-specific spawn options from the unified config
   */
  protected abstract extractSpawnOptions(config: AIPanelConfig, mapping: PanelMapping): Partial<ExecutorSpawnOptions>;

  /**
   * Generate a resume ID for conversation continuation
   */
  protected generateResumeId(panelId: string): string {
    return `${this.getAgentName().toLowerCase()}-panel-${panelId}`;
  }

  /**
   * Setup event handlers to forward executor events to panel events
   */
  protected setupEventHandlers(): void {
    // Forward output events (persistence is handled by events.ts to avoid duplicates)
    this.executor.on('output', (data: { panelId: string; sessionId: string; type: string; data: unknown; timestamp: Date }) => {
      const { panelId, sessionId } = data;
      if (!panelId || !this.panelMappings.has(panelId)) return;

      // Confirm session ID on first assistant message (CLI has persisted successfully)
      if (data.type === 'json' && typeof data.data === 'object' && data.data !== null) {
        const jsonData = data.data as { type?: string; role?: string };
        // Confirm on assistant message OR result message (both indicate successful CLI execution)
        if (jsonData.type === 'assistant' || jsonData.type === 'result' || jsonData.role === 'assistant') {
          this.confirmAndPersistSessionId(panelId);
        }
      }

      // Emit panel-output event for real-time UI updates
      this.executor.emit('panel-output', {
        panelId,
        sessionId,
        type: data.type,
        data: data.data,
        timestamp: data.timestamp
      });
    });

    // Forward spawned events
    this.executor.on('spawned', (data: { panelId: string; sessionId: string }) => {
      const { panelId, sessionId } = data;
      if (panelId && this.panelMappings.has(panelId)) {
        this.executor.emit('panel-spawned', { panelId, sessionId });
      }
    });

    // Forward exit events
    this.executor.on('exit', (data: { panelId: string; sessionId: string; exitCode?: number; signal?: number }) => {
      const { panelId, sessionId, exitCode, signal } = data;
      if (!panelId) {
        this.logger?.warn(`[${this.getAgentName()}PanelManager] Received exit event without panelId`);
        return;
      }

      const mapping = this.panelMappings.get(panelId);
      const resolvedSessionId = mapping?.sessionId ?? sessionId;

      if (!resolvedSessionId) {
        this.logger?.warn(`[${this.getAgentName()}PanelManager] Exit event for panel ${panelId} missing sessionId`);
        return;
      }

      // Discard unconfirmed session ID (CLI never persisted it)
      this.discardPendingSessionId(panelId);

      this.executor.emit('panel-exit', { panelId, sessionId: resolvedSessionId, exitCode, signal });
    });

    // Forward error events
    this.executor.on('error', (data: { panelId: string; sessionId: string; error: Error | string }) => {
      const { panelId, sessionId, error } = data;
      if (panelId && this.panelMappings.has(panelId)) {
        this.executor.emit('panel-error', { panelId, sessionId, error });
      }
    });

    // Handle agent session ID updates
    // Cache session ID but don't persist until first assistant message confirms CLI success
    this.executor.on('agentSessionId', (data: { panelId: string; sessionId: string; agentSessionId: string; agentCwd?: string }) => {
      const { panelId, agentSessionId, agentCwd } = data;
      const mapping = this.panelMappings.get(panelId);
      if (!mapping) return;

      mapping.agentSessionId = agentSessionId;
      this.pendingAgentSessionIds.set(panelId, {
        agentSessionId,
        agentCwd: typeof agentCwd === 'string' ? agentCwd : undefined,
      });
      this.logger?.verbose(`[${this.getAgentName()}PanelManager] Session ID cached, awaiting confirmation: ${agentSessionId}`);
    });
  }

  /**
   * Setup analytics event handlers
   */
  protected setupAnalyticsEventHandlers(): void {
    // Snowtree minimal mode: analytics removed.
  }

  /**
   * Hydrate a previously persisted agent session ID (resume token) for a panel.
   */
  setAgentSessionId(panelId: string, agentSessionId: string): void {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }
    mapping.agentSessionId = agentSessionId;
  }

  /**
   * Register a panel
   */
  registerPanel(panelId: string, sessionId: string, initialState?: AIPanelState, isUserInitiated = true): void {
    const resumeId = initialState?.resumeId || this.generateResumeId(panelId);

    const mapping: PanelMapping = {
      panelId,
      sessionId,
      resumeId,
      config: initialState?.config
    };

    this.panelMappings.set(panelId, mapping);
    this.resumeIdToPanel.set(resumeId, panelId);

    this.logger?.info(`[${this.getAgentName()}PanelManager] Registered panel ${panelId} for session ${sessionId}`);

    if (isUserInitiated) {
      this.trackPanelCreation(sessionId);
    }
  }

  /**
   * Unregister a panel
   */
  unregisterPanel(panelId: string): void {
    const mapping = this.panelMappings.get(panelId);
    if (mapping) {
      if (mapping.resumeId) {
        this.resumeIdToPanel.delete(mapping.resumeId);
      }
      this.panelMappings.delete(panelId);
      this.logger?.info(`[${this.getAgentName()}PanelManager] Unregistered panel ${panelId}`);
    }
  }

  /**
   * Start a panel
   */
  async startPanel(config: StartPanelConfig): Promise<void> {
    const { panelId, sessionId, worktreePath, prompt } = config;

    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    mapping.config = config;
    const resolvedSessionId = sessionId || mapping.sessionId;

    this.logger?.info(`[${this.getAgentName()}PanelManager] Starting panel ${panelId} (session: ${resolvedSessionId})`);
    this.trackPromptSubmission(panelId, prompt);

    // Build spawn options
    const imagePaths =
      Array.isArray((config as unknown as { imagePaths?: unknown }).imagePaths)
        ? ((config as unknown as { imagePaths: unknown[] }).imagePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        : undefined;
    const spawnOptions: ExecutorSpawnOptions = {
      panelId,
      sessionId: resolvedSessionId,
      worktreePath,
      prompt,
      imagePaths,
      ...this.extractSpawnOptions(config, mapping),
      providerConfig: config.providerConfig,
    };

    await this.executor.spawn(spawnOptions);
  }

  /**
   * Continue a panel conversation
   */
  async continuePanel(config: ContinuePanelConfig): Promise<void> {
    const { panelId, worktreePath, prompt, conversationHistory } = config;

    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    mapping.config = { ...mapping.config, ...config };

    this.logger?.info(`[${this.getAgentName()}PanelManager] Continuing panel ${panelId}`);

    const dbConversationHistory: ConversationMessage[] = conversationHistory.map((msg, index): ConversationMessage => ({
      id: msg.id ?? (index + 1),
      session_id: msg.session_id ?? mapping.sessionId,
      message_type: msg.message_type,
      content: msg.content,
      timestamp: msg.timestamp ?? new Date().toISOString()
    }));

    this.trackPromptSubmission(panelId, prompt);
    this.trackConversationTurn(panelId, dbConversationHistory);

    const hasResumeToken = typeof mapping.agentSessionId === 'string' && mapping.agentSessionId.length > 0;

    // Build spawn options with resume
    const imagePaths =
      Array.isArray((config as unknown as { imagePaths?: unknown }).imagePaths)
        ? ((config as unknown as { imagePaths: unknown[] }).imagePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        : undefined;
    const spawnOptions: ExecutorSpawnOptions = {
      panelId,
      sessionId: mapping.sessionId,
      worktreePath,
      prompt,
      imagePaths,
      isResume: hasResumeToken,
      agentSessionId: hasResumeToken ? mapping.agentSessionId : undefined,
      ...this.extractSpawnOptions(config, mapping),
      providerConfig: config.providerConfig,
    };

    await this.executor.spawn(spawnOptions);
  }

  /**
   * Stop a panel
   */
  async stopPanel(panelId: string): Promise<void> {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.info(`[${this.getAgentName()}PanelManager] Stopping panel ${panelId}`);
    await this.executor.kill(panelId);
  }

  /**
   * Send input to a panel
   */
  sendInputToPanel(panelId: string, input: string, imagePaths?: string[]): void {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.verbose(`[${this.getAgentName()}PanelManager] Sending input to panel ${panelId}`);
    this.executor.sendInput(panelId, input, imagePaths);
  }

  /**
   * Answer a user question (from AskUserQuestion tool)
   */
  async answerQuestion(panelId: string, answers: Record<string, string | string[]>): Promise<void> {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.info(`[${this.getAgentName()}PanelManager] Answering question for panel ${panelId}`);

    // Check if process is still running
    if (this.executor.isRunning(panelId)) {
      // Process still alive - write answer to stdin
      await this.executor.answerQuestion(panelId, answers);
    } else {
      // Process has exited - need to resume session with the answer
      this.logger?.info(`[${this.getAgentName()}PanelManager] Process not running, resuming session with answer`);

      // Update timeline event to 'answered' status
      await this.executor.updateQuestionStatus(panelId, mapping.sessionId, answers);

      // Get the session's worktree path
      const session = this.sessionManager.getSession(mapping.sessionId);
      if (!session?.worktreePath) {
        throw new Error(`Session ${mapping.sessionId} has no worktree path`);
      }

      // Check if we have an agent session ID for resume
      const hasValidAgentSessionId = typeof mapping.agentSessionId === 'string' && mapping.agentSessionId.length > 0;

      if (!hasValidAgentSessionId) {
        this.logger?.warn(
          `[${this.getAgentName()}PanelManager] No agent session ID available for panel ${panelId}. ` +
          `This can happen if the process exited before the init message was received. ` +
          `Starting a new conversation with the answer.`
        );
      }

      // Format answers as a readable response for Claude
      const answerText = this.formatAnswersForPrompt(answers);

      // Build config with required fields for extractSpawnOptions
      const config: AIPanelConfig = {
        ...mapping.config,
        prompt: answerText,
        worktreePath: session.worktreePath,
      };

      // Resume the session with the answer (only if we have a valid agent session ID)
      const spawnOptions: ExecutorSpawnOptions = {
        panelId,
        sessionId: mapping.sessionId,
        worktreePath: session.worktreePath,
        prompt: answerText,
        isResume: hasValidAgentSessionId,
        agentSessionId: hasValidAgentSessionId ? mapping.agentSessionId : undefined,
        ...this.extractSpawnOptions(config, mapping),
        providerConfig: config.providerConfig,
      };

      await this.executor.spawn(spawnOptions);
    }
  }

  /**
   * Format answers into a prompt string for resuming the session
   */
  protected formatAnswersForPrompt(answers: Record<string, string | string[]>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(answers)) {
      const displayValue = Array.isArray(value) ? value.join(', ') : value;
      parts.push(`${key}: ${displayValue}`);
    }
    return parts.join('\n');
  }

  /**
   * Check if panel is running
   */
  isPanelRunning(panelId: string): boolean {
    const mapping = this.panelMappings.get(panelId);
    return mapping ? this.executor.isRunning(panelId) : false;
  }

  /**
   * Get panel state
   */
  getPanelState(panelId: string): AIPanelState | undefined {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) return undefined;

    return {
      isInitialized: this.isPanelRunning(panelId),
      resumeId: mapping.resumeId,
      lastActivityTime: new Date().toISOString(),
      config: mapping.config
    };
  }

  /**
   * Get panel ID from resume ID
   */
  getPanelIdFromResumeId(resumeId: string): string | undefined {
    return this.resumeIdToPanel.get(resumeId);
  }

  /**
   * Get all registered panels
   */
  getAllPanels(): string[] {
    return Array.from(this.panelMappings.keys());
  }

  /**
   * Cleanup all panels for a session
   */
  async cleanupSessionPanels(sessionId: string): Promise<void> {
    const panelsToCleanup: string[] = [];

    for (const [panelId, mapping] of this.panelMappings) {
      if (mapping.sessionId === sessionId) {
        panelsToCleanup.push(panelId);
      }
    }

    for (const panelId of panelsToCleanup) {
      try {
        if (this.isPanelRunning(panelId)) {
          await this.stopPanel(panelId);
        }
        this.unregisterPanel(panelId);
      } catch (error) {
        this.logger?.error(`[${this.getAgentName()}PanelManager] Failed to cleanup panel ${panelId}: ${error}`);
      }
    }

    this.logger?.info(`[${this.getAgentName()}PanelManager] Cleaned up ${panelsToCleanup.length} panels for session ${sessionId}`);
  }

  // Analytics methods
  protected trackPanelCreation(sessionId: string): void {
    void sessionId;
  }

  protected trackPromptSubmission(panelId: string, prompt: string): void {
    void panelId;
    void prompt;
  }

  protected trackConversationTurn(panelId: string, conversationHistory: ConversationMessage[]): void {
    void panelId;
    void conversationHistory;
  }

  protected trackAIResponse(panelId: string, hadToolCalls: boolean): void {
    void panelId;
    void hadToolCalls;
  }
}
