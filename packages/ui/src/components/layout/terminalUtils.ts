export const TERMINAL_LAYOUT_KEYS = {
  height: 'snowtree-terminal-height',
  collapsed: 'snowtree-terminal-collapsed',
} as const;

export const TERMINAL_LAYOUT_LIMITS = {
  defaultHeight: 240,
  minHeight: 160,
  maxHeight: 520,
  minConversationHeight: 220,
} as const;

type TerminalClampParams = {
  containerHeight: number;
  containerBottom: number;
  cursorY: number;
  minHeight?: number;
  maxHeight?: number;
  minConversationHeight?: number;
};

export const clampTerminalHeight = ({
  containerHeight,
  containerBottom,
  cursorY,
  minHeight = TERMINAL_LAYOUT_LIMITS.minHeight,
  maxHeight = TERMINAL_LAYOUT_LIMITS.maxHeight,
  minConversationHeight = TERMINAL_LAYOUT_LIMITS.minConversationHeight,
}: TerminalClampParams): number => {
  const rawHeight = containerBottom - cursorY;
  const maxByConversation = containerHeight - minConversationHeight;
  const effectiveMax = Math.min(maxHeight, maxByConversation);
  const safeMax = Math.max(minHeight, effectiveMax);
  return Math.max(minHeight, Math.min(safeMax, rawHeight));
};

export const isTerminalEventTarget = (target: EventTarget | null): target is HTMLElement => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('[data-terminal-panel]'));
};
