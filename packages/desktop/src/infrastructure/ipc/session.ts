import type { IpcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppServices } from './types';
import { panelManager } from '../../features/panels/PanelManager';
import {
  getClaudePanelManager,
  getCodexPanelManager,
  getGeminiPanelManager,
  getKimiPanelManager,
  initPanelManagerRegistry,
} from '../../features/panels/ai/panelManagerRegistry';
import type { AIPanelState } from '@snowtree/core/types/aiPanelConfig';
import { randomUUID } from 'crypto';
import { persistRendererImageAttachments } from '../utils/imageAttachments';

export {
  claudePanelManager,
  codexPanelManager,
  geminiPanelManager,
  kimiPanelManager,
} from '../../features/panels/ai/panelManagerRegistry';

type MinimalCreateSessionRequest = {
  projectId: number;
  prompt?: string;
  toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
  baseBranch?: string;
};

const SETTINGS_FILE = path.join(os.homedir(), '.snowtree', 'settings.json');

export function readProviderConfig(toolType: string): { envVars?: Record<string, string>; extraArgs?: string } | undefined {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return undefined;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const cfg = settings?.providerConfigs?.[toolType];
    if (!cfg) return undefined;
    const hasEnvVars = cfg.envVars && typeof cfg.envVars === 'object' && Object.keys(cfg.envVars).length > 0;
    const hasExtraArgs = typeof cfg.extraArgs === 'string' && cfg.extraArgs.trim().length > 0;
    if (!hasEnvVars && !hasExtraArgs) return undefined;
    return cfg;
  } catch {
    return undefined;
  }
}

