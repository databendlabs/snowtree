import React, { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { ChevronDown, Sparkles, Code2, Loader2 } from 'lucide-react';
import type { InputBarProps, CLITool, ImageAttachment, ExecutionMode } from './types';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { TimelineEvent } from '../../types/timeline';

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const BlockCursor: React.FC<{
  editorRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  color: string;
  opacity?: number;
}> = ({ editorRef, visible, color, opacity = 0.7 }) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const lastPositionRef = useRef<{ top: number; left: number } | null>(null);
  const updateTimeoutRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!visible || !editorRef.current) {
      return;
    }

    const updatePosition = () => {
      const editor = editorRef.current;
      if (!editor) return;

      const selection = window.getSelection();
      const editorRect = editor.getBoundingClientRect();
      const isEditorEmpty = (editor.textContent || '').trim().length === 0;

      // Try to use current selection if available
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);

        // Check if selection is within editor
        if (editor.contains(range.startContainer)) {
          // When there's a non-collapsed selection, the browser caret is typically hidden.
          // Our custom block cursor should also hide to avoid looking like it's "jumping"
          // (e.g. after Cmd/Ctrl+C where selection remains highlighted).
          if (!range.collapsed) {
            setPosition(null);
            return;
          }

          // Use getBoundingClientRect directly (no temp span)
          const rect = range.getBoundingClientRect();

          // Check if rect is valid
          if (rect.width !== 0 || rect.height !== 0) {
            const newPos = {
              top: rect.top - editorRect.top,
              left: rect.left - editorRect.left,
            };
            setPosition(newPos);
            lastPositionRef.current = newPos;
            return;
          }

          // If rect is invalid (collapsed range with 0 dimensions), try getClientRects
          const rects = range.getClientRects();
          if (rects.length > 0) {
            const firstRect = rects[0];
            if (firstRect.width !== 0 || firstRect.height !== 0) {
              const newPos = {
                top: firstRect.top - editorRect.top,
                left: firstRect.left - editorRect.left,
              };
              setPosition(newPos);
              lastPositionRef.current = newPos;
              return;
            }
          }

          // Fallback: insert a temporary marker to get cursor position
          // This handles cases like cursor after <br> where getBoundingClientRect returns zero
          try {
            const marker = document.createElement('span');
            marker.setAttribute('data-cursor-marker', 'true');
            marker.textContent = '\u200B'; // zero-width space

            // Clone the range to avoid modifying the original selection
            const markerRange = range.cloneRange();
            markerRange.insertNode(marker);

            const markerRect = marker.getBoundingClientRect();
            const hasValidRect = markerRect.width !== 0 || markerRect.height !== 0;

            // Immediately remove marker and restore selection
            const parent = marker.parentNode;
            if (parent) {
              parent.removeChild(marker);
              // Normalize to merge adjacent text nodes
              parent.normalize();
            }

            if (hasValidRect) {
              const newPos = {
                top: markerRect.top - editorRect.top,
                left: markerRect.left - editorRect.left,
              };
              setPosition(newPos);
              lastPositionRef.current = newPos;
              return;
            }
          } catch {
            // best-effort, continue to fallback
          }
        }
      }

      // If no valid selection/rect:
      // - When editor is empty, always reset to origin (avoid "drift" after clearing).
      // - Otherwise, keep last known position for unfocused states.
      if (isEditorEmpty) {
        setPosition({ top: 0, left: 0 });
        lastPositionRef.current = { top: 0, left: 0 };
        return;
      }
      if (lastPositionRef.current) {
        setPosition(lastPositionRef.current);
        return;
      }

      setPosition({ top: 0, left: 0 });
      lastPositionRef.current = { top: 0, left: 0 };
    };

    // Debounced update for better performance during rapid changes
    const debouncedUpdate = () => {
      if (updateTimeoutRef.current !== null) {
        cancelAnimationFrame(updateTimeoutRef.current);
      }
      updateTimeoutRef.current = requestAnimationFrame(updatePosition);
    };

    updatePosition();

    const editor = editorRef.current;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by cursor marker insertion/removal
      const isMarkerMutation = mutations.every((m) => {
        if (m.type === 'childList') {
          const isMarkerNode = (node: Node) =>
            node instanceof HTMLElement && node.hasAttribute('data-cursor-marker');
          return (
            Array.from(m.addedNodes).every(isMarkerNode) ||
            Array.from(m.removedNodes).every(isMarkerNode)
          );
        }
        return false;
      });
      if (!isMarkerMutation) {
        debouncedUpdate();
      }
    });
    observer.observe(editor, {
      childList: true,
      subtree: true,
      characterData: true
    });

    document.addEventListener('selectionchange', debouncedUpdate);

    // Listen to all relevant events for immediate updates
    editor.addEventListener('input', debouncedUpdate);
    editor.addEventListener('paste', debouncedUpdate);
    editor.addEventListener('cut', debouncedUpdate);
    editor.addEventListener('scroll', debouncedUpdate);
    editor.addEventListener('keydown', debouncedUpdate);
    editor.addEventListener('keyup', debouncedUpdate);
    editor.addEventListener('beforeinput', debouncedUpdate);
    window.addEventListener('resize', debouncedUpdate);

    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', debouncedUpdate);
      editor.removeEventListener('input', debouncedUpdate);
      editor.removeEventListener('paste', debouncedUpdate);
      editor.removeEventListener('cut', debouncedUpdate);
      editor.removeEventListener('scroll', debouncedUpdate);
      editor.removeEventListener('keydown', debouncedUpdate);
      editor.removeEventListener('keyup', debouncedUpdate);
      editor.removeEventListener('beforeinput', debouncedUpdate);
      window.removeEventListener('resize', debouncedUpdate);
      if (updateTimeoutRef.current !== null) {
        cancelAnimationFrame(updateTimeoutRef.current);
      }
    };
  }, [visible, editorRef]);

  if (!visible || !position) return null;

  return (
    <div
      className="absolute pointer-events-none"
      data-testid="input-block-cursor"
      style={{
        top: position.top,
        left: position.left,
        width: '8px',
        height: '19px',
        backgroundColor: color,
        opacity,
      }}
    />
  );
};

