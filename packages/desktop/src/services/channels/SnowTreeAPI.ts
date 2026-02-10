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
import type {
  SnowTreeCommandRequest,
  SnowTreeCommandResponse,
  ChannelContext,
} from './types';

export interface SnowTreeAPIDeps {
  sessionManager: SessionManager;
  taskQueue: TaskQueue | null;
  worktreeManager: WorktreeManager;
  logger?: Logger;
}

/**
 * SnowTreeAPI - Channel-agnostic API for controlling Snowtree
 *
 * This class handles all Snowtree operations and can be used by any channel
 * (Telegram, Slack, Discord, CLI, etc.)
 */
export class SnowTreeAPI {
  constructor(private deps: SnowTreeAPIDeps) {}

  async execute(command: SnowTreeCommandRequest, context: ChannelContext): Promise<SnowTreeCommandResponse> {
    switch (command.name) {
      case 'list_projects':
        return this.listProjects();

      case 'open_project':
        return this.openProject(command, context);

      case 'list_sessions':
        return this.listSessions(context);

      case 'select_session':
        return this.selectSession(command, context);

      case 'new_session':
        return this.createSession(command, context);

      case 'status':
        return this.status(context);

      case 'send_message':
        return this.sendMessage(command, context);

      case 'switch_executor':
        return this.switchExecutor(command, context);

      case 'stop_session':
        return this.stopSession(context);

      case 'delete_session':
        return this.deleteSession(command, context);

      case 'help':
        return this.help();

      case 'unknown':
      default:
        return this.help();
    }
  }

  // ===========================================================================
  // Project Commands
  // ===========================================================================

  private listProjects(): SnowTreeCommandResponse {
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

  private openProject(command: SnowTreeCommandRequest, context: ChannelContext): SnowTreeCommandResponse {
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

    // Update context (caller should persist this)
    context.activeProjectId = project.id;
    context.activeSessionId = null;

    return { message: `✅ Opened: *${project.name}*`, parseMode: 'Markdown' };
  }

  // ===========================================================================
  // Session Commands
  // ===========================================================================

  private listSessions(context: ChannelContext): SnowTreeCommandResponse {
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

  private selectSession(command: SnowTreeCommandRequest, context: ChannelContext): SnowTreeCommandResponse {
    const id = command.args?.id?.trim();
    if (!id) {
      return { message: 'Please specify a session ID.' };
    }

    const sessions = context.activeProjectId
      ? this.deps.sessionManager.getSessionsForProject(context.activeProjectId)
      : [];

    const session = sessions.find(s => s.id.startsWith(id));
    if (!session) {
      return { message: `Session "${id}" not found.` };
    }

    context.activeSessionId = session.id;

    return { message: `✅ Selected: *${session.name}*`, parseMode: 'Markdown' };
  }

  private async createSession(command: SnowTreeCommandRequest, context: ChannelContext): Promise<SnowTreeCommandResponse> {
    const prompt = command.args?.prompt?.trim();
    if (!prompt) {
      return { message: 'Please provide a prompt for the new session.' };
    }

    return this.createSessionWithPrompt(prompt, context, '🚀 Creating new session');
  }

  private async createSessionWithPrompt(
    prompt: string,
    context: ChannelContext,
    label: string
  ): Promise<SnowTreeCommandResponse> {
    // Auto-select project if not set
    if (!context.activeProjectId) {
      const activeProject = this.deps.sessionManager.getActiveProject();
      if (activeProject) {
        context.activeProjectId = activeProject.id;
      } else {
        const projects = this.deps.sessionManager.db.getAllProjects();
        if (projects.length > 0) {
          context.activeProjectId = projects[0].id;
          this.deps.sessionManager.db.setActiveProject(projects[0].id);
          this.deps.sessionManager.setActiveProject(projects[0]);
        } else {
          return { message: 'No projects found. Please add a project first.' };
        }
      }
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

    context.activeSessionId = sessionId;

    return {
      message: `${label}: \`${sessionId.slice(0, 6)}\``,
      parseMode: 'Markdown'
    };
  }

  // ===========================================================================
  // Status & Control Commands
  // ===========================================================================

  private status(context: ChannelContext): SnowTreeCommandResponse {
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
      msg += `Executor: ${session.toolType || 'none'}\n`;
    }

    return { message: msg, parseMode: 'Markdown' };
  }

  private switchExecutor(command: SnowTreeCommandRequest, context: ChannelContext): SnowTreeCommandResponse {
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

  private async stopSession(context: ChannelContext): Promise<SnowTreeCommandResponse> {
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

  private async deleteSession(command: SnowTreeCommandRequest, context: ChannelContext): Promise<SnowTreeCommandResponse> {
    const id = command.args?.id?.trim();
    if (!id) {
      return { message: 'Please specify a session ID to delete.' };
    }

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
      context.activeSessionId = null;
    }

    return {
      message: `✅ Deleted session: *${session.name}*`,
      parseMode: 'Markdown'
    };
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private async sendMessage(command: SnowTreeCommandRequest, context: ChannelContext): Promise<SnowTreeCommandResponse> {
    const message = command.args?.message?.trim();
    if (!message) {
      return { message: 'Please provide a message to send.' };
    }

    if (!context.activeSessionId) {
      return this.createSessionWithPrompt(message, context, '🚀 Starting agent');
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

  // ===========================================================================
  // Help
  // ===========================================================================

  private help(): SnowTreeCommandResponse {
    const msg = [
      '*Available commands:*',
      '',
      '/status - Show active project/session',
      '/projects - List all projects',
      '/open <name> - Open a project',
      '/sessions - List sessions',
      '/select <id> - Select a session',
      '/new <prompt> - Create a new session',
      '/stop - Stop the active session',
      '/delete <id> - Delete a session',
      '/use <executor> - Switch to claude/codex/gemini/kimi',
      '/help - Show this help',
      '',
      'Or just type a message to send to the active session.',
    ].join('\n');

    return { message: msg, parseMode: 'Markdown' };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getDefaultToolType(): 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' {
    const pref = this.deps.sessionManager.db.getUserPreference('defaultToolType');
    if (pref === 'codex' || pref === 'gemini' || pref === 'kimi' || pref === 'none') {
      return pref;
    }
    return 'claude';
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
      this.deps.logger?.warn?.(`[SnowTreeAPI] Failed to recover worktree path: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ===========================================================================
  // Public Helpers for Channels
  // ===========================================================================

  getActiveProject(): { id: number; name: string; path: string } | null {
    return this.deps.sessionManager.getActiveProject();
  }

  getSession(sessionId: string): Session | undefined {
    return this.deps.sessionManager.getSession(sessionId);
  }
}
