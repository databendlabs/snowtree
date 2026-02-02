import type { ChannelContext } from './types';

/**
 * ChannelContextStore - Manages context for channel users
 *
 * Each channel user (identified by channelType + chatId) has their own context
 * tracking which project/session they're working with.
 */
export class ChannelContextStore {
  private contexts = new Map<string, ChannelContext>();
  private sessionToChats = new Map<string, Set<string>>();

  private makeKey(channelType: string, chatId: string | number): string {
    return `${channelType}:${chatId}`;
  }

  get(channelType: string, chatId: string | number): ChannelContext {
    const key = this.makeKey(channelType, chatId);
    const existing = this.contexts.get(key);
    if (existing) {
      return existing;
    }
    const initial: ChannelContext = { activeProjectId: null, activeSessionId: null };
    this.contexts.set(key, initial);
    return initial;
  }

  update(channelType: string, chatId: string | number, patch: Partial<ChannelContext>): ChannelContext {
    const key = this.makeKey(channelType, chatId);
    const current = this.get(channelType, chatId);
    const prevSessionId = current.activeSessionId;
    const next = { ...current, ...patch };
    this.contexts.set(key, next);

    // Track session -> chat mappings for broadcasting
    if (patch.activeSessionId !== undefined && patch.activeSessionId !== prevSessionId) {
      if (prevSessionId) {
        const existing = this.sessionToChats.get(prevSessionId);
        if (existing) {
          existing.delete(key);
          if (existing.size === 0) this.sessionToChats.delete(prevSessionId);
        }
      }

      if (next.activeSessionId) {
        const set = this.sessionToChats.get(next.activeSessionId) ?? new Set<string>();
        set.add(key);
        this.sessionToChats.set(next.activeSessionId, set);
      }
    }
    return next;
  }

  clear(channelType: string, chatId: string | number): void {
    const key = this.makeKey(channelType, chatId);
    const current = this.contexts.get(key);
    if (current?.activeSessionId) {
      const existing = this.sessionToChats.get(current.activeSessionId);
      if (existing) {
        existing.delete(key);
        if (existing.size === 0) this.sessionToChats.delete(current.activeSessionId);
      }
    }
    this.contexts.delete(key);
  }

  /**
   * Get all channel keys (channelType:chatId) that have a specific session active
   */
  getKeysForSession(sessionId: string): string[] {
    const set = this.sessionToChats.get(sessionId);
    if (!set) return [];
    return Array.from(set);
  }

  /**
   * Parse a key back into channelType and chatId
   */
  parseKey(key: string): { channelType: string; chatId: string } | null {
    const idx = key.indexOf(':');
    if (idx === -1) return null;
    return {
      channelType: key.slice(0, idx),
      chatId: key.slice(idx + 1)
    };
  }
}
