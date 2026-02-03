import { describe, it, expect, beforeEach } from 'vitest';
import type { ChannelContext } from '../types';
import { CommandInterpreter } from '../CommandInterpreter';

describe('CommandInterpreter', () => {
  let interpreter: CommandInterpreter;
  let context: ChannelContext;

  beforeEach(() => {
    interpreter = new CommandInterpreter();
    context = {
      activeProjectId: null,
      activeSessionId: null,
    };
  });

  describe('interpret', () => {
    it('should recognize chat id', async () => {
      const result = await interpreter.interpret('chatid', context);
      expect(result.name).toBe('get_chat_id');
    });

    it('should recognize list projects', async () => {
      const result = await interpreter.interpret('list projects', context);
      expect(result.name).toBe('list_projects');
    });

    it('should recognize show all projects', async () => {
      const result = await interpreter.interpret('show all projects', context);
      expect(result.name).toBe('list_projects');
    });

    it('should recognize open project', async () => {
      const result = await interpreter.interpret('open databend', context);
      expect(result.name).toBe('open_project');
      expect(result.args?.name).toBe('databend');
    });

    it('should recognize switch to project', async () => {
      const result = await interpreter.interpret('switch to myproject', context);
      expect(result.name).toBe('open_project');
      expect(result.args?.name).toBe('myproject');
    });

    it('should recognize list sessions', async () => {
      const result = await interpreter.interpret('list sessions', context);
      expect(result.name).toBe('list_sessions');
    });

    it('should recognize show sessions', async () => {
      const result = await interpreter.interpret('show sessions', context);
      expect(result.name).toBe('list_sessions');
    });

    it('should recognize select session', async () => {
      const result = await interpreter.interpret('select abc123', context);
      expect(result.name).toBe('select_session');
      expect(result.args?.id).toBe('abc123');
    });

    it('should recognize new session', async () => {
      const result = await interpreter.interpret('new fix the bug', context);
      expect(result.name).toBe('new_session');
      expect(result.args?.prompt).toBe('fix the bug');
    });

    it('should recognize create session', async () => {
      const result = await interpreter.interpret('create add new feature', context);
      expect(result.name).toBe('new_session');
      expect(result.args?.prompt).toBe('add new feature');
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

    it('should recognize use claude', async () => {
      const result = await interpreter.interpret('use claude', context);
      expect(result.name).toBe('switch_executor');
      expect(result.args?.executor).toBe('claude');
    });

    it('should recognize stop', async () => {
      const result = await interpreter.interpret('stop', context);
      expect(result.name).toBe('stop_session');
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

    it('should recognize ?', async () => {
      const result = await interpreter.interpret('?', context);
      expect(result.name).toBe('help');
    });

    it('should default to send_message for unknown input', async () => {
      const result = await interpreter.interpret('fix this bug please', context);
      expect(result.name).toBe('send_message');
      expect(result.args?.message).toBe('fix this bug please');
    });

    it('should strip leading slash', async () => {
      const result = await interpreter.interpret('/status', context);
      expect(result.name).toBe('status');
    });
  });
});
