import type { Session, GitStatus } from './session';
import type { TimelineEvent } from './timeline';
import type { DiffTarget } from './diff';
import type { ToolPanel } from '@snowtree/core/types/panels';

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
}

export type ProjectDTO = {
  id: number;
  name: string;
  path: string;
  active?: boolean;
};

export type GitDiffStatsDTO = {
  additions: number;
  deletions: number;
  filesChanged: number;
};

export type GitDiffResultDTO = {
  diff: string;
  stats: GitDiffStatsDTO;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
  workingTree?: {
    staged: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed' }>;
    unstaged: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed' }>;
    untracked: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed' }>;
  };
};

export type ExecutionDTO = {
  id: number;
  commit_message: string;
  timestamp: string;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  after_commit_hash: string;
  parent_commit_hash?: string | null;
  author?: string;
};

export type RemotePullRequestDTO = {
  number: number;
  url: string;
  merged: boolean;
};

export interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;

  aiTools: {
    getStatus: (options?: { force?: boolean }) => Promise<IPCResponse<unknown>>;
    getSettings: () => Promise<IPCResponse<unknown>>;
  };

  dialog: {
    openDirectory: (options?: Electron.OpenDialogOptions) => Promise<IPCResponse<string | null>>;
  };

  projects: {
    getAll: () => Promise<IPCResponse<ProjectDTO[]>>;
    create: (request: { name: string; path: string; active: boolean }) => Promise<IPCResponse<unknown>>;
    delete: (projectId: number) => Promise<IPCResponse<unknown>>;
    getWorktrees: (projectId: number, sessionId?: string | null) => Promise<IPCResponse<Array<{
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
    }>>>;
    removeWorktree: (projectId: number, worktreePath: string, sessionId?: string | null) => Promise<IPCResponse<unknown>>;
    renameWorktree: (projectId: number, worktreePath: string, nextName: string, sessionId?: string | null) => Promise<IPCResponse<{ path: string } | unknown>>;
  };

  sessions: {
    getAll: () => Promise<IPCResponse<Session[]>>;
    get: (sessionId: string) => Promise<IPCResponse<Session>>;
    create: (request: { projectId: number; prompt?: string; toolType?: 'claude' | 'codex' | 'none'; baseBranch?: string }) => Promise<IPCResponse<{ id: string }>>;
    update: (sessionId: string, updates: { toolType?: 'claude' | 'codex' | 'none'; executionMode?: 'plan' | 'execute' }) => Promise<IPCResponse<unknown>>;
    stop: (sessionId: string) => Promise<IPCResponse<unknown>>;
    delete: (sessionId: string) => Promise<IPCResponse<unknown>>;
    openWorktree: (request: { projectId: number; worktreePath: string; branch?: string | null }) => Promise<IPCResponse<{ id: string }>>;
    getTimeline: (sessionId: string) => Promise<IPCResponse<TimelineEvent[]>>;
    getExecutions: (sessionId: string) => Promise<IPCResponse<ExecutionDTO[]>>;
    getDiff: (sessionId: string, target: DiffTarget) => Promise<IPCResponse<GitDiffResultDTO>>;
    getGitCommands: (sessionId: string) => Promise<IPCResponse<{ currentBranch: string; remoteName: string | null }>>;
    getRemotePullRequest: (sessionId: string) => Promise<IPCResponse<RemotePullRequestDTO | null>>;
    getFileContent: (sessionId: string, options: { filePath: string; ref: 'HEAD' | 'INDEX' | 'WORKTREE' | string; maxBytes?: number }) => Promise<IPCResponse<{ content: string }>>;
    stageHunk: (sessionId: string, options: {
      filePath: string;
      isStaging: boolean;
      hunkHeader: string;
    }) => Promise<IPCResponse<{ success: boolean; error?: string }>>;
    restoreHunk: (sessionId: string, options: {
      filePath: string;
      scope: 'staged' | 'unstaged';
      hunkHeader: string;
    }) => Promise<IPCResponse<{ success: boolean; error?: string }>>;
    changeAllStage: (sessionId: string, options: { stage: boolean }) => Promise<IPCResponse<{ success: boolean; error?: string }>>;
    changeFileStage: (sessionId: string, options: { filePath: string; stage: boolean }) => Promise<IPCResponse<{ success: boolean; error?: string }>>;
    restoreFile: (sessionId: string, options: { filePath: string }) => Promise<IPCResponse<{ success: boolean; error?: string }>>;
    getCommitGithubUrl: (sessionId: string, options: { commitHash: string }) => Promise<IPCResponse<{ url: string }>>;
    // Sync PR workflow helpers (AI executes git/gh commands directly)
    getPrTemplate: (sessionId: string) => Promise<IPCResponse<{ template: string | null; path: string | null }>>;
    getSyncContext: (sessionId: string) => Promise<IPCResponse<{
      status: string;
      branch: string;
      log: string;
      diffStat: string;
      prInfo: { number: number; url: string; state: string; title: string; body: string } | null;
      baseBranch: string;
      ownerRepo: string | null;
    }>>;
    // Branch sync status helpers
    getCommitsBehindMain: (sessionId: string) => Promise<IPCResponse<{ behind: number; baseBranch: string }>>;
    getPrRemoteCommits: (sessionId: string) => Promise<IPCResponse<{ ahead: number; behind: number; branch: string | null }>>;
    // CI status
    getCIStatus: (sessionId: string) => Promise<IPCResponse<{
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
    } | null>>;
  };

  panels: {
    create: (request: { sessionId: string; type: 'claude' | 'codex'; name?: string }) => Promise<IPCResponse<ToolPanel>>;
    list: (sessionId: string) => Promise<IPCResponse<ToolPanel[]>>;
    update: (panelId: string, updates: { state?: unknown; title?: string; metadata?: unknown }) => Promise<IPCResponse<unknown>>;
    continue: (panelId: string, input: string, model?: string, options?: { skipCheckpointAutoCommit?: boolean; planMode?: boolean }, images?: Array<{ id: string; filename: string; mime: string; dataUrl: string }>) => Promise<IPCResponse<unknown>>;
    answerQuestion: (panelId: string, panelType: 'claude' | 'codex', answers: Record<string, string | string[]>) => Promise<IPCResponse<unknown>>;
  };

  updater: {
    download: () => Promise<IPCResponse<unknown>>;
    install: () => Promise<IPCResponse<unknown>>;
  };

  events: {
    onSessionsLoaded: (callback: (sessions: Session[]) => void) => () => void;
    onSessionCreated: (callback: (session: Session) => void) => () => void;
    onSessionUpdated: (callback: (session: Session) => void) => () => void;
    onSessionDeleted: (callback: (data: { id?: string; sessionId?: string } | string) => void) => () => void;
    onGitStatusUpdated: (callback: (data: { sessionId: string; gitStatus: GitStatus }) => void) => () => void;
    onGitStatusLoading: (callback: (data: { sessionId: string }) => void) => () => void;
    onTimelineEvent: (callback: (data: { sessionId: string; event: TimelineEvent }) => void) => () => void;
    onAssistantStream: (callback: (data: { sessionId: string; panelId: string; content: string }) => void) => () => void;
    onUpdateAvailable: (callback: (version: string) => void) => () => void;
    onUpdateDownloaded: (callback: () => void) => () => void;
    onAgentCompleted: (callback: (data: { sessionId: string }) => void) => () => void;
  };
}

export interface ElectronBridge {
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    electron: ElectronBridge;
  }
}

export {};
