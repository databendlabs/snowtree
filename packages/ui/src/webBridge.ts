import type {
  ElectronAPI,
  ElectronBridge,
  IPCResponse,
  ProjectDTO,
  ExecutionDTO,
  GitDiffResultDTO,
  RemotePullRequestDTO
} from './types/electron';
import type { Session } from './types/session';
import type { DiffTarget } from './types/diff';
import type { TimelineEvent } from './types/timeline';
import type { ToolPanel } from '@snowtree/core/types/panels';
import type { TerminalSummary } from './types/terminal';

type WorktreeInfo = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
  hasChanges: boolean;
  createdAt: string | null;
  lastCommitAt: string | null;
  additions: number;
  deletions: number;
  filesChanged: number;
};

type StageResult = { success: boolean; error?: string };
type GitCommandInfo = { currentBranch: string; remoteName: string | null };
type FileContentResult = { content: string };
type CommitGithubUrl = { url: string };
type SyncContext = {
  status: string;
  branch: string;
  log: string;
  diffStat: string;
  prInfo: { number: number; url: string; state: string; title: string; body: string } | null;
  baseBranch: string;
  ownerRepo: string | null;
};
type CommitsBehind = { behind: number; baseBranch: string };
type RemoteCommits = { ahead: number; behind: number; branch: string | null };
type CIStatus =
  | {
      rollupState: 'pending' | 'in_progress' | 'success' | 'failure' | 'neutral';
      checks: Array<{
        id: number;
        name: string;
        status: 'queued' | 'in_progress' | 'completed';
        conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
        startedAt: string | null;
        completedAt: string | null;
        detailsUrl: string | null;
      }>;
      totalCount: number;
      successCount: number;
      failureCount: number;
      pendingCount: number;
    }
  | null;

type RepositoryEntry = { name: string; path: string };

const shouldInstallBridge =
  typeof window !== 'undefined' &&
  typeof window.electronAPI === 'undefined';

