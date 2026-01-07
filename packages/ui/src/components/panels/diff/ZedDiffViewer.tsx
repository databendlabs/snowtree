import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Diff, Hunk, getChangeKey, parseDiff, textLinesToHunk, type ChangeData, type DiffType, type HunkData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { API } from '../../../utils/api';
import { useVisibleHunkTracker } from './useVisibleHunkTracker';

export interface ZedDiffViewerHandle {
  navigateToHunk: (direction: 'prev' | 'next') => void;
  stageAll: (stage: boolean) => Promise<void>;
}

type Scope = 'staged' | 'unstaged' | 'untracked';

type FileModel = {
  path: string;
  diffType: DiffType;
  hunks: Array<
    HunkData & {
      __st_hunkKey: string;
      __st_hunkSig: string;
    }
  >;
};

type HunkKind = 'added' | 'deleted' | 'modified';

function toFilePath(raw: { newPath: string; oldPath: string }) {
  return (raw.newPath || raw.oldPath || '(unknown)').trim() || '(unknown)';
}

function parseHunkHeader(content: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const match = content.match(/@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/);
  if (!match) return null;
  const oldStart = parseInt(match[1], 10);
  const oldLines = match[2] == null ? 1 : parseInt(match[2], 10);
  const newStart = parseInt(match[3], 10);
  const newLines = match[4] == null ? 1 : parseInt(match[4], 10);
  return { oldStart, oldLines, newStart, newLines };
}

function hunkSignature(hunk: HunkData): string {
  const changes = hunk.changes as ChangeData[];
  const parts: string[] = [];
  for (const change of changes) {
    if ((change as any).isInsert) parts.push(`+${change.content}`);
    else if ((change as any).isDelete) parts.push(`-${change.content}`);
  }
  return parts.join('\n');
}

function hunkKind(hunk: HunkData): HunkKind | null {
  const changes = hunk.changes as ChangeData[];
  let hasInsert = false;
  let hasDelete = false;
  for (const change of changes) {
    if ((change as any).isInsert) hasInsert = true;
    else if ((change as any).isDelete) hasDelete = true;
  }
  if (!hasInsert && !hasDelete) return null;
  if (hasInsert && hasDelete) return 'modified';
  return hasInsert ? 'added' : 'deleted';
}

function normalizeHunks(hunks: HunkData[]): HunkData[] {
  return hunks.map((h) => {
    const parsed = parseHunkHeader(h.content);
    if (!parsed) return h;
    return Object.assign({}, h, {
      oldStart: parsed.oldStart,
      oldLines: parsed.oldLines,
      newStart: parsed.newStart,
      newLines: parsed.newLines,
    });
  });
}

function expandToFullFile(hunks: HunkData[], source: string): HunkData[] {
  const lines = source.split('\n');
  const normalized = normalizeHunks(hunks).slice().sort((a, b) => (a.oldStart - b.oldStart) || (a.newStart - b.newStart));
  if (normalized.length === 0) {
    const all = textLinesToHunk(lines, 1, 1);
    return all ? [all] : [];
  }

  // New file diffs typically use @@ -0,0 +1,N @@ and already contain the full content as insertions.
  // Expanding using the worktree content would duplicate the file as "plain context" below the inserted hunk.
  if (normalized.some((h) => h.oldStart === 0 && h.oldLines === 0)) {
    return normalized;
  }

  const output: HunkData[] = [];
  let oldCursor = 1;
  let delta = 0; // newLine = oldLine + delta for unchanged lines

  const pushPlain = (start: number, endExclusive: number) => {
    if (endExclusive <= start) return;
    const slice = lines.slice(start - 1, endExclusive - 1);
    const h = textLinesToHunk(slice, start, start + delta);
    if (h) output.push(h);
  };

  for (const h of normalized) {
    const gapEnd = Math.min(Math.max(h.oldStart, 1), lines.length + 1);
    pushPlain(oldCursor, gapEnd);

    output.push(h);

    oldCursor = Math.max(oldCursor, h.oldStart + Math.max(0, h.oldLines));
    delta += h.newLines - h.oldLines;
  }

  pushPlain(oldCursor, lines.length + 1);
  return output;
}

