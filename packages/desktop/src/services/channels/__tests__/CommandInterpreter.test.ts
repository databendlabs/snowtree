import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelContext, SnowTreeCommandDefinition } from '../types';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => { throw new Error('not found'); }),
}));

const mockSessionManager = {
  db: {
    getProject: vi.fn(),
  },
  getSession: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

const mockCommands: SnowTreeCommandDefinition[] = [
  { name: 'list_projects', description: 'List projects' },
  { name: 'open_project', description: 'Open project', args: '{ name: string }' },
  { name: 'list_sessions', description: 'List sessions' },
  { name: 'select_session', description: 'Select session', args: '{ id: string }' },
  { name: 'new_session', description: 'New session', args: '{ prompt: string }' },
  { name: 'status', description: 'Show status' },
  { name: 'send_message', description: 'Send message', args: '{ message: string }' },
  { name: 'switch_executor', description: 'Switch executor', args: '{ executor: string }' },
  { name: 'stop_session', description: 'Stop session' },
  { name: 'delete_session', description: 'Delete session', args: '{ id: string }' },
  { name: 'help', description: 'Show help' },
  { name: 'unknown', description: 'Unknown command' },
];

const { CommandInterpreter } = await import('../CommandInterpreter');

describe('CommandInterpreter', () => {
  let interpreter: InstanceType<typeof CommandInterpreter>;
  let context: ChannelContext;

  beforeEach(() => {
    vi.clearAllMocks();
    interpreter = new CommandInterpreter(
      mockSessionManager as any,
      mockLogger as any,
      mockCommands
    );
    context = {
      activeProjectId: null,
      activeSessionId: null,
    };
  });

  describe('fallback interpretation', () => {
    it('should recognize list projects', async () => {
      const result = await interpreter.interpret('list projects', context);
      expect(result.name).toBe('list_projects');
    });

    it('should recognize open project', async () => {
      const result = await interpreter.interpret('open databend', context);
      expect(result.name).toBe('open_project');
      expect(result.args?.name).toBe('databend');
    });

    it('should recognize list sessions', async () => {
      const result = await interpreter.interpret('show sessions', context);
      expect(result.name).toBe('list_sessions');
    });

    it('should recognize select session', async () => {
      const result = await interpreter.interpret('select abc123', context);
      expect(result.name).toBe('select_session');
      expect(result.args?.id).toBe('abc123');
    });

    it('should recognize new session', async () => {
      const result = await interpreter.interpret('new session fix bug', context);
      expect(result.name).toBe('new_session');
      expect(result.args?.prompt).toBe('fix bug');
    });

    it('should recognize status', async () => {
      const result = await interpreter.interpret('status', context);
      expect(result.name).toBe('status');
    });

    it('should recognize use codex', async () => {
      const result = await interpreter.interpret('use codex', context);
      expect(result.name).toBe('switch_executor');
      expect(result.args?.executor).toBe('codex');
    });

    it('should recognize stop session', async () => {
      const result = await interpreter.interpret('stop session', context);
      expect(result.name).toBe('stop_session');
    });

    it('should recognize delete session', async () => {
      const result = await interpreter.interpret('delete abc123', context);
      expect(result.name).toBe('delete_session');
      expect(result.args?.id).toBe('abc123');
    });

    it('should recognize help', async () => {
      const result = await interpreter.interpret('help', context);
      expect(result.name).toBe('help');
    });

    it('should default to send_message with active session', async () => {
      context.activeSessionId = 'session-123';
      const result = await interpreter.interpret('fix this bug', context);
      expect(result.name).toBe('send_message');
      expect(result.args?.message).toBe('fix this bug');
    });

    it('should convert unknown to send_message with active session', async () => {
      context.activeSessionId = 'session-123';
      const result = await interpreter.interpret('random text', context);
      expect(result.name).toBe('send_message');
    });

    it('should strip leading slash', async () => {
      const result = await interpreter.interpret('/status', context);
      expect(result.name).toBe('status');
    });
  });

  describe('isAvailable', () => {
    it('should return false when claude CLI not detected', () => {
      expect(interpreter.isAvailable()).toBe(false);
    });
  });
});
