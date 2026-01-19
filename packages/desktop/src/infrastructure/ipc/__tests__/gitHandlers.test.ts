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

describe('Git IPC Handlers - Remote Pull Request', () => {
  let mockIpcMain: MockIpcMain;
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };
  let mockServices: AppServices;

  beforeEach(() => {
    mockIpcMain = new MockIpcMain();

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockSessionManager = {
      getSession: vi.fn(),
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

  describe('sessions:get-remote-pull-request', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
    });

    it('should return null when session has no worktreePath', async () => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath: null });

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return null when session is not found', async () => {
      mockSessionManager.getSession.mockReturnValue(null);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should parse SSH remote URL and fetch PR with --repo flag', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:BohuTANG/blog-hexo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, will fail)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:BohuTANG/blog-hexo.git\n',
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 123, url: 'https://github.com/BohuTANG/blog-hexo/pull/123', state: 'OPEN' }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 123, url: 'https://github.com/BohuTANG/blog-hexo/pull/123', merged: false },
      });

      // Verify gh pr view was called with --repo and branch
      const ghPrViewCall = mockGitExecutor.run.mock.calls[4]; // Changed from index 2 to 4
      expect(ghPrViewCall[0].argv).toContain('--repo');
      expect(ghPrViewCall[0].argv).toContain('BohuTANG/blog-hexo');
      expect(ghPrViewCall[0].argv).toContain('feature-branch');
    });

    it('should parse HTTPS remote URL and fetch PR with --repo flag', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'main\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'https://github.com/owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, will fail)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'https://github.com/owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'MERGED' }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 42, url: 'https://github.com/owner/repo/pull/42', merged: true },
      });

      // Verify --repo contains owner/repo from HTTPS URL
      const ghPrViewCall = mockGitExecutor.run.mock.calls[4]; // Changed from index 2 to 4
      expect(ghPrViewCall[0].argv).toContain('owner/repo');
    });

    it('should return null when no PR exists for the branch', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'new-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, will fail)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view (returns exit code 1 when no PR found)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'no pull requests found',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should return null when no remote is available', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: null,
      });
    });

    it('should handle non-GitHub remotes gracefully', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'main\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner, GitLab URL won't match)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@gitlab.com:owner/repo.git\n', // GitLab, not GitHub
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop, GitLab URL won't match regex)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@gitlab.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should detect merged PR state', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'merged-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 50, url: 'https://github.com/owner/repo/pull/50', state: 'MERGED' }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 50, url: 'https://github.com/owner/repo/pull/50', merged: true },
      });
    });

    it('should handle malformed JSON response gracefully', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view (returns malformed JSON)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'not valid json',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should handle empty branch name', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current (returns empty for detached HEAD)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '', // Empty branch (detached HEAD)
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      // Should fallback to gh pr view without --repo when branch is empty
      expect(result.success).toBe(true);
    });

    it('should handle SSH URL without .git suffix', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git remote get-url origin (to extract owner)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo\n', // No .git suffix
          stderr: '',
        } as MockRunResult)
        // 3. git remote get-url upstream (first in loop, fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 4. git remote get-url origin (second in loop)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:owner/repo\n', // No .git suffix
          stderr: '',
        } as MockRunResult)
        // 5. gh pr view
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ number: 10, url: 'https://github.com/owner/repo/pull/10', state: 'OPEN' }),
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-remote-pull-request', sessionId);

      expect(result).toEqual({
        success: true,
        data: { number: 10, url: 'https://github.com/owner/repo/pull/10', merged: false },
      });

      // Verify owner/repo was parsed correctly
      const ghPrViewCall = mockGitExecutor.run.mock.calls[4]; // Changed from index 2 to 4
      expect(ghPrViewCall[0].argv).toContain('owner/repo');
    });
  });
});

