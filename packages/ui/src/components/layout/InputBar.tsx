import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronDown, Sparkles, Code2, Loader2, Star } from 'lucide-react';
import type { InputBarProps, CLITool, ImageAttachment, ExecutionMode } from './types';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { TimelineEvent } from '../../types/timeline';
import { clearSessionDraft, getSessionDraft, setSessionDraft } from './sessionDraftCache';
import { InputBarEditor, type InputBarEditorHandle } from './InputBarEditor';

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
  gemini: ToolAvailability;
};

type ToolDisplaySettings = {
  model?: string;
  level?: string;
};

type AiToolSettingsResponse = {
  claude?: { model?: string };
  codex?: { model?: string; reasoningEffort?: string; sandbox?: string; askForApproval?: string };
  gemini?: { model?: string };
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
    { id: 'gemini', label: 'Gemini', icon: <Star className="w-3.5 h-3.5" /> },
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
  onToggleAgent,
  onToggleExecutionMode,
  placeholder,
  focusRequestId,
  initialExecutionMode,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [executionMode, setExecutionModeInternal] = useState<ExecutionMode>(initialExecutionMode || 'execute');
  const editorRef = useRef<InputBarEditorHandle>(null);
  const [aiToolsStatus, setAiToolsStatus] = useState<AiToolsStatus | null>(null);
  const [, setAiToolsLoading] = useState(false);
  const [, setToolSettingsProbeLoading] = useState(true);
  const [, setToolSettingsTimelineLoading] = useState(true);
  const [toolSettings, setToolSettings] = useState<Record<CLITool, ToolDisplaySettings>>({
    claude: {},
    codex: {},
    gemini: {}
  });
  const [escPending, setEscPending] = useState(false);
  const escTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const imageIdCounter = useRef(0);
  const imageIndexCounter = useRef(0);  // Track next image index for [img1], [img2], etc.
  const inputHistoryRef = useRef<string[]>([]);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const restoringDraftRef = useRef(false);
  const draftSaveRafRef = useRef<number | null>(null);

  // Update local state when initialExecutionMode changes (e.g., session switch)
  useEffect(() => {
    if (initialExecutionMode !== undefined) {
      setExecutionModeInternal(initialExecutionMode);
    }
  }, [initialExecutionMode]);

  useEffect(() => {
    const loadHistoryFromTimeline = async () => {
      if (!_panelId) {
        inputHistoryRef.current = [];
        return;
      }

      try {
        const res = await API.sessions.getTimeline(session.id);
        if (res.success && res.data) {
          const history = res.data
            .filter((event) => event.kind === 'chat.user' && event.panel_id === _panelId)
            .map((event) => typeof event.command === 'string' ? event.command : '')
            .filter((text) => text.trim().length > 0);

          // Deduplicate and limit to last 100
          const deduped = [...new Set(history)].reverse();
          inputHistoryRef.current = deduped.slice(-100);
        }
      } catch (error) {
        console.error('[InputBar] Failed to load history from timeline:', error);
      }
    };

    loadHistoryFromTimeline();
  }, [session.id, _panelId]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  const saveDraftNow = useCallback((sessionId: string) => {
    if (restoringDraftRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;

    const json = editor.getJSON();
    const images = imageAttachmentsRef.current;
    setSessionDraft(sessionId, { json, images });
  }, []);

  const scheduleDraftSave = useCallback((sessionId: string) => {
    if (restoringDraftRef.current) return;
    if (draftSaveRafRef.current !== null) return;
    draftSaveRafRef.current = requestAnimationFrame(() => {
      draftSaveRafRef.current = null;
      saveDraftNow(sessionId);
    });
  }, [saveDraftNow]);

  // Clear image attachments and reset the index counter
  const clearImageAttachments = useCallback(() => {
    setImageAttachments([]);
    imageIndexCounter.current = 0;
  }, []);

  const addImageAttachment = useCallback((file: File): Promise<void> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const id = `img-${Date.now()}-${imageIdCounter.current++}`;
        const imageIndex = ++imageIndexCounter.current;  // Increment and use counter for sequential numbering

        const newAttachment: ImageAttachment = {
          id,
          filename: file.name || 'image.png',
          mime: file.type || 'image/png',
          dataUrl,
        };

        setImageAttachments((prev) => [...prev, newAttachment]);

        // Insert image pill into editor
        if (editorRef.current) {
          editorRef.current.insertImagePill(newAttachment, imageIndex);
        }

        resolve();
      };
      reader.readAsDataURL(file);
    });
  }, [imageAttachments.length]);

  // Restore unsent draft when switching sessions
  useEffect(() => {
    const sessionId = session.id;
    const editor = editorRef.current;
    if (!editor) return;

    restoringDraftRef.current = true;

    try {
      const draft = getSessionDraft(sessionId);
      if (draft) {
        // Try new JSON format first
        if (draft.json) {
          // Validate JSON has required structure for Tiptap
          if (typeof draft.json === 'object' && draft.json.type === 'doc') {
            editor.setContent(draft.json);
            setImageAttachments(draft.images);
          } else {
            console.warn('[InputBar] Invalid Tiptap JSON format, clearing');
            clearSessionDraft(sessionId);
            editor.clear();
            clearImageAttachments();
          }
        }
        // Fallback to legacy HTML format (stored as JSON string)
        else if (draft.html) {
          try {
            const json = JSON.parse(draft.html);
            if (typeof json === 'object' && json.type === 'doc') {
              editor.setContent(json);
              setImageAttachments(draft.images);
            } else {
              // Invalid JSON structure, treat as plain HTML
              const tempDiv = document.createElement('div');
              tempDiv.innerHTML = draft.html;
              const text = tempDiv.innerText || tempDiv.textContent || '';
              editor.setContent(text);
              setImageAttachments(draft.images);
            }
          } catch {
            // If JSON parse fails, treat it as plain HTML (very old format)
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = draft.html;
            const text = tempDiv.innerText || tempDiv.textContent || '';
            editor.setContent(text);
            setImageAttachments(draft.images);
          }
        } else {
          editor.clear();
          clearImageAttachments();
        }
      } else {
        editor.clear();
        clearImageAttachments();
      }
    } catch (err) {
      console.error('[InputBar] Failed to restore draft:', err);
      // Delete the corrupted draft to prevent infinite loop
      clearSessionDraft(sessionId);
      editor.clear();
      clearImageAttachments();
    } finally {
      // Always set flag back to false in finally block to ensure it happens
      // AFTER all operations (including error handling) complete
      restoringDraftRef.current = false;
    }

    // Place caret at end
    requestAnimationFrame(() => editor.focus());

    // Save current session draft when switching away/unmounting
    return () => {
      if (draftSaveRafRef.current !== null) {
        cancelAnimationFrame(draftSaveRafRef.current);
        draftSaveRafRef.current = null;
      }
      saveDraftNow(sessionId);
    };
  }, [saveDraftNow, session.id]);

  const handleEditorUpdate = useCallback(() => {
    // Don't save drafts while restoring to prevent infinite loops
    if (restoringDraftRef.current) return;
    scheduleDraftSave(session.id);
  }, [scheduleDraftSave, session.id]);

  useEffect(() => {
    // Persist draft when image attachments change (but not during restoration)
    if (restoringDraftRef.current) return;
    scheduleDraftSave(session.id);
  }, [imageAttachments, scheduleDraftSave, session.id]);

  const handleSubmit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const text = editor.getText().trim();
    if (!text && imageAttachments.length === 0) return;
    if (isProcessing) return;

    if (text) {
      const hist = inputHistoryRef.current;
      if (hist.length === 0 || hist[hist.length - 1] !== text) {
        inputHistoryRef.current = [...hist, text].slice(-100);
      }
    }

    onSend(text, imageAttachments.length > 0 ? imageAttachments : undefined, executionMode === 'plan');
    clearSessionDraft(session.id);
    editor.clear();
    clearImageAttachments();
  }, [imageAttachments, isProcessing, onSend, executionMode, session.id, clearImageAttachments]);

  const handleFocusHintClick = useCallback(() => {
    editorRef.current?.focus();
  }, []);

  const isRunning = session.status === 'running' || session.status === 'initializing';

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

  // Focus on focusRequestId change
  useEffect(() => {
    if (focusRequestId !== undefined) {
      editorRef.current?.focus();
    }
  }, [focusRequestId]);

  // Auto-focus on initial mount - ensure input is focused when conversation panel opens
  useEffect(() => {
    // Small delay to ensure editor is fully initialized
    const timer = setTimeout(() => {
      editorRef.current?.focus();
    }, 1);
    return () => clearTimeout(timer);
  }, []);

  // Auto-focus: Global keyboard events that type into editor when not focused
  useEffect(() => {
    const focusEditor = () => {
      editorRef.current?.focus();
      return editorRef.current?.editor;
    };

    const handleGlobalKeyPress = (e: KeyboardEvent) => {
      const editor = editorRef.current?.editor;
      if (!editor || editor.view.hasFocus()) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // Cmd/Ctrl+A: Select all in editor
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const ed = focusEditor();
        if (ed) {
          ed.commands.selectAll();
        }
        return;
      }

      // Cmd/Ctrl+V: Paste into editor
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        focusEditor();
        // Allow native paste so the editor receives the clipboard event
        return;
      }

      // Backspace/Delete: Focus and delete
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const ed = focusEditor();
        if (ed) {
          if (e.key === 'Backspace') {
            ed.commands.deleteRange({ from: ed.state.selection.from - 1, to: ed.state.selection.from });
          } else {
            ed.commands.deleteRange({ from: ed.state.selection.from, to: ed.state.selection.from + 1 });
          }
        }
        return;
      }

      // Skip modifier keys and special keys
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const skipKeys = [
        'Escape', 'Tab', 'Enter',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
        'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'
      ];
      if (skipKeys.includes(e.key)) return;

      // Regular character: Focus and type
      e.preventDefault();
      const ed = focusEditor();
      if (ed) {
        ed.commands.insertContent(e.key);
      }
    };

    const handleGlobalPasteCapture = (e: ClipboardEvent) => {
      const editor = editorRef.current?.editor;
      if (!editor || editor.view.hasFocus()) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      e.preventDefault();
      focusEditor();
      // The editor's PasteImage extension will handle the paste
    };

    document.addEventListener('keydown', handleGlobalKeyPress, { capture: true });
    document.addEventListener('paste', handleGlobalPasteCapture, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyPress, { capture: true });
      document.removeEventListener('paste', handleGlobalPasteCapture, { capture: true });
    };
  }, []);

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
    if (event.tool !== 'claude' && event.tool !== 'codex' && event.tool !== 'gemini') return;
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
      } else if (event.tool === 'codex') {
        next.codex = {
          ...next.codex,
          model: cliModel ?? next.codex.model,
          level: cliReasoningEffort ?? next.codex.level,
        };
      } else {
        next.gemini = {
          ...next.gemini,
          model: cliModel ?? next.gemini.model,
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
        gemini: {
          model: typeof data.gemini?.model === 'string' ? data.gemini?.model : prev.gemini.model,
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
      let lastGemini: TimelineEvent | null = null;
      for (const e of events) {
        if (e.kind !== 'cli.command') continue;
        if (e.tool === 'claude') lastClaude = e;
        if (e.tool === 'codex') lastCodex = e;
        if (e.tool === 'gemini') lastGemini = e;
      }
      if (lastClaude) applyTimelineEventToSettings(lastClaude);
      if (lastCodex) applyTimelineEventToSettings(lastCodex);
      if (lastGemini) applyTimelineEventToSettings(lastGemini);
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

  const agentName = selectedTool === 'claude' ? 'Claude' : selectedTool === 'codex' ? 'Codex' : 'Gemini';
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
          style={{
            backgroundColor: isRunning
              ? 'var(--st-border-variant)'
              : isFocused
                ? 'var(--st-accent)'
                : 'var(--st-border-variant)'
          }}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="ml-2">
            <div
              className="px-3 py-2"
              style={{ backgroundColor: 'var(--st-editor)' }}
            >
              <div className="relative">
                <InputBarEditor
                  ref={editorRef}
                  placeholder={placeholder}
                  isRunning={isRunning}
                  onUpdate={handleEditorUpdate}
                  onSubmit={handleSubmit}
                  inputHistory={inputHistoryRef}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => {
                    setIsFocused(false);
                    saveDraftNow(session.id);
                  }}
                  onImagePaste={addImageAttachment}
                />
                {isRunning && (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="absolute right-2 top-2 px-2 py-1 text-[11px] rounded-md st-hoverable st-focus-ring"
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--st-danger) 18%, transparent)',
                      color: 'var(--st-danger)',
                    }}
                  >
                    Stop
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 mt-2 text-[12px] st-font-mono">
                <button
                  type="button"
                  onClick={onToggleAgent}
                  disabled={!onToggleAgent || isRunning}
                  className="text-[12px] st-font-mono rounded st-focus-ring"
                  style={{
                    color: 'var(--st-accent)',
                    opacity: !onToggleAgent || isRunning ? 0.5 : 1,
                  }}
                >
                  {agentName}
                </button>
                <button
                  type="button"
                  onClick={onToggleExecutionMode}
                  disabled={!onToggleExecutionMode || isRunning}
                  className="text-[12px] st-font-mono rounded st-focus-ring"
                  style={{
                    color: executionMode === 'plan' ? 'var(--st-warning, #f59e0b)' : 'var(--st-text-faint)',
                    opacity: !onToggleExecutionMode || isRunning ? 0.5 : 1,
                  }}
                >
                  {modeName}
                </button>
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

          <div
            className="flex items-center justify-between ml-2 mt-1 text-[11px] st-font-mono"
            data-testid="input-hints"
            onClick={handleFocusHintClick}
          >
            <div className="flex items-center gap-2">
              {isRunning && (
                <>
                  <KnightRiderSpinner color="var(--st-accent)" />
                  <span style={{ color: escPending ? 'var(--st-accent)' : 'var(--st-text)' }}>
                    press esc{' '}
                    <span style={{ color: escPending ? 'var(--st-accent)' : 'var(--st-text-faint)' }}>
                      {escPending ? 'again to stop' : 'to stop'}
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
