import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitStagingManager } from '../StagingManager';
import type { GitExecutor } from '../../../executors/git';
import * as fs from 'fs';

// Mock fs promises
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('GitStagingManager', () => {
  let stagingManager: GitStagingManager;
  let mockGitExecutor: GitExecutor;
  let mockStatusManager: any;

  beforeEach(() => {
    mockGitExecutor = {
      run: vi.fn(),
    } as any;

    mockStatusManager = {
      clearSessionCache: vi.fn(),
    };

    stagingManager = new GitStagingManager(mockGitExecutor, mockStatusManager);
    vi.clearAllMocks();
  });

  describe('parseDiffIntoHunks', () => {
    it('should parse simple diff with line numbers', () => {
      const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;

      // Access private method through any cast for testing
      const hunks = (stagingManager as any).parseDiffIntoHunks(diff);

      expect(hunks).toHaveLength(1);
      expect(hunks[0].oldStart).toBe(1);
      expect(hunks[0].oldCount).toBe(3);
      expect(hunks[0].newStart).toBe(1);
      expect(hunks[0].newCount).toBe(4);
      expect(hunks[0].lines).toHaveLength(4);

      // Check line types and numbers
      expect(hunks[0].lines[0]).toMatchObject({
        type: 'context',
        oldLineNumber: 1,
        newLineNumber: 1,
      });
      expect(hunks[0].lines[1]).toMatchObject({
        type: 'added',
        oldLineNumber: null,
        newLineNumber: 2,
      });
      expect(hunks[0].lines[2]).toMatchObject({
        type: 'context',
        oldLineNumber: 2,
        newLineNumber: 3,
      });
    });

    it('should handle multiple hunks', () => {
      const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,3 @@
 line1
+added1
 line2
@@ -10,2 +11,3 @@
 line10
+added2
 line11`;

      const hunks = (stagingManager as any).parseDiffIntoHunks(diff);

      expect(hunks).toHaveLength(2);
      expect(hunks[0].oldStart).toBe(1);
      expect(hunks[1].oldStart).toBe(10);
    });

    it('should track old and new line numbers correctly', () => {
      const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,4 +1,4 @@
 context1
-deleted
+added
 context2`;

      const hunks = (stagingManager as any).parseDiffIntoHunks(diff);

      expect(hunks[0].lines[0]).toMatchObject({
        type: 'context',
        oldLineNumber: 1,
        newLineNumber: 1,
      });
      expect(hunks[0].lines[1]).toMatchObject({
        type: 'deleted',
        oldLineNumber: 2,
        newLineNumber: null,
      });
      expect(hunks[0].lines[2]).toMatchObject({
        type: 'added',
        oldLineNumber: null,
        newLineNumber: 2,
      });
      expect(hunks[0].lines[3]).toMatchObject({
        type: 'context',
        oldLineNumber: 3,
        newLineNumber: 3,
      });
    });

    it('should handle single line hunk header format', () => {
      const diff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1 +1,2 @@
 line1
+added line`;

      const hunks = (stagingManager as any).parseDiffIntoHunks(diff);

      expect(hunks).toHaveLength(1);
      expect(hunks[0].oldStart).toBe(1);
      expect(hunks[0].oldCount).toBe(1);
      expect(hunks[0].newStart).toBe(1);
      expect(hunks[0].newCount).toBe(2);
    });
  });

  describe('generatePartialPatch', () => {
    it('should stage single added line', () => {
      const hunk = {
        header: '@@ -1,3 +1,4 @@',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        lines: [
          { text: ' context1', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
          { text: '+added line', type: 'added' as const, oldLineNumber: null, newLineNumber: 2 },
          { text: '+other added', type: 'added' as const, oldLineNumber: null, newLineNumber: 3 },
          { text: ' context2', type: 'context' as const, oldLineNumber: 2, newLineNumber: 4 },
        ],
      };

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 2 };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, true, 'test.txt');

      // Should contain the target line as-is
      expect(patch).toContain('+added line');
      // Should not include other lines (unidiff-zero staging patch)
      expect(patch).not.toContain('other added');
      // Header should use zero-context counts
      expect(patch).toContain('@@ -2,0 +2,1 @@');
    });

    it('should stage single deleted line', () => {
      const hunk = {
        header: '@@ -1,3 +1,2 @@',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 2,
        lines: [
          { text: ' context1', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
          { text: '-deleted line', type: 'deleted' as const, oldLineNumber: 2, newLineNumber: null },
          { text: ' context2', type: 'context' as const, oldLineNumber: 3, newLineNumber: 2 },
        ],
      };

      const targetLine = { type: 'deleted' as const, oldLineNumber: 2, newLineNumber: null };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, true, 'test.txt');

      // Should contain the target line as-is
      expect(patch).toContain('-deleted line');
      // Header should use zero-context counts
      expect(patch).toContain('@@ -2,1 +2,0 @@');
    });

    it('should omit non-target lines in unidiff-zero patch', () => {
      const hunk = {
        header: '@@ -1,2 +1,3 @@',
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 3,
        lines: [
          { text: '+line1', type: 'added' as const, oldLineNumber: null, newLineNumber: 1 },
          { text: '+line2', type: 'added' as const, oldLineNumber: null, newLineNumber: 2 },
          { text: ' context', type: 'context' as const, oldLineNumber: 1, newLineNumber: 3 },
        ],
      };

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 1 };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, true, 'test.txt');

      // Target line kept as-is
      expect(patch).toContain('+line1');
      // Non-target lines omitted
      expect(patch).not.toContain('line2');
    });

    it('should ignore opposite-type lines when staging', () => {
      const hunk = {
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { text: '-deleted', type: 'deleted' as const, oldLineNumber: 1, newLineNumber: null },
          { text: '+added', type: 'added' as const, oldLineNumber: null, newLineNumber: 1 },
          { text: ' context', type: 'context' as const, oldLineNumber: 2, newLineNumber: 2 },
        ],
      };

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 1 };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, true, 'test.txt');

      // Should keep added line
      expect(patch).toContain('+added');
      // Should NOT contain deleted line (ignored)
      expect(patch).not.toContain('-deleted');
    });

    it('should calculate unidiff-zero hunk header positions', () => {
      const hunk = {
        header: '@@ -1,5 +1,5 @@',
        oldStart: 1,
        oldCount: 5,
        newStart: 1,
        newCount: 5,
        lines: [
          { text: ' context1', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
          { text: '+added1', type: 'added' as const, oldLineNumber: null, newLineNumber: 2 },
          { text: '+added2', type: 'added' as const, oldLineNumber: null, newLineNumber: 3 },
          { text: ' context2', type: 'context' as const, oldLineNumber: 2, newLineNumber: 4 },
        ],
      };

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 2 };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, true, 'test.txt');

      // Insert after the first old line, at new line 2.
      expect(patch).toContain('@@ -2,0 +2,1 @@');
    });

    it('should handle unstaging with -R flag logic', () => {
      const hunk = {
        header: '@@ -1,3 +1,4 @@',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        lines: [
          { text: ' context1', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
          { text: '+added line', type: 'added' as const, oldLineNumber: null, newLineNumber: 2 },
          { text: ' context2', type: 'context' as const, oldLineNumber: 2, newLineNumber: 3 },
        ],
      };

      // When unstaging (isStaging=false), we keep deleted lines and ignore added lines
      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 2 };
      const patch = (stagingManager as any).generatePartialPatch(hunk, targetLine, false, 'test.txt');

      // When unstaging, the logic reverses, but the test verifies the patch is generated correctly
      // The actual reversal happens via git apply -R
      expect(patch).toBeDefined();
    });
  });

  describe('stageLines', () => {
    it('should stage line from unstaged diff', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          // First call: get diff
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff',
        } as any)
        .mockResolvedValueOnce({
          // Second call: apply patch
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply',
        } as any);

      const result = await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: true,
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 2,
        },
      });

      if (!result.success) {
        console.log('Staging failed:', result.error);
      }

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(2);

      // Verify git diff was called
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'diff', '--unified=3']),
      }));

      // Verify git apply was called with --cached
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'apply', '--cached']),
      }));
    });

    it('should unstage line from staged diff', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff --cached',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply',
        } as any);

      const result = await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: false, // unstaging
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 2,
        },
      });

      if (!result.success) {
        console.log('Unstaging failed:', result.error);
      }

      expect(result.success).toBe(true);

      // Verify git apply was called with -R for unstaging
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        argv: expect.arrayContaining(['-R']),
      }));
    });

    it('should reject binary files', async () => {
      const mockDiff = `diff --git a/image.png b/image.png
Binary files differ`;

      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: mockDiff,
        stderr: '',
        commandDisplay: 'git diff',
      } as any);

      const result = await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'image.png',
        isStaging: true,
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 1,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('binary');
    });

    it('should handle git apply failures', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,3 @@
 context
+added line
 context2`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'patch does not apply',
          commandDisplay: 'git apply',
        } as any);

      const result = await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: true,
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 2,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle target line not found', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,3 @@
 context
+added line
 context2`;

      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: mockDiff,
        stderr: '',
        commandDisplay: 'git diff',
      } as any);

      const result = await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: true,
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 999, // Non-existent line
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should write and cleanup temp patch file', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,3 @@
 context
+added line
 context2`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply',
        } as any);

      await stagingManager.stageLines({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: true,
        targetLine: {
          type: 'added',
          oldLineNumber: null,
          newLineNumber: 2,
        },
      });

      // Verify temp file was written
      expect(fs.promises.writeFile).toHaveBeenCalled();
      // Verify temp file was cleaned up
      expect(fs.promises.unlink).toHaveBeenCalled();
    });
  });

  describe('findHunkContainingLine', () => {
    it('should find hunk by old line number', () => {
      const hunks = [
        {
          header: '@@ -1,3 +1,4 @@',
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 4,
          lines: [
            { text: ' context', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
            { text: '-deleted', type: 'deleted' as const, oldLineNumber: 2, newLineNumber: null },
            { text: ' context2', type: 'context' as const, oldLineNumber: 3, newLineNumber: 2 },
          ],
        },
      ];

      const targetLine = { type: 'deleted' as const, oldLineNumber: 2, newLineNumber: null };
      const found = (stagingManager as any).findHunkContainingLine(hunks, targetLine);

      expect(found).toBe(hunks[0]);
    });

    it('should find hunk by new line number', () => {
      const hunks = [
        {
          header: '@@ -1,2 +1,3 @@',
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 3,
          lines: [
            { text: ' context', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
            { text: '+added', type: 'added' as const, oldLineNumber: null, newLineNumber: 2 },
            { text: ' context2', type: 'context' as const, oldLineNumber: 2, newLineNumber: 3 },
          ],
        },
      ];

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 2 };
      const found = (stagingManager as any).findHunkContainingLine(hunks, targetLine);

      expect(found).toBe(hunks[0]);
    });

    it('should return null if line not found', () => {
      const hunks = [
        {
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { text: ' context', type: 'context' as const, oldLineNumber: 1, newLineNumber: 1 },
            { text: ' context2', type: 'context' as const, oldLineNumber: 2, newLineNumber: 2 },
          ],
        },
      ];

      const targetLine = { type: 'added' as const, oldLineNumber: null, newLineNumber: 999 };
      const found = (stagingManager as any).findHunkContainingLine(hunks, targetLine);

      expect(found).toBeNull();
    });
  });

  describe('stageHunk', () => {
    it('should stage a full hunk from unstaged diff', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          // First call: get diff
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff',
        } as any)
        .mockResolvedValueOnce({
          // Second call: apply patch
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply',
        } as any);

      const result = await stagingManager.stageHunk({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: true,
        hunkHeader: '@@ -1,3 +1,4 @@',
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(2);

      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'diff']),
      }));

      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
      const [tempFile, patchText, encoding] = (fs.promises.writeFile as any).mock.calls[0] as [string, string, string];
      expect(tempFile).toMatch(/snowtree-patch-.*\.patch$/);
      expect(patchText).toContain('@@ -1,3 +1,4 @@');
      expect(encoding).toBe('utf8');
    });

    it('should unstage a full hunk from staged diff', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff --cached',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply -R',
        } as any);

      const result = await stagingManager.stageHunk({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        isStaging: false,
        hunkHeader: '@@ -1,3 +1,4 @@',
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(2);

      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'diff', '--cached', '--unified=3']),
      }));

      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'apply', '-R']),
      }));
    });
  });

  describe('restoreHunk', () => {
    it('should restore a hunk from unstaged diff (working tree)', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply -R',
        } as any);

      const result = await stagingManager.restoreHunk({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        scope: 'unstaged',
        hunkHeader: '@@ -1,3 +1,4 @@',
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(2);
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'diff', '--unified=3']),
      }));
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'apply', '-R']),
      }));
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
        argv: expect.arrayContaining(['--cached']),
      }));
    });

    it('should restore a hunk from staged diff by unstaging then restoring worktree', async () => {
      const mockDiff = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
+added line
 context2
 context3`;

      vi.mocked(mockGitExecutor.run)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: mockDiff,
          stderr: '',
          commandDisplay: 'git diff --cached',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply --cached -R',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          commandDisplay: 'git apply -R',
        } as any);

      const result = await stagingManager.restoreHunk({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        scope: 'staged',
        hunkHeader: '@@ -1,3 +1,4 @@',
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledTimes(3);
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'diff', '--cached', '--unified=3']),
      }));
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'apply', '--cached', '-R']),
      }));
      expect(mockGitExecutor.run).toHaveBeenNthCalledWith(3, expect.objectContaining({
        argv: expect.arrayContaining(['git', 'apply', '-R']),
      }));
    });
  });

  describe('changeAllStage', () => {
    it('should stage all using git add --all', async () => {
      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
        commandDisplay: 'git add --all',
      } as any);

      const result = await stagingManager.changeAllStage({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        stage: true,
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledWith(expect.objectContaining({
        argv: ['git', 'add', '--all'],
      }));
    });

    it('should unstage all using git reset', async () => {
      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
        commandDisplay: 'git reset',
      } as any);

      const result = await stagingManager.changeAllStage({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        stage: false,
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledWith(expect.objectContaining({
        argv: ['git', 'reset'],
      }));
    });
  });

  describe('changeFileStage', () => {
    it('should stage a file using git add --all -- <file>', async () => {
      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
        commandDisplay: 'git add --all -- test.txt',
      } as any);

      const result = await stagingManager.changeFileStage({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        stage: true,
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledWith(expect.objectContaining({
        argv: ['git', 'add', '--all', '--', 'test.txt'],
      }));
    });

    it('should unstage a file using git reset -- <file>', async () => {
      vi.mocked(mockGitExecutor.run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
        commandDisplay: 'git reset -- test.txt',
      } as any);

      const result = await stagingManager.changeFileStage({
        worktreePath: '/tmp/project',
        sessionId: 'test-session',
        filePath: 'test.txt',
        stage: false,
      });

      expect(result.success).toBe(true);
      expect(mockGitExecutor.run).toHaveBeenCalledWith(expect.objectContaining({
        argv: ['git', 'reset', '--', 'test.txt'],
      }));
    });
  });
});
