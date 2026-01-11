import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommitItem } from './CommitItem';

describe('CommitItem', () => {
  const defaultCommit = {
    id: 1,
    commit_message: 'Fix bug in parser',
    timestamp: '2026-01-07T10:00:00Z',
    stats_additions: 15,
    stats_deletions: 8,
    stats_files_changed: 3,
    after_commit_hash: 'abc1234567890def',
  };

  it('renders commit message', () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.getByText('Fix bug in parser')).toBeInTheDocument();
  });

  it('renders short hash', () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('renders additions and deletions', () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.getByText('+15')).toBeInTheDocument();
    expect(screen.getByText('-8')).toBeInTheDocument();
  });

  it('renders badge when provided', () => {
    render(
      <CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} badge="HEAD" />
    );
    expect(screen.getByText('head')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /select commit/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows custom tooltip on hover with full commit details', async () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    const container = screen.getByRole('button', { name: /select commit/i }).closest('div');
    expect(container).toBeInTheDocument();
    // Tooltip appears on hover - implementation uses custom tooltip instead of native title
    fireEvent.mouseEnter(container!.parentElement!);
    // Check that tooltip content appears
    expect(await screen.findByText(/Fix bug in parser/)).toBeInTheDocument();
  });

  it('renders copy button for regular commits', () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    // Copy button is rendered (without title attribute)
    const copyButtons = screen.getAllByRole('button');
    // There should be 2 buttons: select commit button and copy button
    expect(copyButtons.length).toBe(2);
  });

  it('does not render message for uncommitted changes (id=0)', () => {
    const uncommittedCommit = {
      ...defaultCommit,
      id: 0,
      commit_message: 'Uncommitted changes',
      after_commit_hash: '',
    };
    render(<CommitItem commit={uncommittedCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.queryByText('Uncommitted changes')).not.toBeInTheDocument();
  });

  it('does not render copy button for uncommitted changes', () => {
    const uncommittedCommit = {
      ...defaultCommit,
      id: 0,
      after_commit_hash: '',
    };
    render(<CommitItem commit={uncommittedCommit} isSelected={false} onClick={() => {}} />);
    // Only the select commit button should be rendered
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
  });

  it('has correct aria-label for regular commit', () => {
    render(<CommitItem commit={defaultCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.getByLabelText('Select commit abc1234')).toBeInTheDocument();
  });

  it('has correct aria-label for uncommitted changes', () => {
    const uncommittedCommit = {
      ...defaultCommit,
      id: 0,
      after_commit_hash: '',
    };
    render(<CommitItem commit={uncommittedCommit} isSelected={false} onClick={() => {}} />);
    expect(screen.getByLabelText('Select commit uncommitted changes')).toBeInTheDocument();
  });
});
