// @ts-nocheck
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { spawn, ChildProcess, exec, execSync } from 'child_process';
import { ShellDetector } from '../../infrastructure/command/shellDetector';
import type { Session, SessionUpdate, SessionOutput } from '@snowtree/core/types/session';
import type { DatabaseService } from '../../infrastructure/database/database';
import type { Session as DbSession, CreateSessionData, UpdateSessionData, ConversationMessage, PromptMarker, ExecutionDiff, CreateExecutionDiffData, Project, CreateTimelineEventData, TimelineEvent } from '../../infrastructure/database/models';
import { getShellPath } from '../../infrastructure/command/shellPath';
import { TerminalManager } from './TerminalManager';
import { TerminalPanelCoordinator } from './TerminalPanelCoordinator';
import type { BaseAIPanelState, ToolPanelState, ToolPanel } from '@snowtree/core/types/panels';
import { formatForDisplay } from '../../infrastructure/utils/timestampUtils';
import { scriptExecutionTracker } from '../queue/ScriptExecutionTracker';

// Interface for generic JSON message data that can contain various properties
interface GenericMessageData {
  type?: string;
  subtype?: string;
  session_id?: string;
  message_id?: string;
  message?: {
    content?: unknown;
    [key: string]: unknown;
  };
  data?: Record<string, unknown>;
  delta?: string;
  [key: string]: unknown;
}

// Helper function to check if data is a JSON message object with specific properties
function isJSONMessage(data: Record<string, unknown>, requiredType?: string, requiredSubtype?: string): data is GenericMessageData {
  if (typeof data.type !== 'string') return false;
  if (requiredType && data.type !== requiredType) return false;
  if (requiredSubtype && typeof data.subtype !== 'string') return false;
  if (requiredSubtype && data.subtype !== requiredSubtype) return false;
  return true;
}

// Interface for panel state with custom state that can hold any AI-specific data
interface PanelStateWithCustomData extends ToolPanelState {
  customState?: Record<string, unknown>;
  [key: string]: unknown;
}
import { withLock } from '../../infrastructure/utils/mutex';
import * as fs from 'fs';
import * as os from 'os';
import { panelManager } from '../panels/PanelManager';

const addSessionLog = (..._args: unknown[]) => undefined;
const cleanupSessionLogs = (..._args: unknown[]) => undefined;

export class SessionManager extends EventEmitter {
  private activeSessions: Map<string, Session> = new Map();
  private runningScriptProcess: ChildProcess | null = null;
  private currentRunningSessionId: string | null = null;
  private activeProject: Project | null = null;
  private terminalSessionManager: TerminalManager;
  private terminalPanels: TerminalPanelCoordinator;
  private autoContextBuffers: Map<string, SessionOutput[]> = new Map();
  private streamingAssistantTimelineEventByPanel: Map<string, number> = new Map();

  constructor(public db: DatabaseService) {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    // This is expected since multiple SessionListItem components and project tree views listen to events
    this.setMaxListeners(100);
    this.terminalSessionManager = new TerminalManager();
    this.terminalPanels = new TerminalPanelCoordinator(db);
    
    // Forward terminal output events to the terminal display
    this.terminalSessionManager.on('terminal-output', ({ sessionId, data, type }) => {
      const outputData = typeof data === 'string' ? data : String(data);
      const { panelId, outputId } = this.terminalPanels.recordOutput(sessionId, type, outputData);

      this.emit('terminal-output', {
        sessionId,
        panelId,
        id: outputId,
        type,
        data: outputData,
        timestamp: new Date().toISOString()
      });
    });

    // Forward terminal exit events
    this.terminalSessionManager.on('terminal-exit', (data) => {
      this.emit('terminal-exit', data);
    });

    // Forward zombie process detection events
    this.terminalSessionManager.on('zombie-processes-detected', (data) => {
      this.emit('zombie-processes-detected', data);
    });
  }

  addTimelineEvent(data: Omit<CreateTimelineEventData, 'timestamp'>): TimelineEvent {
    const event = this.db.addTimelineEvent({
      ...data,
      timestamp: new Date().toISOString()
    });
    this.emit('timeline:event', { sessionId: event.session_id, event });
    return event;
  }

  async ensureTerminalPanel(sessionId: string): Promise<ToolPanel> {
    const existing = this.terminalPanels.getPanel(sessionId);
    if (existing) return existing;

    const session = this.getSession(sessionId);
    const dbSession = session ? null : this.db.getSession(sessionId);
    if ((session && session.archived) || (!session && dbSession?.archived)) {
      throw new Error('Cannot access terminal for archived session');
    }
    const worktreePath = session?.worktreePath || dbSession?.worktree_path;

    return this.terminalPanels.ensurePanel(sessionId, worktreePath);
  }

  upsertStreamingAssistantTimeline(panelId: string, sessionId: string, tool: string | undefined, content: string, timestamp?: string): TimelineEvent {
    const ts = typeof timestamp === 'string' && timestamp ? timestamp : new Date().toISOString();
    const existingId = this.streamingAssistantTimelineEventByPanel.get(panelId);

    if (!existingId) {
      let resolvedTool = tool;
      if (!resolvedTool) {
        try {
          const panel = this.db.getPanel(panelId);
          resolvedTool = panel?.type;
        } catch {
          // best-effort
        }
      }
      const event = this.db.addTimelineEvent({
        session_id: sessionId,
        panel_id: panelId,
        kind: 'chat.assistant',
        command: content,
        tool: resolvedTool,
        is_streaming: 1,
        timestamp: ts,
        meta: { streaming: true }
      });
      this.streamingAssistantTimelineEventByPanel.set(panelId, event.id);
      this.emit('timeline:event', { sessionId: event.session_id, event });
      return event;
    }

    const updated = this.db.updateTimelineAssistantEvent(existingId, content, 1, ts);
    this.emit('timeline:event', { sessionId: updated.session_id, event: updated });
    return updated;
  }

  finalizeStreamingAssistantTimeline(panelId: string, sessionId: string, tool: string | undefined, content: string, timestamp?: string): TimelineEvent {
    const ts = typeof timestamp === 'string' && timestamp ? timestamp : new Date().toISOString();
    const existingId = this.streamingAssistantTimelineEventByPanel.get(panelId);

    if (existingId) {
      const updated = this.db.updateTimelineAssistantEvent(existingId, content, 0, ts);
      this.streamingAssistantTimelineEventByPanel.delete(panelId);
      this.emit('timeline:event', { sessionId: updated.session_id, event: updated });
      return updated;
    }

    let resolvedTool = tool;
    if (!resolvedTool) {
      try {
        const panel = this.db.getPanel(panelId);
        resolvedTool = panel?.type;
      } catch {
        // best-effort
      }
    }
    const event = this.db.addTimelineEvent({
      session_id: sessionId,
      panel_id: panelId,
      kind: 'chat.assistant',
      command: content,
      tool: resolvedTool,
      is_streaming: 0,
      timestamp: ts,
      meta: { streaming: false }
    });
    this.emit('timeline:event', { sessionId: event.session_id, event });
    return event;
  }

  clearStreamingAssistantTimeline(panelId: string): void {
    this.streamingAssistantTimelineEventByPanel.delete(panelId);
  }

  getTimelineEvents(sessionId: string): TimelineEvent[] {
    return this.db.getTimelineEvents(sessionId);
  }

  setActiveProject(project: Project): void {
    this.activeProject = project;
    this.emit('active-project-changed', project);
  }

  getActiveProject(): Project | null {
    if (!this.activeProject) {
      this.activeProject = this.db.getActiveProject() || null;
      if (this.activeProject) {
        // Active project loaded successfully
      }
    }
    return this.activeProject;
  }

  getDbSession(id: string): DbSession | undefined {
    return this.db.getSession(id);
  }
  
  getClaudeSessionId(id: string): string | undefined {
    const dbSession = this.db.getSession(id);
    const claudeSessionId = dbSession?.claude_session_id;
    return claudeSessionId || undefined;
  }

  // Panel-scoped Claude session ID for correct per-panel resume behavior
  getPanelClaudeSessionId(panelId: string): string | undefined {
    try {
      const panel = this.db.getPanel(panelId);
      // Check new agentSessionId first, then fall back to legacy claudeSessionId
      const panelState = panel?.state?.customState as BaseAIPanelState | undefined;
      const claudeSessionId = panelState?.agentSessionId || panelState?.claudeSessionId;
      return claudeSessionId;
    } catch (e) {
      return undefined;
    }
  }

  // Panel-scoped Codex session ID for conversation continuation
  getPanelCodexSessionId(panelId: string): string | undefined {
    try {
      const panel = this.db.getPanel(panelId);
      // Check new agentSessionId first, then fall back to legacy codexSessionId
      const panelState = panel?.state?.customState as BaseAIPanelState | undefined;
      const codexSessionId = panelState?.agentSessionId || panelState?.codexSessionId;
      return codexSessionId;
    } catch (e) {
      return undefined;
    }
  }

