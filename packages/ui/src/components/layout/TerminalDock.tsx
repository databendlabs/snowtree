import React from 'react';
import type { RefObject } from 'react';
import { TerminalPanel } from './TerminalPanel';
import { useTerminalDock } from './useTerminalDock';

export interface TerminalDockProps {
  sessionId: string;
  panelId: string;
  worktreePath?: string;
  containerRef: RefObject<HTMLElement>;
}

export const TerminalDock: React.FC<TerminalDockProps> = ({
  sessionId,
  panelId,
  worktreePath,
  containerRef,
}) => {
  const {
    terminalHeight,
    terminalCollapsed,
    isResizing,
    focusRequestId,
    handleResizeStart,
  } = useTerminalDock(sessionId, containerRef);

  if (terminalCollapsed) return null;

  return (
    <>
      <div
        className="group h-2 flex-shrink-0 cursor-row-resize relative"
        onMouseDown={handleResizeStart}
        data-testid="terminal-resize-handle"
      >
        <div
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px transition-colors"
          style={{
            backgroundColor: isResizing
              ? 'color-mix(in srgb, var(--st-accent) 75%, transparent)'
              : 'color-mix(in srgb, var(--st-border) 65%, transparent)',
          }}
        />
        <div
          className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, transparent, color-mix(in srgb, var(--st-accent) 14%, transparent), transparent)',
          }}
        />
      </div>
      <TerminalPanel
        sessionId={sessionId}
        panelId={panelId}
        worktreePath={worktreePath}
        height={terminalHeight}
        focusRequestId={focusRequestId}
      />
    </>
  );
};

TerminalDock.displayName = 'TerminalDock';

export default TerminalDock;
