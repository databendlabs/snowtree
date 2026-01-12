import { useState, useCallback, useEffect, useRef } from 'react';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { FileChange } from './types';

export interface Commit {
  id: number;
  commit_message: string;
  timestamp: string;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  after_commit_hash: string;
  parent_commit_hash?: string | null;
  author?: string;
}

export interface WorkingTree {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
}

export interface WorkingTreeDiffs {
  all: string;
  staged: string;
}

export interface RemotePullRequest {
  number: number;
  url: string;
  merged: boolean;
}

export type Selection =
  | { kind: 'working' }
  | { kind: 'commit'; hash: string }
  | null;

export interface RightPanelData {
  commits: Commit[];
  workingTree: WorkingTree | null;
  workingTreeDiffs: WorkingTreeDiffs;
  remotePullRequest: RemotePullRequest | null;
  commitFiles: FileChange[];
  selection: Selection;
  isLoading: boolean;
  isMutating: boolean;
  error: string | null;

  selectWorkingTree: () => void;
  selectCommit: (hash: string) => void;
  refresh: () => void;
  stageAll: (stage: boolean) => Promise<void>;
  stageFile: (filePath: string, stage: boolean) => Promise<void>;
}

const REQUEST_TIMEOUT = 15_000;

const toEpochMs = (timestamp: string) => {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
};

function orderCommitsNewestFirst(items: Commit[]): Commit[] {
  const uncommitted = items.filter((c) => c.id === 0);
  const base = items.filter((c) => c.id === -1);
  const sessionCommits = items.filter((c) => c.id > 0);

  sessionCommits.sort((a, b) => {
    const dt = toEpochMs(b.timestamp) - toEpochMs(a.timestamp);
    if (dt !== 0) return dt;
    const ha = a.after_commit_hash || '';
    const hb = b.after_commit_hash || '';
    return ha === hb ? 0 : ha < hb ? 1 : -1;
  });

  return [...uncommitted, ...sessionCommits, ...base];
}

function parseDiffToFiles(diffText: string): FileChange[] {
  const files: FileChange[] = [];
  const fileMatches = diffText.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
  if (!fileMatches) return files;

  for (const fileContent of fileMatches) {
    const fileNameMatch = fileContent.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
    if (!fileNameMatch) continue;

    const path = fileNameMatch[2] || fileNameMatch[1] || '';
    let type: FileChange['type'] = 'modified';

    if (fileContent.includes('new file mode')) type = 'added';
    else if (fileContent.includes('deleted file mode')) type = 'deleted';
    else if (fileContent.includes('rename from')) type = 'renamed';

    const additions = (fileContent.match(/^\+[^+]/gm) || []).length;
    const deletions = (fileContent.match(/^-[^-]/gm) || []).length;

    files.push({ path, additions, deletions, type });
  }

  return files;
}

