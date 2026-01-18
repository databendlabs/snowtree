import { describe, it, expect } from 'vitest';
import { clampTerminalHeight, TERMINAL_LAYOUT_LIMITS } from './terminalUtils';

describe('clampTerminalHeight', () => {
  it('clamps to min height when cursor is too low', () => {
    const height = clampTerminalHeight({
      containerHeight: 800,
      containerBottom: 800,
      cursorY: 790,
    });

    expect(height).toBe(TERMINAL_LAYOUT_LIMITS.minHeight);
  });

  it('clamps to conversation-safe max height', () => {
    const height = clampTerminalHeight({
      containerHeight: 500,
      containerBottom: 500,
      cursorY: 100,
    });

    const expected = Math.max(
      TERMINAL_LAYOUT_LIMITS.minHeight,
      Math.min(TERMINAL_LAYOUT_LIMITS.maxHeight, 500 - TERMINAL_LAYOUT_LIMITS.minConversationHeight)
    );

    expect(height).toBe(expected);
  });

  it('returns raw height when within limits', () => {
    const height = clampTerminalHeight({
      containerHeight: 900,
      containerBottom: 900,
      cursorY: 700,
    });

    expect(height).toBe(200);
  });
});
