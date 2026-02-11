import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, ArrowLeft, RefreshCw, Copy, Check } from 'lucide-react';
import { PierreDiffViewer } from '../panels/diff/PierreDiffViewer';
import { isPreviewableFile } from '../panels/diff/utils/fileUtils';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { DiffOverlayProps } from './types';

const border = 'color-mix(in srgb, var(--st-border) 70%, transparent)';
const hoverBg = 'color-mix(in srgb, var(--st-hover) 42%, transparent)';
const FILE_CONTENT_TIMEOUT_MS = 15_000;
const FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;
const FILE_CONTENT_CONCURRENCY = 6;
const FILE_CONTENT_MAX_FILES = 80;

function uniquePreviewablePaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const trimmed = typeof path === 'string' ? path.trim() : '';
    if (!trimmed) continue;
    if (!isPreviewableFile(trimmed)) continue;
    out.add(trimmed);
  }
  return Array.from(out);
}

function extractPreviewablePathsFromDiff(diffText: string): string[] {
  const matches = diffText.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/g);
  if (!matches) return [];
  const paths: string[] = [];
  for (const match of matches) {
    const fileNameMatch = match.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
    if (!fileNameMatch) continue;
    const newFileName = fileNameMatch[2] || fileNameMatch[1] || '';
    if (newFileName) paths.push(newFileName);
  }
  return uniquePreviewablePaths(paths);
}

async function requestFileContent(sessionId: string, filePath: string, ref: string, maxBytes: number): Promise<string | null> {
  const response = await withTimeout(
    API.sessions.getFileContent(sessionId, { filePath, ref, maxBytes }),
    FILE_CONTENT_TIMEOUT_MS,
    'Load file content'
  );
  if (!response.success) return null;
  return response.data?.content ?? '';
}

async function requestFileContentWithFallback(
  sessionId: string,
  filePath: string,
  refs: string[],
  maxBytes: number
): Promise<string | null> {
  for (const ref of refs) {
    const content = await requestFileContent(sessionId, filePath, ref, maxBytes);
    if (content != null) return content;
  }
  return null;
}

