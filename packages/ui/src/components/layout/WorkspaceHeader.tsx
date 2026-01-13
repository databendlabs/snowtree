import React, { useMemo, useState } from 'react';
import { GitBranch, Copy, Check, Sun, Moon } from 'lucide-react';
import type { WorkspaceHeaderProps } from './types';
import { useThemeStore } from '../../stores/themeStore';

// Extract repository name from worktree path
// e.g., /Users/bohu/github/blog-hexo/worktrees/montreal-wphnwwp9 → blog-hexo
function getRepositoryName(worktreePath?: string): string | null {
  if (!worktreePath) return null;

  // Split path and find the repository directory
  // Worktree path pattern: <repo-path>/worktrees/<worktree-name>
  const parts = worktreePath.split('/');
  const worktreesIndex = parts.lastIndexOf('worktrees');

  if (worktreesIndex > 0) {
    // Get the directory before 'worktrees'
    return parts[worktreesIndex - 1];
  }

  return null;
}

const StatusDot: React.FC<{ status: string }> = React.memo(({ status }) => {
  const getConfig = (s: string) => {
    switch (s) {
      case 'running':
      case 'initializing':
        return { color: 'var(--st-success)', pulse: true };
      case 'waiting':
        return { color: 'var(--st-warning)', pulse: true };
      case 'error':
        return { color: 'var(--st-danger)', pulse: false };
      default:
        return { color: 'var(--st-text-faint)', pulse: false };
    }
  };

  const config = getConfig(status);

  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${config.pulse ? 'animate-pulse' : ''}`}
      style={{ backgroundColor: config.color }}
      title={status}
    />
  );
});

StatusDot.displayName = 'StatusDot';

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = React.memo(({
  session,
  branchName
}) => {
  const repositoryName = useMemo(() => {
    return getRepositoryName(session.worktreePath) || session.name;
  }, [session.worktreePath, session.name]);

  const [copied, setCopied] = useState(false);
  const { theme, toggleTheme } = useThemeStore();

  const handleCopyPath = async () => {
    if (session.worktreePath) {
      await navigator.clipboard.writeText(session.worktreePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="flex items-center justify-between px-3 py-2 st-surface border-b st-hairline"
      data-testid="workspace-header"
      style={{
        ['WebkitAppRegion' as never]: 'drag',
        userSelect: 'none',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* Repository name - primary */}
        <h1 className="text-[13px] font-medium truncate" style={{ color: 'var(--st-text)' }} data-testid="session-name">
          {repositoryName}
        </h1>

        {/* Status dot */}
        <span data-testid="session-status" className="inline-flex">
          <StatusDot status={session.status} />
        </span>

        {/* Branch */}
        <div
          className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded"
          style={{
            color: 'var(--st-text-faint)',
            backgroundColor: 'var(--st-hover)',
          }}
        >
          <GitBranch className="w-3 h-3" />
          <span className="truncate max-w-[120px]" data-testid="branch-name">{branchName || 'main'}</span>
        </div>
      </div>

      <div className="flex items-center gap-1" style={{ ['WebkitAppRegion' as never]: 'no-drag' }}>
        <button
          type="button"
          onClick={handleCopyPath}
          className="p-1.5 rounded st-hoverable st-focus-ring"
          title={copied ? 'Copied!' : 'Copy workspace path'}
        >
          {copied ? (
            <Check className="w-3.5 h-3.5" style={{ color: 'var(--st-success)' }} />
          ) : (
            <Copy className="w-3.5 h-3.5" style={{ color: 'var(--st-text-muted)' }} />
          )}
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          className="p-1.5 rounded st-hoverable st-focus-ring"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'light' ? (
            <Moon className="w-3.5 h-3.5" style={{ color: 'var(--st-text-muted)' }} />
          ) : (
            <Sun className="w-3.5 h-3.5" style={{ color: 'var(--st-text-muted)' }} />
          )}
        </button>
      </div>
    </div>
  );
});

WorkspaceHeader.displayName = 'WorkspaceHeader';

export default WorkspaceHeader;
