import { describe, it, expect } from 'vitest';
import { findTopMostVisibleHunk } from './useVisibleHunkTracker';

describe('findTopMostVisibleHunk', () => {
  const createEntry = (
    hunkKey: string,
    top: number,
    isIntersecting: boolean
  ): IntersectionObserverEntry => ({
    target: { dataset: { hunkKey } } as unknown as Element,
    boundingClientRect: { top } as DOMRectReadOnly,
    isIntersecting,
    intersectionRatio: isIntersecting ? 0.5 : 0,
    intersectionRect: {} as DOMRectReadOnly,
    rootBounds: null,
    time: 0,
  });

  it('returns -1 when no entries are intersecting', () => {
    const hunkKeyToIdx = new Map([['h1', 0], ['h2', 1]]);
    const entries = [
      createEntry('h1', 100, false),
      createEntry('h2', 200, false),
    ];
    expect(findTopMostVisibleHunk(entries, hunkKeyToIdx)).toBe(-1);
  });

  it('returns the index of the only intersecting entry', () => {
    const hunkKeyToIdx = new Map([['h1', 0], ['h2', 1], ['h3', 2]]);
    const entries = [
      createEntry('h1', 100, false),
      createEntry('h2', 200, true),
      createEntry('h3', 300, false),
    ];
    expect(findTopMostVisibleHunk(entries, hunkKeyToIdx)).toBe(1);
  });

  it('returns the index of the topmost intersecting entry', () => {
    const hunkKeyToIdx = new Map([['h1', 0], ['h2', 1], ['h3', 2]]);
    const entries = [
      createEntry('h1', 300, true),
      createEntry('h2', 100, true),
      createEntry('h3', 200, true),
    ];
    expect(findTopMostVisibleHunk(entries, hunkKeyToIdx)).toBe(1);
  });

  it('ignores entries with unknown hunk keys', () => {
    const hunkKeyToIdx = new Map([['h1', 0], ['h2', 1]]);
    const entries = [
      createEntry('unknown', 50, true),
      createEntry('h2', 200, true),
    ];
    expect(findTopMostVisibleHunk(entries, hunkKeyToIdx)).toBe(1);
  });

  it('ignores entries without hunk key', () => {
    const hunkKeyToIdx = new Map([['h1', 0]]);
    const entries = [
      { ...createEntry('', 50, true), target: { dataset: {} } as unknown as Element },
      createEntry('h1', 200, true),
    ];
    expect(findTopMostVisibleHunk(entries, hunkKeyToIdx)).toBe(0);
  });

  it('handles empty entries array', () => {
    const hunkKeyToIdx = new Map([['h1', 0]]);
    expect(findTopMostVisibleHunk([], hunkKeyToIdx)).toBe(-1);
  });

  it('handles empty hunkKeyToIdx map', () => {
    const entries = [createEntry('h1', 100, true)];
    expect(findTopMostVisibleHunk(entries, new Map())).toBe(-1);
  });

  it('selects entry with smallest top value when multiple at same position', () => {
    const hunkKeyToIdx = new Map([['h1', 0], ['h2', 1]]);
    const entries = [
      createEntry('h1', 100, true),
      createEntry('h2', 100, true),
    ];
    const result = findTopMostVisibleHunk(entries, hunkKeyToIdx);
    expect([0, 1]).toContain(result);
  });
});
