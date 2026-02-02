import { test as base } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Inject comprehensive mock electronAPI before page loads
    await page.addInitScript(() => {
      // State management for mock
      const mockState = {
        sessions: new Map(),
        currentSessionId: null as string | null,
        eventListeners: new Map<string, Function[]>(),
        pendingEvents: [] as Array<{ channel: string; data: any }>,
      };

      (window as any).__e2e_lastStageHunk = null;
      (window as any).__e2e_lastRestoreHunk = null;
      (window as any).__e2e_lastChangeAllStage = null;
      (window as any).__e2e_lastChangeFileStage = null;

      const persistMockState = () => {
        try {
          const sessions = Array.from(mockState.sessions.values());
          localStorage.setItem('__e2e_sessions', JSON.stringify(sessions));
          localStorage.setItem('__e2e_activeSessionId', JSON.stringify(mockState.currentSessionId));
        } catch (e) {
          console.warn('[Mock State] Failed to persist state:', e);
        }
      };

      const restoreMockState = () => {
        try {
          const sessionsRaw = localStorage.getItem('__e2e_sessions');
          const activeRaw = localStorage.getItem('__e2e_activeSessionId');
          const sessions: any[] = sessionsRaw ? JSON.parse(sessionsRaw) : [];
          const active: string | null = activeRaw ? JSON.parse(activeRaw) : null;

          if (Array.isArray(sessions)) {
            sessions.forEach((s) => {
              if (s?.id) mockState.sessions.set(s.id, s);
            });
          }
          if (typeof active === 'string') {
            mockState.currentSessionId = active;
          }
        } catch (e) {
          console.warn('[Mock State] Failed to restore state:', e);
        }
      };

      restoreMockState();

      const mockProject = {
        id: 1,
        name: 'E2E Test Repository',
        path: '/mock/repo/path',
        active: true,
        worktrees: [
          {
            id: 1,
            project_id: 1,
            path: '/mock/repo/path',
            branch: 'main',
            is_main: true,
          },
          {
            id: 2,
            project_id: 1,
            path: '/mock/repo/path-feature',
            branch: 'feature/e2e',
            is_main: false,
          },
        ],
      };

      const mockDiffStaged = `diff --git a/src/components/Staged.tsx b/src/components/Staged.tsx
index 1111111..2222222 100644
--- a/src/components/Staged.tsx
+++ b/src/components/Staged.tsx
@@ -1,3 +1,4 @@
 export const Staged = () => {
-  return "old";
+  return "new";
 };
`;

      const mockDiffUnstaged = `diff --git a/src/components/Example.tsx b/src/components/Example.tsx
index 3333333..4444444 100644
--- a/src/components/Example.tsx
+++ b/src/components/Example.tsx
@@ -10,7 +10,9 @@ export const Example = () => {
   const [state, setState] = useState(false);
-  // Old comment
+  // Updated comment
+  const newFeature = true;
+  const longLine = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
   return (
     <div>Example Component</div>
   );
 };
diff --git a/src/utils/helper.ts b/src/utils/helper.ts
index 5555555..6666666 100644
--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -1,3 +1,5 @@
 export function helper() {
-  return "old";
+  const result = "new";
+  console.log(result);
+  return result;
 }
`;

      const mockWorkingTree = () => ({
        staged: [
          { path: 'src/components/Staged.tsx', additions: 2, deletions: 1, type: 'modified' as const },
        ],
        unstaged: [
          { path: 'src/components/Example.tsx', additions: 5, deletions: 2, type: 'modified' as const },
          { path: 'src/utils/helper.ts', additions: 3, deletions: 1, type: 'modified' as const },
        ],
        untracked: [
          { path: 'src/new-file.ts', additions: 10, deletions: 0, type: 'added' as const },
        ],
      });

      const createMockDiffResult = (target: any) => {
        if (target?.kind === 'working') {
          const scope = target.scope || 'all';
          const diff =
            scope === 'staged'
              ? mockDiffStaged
              : scope === 'unstaged'
                ? mockDiffUnstaged
                : scope === 'untracked'
                  ? ''
                  : `${mockDiffStaged}\n${mockDiffUnstaged}`;

          return {
            diff,
            stats: { additions: 8, deletions: 3, filesChanged: 3 },
            changedFiles: ['src/components/Staged.tsx', 'src/components/Example.tsx', 'src/utils/helper.ts'],
            ...(scope === 'all' ? { workingTree: mockWorkingTree() } : {}),
          };
        }

        // Commit diff
        return {
          diff: `${mockDiffStaged}\n${mockDiffUnstaged}`,
          stats: { additions: 8, deletions: 3, filesChanged: 3 },
          changedFiles: ['src/components/Staged.tsx', 'src/components/Example.tsx', 'src/utils/helper.ts'],
        };
      };

      // Mock git status with files
      const createMockGitStatus = () => ({
        staged: [
          { path: 'src/components/Staged.tsx', status: 'modified', additions: 2, deletions: 1 },
        ],
        unstaged: [
          { path: 'src/components/Example.tsx', status: 'modified', additions: 5, deletions: 2 },
          { path: 'src/utils/helper.ts', status: 'modified', additions: 3, deletions: 1 },
        ],
        untracked: [
          { path: 'src/new-file.ts', status: 'untracked', additions: 10, deletions: 0 },
        ],
      });

      // Mock timeline events
      const createMockTimeline = () => ({
        events: [
          {
            id: 1,
            sessionId: mockState.currentSessionId,
            type: 'user',
            content: 'Help me review these changes',
            timestamp: new Date(Date.now() - 5000).toISOString(),
          },
          {
            id: 2,
            sessionId: mockState.currentSessionId,
            type: 'assistant',
            content: 'I can help you review the changes in this repository.',
            timestamp: new Date(Date.now() - 3000).toISOString(),
          },
        ],
        executions: [],
      });

      const createMockExecutions = () => {
        const now = new Date();
        const ts = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
        return [
          {
            id: 0,
            commit_message: 'Uncommitted changes',
            timestamp: ts(10_000),
            stats_additions: 8,
            stats_deletions: 3,
            stats_files_changed: 3,
            after_commit_hash: '',
            parent_commit_hash: null,
            author: 'E2E',
          },
          {
            id: -1,
            commit_message: 'Base commit',
            timestamp: ts(20_000),
            stats_additions: 0,
            stats_deletions: 0,
            stats_files_changed: 0,
            after_commit_hash: 'base1234',
            parent_commit_hash: null,
            author: 'E2E',
          },
        ];
      };

      // Emit mock event
      const emitEvent = (channel: string, data: any) => {
        const listeners = mockState.eventListeners.get(channel) || [];
        console.log(`[Mock Events] Emitting event '${channel}' to ${listeners.length} listener(s)`);

        if (listeners.length === 0) {
          // No listeners yet, save to pending queue
          console.log(`[Mock Events] No listeners for '${channel}', saving to pending queue`);
          mockState.pendingEvents.push({ channel, data });
          return;
        }

        // Use queueMicrotask for faster event emission
        listeners.forEach((callback, index) => {
          queueMicrotask(() => {
            try {
              console.log(`[Mock Events] Calling listener ${index} for '${channel}'`);
              callback(data);
              console.log(`[Mock Events] Listener ${index} for '${channel}' completed`);
            } catch (e) {
              console.error(`[Mock Events] Error in listener ${index} for '${channel}':`, e);
            }
          });
        });
      };

      (window as any).electronAPI = {
        projects: {
          async getAll() {
            return {
              success: true,
              data: [mockProject],
            };
          },
          async create(request: any) {
            return {
              success: true,
              data: { ...mockProject, id: Date.now(), ...request },
            };
          },
          async delete(projectId: number) {
            return { success: true, data: null };
          },
          async update(projectId: number, updates: any) {
            return {
              success: true,
              data: { ...mockProject, ...updates },
            };
          },
          async getWorktrees(projectId: number) {
            return {
              success: true,
              data: mockProject.worktrees,
            };
          },
        },
        sessions: {
          async getAll() {
            // Return any existing sessions from mockState
            const sessions = Array.from(mockState.sessions.values());
            console.log(`[Mock API] sessions.getAll() called, returning ${sessions.length} session(s)`);
            return {
              success: true,
              data: sessions,
            };
          },
          async get(sessionId: string) {
            const session = mockState.sessions.get(sessionId);
            if (!session) {
              return {
                success: false,
                error: 'Session not found',
              };
            }
            return {
              success: true,
              data: session,
            };
          },
          async create(request: any) {
            const sessionId = `session-${Date.now()}`;
            const leafName = mockProject.path.split('/').filter(Boolean).pop() || 'workspace';
            const session = {
              id: sessionId,
              name: leafName,
              projectId: request.projectId || 1,
              worktreePath: mockProject.path,
              branch: 'main',
              createdAt: new Date().toISOString(),
              status: 'waiting',
              prompt: request.prompt || '',
              toolType: request.toolType || 'claude',
            };
            mockState.sessions.set(sessionId, session);
            mockState.currentSessionId = sessionId;
            persistMockState();

            // Emit session created event
            setTimeout(() => {
              emitEvent('session:created', session);
              emitEvent('session:state-changed', { sessionId, state: 'ready' });
            }, 100);

            return {
              success: true,
              data: session,
            };
          },
          async openWorktree(request: any) {
            const sessionId = `session-wt-${Date.now()}`;
            const leafName = String(request.worktreePath || mockProject.path).split('/').filter(Boolean).pop() || 'workspace';
            const session = {
              id: sessionId,
              name: leafName,
              projectId: request.projectId || 1,
              worktreePath: request.worktreePath || mockProject.path,
              branch: request.branch || 'main',
              createdAt: new Date().toISOString(),
              status: 'ready',
              toolType: 'claude',
              gitStatus: createMockGitStatus(),
            };
            mockState.sessions.set(sessionId, session);
            mockState.currentSessionId = sessionId;
            persistMockState();

            console.log('[Mock] Session created:', sessionId);

            // Return first, then emit events asynchronously
            const result = {
              success: true as const,
              data: session,
            };

            // Emit events in next microtask so they fire after openWorktree returns
            // but before any re-renders that might unregister listeners
            queueMicrotask(() => {
              console.log('[Mock] Emitting session:created event');
              emitEvent('session:created', session);
              emitEvent('git:status-updated', { sessionId, gitStatus: createMockGitStatus() });
            });

            return result;
          },
          async stop(sessionId: string) {
            const session = mockState.sessions.get(sessionId);
            if (session) {
              emitEvent('session:stopped', { sessionId });
            }
            return { success: true, data: null };
          },
          async delete(sessionId: string) {
            mockState.sessions.delete(sessionId);
            if (mockState.currentSessionId === sessionId) {
              mockState.currentSessionId = null;
            }
            persistMockState();
            emitEvent('session:deleted', { sessionId });
            return { success: true, data: null };
          },
          async getTimeline(sessionId: string) {
            return {
              success: true,
              data: createMockTimeline(),
            };
          },
          async getExecutions(sessionId: string) {
            return {
              success: true,
              data: createMockExecutions(),
            };
          },
          async getDiff(sessionId: string, target: any) {
            return {
              success: true,
              data: createMockDiffResult(target),
            };
          },
          async getFileContent(sessionId: string, options: any) {
            const filePath = typeof options?.filePath === 'string' ? options.filePath : '';
            const content = [
              `// mock content for ${filePath || 'unknown'}`,
              'line 1',
              'line 2',
              'line 3',
              'line 4',
              'line 5',
            ].join('\n');
            return { success: true, data: { content } };
          },
          async getGitCommands(sessionId: string) {
            return {
              success: true,
              data: [
                { command: 'git status', timestamp: new Date().toISOString() },
              ],
            };
          },
          async stageHunk(sessionId: string, options: any) {
            (window as any).__e2e_lastStageHunk = { sessionId, options };
            setTimeout(() => {
              emitEvent('git:status-updated', { sessionId, gitStatus: createMockGitStatus() });
            }, 50);
            return { success: true, data: { success: true } };
          },
          async restoreHunk(sessionId: string, options: any) {
            (window as any).__e2e_lastRestoreHunk = { sessionId, options };
            setTimeout(() => {
              emitEvent('git:status-updated', { sessionId, gitStatus: createMockGitStatus() });
            }, 50);
            return { success: true, data: { success: true } };
          },
          async changeAllStage(sessionId: string, options: any) {
            (window as any).__e2e_lastChangeAllStage = { sessionId, options };
            setTimeout(() => {
              emitEvent('git:status-updated', { sessionId, gitStatus: createMockGitStatus() });
            }, 50);
            return { success: true, data: { success: true } };
          },
          async changeFileStage(sessionId: string, options: any) {
            (window as any).__e2e_lastChangeFileStage = { sessionId, options };
            setTimeout(() => {
              emitEvent('git:status-updated', { sessionId, gitStatus: createMockGitStatus() });
            }, 50);
            return { success: true, data: { success: true } };
          },
          async sendMessage(sessionId: string, message: string) {
            // Emit message sent event
            emitEvent('message:sent', { sessionId, message });

            // Simulate assistant response
            setTimeout(() => {
              emitEvent('message:received', {
                sessionId,
                message: 'Mock assistant response',
                type: 'assistant',
              });
            }, 500);

            return {
              success: true,
              data: { messageId: `msg-${Date.now()}` },
            };
          },
        },
        panels: {
          async list(sessionId: string) {
            return {
              success: true,
              data: [
                {
                  id: 'panel-1',
                  sessionId,
                  type: 'claude',
                  createdAt: new Date().toISOString(),
                },
              ],
            };
          },
          async create(sessionId: string, type: string) {
            return {
              success: true,
              data: {
                id: `panel-${Date.now()}`,
                sessionId,
                type,
                createdAt: new Date().toISOString(),
              },
            };
          },
        },
        git: {
          async getStatus(repoPath: string) {
            return {
              success: true,
              data: createMockGitStatus(),
            };
          },
          async stage(repoPath: string, filePath: string) {
            return { success: true, data: null };
          },
          async unstage(repoPath: string, filePath: string) {
            return { success: true, data: null };
          },
          async commit(repoPath: string, message: string) {
            return {
              success: true,
              data: {
                sha: 'abc123',
                message,
              }
            };
          },
          async push(repoPath: string) {
            return { success: true, data: null };
          },
          async pull(repoPath: string) {
            return { success: true, data: null };
          },
        },
        on: (channel: string, callback: Function) => {
          if (!mockState.eventListeners.has(channel)) {
            mockState.eventListeners.set(channel, []);
          }
          mockState.eventListeners.get(channel)!.push(callback);
        },
        send: (channel: string, data: any) => {
          // Mock send - could emit events back if needed
          console.log('[Mock IPC] send:', channel, data);
        },
        removeListener: (channel: string, callback: Function) => {
          const listeners = mockState.eventListeners.get(channel) || [];
          const index = listeners.indexOf(callback);
          if (index > -1) {
            listeners.splice(index, 1);
          }
        },
        // Events API used by useIPCEvents hook
        events: {
          onSessionsLoaded: (callback: Function) => {
            console.log('[Mock Events] Registering onSessionsLoaded listener');
            const listeners = mockState.eventListeners.get('sessions:loaded') || [];
            listeners.push(callback);
            mockState.eventListeners.set('sessions:loaded', listeners);

            // Replay pending events for this channel
            const pending = mockState.pendingEvents.filter(e => e.channel === 'sessions:loaded');
            pending.forEach(event => {
              console.log('[Mock Events] Replaying pending sessions:loaded event');
              queueMicrotask(() => callback(event.data));
            });
            // Remove replayed events
            mockState.pendingEvents = mockState.pendingEvents.filter(e => e.channel !== 'sessions:loaded');

            return () => {
              const current = mockState.eventListeners.get('sessions:loaded') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onSessionCreated: (callback: Function) => {
            const listenerId = `listener-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const stack = new Error().stack?.split('\n').slice(2, 4).join('\n') || 'unknown';
            console.log(`[Mock Events] Registering onSessionCreated listener ${listenerId}`);
            console.log(`[Mock Events] Registered from:\n${stack}`);

            const listeners = mockState.eventListeners.get('session:created') || [];
            const wrappedCallback = (data: any) => {
              console.log(`[Mock Events] Calling onSessionCreated listener ${listenerId}`);
              try {
                callback(data);
                console.log(`[Mock Events] Listener ${listenerId} completed successfully`);
              } catch (e) {
                console.error(`[Mock Events] Listener ${listenerId} threw error:`, e);
                throw e;
              }
            };
            listeners.push(wrappedCallback);
            mockState.eventListeners.set('session:created', listeners);

            // Replay pending events for this channel
            const pending = mockState.pendingEvents.filter(e => e.channel === 'session:created');
            if (pending.length > 0) {
              console.log(`[Mock Events] Replaying ${pending.length} pending session:created event(s) for listener ${listenerId}`);
              pending.forEach(event => {
                queueMicrotask(() => wrappedCallback(event.data));
              });
              // Remove replayed events
              mockState.pendingEvents = mockState.pendingEvents.filter(e => e.channel !== 'session:created');
            }

            return () => {
              const current = mockState.eventListeners.get('session:created') || [];
              const index = current.indexOf(wrappedCallback);
              if (index > -1) {
                current.splice(index, 1);
                console.log(`[Mock Events] Unregistered listener ${listenerId}`);
              }
            };
          },
          onSessionUpdated: (callback: Function) => {
            console.log('[Mock Events] Registering onSessionUpdated listener');
            const listeners = mockState.eventListeners.get('session:updated') || [];
            listeners.push(callback);
            mockState.eventListeners.set('session:updated', listeners);
            return () => {
              const current = mockState.eventListeners.get('session:updated') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onSessionDeleted: (callback: Function) => {
            console.log('[Mock Events] Registering onSessionDeleted listener');
            const listeners = mockState.eventListeners.get('session:deleted') || [];
            listeners.push(callback);
            mockState.eventListeners.set('session:deleted', listeners);
            return () => {
              const current = mockState.eventListeners.get('session:deleted') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onGitStatusUpdated: (callback: Function) => {
            console.log('[Mock Events] Registering onGitStatusUpdated listener');
            const listeners = mockState.eventListeners.get('git:status-updated') || [];
            listeners.push(callback);
            mockState.eventListeners.set('git:status-updated', listeners);
            return () => {
              const current = mockState.eventListeners.get('git:status-updated') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onGitStatusLoading: (callback: Function) => {
            console.log('[Mock Events] Registering onGitStatusLoading listener');
            const listeners = mockState.eventListeners.get('git:status-loading') || [];
            listeners.push(callback);
            mockState.eventListeners.set('git:status-loading', listeners);
            return () => {
              const current = mockState.eventListeners.get('git:status-loading') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          // Updater events (used by WorkspaceHeader)
          onUpdateAvailable: (callback: Function) => {
            console.log('[Mock Events] Registering onUpdateAvailable listener');
            const listeners = mockState.eventListeners.get('update:available') || [];
            listeners.push(callback);
            mockState.eventListeners.set('update:available', listeners);
            return () => {
              const current = mockState.eventListeners.get('update:available') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onUpdateDownloaded: (callback: Function) => {
            console.log('[Mock Events] Registering onUpdateDownloaded listener');
            const listeners = mockState.eventListeners.get('update:downloaded') || [];
            listeners.push(callback);
            mockState.eventListeners.set('update:downloaded', listeners);
            return () => {
              const current = mockState.eventListeners.get('update:downloaded') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          // Timeline events (used by TimelineView)
          onTimelineEvent: (callback: Function) => {
            console.log('[Mock Events] Registering onTimelineEvent listener');
            const listeners = mockState.eventListeners.get('timeline:event') || [];
            listeners.push(callback);
            mockState.eventListeners.set('timeline:event', listeners);
            return () => {
              const current = mockState.eventListeners.get('timeline:event') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
          onAssistantStream: (callback: Function) => {
            console.log('[Mock Events] Registering onAssistantStream listener');
            const listeners = mockState.eventListeners.get('assistant:stream') || [];
            listeners.push(callback);
            mockState.eventListeners.set('assistant:stream', listeners);
            return () => {
              const current = mockState.eventListeners.get('assistant:stream') || [];
              const index = current.indexOf(callback);
              if (index > -1) current.splice(index, 1);
            };
          },
        },
        // Mock updater API (WorkspaceHeader uses this)
        updater: {
          async download() {
            console.log('[Mock Updater] download() called');
            return { success: true };
          },
          async install() {
            console.log('[Mock Updater] install() called');
            return { success: true };
          },
        },
        // Mock settings API (used by settingsStore)
        settings: {
          async load() {
            console.log('[Mock Settings] load() called');
            return { success: true, data: null };
          },
          async save(settings: any) {
            console.log('[Mock Settings] save() called', settings);
            return { success: true };
          },
        },
        // Mock telegram API (used by App.tsx)
        telegram: {
          async getStatus() {
            return { success: true, data: { status: 'disconnected' } };
          },
          async start(settings: any) {
            console.log('[Mock Telegram] start() called');
            return { success: true };
          },
          async stop() {
            console.log('[Mock Telegram] stop() called');
            return { success: true };
          },
          async restart(settings: any) {
            console.log('[Mock Telegram] restart() called');
            return { success: true };
          },
        },
        invoke: async (channel: string, ...args: any[]) => {
          // Handle invoke calls
          console.log('[Mock IPC] invoke:', channel, args);
          return { success: true, data: null };
        },
      };

      // Expose helper to manually update session store (for tests)
      (window as any).__test_updateSessionStore = (sessions: any[], activeId: string | null) => {
        // This will be called from tests to manually trigger store updates
        console.log('[Mock Test Helper] Updating session store:', sessions.length, 'sessions, active:', activeId);

        // Try to find and call Zustand store's setState
        // The store might be exposed by the app or we can dispatch a custom event
        const event = new CustomEvent('test:update-sessions', {
          detail: { sessions, activeSessionId: activeId }
        });
        window.dispatchEvent(event);
      };

      // Log that mock is ready
      console.log('[Mock electronAPI] Initialized with state management');
    });

    await use(page);
  },
});

export { expect } from '@playwright/test';
