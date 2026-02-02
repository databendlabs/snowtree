import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SnowTreeCommandRequest, ChannelContext } from '../types';

// Mock PanelManager
vi.mock('../../../features/panels/PanelManager', () => ({
  panelManager: {
    getPanelsForSession: vi.fn(() => []),
    createPanel: vi.fn(),
  },
}));

// Mock panelManagerRegistry
vi.mock('../../../features/panels/ai/panelManagerRegistry', () => ({
  getPanelManagerForType: vi.fn(() => null),
}));

const mockSessionManager = {
  db: {
    getAllProjects: vi.fn(),
    getProject: vi.fn(),
    setActiveProject: vi.fn(),
    getUserPreference: vi.fn(),
    getActivePanel: vi.fn(),
  },
  getSession: vi.fn(),
  getSessionsForProject: vi.fn(),
  setActiveProject: vi.fn(),
  updateSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  archiveSession: vi.fn(),
  getActiveProject: vi.fn(),
};

const mockTaskQueue = {
  createSession: vi.fn(),
};

const mockWorktreeManager = {};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

const { SnowTreeAPI } = await import('../SnowTreeAPI');

describe('SnowTreeAPI', () => {
  let api: InstanceType<typeof SnowTreeAPI>;
  let context: ChannelContext;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new SnowTreeAPI({
      sessionManager: mockSessionManager as any,
      taskQueue: mockTaskQueue as any,
      worktreeManager: mockWorktreeManager as any,
      logger: mockLogger as any,
    });
    context = {
      activeProjectId: null,
      activeSessionId: null,
    };
  });

  describe('list_projects', () => {
    it('should return no projects message when empty', async () => {
      mockSessionManager.db.getAllProjects.mockReturnValue([]);
      const command: SnowTreeCommandRequest = { name: 'list_projects', rawText: 'list projects' };
      const result = await api.execute(command, context);
      expect(result.message).toBe('No projects found.');
    });

    it('should list projects', async () => {
      mockSessionManager.db.getAllProjects.mockReturnValue([
        { id: 1, name: 'project-a', path: '/path/a' },
        { id: 2, name: 'project-b', path: '/path/b' },
      ]);
      const command: SnowTreeCommandRequest = { name: 'list_projects', rawText: 'list projects' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('project-a');
      expect(result.message).toContain('project-b');
    });
  });

  describe('open_project', () => {
    it('should require project name', async () => {
      const command: SnowTreeCommandRequest = { name: 'open_project', args: {}, rawText: 'open' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('specify a project name');
    });

    it('should open project and update context', async () => {
      mockSessionManager.db.getAllProjects.mockReturnValue([
        { id: 1, name: 'databend', path: '/path/databend' },
      ]);
      const command: SnowTreeCommandRequest = { name: 'open_project', args: { name: 'databend' }, rawText: 'open databend' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Opened');
      expect(context.activeProjectId).toBe(1);
      expect(context.activeSessionId).toBeNull();
    });
  });

  describe('list_sessions', () => {
    it('should require active project', async () => {
      const command: SnowTreeCommandRequest = { name: 'list_sessions', rawText: 'list sessions' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('No project selected');
    });

    it('should list sessions', async () => {
      context.activeProjectId = 1;
      mockSessionManager.getSessionsForProject.mockReturnValue([
        { id: 'session-123456', name: 'Fix bug', status: 'running' },
      ]);
      const command: SnowTreeCommandRequest = { name: 'list_sessions', rawText: 'list sessions' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Fix bug');
    });
  });

  describe('select_session', () => {
    it('should select session and update context', async () => {
      context.activeProjectId = 1;
      mockSessionManager.getSessionsForProject.mockReturnValue([
        { id: 'session-123456', name: 'Fix bug', status: 'running' },
      ]);
      const command: SnowTreeCommandRequest = { name: 'select_session', args: { id: 'session' }, rawText: 'select session' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Selected');
      expect(context.activeSessionId).toBe('session-123456');
    });
  });

  describe('status', () => {
    it('should show status with no project', async () => {
      const command: SnowTreeCommandRequest = { name: 'status', rawText: 'status' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Status');
      expect(result.message).toContain('none');
    });

    it('should show status with active session', async () => {
      context.activeProjectId = 1;
      context.activeSessionId = 'session-123';
      mockSessionManager.db.getProject.mockReturnValue({ id: 1, name: 'databend' });
      mockSessionManager.getSession.mockReturnValue({ id: 'session-123', name: 'Fix bug', status: 'running', toolType: 'claude' });
      const command: SnowTreeCommandRequest = { name: 'status', rawText: 'status' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('databend');
      expect(result.message).toContain('Fix bug');
      expect(result.message).toContain('claude');
    });
  });

  describe('switch_executor', () => {
    it('should require valid executor', async () => {
      const command: SnowTreeCommandRequest = { name: 'switch_executor', args: { executor: 'invalid' }, rawText: 'switch to invalid' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('specify an executor');
    });

    it('should require active session', async () => {
      const command: SnowTreeCommandRequest = { name: 'switch_executor', args: { executor: 'claude' }, rawText: 'switch to claude' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('No session selected');
    });

    it('should switch executor', async () => {
      context.activeSessionId = 'session-123';
      mockSessionManager.getSession.mockReturnValue({ id: 'session-123', name: 'Fix bug' });
      const command: SnowTreeCommandRequest = { name: 'switch_executor', args: { executor: 'codex' }, rawText: 'switch to codex' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Switched');
      expect(result.message).toContain('codex');
    });
  });

  describe('stop_session', () => {
    it('should require active session', async () => {
      const command: SnowTreeCommandRequest = { name: 'stop_session', rawText: 'stop session' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('No session selected');
    });

    it('should stop session', async () => {
      context.activeSessionId = 'session-123';
      mockSessionManager.getSession.mockReturnValue({ id: 'session-123', name: 'Fix bug' });
      const command: SnowTreeCommandRequest = { name: 'stop_session', rawText: 'stop session' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Stopped');
    });
  });

  describe('delete_session', () => {
    it('should delete session and clear context', async () => {
      context.activeProjectId = 1;
      context.activeSessionId = 'session-123456';
      mockSessionManager.getSessionsForProject.mockReturnValue([
        { id: 'session-123456', name: 'Fix bug', status: 'idle' },
      ]);
      const command: SnowTreeCommandRequest = { name: 'delete_session', args: { id: 'session' }, rawText: 'delete session' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('Deleted');
      expect(context.activeSessionId).toBeNull();
    });
  });

  describe('help', () => {
    it('should return help message', async () => {
      const command: SnowTreeCommandRequest = { name: 'help', rawText: 'help' };
      const result = await api.execute(command, context);
      expect(result.message).toContain('list projects');
      expect(result.message).toContain('switch');
    });
  });
});
