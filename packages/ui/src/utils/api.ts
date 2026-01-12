export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
}

const requireElectron = () => {
  if (typeof window === 'undefined' || !window.electronAPI) {
    throw new Error('Electron API not available');
  }
};

export class API {
  static sessions = {
    async getAll() {
      requireElectron();
      return window.electronAPI.sessions.getAll();
    },

    async get(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.get(sessionId);
    },

    async create(request: { projectId: number; prompt: string; toolType: 'claude' | 'codex' | 'none' }) {
      requireElectron();
      return window.electronAPI.sessions.create(request);
    },

    async stop(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.stop(sessionId);
    },

    async delete(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.delete(sessionId);
    },

    async openWorktree(request: { projectId: number; worktreePath: string; branch?: string | null }) {
      requireElectron();
      return window.electronAPI.sessions.openWorktree(request);
    },

    async getTimeline(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.getTimeline(sessionId);
    },

    async getExecutions(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.getExecutions(sessionId);
    },

    async getDiff(sessionId: string, target: import('../types/diff').DiffTarget) {
      requireElectron();
      return window.electronAPI.sessions.getDiff(sessionId, target);
    },

    async getGitCommands(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.getGitCommands(sessionId);
    },

    async getRemotePullRequest(sessionId: string) {
      requireElectron();
      return window.electronAPI.sessions.getRemotePullRequest(sessionId);
    },

    async getFileContent(sessionId: string, options: { filePath: string; ref: 'HEAD' | 'INDEX' | 'WORKTREE'; maxBytes?: number }) {
      requireElectron();
      return window.electronAPI.sessions.getFileContent(sessionId, options);
    },

    async stageHunk(sessionId: string, options: {
      filePath: string;
      isStaging: boolean;
      hunkHeader: string;
    }): Promise<{ success: boolean; error?: string }> {
      requireElectron();
      const result = await window.electronAPI.sessions.stageHunk(sessionId, options);

      if (!result.success) {
        throw new Error(result.error || 'Failed to stage hunk');
      }

      return result.data || { success: true };
    },

    async restoreHunk(sessionId: string, options: {
      filePath: string;
      scope: 'staged' | 'unstaged';
      hunkHeader: string;
    }): Promise<{ success: boolean; error?: string }> {
      requireElectron();
      const result = await window.electronAPI.sessions.restoreHunk(sessionId, options);

      if (!result.success) {
        throw new Error(result.error || 'Failed to restore hunk');
      }

      return result.data || { success: true };
    },

    async changeAllStage(sessionId: string, options: { stage: boolean }): Promise<{ success: boolean; error?: string }> {
      requireElectron();
      const result = await window.electronAPI.sessions.changeAllStage(sessionId, options);

      if (!result.success) {
        throw new Error(result.error || 'Failed to change stage state');
      }

      return result.data || { success: true };
    },

    async changeFileStage(sessionId: string, options: { filePath: string; stage: boolean }): Promise<{ success: boolean; error?: string }> {
      requireElectron();
      const result = await window.electronAPI.sessions.changeFileStage(sessionId, options);

      if (!result.success) {
        throw new Error(result.error || 'Failed to change file stage state');
      }

      return result.data || { success: true };
    },

    async restoreFile(sessionId: string, options: { filePath: string }): Promise<{ success: boolean; error?: string }> {
      requireElectron();
      const result = await window.electronAPI.sessions.restoreFile(sessionId, options);

      if (!result.success) {
        throw new Error(result.error || 'Failed to restore file');
      }

      return result.data || { success: true };
    },

    async getCommitGithubUrl(sessionId: string, options: { commitHash: string }): Promise<{ url: string } | null> {
      requireElectron();
      const result = await window.electronAPI.sessions.getCommitGithubUrl(sessionId, options);
      if (!result.success || !result.data) {
        return null;
      }
      return result.data;
    },

    // Sync PR workflow: deterministic operations
    async getSyncContext(sessionId: string): Promise<{
      status: string;
      branch: string;
      log: string;
      diffStat: string;
      prInfo: { number: number; url: string; state: string; title: string; body: string } | null;
      baseBranch: string;
      ownerRepo: string | null;
    } | null> {
      requireElectron();
      const result = await window.electronAPI.sessions.getSyncContext(sessionId);
      if (!result.success || !result.data) {
        return null;
      }
      return result.data;
    },

    async getPrTemplate(sessionId: string): Promise<{ template: string | null; path: string | null } | null> {
      requireElectron();
      const result = await window.electronAPI.sessions.getPrTemplate(sessionId);
      if (!result.success || !result.data) {
        return null;
      }
      return result.data;
    },
  };

  static projects = {
    async getAll() {
      requireElectron();
      return window.electronAPI.projects.getAll();
    },

    async create(request: { name: string; path: string; active: boolean }) {
      requireElectron();
      return window.electronAPI.projects.create(request);
    },

    async delete(projectId: number) {
      requireElectron();
      return window.electronAPI.projects.delete(projectId);
    },

    async getWorktrees(projectId: number, sessionId?: string | null) {
      requireElectron();
      return window.electronAPI.projects.getWorktrees(projectId, sessionId);
    },

    async removeWorktree(projectId: number, worktreePath: string, sessionId?: string | null) {
      requireElectron();
      return window.electronAPI.projects.removeWorktree(projectId, worktreePath, sessionId);
    },

    async renameWorktree(projectId: number, worktreePath: string, nextName: string, sessionId?: string | null) {
      requireElectron();
      return window.electronAPI.projects.renameWorktree(projectId, worktreePath, nextName, sessionId);
    },
  };

  static dialog = {
    async openDirectory(options?: { title?: string; buttonLabel?: string }) {
      requireElectron();
      return window.electronAPI.dialog.openDirectory(options);
    },
  };

  static aiTools = {
    async getStatus(options?: { force?: boolean }) {
      requireElectron();
      return window.electronAPI.aiTools.getStatus(options);
    },
    async getSettings() {
      requireElectron();
      return window.electronAPI.aiTools.getSettings();
    },
  };
}