  beginAutoContextCapture(panelId: string): void {
    // Use synchronous operation - no race condition here as it's a simple set
    this.autoContextBuffers.set(panelId, []);
  }

  collectAutoContextOutput(panelId: string, output: SessionOutput): void {
    // Get buffer atomically - if it doesn't exist, skip collection
    // This prevents race with consumeAutoContextCapture
    const buffer = this.autoContextBuffers.get(panelId);
    if (buffer) {
      buffer.push(output);
    }
  }

  consumeAutoContextCapture(panelId: string): SessionOutput[] {
    // Atomically get and delete the buffer to prevent races with collectAutoContextOutput
    const buffer = this.autoContextBuffers.get(panelId) ?? [];
    this.autoContextBuffers.delete(panelId);
    // Return a copy to prevent external modifications to our internal state
    return [...buffer];
  }

  clearAutoContextCapture(panelId: string): void {
    this.autoContextBuffers.delete(panelId);
  }

  hasAutoContextCapture(panelId: string): boolean {
    return this.autoContextBuffers.has(panelId);
  }
  
  // Generic method for getting agent session ID (works for any AI panel)
  getPanelAgentSessionId(panelId: string): string | undefined {
    try {
      const panel = this.db.getPanel(panelId);
      const customState = panel?.state?.customState as BaseAIPanelState | undefined;
      const agentSessionId = typeof customState?.agentSessionId === 'string' ? customState.agentSessionId : '';
      if (agentSessionId.trim().length > 0) return agentSessionId;

      // Back-compat: infer legacy field by panel type (keeps this modular for future agents).
      if (panel?.type === 'claude' && typeof (customState as BaseAIPanelState | undefined)?.claudeSessionId === 'string') {
        const v = String((customState as BaseAIPanelState).claudeSessionId || '').trim();
        return v || undefined;
      }
      if (panel?.type === 'codex' && typeof (customState as BaseAIPanelState | undefined)?.codexSessionId === 'string') {
        const v = String((customState as BaseAIPanelState).codexSessionId || '').trim();
        return v || undefined;
      }
      return undefined;
    } catch (e) {
      return undefined;
    }
  }

  getPanelAgentCwd(panelId: string): string | undefined {
    try {
      const panel = this.db.getPanel(panelId);
      const customState = panel?.state?.customState as (BaseAIPanelState & { agentCwd?: string }) | undefined;
      const agentCwd = customState?.agentCwd;
      return typeof agentCwd === 'string' && agentCwd.trim().length > 0 ? agentCwd : undefined;
    } catch {
      return undefined;
    }
  }

  clearPanelAgentSessionId(panelId: string): void {
    try {
      const panel = this.db.getPanel(panelId);
      if (!panel) return;
      const currentState = (panel.state as PanelStateWithCustomData) || {};
      const customState = { ...(((currentState.customState as Record<string, unknown> | undefined) || {})) };

      delete customState.agentSessionId;
      delete customState.claudeSessionId;
      delete customState.codexSessionId;

      const updatedState = { ...currentState, customState };
      this.db.updatePanel(panelId, { state: updatedState });
    } catch {
      // best-effort
    }
  }

  persistPanelAgentSessionId(panelId: string, agentSessionId: string, options?: { agentCwd?: string }): void {
    try {
      const panel = this.db.getPanel(panelId);
      if (!panel) return;
      const currentState = (panel.state as PanelStateWithCustomData) || {};
      const customState = (currentState.customState as Record<string, unknown> | undefined) || {};

      const nextCustomState: Record<string, unknown> = { ...customState, agentSessionId };
      // Back-compat: mirror into legacy fields based on panel type (no hardcoded tool list).
      if (panel.type === 'claude') nextCustomState.claudeSessionId = agentSessionId;
      if (panel.type === 'codex') nextCustomState.codexSessionId = agentSessionId;
      const agentCwd = options?.agentCwd;
      if (typeof agentCwd === 'string' && agentCwd.trim().length > 0) nextCustomState.agentCwd = agentCwd;

      const updatedState = { ...currentState, customState: nextCustomState };
      this.db.updatePanel(panelId, { state: updatedState });
    } catch (e) {
      // best-effort persistence
      void e;
    }
  }

  getProjectById(id: number): Project | undefined {
    return this.db.getProject(id);
  }

