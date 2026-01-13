// @ts-nocheck
import * as os from 'os';
import { AbstractAIPanelManager, PanelMapping } from '../base/AbstractAIPanelManager';
import { CodexExecutor } from '../../../executors/codex';
import type { ExecutorSpawnOptions } from '../../../executors/types';
import type { Logger } from '../../../infrastructure/logging/logger';
import type { ConfigManager } from '../../../infrastructure/config/configManager';
import type { ConversationMessage } from '../../../infrastructure/database/models';
import { AIPanelConfig, StartPanelConfig, ContinuePanelConfig } from '@snowtree/core/types/aiPanelConfig';
import { DEFAULT_CODEX_MODEL } from '@snowtree/core/types/models';
import type { CodexPanelState } from '@snowtree/core/types/panels';

const SIGNAL_NAME_BY_VALUE: Map<number, string> = (() => {
  const map = new Map<number, string>();
  const signals = (os.constants as { signals?: Record<string, number> })?.signals;
  if (signals) {
    for (const [name, value] of Object.entries(signals)) {
      if (typeof value === 'number') {
        map.set(value, name);
      }
    }
  }
  return map;
})();

export type { CodexPanelState };

/**
 * Manager for OpenAI Codex panels
 * Uses the new CodexExecutor
 */
export class CodexPanelManager extends AbstractAIPanelManager {
  private codexExecutor: CodexExecutor;

  constructor(
    executor: CodexExecutor,
    sessionManager: import('../../session').SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(executor, sessionManager, logger, configManager);
    this.codexExecutor = executor;
    this.logger?.verbose('CodexPanelManager initialized');
    this.setupCodexSpecificHandlers();
  }

  /**
   * Get the agent name for logging and identification
   */
  protected getAgentName(): string {
    return 'Codex';
  }

  /**
   * Extract Codex-specific spawn options
   */
  protected extractSpawnOptions(config: AIPanelConfig, _mapping: PanelMapping): Partial<ExecutorSpawnOptions> {
    // Map sandbox mode
    let sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
    if (config.sandboxMode) {
      sandbox = config.sandboxMode as typeof sandbox;
    } else {
      // Codex defaults can be restrictive (often read-only); default to full access so the agent can edit files.
      sandbox = 'danger-full-access';
    }

    // Map approval policy
    let askForApproval: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined;
    if (config.approvalPolicy === 'auto') {
      askForApproval = 'never';
    } else if (config.approvalPolicy === 'manual') {
      askForApproval = 'untrusted';
    } else {
      // Default to no-approval mode; Snowtree already provides review/staging safety.
      askForApproval = 'never';
    }

    return {
      model: config.model || DEFAULT_CODEX_MODEL,
      sandbox,
      askForApproval,
      reasoningEffort: config.thinkingLevel,
      planMode: config.planMode,
    };
  }