async function fetchFileSources(
  sessionId: string,
  filePaths: string[],
  options: { refs: string[]; maxBytes?: number; concurrency?: number }
): Promise<Record<string, string>> {
  if (filePaths.length === 0) return {};

  const maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : FILE_CONTENT_MAX_BYTES;
  const concurrency = typeof options.concurrency === 'number' && options.concurrency > 0 ? options.concurrency : FILE_CONTENT_CONCURRENCY;
  const targets = filePaths.slice();
  const results: Record<string, string> = {};
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }).map(async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const path = targets[idx]!;
      try {
        const content = await requestFileContentWithFallback(sessionId, path, options.refs, maxBytes);
        if (content != null) results[path] = content;
      } catch {
        // best-effort
      }
    }
  });

  await Promise.all(workers);
  return results;
}

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
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const lastGitStatusSignatureRef = useRef<string | null>(null);

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
  const viewerFileOrder = useMemo(() => {
    if (!viewerFiles || viewerFiles.length === 0) return undefined;
    return viewerFiles.map((f) => f.path);
  }, [viewerFiles]);

  const previewSources = useMemo(() => {
    if (filePath && fileSource != null) return { [filePath]: fileSource };
    if (!filePath) return fileSources ?? undefined;
    return undefined;
  }, [filePath, fileSource, fileSources]);

  // Shared diff loading logic used by both initial load and refresh
  const loadDiffData = useCallback(async (): Promise<void> => {
    if (!isOpen || !sessionId || !target) return;

    setLoading(true);
    setError(null);

    try {
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
        // Always use WORKTREE to get the current working copy (new content) for preview.
        if (filePath) {
          setFileSources(null);
          const content = await requestFileContentWithFallback(
            sessionId,
            filePath,
            ['WORKTREE', 'HEAD'],
            FILE_CONTENT_MAX_BYTES
          );
          setFileSource(content);
        } else {
          // Project diff view: load previewable files only (markdown/images).
          setFileSource(null);
          setFileSources(null);

          const changed = Array.isArray((allRes.data as { changedFiles?: unknown } | undefined)?.changedFiles)
            ? (((allRes.data as { changedFiles?: unknown }).changedFiles as unknown[]) || []).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            : [];

          const targets = uniquePreviewablePaths(changed).slice(0, FILE_CONTENT_MAX_FILES);
          if (targets.length === 0) {
            setFileSources(null);
          } else {
            const results = await fetchFileSources(sessionId, targets, {
              refs: ['WORKTREE', 'HEAD'],
              maxBytes: FILE_CONTENT_MAX_BYTES,
              concurrency: FILE_CONTENT_CONCURRENCY,
            });
            setFileSources(Object.keys(results).length > 0 ? results : null);
          }
        }
        return;
      }

      const response = await withTimeout(API.sessions.getDiff(sessionId, target), 15_000, 'Load diff');
      if (response.success && response.data) {
        const diffText = response.data.diff ?? '';
        setDiff(diffText);
        setStagedDiff(null);
        setUnstagedDiff(null);
        setFileSources(null);

        if (target.kind === 'commit') {
          const commitHash = target.hash;
          // Single-file view: load the file content at the selected commit for previews.
          if (filePath) {
            const content = await requestFileContentWithFallback(
              sessionId,
              filePath,
              [commitHash, `${commitHash}^`],
              FILE_CONTENT_MAX_BYTES
            );
            setFileSource(content);
          } else {
            setFileSource(null);
            // Project diff view: load previewable file content to enable previews.
            if (diffText) {
              const previewableFiles = extractPreviewablePathsFromDiff(diffText);
              if (previewableFiles.length > 0) {
                const results = await fetchFileSources(sessionId, previewableFiles, {
                  refs: [commitHash],
                  maxBytes: FILE_CONTENT_MAX_BYTES,
                  concurrency: FILE_CONTENT_CONCURRENCY,
                });
                setFileSources(Object.keys(results).length > 0 ? results : null);
              }
            }
          }
        } else {
          setFileSource(null);
        }
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
  }, [filePath, isOpen, onClose, sessionId, target]);

  const loadDiffDataRef = useRef(loadDiffData);
  useEffect(() => {
    loadDiffDataRef.current = loadDiffData;
  }, [loadDiffData]);

  const refreshNow = useCallback(() => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }

    refreshInFlightRef.current = true;
    refreshQueuedRef.current = false;

    void loadDiffDataRef
      .current()
      .catch(() => {
        // errors are surfaced via local state
      })
      .finally(() => {
        refreshInFlightRef.current = false;
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          refreshNow();
        }
      });
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (overlayRefreshTimerRef.current) {
      window.clearTimeout(overlayRefreshTimerRef.current);
    }
    overlayRefreshTimerRef.current = window.setTimeout(() => {
      overlayRefreshTimerRef.current = null;
      refreshNow();
    }, 150);
  }, [refreshNow]);

  // Load diff
  useEffect(() => {
    if (!isOpen || !sessionId || !target) {
      setDiff(null);
      setStagedDiff(null);
      setUnstagedDiff(null);
      setFileSource(null);
      setFileSources(null);
      lastGitStatusSignatureRef.current = null;
      return;
    }

    refreshNow();
  }, [filePath, isOpen, refreshNow, sessionId, target]);

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
    if (target.kind !== 'working') return;
    const unsub = window.electronAPI?.events?.onGitStatusUpdated?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const status = (data as { gitStatus?: unknown }).gitStatus as Record<string, unknown> | undefined;
      const signature = status ? JSON.stringify({
        state: status.state,
        staged: status.staged,
        modified: status.modified,
        untracked: status.untracked,
        conflicted: status.conflicted,
        ahead: status.ahead,
        behind: status.behind,
        additions: status.additions,
        deletions: status.deletions,
        filesChanged: status.filesChanged,
        hasUncommittedChanges: status.hasUncommittedChanges,
        hasUntrackedFiles: status.hasUntrackedFiles,
        isReadyToMerge: status.isReadyToMerge,
        detached: status.detached,
        clean: status.clean,
        secondaryStates: status.secondaryStates,
      }) : null;
      if (signature && lastGitStatusSignatureRef.current === signature) return;
      lastGitStatusSignatureRef.current = signature;
      scheduleRefresh();
    });
    return () => {
      if (overlayRefreshTimerRef.current) {
        window.clearTimeout(overlayRefreshTimerRef.current);
        overlayRefreshTimerRef.current = null;
      }
      if (unsub) unsub();
    };
  }, [isOpen, scheduleRefresh, sessionId, target]);

  // Fallback: staging operations always record a timeline event, while status updates can be throttled/skipped.
  // This keeps the overlay in sync when users stage/unstage via the RightPanel checkboxes.
  useEffect(() => {
    if (!isOpen || !sessionId || !target) return;
    if (target.kind !== 'working') return;
    const unsub = window.electronAPI?.events?.onTimelineEvent?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const e = data.event as { kind?: unknown; status?: unknown; meta?: unknown } | undefined;
      if (!e || e.kind !== 'git.command') return;
      if (e.status !== 'finished' && e.status !== 'failed') return;
      const meta = (e.meta || {}) as Record<string, unknown>;
      const source = typeof meta.source === 'string' ? meta.source : '';
      if (source !== 'gitStaging') return;
      scheduleRefresh();
    });
    return () => {
      if (unsub) unsub();
    };
  }, [isOpen, scheduleRefresh, sessionId, target]);

  if (!isOpen) return null;

  const workingScope = target?.kind === 'working' ? (target.scope || 'all') : null;

  function getWorkingTitle(scope: string | null): string {
    switch (scope) {
      case 'staged':
        return 'Staged Changes';
      case 'unstaged':
        return 'Unstaged Changes';
      case 'untracked':
        return 'Untracked Files';
      default:
        return 'Working Tree Diff';
    }
  }
  const workingTitle = getWorkingTitle(workingScope);

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
            onClick={refreshNow}
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
              onClick={refreshNow}
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
          <PierreDiffViewer
            diff={diff}
            scrollToFilePath={filePath || undefined}
            className="h-full"
            sessionId={sessionId}
            target={target ?? undefined}
            stagedDiff={stagedDiff ?? undefined}
            unstagedDiff={unstagedDiff ?? undefined}
            previewFileSources={previewSources}
            fileOrder={viewerFileOrder}
            onChanged={refreshNow}
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
