import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Minus, Plus, RotateCcw, UnfoldVertical } from 'lucide-react';
import { FileDiff, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata, type Hunk } from '@pierre/diffs';

import { API } from '../../../utils/api';
import { withTimeout } from '../../../utils/withTimeout';
import { workerFactory } from '../../../utils/diffsWorker';
import { useThemeStore } from '../../../stores/themeStore';

import { ImagePreview } from './ImagePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { useFilePreviewState } from './useFilePreviewState';
import { isBinaryFile, isImageFile, isPreviewableFile } from './utils/fileUtils';
import { findMatchingHeader, type HunkHeaderEntry } from './utils/diffUtils';

const FILE_CONTENT_TIMEOUT_MS = 15_000;
const FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;

const DIFF_SCROLL_CSS = `
[data-column-number],
[data-buffer],
[data-separator-wrapper],
[data-annotation-content] {
  position: static !important;
}

[data-buffer] {
  background-image: none !important;
}

[data-line-annotation] {
  min-height: 0 !important;
}

[data-annotation-content] {
  display: flex !important;
  align-items: center !important;
  height: auto !important;
  padding: 1px 8px 2px 8px !important;
}

diffs-container,
[data-diffs],
[data-diffs-header],
[data-error-wrapper] {
  position: relative !important;
  contain: layout style !important;
  isolation: isolate !important;
}
`;

function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= maxConcurrent) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const exec = () => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            runNext();
          });
      };
      queue.push(exec);
      runNext();
    });
  };
}

// Prevent a thundering herd of `git show` calls when rendering large diffs.
const limitFileContentReads = createConcurrencyLimiter(6);

