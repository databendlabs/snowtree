import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { RefreshCw, ChevronDown, GitCommit, Copy, GitPullRequest } from 'lucide-react';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { FileChange, RightPanelProps } from './types';
import type { DiffTarget } from '../../types/diff';

// One Dark colors - Type definition ensures compile-time safety
type ColorScheme = {
  bg: {
    primary: string;
    secondary: string;
    hover: string;
    selected: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    added: string;
    deleted: string;
    modified: string;
    renamed: string;
  };
  accent: string;
  border: string;
};

const colors: ColorScheme = {
  bg: {
    primary: 'var(--st-bg)',
    secondary: 'var(--st-surface)',
    hover: 'var(--st-hover)',
    selected: 'var(--st-selected)',
  },
  text: {
    primary: 'var(--st-text)',
    secondary: 'var(--st-text-muted)',
    muted: 'var(--st-text-faint)',
    added: 'var(--st-success)',
    deleted: 'var(--st-danger)',
    modified: 'var(--st-warning)',
    renamed: 'var(--st-accent)',
  },
  accent: 'var(--st-accent)',
  border: 'var(--st-border-variant)',
};

const stack = {
  line: 'color-mix(in srgb, var(--st-text-faint) 55%, transparent)',
  arrow: 'color-mix(in srgb, var(--st-text-faint) 82%, transparent)',
};

