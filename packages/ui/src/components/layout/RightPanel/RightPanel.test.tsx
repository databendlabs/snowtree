import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RightPanel } from './index';
import type { RightPanelProps } from '../types';
import { API } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      getExecutions: vi.fn(),
      getDiff: vi.fn(),
      getRemotePullRequest: vi.fn(),
      getPrRemoteCommits: vi.fn(),
      getCommitsBehindMain: vi.fn(),
      changeAllStage: vi.fn(),
      changeFileStage: vi.fn(),
    },
  },
}));

describe('RightPanel - Zed-style Changes list', () => {
  const mockProps: RightPanelProps = {
    session: {
      id: 'test-session',
      name: 'Test Session',
      status: 'ready',
      createdAt: new Date().toISOString(),
      worktreePath: '/test/path',
    },
    onFileClick: vi.fn(),
    onCommitUncommittedChanges: vi.fn(),
    isCommitDisabled: false,
    onCommitClick: vi.fn(),
    onPushPR: vi.fn(),
    isPushPRDisabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electronAPI = {
      invoke: vi.fn(),
      events: {
        onGitStatusUpdated: vi.fn(),
      },
    };
    (API.sessions.getExecutions as any).mockResolvedValue({
      success: true,
      data: [
        {
          id: 0,
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: 0,
          stats_deletions: 0,
          stats_files_changed: 0,
          after_commit_hash: '',
          parent_commit_hash: null,
          author: 'test',
        },
      ],
    });
    const workingTree = {
      staged: [{ path: 'staged1.ts', type: 'modified', additions: 5, deletions: 2 }],
      unstaged: [{ path: 'unstaged1.ts', type: 'modified', additions: 3, deletions: 1 }],
      untracked: [{ path: 'new.ts', type: 'added', additions: 10, deletions: 0 }],
    };

    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: '' } });
      }
      return Promise.resolve({ success: true, data: { diff: '', workingTree } });
    });
    (API.sessions.changeAllStage as any).mockResolvedValue({ success: true });
    (API.sessions.changeFileStage as any).mockResolvedValue({ success: true });
    (API.sessions.getRemotePullRequest as any).mockResolvedValue({ success: true, data: null });
    (API.sessions.getPrRemoteCommits as any).mockResolvedValue(null);
    (API.sessions.getCommitsBehindMain as any).mockResolvedValue(null);
  });

  it('renders without crashing', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Changes/i)).toBeInTheDocument();
    });
  });

  it('shows PR number link when remote PR exists and opens it', async () => {
    (API.sessions.getRemotePullRequest as any).mockResolvedValue({
      success: true,
      data: { number: 1234, url: 'https://github.com/org/repo/pull/1234' },
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-open-remote-pr')).toBeInTheDocument();
    });

    expect(screen.getByText('PR #1234')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-panel-open-remote-pr'));

    await waitFor(() => {
      expect((window as any).electronAPI.invoke).toHaveBeenCalledWith(
        'shell:openExternal',
        'https://github.com/org/repo/pull/1234'
      );
    });
  });

  it('keeps Remote PR sync action when remote PR exists', async () => {
    (API.sessions.getRemotePullRequest as any).mockResolvedValue({
      success: true,
      data: { number: 1234, url: 'https://github.com/org/repo/pull/1234' },
    });
    // Mock prSyncStatus with localAhead > 0 so button is enabled
    (API.sessions.getPrRemoteCommits as any).mockResolvedValue({
      ahead: 1,
      behind: 0,
      branch: 'test-branch',
    });
    // Add a session commit (id > 0) so Sync button is enabled
    (API.sessions.getExecutions as any).mockResolvedValue({
      success: true,
      data: [
        {
          id: 0,
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: 0,
          stats_deletions: 0,
          stats_files_changed: 0,
          after_commit_hash: '',
          parent_commit_hash: null,
          author: 'test',
        },
        {
          id: 1,
          commit_message: 'Session commit',
          timestamp: new Date().toISOString(),
          stats_additions: 5,
          stats_deletions: 2,
          stats_files_changed: 1,
          after_commit_hash: '1111111111111111',
          parent_commit_hash: null,
          author: 'test',
        },
      ],
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-sync-remote-pr')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('right-panel-sync-remote-pr'));
    expect(mockProps.onPushPR).toHaveBeenCalledTimes(1);
  });

  it('shows Tracked and Untracked sections', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByText(/^Tracked$/i)).toBeInTheDocument();
      expect(screen.getByText(/^Untracked$/i)).toBeInTheDocument();
    });
  });

  it('renders per-file tri-state checkboxes', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-file-tracked-staged1.ts-checkbox')).toBeInTheDocument();
    });

    const staged = screen.getByTestId('right-panel-file-tracked-staged1.ts-checkbox') as HTMLInputElement;
    const unstaged = screen.getByTestId('right-panel-file-tracked-unstaged1.ts-checkbox') as HTMLInputElement;
    const untracked = screen.getByTestId('right-panel-file-untracked-new.ts-checkbox') as HTMLInputElement;

    expect(staged.checked).toBe(true);
    expect(unstaged.checked).toBe(false);
    expect(untracked.checked).toBe(false);
  });

  it('shows hunk review progress and per-file hunk counts', async () => {
    const workingTree = {
      staged: [{ path: 'staged1.ts', type: 'modified', additions: 5, deletions: 2 }],
      unstaged: [{ path: 'unstaged1.ts', type: 'modified', additions: 3, deletions: 1 }],
      untracked: [{ path: 'new.ts', type: 'added', additions: 10, deletions: 0 }],
    };

    const allDiff = [
      'diff --git a/staged1.ts b/staged1.ts',
      'index 1111111..2222222 100644',
      '--- a/staged1.ts',
      '+++ b/staged1.ts',
      '@@ -1 +1 @@',
      '-foo',
      '+bar',
      'diff --git a/unstaged1.ts b/unstaged1.ts',
      'index 1111111..2222222 100644',
      '--- a/unstaged1.ts',
      '+++ b/unstaged1.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+b',
      '@@ -10,2 +10,2 @@',
      '-c',
      '+d',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
      '',
    ].join('\n');

    const stagedDiff = [
      'diff --git a/staged1.ts b/staged1.ts',
      'index 1111111..2222222 100644',
      '--- a/staged1.ts',
      '+++ b/staged1.ts',
      '@@ -1 +1 @@',
      '-foo',
      '+bar',
      '',
    ].join('\n');

    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: stagedDiff } });
      }
      return Promise.resolve({ success: true, data: { diff: allDiff, workingTree } });
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-review-summary')).toBeInTheDocument();
    });

    expect(screen.getByText('1/4 hunks')).toBeInTheDocument();
    expect(screen.getByText('(1/1 hunks)')).toBeInTheDocument();
    expect(screen.getByText('(0/2 hunks)')).toBeInTheDocument();
    expect(screen.getByText('(0/1 hunks)')).toBeInTheDocument();
  });

  it('stages/unstages a file via checkbox', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-file-tracked-unstaged1.ts-checkbox')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('right-panel-file-tracked-unstaged1.ts-checkbox'));

    await waitFor(() => {
      expect(API.sessions.changeFileStage).toHaveBeenCalledWith('test-session', { filePath: 'unstaged1.ts', stage: true });
    });
  });

  it('stages/unstages all via header controls', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-stage-all')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('right-panel-stage-all'));

    await waitFor(() => {
      expect(API.sessions.changeAllStage).toHaveBeenCalledWith('test-session', { stage: true });
    });
  });

  it('unstages all via header controls', async () => {
    const workingTree = {
      staged: [{ path: 'staged1.ts', type: 'modified', additions: 5, deletions: 2 }],
      unstaged: [],
      untracked: [],
    };
    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: '' } });
      }
      return Promise.resolve({ success: true, data: { diff: '', workingTree } });
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-unstage-all')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('right-panel-unstage-all'));

    await waitFor(() => {
      expect(API.sessions.changeAllStage).toHaveBeenCalledWith('test-session', { stage: false });
    });
  });

  it('shows Stage All when there are unstaged files and calls API on click', async () => {
    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-stage-all')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('right-panel-unstage-all')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-panel-stage-all'));

    await waitFor(() => {
      expect(API.sessions.changeAllStage).toHaveBeenCalledWith('test-session', { stage: true });
    });
  });

  it('handles empty groups gracefully', async () => {
    const workingTree = { staged: [], unstaged: [], untracked: [] };
    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: '' } });
      }
      return Promise.resolve({ success: true, data: { diff: '', workingTree } });
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Changes/i)).toBeInTheDocument();
    });
  });

  it('queues a refresh when status updates during an in-flight fetch', async () => {
    const onGitStatusUpdated = (window as any).electronAPI.events.onGitStatusUpdated as any;
    let statusCb: ((data: any) => void) | null = null;
    onGitStatusUpdated.mockImplementation((fn: any) => {
      statusCb = fn;
      return () => {};
    });

    let resolveAllDiff: ((value: any) => void) | null = null;
    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: '' } });
      }
      return new Promise((r) => {
        resolveAllDiff = r;
      });
    });

    render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(API.sessions.getDiff).toHaveBeenCalled();
    });

    await act(async () => {
      statusCb?.({ sessionId: 'test-session', gitStatus: { state: 'modified' } });
      await new Promise((r) => setTimeout(r, 120));
    });

    await act(async () => {
      resolveAllDiff?.({
        success: true,
        data: {
          diff: '',
          workingTree: {
            staged: [{ path: 'staged1.ts', type: 'modified', additions: 5, deletions: 2 }],
            unstaged: [{ path: 'unstaged1.ts', type: 'modified', additions: 3, deletions: 1 }],
            untracked: [{ path: 'new.ts', type: 'added', additions: 10, deletions: 0 }],
          },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect((API.sessions.getDiff as any).mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('sorts paths in a git-like (codepoint) order', async () => {
    const workingTree = {
      staged: [{ path: '_config.yml', type: 'modified', additions: 3, deletions: 2 }],
      unstaged: [
        { path: '.github/workflows/pages.yml', type: 'modified', additions: 11, deletions: 5 },
        { path: 'package.json', type: 'modified', additions: 4, deletions: 1 },
        { path: 'source/about/index.md', type: 'modified', additions: 3, deletions: 2 },
      ],
      untracked: [
        { path: 'dd.txt', type: 'added', additions: 6, deletions: 0 },
        { path: 'WORKTREE_TEST.md', type: 'added', additions: 29, deletions: 0 },
      ],
    };
    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      const scope = target?.kind === 'working' ? target?.scope : null;
      if (scope === 'staged') {
        return Promise.resolve({ success: true, data: { diff: '' } });
      }
      return Promise.resolve({ success: true, data: { diff: '', workingTree } });
    });

    const { container } = render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-file-tracked-_config.yml')).toBeInTheDocument();
      expect(screen.getByTestId('right-panel-file-tracked-.github/workflows/pages.yml')).toBeInTheDocument();
    });

    const trackedEls = Array.from(
      container.querySelectorAll('button[data-testid^="right-panel-file-tracked-"]')
    ).filter((el) => !el.getAttribute('data-testid')?.endsWith('-checkbox'));

    const trackedOrder = trackedEls.map((el) => el.getAttribute('data-testid'));
    expect(trackedOrder).toEqual([
      'right-panel-file-tracked-_config.yml',
      'right-panel-file-tracked-.github/workflows/pages.yml',
      'right-panel-file-tracked-package.json',
      'right-panel-file-tracked-source/about/index.md',
    ]);

    const untrackedEls = Array.from(
      container.querySelectorAll('button[data-testid^="right-panel-file-untracked-"]')
    ).filter((el) => !el.getAttribute('data-testid')?.endsWith('-checkbox'));
    const untrackedOrder = untrackedEls.map((el) => el.getAttribute('data-testid'));
    expect(untrackedOrder).toEqual([
      'right-panel-file-untracked-WORKTREE_TEST.md',
      'right-panel-file-untracked-dd.txt',
    ]);
  });

  it('orders commits newest-first (working tree first, base last)', async () => {
    (API.sessions.getExecutions as any).mockResolvedValue({
      success: true,
      data: [
        {
          id: 0,
          commit_message: 'Uncommitted changes',
          timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
          stats_additions: 0,
          stats_deletions: 0,
          stats_files_changed: 0,
          after_commit_hash: '',
          parent_commit_hash: null,
          author: 'test',
        },
        {
          id: 1,
          commit_message: 'older commit',
          timestamp: new Date('2026-01-01T00:00:01.000Z').toISOString(),
          stats_additions: 1,
          stats_deletions: 1,
          stats_files_changed: 1,
          after_commit_hash: '1111111111111111111111111111111111111111',
          parent_commit_hash: null,
          author: 'test',
        },
        {
          id: 2,
          commit_message: 'newer commit',
          timestamp: new Date('2026-01-01T00:00:02.000Z').toISOString(),
          stats_additions: 2,
          stats_deletions: 0,
          stats_files_changed: 1,
          after_commit_hash: '2222222222222222222222222222222222222222',
          parent_commit_hash: null,
          author: 'test',
        },
        {
          id: -1,
          commit_message: 'base',
          timestamp: new Date('2025-12-31T23:59:59.000Z').toISOString(),
          stats_additions: 0,
          stats_deletions: 0,
          stats_files_changed: 0,
          after_commit_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          parent_commit_hash: null,
          author: 'test',
        },
      ],
    });

    const { container } = render(<RightPanel {...mockProps} />);

    await waitFor(() => {
      expect(screen.getByText(/^Commits$/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Select commit uncommitted changes')).toBeInTheDocument();
    });

    const selectButtons = Array.from(container.querySelectorAll('button[aria-label^="Select commit"]'));
    const labels = selectButtons.map((el) => el.getAttribute('aria-label'));

    expect(labels[0]).toBe('Select commit uncommitted changes');
    expect(labels[1]).toBe('Select commit 2222222');
    expect(labels[2]).toBe('Select commit 1111111');
    expect(labels[3]).toBe('Select commit bbbbbbb');
    const commitTexts = container.textContent || '';
    expect(commitTexts.indexOf('newer commit')).toBeLessThan(commitTexts.indexOf('older commit'));
    expect(commitTexts.indexOf('older commit')).toBeLessThan(commitTexts.indexOf('base'));
  });
});
