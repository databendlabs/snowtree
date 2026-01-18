import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { DiffOverlay } from './DiffOverlay';
import { API } from '../../utils/api';

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getDiff: vi.fn(),
      getFileContent: vi.fn(),
    },
  },
}));

describe('DiffOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (API.sessions.getDiff as any).mockResolvedValue({ success: true, data: { diff: '' } });
    (API.sessions.getFileContent as any).mockResolvedValue({ success: true, data: { content: 'a\nb\nc' } });

    (window as any).electronAPI = {
      events: {
        onGitStatusUpdated: vi.fn(),
        onTimelineEvent: vi.fn(),
      },
    };
  });

  it('reloads when filePath changes while open', async () => {
    const props = {
      isOpen: true,
      sessionId: 's1',
      filePath: 'a.txt',
      target: { kind: 'working', scope: 'all' } as any,
      onClose: vi.fn(),
      files: [],
    };

    const { rerender } = render(<DiffOverlay {...(props as any)} />);

    await waitFor(() => {
      expect(API.sessions.getFileContent).toHaveBeenCalledWith('s1', expect.objectContaining({ filePath: 'a.txt' }));
    });

    rerender(<DiffOverlay {...({ ...props, filePath: 'b.txt' } as any)} />);

    await waitFor(() => {
      expect(API.sessions.getFileContent).toHaveBeenCalledWith('s1', expect.objectContaining({ filePath: 'b.txt' }));
    });
  });

  it('refreshes when git status updates while open', async () => {
    const onGitStatusUpdated = (window as any).electronAPI.events.onGitStatusUpdated as any;
    let cb: ((data: any) => void) | null = null;
    onGitStatusUpdated.mockImplementation((fn: any) => {
      cb = fn;
      return () => {};
    });

    render(
      <DiffOverlay
        isOpen={true}
        sessionId="s1"
        filePath="a.txt"
        target={{ kind: 'working', scope: 'all' } as any}
        onClose={vi.fn()}
        files={[]}
      />
    );

    await waitFor(() => {
      expect(onGitStatusUpdated).toHaveBeenCalled();
    });

    const callsBefore = (API.sessions.getDiff as any).mock.calls.length;
    await act(async () => {
      cb?.({ sessionId: 's1', gitStatus: { state: 'modified' } });
      await new Promise((r) => setTimeout(r, 120));
    });

    await waitFor(() => {
      expect((API.sessions.getDiff as any).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('refreshes when git staging timeline events arrive while open', async () => {
    const onTimelineEvent = (window as any).electronAPI.events.onTimelineEvent as any;
    let cb: ((data: any) => void) | null = null;
    onTimelineEvent.mockImplementation((fn: any) => {
      cb = fn;
      return () => {};
    });

    render(
      <DiffOverlay
        isOpen={true}
        sessionId="s1"
        filePath="a.txt"
        target={{ kind: 'working', scope: 'all' } as any}
        onClose={vi.fn()}
        files={[]}
      />
    );

    await waitFor(() => {
      expect(onTimelineEvent).toHaveBeenCalled();
    });

    const callsBefore = (API.sessions.getDiff as any).mock.calls.length;
    await act(async () => {
      cb?.({ sessionId: 's1', event: { kind: 'git.command', status: 'finished', meta: { source: 'gitStaging' } } });
      await new Promise((r) => setTimeout(r, 120));
    });

    await waitFor(() => {
      expect((API.sessions.getDiff as any).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('loads file sources for project diff view (working/all)', async () => {
    (API.sessions.getDiff as any).mockImplementation((_sessionId: string, target: any) => {
      if (target?.kind === 'working' && target?.scope === 'all') {
        return Promise.resolve({
          success: true,
          data: {
            diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-a\n+b\n',
            changedFiles: ['tracked.txt', 'README.md', 'logo.png'],
            workingTree: {
              staged: [],
              unstaged: [{ path: 'tracked.txt', type: 'modified', additions: 1, deletions: 1 }],
              untracked: [{ path: 'README.md', type: 'modified', additions: 1, deletions: 0 }],
            },
          },
        });
      }
      return Promise.resolve({ success: true, data: { diff: '' } });
    });

    (API.sessions.getFileContent as any).mockResolvedValue({ success: true, data: { content: 'x\ny\n' } });

    render(
      <DiffOverlay
        isOpen={true}
        sessionId="s1"
        filePath={null as any}
        target={{ kind: 'working', scope: 'all' } as any}
        onClose={vi.fn()}
        files={[]}
      />
    );

    await waitFor(() => {
      // Only previewable files use WORKTREE first for preview (to show new/modified content).
      expect(API.sessions.getFileContent).toHaveBeenCalledWith('s1', expect.objectContaining({ filePath: 'README.md', ref: 'WORKTREE' }));
      expect(API.sessions.getFileContent).toHaveBeenCalledWith('s1', expect.objectContaining({ filePath: 'logo.png', ref: 'WORKTREE' }));
      expect(API.sessions.getFileContent).not.toHaveBeenCalledWith('s1', expect.objectContaining({ filePath: 'tracked.txt' }));
    });
  });
});