if (shouldInstallBridge) {
  const remoteEnvUrl = (import.meta.env?.VITE_REMOTE_API_URL || '').trim();
  const baseUrl = (remoteEnvUrl || window.location.origin || '').replace(/\/$/, '');
  const apiBase = `${baseUrl}/api`;
  const ipcBase = `${apiBase}/ipc`;
  const eventsUrl = `${apiBase}/events`;

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await fetch(`${ipcBase}/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `IPC request failed for ${channel}`);
    }

    return response.json() as Promise<T>;
  };

  const listeners = new Map<string, Set<(payload: any) => void>>();

  const subscribe = (channel: string, callback: (payload: any) => void) => {
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(callback);
    listeners.set(channel, channelListeners);
    return () => {
      const set = listeners.get(channel);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) listeners.delete(channel);
    };
  };

  if (typeof EventSource !== 'undefined') {
    const eventSource = new EventSource(eventsUrl);
    eventSource.onmessage = (event) => {
      if (!event.data) return;
      try {
        const parsed = JSON.parse(event.data) as { channel?: string; payload?: unknown };
        if (!parsed.channel) return;
        const channelListeners = listeners.get(parsed.channel);
        if (!channelListeners) return;
        for (const cb of channelListeners) {
          cb(parsed.payload);
        }
      } catch (error) {
        console.error('[webBridge] Failed to parse SSE payload', error);
      }
    };
    eventSource.onerror = (error) => {
      console.warn('[webBridge] SSE connection error', error);
    };
  }

  const electronAPI: ElectronAPI = {
    invoke: (channel, ...args) => invoke(channel, ...args),
    aiTools: {
      getStatus: (options?: { force?: boolean }) => invoke<IPCResponse<unknown>>('ai-tools:get-status', options),
      getSettings: () => invoke<IPCResponse<unknown>>('ai-tools:get-settings')
    },
    dialog: {
      openDirectory: async () => {
        const value = window.prompt('Enter the repository path on the server');
        if (!value) {
          return { success: true, data: null } satisfies IPCResponse<string | null>;
        }
        return { success: true, data: value } satisfies IPCResponse<string | null>;
      },
      listRepositories: () => invoke<IPCResponse<RepositoryEntry[]>>('dialog:list-repositories')
    },
    projects: {
      getAll: () => invoke<IPCResponse<ProjectDTO[]>>('projects:get-all'),
      create: (request) => invoke<IPCResponse<unknown>>('projects:create', request),
      delete: (projectId) => invoke<IPCResponse<unknown>>('projects:delete', projectId),
      getWorktrees: (projectId, sessionId) =>
        invoke<IPCResponse<WorktreeInfo[]>>('projects:get-worktrees', projectId, sessionId),
      removeWorktree: (projectId, worktreePath, sessionId) =>
        invoke<IPCResponse<unknown>>('projects:remove-worktree', projectId, worktreePath, sessionId),
      renameWorktree: (projectId, worktreePath, nextName, sessionId) =>
        invoke<IPCResponse<{ path: string } | unknown>>('projects:rename-worktree', projectId, worktreePath, nextName, sessionId)
    },
    sessions: {
      getAll: () => invoke<IPCResponse<Session[]>>('sessions:get-all'),
      get: (sessionId) => invoke<IPCResponse<Session>>('sessions:get', sessionId),
      create: (request) => invoke<IPCResponse<{ id: string }>>('sessions:create', request),
      update: (sessionId, updates) => invoke<IPCResponse<unknown>>('sessions:update', sessionId, updates),
      stop: (sessionId) => invoke<IPCResponse<unknown>>('sessions:stop', sessionId),
      delete: (sessionId) => invoke<IPCResponse<unknown>>('sessions:delete', sessionId),
      openWorktree: (request) => invoke<IPCResponse<{ id: string }>>('sessions:open-worktree', request),
      getTimeline: (sessionId) => invoke<IPCResponse<TimelineEvent[]>>('sessions:get-timeline', sessionId),
      getExecutions: (sessionId) => invoke<IPCResponse<ExecutionDTO[]>>('sessions:get-executions', sessionId),
      getDiff: (sessionId, target: DiffTarget) => invoke<IPCResponse<GitDiffResultDTO>>('sessions:get-diff', sessionId, target),
      getGitCommands: (sessionId) => invoke<IPCResponse<GitCommandInfo>>('sessions:get-git-commands', sessionId),
      getRemotePullRequest: (sessionId) =>
        invoke<IPCResponse<RemotePullRequestDTO | null>>('sessions:get-remote-pull-request', sessionId),
      getFileContent: (sessionId, options) => invoke<IPCResponse<FileContentResult>>('sessions:get-file-content', sessionId, options),
      stageHunk: (sessionId, options) => invoke<IPCResponse<StageResult>>('sessions:stage-hunk', sessionId, options),
      restoreHunk: (sessionId, options) => invoke<IPCResponse<StageResult>>('sessions:restore-hunk', sessionId, options),
      changeAllStage: (sessionId, options) => invoke<IPCResponse<StageResult>>('sessions:change-all-stage', sessionId, options),
      changeFileStage: (sessionId, options) => invoke<IPCResponse<StageResult>>('sessions:change-file-stage', sessionId, options),
      restoreFile: (sessionId, options) => invoke<IPCResponse<StageResult>>('sessions:restore-file', sessionId, options),
      getCommitGithubUrl: (sessionId, options) => invoke<IPCResponse<CommitGithubUrl>>('sessions:get-commit-github-url', sessionId, options),
      getSyncContext: (sessionId) => invoke<IPCResponse<SyncContext>>('sessions:get-sync-context', sessionId),
      getPrTemplate: (sessionId) =>
        invoke<IPCResponse<{ template: string | null; path: string | null }>>('sessions:get-pr-template', sessionId),
      getCommitsBehindMain: (sessionId) => invoke<IPCResponse<CommitsBehind>>('sessions:get-commits-behind-main', sessionId),
      getPrRemoteCommits: (sessionId) => invoke<IPCResponse<RemoteCommits>>('sessions:get-pr-remote-commits', sessionId),
      getCIStatus: (sessionId) => invoke<IPCResponse<CIStatus>>('sessions:get-ci-status', sessionId)
    },
    terminals: {
      create: (sessionId, options) => invoke<IPCResponse<TerminalSummary>>('terminals:create', sessionId, options),
      list: (sessionId) => invoke<IPCResponse<TerminalSummary[]>>('terminals:list', sessionId),
      input: (terminalId, data) => invoke<IPCResponse<unknown>>('terminals:input', terminalId, data),
      resize: (terminalId, cols, rows) => invoke<IPCResponse<unknown>>('terminals:resize', terminalId, cols, rows),
      close: (terminalId) => invoke<IPCResponse<unknown>>('terminals:close', terminalId),
    },
    panels: {
      create: (request) => invoke<IPCResponse<ToolPanel>>('panels:create', request),
      list: (sessionId) => invoke<IPCResponse<ToolPanel[]>>('panels:list', sessionId),
      update: (panelId, updates) => invoke<IPCResponse<unknown>>('panels:update', panelId, updates),
      continue: (panelId, input, model, options, images) =>
        invoke<IPCResponse<unknown>>('panels:continue', panelId, input, model, options, images),
      answerQuestion: (panelId, panelType, answers) => {
        const prefix = panelType === 'claude'
          ? 'claude-panels'
          : panelType === 'gemini'
          ? 'geminiPanel'
          : 'codexPanel';
        return invoke<IPCResponse<unknown>>(`${prefix}:answer-question`, panelId, answers);
      }
    },
    updater: {
      download: async () => ({ success: false, error: 'Updater unavailable in web mode' }),
      install: async () => ({ success: false, error: 'Updater unavailable in web mode' })
    },
    events: {
      onSessionsLoaded: (cb) => subscribe('sessions:loaded', cb),
      onSessionCreated: (cb) => subscribe('session:created', cb),
      onSessionUpdated: (cb) => subscribe('session:updated', cb),
      onSessionDeleted: (cb) => subscribe('session:deleted', cb),
      onGitStatusUpdated: (cb) => subscribe('git-status-updated', cb),
      onGitStatusLoading: (cb) => subscribe('git-status-loading', cb),
      onTimelineEvent: (cb) => subscribe('timeline:event', cb),
      onAssistantStream: (cb) => subscribe('assistant:stream', cb),
      onUpdateAvailable: (cb) => subscribe('update:available', cb),
      onUpdateDownloaded: (cb) => subscribe('update:downloaded', cb),
      onAgentCompleted: (cb) => subscribe('agent:completed', cb),
      onSessionTodosUpdate: (cb) => subscribe('session-todos:update', cb),
      onTerminalOutput: (cb) => subscribe('terminal:output', cb),
      onTerminalClosed: (cb) => subscribe('terminal:closed', cb),
      onTerminalExited: (cb) => subscribe('terminal:exited', cb),
    }
  };

  const electronBridge: ElectronBridge = {
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { success: true };
    }
  };

  window.electronAPI = electronAPI;
  window.electron = electronBridge;
}
