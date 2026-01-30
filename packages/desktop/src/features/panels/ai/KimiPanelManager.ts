import { AbstractAIPanelManager, PanelMapping } from '../base/AbstractAIPanelManager';
import { KimiExecutor } from '../../../executors/kimi';
import type { ExecutorSpawnOptions } from '../../../executors/types';
import type { Logger } from '../../../infrastructure/logging/logger';
import type { ConfigManager } from '../../../infrastructure/config/configManager';
import type { ConversationMessage } from '../../../infrastructure/database/models';
import { AIPanelConfig, StartPanelConfig, ContinuePanelConfig } from '@snowtree/core/types/aiPanelConfig';
import type { BaseAIPanelState } from '@snowtree/core/types/panels';

/**
 * Manager for Kimi CLI panels
 */
export class KimiPanelManager extends AbstractAIPanelManager {
  constructor(
    executor: KimiExecutor,
    sessionManager: import('../../session').SessionManager,
    logger?: Logger,
    configManager?: ConfigManager
  ) {
    super(executor, sessionManager, logger, configManager);
  }

  protected getAgentName(): string {
    return 'Kimi';
  }

  protected extractSpawnOptions(config: AIPanelConfig, _mapping: PanelMapping): Partial<ExecutorSpawnOptions> {
    return {
      model: config.model,
      approvalMode: config.approvalMode,
      planMode: config.planMode,
    };
  }

  async startPanel(
    panelId: string,
    worktreePath: string,
    prompt: string,
    model?: string,
    approvalMode?: 'default' | 'yolo'
  ): Promise<void>;
  async startPanel(config: StartPanelConfig): Promise<void>;
  async startPanel(
    panelIdOrConfig: string | StartPanelConfig,
    worktreePath?: string,
    prompt?: string,
    model?: string,
    approvalMode?: 'default' | 'yolo'
  ): Promise<void> {
    if (typeof panelIdOrConfig === 'string') {
      const config: StartPanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        model,
        approvalMode,
      };
      return super.startPanel(config);
    }
    return super.startPanel(panelIdOrConfig);
  }

  async continuePanel(panelId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], model?: string): Promise<void>;
  async continuePanel(config: ContinuePanelConfig): Promise<void>;
  async continuePanel(
    panelIdOrConfig: string | ContinuePanelConfig,
    worktreePath?: string,
    prompt?: string,
    conversationHistory?: ConversationMessage[],
    model?: string
  ): Promise<void> {
    if (typeof panelIdOrConfig === 'string') {
      const config: ContinuePanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        conversationHistory: conversationHistory!,
        model,
      };
      return super.continuePanel(config);
    }
    return super.continuePanel(panelIdOrConfig);
  }

  getPanelState(panelId: string): BaseAIPanelState | undefined {
    return super.getPanelState(panelId);
  }
}

export default KimiPanelManager;
