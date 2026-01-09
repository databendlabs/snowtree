import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InputBar } from './InputBar';
import type { Session } from '../../types/session';

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

// Setup browser API mocks
let mockRange: any;
let mockSelection: any;

beforeEach(() => {
  // Mock Range
  mockRange = {
    startContainer: null as Node | null,
    endContainer: null as Node | null,
    startOffset: 0,
    endOffset: 0,
    collapsed: true,
    setStart: vi.fn(function(this: any, node: Node, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    }),
    setEnd: vi.fn(function(this: any, node: Node, offset: number) {
      this.endContainer = node;
      this.endOffset = offset;
    }),
    setStartAfter: vi.fn(function(this: any, node: Node) {
      const parent = node.parentNode;
      if (parent) {
        const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
        this.startContainer = parent;
        this.startOffset = index + 1;
      }
    }),
    setEndAfter: vi.fn(function(this: any, node: Node) {
      const parent = node.parentNode;
      if (parent) {
        const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
        this.endContainer = parent;
        this.endOffset = index + 1;
      }
    }),
    collapse: vi.fn(function(this: any, toStart: boolean) {
      if (toStart) {
        this.endContainer = this.startContainer;
        this.endOffset = this.startOffset;
      } else {
        this.startContainer = this.endContainer;
        this.startOffset = this.endOffset;
      }
      this.collapsed = true;
    }),
    selectNodeContents: vi.fn(function(this: any, node: Node) {
      this.startContainer = node;
      this.startOffset = 0;
      this.endContainer = node;
      this.endOffset = node.childNodes.length;
    }),
    deleteContents: vi.fn(),
    insertNode: vi.fn(function(this: any, node: Node) {
      if (this.startContainer?.nodeType === Node.TEXT_NODE) {
        const textNode = this.startContainer as Text;
        const parent = textNode.parentNode;
        if (parent) {
          parent.insertBefore(node, textNode.nextSibling);
        }
      } else if (this.startContainer) {
        this.startContainer.appendChild(node);
      }
    }),
    getBoundingClientRect: vi.fn(() => ({ top: 0, left: 0, width: 0, height: 10 })),
    getClientRects: vi.fn(() => [{ top: 0, left: 0, width: 0, height: 10 }]),
  };

  // Mock Selection
  mockSelection = {
    rangeCount: 1,
    getRangeAt: vi.fn(() => mockRange),
    removeAllRanges: vi.fn(function(this: any) {
      this.rangeCount = 0;
    }),
    addRange: vi.fn(function(this: any, range: any) {
      mockRange = range;
      this.rangeCount = 1;
    }),
  };

  // Mock window.getSelection
  global.window.getSelection = vi.fn(() => mockSelection);

  // Mock document.createRange
  global.document.createRange = vi.fn(() => {
    const newRange = { ...mockRange };
    return newRange;
  });

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
  status: 'idle',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  project_id: 1,
  worktree_path: '/test/path',
  branch: 'test-branch',
};

describe('InputBar - Cursor Position Tests', () => {
  let mockOnSend: ReturnType<typeof vi.fn>;
  let mockOnCancel: ReturnType<typeof vi.fn>;
  let mockOnToolChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSend = vi.fn();
    mockOnCancel = vi.fn();
    mockOnToolChange = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should place cursor after image tag when image is pasted', async () => {
    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onToolChange={mockOnToolChange}
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = screen.getByTestId('input-editor') as HTMLDivElement;

    // Set initial content
    editor.innerText = 'hello';
    fireEvent.input(editor);

    // Move cursor to position 2 (after "he")
    const range = document.createRange();
    const textNode = editor.firstChild as Text;
    range.setStart(textNode, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Blur the editor to save cursor position
    fireEvent.blur(editor);

    // Wait for saved position
    await waitFor(() => {
      expect(editor).not.toHaveFocus();
    });

    // Create a mock image file
    const file = new File(['test'], 'test.png', { type: 'image/png' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    // Paste image
    fireEvent.paste(editor, {
      clipboardData: dataTransfer,
    });

    // Wait for image to be inserted
    await waitFor(() => {
      const imageTag = editor.querySelector('[data-image-id]');
      expect(imageTag).toBeInTheDocument();
    });

    // Check cursor position - should be after image tag
    await waitFor(() => {
      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      if (sel && sel.rangeCount > 0) {
        const currentRange = sel.getRangeAt(0);
        const imageTag = editor.querySelector('[data-image-id]');

        // Cursor should be after the image tag and space
        // The structure should be: textNode("he") -> imageTag -> textNode(" ") -> textNode("llo")
        // And cursor should be after the space
        expect(currentRange.startContainer).not.toBe(imageTag);

        // Verify content structure
        expect(editor.textContent).toContain('[img 1]');
      }
    });
  });

  it('should insert text at saved cursor position after blur', async () => {
    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onToolChange={mockOnToolChange}
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = screen.getByTestId('input-editor') as HTMLDivElement;

    // Set initial content
    editor.innerText = 'helloworld';
    fireEvent.input(editor);

    // Move cursor to position 5 (after "hello")
    const range = document.createRange();
    const textNode = editor.firstChild as Text;
    range.setStart(textNode, 5);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Blur the editor to save cursor position
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(editor).not.toHaveFocus();
    });

    // Simulate global keypress (typing when editor is not focused)
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'X',
      bubbles: true,
    });
    document.dispatchEvent(keyEvent);

    // Wait for text to be inserted
    await waitFor(() => {
      // Text should be inserted at saved position: "helloXworld"
      expect(editor.textContent).toBe('helloXworld');
    }, { timeout: 1000 });
  });

  it('should paste text at saved cursor position after blur', async () => {
    // Mock clipboard API
    const mockClipboard = {
      readText: vi.fn().mockResolvedValue('PASTED'),
      read: vi.fn().mockResolvedValue([]),
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
    });

    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onToolChange={mockOnToolChange}
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = screen.getByTestId('input-editor') as HTMLDivElement;

    // Set initial content
    editor.innerText = 'helloworld';
    fireEvent.input(editor);

    // Move cursor to position 5 (after "hello")
    const range = document.createRange();
    const textNode = editor.firstChild as Text;
    range.setStart(textNode, 5);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Blur the editor to save cursor position
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(editor).not.toHaveFocus();
    });

    // Simulate Ctrl+V paste
    const pasteEvent = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(pasteEvent);

    // Wait for text to be pasted
    await waitFor(() => {
      // Text should be pasted at saved position: "helloPASTEDworld"
      expect(editor.textContent).toBe('helloPASTEDworld');
    }, { timeout: 1000 });
  });

  it('should maintain cursor position through multiple operations', async () => {
    render(
      <InputBar
        session={mockSession}
        panelId="test-panel"
        selectedTool="claude"
        onToolChange={mockOnToolChange}
        onSend={mockOnSend}
        onCancel={mockOnCancel}
        isProcessing={false}
      />
    );

    const editor = screen.getByTestId('input-editor') as HTMLDivElement;

    // Initial text
    editor.innerText = 'abc';
    fireEvent.input(editor);

    // Position cursor at index 1 (after "a")
    let range = document.createRange();
    let textNode = editor.firstChild as Text;
    range.setStart(textNode, 1);
    range.collapse(true);
    let selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Blur
    fireEvent.blur(editor);
    await waitFor(() => expect(editor).not.toHaveFocus());

    // Type "X"
    const keyEvent1 = new KeyboardEvent('keydown', { key: 'X', bubbles: true });
    document.dispatchEvent(keyEvent1);

    await waitFor(() => {
      expect(editor.textContent).toBe('aXbc');
    });

    // Focus and move cursor to end
    editor.focus();
    range = document.createRange();
    textNode = editor.firstChild as Text;
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Blur again
    fireEvent.blur(editor);
    await waitFor(() => expect(editor).not.toHaveFocus());

    // Type "Y"
    const keyEvent2 = new KeyboardEvent('keydown', { key: 'Y', bubbles: true });
    document.dispatchEvent(keyEvent2);

    await waitFor(() => {
      expect(editor.textContent).toBe('aXbcY');
    });
  });
});
