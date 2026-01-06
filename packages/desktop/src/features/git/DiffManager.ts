import { readFile } from 'fs/promises';
import { join } from 'path';
import type { GitExecutor } from '../../executors/git';
import type { Logger } from '../../infrastructure/logging/logger';

export interface GitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface GitDiffResult {
  diff: string;
  stats: GitDiffStats;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  message: string;
  date: Date;
  author: string;
  stats: GitDiffStats;
}

export type WorkingTreeScope = 'all' | 'staged' | 'unstaged' | 'untracked';

export type WorkingTreeGroups = {
  staged: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed'; isNew?: boolean }>;
  unstaged: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed'; isNew?: boolean }>;
  untracked: Array<{ path: string; additions: number; deletions: number; type: 'added' | 'deleted' | 'modified' | 'renamed'; isNew?: boolean }>;
};

const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024; // 1MB

export class GitDiffManager {
  constructor(
    private gitExecutor: GitExecutor,
    private logger?: Logger,
  ) {}

  private async runGit(args: {
    sessionId?: string | null;
    cwd: string;
    argv: string[];
    meta?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ stdout: string; stderr: string }> {
    const res = await this.gitExecutor.run({
      sessionId: args.sessionId ?? undefined,
      cwd: args.cwd,
      argv: args.argv,
      op: 'read',
      recordTimeline: false,
      timeoutMs: args.timeoutMs,
      meta: args.meta,
    });
    return { stdout: res.stdout, stderr: res.stderr };
  }

  async getCurrentCommitHash(worktreePath: string, sessionId?: string | null): Promise<string> {
    const { stdout } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'rev-parse', 'HEAD'],
      meta: { source: 'gitDiff', operation: 'rev-parse-head' },
    });
    return stdout.trim();
  }

  async getCommitSubject(worktreePath: string, commitHash: string, sessionId?: string | null): Promise<string> {
    const hash = commitHash.trim();
    if (!hash) return '';
    const { stdout } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'log', '-1', '--format=%s', hash],
      meta: { source: 'gitDiff', operation: 'commit-subject', commit: hash },
    });
    return stdout.trim();
  }

  parseShortstat(statsOutput: string): GitDiffStats {
    const s = statsOutput.trim();
    if (!s) return { additions: 0, deletions: 0, filesChanged: 0 };

    const fileMatch = s.match(/(\d+)\s+files?\s+changed/);
    const addMatch = s.match(/(\d+)\s+insertions?\(\+\)/);
    const delMatch = s.match(/(\d+)\s+deletions?\(-\)/);

    return {
      filesChanged: fileMatch ? parseInt(fileMatch[1], 10) : 0,
      additions: addMatch ? parseInt(addMatch[1], 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
    };
  }

  private parseNumstat(output: string): GitDiffStats {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const add = parts[0];
      const del = parts[1];
      // Binary diffs use "-" for add/del.
      const addNum = add === '-' ? 0 : parseInt(add, 10) || 0;
      const delNum = del === '-' ? 0 : parseInt(del, 10) || 0;
      additions += addNum;
      deletions += delNum;
      filesChanged += 1;
    }

    return { additions, deletions, filesChanged };
  }

  async hasChanges(worktreePath: string, sessionId?: string | null): Promise<boolean> {
    const { stdout } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'status', '--porcelain'],
      meta: { source: 'gitDiff', operation: 'status-porcelain' },
    });
    return stdout.trim().length > 0;
  }

  private async getUntrackedFiles(worktreePath: string, sessionId?: string | null): Promise<string[]> {
    try {
      const { stdout } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'ls-files', '--others', '--exclude-standard'],
        meta: { source: 'gitDiff', operation: 'ls-untracked' },
      });
      if (!stdout.trim()) return [];
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch (e) {
      this.logger?.warn(`Could not list untracked files in ${worktreePath}`, e instanceof Error ? e : undefined);
      return [];
    }
  }

  private async createDiffForUntrackedFiles(worktreePath: string, untrackedFiles: string[]): Promise<{ diff: string; additions: number; files: number }> {
    let diffOutput = '';
    let additions = 0;
    let files = 0;

    for (const file of untrackedFiles) {
      if (!file.trim()) continue;
      const cleanFile = file.trim();
      const filePath = join(worktreePath, cleanFile);

      try {
        const buf = await readFile(filePath);
        if (buf.byteLength > MAX_UNTRACKED_FILE_BYTES) continue;

        const content = buf.toString('utf8');
        const lines = content.split('\n');

        diffOutput += `diff --git a/${cleanFile} b/${cleanFile}\n`;
        diffOutput += `new file mode 100644\n`;
        diffOutput += `index 0000000..0000000\n`;
        diffOutput += `--- /dev/null\n`;
        diffOutput += `+++ b/${cleanFile}\n`;
        diffOutput += `@@ -0,0 +1,${lines.length} @@\n`;
        for (const line of lines) diffOutput += `+${line}\n`;

        files += 1;
        additions += Math.max(0, lines.length);
      } catch {
        this.logger?.verbose(`Could not read untracked file ${cleanFile}`);
      }
    }

    return { diff: diffOutput.trimEnd(), additions, files };
  }

  async captureWorkingDirectoryDiff(worktreePath: string, sessionId?: string | null): Promise<GitDiffResult> {
    const beforeHash = await this.getCurrentCommitHash(worktreePath, sessionId);

    const { stdout: trackedDiff } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--color=never', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'],
      timeoutMs: 120_000,
      meta: { source: 'gitDiff', operation: 'diff-working' },
    });

    const { stdout: trackedFilesOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--name-only', '--color=never', 'HEAD'],
      meta: { source: 'gitDiff', operation: 'diff-working-files' },
    });
    const trackedFiles = trackedFilesOut
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const untrackedFiles = await this.getUntrackedFiles(worktreePath, sessionId);
    const untrackedDiff = untrackedFiles.length > 0 ? await this.createDiffForUntrackedFiles(worktreePath, untrackedFiles) : null;

    const { stdout: shortstatOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--shortstat', '--color=never', 'HEAD'],
      meta: { source: 'gitDiff', operation: 'diff-working-shortstat' },
    });
    const trackedStats = this.parseShortstat(shortstatOut);

    const combinedDiff = [trackedDiff.trimEnd(), untrackedDiff?.diff].filter(Boolean).join('\n\n').trimEnd();
    const changedFiles = [...trackedFiles, ...untrackedFiles];
    const stats: GitDiffStats = {
      additions: trackedStats.additions + (untrackedDiff?.additions || 0),
      deletions: trackedStats.deletions,
      filesChanged: trackedStats.filesChanged + (untrackedDiff?.files || 0),
    };

    return { diff: combinedDiff, stats, changedFiles, beforeHash };
  }

  async captureWorkingTreeDiff(worktreePath: string, scope: WorkingTreeScope, sessionId?: string | null): Promise<GitDiffResult> {
    if (scope === 'all') {
      return await this.captureWorkingDirectoryDiff(worktreePath, sessionId);
    }

    if (scope === 'staged') {
      const beforeHash = await this.getCurrentCommitHash(worktreePath, sessionId);
      const { stdout: diff } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--cached', '--color=never', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'],
        timeoutMs: 120_000,
        meta: { source: 'gitDiff', operation: 'diff-working-staged' },
      });

      const { stdout: filesOut } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--cached', '--name-only', '--color=never', 'HEAD'],
        meta: { source: 'gitDiff', operation: 'diff-working-staged-files' },
      });
      const changedFiles = filesOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const { stdout: shortstatOut } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--cached', '--shortstat', '--color=never', 'HEAD'],
        meta: { source: 'gitDiff', operation: 'diff-working-staged-shortstat' },
      });
      const stats = this.parseShortstat(shortstatOut);

      return { diff: diff.trimEnd(), stats, changedFiles, beforeHash };
    }

    if (scope === 'unstaged') {
      const beforeHash = await this.getCurrentCommitHash(worktreePath, sessionId);
      const { stdout: diff } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--color=never', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/'],
        timeoutMs: 120_000,
        meta: { source: 'gitDiff', operation: 'diff-working-unstaged' },
      });

      const { stdout: filesOut } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--name-only', '--color=never'],
        meta: { source: 'gitDiff', operation: 'diff-working-unstaged-files' },
      });
      const changedFiles = filesOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const { stdout: shortstatOut } = await this.runGit({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'diff', '--shortstat', '--color=never'],
        meta: { source: 'gitDiff', operation: 'diff-working-unstaged-shortstat' },
      });
      const stats = this.parseShortstat(shortstatOut);

      return { diff: diff.trimEnd(), stats, changedFiles, beforeHash };
    }

    // untracked
    const beforeHash = await this.getCurrentCommitHash(worktreePath, sessionId);
    const untrackedFiles = await this.getUntrackedFiles(worktreePath, sessionId);
    const untrackedDiff = untrackedFiles.length > 0 ? await this.createDiffForUntrackedFiles(worktreePath, untrackedFiles) : null;
    const diff = untrackedDiff?.diff || '';
    const stats: GitDiffStats = {
      additions: untrackedDiff?.additions || 0,
      deletions: 0,
      filesChanged: untrackedDiff?.files || 0,
    };
    return { diff, stats, changedFiles: untrackedFiles, beforeHash };
  }

  private normalizeNumstatPath(raw: string): string {
    const input = raw.trim();
    if (!input) return input;
    // Handle brace-style renames: a/{old => new}/b
    const brace = input.match(/^(.*)\{.*=>\s*(.*)\}(.*)$/);
    if (brace) return `${brace[1]}${brace[2]}${brace[3]}`.trim();
    // Handle plain renames: old/path => new/path
    const arrowIdx = input.lastIndexOf('=>');
    if (arrowIdx !== -1) {
      return input.slice(arrowIdx + 2).trim();
    }
    return input;
  }

  private async headPathExists(worktreePath: string, filePath: string, sessionId?: string | null): Promise<boolean> {
    const object = `HEAD:${filePath}`;
    const res = await this.gitExecutor.run({
      sessionId: sessionId ?? undefined,
      cwd: worktreePath,
      argv: ['git', 'cat-file', '-e', object],
      op: 'read',
      recordTimeline: false,
      meta: { source: 'gitDiff', operation: 'cat-file-exists', object },
      timeoutMs: 15_000,
    });
    return res.exitCode === 0;
  }

  private statusType(code: string): 'added' | 'deleted' | 'modified' | 'renamed' {
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    if (code === 'R' || code === 'C') return 'renamed';
    return 'modified';
  }

  async getWorkingTreeGroups(worktreePath: string, sessionId?: string | null): Promise<WorkingTreeGroups> {
    const groups: WorkingTreeGroups = { staged: [], unstaged: [], untracked: [] };

    const { stdout: statusOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'status', '--porcelain=v1'],
      meta: { source: 'gitDiff', operation: 'status-groups' },
    });

    const stagedPaths: Array<{ path: string; type: WorkingTreeGroups['staged'][number]['type'] }> = [];
    const unstagedPaths: Array<{ path: string; type: WorkingTreeGroups['unstaged'][number]['type'] }> = [];
    const untrackedPaths: string[] = [];

    for (const rawLine of statusOut.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      if (line.startsWith('?? ')) {
        const p = line.slice(3).trim();
        if (p) untrackedPaths.push(p);
        continue;
      }

      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      let path = line.slice(3).trim();
      // Rename lines: "R  old -> new"
      if (path.includes(' -> ')) {
        path = path.split(' -> ').pop()?.trim() || path;
      }

      if (x !== ' ') stagedPaths.push({ path, type: this.statusType(x) });
      if (y !== ' ') unstagedPaths.push({ path, type: this.statusType(y) });
    }

    const parseNumstat = (out: string): Map<string, { additions: number; deletions: number }> => {
      const map = new Map<string, { additions: number; deletions: number }>();
      for (const line of out.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const path = this.normalizeNumstatPath(parts.slice(2).join('\t'));
        if (!path) continue;
        map.set(path, { additions: add, deletions: del });
      }
      return map;
    };

    const stagedStats = parseNumstat(
      (
        await this.runGit({
          sessionId,
          cwd: worktreePath,
          argv: ['git', 'diff', '--cached', '--numstat', '--color=never'],
          meta: { source: 'gitDiff', operation: 'numstat-staged' },
        })
      ).stdout
    );
    const unstagedStats = parseNumstat(
      (
        await this.runGit({
          sessionId,
          cwd: worktreePath,
          argv: ['git', 'diff', '--numstat', '--color=never'],
          meta: { source: 'gitDiff', operation: 'numstat-unstaged' },
        })
      ).stdout
    );

    const stagedNewFlags = new Map<string, boolean>();
    const stagedAdded = stagedPaths.filter((p) => p.type === 'added').map((p) => p.path);
    for (const p of stagedAdded) {
      const exists = await this.headPathExists(worktreePath, p, sessionId);
      stagedNewFlags.set(p, !exists);
    }

    for (const item of stagedPaths) {
      const stats = stagedStats.get(item.path) || { additions: 0, deletions: 0 };
      const isNew = item.type === 'added' ? stagedNewFlags.get(item.path) : undefined;
      groups.staged.push({ path: item.path, additions: stats.additions, deletions: stats.deletions, type: item.type, isNew });
    }
    for (const item of unstagedPaths) {
      const stats = unstagedStats.get(item.path) || { additions: 0, deletions: 0 };
      groups.unstaged.push({ path: item.path, additions: stats.additions, deletions: stats.deletions, type: item.type });
    }

    if (untrackedPaths.length > 0) {
      for (const p of untrackedPaths) {
        let additions = 0;
        try {
          const buf = await readFile(join(worktreePath, p));
          if (buf.byteLength <= MAX_UNTRACKED_FILE_BYTES) {
            additions = buf.toString('utf8').split('\n').length;
          }
        } catch {
          // ignore
        }
        groups.untracked.push({ path: p, additions, deletions: 0, type: 'added', isNew: true });
      }
    }

    return groups;
  }

  async captureCommitDiff(worktreePath: string, fromCommit: string, toCommit?: string, sessionId?: string | null): Promise<GitDiffResult> {
    const to = toCommit || 'HEAD';

    const { stdout: diff } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--color=never', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', `${fromCommit}..${to}`],
      timeoutMs: 120_000,
      meta: { source: 'gitDiff', operation: 'diff-commit', fromCommit, toCommit: to },
    });

    const { stdout: filesOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--name-only', '--color=never', `${fromCommit}..${to}`],
      meta: { source: 'gitDiff', operation: 'diff-commit-files', fromCommit, toCommit: to },
    });
    const changedFiles = filesOut
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const { stdout: shortstatOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'diff', '--shortstat', '--color=never', `${fromCommit}..${to}`],
      meta: { source: 'gitDiff', operation: 'diff-commit-shortstat', fromCommit, toCommit: to },
    });
    const stats = this.parseShortstat(shortstatOut);

    const afterHash = to === 'HEAD' ? await this.getCurrentCommitHash(worktreePath, sessionId) : to;
    return { diff, stats, changedFiles, beforeHash: fromCommit, afterHash };
  }

  async getCommitDiff(worktreePath: string, commitHash: string, sessionId?: string | null): Promise<GitDiffResult> {
    const hash = commitHash.trim();
    const { stdout: diff } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'show', '--color=never', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', '--format=', hash],
      timeoutMs: 120_000,
      meta: { source: 'gitDiff', operation: 'show', commit: hash },
    });

    const { stdout: filesOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'show', '--name-only', '--color=never', '--format=', hash],
      meta: { source: 'gitDiff', operation: 'show-files', commit: hash },
    });
    const changedFiles = filesOut
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const { stdout: numstatOut } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'show', '--numstat', '--color=never', '--format=', hash],
      meta: { source: 'gitDiff', operation: 'show-numstat', commit: hash },
    });
    const stats = this.parseNumstat(numstatOut);

    return { diff, stats, changedFiles, afterHash: hash };
  }

  async getCommitHistory(worktreePath: string, limit: number = 50, mainBranch: string = 'main', sessionId?: string | null): Promise<GitCommit[]> {
    const delimiter = '\x1f';
    const logFormat = `%H${delimiter}%P${delimiter}%s${delimiter}%ai${delimiter}%an`;

    const { stdout } = await this.runGit({
      sessionId,
      cwd: worktreePath,
      argv: [
        'git',
        'log',
        `--format=${logFormat}`,
        '--numstat',
        '-n',
        String(limit),
        '--cherry-pick',
        '--left-only',
        `HEAD...${mainBranch}`,
        '--',
      ],
      timeoutMs: 120_000,
      meta: { source: 'gitDiff', operation: 'log-history', mainBranch, limit },
    });

    const commits: GitCommit[] = [];
    const lines = stdout.split('\n');

    let i = 0;
    while (i < lines.length) {
      const header = lines[i];
      if (!header.includes(delimiter)) {
        i++;
        continue;
      }

      const [hash, parentsStr, message, dateStr, author] = header.split(delimiter);
      const parents = (parentsStr || '').trim() ? parentsStr.trim().split(/\s+/) : [];

      i++;
      // git log --numstat commonly inserts an empty line between header and numstat lines.
      while (i < lines.length && !lines[i].trim()) i++;
      let additions = 0;
      let deletions = 0;
      let filesChanged = 0;

      while (i < lines.length && lines[i].trim()) {
        const parts = lines[i].split('\t');
        if (parts.length >= 3) {
          const add = parts[0];
          const del = parts[1];
          const addNum = add === '-' ? 0 : parseInt(add, 10) || 0;
          const delNum = del === '-' ? 0 : parseInt(del, 10) || 0;
          additions += addNum;
          deletions += delNum;
          filesChanged += 1;
        }
        i++;
      }

      while (i < lines.length && !lines[i].trim()) i++;

      commits.push({
        hash: (hash || '').trim(),
        parents,
        message: (message || '').trim(),
        date: new Date((dateStr || '').trim()),
        author: (author || '').trim() || 'Unknown',
        stats: { additions, deletions, filesChanged },
      });
    }

    return commits;
  }

  combineDiffs(diffs: GitDiffResult[]): GitDiffResult {
    const combinedDiff = diffs.map((d) => d.diff).filter(Boolean).join('\n\n').trimEnd();
    const fileSet = new Set<string>();
    let additions = 0;
    let deletions = 0;

    for (const d of diffs) {
      for (const f of d.changedFiles) fileSet.add(f);
      additions += d.stats.additions;
      deletions += d.stats.deletions;
    }

    return {
      diff: combinedDiff,
      changedFiles: [...fileSet],
      stats: { additions, deletions, filesChanged: fileSet.size },
    };
  }
}