const StackConnector: React.FC<{ accent?: boolean }> = React.memo(({ accent }) => {
  const line = accent ? 'color-mix(in srgb, var(--st-accent) 55%, transparent)' : stack.line;
  const arrow = accent ? 'color-mix(in srgb, var(--st-accent) 82%, transparent)' : stack.arrow;
  const gradId = useMemo(() => `st-stack-grad-${Math.random().toString(16).slice(2)}`, []);

  return (
    <div className="relative flex-1 w-4 st-stack-connector">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 16 28" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={line} stopOpacity="0" />
            <stop offset="0.2" stopColor={line} stopOpacity="0.9" />
            <stop offset="0.8" stopColor={line} stopOpacity="0.9" />
            <stop offset="1" stopColor={line} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M8 0V28"
          stroke={`url(#${gradId})`}
          strokeWidth="1"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M6.25 13.75 L8 15.5 L9.75 13.75"
          fill="none"
          stroke={arrow}
          strokeWidth="1.15"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
});

StackConnector.displayName = 'StackConnector';

// Zed/Git-like ordering: locale-independent, matches git path sorting.
const compareGitPaths = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

const toEpochMs = (timestamp: string) => {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
};

const orderCommitsNewestFirst = (items: Commit[]) => {
  const uncommitted = items.filter((c) => c.id === 0);
  const base = items.filter((c) => c.id === -1);
  const others = items.filter((c) => c.id !== 0 && c.id !== -1);

  const sessionCommits = others.filter((c) => c.id > 0);
  const rest = others.filter((c) => c.id <= 0);

  sessionCommits.sort((a, b) => {
    const dt = toEpochMs(b.timestamp) - toEpochMs(a.timestamp);
    if (dt !== 0) return dt;
    const ha = a.after_commit_hash || '';
    const hb = b.after_commit_hash || '';
    return ha === hb ? 0 : ha < hb ? 1 : -1;
  });

  // Keep "Working Tree" first and "BASE" last.
  return [...uncommitted, ...sessionCommits, ...rest, ...base];
};

interface Commit {
  id: number;
  commit_message: string;
  timestamp: string;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  after_commit_hash: string;
  parent_commit_hash?: string | null;
  author?: string;
}

interface FileItemProps {
  file: FileChange;
  onClick: () => void;
  isSelected: boolean;
  testId?: string;
}

const FileItem: React.FC<FileItemProps> = React.memo(({ file, onClick, isSelected, testId }) => {
  const [isHovered, setIsHovered] = useState(false);

  const getTypeInfo = (type: FileChange['type']) => {
    switch (type) {
      case 'added': return { label: 'A', color: colors.text.added, bg: 'rgba(180, 250, 114, 0.15)' };
      case 'deleted': return { label: 'D', color: colors.text.deleted, bg: 'rgba(255, 130, 114, 0.15)' };
      case 'renamed': return { label: 'R', color: colors.text.renamed, bg: 'rgba(0, 194, 255, 0.15)' };
      default: return { label: 'M', color: colors.text.modified, bg: 'rgba(254, 253, 194, 0.15)' };
    }
  };

  const typeInfo = getTypeInfo(file.type);

  const getBgColor = () => {
    if (isSelected) return colors.bg.selected;
    if (isHovered) return colors.bg.hover;
    return 'transparent';
  };

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors duration-75"
      style={{
        backgroundColor: getBgColor(),
        borderLeft: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent',
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span
          className="font-mono text-[10px] font-semibold px-1 rounded"
          style={{ color: typeInfo.color, backgroundColor: typeInfo.bg }}
        >
          {typeInfo.label}
        </span>
        <span
          className="truncate"
          style={{ color: isSelected || isHovered ? colors.text.primary : colors.text.secondary }}
        >
          {file.path}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] flex-shrink-0 ml-2 font-mono">
        {file.additions > 0 && (
          <span style={{ color: colors.text.added }}>+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span style={{ color: colors.text.deleted }}>-{file.deletions}</span>
        )}
      </div>
    </button>
  );
});

FileItem.displayName = 'FileItem';

type TriState = 'checked' | 'indeterminate' | 'unchecked';

const TriStateCheckbox: React.FC<{
  state: TriState;
  disabled?: boolean;
  onToggle: () => void;
  testId?: string;
  title?: string;
}> = React.memo(({ state, disabled, onToggle, testId, title }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.indeterminate = state === 'indeterminate';
  }, [state]);

  return (
    <input
      ref={inputRef}
      data-testid={testId}
      type="checkbox"
      checked={state === 'checked'}
      disabled={disabled}
      title={title}
      onClick={(e) => e.stopPropagation()}
      onChange={() => onToggle()}
      className="st-focus-ring"
      style={{
        width: 14,
        height: 14,
        accentColor: 'var(--st-accent)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    />
  );
});

TriStateCheckbox.displayName = 'TriStateCheckbox';

interface WorkingFileRowProps {
  file: FileChange;
  stageState: TriState;
  onToggleStage: () => void;
  onClick: () => void;
  isSelected: boolean;
  disabled?: boolean;
  testId?: string;
}

const WorkingFileRow: React.FC<WorkingFileRowProps> = React.memo(({
  file,
  stageState,
  onToggleStage,
  onClick,
  isSelected,
  disabled,
  testId,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const getTypeInfo = (type: FileChange['type']) => {
    switch (type) {
      case 'added': return { label: 'A', color: colors.text.added, bg: 'rgba(180, 250, 114, 0.15)' };
      case 'deleted': return { label: 'D', color: colors.text.deleted, bg: 'rgba(255, 130, 114, 0.15)' };
      case 'renamed': return { label: 'R', color: colors.text.renamed, bg: 'rgba(0, 194, 255, 0.15)' };
      default: return { label: 'M', color: colors.text.modified, bg: 'rgba(254, 253, 194, 0.15)' };
    }
  };

  const typeInfo = getTypeInfo(file.type);
  const bg = isSelected ? colors.bg.selected : isHovered ? colors.bg.hover : 'transparent';

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-75"
      style={{
        backgroundColor: bg,
        borderLeft: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent',
      }}
    >
      <TriStateCheckbox
        state={stageState}
        disabled={disabled}
        onToggle={onToggleStage}
        testId={testId ? `${testId}-checkbox` : undefined}
        title={stageState === 'checked' ? 'Unstage file' : 'Stage file'}
      />

      <span
        className="font-mono text-[10px] font-semibold px-1 rounded"
        style={{ color: typeInfo.color, backgroundColor: typeInfo.bg }}
      >
        {typeInfo.label}
      </span>

      <span
        className="truncate min-w-0 flex-1"
        style={{ color: isSelected || isHovered ? colors.text.primary : colors.text.secondary }}
      >
        {file.path}
      </span>

      <div className="flex items-center gap-1.5 text-[10px] flex-shrink-0 ml-2 font-mono">
        {file.additions > 0 && <span style={{ color: colors.text.added }}>+{file.additions}</span>}
        {file.deletions > 0 && <span style={{ color: colors.text.deleted }}>-{file.deletions}</span>}
      </div>
    </button>
  );
});

WorkingFileRow.displayName = 'WorkingFileRow';

interface CommitItemProps {
  commit: Commit;
  isSelected: boolean;
  badge?: string;
  onClick: () => void;
}

const CommitItem: React.FC<CommitItemProps> = React.memo(({
  commit,
  isSelected,
  badge,
  onClick,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const isUncommitted = commit.id === 0;
  const shortHash = isUncommitted ? '' : commit.after_commit_hash.substring(0, 7);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  };

  const handleCopyHash = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!commit.after_commit_hash) return;

    try {
      await navigator.clipboard.writeText(commit.after_commit_hash);
    } catch (err) {
      console.error('Failed to copy hash:', err);
    }
  }, [commit.after_commit_hash]);

  const getBgColor = () => {
    if (isSelected) return colors.bg.selected;
    if (isHovered) return colors.bg.hover;
    return 'transparent';
  };

  return (
    <div
      className="w-full flex items-stretch gap-2 px-3 py-2 text-xs text-left transition-colors duration-75 select-none"
      style={{
        backgroundColor: getBgColor(),
        borderLeft: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 min-w-0 flex items-start gap-2 outline-none focus:ring-1 focus:ring-blue-500/40 rounded"
        aria-label={`Select commit ${isUncommitted ? 'uncommitted changes' : shortHash}`}
      >
        <div
          className="mt-0.5"
          style={{ color: isUncommitted ? colors.text.modified : colors.text.muted }}
        >
          <GitCommit className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span
              className="flex-1 min-w-0 truncate font-medium"
              style={{ color: isUncommitted ? colors.text.modified : (isSelected || isHovered ? colors.text.primary : colors.text.secondary) }}
            >
              {isUncommitted ? '' : commit.commit_message}
            </span>
            {badge && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded lowercase"
                style={{ backgroundColor: colors.bg.hover, color: colors.text.muted }}
                title={badge}
              >
                {badge.toLowerCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[10px]" style={{ color: colors.text.muted }}>
            {shortHash && (
              <span className="font-mono">{shortHash}</span>
            )}
            <span className="font-mono">{formatTime(commit.timestamp)}</span>
            <span style={{ color: colors.text.added }}>+{commit.stats_additions}</span>
            <span style={{ color: colors.text.deleted }}>-{commit.stats_deletions}</span>
          </div>
        </div>
      </button>

      {shortHash && (
        <button
          type="button"
          onClick={handleCopyHash}
          className="flex-shrink-0 self-start p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring"
          title="Copy commit hash"
        >
          <Copy className="w-3.5 h-3.5" style={{ color: colors.text.muted }} />
        </button>
      )}
    </div>
  );
});

CommitItem.displayName = 'CommitItem';

type WorkingTreeScope = 'all' | 'staged' | 'unstaged' | 'untracked';

export const RightPanel: React.FC<RightPanelProps> = React.memo(({
  session,
  onFileClick,
  onCommitUncommittedChanges,
  isCommitDisabled,
  onCommitClick,
  onPushPR,
  isPushPRDisabled
}) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileScope, setSelectedFileScope] = useState<WorkingTreeScope | 'commit' | null>(null);
  const [isCommitsExpanded, setIsCommitsExpanded] = useState(true);
  const [isChangesExpanded, setIsChangesExpanded] = useState(true);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [selectedIsUncommitted, setSelectedIsUncommitted] = useState(false);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [workingTree, setWorkingTree] = useState<{ staged: FileChange[]; unstaged: FileChange[]; untracked: FileChange[] } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingHistory, setIsRefreshingHistory] = useState(false);
  const [isStageChanging, setIsStageChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const pendingFilesRefreshRef = useRef(false);
  const requestIdRef = useRef(0);
  const historyRequestIdRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const changesRefreshTimerRef = useRef<number | null>(null);
  const selectedCommitHashRef = useRef<string | null>(null);
  const selectedIsUncommittedRef = useRef(false);

  useEffect(() => {
    selectedCommitHashRef.current = selectedCommitHash;
    selectedIsUncommittedRef.current = selectedIsUncommitted;
  }, [selectedCommitHash, selectedIsUncommitted]);

  const selectedTarget = useMemo<DiffTarget | null>(() => {
    if (selectedIsUncommitted) return { kind: 'working', scope: 'all' };
    if (!selectedCommitHash) return null;
    return { kind: 'commit', hash: selectedCommitHash };
  }, [selectedIsUncommitted, selectedCommitHash]);

  // Fetch commits for the session
  const fetchCommits = useCallback(async (selectFirst = false) => {
    if (!session.id) return;
    const requestId = ++historyRequestIdRef.current;
    setIsRefreshingHistory(true);

    try {
      const response = await API.sessions.getExecutions(session.id);
      if (requestId !== historyRequestIdRef.current) return;

      if (response.success && response.data) {
        setError(null);
        const next = orderCommitsNewestFirst(response.data as Commit[]);
        setCommits(next);

        const hasUncommitted = next.some((c) => c.id === 0);
        const firstSessionCommit = next.find((c) => c.id > 0) || null;
        const baseCommit = next.find((c) => c.id === -1) || null;
        if (selectFirst) {
          if (hasUncommitted) {
            setSelectedIsUncommitted(true);
            setSelectedCommitHash(null);
          } else {
            setSelectedIsUncommitted(false);
            setSelectedCommitHash((firstSessionCommit || baseCommit)?.after_commit_hash || null);
          }
          return;
        }

        // Keep selection stable across refreshes (selection is by hash, not list index).
        if (selectedIsUncommittedRef.current) {
          if (!hasUncommitted) {
            setSelectedIsUncommitted(false);
            setSelectedCommitHash((firstSessionCommit || baseCommit)?.after_commit_hash || null);
          }
          return;
        }

        const currentHash = selectedCommitHashRef.current;
        if (currentHash) {
          const stillThere = next.some((c) => c.id !== 0 && c.after_commit_hash === currentHash);
          if (!stillThere) {
            if (hasUncommitted) {
              setSelectedIsUncommitted(true);
              setSelectedCommitHash(null);
            } else {
              setSelectedCommitHash((firstSessionCommit || baseCommit)?.after_commit_hash || null);
            }
          }
        } else if (hasUncommitted) {
          // If we had nothing selected yet, prefer working tree.
          setSelectedIsUncommitted(true);
        } else {
          setSelectedCommitHash((firstSessionCommit || baseCommit)?.after_commit_hash || null);
        }
        return;
      }

      // Failed to load history: surface error and avoid leaking previous session's data.
      const message = response.error || 'Failed to load history';
      setError(message);
      if (selectFirst) {
        setCommits([]);
        setSelectedCommitHash(null);
        setSelectedIsUncommitted(false);
      }
    } catch (err) {
      if (requestId !== historyRequestIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load history';
      setError(message);
      if (selectFirst) {
        setCommits([]);
        setSelectedCommitHash(null);
        setSelectedIsUncommitted(false);
      }
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setIsRefreshingHistory(false);
      }
    }
  }, [session.id]);

  // Fetch files for the selected commit
  const fetchFiles = useCallback(async () => {
    if (!session.id || !selectedTarget) return;

    // If a refresh is requested while a previous fetch is in-flight (e.g. external IDE stages/unstages),
    // queue one more fetch to run after the current request settles.
    if (loadingRef.current) {
      pendingFilesRefreshRef.current = true;
      return;
    }

    const requestId = ++requestIdRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      if (selectedTarget.kind === 'working') {
        const response = await withTimeout(
          API.sessions.getDiff(session.id, { kind: 'working', scope: 'all' }),
          15_000,
          'Load working tree'
        );
        if (requestId !== requestIdRef.current) return;
        if (response.success && response.data) {
          const wt = (response.data as { workingTree?: unknown }).workingTree as
            | { staged: FileChange[]; unstaged: FileChange[]; untracked: FileChange[] }
            | undefined;
          setFiles([]);
          setWorkingTree(wt || { staged: [], unstaged: [], untracked: [] });
          return;
        }
        setFiles([]);
        setWorkingTree({ staged: [], unstaged: [], untracked: [] });
        setError(response.error || 'Failed to load working tree');
        return;
      }

      const response = await withTimeout(
        API.sessions.getDiff(session.id, selectedTarget),
        15_000,
        'Load changes'
      );
      if (requestId !== requestIdRef.current) return;
      if (response.success && response.data) {
        const diffText = response.data.diff || '';
        const parsedFiles: FileChange[] = [];

        const fileMatches = diffText.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
        if (fileMatches) {
          for (const fileContent of fileMatches) {
            const fileNameMatch = fileContent.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
            if (!fileNameMatch) continue;

            const newFileName = fileNameMatch[2] || fileNameMatch[1] || '';

            let type: FileChange['type'] = 'modified';
            if (fileContent.includes('new file mode')) {
              type = 'added';
            } else if (fileContent.includes('deleted file mode')) {
              type = 'deleted';
            } else if (fileContent.includes('rename from')) {
              type = 'renamed';
            }

            const additions = (fileContent.match(/^\+[^+]/gm) || []).length;
            const deletions = (fileContent.match(/^-[^-]/gm) || []).length;

            parsedFiles.push({
              path: newFileName,
              additions,
              deletions,
              type
            });
          }
        }

        if (parsedFiles.length > 0) {
          setFiles(parsedFiles);
          return;
        }

        // Fallback: if diff parsing fails, still render a file list from backend data
        const changedFiles = Array.isArray((response.data as { changedFiles?: unknown }).changedFiles)
          ? ((response.data as { changedFiles?: unknown }).changedFiles as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        setFiles(changedFiles.map((path) => ({ path, additions: 0, deletions: 0, type: 'modified' })));
      } else {
        const message = response.error || 'Failed to load changes';
        const isStaleRefError =
          selectedTarget.kind === 'commit' &&
          /commit not found|bad object|unknown revision|invalid object name|ambiguous argument/i.test(message);
        if (isStaleRefError) {
          // A commit can disappear after rebase/force-push; refresh History and keep UI clean.
          fetchCommits(false);
          return;
        }
        setError(message);
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load changes');
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        loadingRef.current = false;
      }

      if (!loadingRef.current && pendingFilesRefreshRef.current) {
        pendingFilesRefreshRef.current = false;
        window.setTimeout(() => {
          void fetchFiles();
        }, 0);
      }
    }
  }, [session.id, selectedTarget, fetchCommits]);

  // Fetch commits when session changes
  useEffect(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setCommits([]);
    setSelectedCommitHash(null);
    setSelectedIsUncommitted(false);
    setFiles([]);
    setWorkingTree(null);
    setSelectedFileScope(null);
    setError(null);
    requestIdRef.current++;
    loadingRef.current = false;
    setIsLoading(false);
    if (session.id) {
      fetchCommits(true);
    }
  }, [session.id, fetchCommits]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (changesRefreshTimerRef.current) {
        window.clearTimeout(changesRefreshTimerRef.current);
        changesRefreshTimerRef.current = null;
      }
    };
  }, []);

  // Fetch files when selected commit changes
  useEffect(() => {
    if (selectedTarget) {
      fetchFiles();
    }
  }, [selectedTarget, fetchFiles]);

  // NOTE: Do not refresh History from the global git-status event; it can create
  // a feedback loop (git commands update index -> watcher triggers refresh -> UI refreshes again).

  const scheduleRefresh = useCallback(() => {
    if (!session.id) return;
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      fetchCommits(false);
      if (selectedIsUncommitted) {
        fetchFiles();
      }
    }, 200);
  }, [session.id, fetchCommits, fetchFiles, selectedIsUncommitted]);

  const scheduleChangesRefresh = useCallback(() => {
    if (!session.id) return;
    if (changesRefreshTimerRef.current) {
      window.clearTimeout(changesRefreshTimerRef.current);
    }
    changesRefreshTimerRef.current = window.setTimeout(() => {
      changesRefreshTimerRef.current = null;
      if (selectedIsUncommittedRef.current) {
        fetchFiles();
      }
    }, 80);
  }, [session.id, fetchFiles]);

  // Refresh once after a run completes (running -> waiting/error/etc).
  const prevStatusRef = useRef(session.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = session.status;
    if (!session.id) return;
    const wasRunning = prev === 'running' || prev === 'initializing';
    const nowRunning = session.status === 'running' || session.status === 'initializing';
    if (wasRunning && !nowRunning) {
      scheduleRefresh();
    }
  }, [session.id, session.status, scheduleRefresh]);

  // Refresh when git state actually changes (not on every poll).
  // Only refresh on stable, state-changing signals. `state`/`lastChecked` can churn even when nothing
  // meaningful changed (e.g. transient errors or polling), which would cause refresh loops.
  const gitSig = [
    String(session.gitStatus?.state ?? ''),
    String(Number(session.gitStatus?.ahead ?? 0)),
    String(Number(session.gitStatus?.behind ?? 0)),
    String(Number(session.gitStatus?.filesChanged ?? 0)),
    String(Number(session.gitStatus?.additions ?? 0)),
    String(Number(session.gitStatus?.deletions ?? 0)),
    String(Boolean(session.gitStatus?.hasUncommittedChanges)),
    String(Boolean(session.gitStatus?.hasUntrackedFiles)),
  ].join('|');
  const prevGitSigRef = useRef(gitSig);
  useEffect(() => {
    if (!session.id) return;
    if (prevGitSigRef.current === gitSig) return;
    prevGitSigRef.current = gitSig;
    scheduleRefresh();
  }, [session.id, gitSig, scheduleRefresh]);

  // Zed-style: refresh changes whenever git status is updated for this session.
  // This covers staging operations that don't change the "has changes" booleans.
  useEffect(() => {
    if (!session.id) return;
    const unsub = window.electronAPI?.events?.onGitStatusUpdated?.((data) => {
      if (!data || data.sessionId !== session.id) return;
      scheduleChangesRefresh();
    });
    return () => { if (unsub) unsub(); };
  }, [session.id, scheduleChangesRefresh]);

  // Refresh after agent-run git commands that can change History/WT state.
  useEffect(() => {
    if (!session.id) return;
    const unsub = window.electronAPI?.events?.onTimelineEvent?.((data) => {
      if (!data || data.sessionId !== session.id) return;
      const e = data.event as { kind?: unknown; status?: unknown; command?: unknown; meta?: unknown } | undefined;
      if (!e) return;
      if (e.kind !== 'git.command') return;
      if (e.status !== 'finished' && e.status !== 'failed') return;
      const meta = (e.meta || {}) as Record<string, unknown>;
      const source = typeof meta.source === 'string' ? meta.source : '';
      if (source !== 'agent' && source !== 'gitStaging') return;
      const cmd = typeof e.command === 'string' ? e.command.trim() : '';
      if (!cmd) return;
      if (!/^(git|gh)\b/.test(cmd)) return;

      // Only refresh for state-changing commands (avoid status/diff loops).
      const affectsHistory = /^(git\s+(add|commit|reset|checkout|switch|merge|rebase|cherry-pick|revert|stash|am|apply|rm|mv|tag)\b|gh\s+pr\s+create\b)/.test(cmd);
      if (!affectsHistory) return;
      scheduleRefresh();
    });
    return () => { if (unsub) unsub(); };
  }, [session.id, scheduleRefresh]);

  const handleCommitFileClick = useCallback((file: FileChange) => {
    setSelectedFile(file.path);
    setSelectedFileScope('commit');
    if (!selectedTarget) return;
    onFileClick(file.path, selectedTarget, files);
  }, [onFileClick, selectedTarget, files]);

  const handleWorkingFileClick = useCallback((scope: WorkingTreeScope, file: FileChange, groupFiles: FileChange[]) => {
    setSelectedFile(file.path);
    setSelectedFileScope(scope);
    onFileClick(file.path, { kind: 'working', scope }, groupFiles);
  }, [onFileClick]);

  const handleCommitSelect = useCallback((commit: Commit) => {
    setSelectedFile(null);
    setSelectedFileScope(null);
    if (commit.id === 0) {
      setSelectedIsUncommitted(true);
      setSelectedCommitHash(null);
      onCommitClick?.({ kind: 'working', scope: 'all' }, []);
      return;
    }
    setSelectedIsUncommitted(false);
    setSelectedCommitHash(commit.after_commit_hash);
    onCommitClick?.({ kind: 'commit', hash: commit.after_commit_hash }, []);
  }, [onCommitClick]);

  const handleRefresh = useCallback(() => {
    fetchCommits(false);
    fetchFiles();
  }, [fetchCommits, fetchFiles]);

  const handleChangeAllStage = useCallback(
    async (stage: boolean) => {
      if (!session.id || isStageChanging) return;
      setIsStageChanging(true);
      const prev = workingTree;
      try {
        await API.sessions.changeAllStage(session.id, { stage });
      } catch (err) {
        if (prev) setWorkingTree(prev);
        console.error('[RightPanel] Failed to change stage state', err);
      } finally {
        setIsStageChanging(false);
      }
    },
    [isStageChanging, session.id, workingTree]
  );

  const handleChangeFileStage = useCallback(
    async (filePath: string, stage: boolean) => {
      if (!session.id || isStageChanging) return;
      setIsStageChanging(true);
      try {
        await API.sessions.changeFileStage(session.id, { filePath, stage });
      } catch (err) {
        console.error('[RightPanel] Failed to change file stage state', err);
      } finally {
        setIsStageChanging(false);
        scheduleChangesRefresh();
      }
    },
    [isStageChanging, scheduleChangesRefresh, session.id]
  );

  const trackedFiles = useMemo(() => {
    if (!workingTree) return [];
    const map = new Map<string, { staged?: FileChange; unstaged?: FileChange }>();
    for (const f of workingTree.staged) {
      map.set(f.path, { ...(map.get(f.path) || {}), staged: f });
    }
    for (const f of workingTree.unstaged) {
      map.set(f.path, { ...(map.get(f.path) || {}), unstaged: f });
    }

    const merged: Array<{ file: FileChange; stageState: TriState }> = [];
    for (const [path, entry] of map.entries()) {
      const staged = entry.staged;
      const unstaged = entry.unstaged;
      const type = unstaged?.type ?? staged?.type ?? 'modified';
      const additions = (staged?.additions || 0) + (unstaged?.additions || 0);
      const deletions = (staged?.deletions || 0) + (unstaged?.deletions || 0);
      const stageState: TriState = staged && unstaged ? 'indeterminate' : staged ? 'checked' : 'unchecked';
      const isNew = Boolean(staged?.isNew);
      merged.push({ file: { path, type, additions, deletions, isNew }, stageState });
    }

    merged.sort((a, b) => compareGitPaths(a.file.path, b.file.path));
    return merged;
  }, [workingTree]);

  const trackedList = useMemo(() => trackedFiles.filter((x) => !x.file.isNew), [trackedFiles]);

  const untrackedList = useMemo(() => {
    if (!workingTree) return [];

    const fromMap = trackedFiles.filter((x) => x.file.isNew);
    const fromStatus = workingTree.untracked.map((f) => ({ file: f, stageState: 'unchecked' as TriState }));

    const byPath = new Map<string, { file: FileChange; stageState: TriState }>();
    for (const x of [...fromStatus, ...fromMap]) {
      byPath.set(x.file.path, x);
    }

    const merged = Array.from(byPath.values()).sort((a, b) => compareGitPaths(a.file.path, b.file.path));
    return merged;
  }, [trackedFiles, workingTree]);

  const workingFilesForDiffOverlay = useMemo(() => {
    const tracked = trackedList.map((x) => x.file);
    const untracked = untrackedList.map((x) => x.file);
    return [...tracked, ...untracked];
  }, [trackedList, untrackedList]);

  const totalCommits = commits.length;
  const totalChanges = selectedIsUncommitted
    ? (workingTree?.staged.length || 0) + (workingTree?.unstaged.length || 0) + (workingTree?.untracked.length || 0)
    : files.length;
  const uncommitted = commits.find((c) => c.id === 0) || null;
  const baseCommit = commits.find((c) => c.id === -1) || null;
  const sessionCommits = commits.filter((c) => c.id > 0);
  const headHash = sessionCommits[0]?.after_commit_hash || null;
  const selectedCommit = selectedIsUncommitted
    ? commits.find((c) => c.id === 0)
    : selectedCommitHash
      ? commits.find((c) => c.id !== 0 && c.after_commit_hash === selectedCommitHash)
      : null;

  const stagedFileCount = workingTree?.staged.length || 0;
  const canStageAll = Boolean((workingTree?.unstaged.length || 0) + (workingTree?.untracked.length || 0));
  const canUnstageAll = Boolean(workingTree?.staged.length || 0);

  return (
    <div
      className="h-full flex flex-col"
      style={{
        backgroundColor: colors.bg.primary,
        borderLeft: `1px solid ${colors.border}`,
      }}
    >
      {/* Commits section */}
      <div
        className="flex-shrink-0"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <div style={{ backgroundColor: colors.bg.secondary }}>
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-xs font-medium" style={{ color: colors.text.secondary }}>
              Sync commits to Remote PR
            </div>
            <div className="flex items-center gap-1">
              {onPushPR && (
                <button
                  type="button"
                  onClick={onPushPR}
                  disabled={isPushPRDisabled || isLoading || isRefreshingHistory}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                  style={{ color: colors.accent }}
                  title="Sync committed commits to remote PR"
                >
                  <GitPullRequest className="w-3 h-3" />
                  Remote PR
                </button>
              )}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isLoading || isRefreshingHistory}
                className="p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                title="Refresh"
              >
                <RefreshCw
                  className={`w-3 h-3 ${isLoading || isRefreshingHistory ? 'animate-spin' : ''}`}
                  style={{ color: colors.text.muted }}
                />
              </button>
            </div>
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${colors.border}` }} />

        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ backgroundColor: colors.bg.secondary }}
        >
          <button
            type="button"
            onClick={() => setIsCommitsExpanded(!isCommitsExpanded)}
            className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
            style={{ color: colors.text.secondary }}
          >
            <ChevronDown
              className={`w-3 h-3 transition-transform ${isCommitsExpanded ? '' : '-rotate-90'}`}
              style={{ color: colors.text.muted }}
            />
            <span>Commits</span>
          </button>
        </div>

        <div style={{ borderTop: `1px solid ${colors.border}` }} />

        {isCommitsExpanded && (
          <div className="max-h-48 overflow-y-auto">
            {totalCommits === 0 ? (
              <div
                className="flex items-center justify-center py-6 text-xs"
                style={{ color: colors.text.muted }}
              >
                No commits
              </div>
            ) : (
              <div>
                {uncommitted && (
                  <div className="flex">
                    <div className="w-5 flex flex-col items-center pt-3">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: selectedIsUncommitted ? colors.accent : colors.text.modified,
                          boxShadow: selectedIsUncommitted ? `0 0 0 3px color-mix(in srgb, ${colors.accent} 18%, transparent)` : 'none',
                        }}
                      />
                      {(sessionCommits.length > 0 || baseCommit) && (
                        <StackConnector accent={selectedIsUncommitted} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <CommitItem
                        commit={uncommitted}
                        isSelected={selectedIsUncommitted}
                        onClick={() => handleCommitSelect(uncommitted)}
                      />
                    </div>
                  </div>
                )}

                {sessionCommits.map((commit, idx) => {
                  const isSelected = selectedCommitHash === commit.after_commit_hash && !selectedIsUncommitted;
                  const isLastSession = idx === sessionCommits.length - 1;
                  const isHead = headHash === commit.after_commit_hash;
                  return (
                    <div key={commit.after_commit_hash} className="flex">
                      <div className="w-5 flex flex-col items-center pt-3">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{
                            backgroundColor: isSelected ? colors.accent : colors.text.muted,
                            boxShadow: isSelected ? `0 0 0 3px color-mix(in srgb, ${colors.accent} 18%, transparent)` : 'none',
                          }}
                        />
                        {(!isLastSession || baseCommit) && (
                          <StackConnector accent={isSelected} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <CommitItem
                          commit={commit}
                          isSelected={isSelected}
                          badge={isHead ? 'HEAD' : undefined}
                          onClick={() => handleCommitSelect(commit)}
                        />
                      </div>
                    </div>
                  );
                })}

                {baseCommit && (
                  <div className="flex">
                    <div className="w-5 flex flex-col items-center pt-3">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: 'transparent',
                          border: `1px solid ${colors.border}`,
                        }}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <CommitItem
                        commit={baseCommit}
                        isSelected={selectedCommitHash === baseCommit.after_commit_hash && !selectedIsUncommitted}
                        badge="BASE"
                        onClick={() => handleCommitSelect(baseCommit)}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ borderTop: `1px solid ${colors.border}` }} />

        <div style={{ backgroundColor: colors.bg.secondary }}>
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-xs font-medium" style={{ color: colors.text.secondary }}>
              Commit staged
            </div>
            <button
              type="button"
              onClick={() => onCommitUncommittedChanges?.()}
              disabled={Boolean(isCommitDisabled) || stagedFileCount === 0}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
              style={{ color: colors.accent }}
              title="Commit staged only"
            >
              <GitCommit className="w-3 h-3" />
              AI Commit
            </button>
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${colors.border}` }} />
      </div>

      {/* Changes section */}
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{
            backgroundColor: colors.bg.secondary,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <button
            type="button"
            onClick={() => setIsChangesExpanded(!isChangesExpanded)}
            className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
            style={{ color: colors.text.secondary }}
          >
            <ChevronDown
              className={`w-3 h-3 transition-transform ${isChangesExpanded ? '' : '-rotate-90'}`}
              style={{ color: colors.text.muted }}
            />
            <span>Changes</span>
            {totalChanges > 0 && (
              <span
                className="ml-1 px-1.5 py-0.5 text-[10px] rounded font-mono"
                style={{ backgroundColor: colors.bg.hover, color: colors.text.muted }}
              >
                {totalChanges}
              </span>
            )}
          </button>
          <div className="flex items-center gap-2">
            {selectedIsUncommitted && totalChanges > 0 && (
              <div className="flex items-center gap-2">
                {canStageAll ? (
                  <button
                    type="button"
                    data-testid="right-panel-stage-all"
                    disabled={isLoading || isStageChanging}
                    onClick={() => {
                      if (workingTree) {
                        const staged = workingTree.staged;
                        const unstaged = workingTree.unstaged;
                        const untracked = workingTree.untracked.map((f) => ({ ...f, isNew: true }));
                        setWorkingTree({
                          staged: [...staged, ...unstaged, ...untracked],
                          unstaged: [],
                          untracked: [],
                        });
                      }
                      void handleChangeAllStage(true);
                    }}
                    className="px-2.5 py-1 rounded text-[10px] font-medium transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      color: colors.text.primary,
                      backgroundColor: colors.bg.hover,
                      border: `1px solid ${colors.border}`,
                    }}
                    title="Stage all"
                  >
                    Stage All
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="right-panel-unstage-all"
                    disabled={isLoading || isStageChanging || !canUnstageAll}
                    onClick={() => {
                      if (!canUnstageAll) return;
                      if (workingTree) {
                        const newFiles = workingTree.staged
                          .filter((f) => Boolean(f.isNew))
                          .map(({ isNew, ...rest }) => rest);
                        const others = workingTree.staged.filter((f) => !Boolean(f.isNew));
                        setWorkingTree({
                          staged: [],
                          unstaged: [...workingTree.unstaged, ...others],
                          untracked: [...workingTree.untracked, ...newFiles],
                        });
                      }
                      void handleChangeAllStage(false);
                    }}
                    className="px-2.5 py-1 rounded text-[10px] font-medium transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      color: colors.text.primary,
                      backgroundColor: colors.bg.hover,
                      border: `1px solid ${colors.border}`,
                    }}
                    title="Unstage all"
                  >
                    Unstage All
                  </button>
                )}
              </div>
            )}

            {selectedCommit && (
              <span
                className="text-[10px] font-mono truncate max-w-[100px]"
                style={{ color: selectedCommit.id === 0 ? colors.text.modified : colors.accent }}
                title={selectedCommit.commit_message}
              >
                {selectedCommit.id === 0 ? '' : selectedCommit.after_commit_hash.substring(0, 7)}
              </span>
            )}
          </div>
        </div>

        <div
          className={`flex-1 overflow-y-auto transition-all origin-top ${
            isChangesExpanded ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0 h-0'
          }`}
          style={{ transitionDuration: '150ms' }}
        >
          {isLoading && (selectedIsUncommitted ? !workingTree : files.length === 0) ? (
            <div
              className="flex flex-col items-center justify-center py-8 gap-2"
              style={{ color: colors.text.muted }}
            >
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-6 gap-2">
              <span className="text-xs" style={{ color: colors.text.deleted }}>{error}</span>
              <button
                type="button"
                onClick={handleRefresh}
                className="text-xs px-3 py-1 rounded transition-all duration-75 st-hoverable st-focus-ring"
                style={{ backgroundColor: colors.bg.hover, color: colors.text.secondary }}
              >
                Retry
              </button>
            </div>
          ) : selectedIsUncommitted ? (
            (!workingTree || (workingTree.staged.length + workingTree.unstaged.length + workingTree.untracked.length) === 0) ? (
              <div
                className="flex items-center justify-center py-8 text-xs"
                style={{ color: colors.text.muted }}
              >
                {!selectedTarget ? 'Select a commit' : 'Working tree clean'}
              </div>
            ) : (
              <div className="py-2">
                {trackedList.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="px-3 pb-1 text-[10px] font-semibold tracking-wider uppercase"
                      style={{ color: colors.text.muted }}
                    >
                      Tracked
                    </div>
                    <div>
                      {trackedList.map(({ file, stageState }) => (
                        <WorkingFileRow
                          key={`tracked:${file.path}`}
                          file={file}
                          stageState={stageState}
                          disabled={isLoading || isStageChanging}
                          onToggleStage={() => {
                            const stage = stageState !== 'checked';
                            void handleChangeFileStage(file.path, stage);
                          }}
                          onClick={() => handleWorkingFileClick('all', file, workingFilesForDiffOverlay)}
                          isSelected={selectedFile === file.path && selectedFileScope === 'all'}
                          testId={`right-panel-file-tracked-${file.path}`}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {untrackedList.length > 0 && (
                  <div className="mb-2">
                    <div
                      className="px-3 pb-1 text-[10px] font-semibold tracking-wider uppercase"
                      style={{ color: colors.text.muted }}
                    >
                      Untracked
                    </div>
                    <div>
                      {untrackedList.map(({ file, stageState }) => (
                        <WorkingFileRow
                          key={`untracked:${file.path}`}
                          file={file}
                          stageState={stageState}
                          disabled={isLoading || isStageChanging}
                          onToggleStage={() => {
                            const stage = stageState !== 'checked';
                            void handleChangeFileStage(file.path, stage);
                          }}
                          onClick={() => handleWorkingFileClick('untracked', file, workingFilesForDiffOverlay)}
                          isSelected={selectedFile === file.path && selectedFileScope === 'untracked'}
                          testId={`right-panel-file-untracked-${file.path}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          ) : files.length === 0 ? (
            <div
              className="flex items-center justify-center py-8 text-xs"
              style={{ color: colors.text.muted }}
            >
              {!selectedTarget ? 'Select a commit' : 'No changes'}
            </div>
          ) : (
            <div className="py-1">
              {files.map((file) => (
                <FileItem
                  key={file.path}
                  file={file}
                  onClick={() => handleCommitFileClick(file)}
                  isSelected={selectedFile === file.path && selectedFileScope === 'commit'}
                  testId={`right-panel-file-commit-${file.path}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

RightPanel.displayName = 'RightPanel';

export default RightPanel;
