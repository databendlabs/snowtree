import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { API } from '../utils/api';

/**
 * Syncs workspace stage data for all sessions on load and periodically.
 * This ensures sidebar badges show correct stage without needing to click each workspace.
 */
export function useWorkspaceStageSync() {
  const { sessions, isLoaded, updateWorkspaceStage } = useSessionStore();
  const syncedSessionsRef = useRef<Set<string>>(new Set());
  const pollingTimerRef = useRef<number | null>(null);
  const pollingInFlightRef = useRef(false);

  // Fetch workspace stage for a single session
  const fetchStageForSession = useCallback(async (sessionId: string) => {
    try {
      const [prRes, syncRes] = await Promise.all([
        API.sessions.getRemotePullRequest(sessionId),
        API.sessions.getPrRemoteCommits(sessionId),
      ]);

      const remotePullRequest = prRes?.success && prRes.data && typeof prRes.data === 'object'
        ? (() => {
            const pr = prRes.data as { number?: unknown; url?: unknown; merged?: unknown };
            const number = typeof pr.number === 'number' ? pr.number : null;
            const url = typeof pr.url === 'string' ? pr.url : '';
            const merged = typeof pr.merged === 'boolean' ? pr.merged : false;
            return number && url ? { number, url, merged } : null;
          })()
        : null;

      const prSyncStatus = syncRes
        ? {
            localAhead: syncRes.ahead ?? 0,
            remoteAhead: syncRes.behind ?? 0,
            branch: syncRes.branch ?? null,
          }
        : null;

      updateWorkspaceStage(sessionId, { remotePullRequest, prSyncStatus });
    } catch {
      // Ignore errors - best effort sync
    }
  }, [updateWorkspaceStage]);

  // Initial sync when sessions are loaded
  useEffect(() => {
    if (!isLoaded) return;

    const sessionsToSync = sessions.filter(
      (s) => s.worktreePath && !syncedSessionsRef.current.has(s.id)
    );

    if (sessionsToSync.length === 0) return;

    // Mark as synced before fetching to avoid duplicate requests
    for (const s of sessionsToSync) {
      syncedSessionsRef.current.add(s.id);
    }

    // Fetch in parallel with a small concurrency limit
    const fetchAll = async () => {
      const batchSize = 3;
      for (let i = 0; i < sessionsToSync.length; i += batchSize) {
        const batch = sessionsToSync.slice(i, i + batchSize);
        await Promise.all(batch.map((s) => fetchStageForSession(s.id)));
      }
    };

    void fetchAll();
  }, [isLoaded, sessions, fetchStageForSession]);

  // Periodic refresh for all sessions (every 5 seconds)
  useEffect(() => {
    if (!isLoaded) return;

    const pollAll = async () => {
      if (pollingInFlightRef.current) return;
      if (document.visibilityState !== 'visible') return;
      pollingInFlightRef.current = true;
      try {
        const sessionsWithWorktree = sessions.filter((s) => s.worktreePath);
        const batchSize = 3;
        for (let i = 0; i < sessionsWithWorktree.length; i += batchSize) {
          const batch = sessionsWithWorktree.slice(i, i + batchSize);
          await Promise.all(batch.map((s) => fetchStageForSession(s.id)));
        }
      } finally {
        pollingInFlightRef.current = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollAll();
    };

    void pollAll();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    pollingTimerRef.current = window.setInterval(() => { void pollAll(); }, 5_000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pollingTimerRef.current) {
        window.clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [isLoaded, sessions, fetchStageForSession]);

  // Reset synced set when sessions change significantly (e.g., new session added)
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id));
    const syncedIds = syncedSessionsRef.current;

    // Remove stale entries
    for (const id of syncedIds) {
      if (!currentIds.has(id)) {
        syncedIds.delete(id);
      }
    }
  }, [sessions]);
}
