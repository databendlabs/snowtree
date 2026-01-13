import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Diff, Hunk, getChangeKey, parseDiff, textLinesToHunk, type ChangeData, type DiffType, type HunkData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { Eye, EyeOff, Plus, Minus, RotateCcw } from 'lucide-react';
import { API } from '../../../utils/api';
import { MarkdownPreview } from './MarkdownPreview';
import { isMarkdownFile } from './utils/fileUtils';

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

  // Markdown preview state - tracks which files are in preview mode
  const [previewFiles, setPreviewFiles] = useState<Set<string>>(() => new Set());

  const togglePreview = useCallback((path: string) => {
    setPreviewFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
  const [overlayTopPx, setOverlayTopPx] = useState<number>(24);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayPinnedHunkKey, setOverlayPinnedHunkKey] = useState<string | null>(null);
  const [uiPendingVersion, setUiPendingVersion] = useState(0);

  const activeHunkKey = hoveredHunkKey ?? focusedHunkKey;
  const overlayKey = activeHunkKey ?? overlayPinnedHunkKey;

  const uiPendingRef = useRef<
    Map<
      string,
      | { kind: 'status'; expectedStaged: boolean; deadlineMs: number }
      | { kind: 'gone'; deadlineMs: number }
    >
  >(new Map());

  const stableHunkId = useCallback((h: { filePath: string; sig: string; oldStart: number; newStart: number }) => {
    return `${h.filePath}:${h.sig}:${h.oldStart}:${h.newStart}`;
  }, []);

  const setUiPending = useCallback(
    (
      h: { filePath: string; sig: string; oldStart: number; newStart: number },
      next:
        | { kind: 'status'; expectedStaged: boolean }
        | { kind: 'gone' }
    ) => {
      const id = stableHunkId(h);
      const deadlineMs = Date.now() + 4000;
      uiPendingRef.current.set(id, { ...next, deadlineMs } as any);
      setUiPendingVersion((v) => v + 1);
      window.setTimeout(() => {
        const cur = uiPendingRef.current.get(id);
        if (!cur) return;
        if (Date.now() < cur.deadlineMs) return;
        uiPendingRef.current.delete(id);
        setUiPendingVersion((v) => v + 1);
      }, 4100);
    },
    [stableHunkId]
  );

  const pinOverlay = useCallback((hunkKey: string) => {
    setOverlayPinnedHunkKey(hunkKey);
  }, []);

  useEffect(() => {
    if (!overlayPinnedHunkKey) return;
    if (pendingHunkKeys.has(overlayPinnedHunkKey)) return;
    const t = window.setTimeout(() => {
      // Clear only if nothing else is controlling the overlay.
      if (activeHunkKey == null) setOverlayPinnedHunkKey(null);
    }, 250);
    return () => window.clearTimeout(t);
  }, [overlayPinnedHunkKey, pendingHunkKeys, activeHunkKey]);

  const fileByPath = useMemo(() => {
    const map = new Map<string, FileModel>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  const hscrollRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const visibleHScrollersRef = useRef<Set<string>>(new Set());
  const hscrollLeftRef = useRef(0);
  const hscrollSyncingRef = useRef(false);
  const hscrollRafRef = useRef<number | null>(null);
  const hscrollPendingRef = useRef<{ left: number; source?: string } | null>(null);

  const xScrollbarRef = useRef<HTMLDivElement>(null);
  const xScrollbarTrackRef = useRef<HTMLDivElement>(null);
  const xScrollbarThumbRef = useRef<HTMLDivElement>(null);
  const [xScrollbarContentWidth, setXScrollbarContentWidth] = useState(0);
  const scheduleXScrollbarWidthUpdateRef = useRef<number | null>(null);
  const xbarThumbRafRef = useRef<number | null>(null);
  const xbarDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startScrollLeft: number;
    thumbWidthPx: number;
    maxScrollLeft: number;
    trackWidthPx: number;
  } | null>(null);

  const scheduleXScrollbarWidthUpdate = useCallback(() => {
    if (scheduleXScrollbarWidthUpdateRef.current != null) return;
    scheduleXScrollbarWidthUpdateRef.current = requestAnimationFrame(() => {
      scheduleXScrollbarWidthUpdateRef.current = null;
      let max = 0;
      for (const el of hscrollRefs.current.values()) {
        max = Math.max(max, el.scrollWidth);
      }
      setXScrollbarContentWidth((prev) => (Math.abs(prev - max) < 1 ? prev : max));
    });
  }, []);

  const scheduleXbarThumbUpdate = useCallback(() => {
    if (xbarThumbRafRef.current != null) return;
    xbarThumbRafRef.current = requestAnimationFrame(() => {
      xbarThumbRafRef.current = null;
      const xbar = xScrollbarRef.current;
      const thumb = xScrollbarThumbRef.current;
      if (!xbar || !thumb) return;

      const clientWidth = xbar.clientWidth;
      const scrollWidth = xbar.scrollWidth;
      const max = Math.max(0, scrollWidth - clientWidth);

      if (clientWidth <= 0 || max <= 0) {
        thumb.style.opacity = '0';
        thumb.style.width = `${Math.max(0, clientWidth)}px`;
        thumb.style.transform = 'translateX(0px)';
        return;
      }

      const minThumb = 28;
      const thumbWidth = Math.max(minThumb, Math.round((clientWidth / scrollWidth) * clientWidth));
      const leftPx = Math.round((xbar.scrollLeft / max) * (clientWidth - thumbWidth));
      thumb.style.opacity = '1';
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.transform = `translateX(${leftPx}px)`;
    });
  }, []);

  const flushHScrollSync = useCallback(() => {
    hscrollRafRef.current = null;

    // Don't drop updates that arrive while we're still ignoring the synthetic
    // scroll events caused by programmatic scrollLeft assignments.
    if (hscrollSyncingRef.current) {
      if (hscrollPendingRef.current) {
        hscrollRafRef.current = requestAnimationFrame(flushHScrollSync);
      }
      return;
    }

    const pending = hscrollPendingRef.current;
    if (!pending) return;
    hscrollPendingRef.current = null;

    hscrollSyncingRef.current = true;
    try {
      for (const [path, el] of hscrollRefs.current.entries()) {
        if (pending.source && pending.source !== '__xbar' && path === pending.source) continue;
        if (Math.abs(el.scrollLeft - pending.left) > 0.5) el.scrollLeft = pending.left;
      }

      if (pending.source !== '__xbar') {
        const xbar = xScrollbarRef.current;
        if (xbar && Math.abs(xbar.scrollLeft - pending.left) > 0.5) {
          xbar.scrollLeft = pending.left;
          scheduleXbarThumbUpdate();
        }
      }
    } finally {
      requestAnimationFrame(() => {
        hscrollSyncingRef.current = false;
        if (hscrollPendingRef.current && hscrollRafRef.current == null) {
          hscrollRafRef.current = requestAnimationFrame(flushHScrollSync);
        }
      });
    }
  }, [scheduleXbarThumbUpdate]);

  const scheduleHScrollSync = useCallback(
    (left: number, source?: string) => {
      hscrollLeftRef.current = left;
      hscrollPendingRef.current = { left, source };
      if (hscrollRafRef.current != null) return;
      hscrollRafRef.current = requestAnimationFrame(flushHScrollSync);
    },
    [flushHScrollSync]
  );

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

  const lastActiveHunkRef = useRef<typeof activeHunk>(null);
  useEffect(() => {
    if (activeHunk) lastActiveHunkRef.current = activeHunk;
  }, [activeHunk]);

  const overlayHunk = useMemo(() => {
    if (activeHunk) return activeHunk;
    if (!overlayKey) return null;
    if (pendingHunkKeys.has(overlayKey)) return lastActiveHunkRef.current;
    if (overlayPinnedHunkKey === overlayKey) return lastActiveHunkRef.current;
    return null;
  }, [activeHunk, overlayKey, pendingHunkKeys, overlayPinnedHunkKey]);

  useEffect(() => {
    const now = Date.now();
    let changed = false;

    for (const [id, entry] of uiPendingRef.current.entries()) {
      if (now >= entry.deadlineMs) {
        uiPendingRef.current.delete(id);
        changed = true;
        continue;
      }

      const parts = id.split(':');
      if (parts.length < 4) continue;
      const filePath = parts[0]!;
      const sig = parts[1]!;
      const oldStart = Number(parts[2]!);
      const newStart = Number(parts[3]!);

      const found =
        allHunks.find(
          (h) => h.filePath === filePath && h.sig === sig && h.oldStart === oldStart && h.newStart === newStart
        ) ?? null;

      if (entry.kind === 'gone') {
        if (!found) {
          uiPendingRef.current.delete(id);
          changed = true;
        }
        continue;
      }

      if (found && !found.isUntracked && found.isStaged === entry.expectedStaged) {
        uiPendingRef.current.delete(id);
        changed = true;
      }
    }

    if (changed) setUiPendingVersion((v) => v + 1);
  }, [allHunks, uiPendingVersion]);

  const updateOverlayPosition = useCallback(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !overlayKey) {
      setOverlayVisible(false);
      return;
    }

    const keepVisibleWhilePending = pendingHunkKeys.has(overlayKey) || overlayPinnedHunkKey === overlayKey;
    const anchor = scroller.querySelector(`[data-hunk-key="${overlayKey}"][data-hunk-anchor="true"]`) as HTMLElement | null;
    if (!anchor) {
      if (!keepVisibleWhilePending) setOverlayVisible(false);
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const rawTop = anchorRect.top - scrollerRect.top;
    if (rawTop < 0 || rawTop > scrollerRect.height) {
      if (!keepVisibleWhilePending) setOverlayVisible(false);
      return;
    }
    const clamped = Math.max(24, Math.min(rawTop, scrollerRect.height - 24));
    setOverlayTopPx(clamped);
    setOverlayVisible(true);
  }, [overlayKey, pendingHunkKeys, overlayPinnedHunkKey]);

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
    const root = scrollContainerRef.current;
    if (!root) return;

    // Track which file horizontal scrollers are visible; sync only those to avoid jank on large diffs.
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const path = el.dataset.diffFilePath;
          if (!path) continue;
          if (entry.isIntersecting) {
            if (!visibleHScrollersRef.current.has(path)) {
              visibleHScrollersRef.current.add(path);
              changed = true;
            }
          } else {
            if (visibleHScrollersRef.current.delete(path)) changed = true;
          }
        }
        if (changed) scheduleHScrollSync(hscrollLeftRef.current, '__xbar');
      },
      { root, threshold: 0.1 }
    );

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleXScrollbarWidthUpdate()) : null;

    for (const el of hscrollRefs.current.values()) {
      io.observe(el);
      ro?.observe(el);
    }

    scheduleXScrollbarWidthUpdate();
    scheduleXbarThumbUpdate();

    // Horizontal wheel gestures anywhere in the diff should scroll all files in sync.
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaX) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const xbar = xScrollbarRef.current;
      const max =
        xbar && xbar.clientWidth > 0 ? Math.max(0, xbar.scrollWidth - xbar.clientWidth) : Infinity;
      const next = Math.max(0, Math.min(max, hscrollLeftRef.current + e.deltaX));
      scheduleHScrollSync(next);
    };

    root.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      root.removeEventListener('wheel', onWheel as any, true);
      ro?.disconnect();
      io.disconnect();
    };
  }, [scheduleHScrollSync, scheduleXScrollbarWidthUpdate, scheduleXbarThumbUpdate, files.length]);

  useEffect(() => {
    scheduleXbarThumbUpdate();
  }, [xScrollbarContentWidth, scheduleXbarThumbUpdate]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = xbarDragRef.current;
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      e.preventDefault();

      const xbar = xScrollbarRef.current;
      if (!xbar) return;

      const trackUsable = Math.max(1, drag.trackWidthPx - drag.thumbWidthPx);
      const deltaPx = e.clientX - drag.startClientX;
      const deltaScroll = (deltaPx / trackUsable) * drag.maxScrollLeft;
      const next = Math.max(0, Math.min(drag.maxScrollLeft, drag.startScrollLeft + deltaScroll));
      xbar.scrollLeft = next;
      scheduleHScrollSync(next, '__xbar');
      scheduleXbarThumbUpdate();
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = xbarDragRef.current;
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      xbarDragRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove as any);
      window.removeEventListener('pointerup', onPointerUp as any);
      window.removeEventListener('pointercancel', onPointerUp as any);
    };
  }, [scheduleHScrollSync, scheduleXbarThumbUpdate]);

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
  }, [overlayKey, updateOverlayPosition]);

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

  // Apply status classes directly to tbody.diff-hunk elements based on the anchor inside
  // Also mark first/last changed rows for proper border rendering
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // Find all diff-hunk tbodies and update their status class
    const hunks = root.querySelectorAll('tbody.diff-hunk');
    for (const hunk of hunks) {
      const anchor = hunk.querySelector('.st-diff-hunk-actions-anchor');
      const isStaged = anchor?.classList.contains('st-hunk-status--staged');
      hunk.classList.remove('st-hunk-status--staged', 'st-hunk-status--unstaged');
      hunk.classList.add(isStaged ? 'st-hunk-status--staged' : 'st-hunk-status--unstaged');

      // Mark first and last changed rows for border caps
      const changedRows = hunk.querySelectorAll('tr.diff-line:has(.diff-code-insert, .diff-code-delete)');
      const allRows = hunk.querySelectorAll('tr.diff-line');
      allRows.forEach((row) => {
        row.classList.remove('st-hunk-row-first', 'st-hunk-row-last');
      });
      if (changedRows.length > 0) {
        changedRows[0]?.classList.add('st-hunk-row-first');
        changedRows[changedRows.length - 1]?.classList.add('st-hunk-row-last');
      }
    }
  }, [files, stagedDiff, unstagedDiff]);

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
          ['--st-diff-global-scroll-width' as any]: `${xScrollbarContentWidth}px`,
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
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          data-testid="diff-scroll-container"
          style={{ paddingBottom: 12 }}
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
                onMouseEnter={() => setHoveredHunkKey(null)}
              >
                <div className="st-diff-file-header-content">
                  <span className="st-diff-file-path" data-testid="diff-file-path">{file.path}</span>
                  <div className="st-diff-file-actions">
                    {isMarkdownFile(file.path) && fileSources?.[file.path] && (
                      <button
                        type="button"
                        className="st-diff-preview-btn"
                        onClick={() => togglePreview(file.path)}
                        title={previewFiles.has(file.path) ? 'Show Diff' : 'Preview'}
                      >
                        {previewFiles.has(file.path) ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                    {!isCommitView && (() => {
                      const hasStaged = stagedHunkHeaderBySig.has(file.path);
                      const hasUnstaged = unstagedHunkHeaderBySig.has(file.path);
                      const isFullyStaged = hasStaged && !hasUnstaged;
                      const isFullyUnstaged = !hasStaged && hasUnstaged;
                      return (
                        <>
                          {!isFullyStaged && (
                            <button
                              type="button"
                              className="st-diff-file-action-btn st-diff-file-action-stage"
                              onClick={() => stageFile(file.path, true, `file:${file.path}`)}
                              title="Stage file"
                            >
                              <Plus size={14} />
                              <span>Stage</span>
                            </button>
                          )}
                          {!isFullyUnstaged && hasStaged && (
                            <button
                              type="button"
                              className="st-diff-file-action-btn st-diff-file-action-unstage"
                              onClick={() => stageFile(file.path, false, `file:${file.path}`)}
                              title="Unstage file"
                            >
                              <Minus size={14} />
                              <span>Unstage</span>
                            </button>
                          )}
                          <button
                            type="button"
                            className="st-diff-file-action-btn st-diff-file-action-restore"
                            onClick={() => restoreFile(file.path, `file:${file.path}`)}
                            title="Restore file"
                          >
                            <RotateCcw size={14} />
                            <span>Restore</span>
                          </button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>

              <div className="st-diff-file-body">
                {previewFiles.has(file.path) && fileSources?.[file.path] ? (
                  <MarkdownPreview content={fileSources[file.path]} />
                ) : (
                <div
                  data-testid="diff-hscroll-container"
                  className="st-diff-hscroll"
                  data-diff-file-path={file.path}
                  ref={(el) => {
                    if (!el) {
                      hscrollRefs.current.delete(file.path);
                      visibleHScrollersRef.current.delete(file.path);
                      scheduleXScrollbarWidthUpdate();
                      return;
                    }
                    hscrollRefs.current.set(file.path, el);
                    // Align newly mounted scrollers with current global horizontal position.
                    if (Math.abs(el.scrollLeft - hscrollLeftRef.current) > 0.5) el.scrollLeft = hscrollLeftRef.current;
                    scheduleXScrollbarWidthUpdate();
                  }}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (hscrollSyncingRef.current) return;
                    scheduleHScrollSync(el.scrollLeft, file.path);
                  }}
                >
                <Diff
                  viewType="unified"
                  diffType={file.diffType}
                  hunks={file.hunks}
                  className="st-diff-table"
                  widgets={Object.fromEntries(
                    file.hunks
                      .flatMap((hunk) => {
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
                          kind === 'added'
                            ? 'st-hunk-kind--added'
                            : kind === 'deleted'
                              ? 'st-hunk-kind--deleted'
                              : 'st-hunk-kind--modified';
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

                        const anchorElement: React.ReactElement | null = isCommitView ? null : (
                          <div
                            data-testid="diff-hunk-controls"
                            data-hunk-key={hunkKey}
                            data-hunk-anchor="true"
                            className={`st-diff-hunk-actions-anchor ${statusClass} ${kindClass} ${isFocused ? 'st-hunk-focused' : ''} ${isHovered ? 'st-hunk-hovered' : ''}`}
                          >
                          </div>
                        );

                        return [[changeKey, anchorElement] as const];
                      })
                      .filter((e): e is readonly [string, React.ReactElement | null] => e !== null)
                  ) as Record<string, React.ReactElement | null>}
                >
                  {(hunks) => hunks.map((hunk, index) => (
                    <React.Fragment key={(hunk as any).__st_hunkKey as string}>
                      {index > 0 && (
                        <tbody className="st-hunk-separator">
                          <tr><td colSpan={3} /></tr>
                        </tbody>
                      )}
                      <Hunk hunk={hunk} />
                    </React.Fragment>
                  ))}
                </Diff>
                </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {!isCommitView && (
          <div className="st-diff-x-scrollbar-wrap">
            <div
              ref={xScrollbarRef}
              data-testid="diff-x-scrollbar"
              className="st-diff-x-scrollbar"
              onScroll={(e) => {
                scheduleXbarThumbUpdate();
                const el = e.currentTarget;
                if (hscrollSyncingRef.current) return;
                scheduleHScrollSync(el.scrollLeft, '__xbar');
              }}
            >
              <div
                className="st-diff-x-scrollbar-spacer"
                style={{ width: `${Math.max(xScrollbarContentWidth, 1)}px` }}
              />
            </div>

            <div
              ref={xScrollbarTrackRef}
              className="st-diff-x-scrollbar-track"
              onPointerDown={(e) => {
                const xbar = xScrollbarRef.current;
                const thumb = xScrollbarThumbRef.current;
                const track = xScrollbarTrackRef.current;
                if (!xbar || !thumb || !track) return;

                const clientWidth = xbar.clientWidth;
                const scrollWidth = xbar.scrollWidth;
                const max = Math.max(0, scrollWidth - clientWidth);
                if (max <= 0) return;

                const rect = track.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const thumbWidth = thumb.getBoundingClientRect().width || 28;
                const usable = Math.max(1, rect.width - thumbWidth);
                const desiredLeft = Math.max(0, Math.min(usable, clickX - thumbWidth / 2));
                const next = (desiredLeft / usable) * max;
                xbar.scrollLeft = next;
                scheduleHScrollSync(next, '__xbar');
                scheduleXbarThumbUpdate();
              }}
            >
              <div
                ref={xScrollbarThumbRef}
                className="st-diff-x-scrollbar-thumb"
                onPointerDown={(e) => {
                  const xbar = xScrollbarRef.current;
                  const track = xScrollbarTrackRef.current;
                  const thumb = xScrollbarThumbRef.current;
                  if (!xbar || !track || !thumb) return;

                  const max = Math.max(0, xbar.scrollWidth - xbar.clientWidth);
                  if (max <= 0) return;

                  const trackWidthPx = track.getBoundingClientRect().width;
                  const thumbWidthPx = thumb.getBoundingClientRect().width || 28;
                  xbarDragRef.current = {
                    pointerId: e.pointerId,
                    startClientX: e.clientX,
                    startScrollLeft: xbar.scrollLeft,
                    thumbWidthPx,
                    maxScrollLeft: max,
                    trackWidthPx,
                  };
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  e.preventDefault();
                  e.stopPropagation();
                }}
              />
            </div>
          </div>
        )}

        {!isCommitView && (
          <div className="st-diff-actions-overlay" data-testid="diff-hunk-actions-overlay" aria-hidden={!overlayVisible || !overlayHunk}>
            {overlayHunk && (() => {
              const file = fileByPath.get(overlayHunk.filePath);
              if (!file) return null;
              const hunkStatus: 'staged' | 'unstaged' | 'untracked' =
                overlayHunk.isUntracked ? 'untracked' : overlayHunk.isStaged ? 'staged' : 'unstaged';
          const stageLabel = hunkStatus === 'staged' ? 'Unstage' : 'Stage';
          const canStageOrUnstage = Boolean(sessionId);
          const canRestore = Boolean(sessionId && (hunkStatus === 'staged' || hunkStatus === 'unstaged'));
          const hunkKey = overlayHunk.hunkKey;
          const isPending = pendingHunkKeys.has(hunkKey);

          return (
              <div
                className="st-diff-actions-overlay-inner"
                data-hunk-key={hunkKey}
                data-visible={overlayVisible ? 'true' : 'false'}
                style={{ top: `${overlayTopPx}px` }}
              >
                <div className="st-diff-hunk-actions">
                  {(() => {
                    const stable = stableHunkId({
                      filePath: overlayHunk.filePath,
                      sig: overlayHunk.sig,
                      oldStart: overlayHunk.oldStart,
                      newStart: overlayHunk.newStart,
                    });
                    const uiPending = uiPendingRef.current.get(stable) ?? null;
                    const visualPending =
                      isPending ||
                      (uiPending != null &&
                        (uiPending.kind === 'gone' ||
                          (uiPending.kind === 'status' && uiPending.expectedStaged !== overlayHunk.isStaged)));
                    const disabled = !canStageOrUnstage || visualPending;

                    return (
                  <button
                    type="button"
                    data-testid="diff-hunk-stage"
                    data-pending={visualPending ? 'true' : 'false'}
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      pinOverlay(hunkKey);
                      setFocusedHunkKey(hunkKey);
                      setHoveredHunkKey(hunkKey);
                      setUiPending(
                        { filePath: overlayHunk.filePath, sig: overlayHunk.sig, oldStart: overlayHunk.oldStart, newStart: overlayHunk.newStart },
                        { kind: 'status', expectedStaged: stageLabel === 'Stage' }
                      );
                      if (hunkStatus === 'untracked') return stageFile(file.path, true, hunkKey);
                      if (file.diffType === 'delete') return stageFile(file.path, stageLabel === 'Stage', hunkKey);
                      stageOrUnstageHunk(file.path, stageLabel === 'Stage', overlayHunk.hunkHeader, hunkKey);
                    }}
                    className="st-diff-hunk-btn"
                    title={canStageOrUnstage ? `${stageLabel} ${hunkStatus === 'untracked' ? 'file' : 'hunk'}` : 'Unavailable'}
                  >
                    <span className="st-diff-hunk-btn-label">{stageLabel}</span>
                    <span className="st-diff-hunk-btn-spinner" aria-hidden="true" />
                  </button>
                    );
                  })()}

                  {(hunkStatus === 'staged' || hunkStatus === 'unstaged') && (
                    <button
                      type="button"
                      data-testid="diff-hunk-restore"
                      data-pending={isPending ? 'true' : 'false'}
                      disabled={!canRestore || isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        pinOverlay(hunkKey);
                        setFocusedHunkKey(hunkKey);
                        setHoveredHunkKey(hunkKey);
                        setUiPending(
                          { filePath: overlayHunk.filePath, sig: overlayHunk.sig, oldStart: overlayHunk.oldStart, newStart: overlayHunk.newStart },
                          { kind: 'gone' }
                        );
                        if (file.diffType === 'delete') return restoreFile(file.path, hunkKey);
                        restoreHunk(file.path, hunkStatus === 'staged' ? 'staged' : 'unstaged', overlayHunk.hunkHeader, hunkKey);
                      }}
                      className="st-diff-hunk-btn"
                      title={canRestore ? (file.diffType === 'delete' ? 'Restore file' : 'Restore hunk') : 'Unavailable'}
                    >
                      <span className="st-diff-hunk-btn-label">Restore</span>
                      <span className="st-diff-hunk-btn-spinner" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
          );
            })()}
          </div>
        )}
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
          /* Vertical sticky: file header stays at top when scrolling within file */
          .st-diff-file-header {
            position: sticky;
            top: 0;
            left: 0;
            right: 0;
            z-index: 25;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            width: 100%;
            min-width: 0;
          }

          /* File header content layout */
          .st-diff-file-header-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
          }

          .st-diff-file-path {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          /* Markdown preview toggle button */
          .st-diff-preview-btn {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 20px;
            padding: 0;
            background: transparent;
            border: 1px solid var(--st-border-variant);
            border-radius: 4px;
            color: var(--st-text-muted);
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .st-diff-preview-btn:hover {
            background: color-mix(in srgb, var(--st-accent) 15%, transparent);
            border-color: var(--st-accent);
            color: var(--st-text);
          }

          /* File action buttons container */
          .st-diff-file-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
          }

          /* File action buttons */
          .st-diff-file-action-btn {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 3px 8px;
            background: transparent;
            border: 1px solid var(--st-border-variant);
            border-radius: 4px;
            color: var(--st-text-muted);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .st-diff-file-action-btn:hover {
            background: color-mix(in srgb, var(--st-hover) 60%, transparent);
            color: var(--st-text);
          }

          .st-diff-file-action-stage:hover {
            border-color: var(--st-diff-added-marker);
            color: var(--st-diff-added-marker);
          }

          .st-diff-file-action-unstage:hover {
            border-color: var(--st-diff-modified-marker);
            color: var(--st-diff-modified-marker);
          }

          .st-diff-file-action-restore:hover {
            border-color: var(--st-diff-deleted-marker);
            color: var(--st-diff-deleted-marker);
          }

          /* Ensure headers are sized to the viewport, not to the max-content table width. */
          .st-diff-file { width: 100%; }
          .st-diff-file-body { width: 100%; }
          /* Per-file horizontal scrollers are used for layout correctness (sticky gutters/header).
             We hide their scrollbars so the user only sees a single global horizontal scrollbar. */
          .st-diff-hscroll {
            overflow-x: auto;
            overflow-y: visible;
            width: 100%;
            /* Performance: isolate each file's horizontal scroller to reduce reflow/paint during global sync. */
            contain: layout paint;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* IE/Edge legacy */
          }
          .st-diff-hscroll::-webkit-scrollbar {
            width: 0;
            height: 0;
          }
          .st-diff-hscroll::-webkit-scrollbar-thumb { background: transparent; }
          .st-diff-hscroll::-webkit-scrollbar-track { background: transparent; }

          .st-diff-x-scrollbar-wrap {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 12px;
            z-index: 80;
          }

          /* Scroll element (hidden native scrollbar, used only for scrollLeft state). */
          .st-diff-x-scrollbar {
            position: absolute;
            inset: 0;
            overflow-x: auto;
            overflow-y: hidden;
            scrollbar-width: none;
            -ms-overflow-style: none;
            background: transparent;
          }
          .st-diff-x-scrollbar::-webkit-scrollbar { width: 0; height: 0; }
          .st-diff-x-scrollbar-spacer { height: 1px; }

          /* Always-visible custom track + thumb (so it feels like one real scrollbar). */
          .st-diff-x-scrollbar-track {
            position: absolute;
            inset: 2px 8px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--st-surface) 70%, transparent);
            border: 1px solid color-mix(in srgb, var(--st-border-variant) 70%, transparent);
            pointer-events: auto;
          }
          .st-diff-x-scrollbar-thumb {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            border-radius: 999px;
            background: color-mix(in srgb, var(--st-text-faint) 35%, transparent);
            border: 1px solid color-mix(in srgb, var(--st-border-variant) 70%, transparent);
            cursor: ew-resize;
            opacity: 0;
            will-change: transform, width;
          }

          .st-diff-table.diff { table-layout: auto; border-collapse: separate; border-spacing: 0; }
          .st-diff-table .diff-line { font-size: 12px; line-height: 20px; }
          /* No grid lines (Zed-like). */
          .st-diff-table .diff-line td { border-bottom: 0; }
          .st-diff-table .diff-gutter { padding: 0 10px; border-right: 0; min-width: var(--st-diff-gutter-width); width: var(--st-diff-gutter-width); }
          /* Ensure the <colgroup> (if present) matches our gutter widths (prevents sticky overlap). */
          .st-diff-table col.diff-gutter-col { width: var(--st-diff-gutter-width); }
          /* Zed-like: preserve long lines and allow horizontal scrolling. */
          .st-diff-table { width: max-content; min-width: max(100%, var(--st-diff-global-scroll-width, 100%)); }
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
          .st-diff-table .diff-hunk {
            position: relative;
          }
          /* Hunk separator row - spacing between hunks */
          .st-diff-table .st-hunk-separator {
            height: 30px;
          }
          .st-diff-table .st-hunk-separator td {
            padding: 0;
            border: 0;
          }
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
          .st-diff-table tbody.diff-hunk.st-hunk-status--staged:has(.diff-code-insert, .diff-code-delete) {
            --st-hunk-bg: var(--st-hunk-hollow-bg);
          }
          .st-diff-table .diff-hunk:has(.st-hunk-status--unknown) {
            --st-hunk-marker-color: var(--st-text-faint);
            --st-hunk-bg: var(--st-diff-hunk-bg);
            --st-hunk-frame-color: var(--st-text-faint);
          }
          /* Zed-like: indicate hunks via a narrow gutter strip on changed rows. */
          /* Unstaged (default): solid filled bar - full opacity background */
          .st-diff-table tr.diff-line:has(.diff-code-insert, .diff-code-delete) td.diff-gutter:first-of-type::before {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 6px;
            background: var(--st-hunk-marker-color);
            opacity: 1;
            pointer-events: none;
          }
          /* Staged: hollow bar - 30% opacity background + border forming a complete rectangle (Zed style) */
          .st-diff-table tbody.diff-hunk.st-hunk-status--staged tr.diff-line:has(.diff-code-insert, .diff-code-delete) td.diff-gutter:first-of-type::before {
            background: color-mix(in srgb, var(--st-hunk-marker-color) 30%, transparent);
            border-left: 1px solid var(--st-hunk-marker-color);
            border-right: 1px solid var(--st-hunk-marker-color);
            box-sizing: border-box;
          }
          /* Top border cap on first changed row */
          .st-diff-table tbody.diff-hunk.st-hunk-status--staged tr.diff-line.st-hunk-row-first td.diff-gutter:first-of-type::before {
            border-top: 1px solid var(--st-hunk-marker-color);
          }
          /* Bottom border cap on last changed row */
          .st-diff-table tbody.diff-hunk.st-hunk-status--staged tr.diff-line.st-hunk-row-last td.diff-gutter:first-of-type::before {
            border-bottom: 1px solid var(--st-hunk-marker-color);
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
            visibility: hidden;
          }
          .st-diff-actions-overlay-inner[data-visible="true"] {
            visibility: visible;
          }
          .st-diff-actions-overlay-inner[data-visible="false"] {
            visibility: hidden;
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
          .st-diff-actions-overlay-inner[data-visible="false"] .st-diff-hunk-btn {
            pointer-events: none;
          }

          /* Persistent staged badge via CSS ::after on first changed row (professional approach). */
          .st-diff-table tbody.diff-hunk.st-hunk-status--staged tr.diff-line.st-hunk-row-first td.diff-gutter:first-of-type::after {
            content: '✓';
            position: absolute;
            top: 3px;
            left: 8px;
            width: 14px;
            height: 14px;
            border-radius: 999px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 9px;
            font-weight: bold;
            line-height: 1;
            border: 1px solid color-mix(in srgb, var(--st-hunk-frame-color) 70%, var(--st-border-variant));
            background: color-mix(in srgb, var(--st-hunk-frame-color) 18%, var(--st-surface));
            color: color-mix(in srgb, var(--st-hunk-frame-color) 85%, var(--st-text));
            box-shadow: 0 0 0 2px color-mix(in srgb, var(--st-bg) 60%, transparent);
            z-index: 61;
            pointer-events: none;
          }


          .st-diff-hunk-btn {
            font-size: 12px;
            min-width: 68px;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            border-radius: 8px;
            border: 0;
            background: transparent;
            color: color-mix(in srgb, var(--st-text) 92%, white);
            cursor: pointer;
            user-select: none;
          }
          .st-diff-hunk-btn:active { transform: none; }
          .st-diff-hunk-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .st-diff-hunk-btn-label { line-height: 1; }
          .st-diff-hunk-btn-spinner {
            width: 10px;
            height: 10px;
            border-radius: 999px;
            border: 2px solid color-mix(in srgb, var(--st-text) 20%, transparent);
            border-top-color: color-mix(in srgb, var(--st-text) 70%, transparent);
            animation: st-diff-spin 700ms linear infinite;
            visibility: hidden;
          }
          .st-diff-hunk-btn[data-pending="true"] .st-diff-hunk-btn-spinner { visibility: visible; }
          @keyframes st-diff-spin { to { transform: rotate(360deg); } }
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