const KnightRiderSpinner: React.FC<{ color?: string }> = ({ color = 'var(--st-accent)' }) => {
  const [frame, setFrame] = useState(0);
  const width = 8;
  const trailLength = 3;
  const totalFrames = width * 2 - 2;

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % totalFrames);
    }, 60);
    return () => clearInterval(interval);
  }, [totalFrames]);

  const activePos = frame < width ? frame : (width * 2 - 2 - frame);

  return (
    <div className="flex gap-[1px] items-center">
      {Array.from({ length: width }).map((_, i) => {
        const distance = Math.abs(i - activePos);
        const isActive = distance < trailLength;
        const opacity = isActive ? 1 - (distance / trailLength) * 0.6 : 0.2;
        return (
          <div
            key={i}
            className="w-[5px] h-[5px] rounded-[1px]"
            style={{
              backgroundColor: color,
              opacity,
            }}
          />
        );
      })}
    </div>
  );
};

type ToolAvailability = {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
};

type AiToolsStatus = {
  fetchedAt?: string;
  cached?: boolean;
  claude: ToolAvailability;
  codex: ToolAvailability;
};

type ToolDisplaySettings = {
  model?: string;
  level?: string;
};

type AiToolSettingsResponse = {
  claude?: { model?: string };
  codex?: { model?: string; reasoningEffort?: string; sandbox?: string; askForApproval?: string };
};

const formatCliVersion = (version?: string): string | undefined => {
  if (!version) return undefined;
  const trimmed = version.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/(\d+\.\d+\.\d+)/);
  return match ? `v${match[1]}` : trimmed;
};

