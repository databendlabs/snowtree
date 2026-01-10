import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, ArrowLeft, RefreshCw, Copy, Check, ChevronUp, ChevronDown, Plus, Minus } from 'lucide-react';
import { ZedDiffViewer, type ZedDiffViewerHandle } from '../panels/diff/ZedDiffViewer';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { DiffOverlayProps } from './types';

const border = 'color-mix(in srgb, var(--st-border) 70%, transparent)';
const hoverBg = 'color-mix(in srgb, var(--st-hover) 42%, transparent)';

const ToolbarButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'icon';
}> = ({ onClick, disabled, title, children, variant = 'default' }) => {
  const baseStyles = 'flex items-center gap-1.5 rounded st-focus-ring transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const variantStyles = {
    default: 'px-2.5 py-1 text-xs font-medium text-[color:var(--st-text-muted)] hover:text-[color:var(--st-text)] hover:bg-[color:var(--st-hover)]',
    primary: 'px-3 py-1.5 text-xs font-medium bg-[color:var(--st-accent)] text-black hover:brightness-110',
    icon: 'p-1.5 text-[color:var(--st-text-faint)] hover:text-[color:var(--st-text)] hover:bg-[color:var(--st-hover)]',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${baseStyles} ${variantStyles[variant]}`}
      title={title}
    >
      {children}
    </button>
  );
};

const ToolbarDivider: React.FC = () => (
  <div className="h-4 w-px mx-1" style={{ backgroundColor: border }} />
);

const IconButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  variant?: 'default' | 'accent';
}> = ({ onClick, disabled, title, children, variant = 'default' }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={[
      'st-icon-button st-focus-ring disabled:opacity-40 disabled:cursor-not-allowed',
      variant === 'accent'
        ? 'text-[color:var(--st-accent)]'
        : 'text-[color:var(--st-text-faint)] hover:text-[color:var(--st-text)]',
    ].join(' ')}
    title={title}
  >
    {children}
  </button>
);

export const DiffOverlay: React.FC<DiffOverlayProps> = React.memo(({
  isOpen,
  filePath,
  sessionId,
  target,
  files = [],
  onClose,
  banner
}) => {
  const [diff, setDiff] = useState<string | null>(null);
  const [stagedDiff, setStagedDiff] = useState<string | null>(null);
  const [unstagedDiff, setUnstagedDiff] = useState<string | null>(null);
  const [fileSource, setFileSource] = useState<string | null>(null);
  const [fileSources, setFileSources] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const overlayRefreshTimerRef = useRef<number | null>(null);
  
  const [currentHunkIndex, setCurrentHunkIndex] = useState(0);
  const [totalHunks, setTotalHunks] = useState(0);
  const [visibleFilePath, setVisibleFilePath] = useState<string | null>(null);
  const [stagingInProgress, setStagingInProgress] = useState(false);
  const diffViewerRef = useRef<ZedDiffViewerHandle | null>(null);

  const derivedFiles = useMemo(() => {
    if (!diff) return [];
    const diffText = diff || '';
    const parsed: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed' }> = [];

    const fileMatches = diffText.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
    if (!fileMatches) return [];

    for (const fileContent of fileMatches) {
      const fileNameMatch = fileContent.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
      if (!fileNameMatch) continue;
      const newFileName = fileNameMatch[2] || fileNameMatch[1] || '';

      let type: 'added' | 'deleted' | 'modified' | 'renamed' = 'modified';
      if (fileContent.includes('new file mode')) type = 'added';
      else if (fileContent.includes('deleted file mode')) type = 'deleted';
      else if (fileContent.includes('rename from')) type = 'renamed';

      const additions = (fileContent.match(/^\+[^+]/gm) || []).length;
      const deletions = (fileContent.match(/^-[^-]/gm) || []).length;

      parsed.push({ path: newFileName, additions, deletions, type });
    }

    return parsed;
  }, [diff]);

  const viewerFiles = files.length > 0 ? files : derivedFiles;

  // Load diff
  useEffect(() => {
    if (!isOpen || !sessionId || !target) {
      setDiff(null);
      setStagedDiff(null);
      setUnstagedDiff(null);
      setFileSource(null);
      setFileSources(null);
      return;
    }

    const loadDiff = async () => {
      setLoading(true);
      setError(null);

      try {
        const workingScope = target.kind === 'working' ? ((target as any).scope || 'all') : null;

        if (target.kind === 'working') {
          // For working tree, always load all + staged + unstaged diffs so we can determine per-hunk status in one view (Zed-like).
          const [allRes, stagedRes, unstagedRes] = await Promise.all([
            withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'all' } as any), 15_000, 'Load diff'),
            withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'staged' } as any), 15_000, 'Load staged diff'),
            withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'unstaged' } as any), 15_000, 'Load unstaged diff'),
          ]);

          if (!allRes.success) throw new Error(allRes.error || 'Failed to load diff');
          if (!stagedRes.success) throw new Error(stagedRes.error || 'Failed to load staged diff');
          if (!unstagedRes.success) throw new Error(unstagedRes.error || 'Failed to load unstaged diff');

          setDiff(allRes.data?.diff ?? '');
          setStagedDiff(stagedRes.data?.diff ?? '');
          setUnstagedDiff(unstagedRes.data?.diff ?? '');

          // Single-file view: expand to full file using a best-effort file source.
          if (filePath) {
            setFileSources(null);
            const preferredRef = workingScope === 'untracked' ? 'WORKTREE' : 'HEAD';
            let sourceRes = await withTimeout(
              API.sessions.getFileContent(sessionId, { filePath, ref: preferredRef, maxBytes: 1024 * 1024 }),
              15_000,
              'Load file content'
            );
            if (!sourceRes.success && preferredRef !== 'WORKTREE') {
              sourceRes = await withTimeout(
                API.sessions.getFileContent(sessionId, { filePath, ref: 'WORKTREE', maxBytes: 1024 * 1024 }),
                15_000,
                'Load file content'
              );
            }
            setFileSource(sourceRes.success ? (sourceRes.data?.content ?? '') : null);
          } else {
            // Project diff view: expand each file to include unchanged lines between hunks (Zed-like).
            setFileSource(null);

            const wt = (allRes.data as { workingTree?: unknown } | undefined)?.workingTree as
              | { staged: Array<{ path: string; isNew?: boolean }>; unstaged: Array<{ path: string; isNew?: boolean }>; untracked: Array<{ path: string; isNew?: boolean }> }
              | undefined;

            const untracked = new Set<string>([
              ...(wt?.untracked || []).map((f) => f.path),
              ...(wt?.staged || []).filter((f) => Boolean((f as any).isNew)).map((f) => f.path),
            ]);

            const changed = Array.isArray((allRes.data as { changedFiles?: unknown } | undefined)?.changedFiles)
              ? (((allRes.data as { changedFiles?: unknown }).changedFiles as unknown[]) || []).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              : [];

            const maxFiles = 80;
            const targets = changed.slice(0, maxFiles);
            const results: Record<string, string> = {};

            // Small concurrency pool to avoid UI stalls.
            const concurrency = 6;
            let cursor = 0;
            const workers = Array.from({ length: concurrency }).map(async () => {
              while (cursor < targets.length) {
                const idx = cursor++;
                const p = targets[idx];
                const prefer = untracked.has(p) ? 'WORKTREE' : 'HEAD';
                try {
                  let r = await withTimeout(
                    API.sessions.getFileContent(sessionId, { filePath: p, ref: prefer as any, maxBytes: 1024 * 1024 }),
                    15_000,
                    'Load file content'
                  );
                  if (!r.success && prefer !== 'WORKTREE') {
                    r = await withTimeout(
                      API.sessions.getFileContent(sessionId, { filePath: p, ref: 'WORKTREE', maxBytes: 1024 * 1024 }),
                      15_000,
                      'Load file content'
                    );
                  }
                  if (r.success) {
                    results[p] = r.data?.content ?? '';
                  }
                } catch {
                  // best-effort
                }
              }
            });
            await Promise.all(workers);
            setFileSources(Object.keys(results).length > 0 ? results : null);
          }
          return;
        }

        const response = await withTimeout(API.sessions.getDiff(sessionId, target), 15_000, 'Load diff');
        if (response.success && response.data) {
          setDiff(response.data.diff ?? '');
          setStagedDiff(null);
          setUnstagedDiff(null);
          setFileSource(null);
          setFileSources(null);
        } else {
          const message = response.error || 'Failed to load diff';
          const isStaleCommit =
            target.kind === 'commit' &&
            /commit not found|bad object|unknown revision|invalid object name|ambiguous argument/i.test(message);
          if (isStaleCommit) {
            onClose();
            return;
          }
          setError(message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      } finally {
        setLoading(false);
      }
    };

    loadDiff();
  }, [isOpen, sessionId, target, filePath, onClose]);

  const handleRefresh = useCallback(async () => {
    if (!sessionId || !target) return;

    setLoading(true);
    setError(null);

    try {
      const workingScope = target.kind === 'working' ? ((target as any).scope || 'all') : null;

      if (target.kind === 'working') {
        const [allRes, stagedRes, unstagedRes] = await Promise.all([
          withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'all' } as any), 15_000, 'Load diff'),
          withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'staged' } as any), 15_000, 'Load staged diff'),
          withTimeout(API.sessions.getDiff(sessionId, { kind: 'working', scope: 'unstaged' } as any), 15_000, 'Load unstaged diff'),
        ]);

        if (!allRes.success) throw new Error(allRes.error || 'Failed to load diff');
        if (!stagedRes.success) throw new Error(stagedRes.error || 'Failed to load staged diff');
        if (!unstagedRes.success) throw new Error(unstagedRes.error || 'Failed to load unstaged diff');

        setDiff(allRes.data?.diff ?? '');
        setStagedDiff(stagedRes.data?.diff ?? '');
        setUnstagedDiff(unstagedRes.data?.diff ?? '');

        if (filePath) {
          setFileSources(null);
          const preferredRef = workingScope === 'untracked' ? 'WORKTREE' : 'HEAD';
          let sourceRes = await withTimeout(
            API.sessions.getFileContent(sessionId, { filePath, ref: preferredRef, maxBytes: 1024 * 1024 }),
            15_000,
            'Load file content'
          );
          if (!sourceRes.success && preferredRef !== 'WORKTREE') {
            sourceRes = await withTimeout(
              API.sessions.getFileContent(sessionId, { filePath, ref: 'WORKTREE', maxBytes: 1024 * 1024 }),
              15_000,
              'Load file content'
            );
          }
          setFileSource(sourceRes.success ? (sourceRes.data?.content ?? '') : null);
        } else {
          setFileSource(null);

          const wt = (allRes.data as { workingTree?: unknown } | undefined)?.workingTree as
            | { staged: Array<{ path: string; isNew?: boolean }>; unstaged: Array<{ path: string; isNew?: boolean }>; untracked: Array<{ path: string; isNew?: boolean }> }
            | undefined;

          const untracked = new Set<string>([
            ...(wt?.untracked || []).map((f) => f.path),
            ...(wt?.staged || []).filter((f) => Boolean((f as any).isNew)).map((f) => f.path),
          ]);

          const changed = Array.isArray((allRes.data as { changedFiles?: unknown } | undefined)?.changedFiles)
            ? (((allRes.data as { changedFiles?: unknown }).changedFiles as unknown[]) || []).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            : [];

          const maxFiles = 80;
          const targets = changed.slice(0, maxFiles);
          const results: Record<string, string> = {};
          const concurrency = 6;
          let cursor = 0;
          const workers = Array.from({ length: concurrency }).map(async () => {
            while (cursor < targets.length) {
              const idx = cursor++;
              const p = targets[idx];
              const prefer = untracked.has(p) ? 'WORKTREE' : 'HEAD';
              try {
                let r = await withTimeout(
                  API.sessions.getFileContent(sessionId, { filePath: p, ref: prefer as any, maxBytes: 1024 * 1024 }),
                  15_000,
                  'Load file content'
                );
                if (!r.success && prefer !== 'WORKTREE') {
                  r = await withTimeout(
                    API.sessions.getFileContent(sessionId, { filePath: p, ref: 'WORKTREE', maxBytes: 1024 * 1024 }),
                    15_000,
                    'Load file content'
                  );
                }
                if (r.success) {
                  results[p] = r.data?.content ?? '';
                }
              } catch {
                // best-effort
              }
            }
          });
          await Promise.all(workers);
          setFileSources(Object.keys(results).length > 0 ? results : null);
        }
        return;
      } else {
        const response = await withTimeout(API.sessions.getDiff(sessionId, target), 15_000, 'Load diff');
        if (response.success && response.data) {
          setDiff(response.data.diff ?? '');
          setStagedDiff(null);
          setUnstagedDiff(null);
          setFileSource(null);
          setFileSources(null);
        } else {
          const message = response.error || 'Failed to load diff';
          const isStaleCommit =
            target.kind === 'commit' &&
            /commit not found|bad object|unknown revision|invalid object name|ambiguous argument/i.test(message);
          if (isStaleCommit) {
            onClose();
            return;
          }
          setError(message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  }, [sessionId, target, filePath, onClose]);

  const handleCopyPath = useCallback(async () => {
    if (!filePath) return;

    try {
      await navigator.clipboard.writeText(filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [filePath]);

  // Keep overlay in sync with staging actions triggered outside the overlay (e.g. Stage/Unstage All in RightPanel).
  useEffect(() => {
    if (!isOpen || !sessionId || !target) return;
    if (target.kind !== 'working' || !filePath) return;
    const unsub = window.electronAPI?.events?.onGitStatusUpdated?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      if (overlayRefreshTimerRef.current) {
        window.clearTimeout(overlayRefreshTimerRef.current);
      }
      overlayRefreshTimerRef.current = window.setTimeout(() => {
        overlayRefreshTimerRef.current = null;
        void handleRefresh();
      }, 80);
    });
    return () => {
      if (overlayRefreshTimerRef.current) {
        window.clearTimeout(overlayRefreshTimerRef.current);
        overlayRefreshTimerRef.current = null;
      }
      if (unsub) unsub();
    };
  }, [isOpen, sessionId, target, filePath, handleRefresh]);

  // Fallback: staging operations always record a timeline event, while status updates can be throttled/skipped.
  // This keeps the overlay in sync when users stage/unstage via the RightPanel checkboxes.
  useEffect(() => {
    if (!isOpen || !sessionId || !target) return;
    if (target.kind !== 'working' || !filePath) return;
    const unsub = window.electronAPI?.events?.onTimelineEvent?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const e = data.event as { kind?: unknown; status?: unknown; meta?: unknown } | undefined;
      if (!e || e.kind !== 'git.command') return;
      if (e.status !== 'finished' && e.status !== 'failed') return;
      const meta = (e.meta || {}) as Record<string, unknown>;
      const source = typeof meta.source === 'string' ? meta.source : '';
      if (source !== 'gitStaging') return;

      if (overlayRefreshTimerRef.current) {
        window.clearTimeout(overlayRefreshTimerRef.current);
      }
      overlayRefreshTimerRef.current = window.setTimeout(() => {
        overlayRefreshTimerRef.current = null;
        void handleRefresh();
      }, 80);
    });
    return () => {
      if (unsub) unsub();
    };
  }, [isOpen, sessionId, target, filePath, handleRefresh]);

  const handleHunkNavigation = useCallback((direction: 'prev' | 'next') => {
    diffViewerRef.current?.navigateToHunk(direction);
  }, []);

  const handleStageAll = useCallback(async (stage: boolean) => {
    if (!sessionId || stagingInProgress) return;
    setStagingInProgress(true);
    try {
      await diffViewerRef.current?.stageAll(stage);
      handleRefresh();
    } finally {
      setStagingInProgress(false);
    }
  }, [sessionId, stagingInProgress, handleRefresh]);

  const handleHunkInfo = useCallback((current: number, total: number) => {
    setCurrentHunkIndex(current);
    setTotalHunks(total);
  }, []);

  const handleVisibleFileChange = useCallback((path: string | null) => {
    setVisibleFilePath(path);
  }, []);

  if (!isOpen) return null;

  const workingScope = target?.kind === 'working' ? (target.scope || 'all') : null;
  const isWorkingTree = target?.kind === 'working';
  const hasHunks = totalHunks > 0;
  const workingTitle =
    workingScope === 'staged'
      ? 'Staged Changes'
      : workingScope === 'unstaged'
        ? 'Unstaged Changes'
        : workingScope === 'untracked'
          ? 'Untracked Files'
          : 'Working Tree Diff';

  return (
    <div
      className="absolute inset-0 z-[60] flex flex-col st-bg"
      data-testid="diff-overlay"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 st-surface"
        style={{
          borderBottom: `1px solid ${border}`,
          // @ts-expect-error - webkit vendor prefix for electron drag region
          WebkitAppRegion: 'no-drag',
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Back button */}
          <button
            type="button"
            onClick={onClose}
            data-testid="diff-overlay-back"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded st-hoverable st-focus-ring"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">Back</span>
          </button>

          {/* Separator */}
          <div className="h-4 w-px" style={{ backgroundColor: border }} />

          {/* File path */}
          {filePath ? (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="text-xs font-mono truncate"
                style={{ color: 'var(--st-text-faint)' }}
                title={filePath}
              >
                {filePath}
              </span>

              {/* Copy path button */}
              <IconButton
                onClick={handleCopyPath}
                title={copied ? 'Copied!' : 'Copy path'}
                variant={copied ? 'accent' : 'default'}
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </IconButton>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-xs font-medium" style={{ color: 'var(--st-text-faint)' }}>
                {target?.kind === 'working' ? workingTitle : 'Commit Diff'}
              </span>
              {viewerFiles.length > 0 && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: hoverBg, color: 'var(--st-text-faint)' }}
                >
                  {viewerFiles.length} files
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right side buttons */}
        <div className="flex items-center gap-0.5">
          {/* Refresh button */}
          <IconButton
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>

          {/* Close button */}
          <IconButton
            onClick={onClose}
            title="Close"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {isWorkingTree && (
        <div
          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3 py-1.5"
          style={{ backgroundColor: 'var(--st-surface)', borderBottom: `1px solid ${border}` }}
          data-testid="diff-toolbar"
        >
          <div className="flex items-center gap-1 min-w-0 justify-start">
            <ToolbarButton
              onClick={() => handleStageAll(true)}
              disabled={stagingInProgress || !diff}
              title="Stage all changes"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Stage All</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => handleStageAll(false)}
              disabled={stagingInProgress || !diff}
              title="Unstage all changes"
            >
              <Minus className="w-3.5 h-3.5" />
              <span>Unstage All</span>
              </ToolbarButton>
            </div>

          <div className="flex items-center gap-1 justify-center">
            <ToolbarButton
              onClick={() => handleHunkNavigation('prev')}
              disabled={!hasHunks}
              title="Previous hunk"
              variant="icon"
            >
              <ChevronUp className="w-4 h-4" />
            </ToolbarButton>
            {hasHunks && (
              <span
                className="text-[11px] font-mono px-1.5 min-w-[40px] text-center"
                style={{ color: 'var(--st-text-faint)' }}
              >
                {currentHunkIndex}/{totalHunks}
              </span>
            )}
            <ToolbarButton
              onClick={() => handleHunkNavigation('next')}
              disabled={!hasHunks}
              title="Next hunk"
              variant="icon"
            >
              <ChevronDown className="w-4 h-4" />
              </ToolbarButton>
          </div>

          <div className="flex items-center gap-1 min-w-0 justify-end">
            {visibleFilePath && (
              <>
                <ToolbarDivider />
                <span
                  className="text-[10px] font-mono truncate max-w-[200px]"
                  style={{ color: 'var(--st-text-faint)' }}
                  title={visibleFilePath}
                >
                  {visibleFilePath.split('/').pop()}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {banner && (
        <div
          className="px-3 py-2 flex items-center justify-between gap-3"
          style={{ backgroundColor: 'var(--st-surface)', borderBottom: `1px solid ${border}` }}
        >
          <div className="min-w-0">
            <div className="text-xs font-medium" style={{ color: 'var(--st-text)' }}>{banner.title}</div>
            {banner.description && (
              <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--st-text-faint)' }} title={banner.description}>
                {banner.description}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {banner.secondaryLabel && banner.onSecondary && (
              <button
                type="button"
                onClick={banner.onSecondary}
                className="px-3 py-1.5 rounded text-xs border transition-all st-hoverable st-focus-ring"
                style={{ borderColor: border, color: 'var(--st-text-muted)', backgroundColor: 'var(--st-surface)' }}
              >
                {banner.secondaryLabel}
              </button>
            )}
            <button
              type="button"
              onClick={banner.onPrimary}
              disabled={banner.primaryDisabled}
              className="px-3 py-1.5 rounded text-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--st-accent)', color: '#000000' }}
            >
              {banner.primaryLabel}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && !diff ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-3"
            style={{ color: 'var(--st-text-faint)' }}
          >
            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            <span className="text-xs">Loading diff...</span>
          </div>
        ) : error ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: 'var(--st-danger)' }}
          >
            <span className="text-xs">{error}</span>
            <button
              type="button"
              onClick={handleRefresh}
              className="text-xs px-3 py-1.5 rounded st-hoverable st-focus-ring"
              style={{
                backgroundColor: hoverBg,
                color: 'var(--st-text-muted)',
              }}
            >
              Retry
            </button>
          </div>
        ) : diff ? (
          <ZedDiffViewer
            ref={diffViewerRef}
            diff={diff}
            scrollToFilePath={filePath || undefined}
            className="h-full"
            sessionId={sessionId}
            currentScope={target?.kind === 'working' ? (target.scope as any) : undefined}
            stagedDiff={stagedDiff ?? undefined}
            unstagedDiff={unstagedDiff ?? undefined}
            fileSources={filePath && fileSource != null ? { [filePath]: fileSource } : (fileSources ?? undefined)}
            expandFileContext={Boolean(filePath && fileSource != null)}
            fileOrder={viewerFiles.length > 0 ? viewerFiles.map((f) => f.path) : undefined}
            isCommitView={target?.kind === 'commit'}
            onChanged={handleRefresh}
            onHunkInfo={handleHunkInfo}
            onVisibleFileChange={handleVisibleFileChange}
          />
        ) : (
          <div
            className="flex items-center justify-center h-full text-xs"
            style={{ color: 'var(--st-text-faint)' }}
          >
            No changes to display
          </div>
        )}
      </div>
    </div>
  );
});

DiffOverlay.displayName = 'DiffOverlay';

export default DiffOverlay;
