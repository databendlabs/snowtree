import React, { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { ChevronDown, Sparkles, Code2, Loader2 } from 'lucide-react';
import type { InputBarProps, CLITool, ImageAttachment } from './types';
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

      // Try to use current selection if available
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);

        // Check if selection is within editor
        if (editor.contains(range.startContainer)) {
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
        }
      }

      // If no valid selection or rect, use last known position or default
      if (lastPositionRef.current) {
        setPosition(lastPositionRef.current);
      } else {
        // Default to start of editor
        setPosition({ top: 0, left: 0 });
        lastPositionRef.current = { top: 0, left: 0 };
      }
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
    const observer = new MutationObserver(debouncedUpdate);
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
    editor.addEventListener('keydown', debouncedUpdate);
    editor.addEventListener('keyup', debouncedUpdate);
    editor.addEventListener('beforeinput', debouncedUpdate);

    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', debouncedUpdate);
      editor.removeEventListener('input', debouncedUpdate);
      editor.removeEventListener('paste', debouncedUpdate);
      editor.removeEventListener('cut', debouncedUpdate);
      editor.removeEventListener('keydown', debouncedUpdate);
      editor.removeEventListener('keyup', debouncedUpdate);
      editor.removeEventListener('beforeinput', debouncedUpdate);
      if (updateTimeoutRef.current !== null) {
        cancelAnimationFrame(updateTimeoutRef.current);
      }
    };
  }, [visible, editorRef]);

  if (!visible || !position) return null;

  return (
    <div
      className="absolute pointer-events-none"
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
  onToolChange,
  onSend,
  onCancel,
  isProcessing,
  placeholder = 'Message...',
  focusRequestId
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
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

  const getEditorText = useCallback(() => {
    if (!editorRef.current) return '';
    return editorRef.current.innerText || '';
  }, []);

  const checkEmpty = useCallback(() => {
    const text = getEditorText().trim();
    const hasPills = editorRef.current?.querySelector('[data-image-id]') !== null;
    setIsEmpty(!text && !hasPills);
  }, [getEditorText]);

  const insertTextAtCursor = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    const currentText = editor.innerText || '';
    console.log('═══════════════════════════════════════════');
    console.log('[InputBar] insertTextAtCursor called');
    console.log('[InputBar] Text to insert length:', text.length);
    console.log('[InputBar] Current editor content:', `"${currentText}"`);
    console.log('[InputBar] Current editor length:', currentText.length);

    const selection = window.getSelection();
    if (!selection) {
      console.log('[InputBar] ERROR: No selection available');
      return;
    }

    let range: Range;
    let method = '';

    // Try to restore saved selection first
    if (savedSelectionRef.current && editor.contains(savedSelectionRef.current.start)) {
      method = 'restored-saved';
      range = document.createRange();
      try {
        range.setStart(savedSelectionRef.current.start, savedSelectionRef.current.offset);
        range.collapse(true);
        console.log('[InputBar] Using SAVED cursor position');
        console.log('[InputBar]   - Saved offset:', savedSelectionRef.current.offset);
        console.log('[InputBar]   - Saved text:', savedSelectionRef.current.start.textContent?.substring(0, 30));
      } catch (err) {
        method = 'restored-failed-fallback';
        console.log('[InputBar] ERROR: Restore failed, using end', err);
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false); // End of editor
      }
    } else if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
      method = 'existing-selection';
      range = selection.getRangeAt(0);
      console.log('[InputBar] Using EXISTING selection');
      console.log('[InputBar]   - Current offset:', range.startOffset);
      console.log('[InputBar]   - Current text:', range.startContainer.textContent?.substring(0, 30));
    } else {
      method = 'default-end';
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      console.log('[InputBar] WARNING: No valid selection, using END');
    }

    console.log('[InputBar] Insert method:', method);
    console.log('[InputBar] Has saved position:', !!savedSelectionRef.current);

    // Delete any selected content and insert text
    console.log('[InputBar] Deleting selection and inserting text...');
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    console.log('[InputBar] Text node inserted');

    // Move cursor to end of inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    range.collapse(true);
    console.log('[InputBar] Cursor moved to after inserted text');

    // Update selection
    selection.removeAllRanges();
    selection.addRange(range);
    console.log('[InputBar] Selection updated');

    // Save the new position
    const newOffset = range.startOffset;
    savedSelectionRef.current = { start: range.startContainer, offset: newOffset };
    console.log('[InputBar] NEW position saved');
    console.log('[InputBar]   - New offset:', newOffset);
    console.log('[InputBar]   - New position text:', range.startContainer.textContent?.substring(0, 30));

    // Trigger input event
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    const finalText = editor.innerText || '';
    console.log('[InputBar] Final editor content:', `"${finalText}"`);
    console.log('[InputBar] Final content length:', finalText.length);
    console.log('═══════════════════════════════════════════');
  }, []);

  const insertImageTag = useCallback((index: number, id: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    console.log('[InputBar] insertImageTag called, index:', index, 'id:', id);

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
    if (!selection) {
      console.log('[InputBar] ERROR: No selection for image insert');
      return;
    }

    console.log('[InputBar] ===== CHECKING SAVED POSITION =====');
    console.log('[InputBar] savedSelectionRef.current exists?', !!savedSelectionRef.current);
    if (savedSelectionRef.current) {
      console.log('[InputBar] saved node in editor?', editor.contains(savedSelectionRef.current.start));
      console.log('[InputBar] saved node text:', savedSelectionRef.current.start.textContent?.substring(0, 50));
      console.log('[InputBar] saved offset:', savedSelectionRef.current.offset);
    }
    console.log('[InputBar] ======================================');

    let range: Range;
    let method = '';

    // Try to restore saved selection first (same as insertTextAtCursor)
    if (savedSelectionRef.current && editor.contains(savedSelectionRef.current.start)) {
      method = 'restored-saved';
      range = document.createRange();
      try {
        console.log('[InputBar] BEFORE setStart - saved node type:', savedSelectionRef.current.start.nodeType);
        console.log('[InputBar] BEFORE setStart - saved node text:', savedSelectionRef.current.start.textContent?.substring(0, 50));
        console.log('[InputBar] BEFORE setStart - saved offset:', savedSelectionRef.current.offset);
        console.log('[InputBar] BEFORE setStart - editor full text:', editor.innerText);

        range.setStart(savedSelectionRef.current.start, savedSelectionRef.current.offset);
        range.collapse(true);

        console.log('[InputBar] AFTER setStart - range container:', range.startContainer.textContent?.substring(0, 50));
        console.log('[InputBar] AFTER setStart - range offset:', range.startOffset);
        console.log('[InputBar] Image insert using SAVED position');
      } catch (err) {
        method = 'restored-failed-fallback';
        console.log('[InputBar] ERROR: Restore failed for image, using end', err);
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
    } else if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
      method = 'existing-selection';
      range = selection.getRangeAt(0);
      console.log('[InputBar] Image insert using EXISTING selection');
    } else {
      method = 'default-end';
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      console.log('[InputBar] WARNING: No valid selection for image, using END');
    }

    console.log('[InputBar] Image insert method:', method);

    // Insert pill
    range.deleteContents();
    range.insertNode(pill);
    range.setStartAfter(pill);
    range.setEndAfter(pill);

    // Add space after pill
    const space = document.createTextNode(' ');
    range.insertNode(space);

    // CRITICAL: Set range to point to the END of the space text node
    // This ensures BlockCursor can correctly calculate position
    range.setStart(space, space.length);
    range.setEnd(space, space.length);
    range.collapse(true);

    console.log('[InputBar] Range set to end of space node, offset:', space.length, 'text:', space.textContent);

    // Update selection first
    selection.removeAllRanges();
    selection.addRange(range);

    // Save the new position - pointing to the space text node
    savedSelectionRef.current = { start: space, offset: space.length };
    console.log('[InputBar] Image inserted, NEW position saved to space text node, offset:', space.length);

    // Focus after setting selection
    editor.focus();

    // Use requestAnimationFrame to ensure selection is stable before triggering input
    requestAnimationFrame(() => {
      // Verify selection is still correct
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const currentRange = sel.getRangeAt(0);
        console.log('[InputBar] After RAF - range offset:', currentRange.startOffset);
        console.log('[InputBar] After RAF - range container:', currentRange.startContainer.textContent?.substring(0, 50));
      }

      // Trigger input event to update BlockCursor
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[InputBar] Input event dispatched to update cursor');
    });
  }, []);

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

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const observer = new MutationObserver(() => {
      const currentPills = editor.querySelectorAll('[data-image-id]');
      const currentIds = new Set(Array.from(currentPills).map(p => p.getAttribute('data-image-id')));
      
      setImageAttachments((prev) => prev.filter((img) => currentIds.has(img.id)));
      checkEmpty();
    });

    observer.observe(editor, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [checkEmpty]);

  const handleSubmit = useCallback(() => {
    const text = getEditorText().trim();
    if (!text && imageAttachments.length === 0) return;
    if (isProcessing) return;

    onSend(text, imageAttachments.length > 0 ? imageAttachments : undefined);
    if (editorRef.current) {
      editorRef.current.innerHTML = '';
    }
    setImageAttachments([]);
    setIsEmpty(true);
  }, [getEditorText, imageAttachments, isProcessing, onSend]);

  const isRunning = session.status === 'running' || session.status === 'initializing';

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isRunning) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit, isRunning]);

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
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const tools: CLITool[] = ['claude', 'codex'];
      const currentIndex = tools.indexOf(selectedTool);
      const nextIndex = (currentIndex + 1) % tools.length;
      onToolChange(tools[nextIndex]);
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    document.addEventListener('keydown', handleTabKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      document.removeEventListener('keydown', handleTabKey, { capture: true });
    };
  }, [isRunning, escPending, onCancel, selectedTool, onToolChange]);

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

      // Handle Ctrl+V / Cmd+V specially (check clipboard for images)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        console.log('[InputBar] Global Ctrl+V detected, activeElement:', document.activeElement?.tagName);
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;

        console.log('[InputBar] Focusing editor for paste');
        editor.focus();
        setTimeout(async () => {
          console.log('[InputBar] setTimeout callback executing, activeElement:', document.activeElement?.tagName);
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
              console.log('[InputBar] Pasting text from clipboard, length:', text.length);
              insertTextAtCursor(text);
            } else {
              console.log('[InputBar] hasText:', hasText, 'hasImage:', hasImage);
            }
          } catch (err) {
            console.log('[InputBar] Clipboard read failed, trying readText:', err);
            try {
              const text = await navigator.clipboard.readText();
              console.log('[InputBar] Fallback readText success, length:', text.length);
              insertTextAtCursor(text);
            } catch {
              console.log('[InputBar] Fallback readText also failed');
            }
          }
        }, 0);
        return;
      }

      // Handle Delete/Backspace specially
      if (e.key === 'Backspace' || e.key === 'Delete') {
        console.log('[InputBar] Global', e.key, 'detected, activeElement:', document.activeElement?.tagName);
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;

        console.log('[InputBar] Focusing editor for delete');
        editor.focus();
        setTimeout(() => {
          console.log('[InputBar] Delete setTimeout callback executing');
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) {
            console.log('[InputBar] No selection for delete');
            return;
          }

          const range = selection.getRangeAt(0);
          if (!editor.contains(range.startContainer)) {
            console.log('[InputBar] Range not in editor');
            return;
          }

          console.log('[InputBar] Delete operation, collapsed:', range.collapsed, 'offset:', range.startOffset);

          if (!range.collapsed) {
            console.log('[InputBar] Deleting selected content');
            range.deleteContents();
          } else if (e.key === 'Backspace') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startOffset > 0 && startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              console.log('[InputBar] Backspace deleting at offset', startOffset - 1);
              textNode.deleteData(startOffset - 1, 1);
              range.setStart(textNode, startOffset - 1);
              range.collapse(true);
            } else {
              console.log('[InputBar] Backspace at offset 0, cannot delete');
            }
          } else if (e.key === 'Delete') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              if (startOffset < textNode.length) {
                console.log('[InputBar] Delete deleting at offset', startOffset);
                textNode.deleteData(startOffset, 1);
              } else {
                console.log('[InputBar] Delete at end of text, cannot delete');
              }
            }
          }

          selection.removeAllRanges();
          selection.addRange(range);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('[InputBar] Delete operation complete');
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
      console.log('[InputBar] Global key press detected:', e.key);
      e.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;

      console.log('[InputBar] Focusing editor for key press');
      editor.focus();
      setTimeout(() => {
        console.log('[InputBar] Inserting key at saved position:', e.key);
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

      console.log('[InputBar] Global paste event detected (backup handler)');
      e.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;

      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      console.log('[InputBar] Focusing editor for backup paste');
      editor.focus();
      setTimeout(async () => {
        console.log('[InputBar] Backup paste setTimeout executing');
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

    document.addEventListener('keydown', handleGlobalKeyPress);
    document.addEventListener('paste', handleGlobalPasteCapture, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyPress);
      document.removeEventListener('paste', handleGlobalPasteCapture, { capture: true });
    };
  }, [addImageAttachment, insertTextAtCursor]);

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
                  onInput={checkEmpty}
                  onPaste={handleEditorPaste}
                  onFocus={() => {
                    console.log('[InputBar] Focus gained');
                    setIsFocused(true);
                  }}
                  onBlur={() => {
                    console.log('[InputBar] Focus lost (blur)');
                    setIsFocused(false);
                    // Save cursor position on blur
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                      const range = selection.getRangeAt(0);
                      if (editorRef.current?.contains(range.startContainer)) {
                        console.log('[InputBar] Saving position - node type:', range.startContainer.nodeType);
                        console.log('[InputBar] Saving position - node name:', range.startContainer.nodeName);
                        console.log('[InputBar] Saving position - node text:', range.startContainer.textContent?.substring(0, 50));
                        console.log('[InputBar] Saving position - offset:', range.startOffset);
                        console.log('[InputBar] Saving position - parent:', range.startContainer.parentNode?.nodeName);

                        savedSelectionRef.current = {
                          start: range.startContainer,
                          offset: range.startOffset,
                        };
                        console.log('[InputBar] Saved selection on blur, offset:', range.startOffset, 'text:', range.startContainer.textContent?.substring(0, 20));
                      } else {
                        console.log('[InputBar] Selection not in editor, not saving');
                      }
                    } else {
                      console.log('[InputBar] No selection on blur');
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
            <span style={{ color: 'var(--st-text)' }}>
              tab{' '}
              <span style={{ color: 'var(--st-text-faint)' }}>switch agent</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

InputBar.displayName = 'InputBar';

export default InputBar;
