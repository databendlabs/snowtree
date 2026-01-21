import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputBar } from './InputBar';
import type { Session } from '../../types/session';

async function blurViaFocusSink(editor: HTMLElement): Promise<void> {
  // `fireEvent.blur` doesn't reliably update `document.activeElement` in jsdom for contenteditable.
  // Move focus to a real focus target to trigger React's onBlur and update focus state.
  const sink = document.createElement('button');
  sink.type = 'button';
  document.body.appendChild(sink);
  sink.focus();
  await waitFor(() => expect(editor).not.toHaveFocus());
  sink.remove();
}

const getEditorParagraph = (editor: HTMLElement): HTMLParagraphElement => {
  const paragraph = editor.querySelector('p');
  if (!paragraph) {
    throw new Error('Expected editor to contain a paragraph');
  }
  return paragraph;
};

const getEditorTextNodes = (editor: HTMLElement): Text[] => {
  const paragraph = getEditorParagraph(editor);
  return Array.from(paragraph.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE) as Text[];
};

type NodeOffset = { node: Text; offset: number };

const getNodeOffsetAt = (editor: HTMLElement, offset: number): NodeOffset => {
  const textNodes = getEditorTextNodes(editor);
  if (textNodes.length === 0) {
    throw new Error('Expected editor to contain text nodes');
  }

  let remaining = offset;
  for (const node of textNodes) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      return { node, offset: remaining };
    }
    remaining -= length;
  }

  const lastNode = textNodes[textNodes.length - 1];
  return { node: lastNode, offset: lastNode.textContent?.length ?? 0 };
};

const setSelectionRange = (start: NodeOffset, end?: NodeOffset) => {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error('Expected selection to be available');
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  const rangeEnd = end ?? start;
  range.setEnd(rangeEnd.node, rangeEnd.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
};

const getEditor = async (): Promise<HTMLDivElement> => {
  return (await screen.findByTestId('input-editor')) as HTMLDivElement;
};

const setCaretInEditor = (editor: HTMLElement, offset: number) => {
  setSelectionRange(getNodeOffsetAt(editor, offset));
};

const selectRangeInEditor = (editor: HTMLElement, start: number, end: number) => {
  setSelectionRange(getNodeOffsetAt(editor, start), getNodeOffsetAt(editor, end));
};

// Mock API
vi.mock('../../utils/api', () => ({
  API: {
    aiTools: {
      getStatus: vi.fn().mockResolvedValue({ success: true, data: {} }),
      getSettings: vi.fn().mockResolvedValue({ success: true, data: {} }),
    },
    sessions: {
      getTimeline: vi.fn().mockResolvedValue({ success: true, data: [] }),
    },
  },
}));

let originalFileReader: typeof FileReader | undefined;

beforeEach(() => {
  originalFileReader = global.FileReader;

  // Make `innerText` behave consistently in jsdom for contenteditable handling.
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    if (!desc || desc.configurable) {
      Object.defineProperty(HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
          return this.textContent || '';
        },
        set(value: string) {
          this.textContent = value;
        },
      });
    }
  } catch {
    // best-effort
  }

  if (!document.elementFromPoint) {
    document.elementFromPoint = () => document.body;
  }

  if (typeof Range !== 'undefined') {
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () => ({
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => ([{
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }] as DOMRectList);
    }
  }

  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;

    readAsDataURL(file: Blob) {
      const type = (file as File).type || 'image/png';
      this.result = `data:${type};base64,TEST_DATA`;
      if (this.onload) {
        const event = typeof ProgressEvent === 'undefined' ? new Event('load') : new ProgressEvent('load');
        this.onload(event as ProgressEvent<FileReader>);
      }
    }
  }

  global.FileReader = MockFileReader as unknown as typeof FileReader;

  // Mock window.electronAPI
  (global as any).window.electronAPI = {
    events: {
      onTimelineEvent: vi.fn(() => vi.fn()),
    },
  };

  // Mock requestAnimationFrame
  global.requestAnimationFrame = vi.fn((cb) => {
    cb(0);
    return 0;
  }) as any;

  // Mock cancelAnimationFrame
  global.cancelAnimationFrame = vi.fn();
});

const mockSession: Session = {
  id: 'test-session',
  name: 'test-session',
  status: 'waiting',
  createdAt: new Date().toISOString(),
  worktreePath: '/test/path',
  toolType: 'claude',
};

