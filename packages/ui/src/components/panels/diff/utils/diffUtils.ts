export type HunkHeaderEntry = {
  sig: string;
  oldStart: number;
  newStart: number;
  header: string;
};

export function findMatchingHeader(entries: HunkHeaderEntry[] | undefined, sig: string, oldStart: number, newStart: number): string | null {
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
