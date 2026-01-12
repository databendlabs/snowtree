import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useRightPanelData } from './useRightPanelData';

const mockGetExecutions = vi.fn();
const mockGetDiff = vi.fn();
const mockGetRemotePullRequest = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getExecutions: (...args: any[]) => mockGetExecutions(...args),
      getDiff: (...args: any[]) => mockGetDiff(...args),
      getRemotePullRequest: (...args: any[]) => mockGetRemotePullRequest(...args),
      changeAllStage: vi.fn(),
      changeFileStage: vi.fn(),
    },
  },
}));

function Harness({ sessionId }: { sessionId: string }) {
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

describe('useRightPanelData - PR polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    mockGetExecutions.mockResolvedValue({
      success: true,
      data: [{
        id: 0,
        commit_message: 'Uncommitted',
        timestamp: new Date().toISOString(),
        stats_additions: 0,
        stats_deletions: 0,
        stats_files_changed: 0,
        after_commit_hash: ''
      }]
    });

    mockGetDiff.mockResolvedValue({
      success: true,
      data: {
        diff: '',
        workingTree: { staged: [], unstaged: [], untracked: [] }
      }
    });

    mockGetRemotePullRequest.mockResolvedValue({
      success: true,
      data: null
    });

    (global as any).window.electronAPI = {
      events: {
        onGitStatusUpdated: vi.fn(() => vi.fn()),
        onTimelineEvent: vi.fn(() => vi.fn()),
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('starts PR polling when sessionId is provided', async () => {
    const { unmount } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();

    // Initial loadAll call (1) + immediate poll call (2) + first interval (3)
    expect(mockGetRemotePullRequest).toHaveBeenCalledWith('s1');
    const initialCalls = mockGetRemotePullRequest.mock.calls.length;

    // Advance 5 seconds
    await vi.advanceTimersByTimeAsync(5000);

    // Should have called one more time
    expect(mockGetRemotePullRequest.mock.calls.length).toBe(initialCalls + 1);

    unmount();
  });

  it('detects PR creation (null -> PR data)', async () => {
    let callCount = 0;
    mockGetRemotePullRequest.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // First two calls: no PR
        return { success: true, data: null };
      }
      // Third call onwards: PR created
      return {
        success: true,
        data: { number: 123, url: 'https://github.com/user/repo/pull/123', merged: false }
      };
    });

    const { unmount } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();
    const initialCalls = mockGetRemotePullRequest.mock.calls.length;

    // Advance 5 seconds to trigger next poll
    await vi.advanceTimersByTimeAsync(5000);

    // PR should now be detected - at least one more call
    expect(mockGetRemotePullRequest.mock.calls.length).toBeGreaterThan(initialCalls);

    unmount();
  });

  it('detects PR updates (property changes)', async () => {
    let callCount = 0;
    mockGetRemotePullRequest.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // First two calls: draft PR
        return {
          success: true,
          data: { number: 123, url: 'https://github.com/user/repo/pull/123', merged: false }
        };
      }
      // Third call onwards: PR merged
      return {
        success: true,
        data: { number: 123, url: 'https://github.com/user/repo/pull/123', merged: true }
      };
    });

    const { unmount } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();
    const initialCalls = mockGetRemotePullRequest.mock.calls.length;

    // Advance 5 seconds to trigger next poll
    await vi.advanceTimersByTimeAsync(5000);

    // Should have detected the merged status change - at least one more call
    expect(mockGetRemotePullRequest.mock.calls.length).toBeGreaterThan(initialCalls);

    unmount();
  });

  it('detects PR deletion (PR data -> null)', async () => {
    let callCount = 0;
    mockGetRemotePullRequest.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // First two calls: PR exists
        return {
          success: true,
          data: { number: 123, url: 'https://github.com/user/repo/pull/123', merged: false }
        };
      }
      // Third call onwards: PR deleted
      return { success: true, data: null };
    });

    const { unmount } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();
    const initialCalls = mockGetRemotePullRequest.mock.calls.length;

    // Advance 5 seconds to trigger next poll
    await vi.advanceTimersByTimeAsync(5000);

    // Should have detected PR deletion - at least one more call
    expect(mockGetRemotePullRequest.mock.calls.length).toBeGreaterThan(initialCalls);

    unmount();
  });

  it('polls every 5 seconds', async () => {
    render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();

    const initialCalls = mockGetRemotePullRequest.mock.calls.length;

    // Advance 15 seconds (3 intervals)
    await vi.advanceTimersByTimeAsync(15000);

    // Should have called 3 more times (once every 5 seconds)
    expect(mockGetRemotePullRequest.mock.calls.length).toBe(initialCalls + 3);
  });

  it('cleans up polling when sessionId changes', async () => {
    const { rerender } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();

    const callsForS1 = mockGetRemotePullRequest.mock.calls.length;

    // Change sessionId
    rerender(<Harness sessionId="s2" />);
    await vi.runOnlyPendingTimersAsync();

    // Advance 5 seconds
    await vi.advanceTimersByTimeAsync(5000);

    // Should have started polling for s2
    expect(mockGetRemotePullRequest).toHaveBeenCalledWith('s2');

    // Total calls should be more than just s1's calls
    expect(mockGetRemotePullRequest.mock.calls.length).toBeGreaterThan(callsForS1);
  });

  it('stops polling when sessionId becomes undefined', async () => {
    const { rerender } = render(<Harness sessionId="s1" />);

    // Wait for initial load
    await vi.runOnlyPendingTimersAsync();

    const callsBeforeUnmount = mockGetRemotePullRequest.mock.calls.length;

    // Remove sessionId
    rerender(<Harness sessionId={undefined as any} />);
    await vi.runOnlyPendingTimersAsync();

    // Advance 10 seconds
    await vi.advanceTimersByTimeAsync(10000);

    // Should not have made any new calls
    expect(mockGetRemotePullRequest.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