export interface ZedDiffViewerProps {
  diff: string;
  className?: string;
  sessionId?: string;
  currentScope?: Scope;
  stagedDiff?: string;
  unstagedDiff?: string;
  fileSources?: Record<string, string>;
  scrollToFilePath?: string;
  fileOrder?: string[];
  onChanged?: () => void;
  onHunkInfo?: (current: number, total: number) => void;
  onVisibleFileChange?: (path: string | null) => void;
}

export const ZedDiffViewer = forwardRef<ZedDiffViewerHandle, ZedDiffViewerProps>(({ 
  diff, className, sessionId, currentScope: _currentScope, stagedDiff, unstagedDiff, fileSources, scrollToFilePath, fileOrder, onChanged, onHunkInfo, onVisibleFileChange 
}, ref) => {
  const fileHeaderRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [pendingHunkKeys, setPendingHunkKeys] = useState<Set<string>>(() => new Set());

  const setPending = useCallback((key: string, next: boolean) => {
    setPendingHunkKeys((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }, []);

  const stagedHunkHeaderBySig = useMemo(() => {
    if (!stagedDiff || stagedDiff.trim() === '') return new Map<string, Map<string, string>>();
    const parsed = parseDiff(stagedDiff, { nearbySequences: 'zip' });
    const byFile = new Map<string, Map<string, string>>();
    for (const file of parsed) {
      const path = toFilePath(file);
      const m = new Map<string, string>();
      for (const hunk of file.hunks || []) {
        const sig = hunkSignature(hunk);
        if (!sig) continue;
        m.set(sig, hunk.content);
      }
      byFile.set(path, m);
    }
    return byFile;
  }, [stagedDiff]);

  const unstagedHunkHeaderBySig = useMemo(() => {
    if (!unstagedDiff || unstagedDiff.trim() === '') return new Map<string, Map<string, string>>();
    const parsed = parseDiff(unstagedDiff, { nearbySequences: 'zip' });
    const byFile = new Map<string, Map<string, string>>();
    for (const file of parsed) {
      const path = toFilePath(file);
      const m = new Map<string, string>();
      for (const hunk of file.hunks || []) {
        const sig = hunkSignature(hunk);
        if (!sig) continue;
        m.set(sig, hunk.content);
      }
      byFile.set(path, m);
    }
    return byFile;
  }, [unstagedDiff]);

  const files = useMemo<FileModel[]>(() => {
    if (!diff || diff.trim() === '') return [];
    const parsed = parseDiff(diff, { nearbySequences: 'zip' });
    const ordered = (() => {
      const order = Array.isArray(fileOrder) ? fileOrder.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean) : [];
      if (order.length === 0) return parsed;
      const idx = new Map<string, number>();
      order.forEach((p, i) => {
        if (!idx.has(p)) idx.set(p, i);
      });
      return parsed
        .map((f, originalIndex) => ({ f, originalIndex, path: toFilePath(f) }))
        .sort((a, b) => {
          const ai = idx.get(a.path);
          const bi = idx.get(b.path);
          if (ai != null && bi != null) return ai - bi;
          if (ai != null) return -1;
          if (bi != null) return 1;
          return a.originalIndex - b.originalIndex;
        })
        .map((x) => x.f);
    })();

    return ordered.map((f) => {
      const path = toFilePath(f);
      const hasSource = Boolean(fileSources && Object.prototype.hasOwnProperty.call(fileSources, path));
      const source = hasSource ? (fileSources as Record<string, string>)[path] : undefined;
      const expandedHunks = hasSource ? expandToFullFile(f.hunks || [], source || '') : normalizeHunks(f.hunks || []);

      const hunks = expandedHunks.map((hunk, idx) => {
        const sig = hunkSignature(hunk);
        const key = `${path}:${idx}:${hunk.oldStart}-${hunk.newStart}:${sig.length}`;
        const next = Object.assign({}, hunk, {
          __st_hunkKey: key,
          __st_hunkSig: sig,
        });
        return next;
      });

      return {
        path,
        diffType: f.type as DiffType,
        hunks,
      };
    });
  }, [diff, fileSources]);

  const scrollToFile = useCallback((filePath: string) => {
    const el = fileHeaderRefs.current.get(filePath);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
  }, []);

  useEffect(() => {
    if (!scrollToFilePath) return;
    scrollToFile(scrollToFilePath);
  }, [scrollToFilePath, scrollToFile]);

  const stageOrUnstageHunk = useCallback(
    async (filePath: string, isStaging: boolean, hunkHeader: string, hunkKey: string) => {
      if (!sessionId) return;
      try {
        setPending(hunkKey, true);
        await API.sessions.stageHunk(sessionId, { filePath, isStaging, hunkHeader });
        onChanged?.();
      } catch (err) {
        console.error(`[Diff] Failed to ${isStaging ? 'stage' : 'unstage'} hunk`, { filePath, hunkHeader, err });
      } finally {
        setPending(hunkKey, false);
        // Prevent focus from sticking to the old hunk after staging (avoids "hover controls" lingering).
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    },
    [sessionId, onChanged, setPending]
  );

  const restoreHunk = useCallback(
    async (filePath: string, scope: 'staged' | 'unstaged', hunkHeader: string, hunkKey: string) => {
      if (!sessionId) return;
      try {
        setPending(hunkKey, true);
        await API.sessions.restoreHunk(sessionId, { filePath, scope, hunkHeader });
        onChanged?.();
      } catch (err) {
        console.error('[Diff] Failed to restore hunk', { filePath, hunkHeader, err });
      } finally {
        setPending(hunkKey, false);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    },
    [sessionId, onChanged, setPending]
  );

  const stageFile = useCallback(
    async (filePath: string, stage: boolean, hunkKey: string) => {
      if (!sessionId) return;
      try {
        setPending(hunkKey, true);
        await API.sessions.changeFileStage(sessionId, { filePath, stage });
        onChanged?.();
      } catch (err) {
        console.error(`[Diff] Failed to ${stage ? 'stage' : 'unstage'} file`, { filePath, err });
      } finally {
        setPending(hunkKey, false);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    },
    [sessionId, onChanged, setPending]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentHunkIdx, setCurrentHunkIdx] = useState(0);
  const [focusedHunkKey, setFocusedHunkKey] = useState<string | null>(null);

  const allHunks = useMemo(() => {
    const result: Array<{ filePath: string; hunkKey: string; hunkHeader: string; isStaged: boolean; isUntracked: boolean }> = [];
    for (const file of files) {
      const stagedMap = stagedHunkHeaderBySig.get(file.path);
      const unstagedMap = unstagedHunkHeaderBySig.get(file.path);
      for (const hunk of file.hunks) {
        const sig = hunk.__st_hunkSig;
        if (!sig) continue;
        const stagedHeader = stagedMap?.get(sig);
        const unstagedHeader = unstagedMap?.get(sig);
        const isUntracked = !stagedHeader && !unstagedHeader;
        result.push({
          filePath: file.path,
          hunkKey: hunk.__st_hunkKey,
          hunkHeader: stagedHeader || unstagedHeader || hunk.content,
          isStaged: Boolean(stagedHeader),
          isUntracked,
        });
      }
    }
    return result;
  }, [files, stagedHunkHeaderBySig, unstagedHunkHeaderBySig]);

  useVisibleHunkTracker({
    hunks: allHunks,
    containerRef,
    onVisibleHunkChange: setCurrentHunkIdx,
  });

  useEffect(() => {
    onHunkInfo?.(currentHunkIdx + 1, allHunks.length);
  }, [currentHunkIdx, allHunks.length, onHunkInfo]);

  const navigateToHunk = useCallback((direction: 'prev' | 'next') => {
    if (allHunks.length === 0) return;
    let newIdx: number;
    if (direction === 'next') {
      newIdx = currentHunkIdx >= allHunks.length - 1 ? 0 : currentHunkIdx + 1;
    } else {
      newIdx = currentHunkIdx <= 0 ? allHunks.length - 1 : currentHunkIdx - 1;
    }
    setCurrentHunkIdx(newIdx);
    const targetKey = allHunks[newIdx]?.hunkKey;
    setFocusedHunkKey(targetKey ?? null);
    if (targetKey && containerRef.current) {
      const el = containerRef.current.querySelector(`[data-hunk-key="${targetKey}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [allHunks, currentHunkIdx]);

  const stageAll = useCallback(async (stage: boolean) => {
    if (!sessionId) return;
    for (const file of files) {
      try {
        await API.sessions.changeFileStage(sessionId, { filePath: file.path, stage });
      } catch (err) {
        console.error(`[Diff] Failed to ${stage ? 'stage' : 'unstage'} file`, { filePath: file.path, err });
      }
    }
    onChanged?.();
  }, [sessionId, files, onChanged]);

  useImperativeHandle(ref, () => ({
    navigateToHunk,
    stageAll,
  }), [navigateToHunk, stageAll]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const path = (entry.target as HTMLElement).dataset.diffFilePath;
            if (path) {
              onVisibleFileChange?.(path);
              break;
            }
          }
        }
      },
      { root: containerRef.current, threshold: 0.3 }
    );
    const fileHeaders = containerRef.current.querySelectorAll('[data-diff-file-path]');
    fileHeaders.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [files, onVisibleFileChange]);

  if (!diff || diff.trim() === '' || files.length === 0) {
    return <div className={`h-full flex items-center justify-center text-sm ${className ?? ''}`}>No changes</div>;
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Diff viewer"
      data-testid="diff-viewer-zed"
      className={`h-full flex flex-col ${className ?? ''}`}
      style={
        {
          backgroundColor: 'var(--st-bg)',
          color: 'var(--st-text)',
          ['--diff-background-color' as any]: 'var(--st-bg)',
          ['--diff-text-color' as any]: 'var(--st-text)',
          ['--diff-font-family' as any]: 'var(--st-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          ['--diff-selection-background-color' as any]: 'var(--st-selected)',
          ['--diff-selection-text-color' as any]: 'var(--st-text)',
          ['--diff-gutter-insert-background-color' as any]: 'color-mix(in srgb, var(--st-success) 18%, var(--st-bg))',
          ['--diff-gutter-delete-background-color' as any]: 'color-mix(in srgb, var(--st-danger) 18%, var(--st-bg))',
          ['--diff-gutter-selected-background-color' as any]: 'var(--st-selected)',
          ['--diff-code-insert-background-color' as any]: 'color-mix(in srgb, var(--st-success) 12%, var(--st-bg))',
          ['--diff-code-delete-background-color' as any]: 'color-mix(in srgb, var(--st-danger) 12%, var(--st-bg))',
          ['--diff-code-selected-background-color' as any]: 'var(--st-selected)',
        } as React.CSSProperties
      }
    >
      <div className="flex-1 overflow-auto">
        {files.map((file) => (
          <div key={file.path} data-testid="diff-file" data-diff-file-path={file.path}>
            <div
              data-testid="diff-file-header"
              ref={(el) => {
                if (!el) {
                  fileHeaderRefs.current.delete(file.path);
                  return;
                }
                fileHeaderRefs.current.set(file.path, el);
              }}
              className="px-3 py-2 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--st-surface)',
                borderBottom: '1px solid var(--st-border-variant)',
              }}
            >
              {file.path}
            </div>

            <Diff
              viewType="unified"
              diffType={file.diffType}
              hunks={file.hunks}
              className="st-diff-table"
              widgets={Object.fromEntries(
                file.hunks
                  .map((hunk) => {
                    const changes = hunk.changes as ChangeData[];
                    const first = changes[0];
                    if (!first) return null;

                    const sig = (hunk as any).__st_hunkSig as string;
                    const hasEdits = Boolean(sig && sig.length > 0);
                    if (!hasEdits) return null;

                    const stagedMap = stagedHunkHeaderBySig.get(file.path);
                    const unstagedMap = unstagedHunkHeaderBySig.get(file.path);
                    const stagedHeader = stagedMap?.get(sig);
                    const unstagedHeader = unstagedMap?.get(sig);

                    const hunkStatus: 'staged' | 'unstaged' | 'untracked' =
                      stagedHeader ? 'staged' : unstagedHeader ? 'unstaged' : 'untracked';

                    const stageLabel = hunkStatus === 'staged' ? 'Unstage' : 'Stage';
                    const canStageOrUnstage = Boolean(sessionId && hunkStatus !== 'unknown');
                    const canRestore = Boolean(sessionId && (hunkStatus === 'staged' || hunkStatus === 'unstaged'));
                    const stageHeader = hunkStatus === 'staged' ? stagedHeader! : hunkStatus === 'unstaged' ? unstagedHeader! : null;
                    const restoreScope: 'staged' | 'unstaged' = hunkStatus === 'staged' ? 'staged' : 'unstaged';
                    const statusClass =
                      hunkStatus === 'staged'
                        ? 'st-hunk-status--staged'
                        : hunkStatus === 'unstaged' || hunkStatus === 'untracked'
                          ? 'st-hunk-status--unstaged'
                          : 'st-hunk-status--unknown';

                    const kind = hunkKind(hunk);
                    const kindClass =
                      kind === 'added' ? 'st-hunk-kind--added' : kind === 'deleted' ? 'st-hunk-kind--deleted' : 'st-hunk-kind--modified';
                    const hunkKey = (hunk as any).__st_hunkKey as string;
                    const isPending = pendingHunkKeys.has(hunkKey);
                    const isFocused = focusedHunkKey === hunkKey;

                    const changeKey = getChangeKey(first);

                    const element = (
                      <div data-testid="diff-hunk-controls" data-hunk-key={hunkKey} className={`st-diff-hunk-actions-anchor ${statusClass} ${kindClass} ${isFocused ? 'st-hunk-focused' : ''}`}>
                        {hunkStatus === 'staged' && (
                          <div className="st-hunk-staged-badge" aria-label="Hunk staged">
                            staged
                          </div>
                        )}
                        <div className="st-diff-hunk-actions">
                          <button
                            type="button"
                            data-testid="diff-hunk-stage"
                            disabled={!canStageOrUnstage || isPending}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (hunkStatus === 'untracked') return stageFile(file.path, true, hunkKey);
                              if (!stageHeader) return;
                              stageOrUnstageHunk(file.path, stageLabel === 'Stage', stageHeader, hunkKey);
                            }}
                            className="st-diff-hunk-btn"
                            title={canStageOrUnstage ? `${stageLabel} ${hunkStatus === 'untracked' ? 'file' : 'hunk'}` : 'Unavailable'}
                          >
                            {isPending ? '…' : stageLabel}
                          </button>
                          {(hunkStatus === 'staged' || hunkStatus === 'unstaged') && (
                            <button
                              type="button"
                              data-testid="diff-hunk-restore"
                              disabled={!canRestore || isPending || !stageHeader}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                if (!stageHeader) return;
                                restoreHunk(file.path, restoreScope, stageHeader, hunkKey);
                              }}
                              className="st-diff-hunk-btn"
                              title={canRestore ? 'Restore hunk' : 'Unavailable'}
                            >
                              {isPending ? '…' : 'Restore'}
                            </button>
                          )}
                        </div>
                      </div>
                    );

                    return [changeKey, element] as const;
                  })
                  .filter((e): e is readonly [string, React.ReactNode] => Boolean(e))
              )}
            >
              {(hunks) => hunks.map((hunk) => <Hunk key={(hunk as any).__st_hunkKey as string} hunk={hunk} />)}
            </Diff>
          </div>
        ))}
      </div>

      <style>
        {`
          :root {
            --st-diff-line-height: 20px;
            /* Zed-like hunk padding (blank line feel). */
            --st-diff-hunk-pad-y: 30px;
            /* Zed-like: square hunks (no rounding). */
            --st-diff-hunk-radius: 0px;
          }

          .st-diff-table.diff { table-layout: fixed; width: 100%; }
          .st-diff-table .diff-line { font-size: 12px; line-height: 20px; }
          /* No grid lines (Zed-like). */
          .st-diff-table .diff-line td { border-bottom: 0; }
          .st-diff-table .diff-gutter { padding: 0 10px; border-right: 0; }
          .st-diff-table .diff-code { padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }

          /* Zed-like: only "edit hunks" are treated as blocks. */
          .st-diff-table .diff-hunk { position: relative; }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-color: var(--st-diff-modified-marker);
            --st-hunk-marker-color: var(--st-hunk-color);
            /* Zed-like opacities on dark themes:
               - filled: ~0.12
               - hollow:  ~0.06 + border */
            --st-hunk-solid-bg: color-mix(in srgb, var(--st-hunk-color) 12%, transparent);
            --st-hunk-hollow-bg: color-mix(in srgb, var(--st-hunk-color) 6%, transparent);
            --st-hunk-bg: var(--st-hunk-solid-bg);
            --st-hunk-frame-color: var(--st-hunk-color);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-kind--added):has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-color: var(--st-diff-added-marker);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-kind--deleted):has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-color: var(--st-diff-deleted-marker);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-kind--modified):has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-color: var(--st-diff-modified-marker);
          }
          /* Zed-like hunk_style: staged is hollow by default (bordered, faded). */
          .st-diff-table .diff-hunk:has(.st-hunk-status--staged):has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-bg: var(--st-hunk-hollow-bg);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--unknown) {
            --st-hunk-marker-color: var(--st-text-faint);
            --st-hunk-bg: var(--st-diff-hunk-bg);
            --st-hunk-frame-color: var(--st-text-faint);
          }
          /* Spacer: empty line above & below each hunk block. */
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr.diff-line:first-child td {
            padding-top: var(--st-diff-hunk-pad-y);
          }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr.diff-line:last-of-type td {
            padding-bottom: var(--st-diff-hunk-pad-y);
          }

          /* Left block marker bar. */
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete)::before {
            content: '';
            position: absolute;
            left: 6px;
            top: 6px;
            bottom: 6px;
            width: 4px;
            border-radius: 0;
            background: var(--st-hunk-marker-color);
            opacity: 0.85;
            pointer-events: none;
          }

          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete)::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: var(--st-diff-hunk-radius);
            pointer-events: none;
            opacity: 0;
            z-index: 1;
            box-shadow: 0 0 0 1px color-mix(in srgb, var(--st-hunk-frame-color) 36%, transparent);
            transition: opacity 110ms ease;
          }
          /* Zed-like: staged_hollow -> staged has border; unstaged filled -> no border even on hover. */
          .st-diff-table .diff-hunk:has(.st-hunk-status--staged):has(.diff-code-insert, .diff-code-delete)::after {
            opacity: 1;
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--staged):has(.diff-code-insert, .diff-code-delete):hover::after {
            box-shadow: 0 0 0 1px color-mix(in srgb, var(--st-hunk-frame-color) 48%, transparent);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--unstaged):has(.diff-code-insert, .diff-code-delete)::after,
          .st-diff-table .diff-hunk:has(.st-hunk-status--unstaged):has(.diff-code-insert, .diff-code-delete):hover::after {
            opacity: 0;
          }

          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr td {
            background-image: linear-gradient(
              color-mix(in srgb, var(--st-hunk-bg) 85%, transparent),
              color-mix(in srgb, var(--st-hunk-bg) 85%, transparent)
            );
          }

          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr:first-child td:first-child { border-top-left-radius: var(--st-diff-hunk-radius); }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr:first-child td:last-child { border-top-right-radius: var(--st-diff-hunk-radius); }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr:last-child td:first-child { border-bottom-left-radius: var(--st-diff-hunk-radius); }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete) tr:last-child td:last-child { border-bottom-right-radius: var(--st-diff-hunk-radius); }

          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete):hover tr td {
            background-image: linear-gradient(
              color-mix(in srgb, var(--st-hunk-bg) 90%, transparent),
              color-mix(in srgb, var(--st-hunk-bg) 90%, transparent)
            );
          }
          /* Extra contrast on hover (more Zed-like). */
          .st-diff-table .diff-hunk:has(.st-hunk-status--unstaged):has(.diff-code-insert, .diff-code-delete):hover {
            filter: saturate(1.04) brightness(1.02);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--staged):has(.diff-code-insert, .diff-code-delete):hover {
            filter: saturate(1.02) brightness(1.01);
          }

          .st-diff-table .diff-hunk:has(.st-hunk-focused) {
            outline: 1px solid color-mix(in srgb, var(--st-accent) 50%, transparent);
            outline-offset: -1px;
            border-radius: 4px;
          }

          /* The widget row is used only as an "anchor"; it should not consume height. */
          .st-diff-table .diff-widget { height: 0; }
          .st-diff-table .diff-widget td { padding: 0; border: 0; height: 0; }
          .st-diff-table .diff-widget-content { padding: 0; border: 0; height: 0; }

          .st-diff-table .st-diff-hunk-actions-anchor { height: 0; }
          .st-diff-table .st-diff-hunk-actions {
            position: absolute;
            top: 0;
            transform: translateY(-58%);
            right: 10px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border-radius: 10px;
            background: color-mix(in srgb, var(--st-surface) 80%, transparent);
            border: 1px solid color-mix(in srgb, var(--st-hunk-frame-color) 55%, var(--st-border-variant));
            box-shadow: 0 10px 28px color-mix(in srgb, #000 35%, transparent);
            backdrop-filter: blur(6px);
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
            z-index: 5;
          }
          .st-diff-table .diff-hunk:has(.diff-code-insert, .diff-code-delete):hover .st-diff-hunk-actions {
            opacity: 1;
            pointer-events: auto;
          }

          /* Persistent staged badge (not hover-only). */
          .st-diff-table .st-hunk-staged-badge {
            position: absolute;
            left: 14px;
            top: 8px;
            z-index: 3;
            pointer-events: none;
            font-size: 10px;
            line-height: 1;
            padding: 3px 6px;
            border-radius: 6px;
            border: 1px solid color-mix(in srgb, var(--st-hunk-frame-color) 45%, var(--st-border-variant));
            background: color-mix(in srgb, var(--st-hunk-bg) 65%, transparent);
            color: color-mix(in srgb, var(--st-hunk-frame-color) 70%, var(--st-text-muted));
            text-transform: uppercase;
            letter-spacing: 0.02em;
          }


          .st-diff-hunk-btn {
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 8px;
            border: 0;
            background: transparent;
            color: color-mix(in srgb, var(--st-text) 92%, white);
            cursor: pointer;
            user-select: none;
          }
          .st-diff-hunk-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .st-diff-hunk-btn:not(:disabled):hover {
            background: color-mix(in srgb, var(--st-accent) 14%, transparent);
          }

          /* Clearer line numbers: avoid default link color. */
          .st-diff-table .diff-gutter { background: color-mix(in srgb, var(--st-surface) 78%, transparent); }
          .st-diff-table .diff-gutter > a { color: var(--st-text-muted); font-weight: 500; }
          .st-diff-table .diff-gutter:hover > a { color: var(--st-text); }
        `}
      </style>
    </div>
  );
});

ZedDiffViewer.displayName = 'ZedDiffViewer';

export default ZedDiffViewer;
