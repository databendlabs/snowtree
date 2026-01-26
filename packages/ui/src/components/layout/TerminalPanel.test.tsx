import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

const terminalInstances = vi.hoisted(() => [] as any[]);

vi.mock('xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    writes: string[] = [];
    focus = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    scrollToBottom = vi.fn();
    dispose = vi.fn();
    onDataHandler?: (data: string) => void;

    constructor() {
      terminalInstances.push(this);
    }

    onData = (handler: (data: string) => void) => {
      this.onDataHandler = handler;
      return { dispose: vi.fn() };
    };

    write = (data: string) => {
      this.writes.push(data);
    };

    writeln = (data: string) => {
      this.writes.push(data);
    };
  }

  return { Terminal: MockTerminal };
});

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
  },
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      preCreateTerminal: vi.fn(),
      getTerminalOutputs: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
    },
  },
}));

import { TerminalPanel } from './TerminalPanel';
import { API } from '../../utils/api';

describe('TerminalPanel', () => {
  let originalRaf: typeof window.requestAnimationFrame;
  let originalCaf: typeof window.cancelAnimationFrame;
  let originalElectronApi: any;

  beforeEach(() => {
    terminalInstances.length = 0;
    vi.clearAllMocks();

    (API.sessions.preCreateTerminal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    (API.sessions.getTerminalOutputs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: [] });

    originalRaf = window.requestAnimationFrame;
    originalCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

    originalElectronApi = (window as any).electronAPI;
    (window as any).electronAPI = { ...originalElectronApi };
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
    (window as any).electronAPI = originalElectronApi;
  });

  it('focuses terminal when focusRequestId is set', async () => {
    render(<TerminalPanel sessionId="s1" panelId="p1" height={200} focusRequestId={1} />);

    await waitFor(() => expect(terminalInstances.length).toBe(1));
    await waitFor(() => expect(terminalInstances[0].open).toHaveBeenCalled());
    await waitFor(() => expect(terminalInstances[0].focus).toHaveBeenCalled());
  });

  it('sends terminal input to the API', async () => {
    render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0];
    await waitFor(() => expect(typeof terminal.onDataHandler).toBe('function'));

    terminal.onDataHandler('ls');
    expect(API.sessions.sendTerminalInput).toHaveBeenCalledWith('s1', 'ls');
  });

  it('writes output events for the active session panel', async () => {
    const outputHandlers: Array<(event: any) => void> = [];
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      events: {
        onTerminalOutput: (handler: (event: any) => void) => {
          outputHandlers.push(handler);
          return () => undefined;
        },
      },
    };

    render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

    await waitFor(() => expect(terminalInstances.length).toBe(1));
    await waitFor(() => expect(outputHandlers.length).toBe(1));

    outputHandlers[0]({
      sessionId: 's1',
      panelId: 'p1',
      type: 'stdout',
      data: 'hello',
    });

    await waitFor(() => expect(terminalInstances[0].writes).toContain('hello'));
  });

  describe('OSC Response Filtering', () => {
    it('filters OSC 11 color query responses with BEL terminator', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with OSC 11 response (background color query)
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: '➜  test \x1b]11;rgb:2828/2c2c/3434\x07\n',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        // OSC response should be filtered out
        expect(lastWrite).toBe('➜  test \n');
        expect(lastWrite).not.toContain('\x1b]11');
      });
    });

    it('filters OSC 11 color query responses with ST terminator', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with OSC response using ST terminator (ESC \)
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: 'test\x1b]11;rgb:c8c8/cccc/d4d4\x1b\\output',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite).toBe('testoutput');
        expect(lastWrite).not.toContain('\x1b]11');
      });
    });

    it('filters multiple OSC responses in single output', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with multiple OSC responses
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: '\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0000/0000/0000\x07normal text',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite).toBe('normal text');
        expect(lastWrite).not.toContain('\x1b]10');
        expect(lastWrite).not.toContain('\x1b]11');
      });
    });

    it('preserves normal ANSI color codes (CSI sequences)', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with normal ANSI color codes
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: '\x1b[36mCyan text\x1b[0m',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        // ANSI color codes should be preserved
        expect(lastWrite).toBe('\x1b[36mCyan text\x1b[0m');
      });
    });

    it('filters OSC responses while preserving ANSI codes', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with both OSC responses and ANSI codes
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: '\x1b[1mBold\x1b]11;rgb:1111/2222/3333\x07\x1b[0m',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        // OSC should be filtered, ANSI preserved
        expect(lastWrite).toBe('\x1b[1mBold\x1b[0m');
        expect(lastWrite).not.toContain('\x1b]11');
      });
    });

    it('filters OSC responses from historical terminal output', async () => {
      (API.sessions.getTerminalOutputs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: [
          { id: 1, type: 'stdout', data: 'line 1\n' },
          { id: 2, type: 'stdout', data: '\x1b]11;rgb:2828/2c2c/3434\x07' },
          { id: 3, type: 'stdout', data: 'line 2\n' },
        ],
      });

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const combinedWrites = writes.join('');
        expect(combinedWrites).toContain('line 1');
        expect(combinedWrites).toContain('line 2');
        expect(combinedWrites).not.toContain('\x1b]11');
      });
    });

    it('filters OSC 10 (foreground color) responses', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with OSC 10 response (foreground color query)
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: 'text\x1b]10;rgb:ffff/ffff/ffff\x07more text',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite).toBe('textmore text');
        expect(lastWrite).not.toContain('\x1b]10');
      });
    });

    it('filters OSC 12 (cursor color) responses', async () => {
      const outputHandlers: Array<(event: any) => void> = [];
      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        events: {
          onTerminalOutput: (handler: (event: any) => void) => {
            outputHandlers.push(handler);
            return () => undefined;
          },
        },
      };

      render(<TerminalPanel sessionId="s1" panelId="p1" height={200} />);

      await waitFor(() => expect(terminalInstances.length).toBe(1));
      await waitFor(() => expect(outputHandlers.length).toBe(1));

      // Send output with OSC 12 response (cursor color query)
      outputHandlers[0]({
        sessionId: 's1',
        panelId: 'p1',
        type: 'stdout',
        data: 'cursor\x1b]12;rgb:61af/efef/0000\x07test',
      });

      await waitFor(() => {
        const writes = terminalInstances[0].writes;
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite).toBe('cursortest');
        expect(lastWrite).not.toContain('\x1b]12');
      });
    });
  });
});
