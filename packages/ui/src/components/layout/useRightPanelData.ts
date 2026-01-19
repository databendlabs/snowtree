import { useState, useCallback, useEffect, useRef } from 'react';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { FileChange } from './types';
import { useSessionStore } from '../../stores/sessionStore';
import { getCIStatus, type CIStatus } from '../../features/ci-status';

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
  state: 'draft' | 'open' | 'merged';
}

export interface BranchSyncStatus {
  commitsBehindMain: number;
  baseBranch: string;
}

export interface PRSyncStatus {
  localAhead: number;
  remoteAhead: number;
  branch: string | null;
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
  branchSyncStatus: BranchSyncStatus | null;
  prSyncStatus: PRSyncStatus | null;
  ciStatus: CIStatus | null;
  commitFiles: FileChange[];
  selection: Selection;
  isLoading: boolean;
  isMutating: boolean;
  error: string | null;

  selectWorkingTree: () => void;
  selectCommit: (hash: string) => void;
  refresh: () => void;
  refreshBranchSync: () => void;
  stageAll: (stage: boolean) => Promise<void>;
  stageFile: (filePath: string, stage: boolean) => Promise<void>;
}

const REQUEST_TIMEOUT = 15_000;
const PR_POLL_INTERVAL_MS = 5_000;
const CI_POLL_INTERVAL_MS = 30_000; // CI status polls less frequently to avoid GitHub API rate limits
const BRANCH_SYNC_POLL_INTERVAL_MS = 3_000;

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
  const [branchSyncStatus, setBranchSyncStatus] = useState<BranchSyncStatus | null>(null);
  const [prSyncStatus, setPrSyncStatus] = useState<PRSyncStatus | null>(null);
  const [ciStatus, setCIStatus] = useState<CIStatus | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileChange[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastGitStatusSignatureRef = useRef<string | null>(null);
  const prPollingTimerRef = useRef<number | null>(null);
  const prPollingAbortRef = useRef<AbortController | null>(null);
  const ciPollingTimerRef = useRef<number | null>(null);
  const ciPollingAbortRef = useRef<AbortController | null>(null);
  const branchSyncPollingTimerRef = useRef<number | null>(null);
  const branchSyncPollingAbortRef = useRef<AbortController | null>(null);

  const cancelPending = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    // Reset loading state when canceling pending requests to avoid stuck state
    setIsLoading(false);
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
    if (!sessionId) return null;
    try {
      const response = await withTimeout(
        API.sessions.getRemotePullRequest(sessionId),
        REQUEST_TIMEOUT,
        'Load remote PR'
      );
      if (signal.aborted) return null;
      if (response.success && response.data && typeof response.data === 'object') {
        const pr = response.data as { number?: unknown; url?: unknown; state?: unknown } | null;
        const number = pr && typeof pr.number === 'number' ? pr.number : null;
        const url = pr && typeof pr.url === 'string' ? pr.url : '';
        const state = pr && typeof pr.state === 'string' && (pr.state === 'draft' || pr.state === 'open' || pr.state === 'merged') ? pr.state : 'open';
        if (number && url) {
          return { number, url, state };
        }
      }
      return null;
    } catch (error) {
      void error;
      return null;
    }
  }, [sessionId]);

  const fetchBranchSyncStatus = useCallback(async (): Promise<BranchSyncStatus | null> => {
    if (!sessionId) return null;
    try {
      const result = await API.sessions.getCommitsBehindMain(sessionId);
      if (!result) return null;
      return {
        commitsBehindMain: result.behind,
        baseBranch: result.baseBranch,
      };
    } catch {
      return null;
    }
  }, [sessionId]);

  const fetchPRSyncStatus = useCallback(async (): Promise<PRSyncStatus | null> => {
    if (!sessionId) return null;
    try {
      const result = await API.sessions.getPrRemoteCommits(sessionId);
      if (!result) return null;
      return {
        localAhead: result.ahead,
        remoteAhead: result.behind,
        branch: result.branch,
      };
    } catch {
      return null;
    }
  }, [sessionId]);

  const fetchCIStatus = useCallback(async (): Promise<CIStatus | null> => {
    if (!sessionId) return null;
    try {
      return await getCIStatus(sessionId);
    } catch {
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

      // Initialize git cache on manual refresh (when showLoading is true)
      if (showLoading) {
        window.electronAPI.sessions.initGitCache(sessionId).catch(() => {
          // Ignore errors - cache init is optional
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      }
    } finally {
      // Always reset isLoading when showLoading was true, even if aborted
      // This prevents stuck loading state when requests are canceled
      if (showLoading) setIsLoading(false);
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
      setBranchSyncStatus(null);
      setPrSyncStatus(null);
      setCIStatus(null);
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

  // Poll PR status periodically to detect changes from GitHub
  useEffect(() => {
    if (!sessionId) {
      if (prPollingTimerRef.current) {
        window.clearInterval(prPollingTimerRef.current);
        prPollingTimerRef.current = null;
      }
      prPollingAbortRef.current?.abort();
      prPollingAbortRef.current = null;
      return;
    }

    const pollPRStatus = async () => {
      try {
        if (document.visibilityState !== 'visible') return;

        // Cancel previous in-flight poll (avoid races when refresh() also hits the endpoint).
        prPollingAbortRef.current?.abort();
        const controller = new AbortController();
        prPollingAbortRef.current = controller;

        const newPR = await fetchRemotePullRequest(controller.signal);
        if (controller.signal.aborted) return;

        // Update state if PR changed (created, updated, or deleted)
        setRemotePullRequest((current) => {
          // PR was created
          if (!current && newPR) {
            return newPR;
          }
          // PR was deleted
          if (current && !newPR) {
            return null;
          }
          // PR was updated
          if (current && newPR && (
            newPR.number !== current.number ||
            newPR.url !== current.url ||
            newPR.state !== current.state
          )) {
            return newPR;
          }
          // No change
          return current;
        });
      } catch (error) {
        void error;
        // Ignore polling errors to avoid spamming
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollPRStatus();
    };

    // Start polling immediately and then periodically
    void pollPRStatus();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    prPollingTimerRef.current = window.setInterval(pollPRStatus, PR_POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (prPollingTimerRef.current) {
        window.clearInterval(prPollingTimerRef.current);
        prPollingTimerRef.current = null;
      }
      prPollingAbortRef.current?.abort();
      prPollingAbortRef.current = null;
    };
  }, [sessionId, fetchRemotePullRequest]);

  // Poll CI status separately with longer interval to avoid GitHub API rate limits
  useEffect(() => {
    if (!sessionId) {
      if (ciPollingTimerRef.current) {
        window.clearInterval(ciPollingTimerRef.current);
        ciPollingTimerRef.current = null;
      }
      setCIStatus(null);
      return;
    }

    const pollCIStatus = async () => {
      if (document.visibilityState !== 'visible') return;

      ciPollingAbortRef.current?.abort();
      const controller = new AbortController();
      ciPollingAbortRef.current = controller;

      try {
        const newCIStatus = await fetchCIStatus();
        if (!controller.signal.aborted && newCIStatus !== null) {
          setCIStatus(newCIStatus);
        }
      } catch (error) {
        void error;
        // Ignore polling errors
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollCIStatus();
    };

    // Start polling immediately and then periodically
    void pollCIStatus();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    ciPollingTimerRef.current = window.setInterval(pollCIStatus, CI_POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (ciPollingTimerRef.current) {
        window.clearInterval(ciPollingTimerRef.current);
        ciPollingTimerRef.current = null;
      }
      ciPollingAbortRef.current?.abort();
      ciPollingAbortRef.current = null;
    };
  }, [sessionId, fetchCIStatus]);

  // Poll branch sync status periodically (requires fetch)
  useEffect(() => {
    if (!sessionId) {
      if (branchSyncPollingTimerRef.current) {
        window.clearInterval(branchSyncPollingTimerRef.current);
        branchSyncPollingTimerRef.current = null;
      }
      branchSyncPollingAbortRef.current?.abort();
      branchSyncPollingAbortRef.current = null;
      return;
    }

    const pollBranchSyncStatus = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        branchSyncPollingAbortRef.current?.abort();
        const controller = new AbortController();
        branchSyncPollingAbortRef.current = controller;

        const [newBranchSync, newPRSync] = await Promise.all([
          fetchBranchSyncStatus(),
          fetchPRSyncStatus(),
        ]);
        if (controller.signal.aborted) return;
        setBranchSyncStatus(newBranchSync);
        setPrSyncStatus(newPRSync);
      } catch {
        // Ignore polling errors
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollBranchSyncStatus();
    };

    void pollBranchSyncStatus();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    branchSyncPollingTimerRef.current = window.setInterval(pollBranchSyncStatus, BRANCH_SYNC_POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (branchSyncPollingTimerRef.current) {
        window.clearInterval(branchSyncPollingTimerRef.current);
        branchSyncPollingTimerRef.current = null;
      }
      branchSyncPollingAbortRef.current?.abort();
      branchSyncPollingAbortRef.current = null;
    };
  }, [sessionId, fetchBranchSyncStatus, fetchPRSyncStatus]);

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

  const refreshBranchSync = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [newBranchSync, newPRSync] = await Promise.all([
        fetchBranchSyncStatus(),
        fetchPRSyncStatus(),
      ]);
      setBranchSyncStatus(newBranchSync);
      setPrSyncStatus(newPRSync);
    } catch {
      // Ignore errors
    }
  }, [sessionId, fetchBranchSyncStatus, fetchPRSyncStatus]);

  // Sync workspace stage to session store for sidebar display
  const updateWorkspaceStage = useSessionStore((state) => state.updateWorkspaceStage);
  useEffect(() => {
    if (!sessionId) return;
    updateWorkspaceStage(sessionId, { remotePullRequest, prSyncStatus });
  }, [sessionId, remotePullRequest, prSyncStatus, updateWorkspaceStage]);

  return {
    commits,
    workingTree,
    workingTreeDiffs,
    remotePullRequest,
    branchSyncStatus,
    prSyncStatus,
    ciStatus,
    commitFiles,
    selection,
    isLoading,
    isMutating,
    error,
    selectWorkingTree,
    selectCommit,
    refresh,
    refreshBranchSync,
    stageAll,
    stageFile,
  };
}