export function registerSessionHandlers(ipcMain: IpcMain, services: AppServices): void {
  const {
    sessionManager,
    taskQueue,
    gitStatusManager,
    claudeExecutor,
    codexExecutor,
    geminiExecutor,
    kimiExecutor,
    logger,
    configManager,
    worktreeManager,
    databaseService,
    gitExecutor
  } = services;

  initPanelManagerRegistry({
    sessionManager,
    claudeExecutor,
    codexExecutor,
    geminiExecutor,
    kimiExecutor,
    logger,
    configManager,
  });

  const resolveDefaultToolType = (): 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' => {
    const pref = databaseService.getUserPreference('defaultToolType');
    if (pref === 'codex' || pref === 'gemini' || pref === 'kimi' || pref === 'none') {
      return pref;
    }
    return 'claude';
  };

  /**
   * Try to recover worktree path if it was moved/renamed on disk.
   * Returns the (possibly updated) worktree path, or null if recovery failed.
   */
  async function tryRecoverWorktreePath(sessionId: string): Promise<string | null> {
    const session = sessionManager.getSession(sessionId);
    if (!session?.worktreePath) return null;

    let worktreePath = session.worktreePath;

    // If path exists, no recovery needed
    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }

    // Get the database session to access worktree_name
    const dbSession = sessionManager.getDbSession(sessionId);
    const worktreeName = dbSession?.worktree_name;

    // Try to find the worktree by branch name
    const project = session.projectId ? databaseService.getProject(session.projectId) : null;
    if (!project || !worktreeName) {
      return null;
    }

    try {
      const worktrees = await worktreeManager.listWorktreesDetailed(project.path, sessionId);
      // Find worktree by branch name (worktreeName is usually the branch name)
      const matchingWorktree = worktrees.find(w => w.branch === worktreeName);
      if (!matchingWorktree) {
        return null;
      }

      // Found the worktree at a new path
      worktreePath = matchingWorktree.path;

      // Update session with new path (do not auto-rename the branch; that is a user action).
      sessionManager.updateSession(sessionId, { worktreePath });
      logger?.info(`[IPC] Recovered worktree path: ${session.worktreePath} -> ${worktreePath}`);

      return worktreePath;
    } catch (e) {
      logger?.warn(`[IPC] Failed to recover worktree path: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  ipcMain.handle('sessions:get-all', async () => {
    try {
      return { success: true, data: sessionManager.getAllSessions() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load sessions' };
    }
  });

  ipcMain.handle('sessions:get', async (_event, sessionId: string) => {
    try {
      // Try to recover worktree path if it was renamed/moved.
      await tryRecoverWorktreePath(sessionId);

      const session = sessionManager.getSession(sessionId);
      if (!session) return { success: false, error: 'Session not found' };
      return { success: true, data: session };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load session' };
    }
  });

  ipcMain.handle('sessions:create', async (_event, request: MinimalCreateSessionRequest) => {
    try {
      if (!taskQueue) return { success: false, error: 'Task queue not initialized' };
      const sessionId = randomUUID();
      const job = await taskQueue.createSession({
        sessionId,
        prompt: request.prompt ?? '',
        worktreeTemplate: '',
        projectId: request.projectId,
        baseBranch: request.baseBranch,
        toolType: request.toolType ?? resolveDefaultToolType(),
      });
      void job;
      return { success: true, data: { id: sessionId } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create session' };
    }
  });

  ipcMain.handle('sessions:stop', async (_event, sessionId: string) => {
    try {
      // Mark stopped first so executor exit events don't transiently flip the session back to waiting/error.
      sessionManager.updateSessionStatus(sessionId, 'stopped');
      const panels = panelManager.getPanelsForSession(sessionId);
      for (const panel of panels) {
        if (panel.type === 'claude') {
          await claudeExecutor.kill(panel.id, 'interrupted');
        } else if (panel.type === 'codex') {
          await codexExecutor.kill(panel.id, 'interrupted');
        } else if (panel.type === 'gemini') {
          await geminiExecutor.kill(panel.id, 'interrupted');
        } else if (panel.type === 'kimi') {
          await kimiExecutor.kill(panel.id, 'interrupted');
        }
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop session' };
    }
  });

  ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) return { success: false, error: 'Session not found' };

      // Stop any running panels first
      const panels = panelManager.getPanelsForSession(sessionId);
      for (const panel of panels) {
        if (panel.type === 'claude') {
          await claudeExecutor.kill(panel.id);
        } else if (panel.type === 'codex') {
          await codexExecutor.kill(panel.id);
        } else if (panel.type === 'gemini') {
          await geminiExecutor.kill(panel.id);
        } else if (panel.type === 'kimi') {
          await kimiExecutor.kill(panel.id);
        }
      }

      // Remove worktree folder if it's a worktree (never delete the main repo folder)
      try {
        const projectId = session.projectId;
        if (projectId) {
          const project = databaseService.getProject(projectId);
          if (project?.path && session.worktreePath && session.worktreePath !== project.path) {
            await worktreeManager.removeWorktreePath(project.path, session.worktreePath);
          }
        }
      } catch {
        // best-effort; deletion should still proceed
      }

      sessionManager.deleteSessionPermanently(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete session' };
    }
  });

  ipcMain.handle('sessions:update', async (_event, sessionId: string, updates: import('@snowtree/core/types/session').SessionUpdate) => {
    try {
      sessionManager.updateSession(sessionId, updates);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update session' };
    }
  });

  ipcMain.handle('sessions:set-active-session', async (_event, sessionId: string | null) => {
    try {
      gitStatusManager.setActiveSession(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set active session' };
    }
  });

  ipcMain.handle('sessions:get-timeline', async (_event, sessionId: string) => {
    try {
      const events = sessionManager.getTimelineEvents(sessionId);
      return { success: true, data: events };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load timeline' };
    }
  });

  ipcMain.handle('sessions:terminal-ensure-panel', async (_event, sessionId: string) => {
    try {
      const panel = await sessionManager.ensureTerminalPanel(sessionId);
      return { success: true, data: panel };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to ensure terminal panel' };
    }
  });

  ipcMain.handle('sessions:terminal-precreate', async (_event, sessionId: string) => {
    try {
      await sessionManager.preCreateTerminalSession(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to pre-create terminal session' };
    }
  });

  ipcMain.handle('sessions:terminal-input', async (_event, sessionId: string, data: string) => {
    try {
      await sessionManager.sendTerminalInput(sessionId, data);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send terminal input' };
    }
  });

  ipcMain.handle('sessions:terminal-resize', async (_event, sessionId: string, cols: number, rows: number) => {
    try {
      sessionManager.resizeTerminal(sessionId, cols, rows);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resize terminal' };
    }
  });

  ipcMain.handle('sessions:terminal-get-outputs', async (_event, panelId: string, limit?: number) => {
    try {
      const outputs = sessionManager.getSessionOutputsForPanel(panelId, limit);
      const serialized = outputs.map(output => {
        const timestamp = output.timestamp as unknown;
        return {
          ...output,
          timestamp: timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
        };
      });
      return { success: true, data: serialized };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load terminal outputs' };
    }
  });

  ipcMain.handle('panels:continue', async (_event, panelId: string, input: string, _model?: string, options?: { skipCheckpointAutoCommit?: boolean; planMode?: boolean }, images?: Array<{ id: string; filename: string; mime: string; dataUrl: string }>) => {
    let sessionIdForError: string | null = null;
    const planMode = options?.planMode ?? false;
    try {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return { success: false, error: 'Panel not found' };

      const session = sessionManager.getSession(panel.sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not available' };
      sessionIdForError = session.id;

      // Check if worktree path still exists; if not, try to recover it (also renames git branch)
      const worktreePath = await tryRecoverWorktreePath(session.id);
      if (!worktreePath) {
        return {
          success: false,
          error: `Workspace directory not found: ${session.worktreePath}\n\nThe workspace may have been renamed or deleted. Please create a new session.`
        };
      }

      sessionManager.updateSessionStatus(session.id, 'running');

      let imagePaths: string[] = [];
      if (images && images.length > 0) {
        try {
          imagePaths = persistRendererImageAttachments(session.id, images).imagePaths;
        } catch (err) {
          logger?.warn?.('[panels:continue] Failed to persist image attachments; sending text-only', err as Error);
          imagePaths = [];
        }
      }

      // Keep original message content with [img1], [img2] etc. tags intact
      const messageContent = input;
      sessionManager.addPanelConversationMessage(panelId, 'user', messageContent);

      // IMPORTANT: PanelManager caches panel state; agent resume tokens are persisted via SessionManager/db.
      // Always read the latest persisted agent session id from the database to preserve conversation context.
      const persistedAgentSessionId = sessionManager.getPanelAgentSessionId(panelId);
      const persistedAgentCwd = sessionManager.getPanelAgentCwd(panelId);
      const agentCwdForSpawn = persistedAgentCwd && fs.existsSync(persistedAgentCwd)
        ? persistedAgentCwd
        : worktreePath;

      const providerConfig = readProviderConfig(panel.type);

      if (panel.type === 'claude') {
        const manager = getClaudePanelManager();
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        if (typeof persistedAgentSessionId === 'string' && persistedAgentSessionId) {
          manager.setAgentSessionId(panelId, persistedAgentSessionId);
        }

        if (claudeExecutor.isRunning(panelId)) {
          manager.sendInputToPanel(panelId, input, imagePaths);
        } else {
          const history = sessionManager.getPanelConversationMessages(panelId);
          await manager.continuePanel({
            panelId,
            worktreePath: agentCwdForSpawn,
            prompt: input,
            conversationHistory: history,
            planMode,
            imagePaths,
            providerConfig,
          });
        }
        return { success: true };
      }

      if (panel.type === 'codex') {
        const manager = getCodexPanelManager();
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        if (typeof persistedAgentSessionId === 'string' && persistedAgentSessionId) {
          manager.setAgentSessionId(panelId, persistedAgentSessionId);
        }

        if (codexExecutor.isRunning(panelId)) {
          manager.sendInputToPanel(panelId, input, imagePaths);
        } else {
          const history = sessionManager.getPanelConversationMessages(panelId);
          await manager.continuePanel({
            panelId,
            worktreePath,
            prompt: input,
            conversationHistory: history,
            planMode,
            imagePaths,
            providerConfig,
          });
        }
        return { success: true };
      }

      if (panel.type === 'gemini') {
        const manager = getGeminiPanelManager();
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        if (typeof persistedAgentSessionId === 'string' && persistedAgentSessionId) {
          manager.setAgentSessionId(panelId, persistedAgentSessionId);
        }

        if (geminiExecutor.isRunning(panelId)) {
          manager.sendInputToPanel(panelId, input, imagePaths);
        } else {
          const history = sessionManager.getPanelConversationMessages(panelId);
          await manager.continuePanel({
            panelId,
            worktreePath,
            prompt: input,
            conversationHistory: history,
            planMode,
            imagePaths,
            providerConfig,
          });
        }
        return { success: true };
      }

      if (panel.type === 'kimi') {
        const manager = getKimiPanelManager();
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        if (typeof persistedAgentSessionId === 'string' && persistedAgentSessionId) {
          manager.setAgentSessionId(panelId, persistedAgentSessionId);
        }

        if (kimiExecutor.isRunning(panelId)) {
          manager.sendInputToPanel(panelId, input, imagePaths);
        } else {
          const history = sessionManager.getPanelConversationMessages(panelId);
          await manager.continuePanel({
            panelId,
            worktreePath,
            prompt: input,
            conversationHistory: history,
            planMode,
            imagePaths,
            providerConfig,
          });
        }
        return { success: true };
      }

      return { success: false, error: `Unsupported panel type: ${panel.type}` };
    } catch (error) {
      sessionManager.addPanelConversationMessage(panelId, 'assistant', `Error: ${error instanceof Error ? error.message : String(error)}`);
      if (sessionIdForError) {
        sessionManager.updateSessionStatus(sessionIdForError, 'error', error instanceof Error ? error.message : String(error));
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to continue panel' };
    }
  });

  // Answer user question handlers for Claude, Codex, Gemini, and Kimi panels
  ipcMain.handle('claude-panels:answer-question', async (_event, panelId: string, answers: Record<string, string | string[]>) => {
    try {
      logger?.info(`[IPC] claude-panels:answer-question called for panelId: ${panelId}, answers: ${JSON.stringify(answers)}`);

      // Ensure panel is registered before answering
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        throw new Error(`Panel ${panelId} not found`);
      }
      const session = sessionManager.getSession(panel.sessionId);
      if (!session) {
        throw new Error(`Session ${panel.sessionId} not found`);
      }

      const manager = getClaudePanelManager();
      // Only register if not already registered (to preserve agentSessionId in memory)
      if (!manager.getPanelState(panelId)) {
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        // Hydrate agentSessionId from database after registration
        const agentSessionId = sessionManager.getPanelAgentSessionId(panelId);
        if (agentSessionId) {
          manager.setAgentSessionId(panelId, agentSessionId);
        }
      }

      await manager.answerQuestion(panelId, answers);
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger?.error(`[IPC] claude-panels:answer-question failed: ${err.message}`, err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('codexPanel:answer-question', async (_event, panelId: string, answers: Record<string, string | string[]>) => {
    try {
      logger?.info(`[IPC] codexPanel:answer-question called for panelId: ${panelId}, answers: ${JSON.stringify(answers)}`);

      // Ensure panel is registered before answering
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        throw new Error(`Panel ${panelId} not found`);
      }
      const session = sessionManager.getSession(panel.sessionId);
      if (!session) {
        throw new Error(`Session ${panel.sessionId} not found`);
      }

      const manager = getCodexPanelManager();
      // Only register if not already registered (to preserve agentSessionId in memory)
      if (!manager.getPanelState(panelId)) {
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        // Hydrate agentSessionId from database after registration
        const agentSessionId = sessionManager.getPanelAgentSessionId(panelId);
        if (agentSessionId) {
          manager.setAgentSessionId(panelId, agentSessionId);
        }
      }

      await manager.answerQuestion(panelId, answers);
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger?.error(`[IPC] codexPanel:answer-question failed: ${err.message}`, err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('geminiPanel:answer-question', async (_event, panelId: string, answers: Record<string, string | string[]>) => {
    try {
      logger?.info(`[IPC] geminiPanel:answer-question called for panelId: ${panelId}, answers: ${JSON.stringify(answers)}`);

      // Ensure panel is registered before answering
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        throw new Error(`Panel ${panelId} not found`);
      }
      const session = sessionManager.getSession(panel.sessionId);
      if (!session) {
        throw new Error(`Session ${panel.sessionId} not found`);
      }

      const manager = getGeminiPanelManager();
      // Only register if not already registered (to preserve agentSessionId in memory)
      if (!manager.getPanelState(panelId)) {
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        // Hydrate agentSessionId from database after registration
        const agentSessionId = sessionManager.getPanelAgentSessionId(panelId);
        if (agentSessionId) {
          manager.setAgentSessionId(panelId, agentSessionId);
        }
      }

      await manager.answerQuestion(panelId, answers);
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger?.error(`[IPC] geminiPanel:answer-question failed: ${err.message}`, err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('kimiPanel:answer-question', async (_event, panelId: string, answers: Record<string, string | string[]>) => {
    try {
      logger?.info(`[IPC] kimiPanel:answer-question called for panelId: ${panelId}, answers: ${JSON.stringify(answers)}`);

      // Ensure panel is registered before answering
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        throw new Error(`Panel ${panelId} not found`);
      }
      const session = sessionManager.getSession(panel.sessionId);
      if (!session) {
        throw new Error(`Session ${panel.sessionId} not found`);
      }

      const manager = getKimiPanelManager();
      // Only register if not already registered (to preserve agentSessionId in memory)
      if (!manager.getPanelState(panelId)) {
        manager.registerPanel(panelId, session.id, panel.state?.customState as AIPanelState | undefined, false);
        // Hydrate agentSessionId from database after registration
        const agentSessionId = sessionManager.getPanelAgentSessionId(panelId);
        if (agentSessionId) {
          manager.setAgentSessionId(panelId, agentSessionId);
        }
      }

      await manager.answerQuestion(panelId, answers);
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger?.error(`[IPC] kimiPanel:answer-question failed: ${err.message}`, err);
      return { success: false, error: err.message };
    }
  });
}
