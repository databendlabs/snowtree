import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { Session } from '@snowtree/core/types/session';
import type { ToolPanel } from '@snowtree/core/types/panels';
import type { AIPanelState } from '@snowtree/core/types/aiPanelConfig';
import { panelManager } from '../../features/panels/PanelManager';
import { getPanelManagerForType } from '../../features/panels/ai/panelManagerRegistry';
import type { SessionManager } from '../../features/session/SessionManager';
import type { TaskQueue } from '../../features/queue/TaskQueue';
import type { WorktreeManager } from '../../features/worktree/WorktreeManager';
import type { Logger } from '../../infrastructure/logging/logger';
import type { TelegramCommandRequest, TelegramCommandResponse, TelegramContext } from './types';
import { TelegramContextStore } from './contextStore';

interface TelegramCommandExecutorDeps {
  sessionManager: SessionManager;
  taskQueue: TaskQueue | null;
  worktreeManager: WorktreeManager;
  logger?: Logger;
  contextStore: TelegramContextStore;
  isAgentAvailable: () => boolean;
}

export class TelegramCommandExecutor {
  constructor(private deps: TelegramCommandExecutorDeps) {}

  async execute(command: TelegramCommandRequest, chatId: string | number): Promise<TelegramCommandResponse> {
    const context = this.ensureContext(chatId);

    switch (command.name) {
      case 'get_chat_id':
        return {
          message: `Your Chat ID: \`${chatId}\``,
          parseMode: 'Markdown'
        };

      case 'list_projects':
        return this.listProjects(context);

      case 'open_project':
        return this.openProject(command, chatId);

      case 'list_sessions':
        return this.listSessions(context);

      case 'select_session':
        return this.selectSession(command, chatId);

      case 'new_session':
        return this.createSession(command, chatId);

      case 'status':
        return this.status(context);

      case 'send_message':
        return this.sendMessage(command, context, chatId);

      case 'switch_executor':
        return this.switchExecutor(command, context);

      case 'stop_session':
        return this.stopSession(context);

      case 'delete_session':
        return this.deleteSession(command, chatId);

      case 'help':
        return this.help();

      case 'unknown':
      default:
        return this.help();
    }
  }

  private ensureContext(chatId: string | number): TelegramContext {
    const context = this.deps.contextStore.get(chatId);
    if (!context.activeProjectId) {
      const activeProject = this.deps.sessionManager.getActiveProject();
      if (activeProject) {
        return this.deps.contextStore.update(chatId, { activeProjectId: activeProject.id });
      }
    }
    return context;
  }

  private listProjects(_context: TelegramContext): TelegramCommandResponse {
    const projects = this.deps.sessionManager.db.getAllProjects();
    if (projects.length === 0) {
      return { message: 'No projects found.' };
    }

    let msg = '📁 *Projects*\n\n';
    projects.forEach((project, index) => {
      msg += `${index + 1}. ${project.name}\n`;
    });
    msg += '\nSay "open <name>" to select.';

    return { message: msg, parseMode: 'Markdown' };
  }

  private openProject(command: TelegramCommandRequest, chatId: string | number): TelegramCommandResponse {
    const name = command.args?.name?.trim();
    if (!name) {
      return { message: 'Please specify a project name.' };
    }

    const projects = this.deps.sessionManager.db.getAllProjects();
    const project = projects.find(p =>
      p.name.toLowerCase() === name.toLowerCase() ||
      p.name.toLowerCase().includes(name.toLowerCase())
    );

    if (!project) {
      return { message: `Project "${name}" not found.` };
    }

    this.deps.sessionManager.db.setActiveProject(project.id);
    this.deps.sessionManager.setActiveProject(project);
    this.deps.contextStore.update(chatId, { activeProjectId: project.id, activeSessionId: null });

    return { message: `✅ Opened: *${project.name}*`, parseMode: 'Markdown' };
  }