describe('InputBar - Cursor Position Tests', () => {
  let mockOnSend: ReturnType<typeof vi.fn>;
  let mockOnCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSend = vi.fn();
    mockOnCancel = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalFileReader) {
      global.FileReader = originalFileReader;
    }
  });

  it('should place cursor after image pill when image is pasted', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');

    setCaretInEditor(editor, 2);

    await blurViaFocusSink(editor);

    const file = new File(['test'], 'test.png', { type: 'image/png' });
    const clipboardData = {
      items: [
        {
          type: 'image/png',
          getAsFile: () => file,
        },
      ],
      types: ['image/png'],
      getData: () => '',
    };

    fireEvent.paste(document.body, { clipboardData });
    await waitFor(() => expect(editor).toHaveFocus());

    await waitFor(() => {
      const imageTag = editor.querySelector('[data-image-id]');
      expect(imageTag).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(editor.textContent).toContain('[img1]');

      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      if (sel) {
        expect(sel.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
        const anchorText = sel.anchorNode?.textContent || '';
        expect(anchorText.startsWith(' ')).toBe(true);
        expect(sel.anchorOffset).toBe(1);
      }
    });
  });

  it('should move caret to end after copy', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'copy me');

    selectRangeInEditor(editor, 0, 4);
    fireEvent.copy(editor);

    await waitFor(() => {
      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        const textNodes = getEditorTextNodes(editor);
        const lastText = textNodes[textNodes.length - 1];
        expect(r.collapsed).toBe(true);
        expect(sel.anchorNode).toBe(lastText);
        expect(sel.anchorOffset).toBe((lastText.textContent || '').length);
      }
    });
  });

  it('should paste at the current caret, not a stale saved position', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');

    // Save a stale position at the end (simulates prior blur/save)
    setCaretInEditor(editor, 5);
    await blurViaFocusSink(editor);

    // User clicks to place caret after 'h' (offset 1), then pastes.
    await user.click(editor);
    setCaretInEditor(editor, 1);

    const clipboardData = {
      items: [],
      types: ['text/plain'],
      getData: () => 'X',
    };
    fireEvent.paste(editor, { clipboardData });

    await waitFor(() => expect(editor.textContent).toBe('hXello'));

    await waitFor(() => {
      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        expect(r.collapsed).toBe(true);
        expect(sel.anchorOffset).toBe(2);
      }
    });
  });

  it('should insert text at saved cursor position after blur', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'helloworld');

    // Move cursor to position 5 (after "hello")
    setCaretInEditor(editor, 5);

    // Blur the editor to save cursor position
    await blurViaFocusSink(editor);

    // Simulate global keypress (typing when editor is not focused)
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'X',
      bubbles: true,
    });
    document.dispatchEvent(keyEvent);

    await waitFor(() => {
      expect(editor.textContent).toBe('helloXworld');
    });
  });

  it('should paste text at saved cursor position after blur', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'helloworld');

    // Move cursor to position 5 (after "hello")
    setCaretInEditor(editor, 5);

    // Blur the editor to save cursor position
    await blurViaFocusSink(editor);

    const clipboardData = {
      items: [],
      types: ['text/plain'],
      getData: () => 'PASTED',
    };
    fireEvent.paste(document.body, { clipboardData });

    await waitFor(() => expect(editor).toHaveFocus());

    await waitFor(() => {
      expect(editor.textContent).toBe('helloPASTEDworld');
    });
  });

  it('should paste text on Ctrl+V when not focused', async () => {
    const user = userEvent.setup();
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { text: 'PASTED', image: null },
    });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      invoke,
    };

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');
    setCaretInEditor(editor, 5);
    await blurViaFocusSink(editor);

    const pasteEvent = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true });
    document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard:read'));
    await waitFor(() => expect(editor.textContent).toBe('helloPASTED'));
  });

  it('should paste text on Cmd+V when not focused', async () => {
    const user = userEvent.setup();
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { text: 'PASTED', image: null },
    });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      invoke,
    };

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');
    setCaretInEditor(editor, 5);
    await blurViaFocusSink(editor);

    const pasteEvent = new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true });
    document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard:read'));
    await waitFor(() => expect(editor.textContent).toBe('helloPASTED'));
  });

  it('should paste image on Ctrl+V when not focused', async () => {
    const user = userEvent.setup();
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { text: '', image: 'data:image/png;base64,TEST_DATA' },
    });
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      invoke,
    };

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');
    setCaretInEditor(editor, 5);
    await blurViaFocusSink(editor);

    const pasteEvent = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true });
    document.dispatchEvent(pasteEvent);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard:read'));
    await waitFor(() => {
      const imageTag = editor.querySelector('[data-image-id]');
      expect(imageTag).toBeInTheDocument();
    });
  });

  it('should select all input content on Ctrl+A when not focused', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'select me');

    await blurViaFocusSink(editor);

    const selectAll = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true });
    document.dispatchEvent(selectAll);

    await waitFor(() => expect(editor).toHaveFocus());

    const sel = window.getSelection();
    expect(sel).not.toBeNull();
    if (sel) {
      expect(sel.rangeCount).toBeGreaterThan(0);
      const r = sel.getRangeAt(0);
      expect(r.collapsed).toBe(false);
      expect(editor.contains(sel.anchorNode)).toBe(true);
      expect(editor.contains(sel.focusNode)).toBe(true);
    }
  });

  it('should maintain cursor position through multiple operations', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    await user.click(editor);
    await user.type(editor, 'abc');

    setCaretInEditor(editor, 1);
    await blurViaFocusSink(editor);

    const keyEvent1 = new KeyboardEvent('keydown', { key: 'X', bubbles: true });
    document.dispatchEvent(keyEvent1);

    await waitFor(() => {
      expect(editor.textContent).toBe('aXbc');
    });

    await user.click(editor);
    setCaretInEditor(editor, editor.textContent.length);
    await blurViaFocusSink(editor);

    const keyEvent2 = new KeyboardEvent('keydown', { key: 'Y', bubbles: true });
    document.dispatchEvent(keyEvent2);

    await waitFor(() => {
      expect(editor.textContent).toBe('aXbcY');
    });
  });

  it('supports ArrowUp/ArrowDown history navigation with two-step behavior', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();

    // Send two messages to populate history.
    await user.click(editor);
    await user.type(editor, 'first msg');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe(''));

    await user.type(editor, 'second msg');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe(''));

    // Draft text.
    await user.type(editor, 'draft');
    await user.click(editor);

    // Place caret at end of draft.
    setCaretInEditor(editor, editor.textContent.length);

    // First ArrowUp: move caret to start, do not change text.
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(editor.textContent).toBe('draft');
    {
      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        expect(r.collapsed).toBe(true);
        expect(sel.anchorOffset).toBe(0);
      }
    }

    // Second ArrowUp (already at start): load most recent history.
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(editor.textContent).toBe('second msg');

    // ArrowUp again: older history.
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(editor.textContent).toBe('first msg');

    // ArrowDown: back toward newer.
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(editor.textContent).toBe('second msg');

    // ArrowDown at newest: restore draft and exit history.
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(editor.textContent).toBe('draft');

    // If caret is already at start (e.g. user clicked to start), first ArrowUp should still be a no-op,
    // and only the second ArrowUp should enter history.
    await user.click(editor);
    setCaretInEditor(editor, 0);

    // Reset priming by pressing a non-arrow key.
    fireEvent.keyDown(editor, { key: 'Shift' });

    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(editor.textContent).toBe('draft');
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(editor.textContent).toBe('second msg');
  });

  it('renders a block caret when focused', async () => {
    const user = userEvent.setup();

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = await getEditor();
    await user.click(editor);

    await waitFor(() => {
      const caret = editor.querySelector('.st-block-caret');
      expect(caret).toBeInTheDocument();
    });
  });

  it('sets block caret width from measured character width', async () => {
    const user = userEvent.setup();
    const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        width: 20,
        height: 0,
        right: 20,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    try {
      const editor = await getEditor();
      await user.click(editor);
      await user.type(editor, 'WW');
      setCaretInEditor(editor, 1);

      await waitFor(() => {
        const caret = editor.querySelector('.st-block-caret') as HTMLElement | null;
        expect(caret).toBeInTheDocument();
        expect(caret?.style.getPropertyValue('--st-block-caret-width')).toBe('20px');
      });
    } finally {
      Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it('keeps default caret width when at end of text', async () => {
    const user = userEvent.setup();
    const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        width: 20,
        height: 0,
        right: 20,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    try {
      const editor = await getEditor();
      await user.click(editor);
      await user.type(editor, 'W');
      setCaretInEditor(editor, 1);

      await waitFor(() => {
        const caret = editor.querySelector('.st-block-caret') as HTMLElement | null;
        expect(caret).toBeInTheDocument();
        expect(caret?.style.getPropertyValue('--st-block-caret-width')).toBe('');
      });
    } finally {
      Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

});
