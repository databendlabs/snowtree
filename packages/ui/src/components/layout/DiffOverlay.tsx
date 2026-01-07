import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, ArrowLeft, RefreshCw, Copy, Check } from 'lucide-react';
import { ZedDiffViewer } from '../panels/diff/ZedDiffViewer';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { DiffOverlayProps } from './types';

const border = 'color-mix(in srgb, var(--st-border) 70%, transparent)';
const hoverBg = 'color-mix(in srgb, var(--st-hover) 42%, transparent)';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const overlayRefreshTimerRef = useRef<number | null>(null);

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
      return;
    }

    const loadDiff = async () => {
      setLoading(true);
      setError(null);

      try {
        if (target.kind === 'working' && filePath) {
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

          // Best-effort: HEAD may not contain new/untracked files.
          const preferredRef = target.scope === 'untracked' ? 'WORKTREE' : 'HEAD';
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
          setFileSource(sourceRes.success ? (sourceRes.data?.content ?? '') : '');
        } else {
          const response = await withTimeout(API.sessions.getDiff(sessionId, target), 15_000, 'Load diff');
          if (response.success && response.data) {
            setDiff(response.data.diff ?? '');
            setStagedDiff(null);
            setUnstagedDiff(null);
            setFileSource(null);
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
    };

    loadDiff();
  }, [isOpen, sessionId, target, filePath, onClose]);

  const handleRefresh = useCallback(async () => {
    if (!sessionId || !target) return;

    setLoading(true);
    setError(null);

    try {
      if (target.kind === 'working' && filePath) {
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

        // Keep full-file rendering stable during refresh as well.
        const preferredRef = target.scope === 'untracked' ? 'WORKTREE' : 'HEAD';
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
        setFileSource(sourceRes.success ? (sourceRes.data?.content ?? '') : '');
      } else {
        const response = await withTimeout(API.sessions.getDiff(sessionId, target), 15_000, 'Load diff');
        if (response.success && response.data) {
          setDiff(response.data.diff ?? '');
          setStagedDiff(null);
          setUnstagedDiff(null);
          setFileSource(null);
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

  if (!isOpen) return null;

  const workingScope = target?.kind === 'working' ? (target.scope || 'all') : null;
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

      {/* Diff usage hint - only show for staged/unstaged working tree */}
      {(workingScope === 'staged' || workingScope === 'unstaged') && (
        <div
          className="px-3 py-1.5 flex items-center gap-3"
          style={{ backgroundColor: 'var(--st-surface)', borderBottom: `1px solid ${border}` }}
        >
          <span className="text-[11px]" style={{ color: 'var(--st-text-faint)' }}>
            {filePath
              ? 'Hover a hunk to stage/unstage/restore.'
              : `Click line numbers to select. Use the +/- button to ${workingScope === 'unstaged' ? 'stage' : 'unstage'} a line or hunk.`}
          </span>
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
            diff={diff}
            scrollToFilePath={filePath || undefined}
            className="h-full"
            sessionId={sessionId}
            currentScope={target?.kind === 'working' ? (target.scope as any) : undefined}
            stagedDiff={stagedDiff ?? undefined}
            unstagedDiff={unstagedDiff ?? undefined}
            fileSources={filePath && fileSource != null ? { [filePath]: fileSource } : undefined}
            fileOrder={viewerFiles.length > 0 ? viewerFiles.map((f) => f.path) : undefined}
            onChanged={handleRefresh}
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
