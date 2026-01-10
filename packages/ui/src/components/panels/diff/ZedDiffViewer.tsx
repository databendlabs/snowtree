import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Diff, Hunk, getChangeKey, parseDiff, textLinesToHunk, type ChangeData, type DiffType, type HunkData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { API } from '../../../utils/api';

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

type HunkHeaderEntry = {
  sig: string;
  oldStart: number;
  newStart: number;
  header: string;
};

function toFilePath(raw: { newPath: string; oldPath: string }) {
  const newPath = (raw.newPath || '').trim();
  const oldPath = (raw.oldPath || '').trim();
  if (newPath && newPath !== '/dev/null') return newPath;
  if (oldPath && oldPath !== '/dev/null') return oldPath;
  return '(unknown)';
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

function findMatchingHeader(entries: HunkHeaderEntry[] | undefined, sig: string, oldStart: number, newStart: number): string | null {
  if (!entries || entries.length === 0) return null;
  const candidates = entries.filter((e) => e.sig === sig);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.header;

  const exact = candidates.find((e) => e.oldStart === oldStart && e.newStart === newStart);
  if (exact) return exact.header;

  let best = candidates[0]!;
  let bestScore = Math.abs(best.oldStart - oldStart) + Math.abs(best.newStart - newStart);
  for (const c of candidates) {
    const score = Math.abs(c.oldStart - oldStart) + Math.abs(c.newStart - newStart);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best.header;
}

export interface ZedDiffViewerProps {
  diff: string;
  className?: string;
  sessionId?: string;
  currentScope?: Scope;
  stagedDiff?: string;
  unstagedDiff?: string;
  fileSources?: Record<string, string>;
  expandFileContext?: boolean;
  scrollToFilePath?: string;
  fileOrder?: string[];
  isCommitView?: boolean;
  onChanged?: () => void;
  onHunkInfo?: (current: number, total: number) => void;
  onVisibleFileChange?: (path: string | null) => void;
}

export const ZedDiffViewer = forwardRef<ZedDiffViewerHandle, ZedDiffViewerProps>(({ 
  diff,
  className,
  sessionId,
  currentScope: _currentScope,
  stagedDiff,
  unstagedDiff,
  fileSources,
  expandFileContext = false,
  scrollToFilePath,
  fileOrder,
  isCommitView,
  onChanged,
  onHunkInfo,
  onVisibleFileChange,
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
    if (!stagedDiff || stagedDiff.trim() === '') return new Map<string, HunkHeaderEntry[]>();
    const parsed = parseDiff(stagedDiff, { nearbySequences: 'zip' });
    const byFile = new Map<string, HunkHeaderEntry[]>();
    for (const file of parsed) {
      const path = toFilePath(file);
      const list: HunkHeaderEntry[] = [];
      for (const hunk of file.hunks || []) {
        const sig = hunkSignature(hunk);
        if (!sig) continue;
        const header = parseHunkHeader(hunk.content);
        list.push({
          sig,
          oldStart: header?.oldStart ?? hunk.oldStart,
          newStart: header?.newStart ?? hunk.newStart,
          header: hunk.content,
        });
      }
      byFile.set(path, list);
    }
    return byFile;
  }, [stagedDiff]);

  const unstagedHunkHeaderBySig = useMemo(() => {
    if (!unstagedDiff || unstagedDiff.trim() === '') return new Map<string, HunkHeaderEntry[]>();
    const parsed = parseDiff(unstagedDiff, { nearbySequences: 'zip' });
    const byFile = new Map<string, HunkHeaderEntry[]>();
    for (const file of parsed) {
      const path = toFilePath(file);
      const list: HunkHeaderEntry[] = [];
      for (const hunk of file.hunks || []) {
        const sig = hunkSignature(hunk);
        if (!sig) continue;
        const header = parseHunkHeader(hunk.content);
        list.push({
          sig,
          oldStart: header?.oldStart ?? hunk.oldStart,
          newStart: header?.newStart ?? hunk.newStart,
          header: hunk.content,
        });
      }
      byFile.set(path, list);
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
      const expandedHunks = (expandFileContext && hasSource) ? expandToFullFile(f.hunks || [], source || '') : normalizeHunks(f.hunks || []);

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
  }, [diff, fileSources, expandFileContext]);

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

  const restoreFile = useCallback(
    async (filePath: string, hunkKey: string) => {
      if (!sessionId) return;
      try {
        setPending(hunkKey, true);
        await API.sessions.restoreFile(sessionId, { filePath });
        onChanged?.();
      } catch (err) {
        console.error('[Diff] Failed to restore file', { filePath, err });
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [currentHunkIdx, setCurrentHunkIdx] = useState(0);
  const [focusedHunkKey, setFocusedHunkKey] = useState<string | null>(null);
  const [focusedHunkSig, setFocusedHunkSig] = useState<{ filePath: string; sig: string; oldStart: number; newStart: number } | null>(null);
  const [hoveredHunkKey, setHoveredHunkKey] = useState<string | null>(null);
  const [overlayTopPx, setOverlayTopPx] = useState<number | null>(null);

  const activeHunkKey = hoveredHunkKey ?? focusedHunkKey;

  const fileByPath = useMemo(() => {
    const map = new Map<string, FileModel>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  const allHunks = useMemo(() => {
    const result: Array<{ filePath: string; hunkKey: string; sig: string; oldStart: number; newStart: number; hunkHeader: string; isStaged: boolean; isUntracked: boolean }> = [];
    for (const file of files) {
      const stagedEntries = stagedHunkHeaderBySig.get(file.path);
      const unstagedEntries = unstagedHunkHeaderBySig.get(file.path);
      for (const hunk of file.hunks) {
        const sig = hunk.__st_hunkSig;
        if (!sig) continue;
        const stagedHeader = findMatchingHeader(stagedEntries, sig, hunk.oldStart, hunk.newStart);
        const unstagedHeader = findMatchingHeader(unstagedEntries, sig, hunk.oldStart, hunk.newStart);
        const isUntracked = !stagedHeader && !unstagedHeader;
        result.push({
          filePath: file.path,
          hunkKey: hunk.__st_hunkKey,
          sig,
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          hunkHeader: stagedHeader || unstagedHeader || hunk.content,
          isStaged: Boolean(stagedHeader),
          isUntracked,
        });
      }
    }
    return result;
  }, [files, stagedHunkHeaderBySig, unstagedHunkHeaderBySig]);

  const activeHunk = useMemo(() => {
    if (!activeHunkKey) return null;
    return allHunks.find((h) => h.hunkKey === activeHunkKey) ?? null;
  }, [allHunks, activeHunkKey]);

  const updateOverlayPosition = useCallback(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !activeHunkKey) {
      setOverlayTopPx(null);
      return;
    }

    const anchor = scroller.querySelector(`[data-hunk-key="${activeHunkKey}"][data-hunk-anchor="true"]`) as HTMLElement | null;
    if (!anchor) {
      setOverlayTopPx(null);
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const rawTop = anchorRect.top - scrollerRect.top;
    if (rawTop < 0 || rawTop > scrollerRect.height) {
      setOverlayTopPx(null);
      return;
    }
    const clamped = Math.max(24, Math.min(rawTop, scrollerRect.height - 24));
    setOverlayTopPx(clamped);
  }, [activeHunkKey]);

  const computeTopMostVisibleHunkIdx = useCallback((): number => {
    const root = scrollContainerRef.current;
    if (!root) return -1;
    if (allHunks.length === 0) return -1;

    const rootRect = root.getBoundingClientRect();
    let bestIdx = -1;
    let bestTop = Infinity;

    for (let i = 0; i < allHunks.length; i++) {
      const key = allHunks[i]!.hunkKey;
      const el = root.querySelector(`[data-hunk-key="${key}"]`) as HTMLElement | null;
      if (!el) continue;
      // Treat the "hunk position" as the first changed row (Zed's hunk ranges are based on changed rows).
      const hunkRoot = el.closest('.diff-hunk') as HTMLElement | null;
      let targetEl: HTMLElement = el;
      if (hunkRoot) {
        const rows = Array.from(hunkRoot.querySelectorAll('tr.diff-line')) as HTMLElement[];
        const firstChangedRow = rows.find((row) => Boolean(row.querySelector('.diff-code-insert, .diff-code-delete')));
        if (firstChangedRow) targetEl = firstChangedRow;
      }
      const rect = targetEl.getBoundingClientRect();
      if (rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) continue;
      const top = rect.top - rootRect.top;
      if (top < bestTop) {
        bestTop = top;
        bestIdx = i;
      }
    }

    return bestIdx;
  }, [allHunks]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;

    let raf = 0;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const idx = computeTopMostVisibleHunkIdx();
        if (idx >= 0) setCurrentHunkIdx(idx);
        updateOverlayPosition();
      });
    };

    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      root.removeEventListener('scroll', onScroll);
    };
  }, [computeTopMostVisibleHunkIdx, updateOverlayPosition]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const onMouseMove = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;

      // Keep hover state stable when moving from the hunk body into the floating controls.
      const anchorEl = target.closest('[data-hunk-key]') as HTMLElement | null;
      if (anchorEl) {
        const next = anchorEl.getAttribute('data-hunk-key') ?? null;
        setHoveredHunkKey((prev) => (prev === next ? prev : next));
        return;
      }

      const hunkRoot = target.closest('.diff-hunk') as HTMLElement | null;
      if (!hunkRoot) return;
      const anchor = hunkRoot.querySelector('[data-hunk-key]') as HTMLElement | null;
      const next = anchor?.getAttribute('data-hunk-key') ?? null;
      setHoveredHunkKey((prev) => (prev === next ? prev : next));
    };

    const onMouseLeave = () => setHoveredHunkKey(null);

    root.addEventListener('mousemove', onMouseMove, { passive: true });
    root.addEventListener('mouseleave', onMouseLeave);
    return () => {
      root.removeEventListener('mousemove', onMouseMove);
      root.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  useEffect(() => {
    updateOverlayPosition();
  }, [activeHunkKey, updateOverlayPosition]);

  useEffect(() => {
    onHunkInfo?.(currentHunkIdx + 1, allHunks.length);
  }, [currentHunkIdx, allHunks.length, onHunkInfo]);

  useEffect(() => {
    if (!focusedHunkSig) return;
    const candidates = allHunks
      .map((h, idx) => ({ h, idx }))
      .filter(({ h }) => h.filePath === focusedHunkSig.filePath && h.sig === focusedHunkSig.sig);

    if (candidates.length === 0) {
      setFocusedHunkKey(null);
      setFocusedHunkSig(null);
      return;
    }

    let best = candidates[0]!;
    let bestScore = Math.abs(best.h.oldStart - focusedHunkSig.oldStart) + Math.abs(best.h.newStart - focusedHunkSig.newStart);
    for (const c of candidates) {
      const score = Math.abs(c.h.oldStart - focusedHunkSig.oldStart) + Math.abs(c.h.newStart - focusedHunkSig.newStart);
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
    }

    const idx = best.idx;
    const key = best.h.hunkKey ?? null;
    if (key && key !== focusedHunkKey) setFocusedHunkKey(key);
    if (idx !== currentHunkIdx) setCurrentHunkIdx(idx);
  }, [allHunks, focusedHunkSig, focusedHunkKey, currentHunkIdx]);

  const navigateToHunk = useCallback((direction: 'prev' | 'next') => {
    if (allHunks.length === 0) return;
    const currentIdx = (() => {
      if (focusedHunkSig) {
        const candidates = allHunks
          .map((h, idx) => ({ h, idx }))
          .filter(({ h }) => h.filePath === focusedHunkSig.filePath && h.sig === focusedHunkSig.sig);
        if (candidates.length > 0) {
          let best = candidates[0]!;
          let bestScore = Math.abs(best.h.oldStart - focusedHunkSig.oldStart) + Math.abs(best.h.newStart - focusedHunkSig.newStart);
          for (const c of candidates) {
            const score = Math.abs(c.h.oldStart - focusedHunkSig.oldStart) + Math.abs(c.h.newStart - focusedHunkSig.newStart);
            if (score < bestScore) {
              best = c;
              bestScore = score;
            }
          }
          return best.idx;
        }
      }
      const visible = computeTopMostVisibleHunkIdx();
      return visible >= 0 ? visible : Math.max(0, Math.min(currentHunkIdx, allHunks.length - 1));
    })();

    // Zed's behavior: wrap-around navigation.
    const newIdx = direction === 'next'
      ? (currentIdx >= allHunks.length - 1 ? 0 : currentIdx + 1)
      : (currentIdx <= 0 ? allHunks.length - 1 : currentIdx - 1);

    setCurrentHunkIdx(newIdx);
    const target = allHunks[newIdx];
    const targetKey = target?.hunkKey;
    if (target && target.sig) setFocusedHunkSig({ filePath: target.filePath, sig: target.sig, oldStart: target.oldStart, newStart: target.newStart });
    setFocusedHunkKey(targetKey ?? null);
    const scroller = scrollContainerRef.current;
    if (targetKey && scroller) {
      const el = scroller.querySelector(`[data-hunk-key="${targetKey}"]`) as HTMLElement | null;
      if (el) {
        const hunkRoot = el.closest('.diff-hunk') as HTMLElement | null;
        let targetEl: HTMLElement = el;
        if (hunkRoot) {
          const rows = Array.from(hunkRoot.querySelectorAll('tr.diff-line')) as HTMLElement[];
          const firstChangedRow = rows.find((row) => Boolean(row.querySelector('.diff-code-insert, .diff-code-delete')));
          if (firstChangedRow) targetEl = firstChangedRow;
        }
        const scrollerRect = scroller.getBoundingClientRect();
        const elRect = targetEl.getBoundingClientRect();
        // Center the hunk controls anchor (similar to Zed's Autoscroll::center()).
        const top = scroller.scrollTop + (elRect.top - scrollerRect.top) - (scroller.clientHeight / 2) + (elRect.height / 2);
        const clamped = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
        scroller.scrollTo({ top: clamped, behavior: 'smooth' });
      }
    }
  }, [allHunks, focusedHunkSig, computeTopMostVisibleHunkIdx, currentHunkIdx]);

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
    const root = scrollContainerRef.current;
    if (!root) return;
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
      { root, threshold: 0.3 }
    );
    const fileHeaders = root.querySelectorAll('[data-diff-file-path]');
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
      <div className="flex-1 relative">
        <div
          ref={scrollContainerRef}
          className="absolute inset-0 overflow-y-auto overflow-x-auto"
          data-testid="diff-scroll-container"
        >
          {files.map((file) => (
            <div key={file.path} data-testid="diff-file" data-diff-file-path={file.path} className="st-diff-file">
              <div
                data-testid="diff-file-header"
                ref={(el) => {
                  if (!el) {
                    fileHeaderRefs.current.delete(file.path);
                    return;
                  }
                  fileHeaderRefs.current.set(file.path, el);
                }}
                className="px-3 py-2 text-xs font-semibold st-diff-file-header"
                style={{
                  backgroundColor: 'var(--st-surface)',
                  borderBottom: '1px solid var(--st-border-variant)',
                }}
              >
                {file.path}
              </div>

              <div className="st-diff-file-body">
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

                    const stagedEntries = stagedHunkHeaderBySig.get(file.path);
                    const unstagedEntries = unstagedHunkHeaderBySig.get(file.path);
                    const stagedHeader = findMatchingHeader(stagedEntries, sig, hunk.oldStart, hunk.newStart);
                    const unstagedHeader = findMatchingHeader(unstagedEntries, sig, hunk.oldStart, hunk.newStart);

                    const hunkStatus: 'staged' | 'unstaged' | 'untracked' =
                      stagedHeader ? 'staged' : unstagedHeader ? 'unstaged' : 'untracked';
                    const statusClass =
                      hunkStatus === 'staged'
                        ? 'st-hunk-status--staged'
                        : hunkStatus === 'unstaged' || hunkStatus === 'untracked'
                          ? 'st-hunk-status--unstaged'
                          : '';

                    const kind = hunkKind(hunk);
                    const kindClass =
                      kind === 'added' ? 'st-hunk-kind--added' : kind === 'deleted' ? 'st-hunk-kind--deleted' : 'st-hunk-kind--modified';
                    const hunkKey = (hunk as any).__st_hunkKey as string;
                    const isFocused =
                      focusedHunkKey === hunkKey ||
                      (focusedHunkSig != null &&
                        focusedHunkSig.filePath === file.path &&
                        focusedHunkSig.sig === sig &&
                        (Math.abs(focusedHunkSig.oldStart - hunk.oldStart) + Math.abs(focusedHunkSig.newStart - hunk.newStart) <= 4));
                    const isHovered = hoveredHunkKey === hunkKey;

                    // Anchor controls near the hunk start (Zed places controls at the start of the changed range,
                    // not on surrounding context lines). `react-diff-view` widgets render *after* the keyed line,
                    // so we prefer the line *before* the first changed line when available (i.e. the last context
                    // line right above the hunk), otherwise fall back to the first changed line.
                    const firstChangedIdx = changes.findIndex((c) => c.type === 'insert' || c.type === 'delete');
                    const anchorChange =
                      firstChangedIdx > 0
                        ? changes[firstChangedIdx - 1]!
                        : firstChangedIdx === 0
                          ? changes[0]!
                          : first;
                    const changeKey = getChangeKey(anchorChange);

                    const element: React.ReactElement | null = isCommitView ? null : (
                      <div
                        data-testid="diff-hunk-controls"
                        data-hunk-key={hunkKey}
                        data-hunk-anchor="true"
                        className={`st-diff-hunk-actions-anchor ${statusClass} ${kindClass} ${isFocused ? 'st-hunk-focused' : ''} ${isHovered ? 'st-hunk-hovered' : ''}`}
                      >
                        {hunkStatus === 'staged' && (
                          <div className="st-hunk-staged-badge-sticky" aria-label="Hunk staged">
                            <div className="st-hunk-staged-badge" title="Staged" aria-hidden="true">
                              <svg viewBox="0 0 16 16" width="10" height="10" fill="none">
                                <path
                                  d="M3.5 8.2l2.6 2.6L12.6 4.6"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </div>
                          </div>
                        )}
                      </div>
                    );

                        return [changeKey, element] as const;
                      })
                      .filter((e): e is readonly [string, React.ReactElement | null] => e !== null)
                  ) as Record<string, React.ReactElement | null>}
                >
                  {(hunks) => hunks.map((hunk) => <Hunk key={(hunk as any).__st_hunkKey as string} hunk={hunk} />)}
                </Diff>
              </div>
            </div>
          ))}
        </div>

        {!isCommitView && activeHunk && overlayTopPx != null && (() => {
          const file = fileByPath.get(activeHunk.filePath);
          if (!file) return null;
          const hunkStatus: 'staged' | 'unstaged' | 'untracked' = activeHunk.isUntracked ? 'untracked' : activeHunk.isStaged ? 'staged' : 'unstaged';
          const stageLabel = hunkStatus === 'staged' ? 'Unstage' : 'Stage';
          const canStageOrUnstage = Boolean(sessionId);
          const canRestore = Boolean(sessionId && (hunkStatus === 'staged' || hunkStatus === 'unstaged'));
          const hunkKey = activeHunk.hunkKey;
          const isPending = pendingHunkKeys.has(hunkKey);

          return (
            <div className="st-diff-actions-overlay" data-testid="diff-hunk-actions-overlay">
              <div
                className="st-diff-actions-overlay-inner"
                data-hunk-key={hunkKey}
                style={{ top: `${overlayTopPx}px` }}
              >
                <div className="st-diff-hunk-actions">
                  <button
                    type="button"
                    data-testid="diff-hunk-stage"
                    disabled={!canStageOrUnstage || isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusedHunkKey(hunkKey);
                      setHoveredHunkKey(hunkKey);
                      if (hunkStatus === 'untracked') return stageFile(file.path, true, hunkKey);
                      if (file.diffType === 'delete') return stageFile(file.path, stageLabel === 'Stage', hunkKey);
                      stageOrUnstageHunk(file.path, stageLabel === 'Stage', activeHunk.hunkHeader, hunkKey);
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
                      disabled={!canRestore || isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocusedHunkKey(hunkKey);
                        setHoveredHunkKey(hunkKey);
                        if (file.diffType === 'delete') return restoreFile(file.path, hunkKey);
                        restoreHunk(file.path, hunkStatus === 'staged' ? 'staged' : 'unstaged', activeHunk.hunkHeader, hunkKey);
                      }}
                      className="st-diff-hunk-btn"
                      title={canRestore ? (file.diffType === 'delete' ? 'Restore file' : 'Restore hunk') : 'Unavailable'}
                    >
                      {isPending ? '…' : 'Restore'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      <style>
        {`
          :root {
            --st-diff-line-height: 20px;
            /* Zed-like hunk padding (blank line feel). */
            --st-diff-hunk-pad-y: 30px;
            /* Zed-like: square hunks (no rounding). */
            --st-diff-hunk-radius: 0px;
            --st-diff-gutter-width: 54px;
          }

          /* Horizontal-scroll behavior: code scrolls, but headers/gutters stay fixed (Zed-like). */
          .st-diff-file-header {
            position: sticky;
            left: 0;
            right: 0;
            z-index: 20;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            width: 100%;
            min-width: 0;
          }

          /* Ensure headers are sized to the viewport, not to the max-content table width. */
          .st-diff-file { width: 100%; }
          .st-diff-file-body { width: 100%; }

          .st-diff-table.diff { table-layout: auto; border-collapse: separate; border-spacing: 0; }
          .st-diff-table .diff-line { font-size: 12px; line-height: 20px; }
          /* No grid lines (Zed-like). */
          .st-diff-table .diff-line td { border-bottom: 0; }
          .st-diff-table .diff-gutter { padding: 0 10px; border-right: 0; min-width: var(--st-diff-gutter-width); width: var(--st-diff-gutter-width); }
          /* Ensure the <colgroup> (if present) matches our gutter widths (prevents sticky overlap). */
          .st-diff-table col.diff-gutter-col { width: var(--st-diff-gutter-width); }
          /* Zed-like: preserve long lines and allow horizontal scrolling. */
          .st-diff-table { width: max-content; min-width: 100%; }
          .st-diff-table .diff-code { padding: 0 10px; white-space: pre; overflow-wrap: normal; word-break: normal; }
          /* Ensure per-line backgrounds extend across the full scrollable width. */
          .st-diff-table td.diff-code-insert,
          .st-diff-table pre.diff-code-insert { background-color: var(--diff-code-insert-background-color); }
          .st-diff-table td.diff-code-delete,
          .st-diff-table pre.diff-code-delete { background-color: var(--diff-code-delete-background-color); }
          .st-diff-table td.diff-gutter-normal { background-color: var(--st-surface); }
          .st-diff-table td.diff-gutter-insert { background-color: var(--diff-gutter-insert-background-color); }
          .st-diff-table td.diff-gutter-delete { background-color: var(--diff-gutter-delete-background-color); }

          /* Keep both line-number gutters fixed while horizontally scrolling the code. */
          .st-diff-table.diff-unified tr.diff-line > td.diff-gutter:nth-child(1) {
            position: sticky;
            left: 0;
            z-index: 21;
            background-color: var(--st-surface);
            box-shadow: 1px 0 0 color-mix(in srgb, var(--st-border-variant) 85%, transparent);
          }
          .st-diff-table.diff-unified tr.diff-line > td.diff-gutter:nth-child(2) {
            position: sticky;
            left: var(--st-diff-gutter-width);
            z-index: 20;
            background-color: var(--st-surface);
            box-shadow: 1px 0 0 color-mix(in srgb, var(--st-border-variant) 85%, transparent);
          }

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
          /* Zed-like: indicate hunks via a narrow gutter strip on changed rows (not full block backgrounds). */
          .st-diff-table tr.diff-line:has(.diff-code-insert, .diff-code-delete) td.diff-gutter:first-of-type::before {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            background: var(--st-hunk-marker-color);
            opacity: 1;
            pointer-events: none;
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--staged) tr.diff-line:has(.diff-code-insert, .diff-code-delete) td.diff-gutter:first-of-type::before {
            opacity: 0.75;
          }

          .st-diff-table .diff-hunk:has(.st-hunk-focused) {
            outline: 1px solid color-mix(in srgb, var(--st-accent) 50%, transparent);
            outline-offset: -1px;
            border-radius: 4px;
          }

          /* The widget row is used only as an "anchor"; it should not consume height. */
          .st-diff-table .diff-widget { height: 0; }
          .st-diff-table .diff-widget td { padding: 0; border: 0; height: 0; overflow: visible; }
          .st-diff-table .diff-widget-content { padding: 0; border: 0; height: 0; overflow: visible; }

          .st-diff-table .st-diff-hunk-actions-anchor { height: 0; position: relative; }

          /* Overlay layer: keeps hover controls visible while horizontally scrolling/dragging. */
          .st-diff-actions-overlay {
            position: absolute;
            inset: 0;
            z-index: 90;
            pointer-events: none;
          }
          .st-diff-actions-overlay-inner {
            position: absolute;
            right: 14px;
            transform: translateY(-50%);
            /* Let vertical scrolling gestures pass through to the underlying scroll container. */
            pointer-events: none;
          }
          .st-diff-hunk-actions {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border-radius: 10px;
            background: color-mix(in srgb, var(--st-surface) 80%, transparent);
            border: 1px solid color-mix(in srgb, var(--st-border-variant) 85%, transparent);
            box-shadow: 0 10px 28px color-mix(in srgb, #000 35%, transparent);
            backdrop-filter: blur(6px);
          }
          .st-diff-actions-overlay-inner .st-diff-hunk-btn {
            pointer-events: auto;
          }

          /* Persistent staged badge (not hover-only). */
          /* Sticky wrapper so the badge stays in the left rail while horizontally scrolling. */
          .st-diff-table .st-hunk-staged-badge-sticky {
            position: sticky;
            /* Inside the first gutter, numbers are right-aligned, so a small badge on the left won't cover them. */
            left: 6px;
            z-index: 60;
            width: 0;
            height: 0;
            pointer-events: none;
          }
          .st-diff-table .st-hunk-staged-badge {
            position: absolute;
            top: 0;
            transform: translateY(-50%);
            left: 0;
            width: 14px;
            height: 14px;
            border-radius: 999px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid color-mix(in srgb, var(--st-hunk-frame-color) 70%, var(--st-border-variant));
            background: color-mix(in srgb, var(--st-hunk-frame-color) 18%, var(--st-surface));
            color: color-mix(in srgb, var(--st-hunk-frame-color) 85%, var(--st-text));
            box-shadow: 0 0 0 2px color-mix(in srgb, var(--st-bg) 60%, transparent);
          }


          .st-diff-hunk-btn {
            font-size: 12px;
            min-width: 68px;
            display: inline-flex;
            justify-content: center;
            align-items: center;
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
          .st-diff-table .diff-gutter > a { color: var(--st-text-muted); font-weight: 500; }
          .st-diff-table .diff-gutter:hover > a { color: var(--st-text); }
        `}
      </style>
    </div>
  );
});

ZedDiffViewer.displayName = 'ZedDiffViewer';

export default ZedDiffViewer;