  getProjectForSession(sessionId: string): Project | undefined {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      return this.getProjectById(dbSession.project_id);
    }
    return undefined;
  }

  initializeFromDatabase(): void {
    // Mark any previously running sessions as stopped
    const activeSessions = this.db.getActiveSessions();
    const activeIds = activeSessions.map(s => s.id);
    if (activeIds.length > 0) {
      this.db.markSessionsAsStopped(activeIds);
    }
    
    // Load all sessions from database
    const dbSessions = this.db.getAllSessions();
    this.emit('sessions-loaded', dbSessions.map(this.convertDbSessionToSession.bind(this)));
  }

  cleanupOrphanedSessions(): void {
    const allSessions = this.db.getAllSessionsIncludingArchived();
    let cleaned = 0;
    for (const session of allSessions) {
      if (session.is_main_repo) continue;
      if (!session.worktree_path) continue;
      if (fs.existsSync(session.worktree_path)) continue;
      try {
        this.deleteSessionPermanently(session.id);
        cleaned++;
      } catch {
        // best-effort
      }
    }
    if (cleaned > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned} orphaned session(s) with missing worktree paths`);
    }
  }

  private convertDbSessionToSession(dbSession: DbSession): Session {
    const toolTypeFromDb = (dbSession as DbSession & { tool_type?: string }).tool_type as 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' | null | undefined;
    const normalizedToolType: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' = toolTypeFromDb === 'codex'
      ? 'codex'
      : toolTypeFromDb === 'gemini'
        ? 'gemini'
        : toolTypeFromDb === 'kimi'
          ? 'kimi'
          : toolTypeFromDb === 'none'
            ? 'none'
            : 'claude';
    const executionModeFromDb = (dbSession as DbSession & { execution_mode?: 'plan' | 'execute' | null }).execution_mode;
    const normalizedExecutionMode: 'plan' | 'execute' = executionModeFromDb === 'plan' ? 'plan' : 'execute';

    const mappedStatus = this.mapDbStatusToSessionStatus(dbSession.status, dbSession.last_viewed_at || undefined, dbSession.updated_at);

    return {
      id: dbSession.id,
      name: dbSession.name,
      worktreePath: dbSession.worktree_path,
      prompt: dbSession.initial_prompt,
      initialPrompt: dbSession.initial_prompt,
      status: mappedStatus,
      statusMessage: dbSession.status_message || undefined,
      pid: dbSession.pid || undefined,
      createdAt: new Date(dbSession.created_at),
      updatedAt: dbSession.updated_at ? new Date(dbSession.updated_at) : undefined,
      lastActivity: new Date(dbSession.updated_at),
      output: [], // Will be loaded separately by frontend when needed
      jsonMessages: [], // Will be loaded separately by frontend when needed
      error: dbSession.exit_code && dbSession.exit_code !== 0 ? `Exit code: ${dbSession.exit_code}` : undefined,
      exitCode: dbSession.exit_code || undefined,
      isRunning: mappedStatus === 'running' || mappedStatus === 'initializing',
      lastViewedAt: dbSession.last_viewed_at || undefined,
      permissionMode: dbSession.permission_mode || undefined,
      runStartedAt: dbSession.run_started_at || undefined,
      isMainRepo: dbSession.is_main_repo ? true : undefined,
      projectId: dbSession.project_id || undefined,
      folderId: dbSession.folder_id || undefined,
      displayOrder: dbSession.display_order || undefined,
      isFavorite: dbSession.is_favorite ? true : undefined,
      autoCommit: dbSession.auto_commit ? true : undefined,
      toolType: normalizedToolType,
      archived: dbSession.archived ? true : false,
      baseCommit: dbSession.base_commit || undefined,
      baseBranch: dbSession.base_branch || undefined,
      commitMode: dbSession.commit_mode || undefined,
      commitModeSettings: dbSession.commit_mode_settings || undefined,
      skipContinueNext: dbSession.skip_continue_next || undefined,
      claudeSessionId: dbSession.claude_session_id || undefined,
      executionMode: normalizedExecutionMode,
      currentBranch: dbSession.current_branch || undefined,
      ownerRepo: dbSession.owner_repo || undefined,
      isFork: dbSession.is_fork || undefined,
      originOwnerRepo: dbSession.origin_owner_repo || undefined,
    };
  }

  private mapDbStatusToSessionStatus(dbStatus: string, lastViewedAt?: string, updatedAt?: string): Session['status'] {
    switch (dbStatus) {
      // `pending` and 'waiting' are treated as 'ready' (ready to start)
      case 'pending':
      case 'waiting': return 'ready';
      case 'initializing': return 'initializing';
      case 'running': return 'running';
      case 'stopped':
      case 'completed': {
        // Show as unviewed if:
        // 1. Database status is 'completed' and session has never been viewed, OR
        // 2. Session was viewed but has been updated since that view
        if (dbStatus === 'completed' && !lastViewedAt) {
          return 'completed_unviewed';
        }
        if (lastViewedAt && updatedAt && new Date(lastViewedAt) < new Date(updatedAt)) {
          return 'completed_unviewed';
        }
        return 'stopped';
      }
      case 'failed':
      case 'error':
        return 'error';
      default: return 'stopped';
    }
  }

  private mapSessionStatusToDbStatus(status: Session['status']): DbSession['status'] {
    switch (status) {
      case 'initializing': return 'initializing';
      case 'ready': return 'waiting';
      case 'running': return 'running';
      case 'waiting': return 'waiting';
      case 'stopped': return 'stopped';
      case 'completed_unviewed': return 'completed';
      case 'error': return 'error';
      default: return 'stopped';
    }
  }

  getAllSessions(): Session[] {
    // Return all sessions regardless of active project
    const dbSessions = this.db.getAllSessions();
    return dbSessions
      .map(this.convertDbSessionToSession.bind(this))
      .filter(session => !session.archived); // Exclude archived sessions by default
  }

  getSessionsForProject(projectId: number): Session[] {
    const dbSessions = this.db.getAllSessions(projectId);
    return dbSessions.map(this.convertDbSessionToSession.bind(this));
  }

  getSession(id: string): Session | undefined {
    // Check cache first to get the in-memory session with outputs
    if (this.activeSessions.has(id)) {
      return this.activeSessions.get(id);
    }

    // Otherwise load from database
    const dbSession = this.db.getSession(id);
    if (dbSession) {
      const session = this.convertDbSessionToSession(dbSession);
      this.activeSessions.set(id, session);
      return session;
    }
    return undefined;
  }

  async createSession(
    nameOrOptions: string | {
      name: string;
      worktreePath: string;
      prompt: string;
      worktreeName?: string;
      permissionMode?: 'approve' | 'ignore';
      projectId?: number;
      isMainRepo?: boolean;
      autoCommit?: boolean;
      folderId?: string;
      toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
      baseCommit?: string;
      baseBranch?: string;
      commitMode?: 'structured' | 'checkpoint' | 'disabled';
      commitModeSettings?: string;
    },
    worktreePath?: string,
    prompt?: string,
    worktreeName?: string,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    isMainRepo?: boolean,
    autoCommit?: boolean,
    folderId?: string,
    toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none',
    baseCommit?: string,
    baseBranch?: string,
    commitMode?: 'structured' | 'checkpoint' | 'disabled',
    commitModeSettings?: string
  ): Promise<Session> {
    // Handle both object and positional parameters
    let name: string;
    let resolvedWorktreePath: string;
    let resolvedPrompt: string;
    let resolvedWorktreeName: string;
    let resolvedPermissionMode: 'approve' | 'ignore' | undefined;
    let resolvedProjectId: number | undefined;
    let resolvedIsMainRepo: boolean | undefined;
    let resolvedAutoCommit: boolean | undefined;
    let resolvedFolderId: string | undefined;
    let resolvedToolType: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' | undefined;
    let resolvedBaseCommit: string | undefined;
    let resolvedBaseBranch: string | undefined;
    let resolvedCommitMode: 'structured' | 'checkpoint' | 'disabled' | undefined;
    let resolvedCommitModeSettings: string | undefined;

    if (typeof nameOrOptions === 'object') {
      // Object parameter style
      name = nameOrOptions.name;
      resolvedWorktreePath = nameOrOptions.worktreePath;
      resolvedPrompt = nameOrOptions.prompt;
      resolvedWorktreeName = nameOrOptions.worktreeName || nameOrOptions.name;
      resolvedPermissionMode = nameOrOptions.permissionMode;
      resolvedProjectId = nameOrOptions.projectId;
      resolvedIsMainRepo = nameOrOptions.isMainRepo;
      resolvedAutoCommit = nameOrOptions.autoCommit;
      resolvedFolderId = nameOrOptions.folderId;
      resolvedToolType = nameOrOptions.toolType;
      resolvedBaseCommit = nameOrOptions.baseCommit;
      resolvedBaseBranch = nameOrOptions.baseBranch;
      resolvedCommitMode = nameOrOptions.commitMode;
      resolvedCommitModeSettings = nameOrOptions.commitModeSettings;
    } else {
      // Positional parameter style
      name = nameOrOptions;
      resolvedWorktreePath = worktreePath!;
      resolvedPrompt = prompt!;
      resolvedWorktreeName = worktreeName!;
      resolvedPermissionMode = permissionMode;
      resolvedProjectId = projectId;
      resolvedIsMainRepo = isMainRepo;
      resolvedAutoCommit = autoCommit;
      resolvedFolderId = folderId;
      resolvedToolType = toolType;
      resolvedBaseCommit = baseCommit;
      resolvedBaseBranch = baseBranch;
      resolvedCommitMode = commitMode;
      resolvedCommitModeSettings = commitModeSettings;
    }

    return await withLock(`session-creation`, async () => {
      return this.createSessionWithId(
        randomUUID(),
        name,
        resolvedWorktreePath,
        resolvedPrompt,
        resolvedWorktreeName,
        resolvedPermissionMode,
        resolvedProjectId,
        resolvedIsMainRepo,
        resolvedAutoCommit,
        resolvedFolderId,
        resolvedToolType,
        resolvedBaseCommit,
        resolvedBaseBranch,
        resolvedCommitMode,
        resolvedCommitModeSettings
      );
    });
  }

  async createSessionWithProvidedId(
    id: string,
    nameOrOptions: string | {
      name: string;
      worktreePath: string;
      prompt: string;
      worktreeName?: string;
      permissionMode?: 'approve' | 'ignore';
      projectId?: number;
      isMainRepo?: boolean;
      autoCommit?: boolean;
      folderId?: string;
      toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
      baseCommit?: string;
      baseBranch?: string;
      commitMode?: 'structured' | 'checkpoint' | 'disabled';
      commitModeSettings?: string;
    },
    worktreePath?: string,
    prompt?: string,
    worktreeName?: string,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    isMainRepo?: boolean,
    autoCommit?: boolean,
    folderId?: string,
    toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none',
    baseCommit?: string,
    baseBranch?: string,
    commitMode?: 'structured' | 'checkpoint' | 'disabled',
    commitModeSettings?: string
  ): Promise<Session> {
    // Handle both object and positional parameters
    let name: string;
    let resolvedWorktreePath: string;
    let resolvedPrompt: string;
    let resolvedWorktreeName: string;
    let resolvedPermissionMode: 'approve' | 'ignore' | undefined;
    let resolvedProjectId: number | undefined;
    let resolvedIsMainRepo: boolean | undefined;
    let resolvedAutoCommit: boolean | undefined;
    let resolvedFolderId: string | undefined;
    let resolvedToolType: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none' | undefined;
    let resolvedBaseCommit: string | undefined;
    let resolvedBaseBranch: string | undefined;
    let resolvedCommitMode: 'structured' | 'checkpoint' | 'disabled' | undefined;
    let resolvedCommitModeSettings: string | undefined;

    if (typeof nameOrOptions === 'object') {
      // Object parameter style
      name = nameOrOptions.name;
      resolvedWorktreePath = nameOrOptions.worktreePath;
      resolvedPrompt = nameOrOptions.prompt;
      resolvedWorktreeName = nameOrOptions.worktreeName || nameOrOptions.name;
      resolvedPermissionMode = nameOrOptions.permissionMode;
      resolvedProjectId = nameOrOptions.projectId;
      resolvedIsMainRepo = nameOrOptions.isMainRepo;
      resolvedAutoCommit = nameOrOptions.autoCommit;
      resolvedFolderId = nameOrOptions.folderId;
      resolvedToolType = nameOrOptions.toolType;
      resolvedBaseCommit = nameOrOptions.baseCommit;
      resolvedBaseBranch = nameOrOptions.baseBranch;
      resolvedCommitMode = nameOrOptions.commitMode;
      resolvedCommitModeSettings = nameOrOptions.commitModeSettings;
    } else {
      // Positional parameter style
      name = nameOrOptions;
      resolvedWorktreePath = worktreePath!;
      resolvedPrompt = prompt!;
      resolvedWorktreeName = worktreeName!;
      resolvedPermissionMode = permissionMode;
      resolvedProjectId = projectId;
      resolvedIsMainRepo = isMainRepo;
      resolvedAutoCommit = autoCommit;
      resolvedFolderId = folderId;
      resolvedToolType = toolType;
      resolvedBaseCommit = baseCommit;
      resolvedBaseBranch = baseBranch;
      resolvedCommitMode = commitMode;
      resolvedCommitModeSettings = commitModeSettings;
    }

    return await withLock(`session-creation`, async () => {
      return this.createSessionWithId(
        id,
        name,
        resolvedWorktreePath,
        resolvedPrompt,
        resolvedWorktreeName,
        resolvedPermissionMode,
        resolvedProjectId,
        resolvedIsMainRepo,
        resolvedAutoCommit,
        resolvedFolderId,
        resolvedToolType,
        resolvedBaseCommit,
        resolvedBaseBranch,
        resolvedCommitMode,
        resolvedCommitModeSettings
      );
    });
  }

  createSessionWithId(
    id: string,
    name: string,
    worktreePath: string,
    prompt: string,
    worktreeName: string,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    isMainRepo?: boolean,
    autoCommit?: boolean,
    folderId?: string,
    toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none',
    baseCommit?: string,
    baseBranch?: string,
    commitMode?: 'structured' | 'checkpoint' | 'disabled',
    commitModeSettings?: string
  ): Session {
    // Ensure this session ID isn't already being created
    if (this.activeSessions.has(id) || this.db.getSession(id)) {
      throw new Error(`Session with ID ${id} already exists`);
    }
    
    // Add log entry for session creation
    addSessionLog(id, 'info', `Creating session: ${name}`, 'SessionManager');
    
    let targetProject;
    
    if (projectId) {
      targetProject = this.getProjectById(projectId);
      if (!targetProject) {
        throw new Error(`Project with ID ${projectId} not found`);
      }
    } else {
      // Fall back to active project for backward compatibility
      targetProject = this.getActiveProject();
      if (!targetProject) {
        throw new Error('No project specified and no active project selected');
      }
    }

    const sessionData: CreateSessionData = {
      id,
      name,
      initial_prompt: prompt || '', // Use empty string if prompt is undefined/null
      worktree_name: worktreeName,
      worktree_path: worktreePath,
      project_id: targetProject.id,
      folder_id: folderId,
      permission_mode: permissionMode,
      is_main_repo: isMainRepo,
      auto_commit: autoCommit,
      // Model is now managed at panel level
      base_commit: baseCommit,
      base_branch: baseBranch,
      tool_type: toolType,
      commit_mode: commitMode,
      commit_mode_settings: commitModeSettings
    };

    const dbSession = this.db.createSession(sessionData);
    
    const session = this.convertDbSessionToSession(dbSession);
    session.toolType = toolType || session.toolType;
    
    this.activeSessions.set(session.id, session);
    // Don't emit the event here - let the caller decide when to emit it
    // this.emit('session-created', session);

    return session;
  }

  async getOrCreateMainRepoSession(projectId: number): Promise<Session> {
    return await withLock(`main-repo-session-${projectId}`, async () => {
      // First check if a main repo session already exists
      const existingSession = this.db.getMainRepoSession(projectId);
      if (existingSession) {
        const session = this.convertDbSessionToSession(existingSession);
        return session;
      }
      
      // Get the project
      const project = this.getProjectById(projectId);
      if (!project) {
        throw new Error(`Project with ID ${projectId} not found`);
      }
      
      
      // Create a new main repo session
      const sessionId = randomUUID();
      const sessionName = `${project.name} (Main)`;
      const worktreePath = project.path; // Use the project path directly
      const worktreeName = 'main'; // Use 'main' as the worktree name
      const prompt = ''; // Empty prompt - user hasn't sent anything yet
      
      const session = this.createSessionWithId(
        sessionId,
        sessionName,
        worktreePath,
        prompt,
        worktreeName,
        project.default_permission_mode || 'ignore', // Default to 'ignore' if not set
        projectId,
        true, // isMainRepo = true
        true, // autoCommit = true (default for main repo sessions)
        undefined, // folderId
        'claude', // tool_type
        undefined, // baseCommit
        undefined, // baseBranch
        project.commit_mode, // Use project's commit mode
        undefined // commit_mode_settings - let it use project defaults
      );
      
      return session;
    });
  }

  emitSessionCreated(session: Session): void {
    this.emit('session-created', session);
  }

  updateSession(id: string, update: SessionUpdate): void {

    // Add log entry for important status changes
    if (update.status) {
      addSessionLog(id, 'info', `Session status changed to: ${update.status}`, 'SessionManager');
    }
    if (update.statusMessage) {
      addSessionLog(id, 'info', `Status: ${update.statusMessage}`, 'SessionManager');
    }
    if (update.error) {
      addSessionLog(id, 'error', `Session error: ${update.error}`, 'SessionManager');
    }

    const dbUpdate: UpdateSessionData = {};

    if (update.name !== undefined) {
      dbUpdate.name = update.name;
    }

    if (update.status !== undefined) {
      dbUpdate.status = this.mapSessionStatusToDbStatus(update.status);
    }

    if (update.statusMessage !== undefined) {
      dbUpdate.status_message = update.statusMessage;
    }

    if (update.worktreePath !== undefined) {
      dbUpdate.worktree_path = update.worktreePath;
    }

    if (update.worktreeName !== undefined) {
      dbUpdate.worktree_name = update.worktreeName;
    }

    if (update.baseCommit !== undefined) {
      dbUpdate.base_commit = update.baseCommit;
    }

    if (update.baseBranch !== undefined) {
      dbUpdate.base_branch = update.baseBranch;
    }

    if (update.toolType !== undefined) {
      dbUpdate.tool_type = update.toolType;
    }

    if (update.executionMode !== undefined) {
      dbUpdate.execution_mode = update.executionMode;
    }

    if (update.skipContinueNext !== undefined) {
      dbUpdate.skip_continue_next = update.skipContinueNext;
    }

    if (update.archived !== undefined) {
      dbUpdate.archived = update.archived;
    }

    const updatedDbSession = this.db.updateSession(id, dbUpdate);
    if (!updatedDbSession) {
      console.error(`[SessionManager] Session ${id} not found in database`);
      throw new Error(`Session ${id} not found`);
    }

    const session = this.convertDbSessionToSession(updatedDbSession);

    // Don't override the status if convertDbSessionToSession determined it should be completed_unviewed
    // This allows the blue dot indicator to work properly when a session completes
    if (update.status !== undefined && session.status === 'completed_unviewed') {
      delete update.status; // Remove status from update to preserve completed_unviewed
    }

    // Apply any additional updates not stored in DB
    Object.assign(session, update);

    this.activeSessions.set(id, session);
    this.emit('session-updated', session);
  }

  updateSessionStatus(id: string, status: Session['status'], statusMessage?: string): void {
    this.updateSession(id, { status, statusMessage });
  }

  addSessionError(id: string, error: string, details?: string): void {
    const errorData = {
      error: error,
      details: details,
      timestamp: new Date().toISOString()
    };
    
    this.addSessionOutput(id, {
      type: 'error',
      data: JSON.stringify(errorData),
      timestamp: new Date().toISOString()
    } as any);
    
    // Mark the session as having an error
    this.updateSession(id, { status: 'error', error: error });
  }


  addSessionOutput(id: string, output: Omit<SessionOutput, 'sessionId'>): void {
    // Check if this is the first output for this session
    const existingOutputs = this.db.getSessionOutputs(id, 1);
    const isFirstOutput = existingOutputs.length === 0;
    
    // Store in database (stringify JSON objects and error objects)
    const dataToStore = (output.type === 'json' || output.type === 'error') ? JSON.stringify(output.data) : String(output.data);
    this.db.addSessionOutput(id, output.type, dataToStore);
    
    // Emit the output so it shows immediately in the UI
    const outputToEmit: SessionOutput = {
      id: 0, // Temporary ID, will be assigned by database
      session_id: id,
      type: output.type,
      data: output.data,
      timestamp: output.timestamp || new Date().toISOString(),
      panel_id: (output as any).panel_id
    };
    this.emit('session-output', outputToEmit);
    
    // Emit output-available event to notify frontend that new output is available
    // This is used to trigger output panel refresh when new content is added (e.g., after git operations)
    this.emit('session-output-available', { sessionId: id });

    // Try to parse stdout/stderr data as JSON early so we can check for special messages
    let parsedData = output.data;
    let isJson = output.type === 'json';

    if (!isJson && typeof output.data === 'string') {
      try {
        parsedData = JSON.parse(output.data);
        isJson = true;
      } catch {
        // Not JSON, keep as is
      }
    }

    // NOTE: Session ID persistence is handled by AbstractAIPanelManager.confirmAndPersistSessionId()
    // which waits for the first assistant message to confirm CLI success before persisting.
    // This prevents overwriting valid session IDs when a resumed session fails before completion.

    // Check if this is a system result message indicating Claude has completed
    if (output.type === 'json' && isJSONMessage(output.data as unknown as Record<string, unknown>, 'system', 'result')) {
      // Update the completion timestamp for the most recent prompt
      const completionTimestamp = (output.timestamp as any) instanceof Date ? (output.timestamp as Date).toISOString() : output.timestamp;
      this.db.updatePromptMarkerCompletion(id, completionTimestamp);

      // Mark the session as completed (this will trigger the completed_unviewed logic if not viewed)
      const dbSession = this.db.getSession(id);
      if (dbSession && dbSession.status === 'running') {
        this.db.updateSession(id, { status: 'completed' });

        // Re-convert to get the proper status (completed_unviewed if not viewed)
        const updatedDbSession = this.db.getSession(id);
        if (updatedDbSession) {
          const session = this.convertDbSessionToSession(updatedDbSession);
          this.activeSessions.set(id, session);
          this.emit('session-updated', session);
        }
      }
    }
    
    // Check if this is a user message in JSON format to track prompts
    if (output.type === 'json' && (output.data as unknown as GenericMessageData).type === 'user' && (output.data as unknown as GenericMessageData).message?.content) {
      // Extract text content from user messages
      const content = (output.data as unknown as GenericMessageData).message?.content;
      let promptText = '';
      
      if (Array.isArray(content)) {
        // Look for text content in the array
        const textContent = content.find((item: { type: string; text?: string }) => item.type === 'text');
        if (textContent?.text) {
          promptText = textContent.text;
        }
      } else if (typeof content === 'string') {
        promptText = content;
      }
      
      if (promptText) {
        // Get current output count to use as index
        const outputs = this.db.getSessionOutputs(id);
        this.db.addPromptMarker(id, promptText, outputs.length - 1);
        // Also add to conversation messages for continuation support
        this.db.addConversationMessage(id, 'user', promptText);
      }
    }
    
    // Check if this is an assistant message to track for conversation history
    if (output.type === 'json' && (output.data as unknown as GenericMessageData).type === 'assistant' && (output.data as unknown as GenericMessageData).message?.content) {
      // Extract text content from assistant messages
      const content = (output.data as unknown as GenericMessageData).message?.content;
      let assistantText = '';
      
      if (Array.isArray(content)) {
        // Concatenate all text content from the array
        assistantText = content
          .filter((item: { type: string; text?: string }) => item.type === 'text')
          .map((item: { type: string; text?: string }) => item.text || '')
          .join('\n');
      } else if (typeof content === 'string') {
        assistantText = content;
      }
      
      if (assistantText) {
        // Add to conversation messages for continuation support
        this.db.addConversationMessage(id, 'assistant', assistantText);
      }
    }
    
    // Update in-memory session (parsedData and isJson were computed earlier)
    const session = this.activeSessions.get(id);
    if (session) {
      if (isJson) {
        session.jsonMessages.push(parsedData);
      }

      // Push the full output object to maintain consistency with test expectations
      session.output.push({
        sessionId: id,
        type: output.type,
        data: output.data,
        timestamp: output.timestamp || new Date().toISOString(),
      } as any);
      session.lastActivity = new Date();
    }
    
    const fullOutput: SessionOutput = {
      sessionId: id,
      ...output
    };
    
    this.emit('session-output', fullOutput);
  }

  getSessionOutput(id: string, limit?: number): SessionOutput[] {
    return this.getSessionOutputs(id, limit);
  }

  getSessionOutputs(id: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getSessionOutputs(id, limit);
    return dbOutputs.map(dbOutput => ({
      id: dbOutput.id,
      sessionId: dbOutput.session_id,
      panelId: dbOutput.panel_id,
      type: dbOutput.type as 'stdout' | 'stderr' | 'json' | 'error',
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      timestamp: new Date(dbOutput.timestamp)
    }));
  }

  getSessionOutputsForPanel(panelId: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getSessionOutputsForPanel(panelId, limit);
    return dbOutputs.map(dbOutput => ({
      id: dbOutput.id,
      sessionId: dbOutput.session_id,
      panelId: dbOutput.panel_id,
      type: dbOutput.type as 'stdout' | 'stderr' | 'json' | 'error',
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      timestamp: new Date(dbOutput.timestamp)
    }));
  }

  async archiveSession(id: string): Promise<void> {
    const success = this.db.archiveSession(id);
    if (!success) {
      throw new Error(`Session ${id} not found`);
    }

    // Stop any running process for this session
    const session = this.getSession(id);
    if (session?.pid) {
      try {
        // Kill the process group on Unix, individual process on Windows
        if (process.platform === 'win32') {
          process.kill(session.pid);
        } else {
          // On Unix, kill the entire process group
          process.kill(-session.pid, 'SIGTERM');
        }
      } catch (error) {
        // Process might already be terminated, ignore error
      }
    }

    // Stop all AI panel processes (Claude, Codex, etc.) for this session
    try {
      // Get all panels for this session
      const panels: ToolPanel[] = panelManager.getPanelsForSession(id);
      
      // Stop Claude panels
      const claudePanels = panels.filter(p => p.type === 'claude');
      if (claudePanels.length > 0) {
        try {
          const { claudePanelManager } = require('../ipc/claudePanel');
          for (const panel of claudePanels) {
            await claudePanelManager.unregisterPanel(panel.id);
          }
        } catch (error) {
          console.error(`[SessionManager] Failed to stop Claude panels for session ${id}:`, error);
        }
      }
      
      // Stop Codex panels
      const codexPanels = panels.filter(p => p.type === 'codex');
      if (codexPanels.length > 0) {
        try {
          const { codexPanelManager } = require('../ipc/codexPanel');
          for (const panel of codexPanels) {
            await codexPanelManager.unregisterPanel(panel.id);
          }
        } catch (error) {
          console.error(`[SessionManager] Failed to stop Codex panels for session ${id}:`, error);
        }
      }

      // Stop Gemini panels
      const geminiPanels = panels.filter(p => p.type === 'gemini');
      if (geminiPanels.length > 0) {
        try {
          const { geminiPanelManager } = require('../ipc/geminiPanel');
          for (const panel of geminiPanels) {
            await geminiPanelManager.unregisterPanel(panel.id);
          }
        } catch (error) {
          console.error(`[SessionManager] Failed to stop Gemini panels for session ${id}:`, error);
        }
      }
    } catch (error) {
      console.error(`[SessionManager] Error stopping AI panels for session ${id}:`, error);
    }

    // Close terminal session if it exists
    await this.terminalSessionManager.closeTerminalSession(id);
    
    this.activeSessions.delete(id);
    this.terminalPanels.clearSession(id);
    this.emit('session-deleted', { id }); // Keep the same event name for frontend compatibility
  }

  stopSession(id: string): void {
    this.updateSession(id, { status: 'stopped' });
  }

  deleteSessionPermanently(id: string): void {
    try {
      this.db.deleteSessionPermanently(id);
    } catch (error) {
      console.error('[SessionManager] Failed to delete session from database:', error);
      throw error;
    }

    this.activeSessions.delete(id);
    this.terminalPanels.clearSession(id);
    this.emit('session-deleted', { id });
  }

  setSessionPid(id: string, pid: number): void {
    this.db.updateSession(id, { pid });
    const session = this.activeSessions.get(id);
    if (session) {
      session.pid = pid;
    }
  }

  setSessionExitCode(id: string, exitCode: number): void {
    this.db.updateSession(id, { exit_code: exitCode });
  }

  addConversationMessage(id: string, messageType: 'user' | 'assistant', content: string): void {
    this.db.addConversationMessage(id, messageType, content);
  }

  getConversationMessages(id: string): ConversationMessage[] {
    return this.db.getConversationMessages(id);
  }

  // Panel-based methods for Claude panels (use panel_id instead of session_id)
  addPanelOutput(panelId: string, output: Omit<SessionOutput, 'sessionId'>): void {
    const panel = this.db.getPanel(panelId);

    if (this.hasAutoContextCapture(panelId)) {
      const bufferedOutput: SessionOutput = {
        sessionId: panel?.sessionId || '',
        panelId,
        type: output.type,
        data: output.data,
        timestamp: output.timestamp instanceof Date ? output.timestamp : new Date(output.timestamp)
      };
      this.collectAutoContextOutput(panelId, bufferedOutput);
      return;
    }

    // Check for JSON message type and store appropriately
    const existingOutputs = this.db.getPanelOutputs(panelId, 1);
    const isContinuing = existingOutputs.length > 0 && 
                        existingOutputs[existingOutputs.length - 1]?.type === 'json';
    
    const dataToStore = (output.type === 'json' || output.type === 'error') 
      ? JSON.stringify(output.data) 
      : output.data as string;
    
    this.db.addPanelOutput(panelId, output.type, dataToStore);

    // NOTE: Session ID persistence is handled by AbstractAIPanelManager.confirmAndPersistSessionId()
    // which waits for the first assistant message to confirm CLI success before persisting.

    // Check if this is a system result message indicating panel execution has completed
    if (output.type === 'json' && isJSONMessage(output.data as unknown as Record<string, unknown>, 'system', 'result')) {
      // Update the completion timestamp for the most recent prompt marker for this panel
      const completionTimestamp = output.timestamp instanceof Date ? output.timestamp.toISOString() : output.timestamp;
      this.db.updatePanelPromptMarkerCompletion(panelId, completionTimestamp);
    }

    // Handle assistant conversation message extraction for Claude panels (same logic as sessions)
    if (output.type === 'json' && (output.data as unknown as GenericMessageData).type === 'assistant' && (output.data as unknown as GenericMessageData).message?.content) {
      // Extract text content from assistant messages
      const content = (output.data as unknown as GenericMessageData).message?.content;
      let assistantText = '';

      if (Array.isArray(content)) {
        // Concatenate all text content from the array
        assistantText = content
          .filter((item: { type: string; text?: string }) => item.type === 'text')
          .map((item: { type: string; text?: string }) => item.text || '')
          .join('\n');
      } else if (typeof content === 'string') {
        assistantText = content;
      }

      if (assistantText) {
        // Add to panel conversation messages for continuation support
        // Use the sessionManager method instead of db method directly to ensure event emission
        this.addPanelConversationMessage(panelId, 'assistant', assistantText);
      }
    }
    
    // Handle Codex session completion message to stop prompt timing
    if (output.type === 'json' && (output.data as unknown as GenericMessageData).type === 'session' && (output.data as unknown as GenericMessageData).data?.status === 'completed') {
      // Add a completion message to trigger panel-response-added event which stops the timer
      const completionMessage = String((output.data as unknown as GenericMessageData).data?.message || 'Session completed');
      this.addPanelConversationMessage(panelId, 'assistant', completionMessage);
    }
    
    // Handle Codex agent messages (similar to Claude's assistant messages)
    if (output.type === 'json' && ((output.data as unknown as GenericMessageData).type === 'agent_message' || (output.data as unknown as GenericMessageData).type === 'agent_message_delta')) {
      const agentText = String((output.data as unknown as GenericMessageData).message || (output.data as unknown as GenericMessageData).delta || '');
      if (agentText && (output.data as unknown as GenericMessageData).type === 'agent_message') {
        // Only add complete messages, not deltas
        this.addPanelConversationMessage(panelId, 'assistant', agentText);
      }
    }
    
    // Handle user conversation message extraction for Claude panels (same logic as sessions)
    // NOTE: User messages are recorded at the moment the user submits input (IPC handlers),
    // so we intentionally avoid extracting and duplicating them from JSON output here.

    // NOTE: Session ID persistence is handled by AbstractAIPanelManager.confirmAndPersistSessionId()
    // which waits for the first assistant message to confirm CLI success before persisting.
    // This prevents overwriting valid session IDs when a resumed session fails before completion.
  }

  getPanelOutputs(panelId: string, limit?: number): SessionOutput[] {
    const dbOutputs = this.db.getPanelOutputs(panelId, limit);
    return dbOutputs.map(dbOutput => ({
      sessionId: dbOutput.session_id || '', // For compatibility, though panels use panel_id
      type: dbOutput.type as 'stdout' | 'stderr' | 'json' | 'error',
      data: (dbOutput.type === 'json' || dbOutput.type === 'error') ? JSON.parse(dbOutput.data) : dbOutput.data,
      // SQLite timestamps are in UTC but stored without timezone indicator
      // Append 'Z' to ensure proper UTC parsing as per project documentation
      timestamp: dbOutput.timestamp.includes('T') || dbOutput.timestamp.includes('Z')
        ? new Date(dbOutput.timestamp)  // Already ISO format
        : new Date(dbOutput.timestamp + 'Z')  // SQLite format, append Z for UTC
    }));
  }

  addPanelConversationMessage(
    panelId: string,
    messageType: 'user' | 'assistant',
    content: string,
    options?: { recordTimeline?: boolean }
  ): void {
    this.db.addPanelConversationMessage(panelId, messageType, content);

    try {
      const panel = this.db.getPanel(panelId);
      console.log('[SessionManager] addPanelConversationMessage:', { panelId, messageType, hasPanel: !!panel, sessionId: panel?.sessionId });
      if (panel?.sessionId) {
        const recordTimeline = options?.recordTimeline !== false;
        if (recordTimeline) {
          this.addTimelineEvent({
            session_id: panel.sessionId,
            panel_id: panelId,
            kind: messageType === 'user' ? 'chat.user' : 'chat.assistant',
            command: content,
            tool: panel.type
          });
          console.log('[SessionManager] Timeline event added for', messageType);
        }
      } else {
        console.warn('[SessionManager] No sessionId for panel, timeline event not added');
      }
    } catch (e) {
      console.warn('[SessionManager] Failed to record timeline chat event:', e);
    }

    // Emit event when a user message is added (new prompt)
    if (messageType === 'user') {
      // Also add to prompt markers so the commit manager can track the latest prompt
      const outputs = this.db.getPanelOutputs(panelId);
      this.db.addPanelPromptMarker(panelId, content, outputs.length);

      this.emit('panel-prompt-added', { panelId, content });
    }

    // Emit event when an assistant message is added (response received)
    if (messageType === 'assistant') {
      this.emit('panel-response-added', { panelId, content });
    }
  }

  getPanelConversationMessages(panelId: string): ConversationMessage[] {
    return this.db.getPanelConversationMessages(panelId);
  }

  // Panel-based prompt marker methods
  getPanelPromptMarkers(panelId: string): PromptMarker[] {
    return this.db.getPanelPromptMarkers(panelId);
  }

  addPanelInitialPromptMarker(panelId: string, prompt: string): void {
    // Prompt markers are no longer needed for panels - using conversation_messages instead
    // The prompt is already being added to conversation_messages in addPanelConversationMessage
  }

  async continueConversation(id: string, userMessage: string): Promise<void> {
    return await withLock(`session-input-${id}`, async () => {
      // Store the user's message
      this.addConversationMessage(id, 'user', userMessage);
      
      // Add the continuation prompt to output so it's visible
      const timestamp = formatForDisplay(new Date());
      const userPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                               `\x1b[1m\x1b[92m${userMessage}\x1b[0m\r\n\r\n`;
      this.addSessionOutput(id, {
        type: 'stdout',
        data: userPromptDisplay,
        timestamp: new Date().toISOString()
      } as any);
      
      // Add a prompt marker for this continued conversation
      // Get current output count to use as index
      const outputs = this.db.getSessionOutputs(id);
      this.db.addPromptMarker(id, userMessage, outputs.length);
      
      // Emit event for the Claude Code manager to handle
      this.emit('conversation-continue', { sessionId: id, message: userMessage });
    });
  }

  clearConversation(id: string): void {
    this.db.clearConversationMessages(id);
    this.db.clearSessionOutputs(id);
  }

  markSessionAsViewed(id: string): void {
    const updatedDbSession = this.db.markSessionAsViewed(id);
    if (updatedDbSession) {
      const session = this.convertDbSessionToSession(updatedDbSession);
      this.activeSessions.set(id, session);
      this.emit('session-updated', session);
    }
  }

  getPromptHistory(): Array<{
    id: string;
    prompt: string;
    sessionName: string;
    sessionId: string;
    createdAt: string;
    status: string;
  }> {
    const sessions = this.db.getAllSessionsIncludingArchived();
    
    return sessions.map(session => ({
      id: session.id,
      prompt: session.initial_prompt,
      sessionName: session.name,
      sessionId: session.id,
      createdAt: session.created_at,
      status: session.status
    })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getPromptById(promptId: string): PromptMarker | null {
    // For prompt history, the promptId is the sessionId
    // We need to get the initial prompt marker for that session
    const markers = this.db.getPromptMarkers(promptId);
    
    // The initial prompt is always the first marker (output_index 0)
    const initialMarker = markers.find(m => m.output_index === 0);
    
    return initialMarker || null;
  }

  getPromptMarkers(sessionId: string): PromptMarker[] {
    return this.db.getPromptMarkers(sessionId);
  }

  getSessionPrompts(sessionId: string): PromptMarker[] {
    return this.getPromptMarkers(sessionId);
  }

  addInitialPromptMarker(sessionId: string, prompt: string): void {
    try {
      // Add the initial prompt as the first prompt marker (index 0)
      this.db.addPromptMarker(sessionId, prompt, 0, 0);
    } catch (error) {
      console.error('[SessionManager] Failed to add initial prompt marker:', error);
      throw error;
    }
  }

  // Execution diff operations
  createExecutionDiff(data: CreateExecutionDiffData): ExecutionDiff {
    return this.db.createExecutionDiff(data);
  }

  getExecutionDiffs(sessionId: string): ExecutionDiff[] {
    return this.db.getExecutionDiffs(sessionId);
  }

  getExecutionDiff(id: number): ExecutionDiff | undefined {
    return this.db.getExecutionDiff(id);
  }

  getNextExecutionSequence(sessionId: string): number {
    return this.db.getNextExecutionSequence(sessionId);
  }

  getProjectRunScript(sessionId: string): string[] | null {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      const project = this.getProjectById(dbSession.project_id);
      if (project?.run_script) {
        // Split by newlines to get array of commands
        return project.run_script.split('\n').filter(cmd => cmd.trim());
      }
    }
    return null;
  }

  getProjectBuildScript(sessionId: string): string[] | null {
    const dbSession = this.getDbSession(sessionId);
    if (dbSession?.project_id) {
      const project = this.getProjectById(dbSession.project_id);
      if (project?.build_script) {
        // Split by newlines to get array of commands
        return project.build_script.split('\n').filter(cmd => cmd.trim());
      }
    }
    return null;
  }

  async runScript(sessionId: string, commands: string[], workingDirectory: string): Promise<void> {
    // Stop any currently running script and wait for it to fully terminate
    await this.stopRunningScript();

    // Clear previous logs when starting a new run
    cleanupSessionLogs(sessionId);

    // Mark session as running
    this.setSessionRunning(sessionId, true);
    this.currentRunningSessionId = sessionId;

    // Track in shared script execution tracker
    scriptExecutionTracker.start('session', sessionId);
    
    // Join commands with && to run them sequentially
    const command = commands.join(' && ');
    
    // Get enhanced shell PATH
    const shellPath = getShellPath();
    
    // Get the user's default shell and command arguments
    const { shell, args } = ShellDetector.getShellCommandArgs(command);
    
    // Spawn the process with its own process group for easier termination
    this.runningScriptProcess = spawn(shell, args, {
      cwd: workingDirectory,
      stdio: 'pipe',
      detached: true, // Create a new process group
      env: {
        ...process.env,
        PATH: shellPath
      }
    });

    // Handle output - send to logs instead of terminal
    this.runningScriptProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      // Split by lines and add each as a log entry
      const lines = output.split('\n').filter(line => line.trim());
      lines.forEach(line => {
        addSessionLog(sessionId, 'info', line, 'Application');
      });
      // Log output is now handled via addSessionLog above
    });

    this.runningScriptProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      // Split by lines and add each as a log entry
      const lines = output.split('\n').filter(line => line.trim());
      lines.forEach(line => {
        addSessionLog(sessionId, 'error', line, 'Application');
      });
      // Log output is now handled via addSessionLog above
    });

    // Handle process exit
    this.runningScriptProcess.on('exit', (code) => {
      addSessionLog(sessionId, 'info', `Process exited with code: ${code}`, 'Application');

      this.setSessionRunning(sessionId, false);
      this.currentRunningSessionId = null;
      this.runningScriptProcess = null;

      // Update shared tracker
      scriptExecutionTracker.stop('session', sessionId);
    });

    this.runningScriptProcess.on('error', (error) => {
      addSessionLog(sessionId, 'error', `Error: ${error.message}`, 'Application');

      this.setSessionRunning(sessionId, false);
      this.currentRunningSessionId = null;
      this.runningScriptProcess = null;

      // Update shared tracker
      scriptExecutionTracker.stop('session', sessionId);
    });
  }

  async runBuildScript(sessionId: string, commands: string[], workingDirectory: string): Promise<{ success: boolean; output: string }> {
    // Get enhanced shell PATH
    const shellPath = getShellPath();
    
    // Add build start message to logs
    const timestamp = new Date().toLocaleTimeString();
    addSessionLog(sessionId, 'info', `🔨 BUILD SCRIPT RUNNING at ${timestamp}`, 'Build');
    
    // Show PATH information for debugging in logs
    addSessionLog(sessionId, 'debug', `Using PATH: ${shellPath.split(':').slice(0, 5).join(':')}...`, 'Build');
    
    // Check if yarn is available
    try {
      const { stdout: yarnPath } = await this.execWithShellPath('which yarn', { cwd: workingDirectory });
      if (yarnPath.trim()) {
        addSessionLog(sessionId, 'debug', `yarn found at: ${yarnPath.trim()}`, 'Build');
      }
    } catch {
      addSessionLog(sessionId, 'warn', `yarn not found in PATH`, 'Build');
    }
    
    let allOutput = '';
    let overallSuccess = true;
    
    // Run commands sequentially
    for (const command of commands) {
      if (command.trim()) {
        console.log(`[SessionManager] Executing build command: ${command}`);
        
        // Add command to logs
        addSessionLog(sessionId, 'info', `$ ${command}`, 'Build');
        
        try {
          const { stdout, stderr } = await this.execWithShellPath(command, { cwd: workingDirectory });
          
          if (stdout) {
            allOutput += stdout;
            // Split stdout by lines and add to logs
            const lines = stdout.split('\n').filter(line => line.trim());
            lines.forEach(line => {
              addSessionLog(sessionId, 'info', line, 'Build');
            });
          }
          if (stderr) {
            allOutput += stderr;
            // Split stderr by lines and add to logs
            const lines = stderr.split('\n').filter(line => line.trim());
            lines.forEach(line => {
              addSessionLog(sessionId, 'warn', line, 'Build');
            });
          }
        } catch (cmdError: unknown) {
          console.error(`[SessionManager] Build command failed: ${command}`, cmdError);
          const error = cmdError as { stderr?: string; stdout?: string; message?: string };
          const errorMessage = error.stderr || error.stdout || error.message || String(cmdError);
          allOutput += errorMessage;
          
          addSessionLog(sessionId, 'error', `Command failed: ${command}`, 'Build');
          addSessionLog(sessionId, 'error', errorMessage, 'Build');
          
          overallSuccess = false;
          // Continue with next command instead of stopping entirely
        }
      }
    }
    
    // Add completion message to logs
    const buildEndTimestamp = new Date().toLocaleTimeString();
    if (overallSuccess) {
      addSessionLog(sessionId, 'info', `✅ BUILD COMPLETED at ${buildEndTimestamp}`, 'Build');
    } else {
      addSessionLog(sessionId, 'error', `❌ BUILD FAILED at ${buildEndTimestamp}`, 'Build');
    }
    
    return { success: overallSuccess, output: allOutput };
  }
  
  private async execWithShellPath(command: string, options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const shellPath = getShellPath();
    return execAsync(command, {
      ...options,
      env: {
        ...process.env,
        PATH: shellPath
      }
    });
  }

  addScriptOutput(sessionId: string, data: string, type: 'stdout' | 'stderr' = 'stdout'): void {
    // Send output to logs instead of terminal
    const lines = data.split('\n').filter(line => line.trim());
    lines.forEach(line => {
      const level = type === 'stderr' ? 'error' : 'info';
      addSessionLog(sessionId, level, line, 'Terminal');
    });
  }

  /**
   * Recursively gets all descendant PIDs of a parent process.
   * This handles deeply nested process trees where processes spawn children
   * that spawn their own children, etc.
   * 
   * @param parentPid The parent process ID
   * @returns Array of all descendant PIDs
   */
  private getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];
    const platform = os.platform();
    
    try {
      if (platform === 'win32') {
        // On Windows, use wmic to get process tree
        const output = execSync(`wmic process where (ParentProcessId=${parentPid}) get ProcessId`, { encoding: 'utf8' });
        const lines = output.split('\n').filter(line => line.trim());
        for (let i = 1; i < lines.length; i++) { // Skip header
          const pid = parseInt(lines[i].trim());
          if (!isNaN(pid)) {
            descendants.push(pid);
            // Recursively get children of this process
            descendants.push(...this.getAllDescendantPids(pid));
          }
        }
      } else {
        // On Unix-like systems, use ps to get children
        const output = execSync(`ps -o pid= --ppid ${parentPid}`, { encoding: 'utf8' });
        const pids = output.split('\n')
          .map(line => parseInt(line.trim()))
          .filter(pid => !isNaN(pid));
        
        for (const pid of pids) {
          descendants.push(pid);
          // Recursively get children of this process
          descendants.push(...this.getAllDescendantPids(pid));
        }
      }
    } catch (error) {
      // Command might fail if no children exist, which is fine
    }
    
    return descendants;
  }

  /**
   * Stops the currently running script and ensures all child processes are terminated.
   * This method uses multiple approaches to ensure complete cleanup:
   * 1. Gets all descendant PIDs recursively before killing
   * 2. Uses platform-specific commands (taskkill on Windows, kill on Unix)
   * 3. Kills the process group (Unix) or process tree (Windows)
   * 4. Kills individual descendant processes as a fallback
   * 5. Uses graceful SIGTERM first, then forceful SIGKILL
   * @returns Promise that resolves when the script has been stopped
   */
  stopRunningScript(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.runningScriptProcess || !this.currentRunningSessionId) {
        resolve();
        return;
      }

      const sessionId = this.currentRunningSessionId;
      const process = this.runningScriptProcess;

      // Mark as closing in shared tracker
      scriptExecutionTracker.markClosing('session', sessionId);

      // Immediately clear references to prevent new output
      this.currentRunningSessionId = null;
      this.runningScriptProcess = null;
      
      // Kill the entire process group to ensure all child processes are terminated
      try {
        if (process.pid) {
          // First, get all descendant PIDs before we start killing
          const descendantPids = this.getAllDescendantPids(process.pid);
          
          // Add a simple log entry for stopping the script
          addSessionLog(sessionId, 'info', `Stopping application process...`, 'Application');
          
          const platform = os.platform();
          
          if (platform === 'win32') {
            // On Windows, use taskkill to terminate the process tree
            addSessionLog(sessionId, 'info', `[Using taskkill to terminate process tree ${process.pid}]`, 'System');
            
            exec(`taskkill /F /T /PID ${process.pid}`, (error) => {
              if (error) {
                console.warn(`Error killing Windows process tree: ${error.message}`);
                addSessionLog(sessionId, 'error', `[Error terminating process tree: ${error.message}]`, 'System');
                
                // Fallback: kill individual processes
                try {
                  process.kill('SIGKILL');
                } catch (killError) {
                  console.warn('Fallback kill failed:', killError);
                }
                
                // Kill descendants individually
                let killedCount = 0;
                let processedCount = 0;
                
                if (descendantPids.length === 0) {
                  // No descendants, we're done
                  this.finishStopScript(sessionId);
                  resolve();
                  return;
                }
                
                descendantPids.forEach(pid => {
                  exec(`taskkill /F /PID ${pid}`, (err) => {
                    if (!err) killedCount++;
                    processedCount++;
                    
                    // Report after all attempts
                    if (processedCount === descendantPids.length) {
                      addSessionLog(sessionId, 'info', `[Terminated ${killedCount} processes using fallback method]`, 'System');
                      this.finishStopScript(sessionId);
                      resolve();
                    }
                  });
                });
              } else {
                addSessionLog(sessionId, 'info', '[Successfully terminated process tree]', 'System');
                this.finishStopScript(sessionId);
                resolve();
              }
            });
          } else {
            // On Unix-like systems (macOS, Linux)
            // First, try SIGTERM for graceful shutdown
            addSessionLog(sessionId, 'info', `[Sending SIGTERM to process ${process.pid} and its group]`, 'System');
            
            try {
              process.kill('SIGTERM');
            } catch (error) {
              console.warn('SIGTERM failed:', error);
            }
            
            // Kill the entire process group using negative PID
            exec(`kill -TERM -${process.pid}`, (error) => {
              if (error) {
                console.warn(`Error sending SIGTERM to process group: ${error.message}`);
              }
            });
            
            // Give processes a chance to clean up gracefully
            addSessionLog(sessionId, 'info', '[Waiting 10 seconds for graceful shutdown...]', 'System');
            
            // Use a shorter timeout for faster cleanup
            setTimeout(() => {
              addSessionLog(sessionId, 'info', '\n[Grace period expired, using forceful termination]', 'System');
              
              // Now forcefully kill the main process
              try {
                process.kill('SIGKILL');
                addSessionLog(sessionId, 'info', `[Sent SIGKILL to process ${process.pid}]`, 'System');
              } catch (error) {
                // Process might already be dead
                addSessionLog(sessionId, 'info', `[Process ${process.pid} already terminated]`, 'System');
              }
              
              // Kill the process group with SIGKILL
              exec(`kill -9 -${process.pid}`, (error) => {
                if (error) {
                  console.warn(`Error sending SIGKILL to process group: ${error.message}`);
                  addSessionLog(sessionId, 'warn', `[Warning: Could not kill process group: ${error.message}]`, 'System');
                } else {
                  addSessionLog(sessionId, 'info', `[Sent SIGKILL to process group ${process.pid}]`, 'System');
                }
              });
              
              // Kill all known descendants individually to be sure
              let killedCount = 0;
              let alreadyDeadCount = 0;
              
              descendantPids.forEach(pid => {
                exec(`kill -9 ${pid}`, (error) => {
                  if (error) {
                    alreadyDeadCount++;
                  } else {
                    killedCount++;
                  }
                  
                  // Report results after processing all descendants
                  if (killedCount + alreadyDeadCount === descendantPids.length) {
                    if (killedCount > 0) {
                      addSessionLog(sessionId, 'info', `[Forcefully terminated ${killedCount} child process${killedCount > 1 ? 'es' : ''}]`, 'System');
                    }
                    if (alreadyDeadCount > 0) {
                      addSessionLog(sessionId, 'info', `[${alreadyDeadCount} process${alreadyDeadCount > 1 ? 'es' : ''} had already terminated gracefully]`, 'System');
                    }
                  }
                });
              });
              
              // Final cleanup attempt using pkill
              exec(`pkill -9 -P ${process.pid}`, () => {
                // Ignore errors - processes might already be dead
              });
              
              // Check for zombie processes after a short delay
              setTimeout(() => {
                if (process.pid) {
                  const remainingPids = this.getAllDescendantPids(process.pid);
                  if (remainingPids.length > 0) {
                    addSessionLog(sessionId, 'warn', `[WARNING: ${remainingPids.length} zombie process${remainingPids.length > 1 ? 'es' : ''} could not be terminated: ${remainingPids.join(', ')}]`, 'System');
                    addSessionLog(sessionId, 'error', `[Please manually kill these processes using: kill -9 ${remainingPids.join(' ')}]`, 'System');
                  } else {
                    addSessionLog(sessionId, 'info', '\n[All processes terminated successfully]', 'System');
                  }
                }
                this.finishStopScript(sessionId);
                resolve();
              }, 500);
            }, 2000); // Reduced from 10 seconds to 2 seconds for faster cleanup
          }
        } else {
          // No process PID
          this.finishStopScript(sessionId);
          resolve();
        }
      } catch (error) {
        console.warn('Error killing script process:', error);
        this.finishStopScript(sessionId);
        resolve();
      }
    });
  }

  private finishStopScript(sessionId: string): void {
    // Update session state
    this.setSessionRunning(sessionId, false);

    // Update shared tracker
    scriptExecutionTracker.stop('session', sessionId);

    // Emit a final message to indicate the script was stopped
    addSessionLog(sessionId, 'info', '\n[Script stopped by user]', 'System');
  }

  private setSessionRunning(sessionId: string, isRunning: boolean): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.isRunning = isRunning;
      this.emit('session-updated', session);
    }
  }

  getCurrentRunningSessionId(): string | null {
    // Use shared tracker for consistency
    return scriptExecutionTracker.getRunningScriptId('session') as string | null;
  }

  async cleanup(options?: { fast?: boolean }): Promise<void> {
    this.stopRunningScript();
    await this.terminalSessionManager.cleanup(options);
  }

  async runTerminalCommand(sessionId: string, command: string): Promise<void> {
    // Add log entry for terminal command
    addSessionLog(sessionId, 'info', `Running terminal command: ${command}`, 'Terminal');
    
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      // Check if session exists in database and is archived
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession) {
        throw new Error('Session not found');
      }
      if (dbSession.archived) {
        throw new Error('Cannot access terminal for archived session');
      }
      throw new Error('Session not found');
    }

    // Don't allow running commands while a script is active
    if (this.currentRunningSessionId === sessionId && this.runningScriptProcess) {
      throw new Error('Cannot run terminal commands while a script is running');
    }

    const worktreePath = session.worktreePath;

    try {
      await this.ensureTerminalPanel(sessionId);
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
        // Give the terminal a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Send the command to the persistent terminal session
      this.terminalSessionManager.sendCommand(sessionId, command);
    } catch (error) {
      // Don't write error to terminal for archived sessions
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('archived session')) {
        this.addScriptOutput(sessionId, `\nError: ${error}\n`, 'stderr');
      }
      throw error;
    }
  }

  async sendTerminalInput(sessionId: string, data: string): Promise<void> {
    let session = this.activeSessions.get(sessionId);
    let worktreePath: string;
    
    if (!session) {
      // Try to get session from database for terminal-only sessions
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || !dbSession.worktree_path) {
        throw new Error('Session not found');
      }
      
      // Check if session is archived
      if (dbSession.archived) {
        throw new Error('Cannot access terminal for archived session');
      }
      
      worktreePath = dbSession.worktree_path;
    } else {
      worktreePath = session.worktreePath;
    }

    try {
      await this.ensureTerminalPanel(sessionId);
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
        // Give the terminal a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Send the raw input to the persistent terminal session
      this.terminalSessionManager.sendInput(sessionId, data);
    } catch (error) {
      // Don't write error to terminal for archived sessions
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('archived session')) {
        this.addScriptOutput(sessionId, `\nError: ${error}\n`, 'stderr');
      }
      throw error;
    }
  }

  async closeTerminalSession(sessionId: string): Promise<void> {
    await this.terminalSessionManager.closeTerminalSession(sessionId);
  }

  hasTerminalSession(sessionId: string): boolean {
    return this.terminalSessionManager.hasSession(sessionId);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    this.terminalSessionManager.resizeTerminal(sessionId, cols, rows);
  }

  async preCreateTerminalSession(sessionId: string): Promise<void> {
    let session = this.activeSessions.get(sessionId);
    let worktreePath: string;
    
    if (!session) {
      // Try to get session from database for terminal-only sessions
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || !dbSession.worktree_path) {
        throw new Error('Session not found');
      }
      
      // Check if session is archived
      if (dbSession.archived) {
        throw new Error('Cannot create terminal for archived session');
      }
      
      worktreePath = dbSession.worktree_path;
    } else {
      worktreePath = session.worktreePath;
    }

    try {
      const panel = await this.ensureTerminalPanel(sessionId);
      // Create terminal session if it doesn't exist
      if (!this.terminalSessionManager.hasSession(sessionId)) {
        await this.terminalSessionManager.createTerminalSession(sessionId, worktreePath);
      }
      if (panel) {
        const customState = (panel.state?.customState || {}) as Record<string, unknown>;
        await panelManager.updatePanel(panel.id, {
          state: {
            ...panel.state,
            customState: {
              ...customState,
              isInitialized: true,
              cwd: worktreePath
            }
          }
        });
      }
    } catch (error) {
      console.error(`[SessionManager] Failed to pre-create terminal session: ${error}`);
      // Don't throw - this is a best-effort optimization
    }
  }
}
