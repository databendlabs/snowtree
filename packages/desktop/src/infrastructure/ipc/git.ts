import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { promises as fs } from 'fs';
import { join } from 'path';

type RemotePullRequest = { number: number; url: string; state: 'draft' | 'open' | 'merged' };

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

type RemoteOwnerRepo = {
  owner: string;
  repo: string;
};

function parseGitRemoteToOwnerRepoParts(remoteUrl: string): RemoteOwnerRepo | null {
  const ownerRepo = parseGitRemoteToOwnerRepo(remoteUrl);
  if (!ownerRepo) return null;
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function isForkOfUpstream(originUrl: string, upstreamUrl: string): boolean {
  const origin = parseGitRemoteToOwnerRepoParts(originUrl);
  const upstream = parseGitRemoteToOwnerRepoParts(upstreamUrl);
  if (!origin || !upstream) return false;
  return origin.repo === upstream.repo && origin.owner !== upstream.owner;
}

/**
 * Fetch and cache repo information (branch, owner/repo, isFork, originOwnerRepo) for a session.
 * This should be called once per session to populate the cache.
 */
export async function fetchAndCacheRepoInfo(
  sessionId: string,
  worktreePath: string,
  sessionManager: AppServices['sessionManager'],
  gitExecutor: AppServices['gitExecutor']
): Promise<{ currentBranch: string; ownerRepo: string | null; isFork: boolean; originOwnerRepo: string | null } | null> {
  try {
    // Get current branch
    const branchRes = await gitExecutor.run({
      sessionId,
      cwd: worktreePath,
      argv: ['git', 'branch', '--show-current'],
      op: 'read',
      recordTimeline: false,
      throwOnError: false,
      timeoutMs: 3_000,
      meta: { source: 'ipc.git', operation: 'cache-branch' },
    });

    const currentBranch = branchRes.stdout?.trim() || '';

    // Get origin and upstream URLs
    const [originRes, upstreamRes] = await Promise.all([
      gitExecutor.run({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'remote', 'get-url', 'origin'],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 3_000,
        meta: { source: 'ipc.git', operation: 'cache-origin-url' },
      }),
      gitExecutor.run({
        sessionId,
        cwd: worktreePath,
        argv: ['git', 'remote', 'get-url', 'upstream'],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 3_000,
        meta: { source: 'ipc.git', operation: 'cache-upstream-url' },
      }),
    ]);

    const originUrl = originRes.exitCode === 0 ? originRes.stdout?.trim() : null;
    const upstreamUrl = upstreamRes.exitCode === 0 ? upstreamRes.stdout?.trim() : null;

    // Determine owner/repo and fork status
    let ownerRepo: string | null = null;
    let originOwnerRepo: string | null = null;
    let isFork = false;

    if (originUrl) {
      originOwnerRepo = parseGitRemoteToOwnerRepo(originUrl);
    }

    if (originUrl && upstreamUrl) {
      // Check if this is a fork workflow
      isFork = isForkOfUpstream(originUrl, upstreamUrl);
      // Prefer upstream repo if it's a fork
      ownerRepo = isFork ? parseGitRemoteToOwnerRepo(upstreamUrl) : originOwnerRepo;
    } else if (originUrl) {
      ownerRepo = originOwnerRepo;
    } else if (upstreamUrl) {
      ownerRepo = parseGitRemoteToOwnerRepo(upstreamUrl);
    }

    // Cache the results in the session
    const session = sessionManager.getSession(sessionId);
    if (session) {
      sessionManager.db.updateSession(sessionId, {
        current_branch: currentBranch,
        owner_repo: ownerRepo,
        is_fork: isFork,
        origin_owner_repo: originOwnerRepo,
      });
    }

    return { currentBranch, ownerRepo, isFork, originOwnerRepo };
  } catch (error) {
    console.error('[git.ts] Failed to fetch and cache repo info:', error);
    return null;
  }
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

function isImageFile(filePath: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(filePath);
}

function isBinaryFile(filePath: string): boolean {
  return /\.(exe|bin|dll|so|dylib|a|o|obj|zip|tar|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|class|jar|war|ear|pyc|wasm|ttf|otf|woff|woff2|eot)$/i.test(filePath);
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

      // Append the workspace base commit (or base branch HEAD when unavailable) for context.
      // Keep this lightweight and avoid spamming Conversations (read operations are not recorded by default).
      const resolveBaseRef = async (): Promise<string | null> => {
        if (baseCommit) {
          try {
            await gitExecutor.run({
              cwd: session.worktreePath!,
              argv: ['git', 'rev-parse', '--verify', `${baseCommit}^{commit}`],
              op: 'read',
              recordTimeline: false,
              meta: { source: 'ipc.git', operation: 'base-ref-probe', ref: baseCommit },
            });
            return baseCommit;
          } catch {
            // Fall through to remote/local probes
          }
        }

        // Use cached repo info to determine remote preference
        const dbSession = sessionManager.db.getSession(sessionId);
        const isFork = dbSession?.is_fork || false;

        let preferredRemote: 'origin' | 'upstream' | null = null;
        const originExists = Boolean(dbSession?.origin_owner_repo);
        const upstreamExists = isFork; // If it's a fork, upstream exists

        if (isFork) {
          preferredRemote = 'upstream';
        } else if (originExists) {
          preferredRemote = 'origin';
        }

        const remoteCandidates: Array<'origin' | 'upstream'> = [];
        if (preferredRemote) remoteCandidates.push(preferredRemote);
        if (preferredRemote !== 'origin' && originExists) remoteCandidates.push('origin');
        if (preferredRemote !== 'upstream' && upstreamExists) remoteCandidates.push('upstream');

        for (const remoteName of remoteCandidates) {
          try {
            await gitExecutor.run({
              cwd: session.worktreePath!,
              argv: ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/${remoteName}/${baseBranch}`],
              op: 'read',
              recordTimeline: false,
              meta: { source: 'ipc.git', operation: 'base-ref-probe', ref: `refs/remotes/${remoteName}/${baseBranch}` },
            });
            return `${remoteName}/${baseBranch}`;
          } catch {
            // Try next candidate
          }
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

      // Try to use cached data first
      const dbSession = sessionManager.db.getSession(sessionId);
      if (dbSession?.current_branch) {
        // Determine remote name from tracking branch if available
        let remoteName: string | null = null;
        const trackingRes = await gitExecutor.run({
          sessionId,
          cwd: session.worktreePath,
          argv: ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          op: 'read',
          throwOnError: false,
          meta: { source: 'ipc.git', operation: 'tracking-remote' },
        });

        if (trackingRes.exitCode === 0 && trackingRes.stdout.trim()) {
          const trackingBranch = trackingRes.stdout.trim();
          const slashIndex = trackingBranch.indexOf('/');
          if (slashIndex > 0) {
            remoteName = trackingBranch.substring(0, slashIndex);
          }
        }

        return { success: true, data: { currentBranch: dbSession.current_branch, remoteName } };
      }

      // Cache miss or first time - fetch and cache
      const repoInfo = await fetchAndCacheRepoInfo(sessionId, session.worktreePath, sessionManager, gitExecutor);
      if (!repoInfo) {
        return { success: false, error: 'Failed to fetch repo info' };
      }

      // Get remote name from tracking branch
      let remoteName: string | null = null;
      const trackingRes = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        op: 'read',
        throwOnError: false,
        meta: { source: 'ipc.git', operation: 'tracking-remote' },
      });

      if (trackingRes.exitCode === 0 && trackingRes.stdout.trim()) {
        const trackingBranch = trackingRes.stdout.trim();
        const slashIndex = trackingBranch.indexOf('/');
        if (slashIndex > 0) {
          remoteName = trackingBranch.substring(0, slashIndex);
        }
      }

      return { success: true, data: { currentBranch: repoInfo.currentBranch, remoteName } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load git commands' };
    }
  });

  ipcMain.handle('sessions:get-remote-pull-request', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) return { success: false, error: 'Session worktree not found' };

      // Try to use cached data first
      const dbSession = sessionManager.db.getSession(sessionId);
      let branch = dbSession?.current_branch;
      let ownerRepo = dbSession?.owner_repo;
      let isFork = dbSession?.is_fork || false;
      let originOwnerRepo = dbSession?.origin_owner_repo;

      // If cache miss, fetch and cache
      if (!branch || !ownerRepo) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, session.worktreePath, sessionManager, gitExecutor);
        if (!repoInfo) {
          return { success: true, data: null };
        }
        branch = repoInfo.currentBranch;
        ownerRepo = repoInfo.ownerRepo;
        isFork = repoInfo.isFork;
        originOwnerRepo = repoInfo.originOwnerRepo;
      }

      // Check if we have the necessary info
      if (!branch || !ownerRepo) {
        return { success: true, data: null };
      }

      // Get origin owner for fork workflow (derive from originOwnerRepo)
      let originOwner: string | null = null;
      if (isFork && originOwnerRepo) {
        originOwner = originOwnerRepo.split('/')[0];
      }

      // For fork workflow: try upstream first (ownerRepo), then origin (originOwnerRepo)
      // For non-fork: try origin first, then upstream
      const repoAttempts: Array<{ repo: string; remoteName: string }> = [];

      if (isFork) {
        if (ownerRepo) repoAttempts.push({ repo: ownerRepo, remoteName: 'upstream' });
        if (originOwnerRepo) repoAttempts.push({ repo: originOwnerRepo, remoteName: 'origin' });
      } else {
        if (ownerRepo) repoAttempts.push({ repo: ownerRepo, remoteName: 'origin' });
      }

      for (const { repo, remoteName } of repoAttempts) {
        // For upstream repo in fork workflow, use "owner:branch" format
        // For origin repo, use just "branch"
        const branchArg = remoteName === 'upstream' && originOwner ? `${originOwner}:${branch}` : branch;
        const repoArgs = ['--repo', repo, branchArg];

        const res = await gitExecutor.run({
          sessionId,
          cwd: session.worktreePath,
          argv: ['gh', 'pr', 'view', ...repoArgs, '--json', 'number,url,state,isDraft'],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 8_000,
          meta: { source: 'ipc.git', operation: 'remote-pr' },
        });

        if (res.exitCode !== 0) continue; // Try next remote

        const raw = (res.stdout || '').trim();
        if (!raw) continue; // Try next remote

        try {
          const parsed = JSON.parse(raw) as { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown } | null;
          const number = parsed && typeof parsed.number === 'number' ? parsed.number : null;
          const url = parsed && typeof parsed.url === 'string' ? parsed.url : '';
          const ghState = parsed && typeof parsed.state === 'string' ? parsed.state.toUpperCase() : '';
          const isDraft = parsed && typeof parsed.isDraft === 'boolean' ? parsed.isDraft : false;

          let prState: 'draft' | 'open' | 'merged';
          if (ghState === 'MERGED') {
            prState = 'merged';
          } else if (isDraft) {
            prState = 'draft';
          } else {
            prState = 'open';
          }

          if (!number || !url) continue; // Try next remote
          const out: RemotePullRequest = { number, url, state: prState };
          return { success: true, data: out }; // Found PR, return immediately
        } catch {
          continue; // Try next remote
        }
      }

      // No PR found in any remote
      return { success: true, data: null };
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
    ref: 'HEAD' | 'INDEX' | 'WORKTREE' | string;
    maxBytes?: number;
  }) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const filePath = typeof options?.filePath === 'string' ? options.filePath.trim() : '';
      if (!filePath) return { success: false, error: 'File path is required' };
      const ref = typeof options?.ref === 'string' ? options.ref : 'HEAD';
      const maxBytes = typeof options?.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : 1024 * 1024;

      const isImage = isImageFile(filePath);
      const isBinary = isBinaryFile(filePath);

      if (isBinary && !isImage) {
        return { success: false, error: 'Binary file content cannot be displayed' };
      }

      if (ref === 'WORKTREE') {
        // If filePath is absolute, use it directly; otherwise join with worktreePath
        const abs = filePath.startsWith('/') ? filePath : join(session.worktreePath, filePath);
        const buf = await fs.readFile(abs);
        if (buf.byteLength > maxBytes) {
          return { success: false, error: `File too large (${buf.byteLength} bytes)` };
        }
        const content = isImage ? buf.toString('base64') : buf.toString('utf8');
        return { success: true, data: { content } };
      }

      // Support INDEX, HEAD, and commit refs (e.g., commit hash)
      const object = ref === 'INDEX' ? `:${filePath}` : `${ref}:${filePath}`;
      const result = await gitExecutor.run({
        sessionId,
        cwd: session.worktreePath,
        argv: ['git', 'show', '--format=', object],
        op: 'read',
        recordTimeline: false,
        meta: { source: 'ipc.git', operation: 'get-file-content', ref, filePath },
        timeoutMs: 15_000,
        encoding: isImage ? 'base64' : 'utf8',
      });

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'Failed to read file content' };
      }

      const content = result.stdout ?? '';
      const size = isImage ? Math.floor(content.length * 3 / 4) : Buffer.byteLength(content, 'utf8');
      
      if (size > maxBytes) {
        return { success: false, error: `File too large (${size} bytes)` };
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

      // Use cached repo info to get owner/repo
      const dbSession = sessionManager.db.getSession(sessionId);
      let ownerRepo = dbSession?.owner_repo;
      let originOwnerRepo = dbSession?.origin_owner_repo;
      let isFork = dbSession?.is_fork || false;

      // If cache miss, fetch and cache
      if (!ownerRepo) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, session.worktreePath, sessionManager, gitExecutor);
        if (!repoInfo) {
          return { success: false, error: 'No remote configured' };
        }
        ownerRepo = repoInfo.ownerRepo;
        originOwnerRepo = repoInfo.originOwnerRepo;
        isFork = repoInfo.isFork;
      }

      if (!ownerRepo) {
        return { success: false, error: 'No remote configured' };
      }

      // For fork workflow, prefer upstream, then origin
      // For non-fork, use ownerRepo (which is already the correct one)
      const repoCandidates: string[] = [];
      if (isFork) {
        if (ownerRepo) repoCandidates.push(ownerRepo); // upstream
        if (originOwnerRepo) repoCandidates.push(originOwnerRepo); // origin
      } else {
        if (ownerRepo) repoCandidates.push(ownerRepo);
      }

      for (const repo of repoCandidates) {
        const url = `https://github.com/${repo}/commit/${commitHash}`;
        return { success: true, data: { url } };
      }

      return { success: false, error: 'No remote configured' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get commit GitHub URL' };
    }
  });

  // ============================================
  // Branch Sync: Get commits behind main
  // ============================================

  ipcMain.handle('sessions:get-commits-behind-main', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const cwd = session.worktreePath;
      const baseBranch = session.baseBranch || 'main';

      // Use cached repo info to determine if it's a fork workflow
      const dbSession = sessionManager.db.getSession(sessionId);
      let isFork = dbSession?.is_fork || false;

      // If cache miss, fetch and cache
      if (dbSession && dbSession.is_fork === null) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, cwd, sessionManager, gitExecutor);
        if (repoInfo) {
          isFork = repoInfo.isFork;
        }
      }

      // In fork workflows, we want to compare with upstream/main, not origin/main
      const remoteName = isFork ? 'upstream' : 'origin';

      // Fetch the remote to ensure we have latest refs
      await gitExecutor.run({
        sessionId,
        cwd,
        argv: ['git', 'fetch', remoteName, baseBranch],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 10_000,
        meta: { source: 'ipc.git', operation: 'fetch-main' },
      });

      // Count commits that remote/baseBranch has but current branch doesn't
      // git rev-list HEAD..{remote}/{baseBranch} --count
      const result = await gitExecutor.run({
        sessionId,
        cwd,
        argv: ['git', 'rev-list', `HEAD..${remoteName}/${baseBranch}`, '--count'],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 5_000,
        meta: { source: 'ipc.git', operation: 'commits-behind-main' },
      });

      if (result.exitCode !== 0) {
        // May fail if remote/baseBranch doesn't exist, return 0
        return { success: true, data: { behind: 0, baseBranch } };
      }

      const behind = parseInt(result.stdout.trim(), 10) || 0;
      return { success: true, data: { behind, baseBranch } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get commits behind main' };
    }
  });

  // ============================================
  // Branch Sync: Get remote PR commits ahead
  // ============================================

  ipcMain.handle('sessions:get-pr-remote-commits', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const cwd = session.worktreePath;

      // Try to use cached branch name
      const dbSession = sessionManager.db.getSession(sessionId);
      let branch = dbSession?.current_branch;

      // If cache miss, fetch and cache
      if (!branch) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, cwd, sessionManager, gitExecutor);
        if (!repoInfo) {
          return { success: true, data: { ahead: 0, behind: 0, branch: null } };
        }
        branch = repoInfo.currentBranch;
      }

      if (!branch) {
        return { success: true, data: { ahead: 0, behind: 0, branch: null } };
      }

      // For PR sync, we want to compare with the push destination (origin)
      // Not the upstream tracking branch (which might be upstream/main)
      // Get the push remote for this branch
      const pushRemoteRes = await gitExecutor.run({
        sessionId,
        cwd,
        argv: ['git', 'config', `branch.${branch}.pushRemote`],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 3_000,
        meta: { source: 'ipc.git', operation: 'get-push-remote' },
      });

      let remoteName = 'origin';
      let remoteSource: 'default' | 'pushRemote' | 'branchRemote' = 'default';
      const pushRemote = pushRemoteRes.stdout?.trim();

      if (pushRemote && pushRemoteRes.exitCode === 0) {
        remoteName = pushRemote;
        remoteSource = 'pushRemote';
      } else {
        // Fallback: check branch.{branch}.remote
        const branchRemoteRes = await gitExecutor.run({
          sessionId,
          cwd,
          argv: ['git', 'config', `branch.${branch}.remote`],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 3_000,
          meta: { source: 'ipc.git', operation: 'get-branch-remote' },
        });

        const branchRemote = branchRemoteRes.stdout?.trim();
        if (branchRemote && branchRemoteRes.exitCode === 0) {
          remoteName = branchRemote;
          remoteSource = 'branchRemote';
        }
      }

      const fetchAndCheckRemoteRef = async (candidateRemote: string): Promise<boolean> => {
        if (!candidateRemote) return false;
        // Fetch the remote branch to get latest refs
        await gitExecutor.run({
          sessionId,
          cwd,
          argv: ['git', 'fetch', candidateRemote, branch],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 10_000,
          meta: { source: 'ipc.git', operation: 'fetch-branch' },
        });

        // Check if remote branch exists
        const refCheckRes = await gitExecutor.run({
          sessionId,
          cwd,
          argv: ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/${candidateRemote}/${branch}`],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 3_000,
          meta: { source: 'ipc.git', operation: 'check-remote-ref' },
        });

        return refCheckRes.exitCode === 0;
      };

      let activeRemote = remoteName;
      let remoteRefExists = await fetchAndCheckRemoteRef(activeRemote);

      if (!remoteRefExists && remoteSource === 'branchRemote' && activeRemote !== 'origin') {
        const originRefExists = await fetchAndCheckRemoteRef('origin');
        if (originRefExists) {
          activeRemote = 'origin';
          remoteRefExists = true;
        }
      }

      if (!remoteRefExists) {
        // Remote branch doesn't exist
        return { success: true, data: { ahead: 0, behind: 0, branch } };
      }

      const remoteRef = `${activeRemote}/${branch}`;

      // Count commits: local ahead of remote and remote ahead of local
      const [aheadRes, behindRes] = await Promise.all([
        gitExecutor.run({
          sessionId,
          cwd,
          argv: ['git', 'rev-list', `${remoteRef}..HEAD`, '--count'],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 5_000,
          meta: { source: 'ipc.git', operation: 'local-ahead' },
        }),
        gitExecutor.run({
          sessionId,
          cwd,
          argv: ['git', 'rev-list', `HEAD..${remoteRef}`, '--count'],
          op: 'read',
          recordTimeline: false,
          throwOnError: false,
          timeoutMs: 5_000,
          meta: { source: 'ipc.git', operation: 'remote-ahead' },
        }),
      ]);

      const ahead = parseInt(aheadRes.stdout?.trim() || '0', 10) || 0;
      const behind = parseInt(behindRes.stdout?.trim() || '0', 10) || 0;

      return { success: true, data: { ahead, behind, branch } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get PR remote commits' };
    }
  });

  // ============================================
  // CI Status: Get PR check runs status
  // ============================================

  ipcMain.handle('sessions:get-ci-status', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: false, error: 'Session worktree not found' };
      }

      const cwd = session.worktreePath;

      // Use cached repo info
      const dbSession = sessionManager.db.getSession(sessionId);
      let branch = dbSession?.current_branch;
      let ownerRepo = dbSession?.owner_repo;
      let originOwnerRepo = dbSession?.origin_owner_repo;
      let isFork = dbSession?.is_fork || false;

      // If cache miss, fetch and cache
      if (!branch || !ownerRepo) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, cwd, sessionManager, gitExecutor);
        if (!repoInfo) {
          return { success: true, data: null };
        }
        branch = repoInfo.currentBranch;
        ownerRepo = repoInfo.ownerRepo;
        originOwnerRepo = repoInfo.originOwnerRepo;
        isFork = repoInfo.isFork;
      }

      if (!ownerRepo || !branch) {
        return { success: true, data: null };
      }

      // For fork workflow: when PR is on upstream, branch needs origin-owner prefix
      // e.g., "bohutang:feature-branch" instead of just "feature-branch"
      let branchRef = branch;
      if (originOwnerRepo && ownerRepo !== originOwnerRepo) {
        const originOwner = originOwnerRepo.split('/')[0];
        branchRef = `${originOwner}:${branch}`;
      }

      // Use gh pr checks to get CI status
      // gh pr checks --json returns: name, workflow, state (SUCCESS/FAILURE/PENDING/etc), startedAt, completedAt, link
      const checksRes = await gitExecutor.run({
        sessionId,
        cwd,
        argv: [
          'gh', 'pr', 'checks',
          '--repo', ownerRepo,
          branchRef,
          '--json', 'name,state,startedAt,completedAt,link,workflow',
        ],
        op: 'read',
        recordTimeline: false,
        throwOnError: false,
        timeoutMs: 8_000,
        meta: { source: 'ipc.git', operation: 'ci-status-checks' },
      });

      if (checksRes.exitCode !== 0) {
        // No PR or no checks
        return { success: true, data: null };
      }

      const raw = checksRes.stdout?.trim();
      if (!raw) {
        return { success: true, data: null };
      }

      try {
        const checksData = JSON.parse(raw) as Array<{
          name?: string;
          workflow?: string;
          state?: string;  // SUCCESS, FAILURE, PENDING, IN_PROGRESS, SKIPPED, etc
          startedAt?: string;
          completedAt?: string;
          link?: string;
        }>;

        if (!Array.isArray(checksData) || checksData.length === 0) {
          return { success: true, data: null };
        }

        // Map to our CICheck type
        // gh pr checks uses 'state' for the combined status/conclusion
        const checks = checksData.map((c, idx) => {
          const { status, conclusion } = parseGhCheckState(c.state);
          return {
            id: idx,
            name: c.name || 'Unknown',
            workflow: c.workflow || null,
            status,
            conclusion,
            startedAt: c.startedAt || null,
            completedAt: c.completedAt || null,
            detailsUrl: c.link || null,
          };
        });

        // Calculate counts
        let successCount = 0;
        let failureCount = 0;
        let pendingCount = 0;

        for (const check of checks) {
          if (check.status !== 'completed') {
            pendingCount++;
          } else if (check.conclusion === 'success' || check.conclusion === 'neutral' || check.conclusion === 'skipped') {
            successCount++;
          } else if (check.conclusion === 'failure') {
            failureCount++;
          }
        }

        // Determine rollup state
        let rollupState: 'pending' | 'in_progress' | 'success' | 'failure' | 'neutral';
        if (failureCount > 0) {
          rollupState = 'failure';
        } else if (checks.some(c => c.status === 'in_progress')) {
          rollupState = 'in_progress';
        } else if (checks.some(c => c.status === 'queued')) {
          rollupState = 'pending';
        } else if (successCount === checks.length) {
          rollupState = 'success';
        } else {
          rollupState = 'neutral';
        }

        return {
          success: true,
          data: {
            rollupState,
            checks,
            totalCount: checks.length,
            successCount,
            failureCount,
            pendingCount,
          },
        };
      } catch {
        return { success: true, data: null };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get CI status' };
    }
  });

  ipcMain.handle('sessions:mark-pr-ready', async (_event, sessionId: string) => {
    try {
      console.log('[git.ts] Mark PR ready called for session:', sessionId);
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        console.error('[git.ts] Session worktree not found');
        return { success: false, error: 'Session worktree not found' };
      }

      // Use cached repo info
      const dbSession = sessionManager.db.getSession(sessionId);
      let branch = dbSession?.current_branch;
      let ownerRepo = dbSession?.owner_repo;
      let originOwnerRepo = dbSession?.origin_owner_repo;
      let isFork = dbSession?.is_fork || false;

      // If cache miss, fetch and cache
      if (!branch || !ownerRepo) {
        const repoInfo = await fetchAndCacheRepoInfo(sessionId, session.worktreePath, sessionManager, gitExecutor);
        if (!repoInfo) {
          console.error('[git.ts] Failed to get repo info');
          return { success: false, error: 'Failed to get repo info' };
        }
        branch = repoInfo.currentBranch;
        ownerRepo = repoInfo.ownerRepo;
        originOwnerRepo = repoInfo.originOwnerRepo;
        isFork = repoInfo.isFork;
      }

      if (!branch || !ownerRepo) {
        console.error('[git.ts] Branch or owner/repo not found');
        return { success: false, error: 'Branch or owner/repo not found' };
      }

      console.log('[git.ts] Current branch:', branch);

      // Get origin owner for fork workflow
      let originOwner: string | null = null;
      if (isFork && originOwnerRepo) {
        originOwner = originOwnerRepo.split('/')[0];
      }
      console.log('[git.ts] Origin owner:', originOwner);

      // For fork workflow: try upstream first (ownerRepo), then origin (originOwnerRepo)
      // For non-fork: try origin only
      const repoAttempts: Array<{ repo: string; remoteName: string }> = [];

      if (isFork) {
        if (ownerRepo) repoAttempts.push({ repo: ownerRepo, remoteName: 'upstream' });
        if (originOwnerRepo) repoAttempts.push({ repo: originOwnerRepo, remoteName: 'origin' });
      } else {
        if (ownerRepo) repoAttempts.push({ repo: ownerRepo, remoteName: 'origin' });
      }

      for (const { repo, remoteName } of repoAttempts) {
        // For upstream repo in fork workflow, use "owner:branch" format
        // For origin repo, use just "branch"
        const branchArg = remoteName === 'upstream' && originOwner ? `${originOwner}:${branch}` : branch;

        console.log(`[git.ts] Trying ${remoteName} with repo=${repo}, branch=${branchArg}`);

        // Mark PR as ready for review using gh pr ready
        const readyRes = await gitExecutor.run({
          sessionId,
          cwd: session.worktreePath,
          argv: ['gh', 'pr', 'ready', '--repo', repo, branchArg],
          op: 'write',
          recordTimeline: true,
          throwOnError: false,
          timeoutMs: 30_000,
          meta: { source: 'ipc.git', operation: 'mark-pr-ready' },
        });

        console.log('[git.ts] gh pr ready result:', { exitCode: readyRes.exitCode, stdout: readyRes.stdout, stderr: readyRes.stderr });

        if (readyRes.exitCode === 0) {
          console.log('[git.ts] Successfully marked PR as ready');
          return { success: true };
        }

        // If failed, try next remote
        console.log(`[git.ts] Failed on ${remoteName}, trying next remote...`);
      }

      // Failed on all remotes
      console.error('[git.ts] Failed to mark PR as ready on all remotes');
      return { success: false, error: 'Failed to mark PR as ready' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark PR as ready'
      };
    }
  });
}

// Helper: parse gh pr checks 'state' field to status and conclusion
// gh pr checks state values: SUCCESS, FAILURE, PENDING, IN_PROGRESS, SKIPPED, CANCELLED, etc
function parseGhCheckState(state?: string): {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
} {
  const s = state?.toUpperCase();
  switch (s) {
    case 'PENDING':
    case 'QUEUED':
    case 'WAITING':
      return { status: 'queued', conclusion: null };
    case 'IN_PROGRESS':
      return { status: 'in_progress', conclusion: null };
    case 'SUCCESS':
      return { status: 'completed', conclusion: 'success' };
    case 'FAILURE':
    case 'ERROR':
      return { status: 'completed', conclusion: 'failure' };
    case 'CANCELLED':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'SKIPPED':
      return { status: 'completed', conclusion: 'skipped' };
    case 'NEUTRAL':
      return { status: 'completed', conclusion: 'neutral' };
    case 'TIMED_OUT':
      return { status: 'completed', conclusion: 'timed_out' };
    case 'ACTION_REQUIRED':
      return { status: 'completed', conclusion: 'action_required' };
    default:
      // Unknown state, treat as completed with null conclusion
      return { status: 'completed', conclusion: null };
  }
}
