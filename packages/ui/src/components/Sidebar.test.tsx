import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { Sidebar } from './Sidebar';

vi.mock('../utils/timestampUtils', () => ({
  formatDistanceToNow: () => '12 hours ago',
}));

vi.mock('../stores/errorStore', () => ({
  useErrorStore: () => ({ showError: vi.fn() }),
}));

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    sessions: [
      {
        id: 's1',
        status: 'idle',
        worktreePath: '/tmp/repo/readme-long-branch-name-that-should-not-truncate-so-much',
      },
    ],
    activeSessionId: 's1',
    setActiveSession: vi.fn(),
    sessionTodos: {},
  }),
}));

vi.mock('../utils/api', () => ({
  API: {
    projects: {
      getAll: vi.fn(),
      getWorktrees: vi.fn(),
    },
    dialog: {
      openDirectory: vi.fn(),
    },
    sessions: {
      openWorktree: vi.fn(),
    },
  },
}));

import { API } from '../utils/api';

describe('Sidebar worktree row layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (API.projects.getAll as any).mockResolvedValue({
      success: true,
      data: [{ id: 1, name: 'databend', path: '/tmp/repo', active: true }],
    });
    (API.projects.getWorktrees as any).mockResolvedValue({
      success: true,
      data: [
        {
          path: '/tmp/repo/readme-long-branch-name-that-should-not-truncate-so-much',
          head: 'abcdef',
          branch: 'readme-long-branch-name-that-should-not-truncate-so-much',
          detached: false,
          locked: false,
          prunable: false,
          isMain: false,
          hasChanges: true,
          createdAt: null,
          lastCommitAt: '2026-01-10T00:00:00.000Z',
          additions: 11,
          deletions: 14,
          filesChanged: 3,
        },
      ],
    });
  });

  it('moves relative time to a second line to give the name more room', async () => {
    render(<Sidebar />);
    await waitFor(() => expect(API.projects.getWorktrees).toHaveBeenCalled());

    const item = await screen.findByTestId('worktree-item');
    const name = within(item).getByTestId('worktree-name');
    const time = within(item).getByTestId('worktree-relative-time');

    expect(name).toHaveTextContent('readme-long-branch-name-that-should-not-truncate-so-much');
    expect(time).toHaveTextContent('12 hours ago');

    // Regression guard: time should not be part of the name node (keeps first line compact).
    expect(name.textContent).not.toContain('hours ago');

    // Diff counters still render and are not affected by moving time.
    expect(screen.getByText('+11')).toBeInTheDocument();
    expect(screen.getByText('-14')).toBeInTheDocument();
  });
});
