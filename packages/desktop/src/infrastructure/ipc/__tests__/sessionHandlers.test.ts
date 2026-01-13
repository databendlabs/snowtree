import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

import * as fs from 'fs';

// Mock IpcMain
class MockIpcMain {
  private handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> = new Map();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }
    return handler({}, ...args);
  }

  clear() {
    this.handlers.clear();
  }
}

describe('Session IPC Handlers - Worktree Path Recovery', () => {
  let mockIpcMain: MockIpcMain;
  let mockSessionManager: {
    getSession: ReturnType<typeof vi.fn>;
    getDbSession: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
    getAllSessions: ReturnType<typeof vi.fn>;
    updateSessionStatus: ReturnType<typeof vi.fn>;
    deleteSessionPermanently: ReturnType<typeof vi.fn>;
    getTimelineEvents: ReturnType<typeof vi.fn>;
    addPanelConversationMessage: ReturnType<typeof vi.fn>;
    getPanelAgentSessionId: ReturnType<typeof vi.fn>;
    getPanelConversationMessages: ReturnType<typeof vi.fn>;
  };
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockWorktreeManager: {
    listWorktreesDetailed: ReturnType<typeof vi.fn>;
    removeWorktreePath: ReturnType<typeof vi.fn>;
  };
  let mockDatabaseService: { getProject: ReturnType<typeof vi.fn> };
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let mockServices: AppServices;

  const sessionId = 'test-session-123';
	  const projectId = 1;
	  const oldWorktreePath = '/path/to/worktrees/paris-w7x9k2m';
	  const newWorktreePath = '/path/to/worktrees/my-feature';
	  const oldBranchName = 'paris-w7x9k2m';

  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcMain = new MockIpcMain();

    mockSessionManager = {
      getSession: vi.fn(),
      getDbSession: vi.fn(),
      updateSession: vi.fn(),
      getAllSessions: vi.fn(),
      updateSessionStatus: vi.fn(),
      deleteSessionPermanently: vi.fn(),
      getTimelineEvents: vi.fn(),
      addPanelConversationMessage: vi.fn(),
      getPanelAgentSessionId: vi.fn(),
      getPanelConversationMessages: vi.fn(),
    };

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockWorktreeManager = {
      listWorktreesDetailed: vi.fn(),
      removeWorktreePath: vi.fn(),
    };

    mockDatabaseService = {
      getProject: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    mockServices = {
      sessionManager: mockSessionManager,
      gitExecutor: mockGitExecutor,
      worktreeManager: mockWorktreeManager,
      databaseService: mockDatabaseService,
      logger: mockLogger,
      taskQueue: null,
      gitStatusManager: { setActiveSession: vi.fn() },
      claudeExecutor: { kill: vi.fn() },
      codexExecutor: { kill: vi.fn() },
      configManager: {},
    } as unknown as AppServices;

    registerSessionHandlers(mockIpcMain as unknown as IpcMain, mockServices);
  });

  describe('sessions:get with worktree path recovery', () => {
    it('should return session directly when worktree path exists', async () => {
      const session = {
        id: sessionId,
        worktreePath: oldWorktreePath,
        projectId,
      };
      mockSessionManager.getSession.mockReturnValue(session);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

      expect(result).toEqual({ success: true, data: session });
      expect(mockWorktreeManager.listWorktreesDetailed).not.toHaveBeenCalled();
      expect(mockGitExecutor.run).not.toHaveBeenCalled();
    });

	    it('should recover worktree path when folder is moved/renamed', async () => {
	      const session = {
	        id: sessionId,
	        worktreePath: oldWorktreePath,
	        projectId,
      };
      const dbSession = {
        worktree_name: oldBranchName,
      };
      const project = {
        path: '/path/to/project',
      };

      mockSessionManager.getSession.mockReturnValue(session);
      mockSessionManager.getDbSession.mockReturnValue(dbSession);
      mockDatabaseService.getProject.mockReturnValue(project);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
	      mockWorktreeManager.listWorktreesDetailed.mockResolvedValue([
	        { path: newWorktreePath, branch: oldBranchName },
	      ]);

	      const result = await mockIpcMain.invoke('sessions:get', sessionId);

	      expect(result.success).toBe(true);
	      expect(mockSessionManager.updateSession).toHaveBeenCalledWith(sessionId, {
	        worktreePath: newWorktreePath,
	      });
	      expect(mockGitExecutor.run).not.toHaveBeenCalled();
	    });

    it('should not rename branch when folder name matches branch name', async () => {
      const session = {
        id: sessionId,
        worktreePath: oldWorktreePath,
        projectId,
      };
      const dbSession = {
        worktree_name: oldBranchName,
      };
      const project = {
        path: '/path/to/project',
      };

      mockSessionManager.getSession.mockReturnValue(session);
      mockSessionManager.getDbSession.mockReturnValue(dbSession);
      mockDatabaseService.getProject.mockReturnValue(project);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      // Worktree found at a path with same folder name as branch
      mockWorktreeManager.listWorktreesDetailed.mockResolvedValue([
        { path: `/different/path/worktrees/${oldBranchName}`, branch: oldBranchName },
      ]);

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

	      expect(result.success).toBe(true);
	      // Branch renames are not performed during path recovery.
	      expect(mockGitExecutor.run).not.toHaveBeenCalled();
	      expect(mockSessionManager.updateSession).toHaveBeenCalledWith(sessionId, {
	        worktreePath: `/different/path/worktrees/${oldBranchName}`,
	      });
	    });

    it('should return null when session has no worktreePath', async () => {
      mockSessionManager.getSession.mockReturnValue({ id: sessionId, worktreePath: null });

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

      // Recovery returns null but session is still returned
      expect(result.success).toBe(true);
    });

    it('should return null when worktree not found by branch name', async () => {
      const session = {
        id: sessionId,
        worktreePath: oldWorktreePath,
        projectId,
      };
      const dbSession = {
        worktree_name: oldBranchName,
      };
      const project = {
        path: '/path/to/project',
      };

      mockSessionManager.getSession.mockReturnValue(session);
      mockSessionManager.getDbSession.mockReturnValue(dbSession);
      mockDatabaseService.getProject.mockReturnValue(project);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      // No matching worktree found
      mockWorktreeManager.listWorktreesDetailed.mockResolvedValue([
        { path: '/some/other/path', branch: 'other-branch' },
      ]);

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).not.toHaveBeenCalled();
      expect(mockSessionManager.updateSession).not.toHaveBeenCalled();
    });

	    it('should return null when no project found', async () => {
	      const session = {
	        id: sessionId,
        worktreePath: oldWorktreePath,
        projectId,
      };
      const dbSession = {
        worktree_name: oldBranchName,
      };

      mockSessionManager.getSession.mockReturnValue(session);
      mockSessionManager.getDbSession.mockReturnValue(dbSession);
      mockDatabaseService.getProject.mockReturnValue(null);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

      expect(result.success).toBe(true);
      expect(mockWorktreeManager.listWorktreesDetailed).not.toHaveBeenCalled();
    });

    it('should return null when no worktree_name in db session', async () => {
      const session = {
        id: sessionId,
        worktreePath: oldWorktreePath,
        projectId,
      };
      const dbSession = {
        worktree_name: null,
      };
      const project = {
        path: '/path/to/project',
      };

      mockSessionManager.getSession.mockReturnValue(session);
      mockSessionManager.getDbSession.mockReturnValue(dbSession);
      mockDatabaseService.getProject.mockReturnValue(project);
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await mockIpcMain.invoke('sessions:get', sessionId);

      expect(result.success).toBe(true);
      expect(mockWorktreeManager.listWorktreesDetailed).not.toHaveBeenCalled();
    });
  });
});
