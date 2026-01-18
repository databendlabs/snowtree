import { useCallback, useEffect, useState } from 'react';
import type { RefObject, MouseEvent as ReactMouseEvent } from 'react';
import { clampTerminalHeight, TERMINAL_LAYOUT_KEYS, TERMINAL_LAYOUT_LIMITS } from './terminalUtils';

const getSessionKey = (base: string, sessionId: string) => `${base}:${sessionId}`;

const readStoredNumber = (base: string, sessionId: string, fallback: number, min: number, max: number) => {
  const stored = localStorage.getItem(getSessionKey(base, sessionId)) ?? localStorage.getItem(base);
  if (stored) {
    const value = parseInt(stored, 10);
    if (Number.isFinite(value) && value >= min && value <= max) {
      return value;
    }
  }
  return fallback;
};

const readStoredBoolean = (base: string, sessionId: string, fallback: boolean) => {
  const stored = localStorage.getItem(getSessionKey(base, sessionId));
  if (stored !== null) return stored === 'true';
  const legacy = localStorage.getItem(base);
  if (legacy !== null) return legacy === 'true';
  return fallback;
};

export const useTerminalDock = (sessionId: string, containerRef: RefObject<HTMLElement>) => {
  const [terminalHeight, setTerminalHeight] = useState(() => {
    return readStoredNumber(
      TERMINAL_LAYOUT_KEYS.height,
      sessionId,
      TERMINAL_LAYOUT_LIMITS.defaultHeight,
      TERMINAL_LAYOUT_LIMITS.minHeight,
      TERMINAL_LAYOUT_LIMITS.maxHeight
    );
  });

  const [terminalCollapsed, setTerminalCollapsed] = useState(() => {
    return readStoredBoolean(TERMINAL_LAYOUT_KEYS.collapsed, sessionId, true);
  });

  const [isResizing, setIsResizing] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);

  useEffect(() => {
    localStorage.setItem(getSessionKey(TERMINAL_LAYOUT_KEYS.height, sessionId), terminalHeight.toString());
  }, [terminalHeight, sessionId]);

  useEffect(() => {
    localStorage.setItem(getSessionKey(TERMINAL_LAYOUT_KEYS.collapsed, sessionId), terminalCollapsed ? 'true' : 'false');
  }, [terminalCollapsed, sessionId]);

  useEffect(() => {
    setTerminalHeight(
      readStoredNumber(
        TERMINAL_LAYOUT_KEYS.height,
        sessionId,
        TERMINAL_LAYOUT_LIMITS.defaultHeight,
        TERMINAL_LAYOUT_LIMITS.minHeight,
        TERMINAL_LAYOUT_LIMITS.maxHeight
      )
    );
    setTerminalCollapsed(readStoredBoolean(TERMINAL_LAYOUT_KEYS.collapsed, sessionId, true));
    setFocusRequestId(0);
  }, [sessionId]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const constrainedHeight = clampTerminalHeight({
        containerHeight: rect.height,
        containerBottom: rect.bottom,
        cursorY: e.clientY,
      });
      setTerminalHeight(constrainedHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, containerRef]);

  const handleResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    if (terminalCollapsed) {
      setTerminalCollapsed(false);
    }
    setIsResizing(true);
  }, [terminalCollapsed]);

  const toggleTerminal = useCallback(() => {
    setTerminalCollapsed((prev) => {
      if (prev) {
        setFocusRequestId((id) => id + 1);
        return false;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-terminal-panel]')) {
        active.blur();
      }
      return true;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey || e.altKey) return;
      if (!e.ctrlKey && !e.metaKey) return;
      const target = e.target as HTMLElement | null;

      const isToggleKey =
        e.code === 'Equal'
        || e.code === 'NumpadAdd'
        || e.code === 'Minus'
        || e.code === 'NumpadSubtract'
        || e.key === '+'
        || e.key === '_'
        || e.key === '=';
      if (!isToggleKey) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleTerminal();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [toggleTerminal]);

  return {
    terminalHeight,
    terminalCollapsed,
    isResizing,
    focusRequestId,
    handleResizeStart,
  };
};