  private listSessions(context: TelegramContext): TelegramCommandResponse {
    if (!context.activeProjectId) {
      return { message: 'No project selected. Say "open <name>" first.' };
    }

    const sessions = this.deps.sessionManager.getSessionsForProject(context.activeProjectId);
    if (sessions.length === 0) {
      return { message: 'No sessions. Say "new <prompt>" to create.' };
    }

    let msg = '📋 *Sessions*\n\n';
    sessions.slice(0, 10).forEach((session, index) => {
      const marker = session.id === context.activeSessionId ? '→ ' : '  ';
      const shortId = session.id.slice(0, 6);
      msg += `${marker}${index + 1}. [${shortId}] ${session.name} (${session.status})\n`;
    });

    if (sessions.length > 10) {
      msg += `\n... and ${sessions.length - 10} more`;
    }

    msg += '\n\nSay "select <id>" to select.';

    return { message: msg, parseMode: 'Markdown' };
  }

  private selectSession(command: TelegramCommandRequest, chatId: string | number): TelegramCommandResponse {
    const id = command.args?.id?.trim();
    if (!id) {
      return { message: 'Please specify a session ID.' };
    }

    const context = this.deps.contextStore.get(chatId);
    const sessions = context.activeProjectId
      ? this.deps.sessionManager.getSessionsForProject(context.activeProjectId)
      : [];

    const session = sessions.find(s => s.id.startsWith(id));
    if (!session) {
      return { message: `Session "${id}" not found.` };
    }

    this.deps.contextStore.update(chatId, { activeSessionId: session.id });

    return { message: `✅ Selected: *${session.name}*`, parseMode: 'Markdown' };
  }

  private async createSession(command: TelegramCommandRequest, chatId: string | number): Promise<TelegramCommandResponse> {
    const prompt = command.args?.prompt?.trim();
    if (!prompt) {
      return { message: 'Please provide a prompt for the new session.' };
    }

    return this.createSessionWithPrompt(prompt, chatId, '🚀 Creating new session');
  }

