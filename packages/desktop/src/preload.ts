import { contextBridge, ipcRenderer } from 'electron';
import type { IPCResponse } from './infrastructure/ipc';

export type { IPCResponse };

ipcRenderer.setMaxListeners(50);

const on = <T>(channel: string, callback: (data: T) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('electron', {
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
});

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),

  aiTools: {
    getStatus: (options?: { force?: boolean }): Promise<IPCResponse> =>
      ipcRenderer.invoke('ai-tools:get-status', options),
    getSettings: (): Promise<IPCResponse> =>
      ipcRenderer.invoke('ai-tools:get-settings'),
  },

  dialog: {
    openDirectory: (options?: Electron.OpenDialogOptions): Promise<IPCResponse<string | null>> =>
      ipcRenderer.invoke('dialog:open-directory', options),
    listRepositories: undefined
  },

  projects: {
    getAll: (): Promise<IPCResponse> => ipcRenderer.invoke('projects:get-all'),
    create: (request: { name: string; path: string; active: boolean }): Promise<IPCResponse> =>
      ipcRenderer.invoke('projects:create', request),
    delete: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('projects:delete', projectId),
    getWorktrees: (projectId: number, sessionId?: string | null): Promise<IPCResponse> =>
      ipcRenderer.invoke('projects:get-worktrees', projectId, sessionId),
    removeWorktree: (projectId: number, worktreePath: string, sessionId?: string | null): Promise<IPCResponse> =>
      ipcRenderer.invoke('projects:remove-worktree', projectId, worktreePath, sessionId),
    renameWorktree: (projectId: number, worktreePath: string, nextName: string, sessionId?: string | null): Promise<IPCResponse> =>
      ipcRenderer.invoke('projects:rename-worktree', projectId, worktreePath, nextName, sessionId),
  },

  sessions: {
    getAll: (): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-all'),
    get: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get', sessionId),
    create: (request: { projectId: number; prompt?: string; toolType?: 'claude' | 'codex' | 'gemini' | 'none'; baseBranch?: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:create', request),
    update: (sessionId: string, updates: { toolType?: 'claude' | 'codex' | 'gemini' | 'none'; executionMode?: 'plan' | 'execute' }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:update', sessionId, updates),
    stop: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:stop', sessionId),
    delete: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:delete', sessionId),
    openWorktree: (request: { projectId: number; worktreePath: string; branch?: string | null }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:open-worktree', request),
    getTimeline: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-timeline', sessionId),
    getExecutions: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-executions', sessionId),
    getDiff: (sessionId: string, target: { kind: 'working' } | { kind: 'commit'; hash: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-diff', sessionId, target),
    getGitCommands: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-git-commands', sessionId),
    getRemotePullRequest: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-remote-pull-request', sessionId),
    getFileContent: (sessionId: string, options: { filePath: string; ref: 'HEAD' | 'INDEX' | 'WORKTREE' | string; maxBytes?: number }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-file-content', sessionId, options),
    stageHunk: (sessionId: string, options: {
      filePath: string;
      isStaging: boolean;
      hunkHeader: string;
    }): Promise<IPCResponse> => ipcRenderer.invoke('sessions:stage-hunk', sessionId, options),
    restoreHunk: (sessionId: string, options: {
      filePath: string;
      scope: 'staged' | 'unstaged';
      hunkHeader: string;
    }): Promise<IPCResponse> => ipcRenderer.invoke('sessions:restore-hunk', sessionId, options),
    changeAllStage: (sessionId: string, options: { stage: boolean }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:change-all-stage', sessionId, options),
    changeFileStage: (sessionId: string, options: { filePath: string; stage: boolean }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:change-file-stage', sessionId, options),
    restoreFile: (sessionId: string, options: { filePath: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:restore-file', sessionId, options),
    getCommitGithubUrl: (sessionId: string, options: { commitHash: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-commit-github-url', sessionId, options),
    // Sync PR workflow helpers (AI executes git/gh commands directly)
    getSyncContext: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-sync-context', sessionId),
    getPrTemplate: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-pr-template', sessionId),
    // Branch sync status helpers
    getCommitsBehindMain: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-commits-behind-main', sessionId),
    getPrRemoteCommits: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-pr-remote-commits', sessionId),
    // CI status
    getCIStatus: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-ci-status', sessionId),
  },

  terminals: {
    create: (sessionId: string, options?: { title?: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('terminals:create', sessionId, options),
    list: (sessionId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('terminals:list', sessionId),
    input: (terminalId: string, data: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('terminals:input', terminalId, data),
    resize: (terminalId: string, cols: number, rows: number): Promise<IPCResponse> =>
      ipcRenderer.invoke('terminals:resize', terminalId, cols, rows),
    close: (terminalId: string): Promise<IPCResponse> =>
      ipcRenderer.invoke('terminals:close', terminalId),
  },

  panels: {
    create: (request: { sessionId: string; type: 'claude' | 'codex' | 'gemini'; name?: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('panels:create', request),
    list: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:list', sessionId),
    update: (panelId: string, updates: { state?: unknown; title?: string; metadata?: unknown }): Promise<IPCResponse> =>
      ipcRenderer.invoke('panels:update', panelId, updates),
    continue: (panelId: string, input: string, model?: string, options?: { skipCheckpointAutoCommit?: boolean; planMode?: boolean }, images?: Array<{ id: string; filename: string; mime: string; dataUrl: string }>): Promise<IPCResponse> =>
      ipcRenderer.invoke('panels:continue', panelId, input, model, options, images),
    answerQuestion: (panelId: string, panelType: 'claude' | 'codex' | 'gemini', answers: Record<string, string | string[]>): Promise<IPCResponse> => {
      const ipcPrefix = panelType === 'claude' ? 'claude-panels' : panelType === 'gemini' ? 'geminiPanel' : 'codexPanel';
      return ipcRenderer.invoke(`${ipcPrefix}:answer-question`, panelId, answers);
    },
  },

  updater: {
    download: (): Promise<IPCResponse> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<IPCResponse> => ipcRenderer.invoke('updater:install'),
  },

  events: {
    onSessionsLoaded: (cb: (sessions: unknown[]) => void) => on('sessions:loaded', cb),
    onSessionCreated: (cb: (session: unknown) => void) => on('session:created', cb),
    onSessionUpdated: (cb: (session: unknown) => void) => on('session:updated', cb),
    onSessionDeleted: (cb: (data: unknown) => void) => on('session:deleted', cb),
    onGitStatusUpdated: (cb: (data: unknown) => void) => on('git-status-updated', cb),
    onGitStatusLoading: (cb: (data: unknown) => void) => on('git-status-loading', cb),
    onTimelineEvent: (cb: (data: { sessionId: string; event: unknown }) => void) => on('timeline:event', cb),
    onAssistantStream: (cb: (data: { sessionId: string; panelId: string; content: string }) => void) => on('assistant:stream', cb),
    onUpdateAvailable: (cb: (version: string) => void) => on('update:available', cb),
    onUpdateDownloaded: (cb: () => void) => on('update:downloaded', cb),
    onAgentCompleted: (cb: (data: { sessionId: string }) => void) => on('agent:completed', cb),
    onSessionTodosUpdate: (cb: (data: { sessionId: string; todos: Array<{ status: string; content: string; activeForm?: string }> }) => void) => on('session-todos:update', cb),
    onTerminalOutput: (cb: (data: { sessionId: string; terminalId: string; data: string; type?: string }) => void) => on('terminal:output', cb),
    onTerminalClosed: (cb: (data: { sessionId: string; terminalId: string }) => void) => on('terminal:closed', cb),
    onTerminalExited: (cb: (data: { sessionId: string; terminalId: string; exitCode: number; signal?: number }) => void) => on('terminal:exited', cb),
  },
});
