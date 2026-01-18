import { useCallback, useEffect, useState } from 'react';
import { useErrorStore } from '../../stores/errorStore';
import type { TerminalClosedEvent, TerminalExitEvent, TerminalSummary } from '../../types/terminal';

export function useTerminalSessions(sessionId: string | null) {
  const { showError } = useErrorStore();
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.terminals) {
      setTerminals([]);
      return;
    }

    const response = await window.electronAPI.terminals.list(sessionId);
    if (response.success && response.data) {
      setTerminals(response.data);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setTerminals([]);
      return;
    }
    void refresh();
  }, [sessionId, refresh]);

  useEffect(() => {
    if (!sessionId || !window.electronAPI?.events) return undefined;

    const handleExited = (event: TerminalExitEvent) => {
      if (event.sessionId !== sessionId) return;
      setTerminals((prev) => prev.filter((terminal) => terminal.id !== event.terminalId));
    };

    const handleClosed = (event: TerminalClosedEvent) => {
      if (event.sessionId !== sessionId) return;
      setTerminals((prev) => prev.filter((terminal) => terminal.id !== event.terminalId));
    };

    const unsubscribeExit = window.electronAPI.events.onTerminalExited(handleExited);
    const unsubscribeClosed = window.electronAPI.events.onTerminalClosed(handleClosed);

    return () => {
      unsubscribeExit?.();
      unsubscribeClosed?.();
    };
  }, [sessionId]);

  const createTerminal = useCallback(async () => {
    if (!sessionId || !window.electronAPI?.terminals) return null;

    const response = await window.electronAPI.terminals.create(sessionId);
    if (!response.success || !response.data) {
      showError({ title: 'Failed to create terminal', error: response.error || 'Unknown error' });
      return null;
    }

    setTerminals((prev) => {
      if (prev.some((terminal) => terminal.id === response.data?.id)) return prev;
      return [...prev, response.data as TerminalSummary];
    });

    return response.data;
  }, [sessionId, showError]);

  const closeTerminal = useCallback(async (terminalId: string) => {
    if (!window.electronAPI?.terminals) return;

    const response = await window.electronAPI.terminals.close(terminalId);
    if (!response.success) {
      showError({ title: 'Failed to close terminal', error: response.error || 'Unknown error' });
    }
  }, [showError]);

  return {
    terminals,
    refresh,
    createTerminal,
    closeTerminal,
  };
}

export default useTerminalSessions;
