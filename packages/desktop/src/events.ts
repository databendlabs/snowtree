import type { BrowserWindow } from 'electron';
import type { AppServices } from './infrastructure/ipc';
import type { GitStatus } from '@snowtree/core/types/session';
import type { NormalizedEntry } from './executors/types';

type ExecutorLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

export function setupEventListeners(services: AppServices, getMainWindow: () => BrowserWindow | null): void {
  const { sessionManager, gitStatusManager, claudeExecutor, codexExecutor } = services;
  const lastSessionStatusById = new Map<string, string>();

  const send = (channel: string, ...args: unknown[]) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, ...args);
  };

  sessionManager.on('sessions-loaded', (sessions) => {
    if (Array.isArray(sessions)) {
      for (const s of sessions as Array<{ id?: unknown; status?: unknown }>) {
        const id = typeof s?.id === 'string' ? s.id : null;
        const status = typeof s?.status === 'string' ? s.status : null;
        if (id && status) lastSessionStatusById.set(id, status);
      }
    }
    send('sessions:loaded', sessions);
  });

  sessionManager.on('session-created', (session) => {
    const id = typeof (session as { id?: unknown })?.id === 'string' ? (session as { id: string }).id : null;
    const status = typeof (session as { status?: unknown })?.status === 'string' ? (session as { status: string }).status : null;
    if (id && status) lastSessionStatusById.set(id, status);
    send('session:created', session);
  });

  sessionManager.on('session-updated', (session) => {
    const id = typeof (session as { id?: unknown })?.id === 'string' ? (session as { id: string }).id : null;
    const status = typeof (session as { status?: unknown })?.status === 'string' ? (session as { status: string }).status : null;
    if (id && status) {
      const prev = lastSessionStatusById.get(id);
      lastSessionStatusById.set(id, status);

      // When a turn completes (running -> waiting), refresh git status so the right panel updates.
      if ((prev === 'running' || prev === 'initializing') && status === 'waiting') {
        console.log('[events.ts] Agent completed, sending agent:completed event for session:', id);
        send('agent:completed', { sessionId: id });
        gitStatusManager.refreshSessionGitStatus(id, false).catch(() => {
          // best-effort
        });
      }
    }
    send('session:updated', session);
  });

  sessionManager.on('session-deleted', (data) => {
    const sessionId = typeof data === 'string'
      ? data
      : (typeof (data as { id?: unknown })?.id === 'string'
          ? String((data as { id: string }).id)
          : (typeof (data as { sessionId?: unknown })?.sessionId === 'string'
              ? String((data as { sessionId: string }).sessionId)
              : null));
    if (sessionId) lastSessionStatusById.delete(sessionId);
    send('session:deleted', data);
  });

  sessionManager.on('timeline:event', (data: { sessionId: string; event: unknown }) => {
    send('timeline:event', data);
  });

  gitStatusManager.on('git-status-loading', (sessionId: string) => {
    send('git-status-loading', { sessionId });
  });

  gitStatusManager.on('git-status-updated', (sessionId: string, gitStatus: GitStatus) => {
    send('git-status-updated', { sessionId, gitStatus });
  });

  const wireExecutorLifecycle = (executor: ExecutorLike) => {
    const streamingAssistantBufferByPanel = new Map<string, { content: string; timestamp?: string }>();
    const lastAssistantByPanel = new Map<string, string>();
    const pendingStreamFlushByPanel = new Map<string, NodeJS.Timeout>();

    executor.on('spawned', (data: unknown) => {
      const sessionId = typeof (data as { sessionId?: unknown })?.sessionId === 'string'
        ? (data as { sessionId: string }).sessionId
        : null;
      if (!sessionId) return;
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      // Only transition to running if the session was explicitly initializing.
      // Spawning a long-lived background process (e.g. `codex app-server`) is not a "turn".
      if (session.status === 'initializing') {
        sessionManager.updateSessionStatus(sessionId, 'running');
      }
    });

    executor.on('entry', (rawEntry: unknown) => {
      const entry = rawEntry as NormalizedEntry;
      const meta = (entry.metadata || {}) as Record<string, unknown>;
      const panelId = typeof meta.panelId === 'string' ? meta.panelId : undefined;
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined;
      if (!panelId || !sessionId) {
        console.log('[events.ts] Entry missing panelId or sessionId:', entry.entryType, { panelId, sessionId });
        return;
      }

      // Handle TodoWrite tool calls
      if (entry.entryType === 'tool_use' && entry.toolName?.toLowerCase() === 'todowrite') {
        const input = (meta.input as { todos?: Array<{ status: string; content: string; activeForm?: string }> }) || {};
        if (input.todos && Array.isArray(input.todos)) {
          console.log('[events.ts] TodoWrite detected, sending session-todos:update event');
          send('session-todos:update', { sessionId, todos: input.todos });
        }
      }

      if (entry.entryType === 'assistant_message') {
        const content = typeof entry.content === 'string' ? entry.content : '';
        const trimmedContent = content.trim();
        const buffered = streamingAssistantBufferByPanel.get(panelId);
        const bufferedText = typeof buffered?.content === 'string' ? buffered.content : '';
        const trimmedBuffered = bufferedText.trim();
        const isStreaming = Boolean((meta as { streaming?: unknown }).streaming);

        if (isStreaming) {
          if (!trimmedContent) {
            console.log('[events.ts] Skipping empty streaming assistant_message');
            return;
          }

          console.log('[events.ts] assistant_message:', {
            isStreaming,
            contentLen: content.length,
            panelId: panelId.slice(0, 8),
          });
          streamingAssistantBufferByPanel.set(panelId, { content, timestamp: entry.timestamp });
          if (!pendingStreamFlushByPanel.has(panelId)) {
            const t = setTimeout(() => {
              pendingStreamFlushByPanel.delete(panelId);
              const latest = streamingAssistantBufferByPanel.get(panelId);
              const latestText = latest?.content || '';
              if (!latestText.trim()) return;
              console.log('[events.ts] Updating streaming assistant timeline, contentLen:', latestText.length);
              try {
                const tool = typeof meta.tool === 'string' ? meta.tool : undefined;
                sessionManager.upsertStreamingAssistantTimeline(panelId, sessionId, tool, latestText, latest?.timestamp);
              } catch {
                // best-effort
              }
            }, 100);
            pendingStreamFlushByPanel.set(panelId, t);
          }
          return;
        }

        if (!trimmedContent && !trimmedBuffered) {
          console.log('[events.ts] Skipping empty assistant_message');
          const pending = pendingStreamFlushByPanel.get(panelId);
          if (pending) clearTimeout(pending);
          pendingStreamFlushByPanel.delete(panelId);
          streamingAssistantBufferByPanel.delete(panelId);
          return;
        }

        console.log('[events.ts] assistant_message:', {
          isStreaming,
          contentLen: content.length,
          panelId: panelId.slice(0, 8),
        });
        const pending = pendingStreamFlushByPanel.get(panelId);
        if (pending) clearTimeout(pending);
        pendingStreamFlushByPanel.delete(panelId);

        let finalText = content;
        let finalTimestamp = entry.timestamp;
        if (trimmedBuffered) {
          const streamHasMore =
            !trimmedContent ||
            trimmedBuffered.length > trimmedContent.length ||
            (trimmedBuffered !== trimmedContent && trimmedBuffered.includes(trimmedContent));
          if (streamHasMore) {
            finalText = bufferedText;
            if (buffered?.timestamp) finalTimestamp = buffered.timestamp;
          }
        }

        if (!finalText.trim()) {
          streamingAssistantBufferByPanel.delete(panelId);
          return;
        }

        const last = lastAssistantByPanel.get(panelId);
        if (last === finalText) {
          streamingAssistantBufferByPanel.delete(panelId);
          return;
        }
        lastAssistantByPanel.set(panelId, finalText);
        streamingAssistantBufferByPanel.delete(panelId);
        try {
          const tool = typeof meta.tool === 'string' ? meta.tool : undefined;
          sessionManager.finalizeStreamingAssistantTimeline(panelId, sessionId, tool, finalText, finalTimestamp);
        } catch {
          // best-effort
        }
        try {
          sessionManager.addPanelConversationMessage(panelId, 'assistant', finalText, { recordTimeline: false });
        } catch {
          // best-effort
        }
        return;
      }

      if (entry.entryType === 'tool_use') {
        console.log('[events.ts] tool_use:', {
          toolName: entry.toolName,
          toolUseId: entry.toolUseId,
          content: entry.content,
          metadata: entry.metadata,
          panelId: panelId.slice(0, 8),
        });
      }

      if (entry.entryType === 'error_message') {
        const content = typeof entry.content === 'string' ? entry.content : 'Unknown error';
        if (content.trim()) {
          try {
            sessionManager.addPanelConversationMessage(panelId, 'assistant', content);
          } catch {
            // best-effort
          }
        }
        sessionManager.updateSessionStatus(sessionId, 'error');
      }
    });

    executor.on('exit', (data: unknown) => {
      const panelId = typeof (data as { panelId?: unknown })?.panelId === 'string'
        ? (data as { panelId: string }).panelId
        : null;
      const sessionId = typeof (data as { sessionId?: unknown })?.sessionId === 'string'
        ? (data as { sessionId: string }).sessionId
        : null;
      const exitCode = (data as { exitCode?: unknown })?.exitCode;
      const signal = (data as { signal?: unknown })?.signal;
      if (!sessionId) return;
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      if (session.status === 'stopped') return;

      if (panelId) {
        const timer = pendingStreamFlushByPanel.get(panelId);
        if (timer) clearTimeout(timer);
        pendingStreamFlushByPanel.delete(panelId);

        const buffered = streamingAssistantBufferByPanel.get(panelId);
        const bufferedText = buffered?.content || '';
        if (bufferedText.trim()) {
          const last = lastAssistantByPanel.get(panelId);
          if (last !== bufferedText) {
            lastAssistantByPanel.set(panelId, bufferedText);
            try {
              sessionManager.finalizeStreamingAssistantTimeline(panelId, sessionId, undefined, bufferedText, buffered?.timestamp);
            } catch {
              // best-effort
            }
            try {
              sessionManager.addPanelConversationMessage(panelId, 'assistant', bufferedText, { recordTimeline: false });
            } catch {
              // best-effort
            }
          }
        }
        streamingAssistantBufferByPanel.delete(panelId);
        try {
          sessionManager.clearStreamingAssistantTimeline(panelId);
        } catch {
          // best-effort
        }
      }

      const code = typeof exitCode === 'number' ? exitCode : null;
      const sig = typeof signal === 'number' ? signal : null;

      if (code !== null && code !== 0) {
        sessionManager.updateSessionStatus(sessionId, 'error', `Exited with code ${code}`);
        return;
      }

      if (sig !== null) {
        // If the process was terminated but the session wasn't explicitly stopped, keep it usable.
        sessionManager.updateSessionStatus(sessionId, 'waiting');
        return;
      }

      sessionManager.updateSessionStatus(sessionId, 'waiting');
    });

    executor.on('error', (data: unknown) => {
      const sessionId = typeof (data as { sessionId?: unknown })?.sessionId === 'string'
        ? (data as { sessionId: string }).sessionId
        : null;
      if (!sessionId) return;
      const error = (data as { error?: unknown })?.error;
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      sessionManager.updateSessionStatus(sessionId, 'error', message);
    });
  };

  wireExecutorLifecycle(claudeExecutor);
  wireExecutorLifecycle(codexExecutor);
}