  /**
   * Setup Codex-specific event handlers
   */
  private setupCodexSpecificHandlers(): void {
    this.logger?.verbose('Setting up Codex-specific event handlers');

    this.executor.on('exit', (data: { panelId?: string; sessionId?: string; exitCode?: number | null; signal?: number | null }) => {
      const panelId = data?.panelId;
      if (!panelId) {
        this.logger?.warn('Received panel-exit event without panelId');
        return;
      }

      const mapping = this.panelMappings.get(panelId);
      const sessionId = data?.sessionId ?? mapping?.sessionId;
      if (!sessionId) {
        this.logger?.warn(`Panel ${panelId} exit event missing sessionId`);
        return;
      }

      const exitCode = data.exitCode ?? null;
      const signalNumber = data.signal ?? null;
      const signalName = signalNumber !== null ? SIGNAL_NAME_BY_VALUE.get(signalNumber) : undefined;
      const finishedAt = new Date();

      let status: 'completed' | 'terminated' | 'error';
      let summary: string;

      if (exitCode === 0 && signalNumber === null) {
        status = 'completed';
        summary = 'Codex process completed successfully.';
      } else if (signalNumber !== null) {
        status = 'terminated';
        summary = `Codex process terminated by signal ${signalName || signalNumber}.`;
      } else if (exitCode === null) {
        status = 'terminated';
        summary = 'Codex process exited without reporting an exit code.';
      } else if (exitCode > 0) {
        status = 'error';
        summary = `Codex process exited with code ${exitCode}.`;
      } else {
        status = 'completed';
        summary = `Codex process exited with code ${exitCode}.`;
      }

      const outcomeDetail =
        status === 'completed'
          ? 'Completed successfully'
          : status === 'terminated'
            ? 'Terminated before completion'
            : 'Exited with errors';

      const signalDetail = signalNumber !== null ? `${signalName || 'unknown'} (${signalNumber})` : 'none';

      const detailLines = [
        `Outcome: ${outcomeDetail}`,
        `Exit code: ${exitCode !== null ? exitCode : 'not reported'}`,
        `Signal: ${signalDetail}`,
        `Finished at: ${finishedAt.toISOString()}`
      ];

      this.logger?.verbose(
        `Codex panel ${panelId} process exit: status=${status}, exitCode=${exitCode}, signal=${signalDetail}`
      );

      const message = {
        type: 'session',
        data: {
          status,
          message: summary,
          details: detailLines.join('\n'),
          diagnostics: {
            exitCode,
            signal: signalNumber,
            signalName,
            finishedAt: finishedAt.toISOString()
          }
        }
      };

      const outputEvent = {
        panelId,
        sessionId,
        type: 'json' as const,
        data: message,
        timestamp: finishedAt
      };

      if (this.panelMappings.has(panelId)) {
        this.executor.emit('output', outputEvent);
        return;
      }

      this.logger?.verbose(`Panel ${panelId} exit received after unregistration`);
      this.executor.emit('panel-output', outputEvent);

      try {
        if (this.sessionManager?.addSessionOutput) {
          this.sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: message,
            timestamp: finishedAt
          });
        }
      } catch (error) {
        this.logger?.warn(`Failed to persist Codex session summary for panel ${panelId}:`, error as Error);
      }
    });
  }

  /**
   * Start a Codex panel with specific configuration for backward compatibility
   */
  async startPanel(
    panelId: string,
    worktreePath: string,
    prompt: string,
    model?: string,
    modelProvider?: string,
    approvalPolicy?: 'auto' | 'manual',
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
    webSearch?: boolean,
    thinkingLevel?: 'low' | 'medium' | 'high'
  ): Promise<void>;
  async startPanel(config: StartPanelConfig): Promise<void>;
  async startPanel(
    panelIdOrConfig: string | StartPanelConfig,
    worktreePath?: string,
    prompt?: string,
    model?: string,
    modelProvider?: string,
    approvalPolicy?: 'auto' | 'manual',
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
    webSearch?: boolean,
    thinkingLevel?: 'low' | 'medium' | 'high'
  ): Promise<void> {
    if (typeof panelIdOrConfig === 'string') {
      const config: StartPanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        model,
        modelProvider,
        approvalPolicy,
        sandboxMode,
        webSearch,
        thinkingLevel
      };
      return super.startPanel(config);
    } else {
      return super.startPanel(panelIdOrConfig);
    }
  }

  /**
   * Send approval decision to Codex
   */
  async sendApproval(panelId: string, callId: string, decision: 'approved' | 'denied', type: 'exec' | 'patch'): Promise<void> {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.verbose(`Approval request for Codex panel ${panelId}: ${decision}`);
    this.logger?.warn(`Approval handling in interactive mode is not yet fully implemented`);
  }

  /**
   * Send interrupt signal to Codex
   */
  async sendInterrupt(panelId: string): Promise<void> {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    if (!this.codexExecutor.isRunning(panelId)) {
      this.logger?.verbose(`Cannot send interrupt - no running process for panel ${panelId}`);
      return;
    }

    this.logger?.verbose(`Sending interrupt signal (Ctrl+C) to panel ${panelId}`);
    this.codexExecutor.interrupt(panelId);
  }

  /**
   * Register panel with Codex-specific state handling
   */
  registerPanel(panelId: string, sessionId: string, initialState?: CodexPanelState, isUserInitiated = true): void {
    const baseInitialState = initialState ? {
      isInitialized: initialState.isInitialized,
      resumeId: initialState.codexResumeId,
      lastActivityTime: initialState.lastActivityTime,
      config: {
        model: initialState.model,
        modelProvider: initialState.modelProvider,
        approvalPolicy: initialState.approvalPolicy,
        sandboxMode: initialState.sandboxMode,
        webSearch: initialState.webSearch,
        thinkingLevel: initialState.codexConfig?.thinkingLevel
      }
    } : undefined;

    super.registerPanel(panelId, sessionId, baseInitialState, isUserInitiated);
  }

  /**
   * Get Codex-specific panel state
   */
  getPanelState(panelId: string): CodexPanelState | undefined {
    const baseState = super.getPanelState(panelId);
    if (!baseState) {
      return undefined;
    }

    const mapping = this.panelMappings.get(panelId);
    const config = mapping?.config;

    return {
      isInitialized: baseState.isInitialized,
      codexResumeId: baseState.resumeId,
      lastActivityTime: baseState.lastActivityTime,
      lastPrompt: config?.prompt,
      model: config?.model || DEFAULT_CODEX_MODEL,
      modelProvider: config?.modelProvider || 'openai',
      approvalPolicy: config?.approvalPolicy || 'auto',
      sandboxMode: config?.sandboxMode || 'danger-full-access',
      webSearch: config?.webSearch ?? false,
      codexConfig: {
        model: config?.model || DEFAULT_CODEX_MODEL,
        thinkingLevel: config?.thinkingLevel || 'medium',
        sandboxMode: config?.sandboxMode || 'danger-full-access',
        webSearch: config?.webSearch ?? false
      }
    };
  }

  /**
   * Continue panel with conversation history for backward compatibility
   */
  async continuePanel(
    panelId: string,
    worktreePath: string,
    prompt: string,
    conversationHistory: ConversationMessage[],
    model?: string,
    modelProvider?: string,
    thinkingLevel?: 'low' | 'medium' | 'high',
    approvalPolicy?: 'auto' | 'manual',
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
    webSearch?: boolean
  ): Promise<void>;
  async continuePanel(config: ContinuePanelConfig): Promise<void>;
  async continuePanel(
    panelIdOrConfig: string | ContinuePanelConfig,
    worktreePath?: string,
    prompt?: string,
    conversationHistory?: ConversationMessage[],
    model?: string,
    modelProvider?: string,
    thinkingLevel?: 'low' | 'medium' | 'high',
    approvalPolicy?: 'auto' | 'manual',
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
    webSearch?: boolean
  ): Promise<void> {
    if (typeof panelIdOrConfig === 'string') {
      const config: ContinuePanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        conversationHistory: conversationHistory!,
        model,
        modelProvider,
        thinkingLevel,
        approvalPolicy,
        sandboxMode,
        webSearch
      };
      return super.continuePanel(config);
    } else {
      return super.continuePanel(panelIdOrConfig);
    }
  }
}
