import { describe, it, expect, vi } from 'vitest';
import { GitDiffManager } from '../DiffManager';
import type { GitExecutor } from '../../../executors/git';

describe('GitDiffManager', () => {
  it('uses --unified=2 for staged working tree diff', async () => {
    const mockGitExecutor: GitExecutor = {
      run: vi.fn(async ({ argv }) => {
        if (argv[1] === 'rev-parse') {
          return { exitCode: 0, stdout: 'abc123\n', stderr: '' } as any;
        }

        if (argv[1] === 'diff' && argv.includes('--cached') && !argv.includes('--name-only') && !argv.includes('--shortstat')) {
          return { exitCode: 0, stdout: 'diff --git a/a.txt b/a.txt\n', stderr: '' } as any;
        }

        if (argv[1] === 'diff' && argv.includes('--cached') && argv.includes('--name-only')) {
          return { exitCode: 0, stdout: 'a.txt\n', stderr: '' } as any;
        }

        if (argv[1] === 'diff' && argv.includes('--cached') && argv.includes('--shortstat')) {
          return { exitCode: 0, stdout: ' 1 file changed, 1 insertion(+)\n', stderr: '' } as any;
        }

        return { exitCode: 0, stdout: '', stderr: '' } as any;
      }),
    } as any;

    const manager = new GitDiffManager(mockGitExecutor);
    await manager.captureWorkingTreeDiff('/tmp/repo', 'staged', 's1');

    const diffCall = vi
      .mocked(mockGitExecutor.run)
      .mock.calls.find((c) => (c[0] as any).argv?.[1] === 'diff' && (c[0] as any).argv?.includes('--cached') && !(c[0] as any).argv?.includes('--name-only') && !(c[0] as any).argv?.includes('--shortstat'));

    expect(diffCall).toBeTruthy();
    expect((diffCall?.[0] as any).argv).toEqual(expect.arrayContaining(['--unified=0']));
  });

  it('uses --unified=2 for commit diff (git show)', async () => {
    const mockGitExecutor: GitExecutor = {
      run: vi.fn(async ({ argv }) => {
        if (argv[1] === 'show' && argv.includes('--numstat')) {
          return { exitCode: 0, stdout: '1\t0\ta.txt\n', stderr: '' } as any;
        }
        if (argv[1] === 'show' && argv.includes('--name-only')) {
          return { exitCode: 0, stdout: 'a.txt\n', stderr: '' } as any;
        }
        if (argv[1] === 'show') {
          return { exitCode: 0, stdout: 'diff --git a/a.txt b/a.txt\n', stderr: '' } as any;
        }
        return { exitCode: 0, stdout: '', stderr: '' } as any;
      }),
    } as any;

    const manager = new GitDiffManager(mockGitExecutor);
    await manager.getCommitDiff('/tmp/repo', 'deadbeef', 's1');

    const showCall = vi
      .mocked(mockGitExecutor.run)
      .mock.calls.find((c) => (c[0] as any).argv?.[1] === 'show' && !(c[0] as any).argv?.includes('--name-only') && !(c[0] as any).argv?.includes('--numstat'));

    expect(showCall).toBeTruthy();
    expect((showCall?.[0] as any).argv).toEqual(expect.arrayContaining(['--unified=2']));
  });
});
