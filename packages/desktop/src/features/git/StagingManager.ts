import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GitExecutor } from '../../executors/git';
import type { GitStatusManager } from './StatusManager';

interface HunkLine {
  text: string;
  type: 'added' | 'deleted' | 'context';
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface TargetLine {
  type: 'added' | 'deleted';
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface StageLinesOptions {
  worktreePath: string;
  sessionId: string;
  filePath: string;
  isStaging: boolean;
  targetLine: TargetLine;
}

export interface StageHunkOptions {
  worktreePath: string;
  sessionId: string;
  filePath: string;
  isStaging: boolean;
  hunkHeader: string;
}

export interface RestoreHunkOptions {
  worktreePath: string;
  sessionId: string;
  filePath: string;
  scope: 'staged' | 'unstaged';
  hunkHeader: string;
}

export interface ChangeAllStageOptions {
  worktreePath: string;
  sessionId: string;
  stage: boolean;
}

export interface ChangeFileStageOptions {
  worktreePath: string;
  sessionId: string;
  filePath: string;
  stage: boolean;
}

export interface StageLinesResult {
  success: boolean;
  error?: string;
}

export class GitStagingManager {
  // Keep in sync with UI working-tree diff context (DiffManager.WORKING_DIFF_CONTEXT_LINES).
  private readonly UI_WORKING_DIFF_CONTEXT_LINES = 3;

  constructor(
    private gitExecutor: GitExecutor,
    private statusManager: GitStatusManager
  ) {}

  /**
   * Stage or unstage a specific line
   */
  async stageLines(options: StageLinesOptions): Promise<StageLinesResult> {
    try {
      console.debug('[GitStagingManager] stageLines called:', options);

      // 1. Get full diff for the file
      const scope = options.isStaging ? 'unstaged' : 'staged';
      console.debug('[GitStagingManager] Getting diff for scope:', scope);
      const fullDiff = await this.getFileDiff(
        options.worktreePath,
        options.filePath,
        scope,
        options.sessionId
      );
      console.debug('[GitStagingManager] Got diff, length:', fullDiff.length);

      // Check for binary files
      if (this.isBinaryDiffOutput(fullDiff)) {
        return {
          success: false,
          error: 'Cannot stage individual lines of binary files',
        };
      }

      // 2. Parse into hunks
      const hunks = this.parseDiffIntoHunks(fullDiff);
      console.debug('[GitStagingManager] Parsed hunks:', hunks.length);

      if (hunks.length === 0) {
        return {
          success: false,
          error: 'No changes found in diff',
        };
      }

      // 3. Find hunk containing target line
      const targetHunk = this.findHunkContainingLine(hunks, options.targetLine);
      console.debug('[GitStagingManager] Found target hunk:', !!targetHunk);
      if (!targetHunk) {
        return {
          success: false,
          error: 'Target line not found in diff',
        };
      }

      // 4. Generate patch
      const patch = this.generatePartialPatch(
        targetHunk,
        options.targetLine,
        options.isStaging,
        options.filePath
      );
      console.debug('[GitStagingManager] Generated patch:\n', patch);

      // 5. Apply patch
      return await this.applyPatch(
        options.worktreePath,
        patch,
        options.isStaging,
        options.sessionId
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Stage or unstage a full hunk (block)
   */
  async stageHunk(options: StageHunkOptions): Promise<StageLinesResult> {
    try {
      const scope = options.isStaging ? 'unstaged' : 'staged';
      const resolved = await this.resolveTargetHunkByHeader({
        worktreePath: options.worktreePath,
        filePath: options.filePath,
        scope,
        sessionId: options.sessionId,
        hunkHeader: options.hunkHeader,
        binaryError: 'Cannot stage hunks of binary files',
      });
      if ('error' in resolved) {
        return { success: false, error: resolved.error };
      }
      const targetHunk = resolved.hunk;

      const patch = this.generateHunkPatch(targetHunk, options.filePath);
      return await this.applyPatch(options.worktreePath, patch, options.isStaging, options.sessionId, {
        operation: options.isStaging ? 'stage-hunk' : 'unstage-hunk',
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Restore (discard) a specific hunk in the working tree.
   *
   * For staged hunks we first unstage the hunk, then attempt to restore the same patch in
   * the working tree (best-effort; may fail if the working tree differs from the index).
   */
  async restoreHunk(options: RestoreHunkOptions): Promise<StageLinesResult> {
    try {
      const fullDiffScope = options.scope === 'staged' ? 'staged' : 'unstaged';
      const resolved = await this.resolveTargetHunkByHeader({
        worktreePath: options.worktreePath,
        filePath: options.filePath,
        scope: fullDiffScope,
        sessionId: options.sessionId,
        hunkHeader: options.hunkHeader,
        binaryError: 'Cannot restore hunks of binary files',
      });
      if ('error' in resolved) {
        return { success: false, error: resolved.error };
      }
      const targetHunk = resolved.hunk;

      const patch = this.generateHunkPatch(targetHunk, options.filePath);

      if (options.scope === 'staged') {
        const unstage = await this.applyPatch(options.worktreePath, patch, false, options.sessionId, {
          operation: 'restore-hunk-unstage',
        });
        if (!unstage.success) return unstage;
      }

      const worktreeRestore = await this.applyWorktreePatch(options.worktreePath, patch, true, options.sessionId, {
        operation: 'restore-hunk-worktree',
      });
      if (!worktreeRestore.success) {
        return worktreeRestore;
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Stage or unstage all changes.
   */
  async changeAllStage(options: ChangeAllStageOptions): Promise<StageLinesResult> {
    try {
      const argv = options.stage
        ? ['git', 'add', '--all']
        : ['git', 'reset'];

      const result = await this.gitExecutor.run({
        sessionId: options.sessionId,
        cwd: options.worktreePath,
        argv,
        op: 'write',
        recordTimeline: true,
        meta: { source: 'gitStaging', operation: options.stage ? 'stage-all' : 'unstage-all' },
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'git command failed' };
      }

      this.statusManager.clearSessionCache(options.sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Stage or unstage a single file.
   *
   * - Stage: `git add --all -- <file>`
   * - Unstage: `git reset -- <file>`
   */
  async changeFileStage(options: ChangeFileStageOptions): Promise<StageLinesResult> {
    try {
      const filePath = options.filePath.trim();
      if (!filePath) return { success: false, error: 'File path is required' };

      const argv = options.stage
        ? ['git', 'add', '--all', '--', filePath]
        : ['git', 'reset', '--', filePath];

      const result = await this.gitExecutor.run({
        sessionId: options.sessionId,
        cwd: options.worktreePath,
        argv,
        op: 'write',
        recordTimeline: true,
        meta: { source: 'gitStaging', operation: options.stage ? 'stage-file' : 'unstage-file', filePath },
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'git command failed' };
      }

      this.statusManager.clearSessionCache(options.sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async restoreFile(options: { worktreePath: string; sessionId: string; filePath: string }): Promise<StageLinesResult> {
    try {
      const filePath = options.filePath.trim();
      if (!filePath) return { success: false, error: 'File path is required' };

      const result = await this.gitExecutor.run({
        sessionId: options.sessionId,
        cwd: options.worktreePath,
        argv: ['git', 'checkout', 'HEAD', '--', filePath],
        op: 'write',
        recordTimeline: true,
        meta: { source: 'gitStaging', operation: 'restore-file', filePath },
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'git checkout failed' };
      }

      this.statusManager.clearSessionCache(options.sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  private async resolveTargetHunkByHeader(options: {
    worktreePath: string;
    filePath: string;
    scope: 'staged' | 'unstaged';
    sessionId: string;
    hunkHeader: string;
    binaryError: string;
  }): Promise<{ hunk: Hunk } | { error: string }> {
    const normalizedHeader = options.hunkHeader.trim();
    if (!normalizedHeader) {
      return { error: 'Invalid hunk header' };
    }

    let sawAnyHunks = false;
    const unifiedCandidates = [0, this.UI_WORKING_DIFF_CONTEXT_LINES];
    const attemptedUnified = new Set<number>();

    for (const unified of unifiedCandidates) {
      if (attemptedUnified.has(unified)) continue;
      attemptedUnified.add(unified);

      const fullDiff = await this.getFileDiff(
        options.worktreePath,
        options.filePath,
        options.scope,
        options.sessionId,
        unified
      );

      if (this.isBinaryDiffOutput(fullDiff)) {
        return { error: options.binaryError };
      }

      const hunks = this.parseDiffIntoHunks(fullDiff);
      if (hunks.length === 0) continue;
      sawAnyHunks = true;

      const target = hunks.find((h) => h.header.trim() === normalizedHeader);
      if (target) return { hunk: target };
    }

    if (!sawAnyHunks) return { error: 'No changes found in diff' };
    return { error: 'Target hunk not found in diff' };
  }

  private async getFileDiff(
    worktreePath: string,
    filePath: string,
    scope: 'staged' | 'unstaged',
    sessionId: string,
    unifiedLines: number = 0
  ): Promise<string> {
    const unified = `--unified=${unifiedLines}`;
    const argv =
      scope === 'staged'
        ? ['git', 'diff', '--cached', '--color=never', unified, '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', filePath]
        : ['git', 'diff', '--color=never', unified, '--src-prefix=a/', '--dst-prefix=b/', '--', filePath];

    const result = await this.gitExecutor.run({
      sessionId,
      cwd: worktreePath,
      argv,
      op: 'read',
      recordTimeline: false,
      meta: { source: 'gitStaging', operation: 'get-file-diff', scope, filePath },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get diff: ${result.stderr}`);
    }

    return result.stdout;
  }

  private isBinaryDiffOutput(diffText: string): boolean {
    for (const rawLine of diffText.split('\n')) {
      const line = rawLine.trimEnd();
      if (line === 'GIT binary patch') return true;
      if (line.startsWith('Binary files ') && line.endsWith(' differ')) return true;
    }
    return false;
  }

  /**
   * Parse diff text into hunks with line number tracking
   */
  private parseDiffIntoHunks(diffText: string): Hunk[] {
    const hunks: Hunk[] = [];
    const lines = diffText.split('\n');

    let currentHunk: Hunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      // Detect hunk header: @@ -10,5 +10,6 @@
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        // Match both formats: @@ -10,5 +10,6 @@ and @@ -10 +10,6 @@
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          oldLineNum = parseInt(match[1], 10);
          const oldCount = match[2] ? parseInt(match[2], 10) : 1;
          newLineNum = parseInt(match[3], 10);
          const newCount = match[4] ? parseInt(match[4], 10) : 1;

          currentHunk = {
            header: line,
            oldStart: oldLineNum,
            oldCount,
            newStart: newLineNum,
            newCount,
            lines: [],
          };
        }
        continue;
      }

      if (!currentHunk) continue;

      // Skip diff metadata lines (diff --git, index, ---, +++)
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode')
      ) {
        continue;
      }

      // Track line numbers for each line
      const lineType = line[0];
      let type: HunkLine['type'];
      if (lineType === '+') {
        type = 'added';
      } else if (lineType === '-') {
        type = 'deleted';
      } else {
        type = 'context';
      }

      currentHunk.lines.push({
        text: line,
        type,
        oldLineNumber: lineType !== '+' ? oldLineNum : null,
        newLineNumber: lineType !== '-' ? newLineNum : null,
      });

      // Update line numbers
      if (lineType !== '+') oldLineNum++;
      if (lineType !== '-') newLineNum++;
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  /**
   * Find the hunk containing the target line
   */
  private findHunkContainingLine(hunks: Hunk[], targetLine: TargetLine): Hunk | null {
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        const matchesOld =
          targetLine.oldLineNumber !== null &&
          line.oldLineNumber === targetLine.oldLineNumber;
        const matchesNew =
          targetLine.newLineNumber !== null &&
          line.newLineNumber === targetLine.newLineNumber;

        if (matchesOld || matchesNew) {
          return hunk;
        }
      }
    }
    return null;
  }

  /**
   * Generate partial patch with zero context (unidiff-zero format)
   */
  private generatePartialPatch(
    hunk: Hunk,
    targetLine: TargetLine,
    isStaging: boolean,
    filePath: string
  ): string {
    const targetType = targetLine.type;

    // Find target line and calculate positions
    let targetHunkLine: HunkLine | null = null;
    let oldLinePos = hunk.oldStart;
    let newLinePos = hunk.newStart;

    for (const line of hunk.lines) {
      const isTarget =
        (line.oldLineNumber === targetLine.oldLineNumber &&
          targetLine.oldLineNumber !== null) ||
        (line.newLineNumber === targetLine.newLineNumber &&
          targetLine.newLineNumber !== null);

      if (isTarget) {
        targetHunkLine = line;
        // Use the actual line numbers from the diff
        if (targetType === 'deleted') {
          oldLinePos = line.oldLineNumber!;
          newLinePos = line.newLineNumber || newLinePos;
        } else {
          // For added lines, we insert AFTER the previous old line
          // Find the last old line number before this addition
          newLinePos = line.newLineNumber!;
        }
        break;
      }

      // Track position as we iterate
      if (line.type !== 'added') oldLinePos = (line.oldLineNumber || 0) + 1;
      if (line.type !== 'deleted') newLinePos = (line.newLineNumber || 0) + 1;
    }

    if (!targetHunkLine) {
      throw new Error('Target line not found in hunk');
    }

    // For added lines, use the position right before the insertion
    if (targetType === 'added') {
      // Find what old line this corresponds to by counting back
      let oldCount = 0;
      for (const line of hunk.lines) {
        if (line === targetHunkLine) break;
        if (line.type !== 'added') oldCount++;
      }
      oldLinePos = hunk.oldStart + oldCount;
    }

    // Generate patch with zero context
    let oldCount, newCount, patchContent;

    if (targetType === 'deleted') {
      // Deleting a line: old has 1 line, new has 0
      oldCount = 1;
      newCount = 0;
      patchContent = targetHunkLine.text; // Keep the - line
    } else {
      // Adding a line: old has 0 lines, new has 1
      oldCount = 0;
      newCount = 1;
      patchContent = targetHunkLine.text; // Keep the + line
    }

    // Ensure patchContent doesn't end with \n (join will add it)
    if (patchContent.endsWith('\n')) {
      patchContent = patchContent.slice(0, -1);
    }

    // Generate patch header for zero-context patch
    const newHeader = `@@ -${oldLinePos},${oldCount} +${newLinePos},${newCount} @@`;

    // Full patch format
    const patch = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      newHeader,
      patchContent,
      '', // Empty line at end
    ].join('\n');

    return patch;
  }

  private generateHunkPatch(hunk: Hunk, filePath: string): string {
    const patch = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      hunk.header,
      ...hunk.lines.map((l) => l.text),
      '',
    ].join('\n');

    return patch;
  }

  /**
   * Apply patch to working tree using git apply (not --cached).
   */
  private async applyWorktreePatch(
    worktreePath: string,
    patch: string,
    reverse: boolean,
    sessionId: string,
    meta?: { operation: string }
  ): Promise<StageLinesResult> {
    const tempFile = path.join(os.tmpdir(), `snowtree-worktree-patch-${Date.now()}.patch`);

    try {
      await fs.writeFile(tempFile, patch, 'utf8');

      const argv = [
        'git',
        'apply',
        '--unidiff-zero',
        '--whitespace=nowarn',
        ...(reverse ? ['-R'] : []),
        tempFile,
      ];

      const result = await this.gitExecutor.run({
        sessionId,
        cwd: worktreePath,
        argv,
        op: 'write',
        recordTimeline: true,
        meta: { source: 'gitStaging', operation: meta?.operation ?? (reverse ? 'apply-reverse' : 'apply') },
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'git apply failed' };
      }

      this.statusManager.clearSessionCache(sessionId);
      return { success: true };
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Apply patch using git apply --cached
   */
  private async applyPatch(
    worktreePath: string,
    patch: string,
    isStaging: boolean,
    sessionId: string,
    meta?: { operation: string }
  ): Promise<StageLinesResult> {
    // Write patch to temp file
    const tempFile = path.join(os.tmpdir(), `snowtree-patch-${Date.now()}.patch`);

    try {
      await fs.writeFile(tempFile, patch, 'utf8');

      // Build git apply command
      const argv = [
        'git',
        'apply',
        '--unidiff-zero', // Allow patches with zero context
        '--whitespace=nowarn',
        '--cached',
        ...(isStaging ? [] : ['-R']), // Use -R for unstaging
        tempFile,
      ];

      const result = await this.gitExecutor.run({
        sessionId,
        cwd: worktreePath,
        argv,
        op: 'write',
        recordTimeline: true,
        meta: {
          source: 'gitStaging',
          operation: meta?.operation ?? (isStaging ? 'stage-line' : 'unstage-line'),
        },
      });

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: result.stderr || 'git apply failed',
        };
      }

      // Clear git status cache to force refresh
      this.statusManager.clearSessionCache(sessionId);

      return { success: true };
    } finally {
      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {
        // Ignore cleanup errors
      });
    }
  }
}