function splitLinesPreserveNewline(contents: string): string[] {
  if (!contents) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < contents.length; i++) {
    if (contents[i] === '\n') {
      out.push(contents.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < contents.length) out.push(contents.slice(start));
  return out;
}

function normalizePatchName(name: string): string {
  if (!name) return name;
  return name.replace(/^(?:a|b)\//, '');
}

function extractFileDiffs(diffText: string): FileDiffMetadata[] {
  const trimmed = (diffText || '').trim();
  if (!trimmed) return [];
  const patches = parsePatchFiles(trimmed);
  const files = patches.flatMap((p) => p.files || []);
  return files
    .filter((f) => Boolean(f && f.name))
    .map((f) => ({
      ...f,
      name: normalizePatchName(f.name),
      prevName: f.prevName ? normalizePatchName(f.prevName) : f.prevName,
    }));
}

function orderFileDiffs(files: FileDiffMetadata[], fileOrder?: string[]): FileDiffMetadata[] {
  if (!fileOrder || fileOrder.length === 0) return files;
  const byPath = new Map<string, FileDiffMetadata[]>();
  for (const f of files) {
    const list = byPath.get(f.name) ?? [];
    list.push(f);
    byPath.set(f.name, list);
  }

  const ordered: FileDiffMetadata[] = [];
  for (const path of fileOrder) {
    const list = byPath.get(path);
    if (!list || list.length === 0) continue;
    ordered.push(list.shift()!);
    if (list.length === 0) byPath.delete(path);
    else byPath.set(path, list);
  }

  for (const f of files) {
    const list = byPath.get(f.name);
    if (!list || list.length === 0) continue;
    if (list[0] === f) {
      ordered.push(f);
      list.shift();
      if (list.length === 0) byPath.delete(f.name);
      else byPath.set(f.name, list);
    }
  }

  return ordered;
}

function hunkSignature(hunk: Hunk): string {
  const parts: string[] = [];
  for (const content of hunk.hunkContent) {
    if (content.type !== 'change') continue;
    for (const line of content.deletions) parts.push(`-${line}`);
    for (const line of content.additions) parts.push(`+${line}`);
  }
  return parts.join('\n');
}

function buildHunkHeaderEntries(diffText: string | undefined): Map<string, HunkHeaderEntry[]> {
  const map = new Map<string, HunkHeaderEntry[]>();
  if (!diffText || !diffText.trim()) return map;

  for (const file of extractFileDiffs(diffText)) {
    const entries: HunkHeaderEntry[] = [];
    for (const hunk of file.hunks) {
      const sig = hunkSignature(hunk);
      if (!sig) continue;
      entries.push({
        sig,
        oldStart: hunk.deletionStart,
        newStart: hunk.additionStart,
        header: hunk.hunkSpecs ?? '',
      });
    }
    if (entries.length > 0) map.set(file.name, entries);
  }

  return map;
}

async function requestFileContent(sessionId: string, filePath: string, ref: string): Promise<string | null> {
  return limitFileContentReads(async () => {
    const response = await withTimeout(
      API.sessions.getFileContent(sessionId, { filePath, ref, maxBytes: FILE_CONTENT_MAX_BYTES }),
      FILE_CONTENT_TIMEOUT_MS,
      'Load file content'
    );
    if (!response.success) return null;
    return response.data?.content ?? '';
  });
}

type PierreDiffViewerProps = {
  diff: string;
  sessionId?: string;
  target?: { kind: 'working'; scope?: 'all' | 'staged' | 'unstaged' | 'untracked' } | { kind: 'commit'; hash: string };
  stagedDiff?: string;
  unstagedDiff?: string;
  previewFileSources?: Record<string, string>;
  scrollToFilePath?: string;
  fileOrder?: string[];
  className?: string;
  onChanged?: () => void;
};

type HunkMeta = {
  index: number;
  sig: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  stagedHeader: string | null;
  unstagedHeader: string | null;
  status: 'staged' | 'unstaged' | 'untracked';
};

type HunkStatusAnnotation = {
  status: HunkMeta['status'];
  label: string;
};

function findHoveredHunk(hunks: HunkMeta[], lineNumber: number, side: 'deletions' | 'additions'): HunkMeta | null {
  if (!Number.isFinite(lineNumber)) return null;
  for (const hunk of hunks) {
    if (side === 'deletions') {
      if (hunk.oldCount > 0 && lineNumber >= hunk.oldStart && lineNumber <= hunk.oldStart + hunk.oldCount - 1) return hunk;
    } else {
      if (hunk.newCount > 0 && lineNumber >= hunk.newStart && lineNumber <= hunk.newStart + hunk.newCount - 1) return hunk;
    }
  }
  // Fallback: if we can't map by side (e.g., unified), try either range.
  for (const hunk of hunks) {
    if (hunk.oldCount > 0 && lineNumber >= hunk.oldStart && lineNumber <= hunk.oldStart + hunk.oldCount - 1) return hunk;
    if (hunk.newCount > 0 && lineNumber >= hunk.newStart && lineNumber <= hunk.newStart + hunk.newCount - 1) return hunk;
  }
  return null;
}

function getRequiredFileLineCount(fileDiff: FileDiffMetadata): { old: number; next: number } {
  let oldMax = 0;
  let nextMax = 0;
  for (const hunk of fileDiff.hunks) {
    // Use the hunk header ranges (deletion/addition counts include context lines).
    // If the fetched file content is shorter than these ranges, @pierre/diffs can
    // produce invalid Shiki decorations due to mismatched line indexing.
    const oldEnd = hunk.deletionStart + Math.max(hunk.deletionCount, 0) - 1;
    const nextEnd = hunk.additionStart + Math.max(hunk.additionCount, 0) - 1;
    oldMax = Math.max(oldMax, Math.max(oldEnd, hunk.deletionStart - 1));
    nextMax = Math.max(nextMax, Math.max(nextEnd, hunk.additionStart - 1));
  }
  return { old: oldMax, next: nextMax };
}

const FileCard = memo(function FileCard({
  fileDiff,
  stagedEntries,
  unstagedEntries,
  previewContent,
  isCommitView,
  sessionId,
  target,
  enableContextLoading,
  onChanged,
  scrollToSelf,
  isPreviewing,
  onTogglePreview,
  themeType,
}: {
  fileDiff: FileDiffMetadata;
  stagedEntries: HunkHeaderEntry[] | undefined;
  unstagedEntries: HunkHeaderEntry[] | undefined;
  previewContent: string | undefined;
  isCommitView: boolean;
  sessionId?: string;
  target?: PierreDiffViewerProps['target'];
  enableContextLoading: boolean;
  onChanged?: () => void;
  scrollToSelf?: boolean;
  isPreviewing: boolean;
  onTogglePreview: () => void;
  themeType: 'light' | 'dark';
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollToSelf) return;
    headerRef.current?.scrollIntoView({ block: 'start' });
  }, [scrollToSelf]);

  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const setPending = useCallback((key: string, pending: boolean) => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const hunksMeta = useMemo<HunkMeta[]>(() => {
    return fileDiff.hunks.map((hunk, idx) => {
      const sig = hunkSignature(hunk);
      const oldStart = hunk.deletionStart;
      const newStart = hunk.additionStart;
      const stagedHeader = findMatchingHeader(stagedEntries, sig, oldStart, newStart);
      const unstagedHeader = findMatchingHeader(unstagedEntries, sig, oldStart, newStart);
      const status: HunkMeta['status'] = stagedHeader ? 'staged' : unstagedHeader ? 'unstaged' : 'untracked';
      return {
        index: idx,
        sig,
        oldStart,
        oldCount: hunk.deletionCount,
        newStart,
        newCount: hunk.additionCount,
        header: hunk.hunkSpecs ?? '',
        stagedHeader,
        unstagedHeader,
        status,
      };
    });
  }, [fileDiff.hunks, stagedEntries, unstagedEntries]);

  const hasStaged = Boolean(stagedEntries && stagedEntries.length > 0);
  const hasUnstaged = Boolean(unstagedEntries && unstagedEntries.length > 0);
  const isFullyStaged = hasStaged && !hasUnstaged;
  const isFullyUnstaged = !hasStaged && hasUnstaged;

  const hunkStatusAnnotations = useMemo<DiffLineAnnotation<HunkStatusAnnotation>[]>(() => {
    if (isCommitView) return [];
    const annotations: DiffLineAnnotation<HunkStatusAnnotation>[] = [];
    const seen = new Set<string>();

    for (const hunk of hunksMeta) {
      const lineNumber = hunk.newStart > 0 ? hunk.newStart : hunk.oldStart;
      if (!Number.isFinite(lineNumber) || lineNumber <= 0) continue;
      const key = `${lineNumber}:${hunk.status}`;
      if (seen.has(key)) continue;
      seen.add(key);

      annotations.push({
        side: 'additions',
        lineNumber,
        metadata: {
          status: hunk.status,
          label: hunk.status === 'staged' ? 'Staged' : hunk.status === 'unstaged' ? 'Unstaged' : 'Untracked',
        },
      });
    }

    return annotations;
  }, [hunksMeta, isCommitView]);

  const renderHunkStatusAnnotation = useCallback((annotation: DiffLineAnnotation<HunkStatusAnnotation>) => {
    const metadata = annotation.metadata;
    if (!metadata) return null;

    const tone =
      metadata.status === 'staged'
        ? {
            bg: 'color-mix(in srgb, var(--st-success) 16%, transparent)',
            border: 'color-mix(in srgb, var(--st-success) 42%, transparent)',
            dot: 'var(--st-success)',
          }
        : metadata.status === 'unstaged'
          ? {
              bg: 'color-mix(in srgb, var(--st-warning) 14%, transparent)',
              border: 'color-mix(in srgb, var(--st-warning) 38%, transparent)',
              dot: 'var(--st-warning)',
            }
          : {
              bg: 'color-mix(in srgb, var(--st-accent) 14%, transparent)',
              border: 'color-mix(in srgb, var(--st-accent) 36%, transparent)',
              dot: 'var(--st-accent)',
            };

    return (
      <span
        className="inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10px] font-medium leading-none select-none pointer-events-none"
        style={{ backgroundColor: tone.bg, borderColor: tone.border, color: 'var(--st-text-faint)' }}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tone.dot }} />
        {metadata.label}
      </span>
    );
  }, []);

  const stageFile = useCallback(
    async (stage: boolean) => {
      if (!sessionId) return;
      const key = `file:${fileDiff.name}`;
      try {
        setPending(key, true);
        await API.sessions.changeFileStage(sessionId, { filePath: fileDiff.name, stage });
        onChanged?.();
      } catch (err) {
        console.error(`[Diffs] Failed to ${stage ? 'stage' : 'unstage'} file`, { filePath: fileDiff.name, err });
      } finally {
        setPending(key, false);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    },
    [fileDiff.name, onChanged, sessionId, setPending]
  );

  const restoreFile = useCallback(async () => {
    if (!sessionId) return;
    const key = `file:${fileDiff.name}:restore`;
    try {
      setPending(key, true);
      await API.sessions.restoreFile(sessionId, { filePath: fileDiff.name });
      onChanged?.();
    } catch (err) {
      console.error('[Diffs] Failed to restore file', { filePath: fileDiff.name, err });
    } finally {
      setPending(key, false);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [fileDiff.name, onChanged, sessionId, setPending]);

  const stageHunk = useCallback(
    async (hunk: HunkMeta, stage: boolean) => {
      if (!sessionId) return;
      const key = `hunk:${fileDiff.name}:${hunk.index}`;
      try {
        setPending(key, true);
        await API.sessions.stageHunk(sessionId, { filePath: fileDiff.name, isStaging: stage, hunkHeader: hunk.stagedHeader || hunk.unstagedHeader || hunk.header });
        onChanged?.();
      } catch (err) {
        console.error(`[Diffs] Failed to ${stage ? 'stage' : 'unstage'} hunk`, { filePath: fileDiff.name, hunkHeader: hunk.header, err });
      } finally {
        setPending(key, false);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    },
    [fileDiff.name, onChanged, sessionId, setPending]
  );

  const restoreHunk = useCallback(
    async (hunk: HunkMeta) => {
      if (!sessionId) return;
      const key = `hunk:${fileDiff.name}:${hunk.index}:restore`;
      if (hunk.status !== 'staged' && hunk.status !== 'unstaged') return;
      try {
        setPending(key, true);
        await API.sessions.restoreHunk(sessionId, { filePath: fileDiff.name, scope: hunk.status, hunkHeader: hunk.stagedHeader || hunk.unstagedHeader || hunk.header });
        onChanged?.();
      } catch (err) {
        console.error('[Diffs] Failed to restore hunk', { filePath: fileDiff.name, hunkHeader: hunk.header, err });
      } finally {
        setPending(key, false);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    },
    [fileDiff.name, onChanged, sessionId, setPending]
  );

  const [hoveredHunk, setHoveredHunk] = useState<HunkMeta | null>(null);

  const enableHoverUtility = !isCommitView && Boolean(sessionId);

  const targetKind = target?.kind;
  const targetHash = target?.kind === 'commit' ? target.hash : null;
  const oldRef = targetKind === 'working' ? 'HEAD' : targetHash ? `${targetHash}^` : null;
  const newRef = targetKind === 'working' ? 'WORKTREE' : targetHash;

  const [isContextEnabled, setIsContextEnabled] = useState<boolean>(() => Boolean(scrollToSelf));
  const [isContextLoading, setIsContextLoading] = useState(false);
  const [contextRequestId, setContextRequestId] = useState(0);

  useEffect(() => {
    if (scrollToSelf) setIsContextEnabled(true);
  }, [scrollToSelf]);

  const [contextLines, setContextLines] = useState<{ oldLines: string[]; newLines: string[] } | null>(null);
  const shouldLoadContext = useMemo(() => {
    if (!isContextEnabled) return false;
    if (!sessionId || !enableContextLoading || oldRef == null || newRef == null) return false;
    if (fileDiff.type === 'new' || fileDiff.type === 'deleted') return false;
    return fileDiff.hunks.length > 0;
  }, [enableContextLoading, fileDiff.hunks.length, fileDiff.type, isContextEnabled, newRef, oldRef, sessionId]);
  const contextLoadKey = useMemo(() => {
    if (!shouldLoadContext || oldRef == null || newRef == null) return null;
    const oldPath = fileDiff.prevName || fileDiff.name;
    const newPath = fileDiff.name;
    return `${oldRef}:${oldPath}=>${newRef}:${newPath}#${contextRequestId}`;
  }, [contextRequestId, fileDiff.name, fileDiff.prevName, newRef, oldRef, shouldLoadContext]);

  useEffect(() => {
    if (!sessionId || !shouldLoadContext || contextLoadKey == null || oldRef == null || newRef == null) {
      setContextLines(null);
      setIsContextLoading(false);
      return;
    }

    let cancelled = false;
    setIsContextLoading(true);
    void (async () => {
      try {
        const oldPath = fileDiff.prevName || fileDiff.name;
        const newPath = fileDiff.name;

        const [oldContent, newContent] = await Promise.all([
          requestFileContent(sessionId, oldPath, oldRef),
          requestFileContent(sessionId, newPath, newRef),
        ]);

        if (cancelled) return;
        if (oldContent == null || newContent == null) return;
        const oldLines = splitLinesPreserveNewline(oldContent);
        const newLines = splitLinesPreserveNewline(newContent);

        const required = getRequiredFileLineCount(fileDiff);
        const hasEnoughLines = oldLines.length >= required.old && newLines.length >= required.next;
        if (!hasEnoughLines) return;

        setContextLines({ oldLines, newLines });
      } catch {
        // best-effort
      } finally {
        if (!cancelled) setIsContextLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contextLoadKey, fileDiff, newRef, oldRef, sessionId, shouldLoadContext]);

  const diffOptions = useMemo(() => {
    const base = {
      diffStyle: 'unified' as const,
      hunkSeparators: 'line-info' as const,
      overflow: 'scroll' as const,
      themeType: themeType as 'light' | 'dark',
      disableFileHeader: true,
      unsafeCSS: DIFF_SCROLL_CSS,
      enableHoverUtility,
      onLineEnter: (props: any) => {
        const h = findHoveredHunk(hunksMeta, props.lineNumber, props.annotationSide);
        setHoveredHunk(h);
      },
      onLineLeave: () => {
        setHoveredHunk(null);
      },
    };
    if (!enableHoverUtility) {
      return {
        diffStyle: base.diffStyle,
        hunkSeparators: base.hunkSeparators,
        overflow: base.overflow,
        themeType: base.themeType,
        disableFileHeader: true,
        unsafeCSS: DIFF_SCROLL_CSS,
      };
    }
    return base;
  }, [enableHoverUtility, hunksMeta, themeType]);

  const fileDiffForRender = useMemo(() => {
    if (!contextLines) return fileDiff;
    return {
      ...fileDiff,
      oldLines: contextLines.oldLines,
      newLines: contextLines.newLines,
    } satisfies FileDiffMetadata;
  }, [contextLines, fileDiff]);

  const hoverUtility = useMemo(() => {
    if (!enableHoverUtility || hoveredHunk == null) return null;

    const canStageOrUnstage = Boolean(sessionId);
    const isPending = pendingKeys.has(`hunk:${fileDiff.name}:${hoveredHunk.index}`);
    const isRestorePending = pendingKeys.has(`hunk:${fileDiff.name}:${hoveredHunk.index}:restore`);

    const stageLabel = hoveredHunk.status === 'staged' ? 'Unstage' : 'Stage';
    const canRestore = hoveredHunk.status === 'staged' || hoveredHunk.status === 'unstaged';

    return (
      <div className="flex h-full items-center gap-1 pr-1">
        <button
          type="button"
          className="st-icon-button st-focus-ring !w-5 !h-5 disabled:opacity-40"
          data-testid="diff-hunk-stage"
          title={stageLabel}
          disabled={!canStageOrUnstage || isPending}
          onClick={(e) => {
            e.stopPropagation();
            if (hoveredHunk.status === 'untracked') return stageFile(true);
            if (fileDiff.type === 'deleted') return stageFile(stageLabel === 'Stage');
            return stageHunk(hoveredHunk, stageLabel === 'Stage');
          }}
        >
          {stageLabel === 'Stage' ? <Plus className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          className="st-icon-button st-focus-ring !w-5 !h-5 disabled:opacity-40"
          data-testid="diff-hunk-restore"
          title="Restore"
          disabled={!canRestore || isRestorePending}
          onClick={(e) => {
            e.stopPropagation();
            if (fileDiff.type === 'deleted') return restoreFile();
            return restoreHunk(hoveredHunk);
          }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }, [enableHoverUtility, fileDiff.name, fileDiff.type, hoveredHunk, pendingKeys, restoreFile, restoreHunk, sessionId, stageFile, stageHunk]);

  const containerStyle = useMemo(
    () =>
      ({
        ['--diffs-font-family' as any]: 'var(--st-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace)',
        ['--diffs-font-size' as any]: 'var(--st-font-sm, 12px)',
        ['--diffs-line-height' as any]: 1.5,
        ['--diffs-tab-size' as any]: 2,
        // Reserve enough space for per-hunk hover controls in the gutter.
        ['--diffs-min-number-column-width' as any]: '6ch',
        ['--diffs-light-bg' as any]: 'var(--st-diff-bg, var(--st-bg))',
        ['--diffs-dark-bg' as any]: 'var(--st-diff-bg, var(--st-bg))',
        ['--diffs-addition-color-override' as any]: 'var(--st-diff-added-marker)',
        ['--diffs-deletion-color-override' as any]: 'var(--st-diff-deleted-marker)',
        ['--diffs-modified-color-override' as any]: 'var(--st-diff-modified-marker)',
        ['--diffs-fg-number-override' as any]: 'var(--st-diff-gutter-fg)',
      }) as React.CSSProperties,
    []
  );

  const canPreview = Boolean(previewContent) && isPreviewableFile(fileDiff.name);
  const canLoadContext = Boolean(
    sessionId &&
      enableContextLoading &&
      oldRef != null &&
      newRef != null &&
      fileDiff.type !== 'new' &&
      fileDiff.type !== 'deleted' &&
      fileDiff.hunks.length > 0
  );

  return (
    <div className="st-diff-file" data-testid="diff-file" data-diff-file-path={fileDiff.name}>
      <div
        ref={headerRef}
        data-testid="diff-file-header"
        className="sticky top-0 z-20 px-3 py-2 text-xs font-semibold flex items-center justify-between gap-2"
        style={{ backgroundColor: 'var(--st-surface)', borderBottom: '1px solid var(--st-border-variant)' }}
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono truncate" title={fileDiff.name}>
            {fileDiff.name}
          </div>
          {fileDiff.prevName && fileDiff.prevName !== fileDiff.name && (
            <div className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--st-text-faint)' }} title={fileDiff.prevName}>
              {fileDiff.prevName}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {canLoadContext && !contextLines && (
            <button
              type="button"
              className="st-icon-button st-focus-ring disabled:opacity-40"
              onClick={() => {
                setIsContextEnabled(true);
                setContextRequestId((v) => v + 1);
              }}
              disabled={isContextLoading}
              title={isContextLoading ? 'Loading context...' : 'Load context for expand'}
            >
              <UnfoldVertical className={`w-3.5 h-3.5 ${isContextLoading ? 'animate-spin' : ''}`} />
            </button>
          )}
          {canPreview && (
            <button
              type="button"
              className="st-icon-button st-focus-ring"
              onClick={onTogglePreview}
              title={isPreviewing ? 'Show diff' : 'Preview'}
            >
              {isPreviewing ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
          {!isCommitView && (
            <>
              {!isFullyStaged && (
                <button
                  type="button"
                  className="px-2 py-1 rounded text-[11px] font-medium st-focus-ring disabled:opacity-40"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--st-success) 14%, transparent)', color: 'var(--st-text)' }}
                  disabled={!sessionId || pendingKeys.has(`file:${fileDiff.name}`)}
                  onClick={() => stageFile(true)}
                  title="Stage file"
                >
                  Stage
                </button>
              )}
              {!isFullyUnstaged && hasStaged && (
                <button
                  type="button"
                  className="px-2 py-1 rounded text-[11px] font-medium st-focus-ring disabled:opacity-40"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--st-warning) 14%, transparent)', color: 'var(--st-text)' }}
                  disabled={!sessionId || pendingKeys.has(`file:${fileDiff.name}`)}
                  onClick={() => stageFile(false)}
                  title="Unstage file"
                >
                  Unstage
                </button>
              )}
              <button
                type="button"
                className="px-2 py-1 rounded text-[11px] font-medium st-focus-ring disabled:opacity-40"
                style={{ backgroundColor: 'color-mix(in srgb, var(--st-danger) 10%, transparent)', color: 'var(--st-text)' }}
                disabled={!sessionId || pendingKeys.has(`file:${fileDiff.name}:restore`)}
                onClick={() => restoreFile()}
                title="Restore file"
              >
                Restore
              </button>
            </>
          )}
        </div>
      </div>

      <div style={containerStyle}>
        {isPreviewing && previewContent ? (
          isImageFile(fileDiff.name) ? (
            <ImagePreview content={previewContent} filePath={fileDiff.name} />
          ) : (
            <MarkdownPreview content={previewContent} />
          )
        ) : fileDiff.hunks.length === 0 ? (
          <div className="px-3 py-6 text-xs" style={{ color: 'var(--st-text-faint)' }}>
            {isImageFile(fileDiff.name) ? 'Binary file (image)' : isBinaryFile(fileDiff.name) ? 'Binary file' : 'Diff unavailable.'}
          </div>
        ) : (
          <FileDiff<HunkStatusAnnotation>
            fileDiff={fileDiffForRender}
            options={diffOptions as any}
            lineAnnotations={hunkStatusAnnotations}
            renderAnnotation={renderHunkStatusAnnotation}
            renderHoverUtility={() => hoverUtility}
            style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
          />
        )}
      </div>
    </div>
  );
});

export const PierreDiffViewer: React.FC<PierreDiffViewerProps> = memo(function PierreDiffViewer({
  diff,
  sessionId,
  target,
  stagedDiff,
  unstagedDiff,
  previewFileSources,
  scrollToFilePath,
  fileOrder,
  className,
  onChanged,
}: PierreDiffViewerProps) {
  const theme = useThemeStore((s) => s.theme);
  const themeType = theme === 'light' ? 'light' : 'dark';

  const isCommitView = target?.kind === 'commit';

  const parsedFiles = useMemo(() => {
    return orderFileDiffs(extractFileDiffs(diff), fileOrder);
  }, [diff, fileOrder]);

  const stagedEntriesByFile = useMemo(() => buildHunkHeaderEntries(stagedDiff), [stagedDiff]);
  const unstagedEntriesByFile = useMemo(() => buildHunkHeaderEntries(unstagedDiff), [unstagedDiff]);

  const autoPreviewPaths = useMemo(() => {
    return parsedFiles.map((f) => f.name).filter((p) => isImageFile(p));
  }, [parsedFiles]);
  const { previewFiles, togglePreview } = useFilePreviewState(autoPreviewPaths, { defaultPreview: true });

  const enableWorkerPool = typeof window !== 'undefined' && typeof Worker !== 'undefined';
  const poolOptions = useMemo(() => (enableWorkerPool ? { workerFactory } : undefined), [enableWorkerPool]);
  const highlighterOptions = useMemo(
    () => ({ theme: { dark: 'pierre-dark', light: 'pierre-light' } }),
    []
  );

  const content = (
    <div className={className ? `h-full ${className}` : 'h-full'}>
      <div className="h-full overflow-y-auto" data-testid="diff-scroll-container" style={{ paddingBottom: 12 }}>
        {parsedFiles.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs" style={{ color: 'var(--st-text-faint)' }}>
            No changes to display
          </div>
        ) : (
          parsedFiles.map((file) => (
            <FileCard
              key={file.cacheKey ?? file.name}
              fileDiff={file}
              stagedEntries={stagedEntriesByFile.get(file.name)}
              unstagedEntries={unstagedEntriesByFile.get(file.name)}
              previewContent={previewFileSources?.[file.name]}
              isCommitView={Boolean(isCommitView)}
              sessionId={sessionId}
              target={target}
              enableContextLoading={Boolean(sessionId && target)}
              onChanged={onChanged}
              scrollToSelf={Boolean(scrollToFilePath && file.name === scrollToFilePath)}
              isPreviewing={previewFiles.has(file.name)}
              onTogglePreview={() => togglePreview(file.name)}
              themeType={themeType}
            />
          ))
        )}
      </div>
    </div>
  );

  if (!enableWorkerPool) return content;
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions as any} highlighterOptions={highlighterOptions as any}>
      {content}
    </WorkerPoolContextProvider>
  );
});

PierreDiffViewer.displayName = 'PierreDiffViewer';

export default PierreDiffViewer;