  private getDefaultToolType(): 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' {
    const pref = this.deps.sessionManager.db.getUserPreference('defaultToolType');
    if (pref === 'codex' || pref === 'gemini' || pref === 'kimi' || pref === 'none') {
      return pref;
    }
    return 'claude';
  }

  private status(context: TelegramContext): TelegramCommandResponse {
    const project = context.activeProjectId
      ? this.deps.sessionManager.db.getProject(context.activeProjectId)
      : null;
    const session = context.activeSessionId
      ? this.deps.sessionManager.getSession(context.activeSessionId)
      : null;

    let msg = '📊 *Status*\n\n';
    msg += `Project: ${project ? project.name : '_none_'}\n`;
    msg += `Session: ${session ? session.name : '_none_'}\n`;
    if (session) {
      msg += `Status: ${session.status}\n`;
    }
    msg += `\nAgent: ${this.deps.isAgentAvailable() ? '✅ AI' : '⚡ Fallback'}`;

    return { message: msg, parseMode: 'Markdown' };
  }

  private async sendMessage(command: TelegramCommandRequest, context: TelegramContext, chatId: string | number): Promise<TelegramCommandResponse> {
    const message = command.args?.message?.trim();
    if (!message) {
      return { message: 'Please provide a message to send.' };
    }

    if (!context.activeSessionId) {
      return this.createSessionWithPrompt(message, chatId, '🚀 Starting agent');
    }

    const error = await this.dispatchToSession(
      context.activeSessionId,
      message,
      command.attachments
    );

    if (error) {
      return { message: error };
    }

    return { showTyping: true };
  }

  private async createSessionWithPrompt(
    prompt: string,
    chatId: string | number,
    label: string
  ): Promise<TelegramCommandResponse> {
    const context = this.deps.contextStore.get(chatId);
    if (!context.activeProjectId) {
      return { message: 'No project selected. Say "open <name>" first.' };
    }

    if (!this.deps.taskQueue) {
      return { message: 'Task queue not initialized.' };
    }

    const toolType = this.getDefaultToolType();
    if (toolType !== 'none') {
      getPanelManagerForType(toolType);
    }

    const sessionId = randomUUID();
    await this.deps.taskQueue.createSession({
      sessionId,
      prompt,
      worktreeTemplate: '',
      projectId: context.activeProjectId,
      toolType
    });

    this.deps.contextStore.update(chatId, { activeSessionId: sessionId });

    return {
      message: `${label}: \`${sessionId.slice(0, 6)}\``,
      parseMode: 'Markdown'
    };
  }

  private help(): TelegramCommandResponse {
    const msg = [
      'Try:',
      '- list projects',
      '- open <name>',
      '- list sessions',
      '- select <id>',
      '- new <prompt>',
      '- status',
      '- send <message>',
      '- switch to claude/codex/gemini/kimi',
      '- stop session',
      '- delete <id>',
      '- chat id'
    ].join('\n');

    return { message: msg };
  }

  private switchExecutor(command: TelegramCommandRequest, context: TelegramContext): TelegramCommandResponse {
    const executor = command.args?.executor?.toLowerCase()?.trim();
    const validExecutors = ['claude', 'codex', 'gemini', 'kimi'];

    if (!executor || !validExecutors.includes(executor)) {
      return { message: `Please specify an executor: ${validExecutors.join(', ')}` };
    }

    if (!context.activeSessionId) {
      return { message: 'No session selected. Say "select <id>" first.' };
    }

    const session = this.deps.sessionManager.getSession(context.activeSessionId);
    if (!session) {
      return { message: 'Session not found.' };
    }

    const toolType = executor as 'claude' | 'codex' | 'gemini' | 'kimi';
    this.deps.sessionManager.updateSession(context.activeSessionId, { toolType });

    // Create new panel for the executor if needed
    const panels = panelManager.getPanelsForSession(context.activeSessionId);
    const existingPanel = panels.find(p => p.type === toolType);

    if (!existingPanel) {
      panelManager.createPanel({
        sessionId: context.activeSessionId,
        type: toolType,
        title: toolType.charAt(0).toUpperCase() + toolType.slice(1)
      });
    }

    return {
      message: `✅ Switched to *${toolType}*`,
      parseMode: 'Markdown'
    };
  }

  private async stopSession(context: TelegramContext): Promise<TelegramCommandResponse> {
    if (!context.activeSessionId) {
      return { message: 'No session selected.' };
    }

    const session = this.deps.sessionManager.getSession(context.activeSessionId);
    if (!session) {
      return { message: 'Session not found.' };
    }

    // Stop all AI executors for this session
    const panels = panelManager.getPanelsForSession(context.activeSessionId);
    for (const panel of panels) {
      if (this.isAiPanel(panel)) {
        const managerInfo = getPanelManagerForType(panel.type);
        if (managerInfo) {
          await managerInfo.executor.kill(panel.id);
        }
      }
    }

    this.deps.sessionManager.updateSessionStatus(context.activeSessionId, 'stopped');

    return {
      message: `✅ Stopped session: *${session.name}*`,
      parseMode: 'Markdown'
    };
  }

  private async deleteSession(command: TelegramCommandRequest, chatId: string | number): Promise<TelegramCommandResponse> {
    const id = command.args?.id?.trim();
    if (!id) {
      return { message: 'Please specify a session ID to delete.' };
    }

    const context = this.deps.contextStore.get(chatId);
    const sessions = context.activeProjectId
      ? this.deps.sessionManager.getSessionsForProject(context.activeProjectId)
      : [];

    const session = sessions.find(s => s.id.startsWith(id));
    if (!session) {
      return { message: `Session "${id}" not found.` };
    }

    // Stop any running executors first
    const panels = panelManager.getPanelsForSession(session.id);
    for (const panel of panels) {
      if (this.isAiPanel(panel)) {
        const managerInfo = getPanelManagerForType(panel.type);
        if (managerInfo) {
          await managerInfo.executor.kill(panel.id);
        }
      }
    }

    // Delete the session
    await this.deps.sessionManager.archiveSession(session.id);

    // Clear from context if it was active
    if (context.activeSessionId === session.id) {
      this.deps.contextStore.update(chatId, { activeSessionId: null });
    }

    return {
      message: `✅ Deleted session: *${session.name}*`,
      parseMode: 'Markdown'
    };
  }

  private async dispatchToSession(sessionId: string, message: string, attachments?: string[]): Promise<string | null> {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session || !session.worktreePath) {
      return 'Session worktree not available.';
    }

    const panel = this.resolvePanel(session);
    if (!panel) {
      return 'No AI panel found for this session.';
    }

    const worktreePath = await this.resolveWorktreePath(sessionId, session);
    if (!worktreePath) {
      return `Workspace directory not found: ${session.worktreePath}`;
    }

    const managerInfo = getPanelManagerForType(panel.type);
    if (!managerInfo) {
      return `Unsupported panel type: ${panel.type}`;
    }

    const { manager, executor } = managerInfo;
    const persistedAgentSessionId = this.deps.sessionManager.getPanelAgentSessionId(panel.id);
    const persistedAgentCwd = this.deps.sessionManager.getPanelAgentCwd(panel.id);
    const agentCwdForSpawn = persistedAgentCwd && fs.existsSync(persistedAgentCwd)
      ? persistedAgentCwd
      : worktreePath;

    this.deps.sessionManager.updateSessionStatus(sessionId, 'running');
    this.deps.sessionManager.addPanelConversationMessage(panel.id, 'user', message);

    manager.registerPanel(panel.id, session.id, panel.state?.customState as AIPanelState | undefined, false);
    if (typeof persistedAgentSessionId === 'string' && persistedAgentSessionId) {
      manager.setAgentSessionId(panel.id, persistedAgentSessionId);
    }

    if (executor.isRunning(panel.id)) {
      manager.sendInputToPanel(panel.id, message, attachments);
      return null;
    }

    const history = this.deps.sessionManager.getPanelConversationMessages(panel.id);
    await manager.continuePanel({
      panelId: panel.id,
      worktreePath: agentCwdForSpawn,
      prompt: message,
      conversationHistory: history,
      imagePaths: attachments
    });

    return null;
  }

  private resolvePanel(session: Session): ToolPanel | null {
    const activePanel = this.deps.sessionManager.db.getActivePanel(session.id);
    if (activePanel && this.isAiPanel(activePanel)) {
      return activePanel;
    }

    const panels = panelManager.getPanelsForSession(session.id);
    const preferred = panels.find(panel => panel.type === 'claude')
      || panels.find(panel => panel.type === 'codex')
      || panels.find(panel => panel.type === 'gemini')
      || panels.find(panel => panel.type === 'kimi');

    return preferred || null;
  }

  private isAiPanel(panel: ToolPanel): boolean {
    return panel.type === 'claude'
      || panel.type === 'codex'
      || panel.type === 'gemini'
      || panel.type === 'kimi';
  }

  private async resolveWorktreePath(sessionId: string, session: Session): Promise<string | null> {
    if (fs.existsSync(session.worktreePath)) {
      return session.worktreePath;
    }

    const dbSession = this.deps.sessionManager.getDbSession(sessionId);
    const worktreeName = dbSession?.worktree_name;
    const project = session.projectId
      ? this.deps.sessionManager.db.getProject(session.projectId)
      : null;

    if (!project || !worktreeName) {
      return null;
    }

    try {
      const worktrees = await this.deps.worktreeManager.listWorktreesDetailed(project.path, sessionId);
      const matching = worktrees.find(worktree => worktree.branch === worktreeName);
      if (!matching) {
        return null;
      }

      this.deps.sessionManager.updateSession(sessionId, { worktreePath: matching.path });
      return matching.path;
    } catch (error) {
      this.deps.logger?.warn?.(`[Telegram] Failed to recover worktree path: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
