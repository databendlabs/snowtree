import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useRightPanelData } from './useRightPanelData';

const mockGetExecutions = vi.fn();
const mockGetDiff = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getExecutions: (...args: any[]) => mockGetExecutions(...args),
      getDiff: (...args: any[]) => mockGetDiff(...args),
      changeAllStage: vi.fn(),
      changeFileStage: vi.fn(),
    },
  },
}));

function Harness({ sessionId }: { sessionId: string }) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useRightPanelData(sessionId);
  return <div data-testid="mounted" />;
}

describe('useRightPanelData - git status refresh', () => {
  let gitStatusUpdated: ((data: any) => void) | null = null;

  beforeEach(() => {
    gitStatusUpdated = null;

    mockGetExecutions.mockResolvedValue({ success: true, data: [{ id: 0, commit_message: 'Uncommitted', timestamp: new Date().toISOString(), stats_additions: 0, stats_deletions: 0, stats_files_changed: 0, after_commit_hash: '' }] });
    mockGetDiff.mockResolvedValue({ success: true, data: { diff: '', workingTree: { staged: [], unstaged: [], untracked: [] } } });

    (global as any).window.electronAPI = {
      events: {
        onGitStatusUpdated: vi.fn((cb: any) => {
          gitStatusUpdated = cb;
          return vi.fn();
        }),
        onTimelineEvent: vi.fn(() => vi.fn()),
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes when staged/modified counts change even if other fields stay same', async () => {
    render(<Harness sessionId="s1" />);

    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(gitStatusUpdated).toBeTypeOf('function');

    // Previously this would be ignored because the signature didn't include staged/modified counts.
    gitStatusUpdated?.({
      sessionId: 's1',
      gitStatus: {
        state: 'modified',
        staged: 1,
        modified: 2,
        untracked: 0,
        conflicted: 0,
        ahead: 0,
        behind: 0,
        additions: 10,
        deletions: 1,
        filesChanged: 1,
        hasUncommittedChanges: true,
        hasUntrackedFiles: false,
        isReadyToMerge: false,
      },
    });

    await waitFor(() => expect(mockGetDiff).toHaveBeenCalledTimes(2), { timeout: 2000 });

    // Same signature again should not trigger another refresh.
    gitStatusUpdated?.({
      sessionId: 's1',
      gitStatus: {
        state: 'modified',
        staged: 1,
        modified: 2,
        untracked: 0,
        conflicted: 0,
        ahead: 0,
        behind: 0,
        additions: 10,
        deletions: 1,
        filesChanged: 1,
        hasUncommittedChanges: true,
        hasUntrackedFiles: false,
        isReadyToMerge: false,
      },
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(mockGetDiff).toHaveBeenCalledTimes(2);
  });
});
