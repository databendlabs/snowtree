import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { promises as fs } from 'fs';
import { join } from 'path';

type RemotePullRequest = { number: number; url: string; merged: boolean };

/**
 * Parse a git remote URL and return the GitHub web URL for the repository.
 * Supports SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git) formats.
 */
function parseGitRemoteToGitHubUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

/**
 * Parse a git remote URL and return the owner/repo string for use with gh --repo flag.
 * Supports SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git) formats.
 */
function parseGitRemoteToOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

/**
 * Parse git remote -v output and extract owner/repo for the origin remote.
 */
function parseOwnerRepoFromRemoteOutput(remoteOutput: string): string | null {
  const lines = remoteOutput.split('\n');
  for (const line of lines) {
    // Format: "origin\tgit@github.com:owner/repo.git (fetch)"
    const match = line.match(/^origin\s+(\S+)/);
    if (match) {
      return parseGitRemoteToOwnerRepo(match[1]);
    }
  }
  return null;
}

export function registerGitHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { sessionManager, gitDiffManager, gitStagingManager, gitStatusManager, gitExecutor } = services;

  ipcMain.handle('sessions:get-executions', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not found' };

      const baseBranch = session.baseBranch || 'main';
      const baseCommit = session.baseCommit;
      const commits = await gitDiffManager.getCommitHistory(session.worktreePath, 50, baseCommit || baseBranch, sessionId);

      const executions = commits.map((commit, index) => ({
        id: index + 1,
        session_id: sessionId,
        execution_sequence: index + 1,
        after_commit_hash: commit.hash,
        parent_commit_hash: commit.parents[0] || null,
        commit_message: commit.message,
        timestamp: commit.date.toISOString(),
        stats_additions: commit.stats.additions,
        stats_deletions: commit.stats.deletions,
        stats_files_changed: commit.stats.filesChanged,
        author: commit.author,
        comparison_branch: baseBranch,
        history_source: 'git',
        history_limit_reached: commits.length === 50
      }));

      if (await gitDiffManager.hasChanges(session.worktreePath, sessionId)) {
        const stats = await gitDiffManager.getWorkingDiffStatsQuick(session.worktreePath, sessionId);
        executions.unshift({
          id: 0,
          session_id: sessionId,
          execution_sequence: 0,
          after_commit_hash: 'UNCOMMITTED',
          parent_commit_hash: null,
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: stats.additions,
          stats_deletions: stats.deletions,
          stats_files_changed: stats.filesChanged,
          author: 'You',
          comparison_branch: baseBranch,
          history_source: 'git',
          history_limit_reached: commits.length === 50
        });
      }

      // Append the base branch HEAD commit (single commit) for context.
      // Keep this lightweight and avoid spamming Conversations (read operations are not recorded by default).
      const resolveBaseRef = async (): Promise<string | null> => {
        try {
          await gitExecutor.run({
            cwd: session.worktreePath!,
            argv: ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`],
            op: 'read',
            recordTimeline: false,
            meta: { source: 'ipc.git', operation: 'base-ref-probe', ref: `refs/remotes/origin/${baseBranch}` },
          });
          return `origin/${baseBranch}`;
        } catch {
          // ignore
        }
        try {
          await gitExecutor.run({
            cwd: session.worktreePath!,
            argv: ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${baseBranch}`],
            op: 'read',
            recordTimeline: false,
            meta: { source: 'ipc.git', operation: 'base-ref-probe', ref: `refs/heads/${baseBranch}` },
          });
          return baseBranch;
        } catch {
          // ignore
        }
        try {
          await gitExecutor.run({
            cwd: session.worktreePath!,
            argv: ['git', 'rev-parse', '--verify', `${baseBranch}^{commit}`],
            op: 'read',
            recordTimeline: false,
            meta: { source: 'ipc.git', operation: 'base-ref-probe', ref: baseBranch },
          });
          return baseBranch;
        } catch {
          return null;
        }
      };

      const baseRef = await resolveBaseRef();
      if (baseRef) {
        try {
          const delimiter = '\x1f';
          const fmt = `%H${delimiter}%P${delimiter}%s${delimiter}%cI${delimiter}%an`;
          const { stdout } = await gitExecutor.run({
            cwd: session.worktreePath,
            argv: ['git', 'log', '-1', `--format=${fmt}`, baseRef],
            op: 'read',
            recordTimeline: false,
            meta: { source: 'ipc.git', operation: 'base-head', baseRef, baseBranch },
          });
          const line = stdout.trim();
          if (line) {
            const [hash, parentsRaw, subject, timestamp, author] = line.split(delimiter);
            if (hash) {
              executions.push({
                id: -1,
                session_id: sessionId,
                execution_sequence: -1,
                after_commit_hash: hash,
                parent_commit_hash: (parentsRaw || '').trim().split(/\s+/).filter(Boolean)[0] || null,
                commit_message: `[base/${baseBranch}] ${subject || ''}`.trim(),
                timestamp: timestamp || new Date().toISOString(),
                stats_additions: 0,
                stats_deletions: 0,
                stats_files_changed: 0,
                author: author || '',
                comparison_branch: baseBranch,
                history_source: 'git',
                history_limit_reached: commits.length === 50
              });
            }
          }
        } catch {
          // ignore
        }
      }

      return { success: true, data: executions };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load executions' };
    }
  });

  ipcMain.handle('sessions:get-diff', async (_event, sessionId: string, target?: { kind?: unknown; hash?: unknown }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not found' };

      const kind = typeof target?.kind === 'string' ? target.kind : 'working';
      if (kind === 'working') {
        const scopeRaw = (target as { scope?: unknown } | undefined)?.scope;
        const scope = (typeof scopeRaw === 'string' ? scopeRaw : 'all') as 'all' | 'staged' | 'unstaged' | 'untracked';

        if (scope === 'all') {
          const diff = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath, sessionId);
          const workingTree = await gitDiffManager.getWorkingTreeGroups(session.worktreePath, sessionId);
          return { success: true, data: { ...diff, workingTree } };
        }

        if (scope === 'staged' || scope === 'unstaged' || scope === 'untracked') {
          const diff = await gitDiffManager.captureWorkingTreeDiff(session.worktreePath, scope, sessionId);
          return { success: true, data: diff };
        }

        return { success: false, error: `Unsupported working diff scope: ${scope}` };
      }

      if (kind === 'commit') {
        const hash = typeof target?.hash === 'string' ? target.hash.trim() : '';
        if (!hash) return { success: false, error: 'Commit hash is required' };

        const diff = await gitDiffManager.getCommitDiff(session.worktreePath, hash, sessionId);
        return { success: true, data: diff };
      }

      return { success: false, error: `Unsupported diff target: ${kind}` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load diff' };
    }
  });

  ipcMain.handle('sessions:get-git-commands', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not found' };

      const { stdout } = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'branch', '--show-current'],
        op: 'read',
        meta: { source: 'ipc.git', operation: 'current-branch' },
      });
      const currentBranch = stdout.trim();

      return { success: true, data: { currentBranch } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load git commands' };
    }
  });

  ipcMain.handle('sessions:get-remote-pull-request', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not found' };

      // Get remote URL to extract owner/repo (workaround for gh CLI worktree issue)
      const remoteRes = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'remote', 'get-url', 'origin'],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 3_000,
        meta: { source: 'ipc.git', operation: 'get-remote-url' },
      });

      let repoArgs: string[] = [];
      if (remoteRes.exitCode === 0 && remoteRes.stdout?.trim()) {
        const url = remoteRes.stdout.trim();
        // Parse: git@github.com:owner/repo.git or https://github.com/owner/repo.git
        const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match) {
          // Get current branch name (required when using --repo)
          const branchRes = await gitExecutor.run({
            sessionId,
            cwd: session.worktreePath,
            argv: ['git', 'branch', '--show-current'],
            op: 'read',
            recordTimeline: false,
            throwOnError: false,
            timeoutMs: 3_000,
            meta: { source: 'ipc.git', operation: 'get-branch' },
          });
          const branch = branchRes.stdout?.trim();
          if (branch) {
            repoArgs = ['--repo', match[1], branch];
          }
        }
      }

      const res = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['gh', 'pr', 'view', ...repoArgs, '--json', 'number,url,state'],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 8_000,
        meta: { source: 'ipc.git', operation: 'remote-pr' },
      });

      if (res.exitCode !== 0) return { success: true, data: null };

      const raw = (res.stdout || '').trim();
      if (!raw) return { success: true, data: null };

      try {
        const parsed = JSON.parse(raw) as { number?: unknown; url?: unknown; state?: unknown } | null;
        const number = parsed && typeof parsed.number === 'number' ? parsed.number : null;
        const url = parsed && typeof parsed.url === 'string' ? parsed.url : '';
        const state = parsed && typeof parsed.state === 'string' ? parsed.state : '';
        const merged = state === 'MERGED';
        if (!number || !url) return { success: true, data: null };
        const out: RemotePullRequest = { number, url, merged };
        return { success: true, data: out };
      } catch {
        return { success: true, data: null };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load remote pull request' };
    }
  });

  ipcMain.handle('sessions:stage-hunk', async (_event, sessionId: string, options: {
    filePath: string;
    isStaging: boolean;
    hunkHeader: string;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const result = await gitStagingManager.stageHunk({
        worktreePath: session.worktreePath,
        sessionId,
        filePath: options.filePath,
        isStaging: options.isStaging,
        hunkHeader: options.hunkHeader,
      });

      if (result.success) {
        void gitStatusManager.refreshSessionGitStatus(sessionId, false);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage hunk',
      };
    }
  });

  ipcMain.handle('sessions:restore-hunk', async (_event, sessionId: string, options: {
    filePath: string;
    scope: 'staged' | 'unstaged';
    hunkHeader: string;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const result = await gitStagingManager.restoreHunk({
        worktreePath: session.worktreePath,
        sessionId,
        filePath: options.filePath,
        scope: options.scope,
        hunkHeader: options.hunkHeader,
      });

      if (result.success) {
        void gitStatusManager.refreshSessionGitStatus(sessionId, false);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore hunk',
      };
    }
  });

  ipcMain.handle('sessions:change-all-stage', async (_event, sessionId: string, options: {
    stage: boolean;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const result = await gitStagingManager.changeAllStage({
        worktreePath: session.worktreePath,
        sessionId,
        stage: options.stage,
      });

      if (result.success) {
        void gitStatusManager.refreshSessionGitStatus(sessionId, false);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to change stage state',
      };
    }
  });

  ipcMain.handle('sessions:change-file-stage', async (_event, sessionId: string, options: {
    filePath: string;
    stage: boolean;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const filePath = typeof options?.filePath === 'string' ? options.filePath.trim() : '';
      if (!filePath) return { success: false, error: 'File path is required' };
      const stage = Boolean(options?.stage);

      const result = await gitStagingManager.changeFileStage({
        worktreePath: session.worktreePath,
        sessionId,
        filePath,
        stage,
      });

      if (result.success) {
        void gitStatusManager.refreshSessionGitStatus(sessionId, false);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to change file stage state',
      };
    }
  });

  ipcMain.handle('sessions:restore-file', async (_event, sessionId: string, options: {
    filePath: string;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const filePath = typeof options?.filePath === 'string' ? options.filePath.trim() : '';
      if (!filePath) return { success: false, error: 'File path is required' };

      const result = await gitStagingManager.restoreFile({
        worktreePath: session.worktreePath,
        sessionId,
        filePath,
      });

      if (result.success) {
        void gitStatusManager.refreshSessionGitStatus(sessionId, false);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore file',
      };
    }
  });

  ipcMain.handle('sessions:get-file-content', async (_event, sessionId: string, options: {
    filePath: string;
    ref: 'HEAD' | 'INDEX' | 'WORKTREE';
    maxBytes?: number;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const filePath = typeof options?.filePath === 'string' ? options.filePath.trim() : '';
      if (!filePath) return { success: false, error: 'File path is required' };
      const ref = options?.ref === 'INDEX' || options?.ref === 'WORKTREE' ? options.ref : 'HEAD';
      const maxBytes = typeof options?.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : 1024 * 1024;

      if (ref === 'WORKTREE') {
        const abs = join(session.worktreePath, filePath);
        const buf = await fs.readFile(abs);
        if (buf.byteLength > maxBytes) {
          return { success: false, error: `File too large (${buf.byteLength} bytes)` };
        }
        return { success: true, data: { content: buf.toString('utf8') } };
      }

      const object = ref === 'INDEX' ? `:${filePath}` : `HEAD:${filePath}`;
      const result = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'show', '--format=', object],
        op: 'read',
        recordTimeline: false,
        meta: { source: 'ipc.git', operation: 'get-file-content', ref, filePath },
        timeoutMs: 15_000,
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'Failed to read file content' };
      }

      const content = result.stdout ?? '';
      if (Buffer.byteLength(content, 'utf8') > maxBytes) {
        return { success: false, error: `File too large (${Buffer.byteLength(content, 'utf8')} bytes)` };
      }

      return { success: true, data: { content } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file content' };
    }
  });

  // ============================================
  // Sync PR Workflow: Deterministic Operations
  // ============================================

  // Read PR template if exists
  ipcMain.handle('sessions:get-pr-template', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const cwd = session.worktreePath;
      const fs = require('fs');
      const path = require('path');

      // Common PR template paths
      const templatePaths = [
        path.join(cwd, '.github', 'PULL_REQUEST_TEMPLATE.md'),
        path.join(cwd, '.github', 'pull_request_template.md'),
        path.join(cwd, 'PULL_REQUEST_TEMPLATE.md'),
        path.join(cwd, 'pull_request_template.md'),
        path.join(cwd, 'docs', 'PULL_REQUEST_TEMPLATE.md'),
      ];

      for (const templatePath of templatePaths) {
        if (fs.existsSync(templatePath)) {
          const content = fs.readFileSync(templatePath, 'utf-8');
          return { success: true, data: { template: content, path: templatePath } };
        }
      }

      // No template found
      return { success: true, data: { template: null, path: null } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read PR template' };
    }
  });

  ipcMain.handle('sessions:get-sync-context', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const cwd = session.worktreePath;
      const baseBranch = session.baseBranch || 'main';

      // Run git read operations in parallel (excluding gh which needs --repo)
      const [statusRes, branchRes, logRes, diffStatRes, remoteRes] = await Promise.all([
        gitExecutor.run({
          sessionId, cwd, argv: ['git', 'status', '--porcelain'],
          op: 'read', recordTimeline: false, throwOnError: false,
          meta: { source: 'ipc.git', operation: 'sync-context-status' },
        }),
        gitExecutor.run({
          sessionId, cwd, argv: ['git', 'branch', '--show-current'],
          op: 'read', recordTimeline: false, throwOnError: false,
          meta: { source: 'ipc.git', operation: 'sync-context-branch' },
        }),
        gitExecutor.run({
          sessionId, cwd, argv: ['git', 'log', '--oneline', '-10'],
          op: 'read', recordTimeline: false, throwOnError: false,
          meta: { source: 'ipc.git', operation: 'sync-context-log' },
        }),
        gitExecutor.run({
          sessionId, cwd, argv: ['git', 'diff', '--cached', '--stat'],
          op: 'read', recordTimeline: false, throwOnError: false,
          meta: { source: 'ipc.git', operation: 'sync-context-diff-stat' },
        }),
        gitExecutor.run({
          sessionId, cwd, argv: ['git', 'remote', '-v'],
          op: 'read', recordTimeline: false, throwOnError: false,
          meta: { source: 'ipc.git', operation: 'sync-context-remote' },
        }),
      ]);

      // Parse owner/repo from remote for gh commands
      const ownerRepo = parseOwnerRepoFromRemoteOutput(remoteRes.stdout || '');

      // Now fetch PR info with --repo flag if available
      let prInfo: { number: number; url: string; state: string; title: string; body: string } | null = null;
      if (ownerRepo) {
        const prRes = await gitExecutor.run({
          sessionId, cwd,
          argv: ['gh', 'pr', 'view', '--repo', ownerRepo, '--json', 'number,url,state,title,body'],
          op: 'read', recordTimeline: false, throwOnError: false, timeoutMs: 8_000,
          meta: { source: 'ipc.git', operation: 'sync-context-pr' },
        });
        if (prRes.exitCode === 0 && prRes.stdout.trim()) {
          try {
            prInfo = JSON.parse(prRes.stdout.trim());
          } catch { /* ignore */ }
        }
      }

      return {
        success: true,
        data: {
          status: statusRes.stdout || '',
          branch: branchRes.stdout?.trim() || '',
          log: logRes.stdout || '',
          diffStat: diffStatRes.stdout || '',
          prInfo,
          baseBranch,
          ownerRepo,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get sync context' };
    }
  });

  ipcMain.handle('sessions:get-commit-github-url', async (_event, sessionId: string, options: {
    commitHash: string;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const commitHash = typeof options?.commitHash === 'string' ? options.commitHash.trim() : '';
      if (!commitHash) return { success: false, error: 'Commit hash is required' };

      // Get the remote origin URL
      const result = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'config', '--get', 'remote.origin.url'],
        op: 'read',
        recordTimeline: false,
        meta: { source: 'ipc.git', operation: 'get-remote-url' },
        timeoutMs: 5_000,
      });

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return { success: false, error: 'No remote origin configured' };
      }

      const gitHubBaseUrl = parseGitRemoteToGitHubUrl(result.stdout);
      if (!gitHubBaseUrl) {
        return { success: false, error: 'Remote is not a GitHub repository' };
      }

      const url = `${gitHubBaseUrl}/commit/${commitHash}`;
      return { success: true, data: { url } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get commit GitHub URL' };
    }
  });
}
