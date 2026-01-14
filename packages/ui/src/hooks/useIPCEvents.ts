import { useEffect } from 'react';
import { API } from '../utils/api';
import { useErrorStore } from '../stores/errorStore';
import { useSessionStore } from '../stores/sessionStore';
import type { GitStatus, Session } from '../types/session';
import notificationSound from '../assets/sounds/notification.wav';

export function useIPCEvents() {
  const { loadSessions, addSession, updateSession, deleteSession, setGitStatusLoading, updateSessionGitStatus } = useSessionStore();
  const { showError } = useErrorStore();

  useEffect(() => {
    let cancelled = false;
    API.sessions.getAll()
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          loadSessions(res.data as Session[]);
        } else if (!res.success) {
          showError({ title: 'Failed to Load Workspaces', error: res.error || 'Unknown error' });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        showError({ title: 'Failed to Load Workspaces', error: e instanceof Error ? e.message : String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [loadSessions, showError]);

  useEffect(() => {
    if (!window.electronAPI?.events) return;

    const unsubscribes: Array<() => void> = [];

    unsubscribes.push(window.electronAPI.events.onSessionsLoaded((sessions: Session[]) => {
      loadSessions(sessions);
    }));

    unsubscribes.push(window.electronAPI.events.onSessionCreated((session: Session) => {
      addSession(session);
      setGitStatusLoading(session.id, true);
    }));

    unsubscribes.push(window.electronAPI.events.onSessionUpdated((session: Session) => {
      updateSession(session);
    }));

    unsubscribes.push(window.electronAPI.events.onSessionDeleted((sessionData: { id?: string; sessionId?: string } | string) => {
      const sessionId = typeof sessionData === 'string' ? sessionData : (sessionData.id || sessionData.sessionId);
      if (!sessionId) return;
      deleteSession({ id: sessionId });
    }));

    unsubscribes.push(window.electronAPI.events.onGitStatusUpdated((data: { sessionId: string; gitStatus: GitStatus }) => {
      updateSessionGitStatus(data.sessionId, data.gitStatus);
      setGitStatusLoading(data.sessionId, false);
      window.dispatchEvent(new CustomEvent('git-status-updated', { detail: { sessionId: data.sessionId, gitStatus: data.gitStatus } }));
    }));

    const maybeOnLoading = window.electronAPI.events.onGitStatusLoading;
    if (maybeOnLoading) {
      unsubscribes.push(maybeOnLoading((data: { sessionId: string }) => {
        setGitStatusLoading(data.sessionId, true);
        window.dispatchEvent(new CustomEvent('git-status-loading', { detail: { sessionId: data.sessionId } }));
      }));
    }

    const maybeOnAgentCompleted = window.electronAPI.events.onAgentCompleted;
    if (maybeOnAgentCompleted) {
      unsubscribes.push(maybeOnAgentCompleted((data: { sessionId: string }) => {
        console.log('[useIPCEvents] Agent completed event received for session:', data.sessionId);
        const audio = new Audio(notificationSound);
        audio.volume = 0.3;
        audio.play().catch((err) => {
          console.error('[useIPCEvents] Failed to play notification sound:', err);
        });
      }));
    }

    return () => unsubscribes.forEach((u) => u());
  }, [loadSessions, addSession, updateSession, deleteSession, setGitStatusLoading, updateSessionGitStatus]);
}

