import React, { useEffect, useMemo, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { useThemeStore } from '../../../stores/themeStore';
import type { TerminalClosedEvent, TerminalExitEvent, TerminalOutputEvent } from '../../../types/terminal';
import 'xterm/css/xterm.css';

type TerminalPanelProps = {
  terminalId: string;
  isActive: boolean;
};

const resolveCssVar = (name: string, fallback: string) => {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const resolveFontSize = () => {
  const raw = resolveCssVar('--st-font-sm', '12px');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 12;
};

const resolveFontFamily = () =>
  resolveCssVar('--st-font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace');

const resolveTerminalTheme = () => ({
  background: resolveCssVar('--st-editor', '#1f2228'),
  foreground: resolveCssVar('--st-text', '#c8ccd4'),
  cursor: resolveCssVar('--st-accent', '#61afef'),
  selection: resolveCssVar('--st-selected', 'rgba(97, 175, 239, 0.22)'),
});

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ terminalId, isActive }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const { theme } = useThemeStore();

  const containerStyle = useMemo(() => ({
    backgroundColor: 'var(--st-editor)',
    borderTop: '1px solid color-mix(in srgb, var(--st-border) 70%, transparent)',
  }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.electronAPI?.terminals) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: resolveFontFamily(),
      fontSize: resolveFontSize(),
      lineHeight: 1.2,
      scrollback: 5000,
      theme: resolveTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();

    const textarea = terminal.textarea;
    if (textarea) {
      textarea.setAttribute('inputmode', 'text');
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('spellcheck', 'false');
    }

    void window.electronAPI.terminals.resize(terminalId, terminal.cols, terminal.rows);

    const onData = terminal.onData((data) => {
      void window.electronAPI.terminals.input(terminalId, data);
    });

    const handleOutput = (event: TerminalOutputEvent) => {
      if (event.terminalId !== terminalId) return;
      terminal.write(event.data);
    };

    const handleExit = (event: TerminalExitEvent) => {
      if (event.terminalId !== terminalId) return;
      terminal.write(`\r\n[process exited with code ${event.exitCode}]\r\n`);
    };

    const handleClosed = (event: TerminalClosedEvent) => {
      if (event.terminalId !== terminalId) return;
      terminal.write('\r\n[terminal closed]\r\n');
    };

    const unsubscribeOutput = window.electronAPI.events.onTerminalOutput(handleOutput);
    const unsubscribeExit = window.electronAPI.events.onTerminalExited(handleExit);
    const unsubscribeClosed = window.electronAPI.events.onTerminalClosed(handleClosed);

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        fitAddon.fit();
        void window.electronAPI.terminals.resize(terminalId, terminal.cols, terminal.rows);
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      onData.dispose();
      unsubscribeOutput?.();
      unsubscribeExit?.();
      unsubscribeClosed?.();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = resolveTerminalTheme();
  }, [theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || !isActive) return;
    fitAddon.fit();
    terminal.focus();
    void window.electronAPI?.terminals?.resize(terminalId, terminal.cols, terminal.rows);
  }, [isActive, terminalId]);

  return <div ref={containerRef} className="h-full w-full" style={containerStyle} />;
};

export default TerminalPanel;
