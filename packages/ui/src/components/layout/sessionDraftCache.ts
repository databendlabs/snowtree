import type { ImageAttachment } from './types';

export type SessionDraft = {
  html: string;
  images: ImageAttachment[];
  updatedAt: number;
};

const MAX_DRAFTS = 50;
const draftsBySessionId = new Map<string, SessionDraft>();

function pruneIfNeeded(): void {
  if (draftsBySessionId.size <= MAX_DRAFTS) return;
  const entries = Array.from(draftsBySessionId.entries());
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toRemove = entries.slice(0, Math.max(0, entries.length - MAX_DRAFTS));
  for (const [sessionId] of toRemove) draftsBySessionId.delete(sessionId);
}

export function getSessionDraft(sessionId: string): SessionDraft | null {
  return draftsBySessionId.get(sessionId) ?? null;
}

export function setSessionDraft(sessionId: string, draft: Omit<SessionDraft, 'updatedAt'>): void {
  const html = String(draft.html ?? '');
  const images = Array.isArray(draft.images) ? draft.images : [];
  if (html.trim().length === 0 && images.length === 0) {
    draftsBySessionId.delete(sessionId);
    return;
  }
  draftsBySessionId.set(sessionId, { html, images, updatedAt: Date.now() });
  pruneIfNeeded();
}

export function clearSessionDraft(sessionId: string): void {
  draftsBySessionId.delete(sessionId);
}

