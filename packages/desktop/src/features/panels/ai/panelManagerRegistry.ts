import type { ToolPanelType } from '@snowtree/core/types/panels';
import { ClaudePanelManager } from './ClaudePanelManager';
import { CodexPanelManager } from './CodexPanelManager';
import { GeminiPanelManager } from './GeminiPanelManager';
import { KimiPanelManager } from './KimiPanelManager';
import type { ClaudeExecutor } from '../../../executors/claude';
import type { CodexExecutor } from '../../../executors/codex';
import type { GeminiExecutor } from '../../../executors/gemini';
import type { KimiExecutor } from '../../../executors/kimi';
import type { Logger } from '../../../infrastructure/logging/logger';
import type { ConfigManager } from '../../../infrastructure/config/configManager';
import type { SessionManager } from '../../session';

export interface PanelManagerDependencies {
  sessionManager: SessionManager;
  claudeExecutor: ClaudeExecutor;
  codexExecutor: CodexExecutor;
  geminiExecutor: GeminiExecutor;
  kimiExecutor: KimiExecutor;
  logger?: Logger;
  configManager?: ConfigManager;
}

let deps: PanelManagerDependencies | null = null;

export let claudePanelManager: ClaudePanelManager | null = null;
export let codexPanelManager: CodexPanelManager | null = null;
export let geminiPanelManager: GeminiPanelManager | null = null;
export let kimiPanelManager: KimiPanelManager | null = null;

export const initPanelManagerRegistry = (nextDeps: PanelManagerDependencies): void => {
  if (!deps) {
    deps = nextDeps;
  }
};

const requireDeps = (): PanelManagerDependencies => {
  if (!deps) {
    throw new Error('Panel manager registry not initialized');
  }
  return deps;
};

export const getClaudePanelManager = (): ClaudePanelManager => {
  const current = requireDeps();
  if (!claudePanelManager) {
    claudePanelManager = new ClaudePanelManager(
      current.claudeExecutor,
      current.sessionManager,
      current.logger,
      current.configManager
    );
  }
  return claudePanelManager;
};

export const getCodexPanelManager = (): CodexPanelManager => {
  const current = requireDeps();
  if (!codexPanelManager) {
    codexPanelManager = new CodexPanelManager(
      current.codexExecutor,
      current.sessionManager,
      current.logger,
      current.configManager
    );
  }
  return codexPanelManager;
};

export const getGeminiPanelManager = (): GeminiPanelManager => {
  const current = requireDeps();
  if (!geminiPanelManager) {
    geminiPanelManager = new GeminiPanelManager(
      current.geminiExecutor,
      current.sessionManager,
      current.logger,
      current.configManager
    );
  }
  return geminiPanelManager;
};

export const getKimiPanelManager = (): KimiPanelManager => {
  const current = requireDeps();
  if (!kimiPanelManager) {
    kimiPanelManager = new KimiPanelManager(
      current.kimiExecutor,
      current.sessionManager,
      current.logger,
      current.configManager
    );
  }
  return kimiPanelManager;
};

export const getPanelManagerForType = (type: ToolPanelType): {
  manager: ClaudePanelManager | CodexPanelManager | GeminiPanelManager | KimiPanelManager;
  executor: ClaudeExecutor | CodexExecutor | GeminiExecutor | KimiExecutor;
} | null => {
  const current = requireDeps();
  switch (type) {
    case 'claude':
      return { manager: getClaudePanelManager(), executor: current.claudeExecutor };
    case 'codex':
      return { manager: getCodexPanelManager(), executor: current.codexExecutor };
    case 'gemini':
      return { manager: getGeminiPanelManager(), executor: current.geminiExecutor };
    case 'kimi':
      return { manager: getKimiPanelManager(), executor: current.kimiExecutor };
    default:
      return null;
  }
};