describe('Git IPC Handlers - Commit URL', () => {
  let mockIpcMain: MockIpcMain;
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };
  let mockServices: AppServices;

  beforeEach(() => {
    mockIpcMain = new MockIpcMain();

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockSessionManager = {
      getSession: vi.fn(),
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

  describe('sessions:get-commit-github-url', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
    });

    it('should prefer upstream when origin is a fork', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:forkowner/snowtree.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:datafuselabs/snowtree.git\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commit-github-url', sessionId, { commitHash: 'abc123' });

      expect(result).toEqual({
        success: true,
        data: { url: 'https://github.com/datafuselabs/snowtree/commit/abc123' },
      });
    });
  });
});

describe('Git IPC Handlers - Branch Sync Status', () => {
  let mockIpcMain: MockIpcMain;
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };
  let mockServices: AppServices;

  beforeEach(() => {
    mockIpcMain = new MockIpcMain();

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockSessionManager = {
      getSession: vi.fn(),
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

  describe('sessions:get-executions', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath, baseBranch: 'main' });
      mockServices.gitDiffManager.getCommitHistory.mockResolvedValue([]);
      mockServices.gitDiffManager.hasChanges.mockResolvedValue(false);
    });

    it('should use baseCommit when available', async () => {
      const baseCommit = 'abc123def456';
      const delimiter = '\x1f';
      const logLine = [
        baseCommit,
        'def789abc000',
        'Base commit',
        '2025-01-01T00:00:00Z',
        'Base Author',
      ].join(delimiter);

      mockSessionManager.getSession.mockReturnValue({ worktreePath, baseBranch: 'main', baseCommit });

      mockGitExecutor.run.mockImplementation((opts: { argv: string[] }) => {
        const cmd = opts.argv.join(' ');
        if (cmd.includes('rev-parse --verify') && cmd.includes(baseCommit)) {
          return Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
          } as MockRunResult);
        }
        if (cmd.includes('log -1')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${logLine}\n`,
            stderr: '',
          } as MockRunResult);
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' } as MockRunResult);
      });

      const result = await mockIpcMain.invoke('sessions:get-executions', sessionId);

      expect(result.success).toBe(true);

      const remoteGetUrlCalled = mockGitExecutor.run.mock.calls.some((call) =>
        call[0].argv.join(' ').includes('remote get-url')
      );
      expect(remoteGetUrlCalled).toBe(false);

      const logUsesBaseCommit = mockGitExecutor.run.mock.calls.some((call) =>
        call[0].argv.includes(baseCommit)
      );
      expect(logUsesBaseCommit).toBe(true);
    });

    it('should prefer upstream base ref when origin is a fork', async () => {
      const delimiter = '\x1f';
      const logLine = [
        'abc123def456',
        'def789abc000',
        'Merge upstream',
        '2025-01-01T00:00:00Z',
        'Upstream Author',
      ].join(delimiter);

      mockGitExecutor.run.mockImplementation((opts: { argv: string[] }) => {
        const cmd = opts.argv.join(' ');
        if (cmd.includes('remote get-url origin')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: 'git@github.com:forkowner/snowtree.git\n',
            stderr: '',
          } as MockRunResult);
        }
        if (cmd.includes('remote get-url upstream')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: 'git@github.com:datafuselabs/snowtree.git\n',
            stderr: '',
          } as MockRunResult);
        }
        if (cmd.includes('show-ref --verify --quiet refs/remotes/upstream/main')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
          } as MockRunResult);
        }
        if (cmd.includes('log -1')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${logLine}\n`,
            stderr: '',
          } as MockRunResult);
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' } as MockRunResult);
      });

      const result = await mockIpcMain.invoke('sessions:get-executions', sessionId);

      expect(result.success).toBe(true);

      const originProbe = mockGitExecutor.run.mock.calls.some((call) =>
        call[0].argv.includes('refs/remotes/origin/main')
      );
      expect(originProbe).toBe(false);

      const upstreamLog = mockGitExecutor.run.mock.calls.some((call) =>
        call[0].argv.includes('upstream/main')
      );
      expect(upstreamLog).toBe(true);
    });
  });

  describe('sessions:get-commits-behind-main', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath, baseBranch: 'main' });
    });

    it('should return error when session has no worktreePath', async () => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath: null });

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return error when session is not found', async () => {
      mockSessionManager.getSession.mockReturnValue(null);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return commits behind main count', async () => {
      mockGitExecutor.run
        // 1. git remote get-url upstream (no upstream)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        // 2. git fetch origin main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git rev-list HEAD..origin/main --count
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '5\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({
        success: true,
        data: { behind: 5, baseBranch: 'main' },
      });
    });

    it('should return 0 when branch is up to date', async () => {
      mockGitExecutor.run
        // 1. git remote get-url upstream (no upstream)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 2. git fetch origin main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git rev-list HEAD..origin/main --count
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '0\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({
        success: true,
        data: { behind: 0, baseBranch: 'main' },
      });
    });

    it('should use custom baseBranch from session', async () => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath, baseBranch: 'master' });

      mockGitExecutor.run
        // 1. git remote get-url upstream (no upstream)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 2. git fetch origin master
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git rev-list HEAD..origin/master --count
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '3\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({
        success: true,
        data: { behind: 3, baseBranch: 'master' },
      });

      // Verify fetch was called with correct branch
      const fetchCall = mockGitExecutor.run.mock.calls[1]; // Changed from index 0 to 1
      expect(fetchCall[0].argv).toContain('master');
    });

    it('should return 0 when origin/main does not exist', async () => {
      mockGitExecutor.run
        // 1. git remote get-url upstream (no upstream)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 2. git fetch origin main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git rev-list HEAD..origin/main --count (fails)
        .mockResolvedValueOnce({
          exitCode: 128, // fatal: ambiguous argument
          stdout: '',
          stderr: 'fatal: ambiguous argument',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({
        success: true,
        data: { behind: 0, baseBranch: 'main' },
      });
    });

    it('should handle fetch failure gracefully', async () => {
      mockGitExecutor.run
        // 1. git remote get-url upstream (no upstream)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 2. git fetch origin main (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: could not fetch',
        } as MockRunResult)
        // 3. git rev-list HEAD..origin/main --count (still works with local refs)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '2\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      // Should still work even if fetch fails (use local refs)
      expect(result).toEqual({
        success: true,
        data: { behind: 2, baseBranch: 'main' },
      });
    });

    it('should use upstream remote in fork workflow', async () => {
      mockGitExecutor.run
        // 1. git remote get-url upstream (has upstream)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@github.com:databendlabs/snowtree.git\n',
          stderr: '',
        } as MockRunResult)
        // 2. git fetch upstream main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git rev-list HEAD..upstream/main --count
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '7\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-commits-behind-main', sessionId);

      expect(result).toEqual({
        success: true,
        data: { behind: 7, baseBranch: 'main' },
      });

      // Verify fetch was called with upstream
      const fetchCall = mockGitExecutor.run.mock.calls[1];
      expect(fetchCall[0].argv).toContain('upstream');
      expect(fetchCall[0].argv).toContain('main');
    });
  });

  describe('sessions:get-pr-remote-commits', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
    });

    it('should return error when session has no worktreePath', async () => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath: null });

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return error when session is not found', async () => {
      mockSessionManager.getSession.mockReturnValue(null);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return ahead and behind counts', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.feature-branch.pushRemote (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.feature-branch.remote (returns origin)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'origin\n',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch origin feature-branch
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/origin/feature-branch
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 6. git rev-list origin/feature-branch..HEAD --count (local ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '3\n',
          stderr: '',
        } as MockRunResult)
        // 7. git rev-list HEAD..origin/feature-branch --count (remote ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '2\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 3, behind: 2, branch: 'feature-branch' },
      });
    });

    it('should return zeros when branch is synced', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'main\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.main.pushRemote (fails, no pushRemote set)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.main.remote (fallback, returns origin)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'origin\n',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch origin main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/origin/main
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 6. git rev-list --count origin/main..HEAD (ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '0\n',
          stderr: '',
        } as MockRunResult)
        // 7. git rev-list --count HEAD..origin/main (behind)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '0\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 0, behind: 0, branch: 'main' },
      });
    });

    it('should return zeros when remote branch does not exist', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'new-branch\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.new-branch.pushRemote (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.new-branch.remote (fails, not set up yet)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch origin new-branch (may fail for non-existent branch)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: could not fetch',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/origin/new-branch (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 0, behind: 0, branch: 'new-branch' },
      });
    });

    it('should fallback to origin when branch remote is upstream and branch is missing', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.feature.pushRemote (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.feature.remote (returns upstream)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'upstream\n',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch upstream feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/upstream/feature (missing)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 6. git fetch origin feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 7. git show-ref --verify --quiet refs/remotes/origin/feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 8. git rev-list origin/feature..HEAD --count (local ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '2\n',
          stderr: '',
        } as MockRunResult)
        // 9. git rev-list HEAD..origin/feature --count (remote ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '1\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 2, behind: 1, branch: 'feature' },
      });
    });

    it('should return null branch when in detached HEAD state', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '', // Empty for detached HEAD
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 0, behind: 0, branch: null },
      });
    });

    it('should handle only local commits ahead', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.feature.pushRemote (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.feature.remote (returns origin)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'origin\n',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch origin feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/origin/feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 6. git rev-list --count origin/feature..HEAD (ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '5\n', // 5 local commits ahead
          stderr: '',
        } as MockRunResult)
        // 7. git rev-list --count HEAD..origin/feature (behind)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '0\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 5, behind: 0, branch: 'feature' },
      });
    });

    it('should handle only remote commits ahead', async () => {
      mockGitExecutor.run
        // 1. git branch --show-current
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        // 2. git config branch.feature.pushRemote (fails)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 3. git config branch.feature.remote (returns origin)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'origin\n',
          stderr: '',
        } as MockRunResult)
        // 4. git fetch origin feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 5. git show-ref --verify --quiet refs/remotes/origin/feature
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
        } as MockRunResult)
        // 6. git rev-list --count origin/feature..HEAD (ahead)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '0\n', // 0 local commits ahead
          stderr: '',
        } as MockRunResult)
        // 7. git rev-list --count HEAD..origin/feature (behind)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '4\n', // 4 remote commits ahead
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-pr-remote-commits', sessionId);

      expect(result).toEqual({
        success: true,
        data: { ahead: 0, behind: 4, branch: 'feature' },
      });
    });
  });
});

