import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { createMockDatabase, cleanupDatabase } from '../../../__tests__/helpers/mockDatabase';
import { createTestSession } from '../../../__tests__/helpers/testFixtures';
import type { DatabaseService } from '../../../infrastructure/database/database';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockDb: DatabaseService;
  let testProject: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    // Create a test project and set it as active
    testProject = mockDb.createProject('Test Project', '/tmp/test-project');
    mockDb.setActiveProject(testProject.id);
    sessionManager = new SessionManager(mockDb);
  });

  afterEach(() => {
    cleanupDatabase(mockDb);
  });

  describe('createSession', () => {
    it('should create a session with generated ID', async () => {
      const result = await sessionManager.createSession({
        name: 'Test Session',
        worktreePath: '/tmp/test',
        prompt: 'Test prompt',
        toolType: 'claude',
      });

      expect(result.id).toBeDefined();
      expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(result.name).toBe('Test Session');
      expect(result.status).toBe('ready');
    });

    it('should create session with provided ID', async () => {
      const customId = 'custom-session-id';

      const result = await sessionManager.createSessionWithProvidedId(customId, {
        name: 'Custom Session',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      expect(result.id).toBe(customId);
    });

    it('should handle concurrent session creation safely', async () => {
      const promises = Array(5).fill(null).map((_, i) =>
        sessionManager.createSession({
          name: `Session ${i}`,
          worktreePath: '/tmp/test',
          prompt: 'Test',
          toolType: 'claude',
        })
      );

      const sessions = await Promise.all(promises);
      const ids = sessions.map(s => s.id);

      expect(new Set(ids).size).toBe(5);
    });

    it('should set initial status to ready', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      expect(session.status).toBe('ready');
      expect(session.isRunning).toBe(false);
    });

    it('should initialize empty output array', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      expect(session.output).toEqual([]);
      expect(session.jsonMessages).toEqual([]);
    });
  });

  describe('getSession', () => {
    it('should retrieve created session', async () => {
      const created = await sessionManager.createSession({
        name: 'Test Session',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const retrieved = sessionManager.getSession(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.name).toBe('Test Session');
    });

    it('should return undefined for non-existent session', () => {
      const result = sessionManager.getSession('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('should return cached session on repeated calls', async () => {
      const created = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const first = sessionManager.getSession(created.id);
      const second = sessionManager.getSession(created.id);

      expect(first).toBe(second);
    });
  });

  describe('updateSession', () => {
    it('should update session status', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, {
        status: 'running',
      });

      const updated = sessionManager.getSession(session.id);
      expect(updated.status).toBe('running');
    });

    it('should update status', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, {
        status: 'running',
      });

      const updated = sessionManager.getSession(session.id);
      expect(updated.status).toBe('running');
    });

    it('should set updatedAt timestamp', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const beforeUpdate = new Date();
      await sessionManager.updateSession(session.id, { status: 'running' });
      const afterUpdate = new Date();

      const updated = sessionManager.getSession(session.id);
      expect(updated.updatedAt).toBeDefined();
      expect(new Date(updated.updatedAt!)).toBeInstanceOf(Date);
    });

    it('should update isRunning flag when status changes', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, { status: 'running' });
      expect(sessionManager.getSession(session.id).isRunning).toBe(true);

      await sessionManager.updateSession(session.id, { status: 'completed' });
      expect(sessionManager.getSession(session.id).isRunning).toBe(false);
    });

    it('should persist toolType and executionMode changes', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, { toolType: 'codex', executionMode: 'plan' });

      const reloadedManager = new SessionManager(mockDb);
      const updated = reloadedManager.getSession(session.id);

      expect(updated.toolType).toBe('codex');
      expect(updated.executionMode).toBe('plan');

      await reloadedManager.updateSession(session.id, { status: 'running' });
      const afterStatusUpdate = reloadedManager.getSession(session.id);

      expect(afterStatusUpdate.toolType).toBe('codex');
      expect(afterStatusUpdate.executionMode).toBe('plan');
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      const sessions = sessionManager.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should return all created sessions', async () => {
      await sessionManager.createSession({
        name: 'Session 1',
        worktreePath: '/tmp/test1',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.createSession({
        name: 'Session 2',
        worktreePath: '/tmp/test2',
        prompt: 'Test',
        toolType: 'claude',
      });

      const sessions = sessionManager.getAllSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should not include archived sessions by default', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, { archived: true });

      const sessions = sessionManager.getAllSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe('deleteSession', () => {
    it('should archive session', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.archiveSession(session.id);

      const archived = sessionManager.getSession(session.id);
      expect(archived.archived).toBe(true);
    });

    it('should handle archiving non-existent session gracefully', async () => {
      await expect(sessionManager.archiveSession('non-existent')).rejects.toThrow();
    });
  });

  describe('addSessionOutput', () => {
    it('should add output to session', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.addSessionOutput(session.id, {
        type: 'stdout',
        data: 'Hello, world!',
        timestamp: new Date().toISOString(),
      });

      const updated = sessionManager.getSession(session.id);
      expect(updated.output).toHaveLength(1);
      expect(updated.output[0].data).toBe('Hello, world!');
    });

    it('should parse JSON messages from output', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const jsonMessage = JSON.stringify({
        type: 'system.init',
        data: 'initialized',
      });

      await sessionManager.addSessionOutput(session.id, {
        type: 'stdout',
        data: jsonMessage,
        timestamp: new Date().toISOString(),
      });

      const updated = sessionManager.getSession(session.id);
      expect(updated.jsonMessages).toHaveLength(1);
      expect(updated.jsonMessages[0]).toEqual({
        type: 'system.init',
        data: 'initialized',
      });
    });

    it('should not persist session ID from init message (handled by AbstractAIPanelManager)', async () => {
      // Session ID persistence is now handled by AbstractAIPanelManager.confirmAndPersistSessionId()
      // which waits for the first assistant message before persisting.
      // This prevents overwriting valid session IDs when a resumed session fails.
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const initMessage = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-123',
      });

      await sessionManager.addSessionOutput(session.id, {
        type: 'stdout',
        data: initMessage,
        timestamp: new Date().toISOString(),
      });

      // Session ID should NOT be persisted by addSessionOutput anymore
      const updated = sessionManager.getSession(session.id);
      expect(updated.claudeSessionId).toBeUndefined();
    });

    it('should handle non-JSON output gracefully', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.addSessionOutput(session.id, {
        type: 'stdout',
        data: 'Regular text output',
        timestamp: new Date().toISOString(),
      });

      const updated = sessionManager.getSession(session.id);
      expect(updated.output).toHaveLength(1);
      expect(updated.jsonMessages).toHaveLength(0);
    });
  });

  describe('archiveSession', () => {
    it('should mark session as archived', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.archiveSession(session.id);

      const updated = sessionManager.getSession(session.id);
      expect(updated.archived).toBe(true);
    });

    it('should stop running process before archiving', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, {
        pid: 12345,
        status: 'running',
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await sessionManager.archiveSession(session.id);

      expect(killSpy).toHaveBeenCalled();
      killSpy.mockRestore();
    });
  });

  describe('status mapping', () => {
    it('should map pending to ready status', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      mockDb.updateSession(session.id, { status: 'pending' });
      sessionManager.initializeFromDatabase();

      const retrieved = sessionManager.getSession(session.id);
      expect(retrieved.status).toBe('ready');
    });

    it('should preserve completed_unviewed status', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      await sessionManager.updateSession(session.id, {
        status: 'completed_unviewed',
      });

      const retrieved = sessionManager.getSession(session.id);
      expect(retrieved.status).toBe('completed_unviewed');
    });
  });

  describe('getOrCreateMainRepoSession', () => {
    it('should create main repo session if not exists', async () => {
      const session = await sessionManager.getOrCreateMainRepoSession(testProject.id);

      expect(session.isMainRepo).toBe(true);
      expect(session.name).toContain('Test Project');
    });

    it('should return existing main repo session', async () => {
      const first = await sessionManager.getOrCreateMainRepoSession(testProject.id);

      const second = await sessionManager.getOrCreateMainRepoSession(testProject.id);

      expect(first.id).toBe(second.id);
    });

    it('should use mutex lock for concurrent calls', async () => {
      const promises = Array(5).fill(null).map(() =>
        sessionManager.getOrCreateMainRepoSession(testProject.id)
      );

      const sessions = await Promise.all(promises);
      const ids = sessions.map(s => s.id);

      expect(new Set(ids).size).toBe(1);
    });
  });

  describe('persistPanelAgentSessionId', () => {
    it('should persist agent session ID to panel state', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const panelId = 'test-panel-id';
      // Create a panel (createPanel returns void)
      mockDb.createPanel({
        id: panelId,
        sessionId: session.id,
        type: 'claude',
        title: 'Test Panel',
        state: { isActive: true, hasBeenViewed: false, customState: {} },
        metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
      });

      // Persist agent session ID
      sessionManager.persistPanelAgentSessionId(panelId, 'agent-session-123');

      // Verify it's persisted
      const retrievedId = sessionManager.getPanelAgentSessionId(panelId);
      expect(retrievedId).toBe('agent-session-123');
    });

    it('should preserve existing session ID when not overwritten', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const panelId = 'test-panel-id-2';
      // Create panel with existing session ID
      mockDb.createPanel({
        id: panelId,
        sessionId: session.id,
        type: 'claude',
        title: 'Test Panel',
        state: {
          isActive: true,
          hasBeenViewed: false,
          customState: { agentSessionId: 'old-session-id' }
        },
        metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
      });

      // Verify old ID is readable
      const oldId = sessionManager.getPanelAgentSessionId(panelId);
      expect(oldId).toBe('old-session-id');

      // Persist new ID
      sessionManager.persistPanelAgentSessionId(panelId, 'new-session-id');

      // Verify new ID is persisted
      const newId = sessionManager.getPanelAgentSessionId(panelId);
      expect(newId).toBe('new-session-id');
    });

    it('should also set legacy claudeSessionId for backward compatibility', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const panelId = 'test-panel-id-3';
      mockDb.createPanel({
        id: panelId,
        sessionId: session.id,
        type: 'claude',
        title: 'Test Panel',
        state: { isActive: true, hasBeenViewed: false, customState: {} },
        metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
      });

      sessionManager.persistPanelAgentSessionId(panelId, 'agent-session-456');

      // Check legacy field via getPanelClaudeSessionId
      const claudeId = sessionManager.getPanelClaudeSessionId(panelId);
      expect(claudeId).toBe('agent-session-456');
    });
  });

  describe('getPanelAgentSessionId', () => {
    it('should return undefined for non-existent panel', () => {
      const id = sessionManager.getPanelAgentSessionId('non-existent-panel');
      expect(id).toBeUndefined();
    });

    it('should fallback to claudeSessionId if agentSessionId is not set', async () => {
      const session = await sessionManager.createSession({
        name: 'Test',
        worktreePath: '/tmp/test',
        prompt: 'Test',
        toolType: 'claude',
      });

      const panelId = 'legacy-panel';
      // Create panel with only legacy claudeSessionId
      mockDb.createPanel({
        id: panelId,
        sessionId: session.id,
        type: 'claude',
        title: 'Legacy Panel',
        state: {
          isActive: true,
          hasBeenViewed: false,
          customState: { claudeSessionId: 'legacy-id' }
        },
        metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
      });

      const id = sessionManager.getPanelAgentSessionId(panelId);
      expect(id).toBe('legacy-id');
    });
  });
});
