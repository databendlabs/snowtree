import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerGitHandlers } from '../git';
import type { AppServices } from '../types';

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

// Mock GitExecutor run result
interface MockRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe('Git IPC Handlers - Repo Info Cache', () => {
  let mockIpcMain: MockIpcMain;
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn>; db: { getSession: ReturnType<typeof vi.fn>; updateSession: ReturnType<typeof vi.fn> } };
  let mockServices: AppServices;

  beforeEach(() => {
    mockIpcMain = new MockIpcMain();

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockSessionManager = {
      getSession: vi.fn(),
      db: {
        getSession: vi.fn().mockReturnValue(null), // Return null by default (cache miss)
        updateSession: vi.fn(),
      },
    };

    mockServices = {
      gitExecutor: mockGitExecutor,
      sessionManager: mockSessionManager,
      gitStagingManager: { stageHunk: vi.fn(), restoreHunk: vi.fn() },
      gitStatusManager: { refreshSessionGitStatus: vi.fn() },
      gitDiffManager: {
        getDiff: vi.fn(),
        getCommitHistory: vi.fn(),
        hasChanges: vi.fn(),
        getWorkingDiffStatsQuick: vi.fn(),
      },
      worktreeManager: {},
      configManager: {},
    } as unknown as AppServices;

    registerGitHandlers(mockIpcMain as unknown as IpcMain, mockServices);
  });

  describe('sessions:get-remote-pull-request with cache', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
    });

    it('should use cached branch and repo info', async () => {
      // Set up cache hit - need BOTH branch AND owner_repo
      mockSessionManager.db.getSession.mockReturnValue({
        current_branch: 'feature-branch',
        owner_repo: 'owner/repo',
        is_fork: false,
        origin_owner_repo: 'owner/repo',
      });

      mockGitExecutor.run
        // 1. gh pr view (using cached data, no git commands needed)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 123, url: 'https://github.com/owner/repo/pull/123', state: 'OPEN', isDraft: false }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 123, url: 'https://github.com/owner/repo/pull/123', state: 'open' },
      });

      // Verify cache was used - should only call gh pr view, not git commands
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(1);
      // Verify updateSession was not called (cache hit)
      expect(mockSessionManager.db.updateSession).not.toHaveBeenCalled();
    });

    it('should cache repo info on first call', async () => {
      // Cache miss - will call fetchAndCacheRepoInfo
      mockGitExecutor.run
        // 1. git branch --show-current (from fetchAndCacheRepoInfo)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (from fetchAndCacheRepoInfo)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (from fetchAndCacheRepoInfo)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. gh pr view (using newly cached data)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 123, url: 'https://github.com/owner/repo/pull/123', state: 'OPEN', isDraft: false }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 123, url: 'https://github.com/owner/repo/pull/123', state: 'open' },
      });

      // Verify updateSession was called to cache the data
      expect(mockSessionManager.db.updateSession).toHaveBeenCalledWith(sessionId, {
        current_branch: 'feature-branch',
        owner_repo: 'owner/repo',
        is_fork: false,
        origin_owner_repo: 'owner/repo',
      });
    });

    it('should use cached data for fork workflow', async () => {
      // Set up cache with fork info - need BOTH branch AND owner_repo
      mockSessionManager.db.getSession.mockReturnValue({
        current_branch: 'feature-branch',
        owner_repo: 'upstream-owner/repo',
        is_fork: true,
        origin_owner_repo: 'fork-owner/repo',
      });

      mockGitExecutor.run
        // 1. gh pr view (with fork-owner:branch format, using cached data)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 456, url: 'https://github.com/upstream-owner/repo/pull/456', state: 'OPEN', isDraft: false }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 456, url: 'https://github.com/upstream-owner/repo/pull/456', state: 'open' },
      });

      // Verify the gh command used the fork-owner:branch format
      const ghCall = mockGitExecutor.run.mock.calls[0];
      expect(ghCall[0].argv).toContain('fork-owner:feature-branch');
    });
  });

  describe('sessions:get-pr-remote-commits with cache', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
      mockSessionManager.db.getSession.mockReturnValue(null);
    });

    it('should use cached branch name', async () => {
      // Set up cache hit
      mockSessionManager.db.getSession.mockReturnValue({
        current_branch: 'feature-branch',
      });

      mockGitExecutor.run
        // 1. git config branch.feature-branch.pushRemote
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.feature-branch.remote
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'origin\n',
          stderr: '',
        } as MockRunResult)
        // 3. git fetch origin feature-branch
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 4. git show-ref
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git rev-list (local ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '2\n',
          stderr: '',
        } as MockRunResult)
        // 6. git rev-list (remote ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '1\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 2, behind: 1, branch: 'feature-branch' },
      });

      // Verify cache was used - should NOT call git branch
      const firstCall = mockGitExecutor.run.mock.calls[0];
      expect(firstCall[0].argv).not.toContain('branch');
      expect(firstCall[0].argv).toContain('config');
    });
  });
});
