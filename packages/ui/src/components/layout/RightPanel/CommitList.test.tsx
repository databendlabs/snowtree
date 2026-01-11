import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommitList } from './CommitList';

describe('CommitList', () => {
  const baseCommit = {
    id: -1,
    commit_message: 'base',
    timestamp: '2025-12-31T23:59:59Z',
    stats_additions: 0,
    stats_deletions: 0,
    stats_files_changed: 0,
    after_commit_hash: 'base1234567890',
  };

  const sessionCommit1 = {
    id: 1,
    commit_message: 'older commit',
    timestamp: '2026-01-01T00:00:01Z',
    stats_additions: 1,
    stats_deletions: 1,
    stats_files_changed: 1,
    after_commit_hash: '1111111111111111',
  };

  const sessionCommit2 = {
    id: 2,
    commit_message: 'newer commit',
    timestamp: '2026-01-01T00:00:02Z',
    stats_additions: 2,
    stats_deletions: 0,
    stats_files_changed: 1,
    after_commit_hash: '2222222222222222',
  };

  const uncommittedCommit = {
    id: 0,
    commit_message: 'Uncommitted changes',
    timestamp: new Date().toISOString(),
    stats_additions: 0,
    stats_deletions: 0,
    stats_files_changed: 0,
    after_commit_hash: '',
  };

  it('renders "No commits" when commits array is empty', () => {
    render(
      <CommitList
        commits={[]}
        selectedCommitHash={null}
        isWorkingTreeSelected={false}
        onCommitSelect={() => {}}
      />
    );
    expect(screen.getByText('No commits')).toBeInTheDocument();
  });

  it('renders uncommitted changes first', () => {
    const commits = [uncommittedCommit, sessionCommit1];
    render(
      <CommitList
        commits={commits}
        selectedCommitHash={null}
        isWorkingTreeSelected={true}
        onCommitSelect={() => {}}
      />
    );
    const buttons = screen.getAllByRole('button', { name: /select commit/i });
    expect(buttons[0]).toHaveAttribute('aria-label', 'Select commit uncommitted changes');
  });

  it('renders base commit', () => {
    render(
      <CommitList
        commits={[baseCommit]}
        selectedCommitHash={null}
        isWorkingTreeSelected={false}
        onCommitSelect={() => {}}
      />
    );
    const baseButton = screen.getByLabelText('Select commit base123');
    expect(baseButton).toBeInTheDocument();
  });

  it('renders session commits without badges', () => {
    const commits = [sessionCommit2, sessionCommit1];
    render(
      <CommitList
        commits={commits}
        selectedCommitHash={null}
        isWorkingTreeSelected={false}
        onCommitSelect={() => {}}
      />
    );
    // Session commits should render with their commit messages
    expect(screen.getByText('newer commit')).toBeInTheDocument();
    expect(screen.getByText('older commit')).toBeInTheDocument();
  });

  it('calls onCommitSelect when commit is clicked', () => {
    const onCommitSelect = vi.fn();
    render(
      <CommitList
        commits={[sessionCommit1]}
        selectedCommitHash={null}
        isWorkingTreeSelected={false}
        onCommitSelect={onCommitSelect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /select commit/i }));
    expect(onCommitSelect).toHaveBeenCalledWith(sessionCommit1);
  });

  it('renders all commit types in correct order', () => {
    const commits = [uncommittedCommit, sessionCommit2, sessionCommit1, baseCommit];
    render(
      <CommitList
        commits={commits}
        selectedCommitHash={null}
        isWorkingTreeSelected={false}
        onCommitSelect={() => {}}
      />
    );
    const buttons = screen.getAllByRole('button', { name: /select commit/i });
    expect(buttons).toHaveLength(4);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Select commit uncommitted changes');
    expect(buttons[1]).toHaveAttribute('aria-label', 'Select commit 2222222');
    expect(buttons[2]).toHaveAttribute('aria-label', 'Select commit 1111111');
    expect(buttons[3]).toHaveAttribute('aria-label', 'Select commit base123');
  });
});
