import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { API } from '../../utils/api';
import { useThemeStore } from '../../stores/themeStore';

type TerminalOutputEvent = {
  sessionId: string;
  panelId?: string;
  id?: number;
  type: string;
  data: string;
  timestamp?: string;
};

type TerminalOutputRow = {
  id?: number;
  type: 'stdout' | 'stderr' | 'system' | 'json' | 'error';
  data: string;
  timestamp?: string;
};

const OUTPUT_LIMIT = 4000;
const HEADER_HEIGHT = 34;
const DEFAULT_FONT_SIZE = 13;

const getCssValue = (name: string, fallback: string) => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const buildTerminalTheme = () => ({
  background: getCssValue('--st-editor', '#282c34'),
  foreground: getCssValue('--st-text', '#c8ccd4'),
  cursor: getCssValue('--st-accent', '#61afef'),
  selection: getCssValue('--st-selected', 'rgba(97, 175, 239, 0.2)'),
  black: getCssValue('--st-border', '#1b1e23'),
  red: getCssValue('--st-danger', '#e06c75'),
  green: getCssValue('--st-success', '#98c379'),
  yellow: getCssValue('--st-warning', '#e5c07b'),
  blue: getCssValue('--st-accent', '#61afef'),
  magenta: getCssValue('--st-assistant', '#c678dd'),
  cyan: getCssValue('--st-accent', '#56b6c2'),
  white: getCssValue('--st-text', '#c8ccd4'),
  brightBlack: getCssValue('--st-text-faint', '#5c6370'),
  brightRed: getCssValue('--st-danger', '#e06c75'),
  brightGreen: getCssValue('--st-success', '#98c379'),
  brightYellow: getCssValue('--st-warning', '#e5c07b'),
  brightBlue: getCssValue('--st-accent', '#61afef'),
  brightMagenta: getCssValue('--st-assistant', '#c678dd'),
  brightCyan: getCssValue('--st-accent', '#56b6c2'),
  brightWhite: getCssValue('--st-text', '#ffffff'),
});

const getFontSize = () => {
  const raw = getCssValue('--st-font-base', String(DEFAULT_FONT_SIZE));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_FONT_SIZE;
};

const getFontFamily = () =>
  getCssValue('--st-font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace');

export interface TerminalPanelProps {
  sessionId: string;
  panelId: string;
  worktreePath?: string;
  height: number;
  focusRequestId?: number;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  sessionId,
  panelId,
  worktreePath,
  height,
  focusRequestId = 0,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingOutputsRef = useRef<TerminalOutputEvent[]>([]);
  const hydratedRef = useRef(false);
  const lastOutputIdRef = useRef(0);
  const openedRef = useRef(false);
  const pendingFocusIdRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const theme = useThemeStore(state => state.theme);

  const worktreeLabel = useMemo(() => {
    if (!worktreePath) return 'workspace';
    return worktreePath.split('/').filter(Boolean).pop() || worktreePath;
  }, [worktreePath]);