describe('Git IPC Handlers - CI Status', () => {
  let mockIpcMain: MockIpcMain;
  let mockGitExecutor: { run: ReturnType<typeof vi.fn> };
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };
  let mockServices: AppServices;

  beforeEach(() => {
    mockIpcMain = new MockIpcMain();

    mockGitExecutor = {
      run: vi.fn(),
    };

    mockSessionManager = {
      getSession: vi.fn(),
    };

    mockServices = {
      gitExecutor: mockGitExecutor,
      sessionManager: mockSessionManager,
      gitStagingManager: { stageHunk: vi.fn(), restoreHunk: vi.fn() },
      gitStatusManager: { refreshSessionGitStatus: vi.fn() },
      gitDiffManager: { getDiff: vi.fn() },
      worktreeManager: {},
      configManager: {},
    } as unknown as AppServices;

    registerGitHandlers(mockIpcMain as unknown as IpcMain, mockServices);
  });

  describe('sessions:get-ci-status', () => {
    const sessionId = 'test-session-123';
    const worktreePath = '/path/to/worktree';

    beforeEach(() => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath });
    });

    it('should return error when session has no worktreePath', async () => {
      mockSessionManager.getSession.mockReturnValue({ worktreePath: null });

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: false, error: 'Session worktree not found' });
    });

    it('should return null when remote URL cannot be obtained', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // upstream not found
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 1, // origin not found
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should return null for non-GitHub remotes', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'git@gitlab.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should return null when branch is empty', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '', // Empty branch (detached HEAD)
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should return null when gh pr checks fails', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature-branch\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 1, // gh pr checks fails (no PR)
          stdout: '',
          stderr: 'no pull requests found',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should parse SUCCESS checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'SUCCESS', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:10:00Z', link: 'https://github.com/test/link1' },
        { name: 'test', state: 'SUCCESS', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:12:00Z', link: 'https://github.com/test/link2' },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        rollupState: 'success',
        checks: [
          { id: 0, name: 'build', workflow: null, status: 'completed', conclusion: 'success', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:10:00Z', detailsUrl: 'https://github.com/test/link1' },
          { id: 1, name: 'test', workflow: null, status: 'completed', conclusion: 'success', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:12:00Z', detailsUrl: 'https://github.com/test/link2' },
        ],
        totalCount: 2,
        successCount: 2,
        failureCount: 0,
        pendingCount: 0,
      });
    });

    it('should parse FAILURE checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'SUCCESS', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:10:00Z', link: 'https://github.com/test/link1' },
        { name: 'test', state: 'FAILURE', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:08:00Z', link: 'https://github.com/test/link2' },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.rollupState).toBe('failure');
      expect(result.data.successCount).toBe(1);
      expect(result.data.failureCount).toBe(1);
    });

    it('should parse PENDING checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'PENDING', startedAt: null, completedAt: null, link: 'https://github.com/test/link1' },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.rollupState).toBe('pending');
      expect(result.data.pendingCount).toBe(1);
      expect(result.data.checks[0].status).toBe('queued');
      expect(result.data.checks[0].conclusion).toBe(null);
    });

    it('should parse IN_PROGRESS checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'IN_PROGRESS', startedAt: '2026-01-14T05:00:00Z', completedAt: null, link: 'https://github.com/test/link1' },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.rollupState).toBe('in_progress');
      expect(result.data.pendingCount).toBe(1);
      expect(result.data.checks[0].status).toBe('in_progress');
      expect(result.data.checks[0].conclusion).toBe(null);
    });

    it('should parse SKIPPED checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'optional-check', state: 'SKIPPED', startedAt: null, completedAt: null, link: null },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.checks[0].status).toBe('completed');
      expect(result.data.checks[0].conclusion).toBe('skipped');
      expect(result.data.successCount).toBe(1); // skipped counts as success
    });

    it('should parse CANCELLED checks correctly', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'CANCELLED', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:01:00Z', link: null },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.checks[0].status).toBe('completed');
      expect(result.data.checks[0].conclusion).toBe('cancelled');
    });

    it('should handle empty checks array', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '[]',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should handle malformed JSON gracefully', async () => {
      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'not valid json',
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result).toEqual({ success: true, data: null });
    });

    it('should prioritize failure over in_progress in rollup state', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'SUCCESS', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:10:00Z', link: null },
        { name: 'test', state: 'FAILURE', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:08:00Z', link: null },
        { name: 'lint', state: 'IN_PROGRESS', startedAt: '2026-01-14T05:00:00Z', completedAt: null, link: null },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'git@github.com:owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'feature\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.rollupState).toBe('failure'); // failure takes priority
    });

    it('should work with HTTPS remote URLs', async () => {
      const checksJson = JSON.stringify([
        { name: 'build', state: 'SUCCESS', startedAt: '2026-01-14T05:00:00Z', completedAt: '2026-01-14T05:10:00Z', link: null },
      ]);

      mockGitExecutor.run
        .mockResolvedValueOnce({
          exitCode: 1, // no upstream
          stdout: '',
          stderr: 'fatal: No such remote',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0, // origin
          stdout: 'https://github.com/owner/repo.git\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'main\n',
          stderr: '',
        } as MockRunResult)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: checksJson,
          stderr: '',
        } as MockRunResult);

      const result = await mockIpcMain.invoke('sessions:get-ci-status', sessionId);

      expect(result.success).toBe(true);
      expect(result.data.rollupState).toBe('success');

      // Verify gh pr checks was called with correct --repo (call index changed due to upstream check)
      const ghChecksCall = mockGitExecutor.run.mock.calls[3];
      expect(ghChecksCall[0].argv).toContain('--repo');
      expect(ghChecksCall[0].argv).toContain('owner/repo');
    });
  });
});