const CLISelector: React.FC<{
  selected: CLITool;
  onChange: (tool: CLITool) => void;
  disabled: boolean;
  availability: AiToolsStatus | null;
  availabilityLoading: boolean;
  settingsLoading: boolean;
  settings: Record<CLITool, ToolDisplaySettings>;
  onOpen: () => void;
}> = React.memo(({ selected, onChange, disabled, availability, availabilityLoading, settingsLoading, settings, onOpen }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const tools: { id: CLITool; label: string; icon: React.ReactNode }[] = [
    { id: 'claude', label: 'Claude', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: 'codex', label: 'Codex', icon: <Code2 className="w-3.5 h-3.5" /> },
  ];

  const selectedTool = tools.find(t => t.id === selected) || tools[0];
  const availabilityForSelected = availability?.[selected];
  const isSelectedAvailable = availabilityLoading ? true : (availabilityForSelected?.available ?? true);
  const isProbing = availabilityLoading || settingsLoading;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => {
          if (disabled) return;
          const next = !isOpen;
          setIsOpen(next);
          if (next) onOpen();
        }}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-all st-focus-ring ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer st-hoverable'
        } ${isOpen ? 'st-selected' : ''}`}
        title={!isSelectedAvailable ? (availabilityForSelected?.error || `${selectedTool.label} unavailable`) : undefined}
      >
        {selectedTool.icon}
        <span style={{ color: 'var(--st-text)' }}>{selectedTool.label}</span>
        {isProbing && <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--st-text-faint)' }} />}
        {!availabilityLoading && !isSelectedAvailable && <span className="text-[10px] uppercase tracking-wider st-text-faint">Unavailable</span>}
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--st-text-faint)' }} />
      </button>

      <div
        className={`absolute bottom-full left-0 mb-1 border rounded-lg shadow-xl py-1 min-w-[280px] z-50 transition-all origin-bottom relative ${
          isOpen
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
        }`}
        style={{ transitionDuration: '150ms' }}
      >
        <div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{
            backgroundColor: 'var(--st-surface)',
            border: '1px solid color-mix(in srgb, var(--st-border) 70%, transparent)',
          }}
        />
        {tools.map((tool) => {
          const toolSettings = settings[tool.id];
          const toolAvailability = availability?.[tool.id];
          const subtitle = [
            toolSettings?.model,
            tool.id === 'codex' ? toolSettings?.level : null,
            formatCliVersion(toolAvailability?.version)
          ].filter(Boolean).join(' · ');
          
          return (
            <button
              key={tool.id}
              onClick={() => {
                if (!availabilityLoading && toolAvailability && !toolAvailability.available) {
                  return;
                }
                onChange(tool.id);
                setIsOpen(false);
              }}
              disabled={!availabilityLoading && !!toolAvailability && !toolAvailability.available}
              className={`relative w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors st-focus-ring ${
                selected === tool.id ? 'st-selected' : 'st-hoverable'
              } ${!availabilityLoading && toolAvailability && !toolAvailability.available ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {tool.icon}
              <div className="flex flex-col items-start min-w-0">
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--st-text)' }}>{tool.label}</span>
                  {!availabilityLoading && toolAvailability?.available === false && (
                    <span className="text-[10px] uppercase tracking-wider st-text-faint">Unavailable</span>
                  )}
                </div>
                {subtitle && (
                  <span className="text-[11px] truncate max-w-[260px] st-text-faint">{subtitle}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

CLISelector.displayName = 'CLISelector';

export const InputBar: React.FC<InputBarProps> = React.memo(({
  session,
  panelId: _panelId,
  selectedTool,
  onSend,
  onCancel,
  isProcessing,
  placeholder = 'Message...',
  focusRequestId,
  initialExecutionMode,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [executionMode, setExecutionModeInternal] = useState<ExecutionMode>(initialExecutionMode || 'execute');

  // Update local state when initialExecutionMode changes (e.g., session switch)
  useEffect(() => {
    if (initialExecutionMode !== undefined) {
      setExecutionModeInternal(initialExecutionMode);
    }
  }, [initialExecutionMode]);

  const editorRef = useRef<HTMLDivElement>(null);
  const [aiToolsStatus, setAiToolsStatus] = useState<AiToolsStatus | null>(null);
  const [, setAiToolsLoading] = useState(false);
  const [, setToolSettingsProbeLoading] = useState(true);
  const [, setToolSettingsTimelineLoading] = useState(true);
  const [toolSettings, setToolSettings] = useState<Record<CLITool, ToolDisplaySettings>>({
    claude: {},
    codex: {}
  });
  const [escPending, setEscPending] = useState(false);
  const escTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const imageIdCounter = useRef(0);
  const savedSelectionRef = useRef<{ start: Node; offset: number } | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null); // index into inputHistoryRef.current
  const draftBeforeHistoryRef = useRef<string>('');
  const historyNavPrimedRef = useRef<'up' | 'down' | null>(null);
  const emitSelectionChange = useCallback(() => {
    try {
      document.dispatchEvent(new Event('selectionchange'));
    } catch {
      // best-effort
    }
  }, []);

  const getEditorText = useCallback(() => {
    if (!editorRef.current) return '';
    return editorRef.current.innerText || '';
  }, []);

  const insertTextAtCursor = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    const selection = window.getSelection();
    if (!selection) return;

    let range: Range;

    // Prefer the *current* selection if it's within the editor. This is critical for paste:
    // `savedSelectionRef` can be stale (e.g. user clicked to reposition caret then pasted).
    if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
      range = selection.getRangeAt(0);
    // Fallback: restore saved selection (used by global keypress/paste handlers when editor isn't focused).
    } else if (savedSelectionRef.current && editor.contains(savedSelectionRef.current.start)) {
      range = document.createRange();
      try {
        range.setStart(savedSelectionRef.current.start, savedSelectionRef.current.offset);
        range.collapse(true);
      } catch (err) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false); // End of editor
      }
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    // Delete any selected content and insert text
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    // Move cursor to end of inserted text.
    // Keep the caret anchored inside the inserted text node: this is more stable for our
    // custom BlockCursor positioning than using `setStartAfter` (which can land on the parent).
    try {
      const endOffset = textNode.data.length;
      range.setStart(textNode, endOffset);
      range.setEnd(textNode, endOffset);
      range.collapse(true);
    } catch {
      // Fallback
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      range.collapse(true);
    }

    // Update selection
    selection.removeAllRanges();
    selection.addRange(range);

    // Save the new position
    const newOffset = range.startOffset;
    savedSelectionRef.current = { start: range.startContainer, offset: newOffset };

    // Trigger input event
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    emitSelectionChange();
  }, [emitSelectionChange]);

  const insertImageTag = useCallback((index: number, id: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    const pill = document.createElement('span');
    pill.textContent = `[img${index}]`;
    pill.setAttribute('data-image-id', id);
    pill.setAttribute('contenteditable', 'false');
    pill.style.cssText = `
      display: inline-block;
      padding: 2px 6px;
      margin: 0 2px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 13px;
      background-color: color-mix(in srgb, var(--st-accent) 15%, transparent);
      color: var(--st-accent);
      user-select: all;
      cursor: default;
    `;

    const selection = window.getSelection();
    if (!selection) return;

    let range: Range;

    // Prefer the *current* selection if it's within the editor.
    if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
      range = selection.getRangeAt(0);
    } else if (savedSelectionRef.current && editor.contains(savedSelectionRef.current.start)) {
      range = document.createRange();
      try {
        range.setStart(savedSelectionRef.current.start, savedSelectionRef.current.offset);
        range.collapse(true);
      } catch {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    // Insert pill
    range.deleteContents();
    range.insertNode(pill);
    range.setStartAfter(pill);
    range.setEndAfter(pill);

    // Add space after pill
    const space = document.createTextNode(' ');
    range.insertNode(space);

    range.setStart(space, space.length);
    range.setEnd(space, space.length);
    range.collapse(true);

    // Update selection first
    selection.removeAllRanges();
    selection.addRange(range);

    // Save the new position - pointing to the space text node
    savedSelectionRef.current = { start: space, offset: space.length };

    // Focus after setting selection
    editor.focus();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    emitSelectionChange();
  }, [emitSelectionChange]);

  const addImageAttachment = useCallback((file: File): Promise<void> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const id = `img-${Date.now()}-${imageIdCounter.current++}`;
        const imageIndex = imageAttachments.length + 1;

        setImageAttachments((prev) => [...prev, {
          id,
          filename: file.name || 'image.png',
          mime: file.type || 'image/png',
          dataUrl,
        }]);

        insertImageTag(imageIndex, id);
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }, [imageAttachments.length, insertImageTag]);

  const handleEditorPaste = useCallback(async (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Always prevent default and handle manually
    e.preventDefault();

    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const items = Array.from(clipboardData.items);
    const imageItems = items.filter((item) => ACCEPTED_IMAGE_TYPES.includes(item.type));

    // Handle images
    if (imageItems.length > 0) {
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) await addImageAttachment(file);
      }
    }

    // Handle text
    if (clipboardData.types.includes('text/plain')) {
      const text = clipboardData.getData('text/plain');
      if (text) {
        insertTextAtCursor(text);
      }
    }
  }, [addImageAttachment, insertTextAtCursor]);

  const moveCursorToEnd = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      // Prefer anchoring inside the last text node for stable caret + BlockCursor.
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      let node = walker.nextNode();
      while (node) {
        const t = node as Text;
        if (t.data.length > 0) last = t;
        node = walker.nextNode();
      }
      if (last) {
        range.setStart(last, last.data.length);
        range.collapse(true);
      } else {
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(range);
      savedSelectionRef.current = { start: range.startContainer, offset: range.startOffset };
      emitSelectionChange();
    } catch {
      // best-effort
    }
  }, [emitSelectionChange]);

  const handleEditorCopy = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    void e;
    // Allow the browser to perform the copy. Then collapse selection and move caret to the end,
    // which matches typical chat-input UX (copy then keep typing at end).
    const editor = editorRef.current;
    if (!editor) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return;

    requestAnimationFrame(() => moveCursorToEnd());
  }, [moveCursorToEnd]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const observer = new MutationObserver(() => {
      const currentPills = editor.querySelectorAll('[data-image-id]');
      const currentIds = new Set(Array.from(currentPills).map(p => p.getAttribute('data-image-id')));
      
      setImageAttachments((prev) => prev.filter((img) => currentIds.has(img.id)));
    });

    observer.observe(editor, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const handleSubmit = useCallback(() => {
    const text = getEditorText().trim();
    if (!text && imageAttachments.length === 0) return;
    if (isProcessing) return;

    if (text) {
      const hist = inputHistoryRef.current;
      if (hist.length === 0 || hist[hist.length - 1] !== text) {
        inputHistoryRef.current = [...hist, text].slice(-100);
      }
      historyIndexRef.current = null;
      draftBeforeHistoryRef.current = '';
    }

    onSend(text, imageAttachments.length > 0 ? imageAttachments : undefined, executionMode === 'plan');
    if (editorRef.current) {
      const editor = editorRef.current;
      editor.innerHTML = '';

      // Reset selection to the start so BlockCursor doesn't keep a stale/removed position.
      // Also reset the saved selection, since previous nodes may no longer exist.
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        savedSelectionRef.current = { start: editor, offset: 0 };
        emitSelectionChange();
      } catch {
        savedSelectionRef.current = null;
      }
    }
    setImageAttachments([]);
  }, [emitSelectionChange, getEditorText, imageAttachments, isProcessing, onSend]);

  const isRunning = session.status === 'running' || session.status === 'initializing';

  const placeCaretAtBoundary = useCallback((which: 'start' | 'end') => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      const selection = window.getSelection();
      if (!selection) return;

      const range = document.createRange();

      // Prefer anchoring inside a text node (more reliable for visual caret + BlockCursor).
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      let node = walker.nextNode();
      while (node) {
        const t = node as Text;
        if (t.data.length > 0) texts.push(t);
        node = walker.nextNode();
      }

      if (texts.length === 0) {
        range.selectNodeContents(editor);
        range.collapse(which === 'start');
      } else if (which === 'start') {
        range.setStart(texts[0], 0);
        range.collapse(true);
      } else {
        const last = texts[texts.length - 1];
        range.setStart(last, last.data.length);
        range.collapse(true);
      }

      selection.removeAllRanges();
      selection.addRange(range);
      savedSelectionRef.current = { start: range.startContainer, offset: range.startOffset };
      emitSelectionChange();
    } catch {
      // best-effort
    }
  }, [emitSelectionChange]);

  const setEditorTextAndMoveCaretToEnd = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    placeCaretAtBoundary('end');
  }, [placeCaretAtBoundary]);

  const isCaretAtBoundary = useCallback((which: 'start' | 'end'): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const caret = selection.getRangeAt(0);
    if (!editor.contains(caret.startContainer)) return false;
    if (!caret.collapsed) return false;
    const getCaretTextOffset = (): number | null => {
      try {
        if (caret.startContainer === editor) {
          const childCount = editor.childNodes.length;
          const idx = Math.max(0, Math.min(caret.startOffset, childCount));
          let off = 0;
          for (let i = 0; i < idx; i++) {
            off += (editor.childNodes[i]?.textContent || '').length;
          }
          return off;
        }

        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let off = 0;
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node === caret.startContainer) {
            const textLen = (node.textContent || '').length;
            const clamped = Math.max(0, Math.min(caret.startOffset, textLen));
            return off + clamped;
          }
          off += (node.textContent || '').length;
          node = walker.nextNode();
        }
      } catch {
        // ignore
      }
      return null;
    };

    const offset = getCaretTextOffset();
    if (offset === null) return false;
    const total = (editor.textContent || '').length;
    return which === 'start' ? offset === 0 : offset === total;
  }, []);

  const moveCaretToBoundary = useCallback((which: 'start' | 'end') => {
    placeCaretAtBoundary(which);
  }, [placeCaretAtBoundary]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isRunning) {
      e.preventDefault();
      return;
    }

    // Input history navigation (shell-like).
    // - First ArrowUp/Down jumps caret to start/end.
    // - Second ArrowUp/Down (when already at boundary) cycles through sent prompts.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const editor = editorRef.current;
      if (!editor) return;

      const history = inputHistoryRef.current;
      const inHistory = historyIndexRef.current !== null;
      const direction: 'up' | 'down' = e.key === 'ArrowUp' ? 'up' : 'down';

      const goPrev = () => {
        if (history.length === 0) return;
        if (historyIndexRef.current === null) {
          draftBeforeHistoryRef.current = getEditorText();
          historyIndexRef.current = history.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        const idx = historyIndexRef.current;
        if (idx === null) return;
        setEditorTextAndMoveCaretToEnd(history[idx]);
      };

      const goNext = () => {
        if (history.length === 0) return;
        if (historyIndexRef.current === null) return;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          setEditorTextAndMoveCaretToEnd(history[historyIndexRef.current]);
          return;
        }
        // Past the newest entry => restore draft and exit history.
        historyIndexRef.current = null;
        const draft = draftBeforeHistoryRef.current;
        draftBeforeHistoryRef.current = '';
        setEditorTextAndMoveCaretToEnd(draft);
      };

      e.preventDefault();

      // While browsing history, ArrowUp/Down always navigates history.
      if (inHistory) {
        historyNavPrimedRef.current = direction;
        if (direction === 'up') goPrev();
        else goNext();
        return;
      }

      // Two-step behavior: first press always moves caret to boundary (even if already there),
      // second press (while still at boundary) triggers history navigation.
      if (historyNavPrimedRef.current !== direction) {
        historyNavPrimedRef.current = direction;
        moveCaretToBoundary(direction === 'up' ? 'start' : 'end');
        return;
      }

      if (direction === 'up') {
        if (!isCaretAtBoundary('start')) {
          moveCaretToBoundary('start');
          return;
        }
        goPrev();
        return;
      }

      // direction === 'down'
      if (!isCaretAtBoundary('end')) {
        moveCaretToBoundary('end');
        return;
      }
      // At end and not in history: nothing to do.
      return;
    }

    // Any other key resets the two-step arrow priming.
    historyNavPrimedRef.current = null;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [getEditorText, handleSubmit, isCaretAtBoundary, isRunning, moveCaretToBoundary, setEditorTextAndMoveCaretToEnd]);

  useEffect(() => {
    if (!isRunning) {
      setEscPending(false);
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }
    }
  }, [isRunning]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('esc-pending-change', { detail: { escPending } }));
  }, [escPending]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isRunning) {
        e.preventDefault();
        if (escPending) {
          if (escTimeoutRef.current) {
            clearTimeout(escTimeoutRef.current);
            escTimeoutRef.current = null;
          }
          setEscPending(false);
          onCancel();
        } else {
          setEscPending(true);
          escTimeoutRef.current = setTimeout(() => {
            setEscPending(false);
            escTimeoutRef.current = null;
          }, 5000);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isRunning, escPending, onCancel]);

  useEffect(() => {
    if (!focusRequestId) return;
    editorRef.current?.focus();
  }, [focusRequestId]);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  // Auto-focus on typing (keyboard input auto-focuses the input field)
  useEffect(() => {
    const handleGlobalKeyPress = (e: KeyboardEvent) => {
      // Skip if already focused
      if (document.activeElement === editorRef.current) return;

      // Skip if focus is in another input/textarea/contenteditable
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // Ctrl/Cmd+A should select the input contents (chat-style UX), not the whole page.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();
        try {
          const selection = window.getSelection();
          if (!selection) return;
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges();
          selection.addRange(range);
          emitSelectionChange();
        } catch {
          // best-effort
        }
        return;
      }

      // Handle Ctrl+V / Cmd+V specially (check clipboard for images)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;

        editor.focus();
        setTimeout(async () => {
          try {
            const clipboardItems = await navigator.clipboard.read();
            let hasImage = false;
            let hasText = false;

            for (const item of clipboardItems) {
              if (item.types.some(type => ACCEPTED_IMAGE_TYPES.includes(type))) {
                hasImage = true;
                for (const type of item.types) {
                  if (ACCEPTED_IMAGE_TYPES.includes(type)) {
                    const blob = await item.getType(type);
                    const file = new File([blob], 'clipboard.png', { type });
                    await addImageAttachment(file);
                    break;
                  }
                }
              }
              if (item.types.includes('text/plain')) {
                hasText = true;
              }
            }

            if (hasText && !hasImage) {
              const text = await navigator.clipboard.readText();
              insertTextAtCursor(text);
            }
          } catch (err) {
            try {
              const text = await navigator.clipboard.readText();
              insertTextAtCursor(text);
            } catch {
              // best-effort
            }
          }
        }, 0);
        return;
      }

      // Handle Delete/Backspace specially
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;

        editor.focus();
        setTimeout(() => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) {
            return;
          }

          const range = selection.getRangeAt(0);
          if (!editor.contains(range.startContainer)) {
            return;
          }

          if (!range.collapsed) {
            range.deleteContents();
          } else if (e.key === 'Backspace') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startOffset > 0 && startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              textNode.deleteData(startOffset - 1, 1);
              range.setStart(textNode, startOffset - 1);
              range.collapse(true);
            }
          } else if (e.key === 'Delete') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              if (startOffset < textNode.length) {
                textNode.deleteData(startOffset, 1);
              }
            }
          }

          selection.removeAllRanges();
          selection.addRange(range);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }, 0);
        return;
      }

      // Skip if modifier keys are pressed
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Skip special keys (removed Backspace and Delete, now handled above)
      const skipKeys = [
        'Escape', 'Tab', 'Enter',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
      ];
      if (skipKeys.includes(e.key)) return;

      // Handle printable key press - focus and insert at saved position
      e.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;

      editor.focus();
      setTimeout(() => {
        insertTextAtCursor(e.key);
      }, 0);
    };

    // Also handle paste events directly (backup for when Ctrl+V doesn't trigger)
    const handleGlobalPasteCapture = (e: ClipboardEvent) => {
      if (document.activeElement === editorRef.current) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      e.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;

      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      editor.focus();
      setTimeout(async () => {
        const items = Array.from(clipboardData.items);
        const imageItems = items.filter((item) => ACCEPTED_IMAGE_TYPES.includes(item.type));

        if (imageItems.length > 0) {
          for (const item of imageItems) {
            const file = item.getAsFile();
            if (file) await addImageAttachment(file);
          }
        }

        if (clipboardData.types.includes('text/plain')) {
          const text = clipboardData.getData('text/plain');
          if (text) insertTextAtCursor(text);
        }
      }, 0);
    };

    document.addEventListener('keydown', handleGlobalKeyPress, { capture: true });
    document.addEventListener('paste', handleGlobalPasteCapture, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyPress, { capture: true });
      document.removeEventListener('paste', handleGlobalPasteCapture, { capture: true });
    };
  }, [addImageAttachment, emitSelectionChange, insertTextAtCursor]);

  const loadAvailability = useCallback(async (force?: boolean) => {
    setAiToolsLoading(true);
    try {
      const res = await API.aiTools.getStatus({ force });
      if (res.success && res.data) {
        setAiToolsStatus(res.data as AiToolsStatus);
      }
    } finally {
      setAiToolsLoading(false);
    }
  }, []);

  const applyTimelineEventToSettings = useCallback((event: TimelineEvent) => {
    if (event.kind !== 'cli.command') return;
    if (event.tool !== 'claude' && event.tool !== 'codex') return;
    const meta = (event.meta || {}) as Record<string, unknown>;
    const cliModel = typeof meta.cliModel === 'string' ? meta.cliModel : undefined;
    const cliReasoningEffort = typeof meta.cliReasoningEffort === 'string' ? meta.cliReasoningEffort : undefined;

    setToolSettings((prev) => {
      const next = { ...prev };
      if (event.tool === 'claude') {
        next.claude = {
          ...next.claude,
          model: cliModel ?? next.claude.model,
        };
      } else {
        next.codex = {
          ...next.codex,
          model: cliModel ?? next.codex.model,
          level: cliReasoningEffort ?? next.codex.level,
        };
      }
      return next;
    });
  }, []);

  const loadToolSettingsFromProbe = useCallback(async () => {
    setToolSettingsProbeLoading(true);
    try {
      const res = await withTimeout(API.aiTools.getSettings(), 8_000, 'Detect CLI settings');
      if (!res.success || !res.data) return;
      const data = res.data as AiToolSettingsResponse;
      setToolSettings((prev) => ({
        claude: {
          model: typeof data.claude?.model === 'string' ? data.claude?.model : prev.claude.model,
        },
        codex: {
          model: typeof data.codex?.model === 'string' ? data.codex?.model : prev.codex.model,
          level: typeof data.codex?.reasoningEffort === 'string' ? data.codex?.reasoningEffort : prev.codex.level,
        },
      }));
    } catch {
    } finally {
      setToolSettingsProbeLoading(false);
    }
  }, []);

  const loadToolSettingsFromTimeline = useCallback(async () => {
    setToolSettingsTimelineLoading(true);
    try {
      const res = await withTimeout(API.sessions.getTimeline(session.id), 8_000, 'Load runtime settings');
      if (!res.success || !Array.isArray(res.data)) return;
      const events = res.data as TimelineEvent[];

      let lastClaude: TimelineEvent | null = null;
      let lastCodex: TimelineEvent | null = null;
      for (const e of events) {
        if (e.kind !== 'cli.command') continue;
        if (e.tool === 'claude') lastClaude = e;
        if (e.tool === 'codex') lastCodex = e;
      }
      if (lastClaude) applyTimelineEventToSettings(lastClaude);
      if (lastCodex) applyTimelineEventToSettings(lastCodex);
    } catch {
    } finally {
      setToolSettingsTimelineLoading(false);
    }
  }, [session.id, applyTimelineEventToSettings]);

  useEffect(() => {
    void loadToolSettingsFromProbe();
    loadToolSettingsFromTimeline();
  }, [loadToolSettingsFromProbe, loadToolSettingsFromTimeline]);

  useEffect(() => {
    if (!window.electronAPI?.events?.onTimelineEvent) return;
    const unsubscribe = window.electronAPI.events.onTimelineEvent((data) => {
      if (data.sessionId !== session.id) return;
      const event = data.event as TimelineEvent | undefined;
      if (!event) return;
      applyTimelineEventToSettings(event);
    });
    return () => unsubscribe();
  }, [session.id, applyTimelineEventToSettings]);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  const agentName = selectedTool === 'claude' ? 'Claude' : 'Codex';
  const modeName = executionMode === 'plan' ? 'Plan' : 'Execute';
  const selectedSettings = toolSettings[selectedTool];
  const availabilityForSelected = aiToolsStatus?.[selectedTool];
  const modelInfo = selectedSettings.model || '';
  const levelInfo = selectedTool === 'codex' && selectedSettings.level ? selectedSettings.level : '';
  const versionInfo = formatCliVersion(availabilityForSelected?.version) || '';

  return (
    <div className="flex-shrink-0 px-4 py-2" style={{ backgroundColor: 'var(--st-bg)' }}>
      <div className="flex">
        <div
          className="w-[2px] self-stretch transition-colors duration-150"
          style={{ backgroundColor: isFocused || isRunning ? 'var(--st-accent)' : 'var(--st-border-variant)' }}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="ml-2">
            <div
              className="px-3 py-2"
              style={{ backgroundColor: 'var(--st-editor)' }}
            >
              <div className="relative">
                <div
                  ref={editorRef}
                  contentEditable
                  role="textbox"
                  aria-label={placeholder}
                  aria-multiline="true"
                  data-testid="input-editor"
                  onKeyDown={handleKeyDown}
                  onPaste={handleEditorPaste}
                  onCopy={handleEditorCopy}
                  onFocus={() => {
                    setIsFocused(true);
                  }}
                  onBlur={() => {
                    setIsFocused(false);
                    // Save cursor position on blur
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                      const range = selection.getRangeAt(0);
                      if (editorRef.current?.contains(range.startContainer)) {
                        savedSelectionRef.current = {
                          start: range.startContainer,
                          offset: range.startOffset,
                        };
                      }
                    }
                  }}
                  className="w-full bg-transparent text-[13px] focus:outline-none min-h-[20px] max-h-[144px] overflow-y-auto"
                  style={{
                    color: isRunning ? 'var(--st-text-faint)' : 'var(--st-text)',
                    caretColor: 'transparent',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                />
                <BlockCursor
                  editorRef={editorRef}
                  visible={!isRunning}
                  color="var(--st-text)"
                  opacity={isFocused ? 0.7 : 0.3}
                />
              </div>

              <div className="flex items-center gap-2 mt-2 text-[12px]">
                <span data-testid="input-agent" style={{ color: 'var(--st-accent)' }}>{agentName}</span>
                <span
                  data-testid="input-mode"
                  style={{
                    color: executionMode === 'plan' ? 'var(--st-warning, #f59e0b)' : 'var(--st-text-faint)',
                  }}
                >
                  {modeName}
                </span>
                {modelInfo && (
                  <span style={{ color: 'var(--st-text)' }}>{modelInfo}</span>
                )}
                {levelInfo && (
                  <span style={{ color: 'var(--st-text-faint)' }}>{levelInfo}</span>
                )}
                {versionInfo && (
                  <span style={{ color: 'var(--st-text-faint)' }}>{versionInfo}</span>
                )}
              </div>
            </div>
            <div 
              className="h-[3px]"
              style={{ 
                background: `linear-gradient(to bottom, var(--st-editor) 0%, transparent 100%)` 
              }}
            />
          </div>

          <div className="flex items-center justify-between ml-2 mt-1 text-[11px]">
            <div className="flex items-center gap-2">
              {isRunning && (
                <>
                  <KnightRiderSpinner color="var(--st-accent)" />
                  <span style={{ color: escPending ? 'var(--st-accent)' : 'var(--st-text)' }}>
                    esc{' '}
                    <span style={{ color: escPending ? 'var(--st-accent)' : 'var(--st-text-faint)' }}>
                      {escPending ? 'again to interrupt' : 'interrupt'}
                    </span>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span style={{ color: 'var(--st-text)' }}>
                tab{' '}
                <span style={{ color: 'var(--st-text-faint)' }}>switch agent</span>
              </span>
              <span style={{ color: 'var(--st-text)' }}>
                shift+tab{' '}
                <span style={{ color: 'var(--st-text-faint)' }}>switch mode</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

InputBar.displayName = 'InputBar';

export default InputBar;
