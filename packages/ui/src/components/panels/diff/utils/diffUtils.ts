import { textLinesToHunk, type ChangeData, type HunkData } from 'react-diff-view';

export type HunkKind = 'added' | 'deleted' | 'modified';

export type HunkHeaderEntry = {
  sig: string;
  oldStart: number;
  newStart: number;
  header: string;
};

export function toFilePath(raw: { newPath: string; oldPath: string }) {
  const newPath = (raw.newPath || '').trim();
  const oldPath = (raw.oldPath || '').trim();
  if (newPath && newPath !== '/dev/null') return newPath;
  if (oldPath && oldPath !== '/dev/null') return oldPath;
  return '(unknown)';
}

export function parseHunkHeader(content: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const match = content.match(/@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/);
  if (!match) return null;
  const oldStart = parseInt(match[1], 10);
  const oldLines = match[2] == null ? 1 : parseInt(match[2], 10);
  const newStart = parseInt(match[3], 10);
  const newLines = match[4] == null ? 1 : parseInt(match[4], 10);
  return { oldStart, oldLines, newStart, newLines };
}

export function hunkSignature(hunk: HunkData): string {
  const changes = hunk.changes as ChangeData[];
  const parts: string[] = [];
  for (const change of changes) {
    if ((change as any).isInsert) parts.push(`+${change.content}`);
    else if ((change as any).isDelete) parts.push(`-${change.content}`);
  }
  return parts.join('\n');
}

export function hunkKind(hunk: HunkData): HunkKind | null {
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

export function normalizeHunks(hunks: HunkData[]): HunkData[] {
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

export function expandToFullFile(hunks: HunkData[], source: string): HunkData[] {
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