  const safeFit = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!fitAddon || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    try {
      fitAddon.fit();
    } catch (error) {
      console.warn('Failed to fit terminal', error);
    }
  }, []);

  const focusTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    try {
      terminal.focus();
    } catch (error) {
      console.warn('Failed to focus terminal', error);
    }
  }, []);

  const applyTheme = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = buildTerminalTheme();
    terminal.options.fontFamily = getFontFamily();
    terminal.options.fontSize = getFontSize();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: OUTPUT_LIMIT,
      fontFamily: getFontFamily(),
      fontSize: getFontSize(),
      theme: buildTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    let cancelled = false;
    const openFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) return;
      try {
        terminal.open(container);
        safeFit();
        openedRef.current = true;
        if (pendingFocusIdRef.current !== null) {
          focusTerminal();
        }
      } catch (error) {
        console.error('Failed to open terminal', error);
      }
    });

    const disposable = terminal.onData((data) => {
      if (!window.electronAPI) return;
      void API.sessions.sendTerminalInput(sessionId, data);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(openFrame);
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      openedRef.current = false;
    };
  }, [sessionId, focusTerminal, safeFit]);

  useEffect(() => {
    applyTheme();
    safeFit();
  }, [theme, applyTheme, safeFit]);

  useEffect(() => {
    if (!focusRequestId) return;
    pendingFocusIdRef.current = focusRequestId;
    if (!openedRef.current) return;
    const frame = requestAnimationFrame(() => {
      focusTerminal();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequestId, focusTerminal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const unsubscribe = window.electronAPI?.events?.onTerminalOutput?.((event: TerminalOutputEvent) => {
      if (event.sessionId !== sessionId) return;
      if (event.panelId && event.panelId !== panelId) return;

      if (!hydratedRef.current) {
        pendingOutputsRef.current.push(event);
        return;
      }

      if (event.id && event.id <= lastOutputIdRef.current) return;
      terminal.write(event.data);
      if (event.id) lastOutputIdRef.current = event.id;
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [sessionId, panelId]);

  useEffect(() => {
    let cancelled = false;
    const terminal = terminalRef.current;
    if (!terminal) return;

    hydratedRef.current = false;
    pendingOutputsRef.current = [];
    setIsLoading(true);

    const hydrate = async () => {
      if (!window.electronAPI) {
        setIsLoading(false);
        hydratedRef.current = true;
        return;
      }
      const precreate = await API.sessions.preCreateTerminal(sessionId);
      if (!precreate?.success) {
        terminal.writeln(`\r\nFailed to start terminal: ${precreate?.error || 'unknown error'}\r\n`);
      }

      const outputsResponse = await API.sessions.getTerminalOutputs(panelId, OUTPUT_LIMIT);
      if (cancelled || !terminalRef.current) return;

      const outputs = (outputsResponse?.data || []) as TerminalOutputRow[];
      if (outputsResponse?.success && outputs.length > 0) {
        terminal.write(outputs.map(output => output.data).join(''));
        terminal.scrollToBottom();
        const last = outputs[outputs.length - 1];
        lastOutputIdRef.current = last?.id ? Number(last.id) : 0;
      } else if (!outputsResponse?.success) {
        terminal.writeln(`\r\nFailed to load terminal history: ${outputsResponse?.error || 'unknown error'}\r\n`);
      }

      hydratedRef.current = true;
      setIsLoading(false);

      if (pendingOutputsRef.current.length > 0) {
        const pending = pendingOutputsRef.current;
        pendingOutputsRef.current = [];
        pending.forEach(output => {
          if (output.id && output.id <= lastOutputIdRef.current) return;
          terminal.write(output.data);
          if (output.id) lastOutputIdRef.current = output.id;
        });
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [sessionId, panelId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!terminal || !fitAddon || !container) return;

    const handleResize = () => {
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = requestAnimationFrame(() => {
        safeFit();
        void API.sessions.resizeTerminal(sessionId, terminal.cols, terminal.rows);
      });
    };

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    handleResize();

    return () => {
      observer.disconnect();
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [sessionId, safeFit]);

  return (
    <div
      className="flex flex-col st-surface border-t"
      style={{ height }}
      data-terminal-panel
    >
      <div
        className="flex items-center justify-between px-3"
        style={{
          height: HEADER_HEIGHT,
          borderBottom: '1px solid color-mix(in srgb, var(--st-border) 70%, transparent)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="w-3.5 h-3.5" style={{ color: 'var(--st-text-faint)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--st-text)' }}>Terminal</span>
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'color-mix(in srgb, var(--st-hover) 45%, transparent)', color: 'var(--st-text-faint)' }}
            title={worktreePath}
          >
            {worktreeLabel}
          </span>
          {isLoading && (
            <span className="text-[10px]" style={{ color: 'var(--st-text-faint)' }}>
              Connecting...
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div ref={containerRef} className="h-full" />
      </div>
    </div>
  );
};

TerminalPanel.displayName = 'TerminalPanel';

export default TerminalPanel;
