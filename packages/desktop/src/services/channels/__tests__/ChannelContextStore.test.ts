import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelContextStore } from '../ChannelContextStore';

describe('ChannelContextStore', () => {
  let store: ChannelContextStore;

  beforeEach(() => {
    store = new ChannelContextStore();
  });

  describe('get', () => {
    it('should return default context for new chat', () => {
      const context = store.get('telegram', 123456);
      expect(context).toEqual({
        activeProjectId: null,
        activeSessionId: null,
      });
    });

    it('should return same context for same channel and chat', () => {
      const context1 = store.get('telegram', 123456);
      const context2 = store.get('telegram', 123456);
      expect(context1).toBe(context2);
    });

    it('should return different contexts for different channels', () => {
      const context1 = store.get('telegram', 123456);
      const context2 = store.get('slack', 123456);
      expect(context1).not.toBe(context2);
    });

    it('should return different contexts for different chats', () => {
      const context1 = store.get('telegram', 111);
      const context2 = store.get('telegram', 222);
      expect(context1).not.toBe(context2);
    });
  });

  describe('update', () => {
    it('should update activeProjectId', () => {
      const updated = store.update('telegram', 123456, { activeProjectId: 1 });
      expect(updated.activeProjectId).toBe(1);
      expect(updated.activeSessionId).toBeNull();
    });

    it('should update activeSessionId', () => {
      const updated = store.update('telegram', 123456, { activeSessionId: 'session-123' });
      expect(updated.activeProjectId).toBeNull();
      expect(updated.activeSessionId).toBe('session-123');
    });

    it('should persist updates', () => {
      store.update('telegram', 123456, { activeProjectId: 3 });
      const context = store.get('telegram', 123456);
      expect(context.activeProjectId).toBe(3);
    });
  });

  describe('getKeysForSession', () => {
    it('should return empty array when no chats have the session', () => {
      const keys = store.getKeysForSession('session-123');
      expect(keys).toEqual([]);
    });

    it('should return keys with matching session', () => {
      store.update('telegram', 111, { activeSessionId: 'session-123' });
      store.update('slack', 222, { activeSessionId: 'session-123' });
      store.update('telegram', 333, { activeSessionId: 'session-456' });

      const keys = store.getKeysForSession('session-123');
      expect(keys).toHaveLength(2);
      expect(keys).toContain('telegram:111');
      expect(keys).toContain('slack:222');
    });
  });

  describe('parseKey', () => {
    it('should parse valid key', () => {
      const result = store.parseKey('telegram:123456');
      expect(result).toEqual({ channelType: 'telegram', chatId: '123456' });
    });

    it('should return null for invalid key', () => {
      const result = store.parseKey('invalid');
      expect(result).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove context for chat', () => {
      store.update('telegram', 123456, { activeProjectId: 1, activeSessionId: 'session-1' });
      store.clear('telegram', 123456);
      const context = store.get('telegram', 123456);
      expect(context.activeProjectId).toBeNull();
      expect(context.activeSessionId).toBeNull();
    });
  });
});
