import type { TelegramContext } from './types';

export class TelegramContextStore {
  private contexts = new Map<string, TelegramContext>();
  private sessionToChats = new Map<string, Set<string>>();

  get(chatId: string | number): TelegramContext {
    const key = String(chatId);
    const existing = this.contexts.get(key);
    if (existing) {
      return existing;
    }
    const initial: TelegramContext = { activeProjectId: null, activeSessionId: null };
    this.contexts.set(key, initial);
    return initial;
  }

  update(chatId: string | number, patch: Partial<TelegramContext>): TelegramContext {
    const key = String(chatId);
    const current = this.get(chatId);
    const prevSessionId = current.activeSessionId;
    const next = { ...current, ...patch };
    this.contexts.set(key, next);

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

  clear(chatId: string | number): void {
    const key = String(chatId);
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

  getChatIdsForSession(sessionId: string): string[] {
    const set = this.sessionToChats.get(sessionId);
    if (!set) return [];
    return Array.from(set);
  }
}
