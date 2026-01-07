import { useEffect, useRef, useCallback } from 'react';

export interface HunkEntry {
  hunkKey: string;
}

export interface UseVisibleHunkTrackerOptions {
  hunks: HunkEntry[];
  containerRef: React.RefObject<HTMLElement | null>;
  onVisibleHunkChange: (index: number) => void;
  enabled?: boolean;
}

export function findTopMostVisibleHunk(
  entries: IntersectionObserverEntry[],
  hunkKeyToIdx: Map<string, number>
): number {
  let topMostIdx = -1;
  let topMostY = Infinity;

  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    
    const key = (entry.target as HTMLElement).dataset.hunkKey;
    if (!key) continue;
    
    const idx = hunkKeyToIdx.get(key);
    if (idx === undefined) continue;
    
    const rect = entry.boundingClientRect;
    if (rect.top < topMostY) {
      topMostY = rect.top;
      topMostIdx = idx;
    }
  }

  return topMostIdx;
}

export function useVisibleHunkTracker({
  hunks,
  containerRef,
  onVisibleHunkChange,
  enabled = true,
}: UseVisibleHunkTrackerOptions): void {
  const hunkKeyToIdxRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    hunkKeyToIdxRef.current = new Map(hunks.map((h, i) => [h.hunkKey, i]));
  }, [hunks]);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const topMostIdx = findTopMostVisibleHunk(entries, hunkKeyToIdxRef.current);
      if (topMostIdx >= 0) {
        onVisibleHunkChange(topMostIdx);
      }
    },
    [onVisibleHunkChange]
  );

  useEffect(() => {
    if (!enabled || !containerRef.current || hunks.length === 0) return;

    const observer = new IntersectionObserver(handleIntersection, {
      root: containerRef.current,
      threshold: 0.1,
    });

    const hunkEls = containerRef.current.querySelectorAll('[data-hunk-key]');
    hunkEls.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [enabled, hunks.length, containerRef, handleIntersection]);
}