export function useRightPanelData(sessionId: string | undefined): RightPanelData {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [workingTree, setWorkingTree] = useState<WorkingTree | null>(null);
  const [workingTreeDiffs, setWorkingTreeDiffs] = useState<WorkingTreeDiffs>({
    all: '',
    staged: '',
  });
  const [remotePullRequest, setRemotePullRequest] = useState<RemotePullRequest | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileChange[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastGitStatusSignatureRef = useRef<string | null>(null);
  const prPollingTimerRef = useRef<number | null>(null);

  const cancelPending = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (prPollingTimerRef.current) {
      window.clearInterval(prPollingTimerRef.current);
      prPollingTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cancelPending();
  }, [cancelPending]);

  const fetchCommits = useCallback(async (signal: AbortSignal): Promise<Commit[]> => {
    if (!sessionId) return [];
    const response = await withTimeout(
      API.sessions.getExecutions(sessionId),
      REQUEST_TIMEOUT,
      'Load commits'
    );
    if (signal.aborted) return [];
    if (response.success && response.data) {
      return orderCommitsNewestFirst(response.data as Commit[]);
    }
    throw new Error(response.error || 'Failed to load commits');
  }, [sessionId]);

  const fetchWorkingTreeSnapshot = useCallback(async (signal: AbortSignal): Promise<{ workingTree: WorkingTree; diffs: WorkingTreeDiffs }> => {
    const empty = { staged: [], unstaged: [], untracked: [] } satisfies WorkingTree;
    if (!sessionId) return { workingTree: empty, diffs: { all: '', staged: '' } };

    const response = await withTimeout(
      API.sessions.getDiff(sessionId, { kind: 'working', scope: 'all' } as any),
      REQUEST_TIMEOUT,
      'Load working tree'
    );

    if (signal.aborted) return { workingTree: empty, diffs: { all: '', staged: '' } };

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to load working tree');
    }

    const data = response.data as { workingTree?: WorkingTree; diff?: unknown };
    const workingTree = data.workingTree || empty;
    const diffs: WorkingTreeDiffs = {
      all: typeof data.diff === 'string' ? data.diff : '',
      staged: '',
    };

    // Best-effort staged diff for hunk progress (do not fail the panel if this request fails).
    const hasStagedFiles = (workingTree.staged?.length || 0) > 0;
    if (hasStagedFiles) {
      try {
        const stagedRes = await withTimeout(
          API.sessions.getDiff(sessionId, { kind: 'working', scope: 'staged' } as any),
          REQUEST_TIMEOUT,
          'Load staged diff'
        );
        if (!signal.aborted && stagedRes.success && stagedRes.data) {
          const stagedData = stagedRes.data as { diff?: unknown };
          diffs.staged = typeof stagedData.diff === 'string' ? stagedData.diff : '';
        }
      } catch {
        // ignore
      }
    }

    return { workingTree, diffs };
  }, [sessionId]);

  const fetchCommitFiles = useCallback(async (hash: string, signal: AbortSignal): Promise<FileChange[]> => {
    if (!sessionId) return [];
    const response = await withTimeout(
      API.sessions.getDiff(sessionId, { kind: 'commit', hash }),
      REQUEST_TIMEOUT,
      'Load commit files'
    );
    if (signal.aborted) return [];
    if (response.success && response.data) {
      const diffText = response.data.diff || '';
      const parsed = parseDiffToFiles(diffText);
      if (parsed.length > 0) return parsed;

      const changedFiles = Array.isArray((response.data as { changedFiles?: unknown }).changedFiles)
        ? ((response.data as { changedFiles?: unknown }).changedFiles as unknown[]).filter(
            (v): v is string => typeof v === 'string'
          )
        : [];
      return changedFiles.map((path) => ({ path, additions: 0, deletions: 0, type: 'modified' as const }));
    }

    const message = response.error || 'Failed to load commit files';
    const isStale = /commit not found|bad object|unknown revision|invalid object name|ambiguous argument/i.test(message);
    if (isStale) return [];
    throw new Error(message);
  }, [sessionId]);

  const fetchRemotePullRequest = useCallback(async (signal: AbortSignal): Promise<RemotePullRequest | null> => {
    if (!sessionId) {
      console.log('[fetchRemotePullRequest] No sessionId, returning null');
      return null;
    }
    try {
      console.log('[fetchRemotePullRequest] Fetching PR for sessionId:', sessionId);
      const response = await withTimeout(
        API.sessions.getRemotePullRequest(sessionId),
        REQUEST_TIMEOUT,
        'Load remote PR'
      );
      console.log('[fetchRemotePullRequest] API response:', response);
      if (signal.aborted) {
        console.log('[fetchRemotePullRequest] Signal aborted');
        return null;
      }
      if (response.success && response.data && typeof response.data === 'object') {
        const pr = response.data as { number?: unknown; url?: unknown; merged?: unknown } | null;
        const number = pr && typeof pr.number === 'number' ? pr.number : null;
        const url = pr && typeof pr.url === 'string' ? pr.url : '';
        const merged = pr && typeof pr.merged === 'boolean' ? pr.merged : false;
        if (number && url) {
          console.log('[fetchRemotePullRequest] Returning PR:', { number, url, merged });
          return { number, url, merged };
        }
      }
      console.log('[fetchRemotePullRequest] No valid PR data, returning null');
      return null;
    } catch (error) {
      console.error('[fetchRemotePullRequest] Error:', error);
      return null;
    }
  }, [sessionId]);

  const loadAll = useCallback(async (selectFirst: boolean, options?: { showLoading?: boolean }) => {
    if (!sessionId) return;

    cancelPending();
    const controller = new AbortController();
    abortRef.current = controller;

    const showLoading = options?.showLoading !== false;
    if (showLoading) setIsLoading(true);
    setError(null);

    try {
      const [newCommits, newSnapshot, newRemotePR] = await Promise.all([
        fetchCommits(controller.signal),
        fetchWorkingTreeSnapshot(controller.signal),
        fetchRemotePullRequest(controller.signal),
      ]);

      if (controller.signal.aborted) return;

      setCommits(newCommits);
      setWorkingTree(newSnapshot.workingTree);
      setWorkingTreeDiffs(newSnapshot.diffs);
      setRemotePullRequest(newRemotePR);

      const hasUncommitted = newCommits.some((c) => c.id === 0);
      if (selectFirst) {
        if (hasUncommitted) {
          setSelection({ kind: 'working' });
          setCommitFiles([]);
        } else {
          // Only select session commits (id > 0), never select base commit (id === -1)
          const first = newCommits.find((c) => c.id > 0);
          if (first) {
            setSelection({ kind: 'commit', hash: first.after_commit_hash });
            const files = await fetchCommitFiles(first.after_commit_hash, controller.signal);
            if (!controller.signal.aborted) setCommitFiles(files);
          } else {
            // If only base commit exists, don't select anything
            setSelection(null);
            setCommitFiles([]);
          }
        }
      } else if (hasUncommitted) {
        setSelection((prev) => prev ?? { kind: 'working' });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      }
    } finally {
      if (!controller.signal.aborted) {
        if (showLoading) setIsLoading(false);
      }
    }
  }, [sessionId, cancelPending, fetchCommits, fetchWorkingTreeSnapshot, fetchRemotePullRequest, fetchCommitFiles]);

  const refresh = useCallback(() => {
    void loadAll(false, { showLoading: true });
  }, [loadAll]);

  const backgroundRefresh = useCallback(() => {
    void loadAll(false, { showLoading: false });
  }, [loadAll]);

  // Use a ref to always have the latest refresh function without changing scheduleRefresh's identity
  const refreshRef = useRef(backgroundRefresh);
  useEffect(() => {
    refreshRef.current = backgroundRefresh;
  }, [backgroundRefresh]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      refreshRef.current();
    }, 150); // Fast refresh with smart loading to avoid UI flicker
  }, []); // No dependencies - scheduleRefresh identity is now stable

  useEffect(() => {
    if (!sessionId) {
      setCommits([]);
      setWorkingTree(null);
      setWorkingTreeDiffs({ all: '', staged: '' });
      setRemotePullRequest(null);
      setCommitFiles([]);
      setSelection(null);
      setError(null);
      return;
    }
    void loadAll(true, { showLoading: true });
  }, [sessionId, loadAll]);

  useEffect(() => {
    if (!sessionId || selection?.kind !== 'commit') return;

    cancelPending();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    fetchCommitFiles(selection.hash, controller.signal)
      .then((files) => {
        if (!controller.signal.aborted) {
          setCommitFiles(files);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load commit files');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });
  }, [sessionId, selection, cancelPending, fetchCommitFiles]);

  useEffect(() => {
    if (!sessionId) return;
    const unsub = window.electronAPI?.events?.onGitStatusUpdated?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const status = (data as { gitStatus?: unknown }).gitStatus as Record<string, unknown> | undefined;
      const signature = status ? JSON.stringify({
        state: status.state,
        staged: status.staged,
        modified: status.modified,
        untracked: status.untracked,
        conflicted: status.conflicted,
        ahead: status.ahead,
        behind: status.behind,
        additions: status.additions,
        deletions: status.deletions,
        filesChanged: status.filesChanged,
        hasUncommittedChanges: status.hasUncommittedChanges,
        hasUntrackedFiles: status.hasUntrackedFiles,
        isReadyToMerge: status.isReadyToMerge,
      }) : null;
      if (signature && lastGitStatusSignatureRef.current === signature) return;
      if (signature) lastGitStatusSignatureRef.current = signature;
      scheduleRefresh();
    });
    return () => { unsub?.(); };
  }, [sessionId, scheduleRefresh]);

  useEffect(() => {
    if (!sessionId) return;
    const unsub = window.electronAPI?.events?.onTimelineEvent?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const e = data.event as { kind?: unknown; status?: unknown; command?: unknown; meta?: unknown } | undefined;
      if (!e || (e.kind !== 'git.command' && e.kind !== 'cli.command')) return;
      if (e.status !== 'finished' && e.status !== 'failed') return;
      const meta = (e.meta || {}) as Record<string, unknown>;
      const source = typeof meta.source === 'string' ? meta.source : '';
      if (source !== 'agent') return;
      const cmd = typeof e.command === 'string' ? e.command.trim() : '';
      if (!cmd || !/^(git|gh)\b/.test(cmd)) return;
      const affectsHistory = /^(git\s+(add|commit|reset|checkout|switch|merge|rebase|cherry-pick|revert|stash|am|apply|rm|mv|tag)\b|gh\s+pr\s+(create|edit)\b)/.test(cmd);
      if (!affectsHistory) return;
      scheduleRefresh();
    });
    return () => { unsub?.(); };
  }, [sessionId, scheduleRefresh]);

  // Poll PR status every 5 seconds to detect changes from GitHub
  useEffect(() => {
    if (!sessionId) {
      if (prPollingTimerRef.current) {
        window.clearInterval(prPollingTimerRef.current);
        prPollingTimerRef.current = null;
      }
      return;
    }

    const pollPRStatus = async () => {
      try {
        console.log('[PR Polling] Starting poll for sessionId:', sessionId);
        const controller = new AbortController();
        const newPR = await fetchRemotePullRequest(controller.signal);
        console.log('[PR Polling] Received PR data:', newPR);
        if (controller.signal.aborted) {
          console.log('[PR Polling] Request aborted');
          return;
        }

        // Update state if PR changed (created, updated, or deleted)
        setRemotePullRequest((current) => {
          console.log('[PR Polling] Current state:', current, '| New state:', newPR);
          // PR was created
          if (!current && newPR) {
            console.log('[PR Polling] PR created, updating state');
            return newPR;
          }
          // PR was deleted
          if (current && !newPR) {
            console.log('[PR Polling] PR deleted, clearing state');
            return null;
          }
          // PR was updated
          if (current && newPR && (
            newPR.number !== current.number ||
            newPR.url !== current.url ||
            newPR.merged !== current.merged
          )) {
            console.log('[PR Polling] PR updated, updating state');
            return newPR;
          }
          // No change
          console.log('[PR Polling] No change detected');
          return current;
        });
      } catch (error) {
        console.error('[PR Polling] Error during poll:', error);
        // Ignore polling errors to avoid spamming
      }
    };

    // Start polling immediately and then every 5 seconds
    void pollPRStatus();
    prPollingTimerRef.current = window.setInterval(pollPRStatus, 5000);

    return () => {
      if (prPollingTimerRef.current) {
        window.clearInterval(prPollingTimerRef.current);
        prPollingTimerRef.current = null;
      }
    };
  }, [sessionId, fetchRemotePullRequest]);

  const selectWorkingTree = useCallback(() => {
    setSelection({ kind: 'working' });
    setCommitFiles([]);
  }, []);

  const selectCommit = useCallback((hash: string) => {
    setSelection({ kind: 'commit', hash });
  }, []);

  const stageAll = useCallback(async (stage: boolean) => {
    if (!sessionId || isMutating) return;
    setIsMutating(true);
    setError(null);
    try {
      await API.sessions.changeAllStage(sessionId, { stage });
      const controller = new AbortController();
      const snapshot = await fetchWorkingTreeSnapshot(controller.signal);
      setWorkingTree(snapshot.workingTree);
      setWorkingTreeDiffs(snapshot.diffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stage files');
    } finally {
      setIsMutating(false);
    }
  }, [sessionId, isMutating, fetchWorkingTreeSnapshot]);

  const stageFile = useCallback(async (filePath: string, stage: boolean) => {
    if (!sessionId || isMutating) return;
    setIsMutating(true);
    setError(null);
    try {
      await API.sessions.changeFileStage(sessionId, { filePath, stage });
      const controller = new AbortController();
      const snapshot = await fetchWorkingTreeSnapshot(controller.signal);
      setWorkingTree(snapshot.workingTree);
      setWorkingTreeDiffs(snapshot.diffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stage file');
    } finally {
      setIsMutating(false);
    }
  }, [sessionId, isMutating, fetchWorkingTreeSnapshot]);

  return {
    commits,
    workingTree,
    workingTreeDiffs,
    remotePullRequest,
    commitFiles,
    selection,
    isLoading,
    isMutating,
    error,
    selectWorkingTree,
    selectCommit,
    refresh,
    stageAll,
    stageFile,
  };
}
