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
    create: (request: { projectId: number; prompt?: string; toolType?: 'claude' | 'codex' | 'none'; baseBranch?: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:create', request),
    stop: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:stop', sessionId),
    delete: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:delete', sessionId),
    openWorktree: (request: { projectId: number; worktreePath: string; branch?: string | null }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:open-worktree', request),
    getTimeline: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-timeline', sessionId),
    getExecutions: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-executions', sessionId),
    getDiff: (sessionId: string, target: { kind: 'working' } | { kind: 'commit'; hash: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('sessions:get-diff', sessionId, target),
    getGitCommands: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-git-commands', sessionId),
    getFileContent: (sessionId: string, options: { filePath: string; ref: 'HEAD' | 'INDEX' | 'WORKTREE'; maxBytes?: number }): Promise<IPCResponse> =>
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
  },

  panels: {
    create: (request: { sessionId: string; type: 'claude' | 'codex'; name?: string }): Promise<IPCResponse> =>
      ipcRenderer.invoke('panels:create', request),
    list: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:list', sessionId),
    continue: (panelId: string, input: string, model?: string, options?: { skipCheckpointAutoCommit?: boolean }, images?: Array<{ id: string; filename: string; mime: string; dataUrl: string }>): Promise<IPCResponse> =>
      ipcRenderer.invoke('panels:continue', panelId, input, model, options, images),
    answerQuestion: (panelId: string, panelType: 'claude' | 'codex', answers: Record<string, string | string[]>): Promise<IPCResponse> => {
      const ipcPrefix = panelType === 'claude' ? 'claude-panels' : 'codexPanel';
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
  },
});
