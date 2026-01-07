import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Send, ChevronDown, Sparkles, Code2, Loader2 } from 'lucide-react';
import type { InputBarProps, CLITool } from './types';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { TimelineEvent } from '../../types/timeline';

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

const subtitlePartsForTool = (tool: CLITool, args: { model?: string; level?: string; version?: string }): string[] => {
  if (tool === 'claude') {
    return [args.model, formatCliVersion(args.version)].filter(Boolean) as string[];
  }
  return [args.model, args.level, formatCliVersion(args.version)].filter(Boolean) as string[];
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
  const selectedSettings = settings[selected];
  const availabilityForSelected = availability?.[selected];
  const isSelectedAvailable = availabilityLoading ? true : (availabilityForSelected?.available ?? true);
  const selectedSubtitleParts = subtitlePartsForTool(selected, {
    model: selectedSettings.model,
    level: selectedSettings.level,
    version: availabilityForSelected?.version,
  });
  const selectedSubtitle = selectedSubtitleParts.join(' • ') || (settingsLoading ? 'Detecting…' : '');
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
        {selectedSubtitle && (
          <span className="truncate max-w-[320px] st-text-faint" title={selectedSubtitle}>
            {selectedSubtitle}
          </span>
        )}
        {isProbing && <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--st-text-faint)' }} />}
        {!availabilityLoading && !isSelectedAvailable && <span className="text-[10px] uppercase tracking-wider st-text-faint">Unavailable</span>}
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--st-text-faint)' }} />
      </button>

      {/* Dropdown with animation */}
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
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => {
              const toolAvailability = availability?.[tool.id];
              if (!availabilityLoading && toolAvailability && !toolAvailability.available) {
                return;
              }
              onChange(tool.id);
              setIsOpen(false);
            }}
            disabled={!availabilityLoading && !!availability?.[tool.id] && !availability[tool.id].available}
            className={`relative w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors st-focus-ring ${
              selected === tool.id ? 'st-selected' : 'st-hoverable'
            } ${!availabilityLoading && !!availability?.[tool.id] && !availability[tool.id].available ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={!availabilityLoading && !availability?.[tool.id]?.available ? (availability?.[tool.id]?.error || `${tool.label} unavailable`) : undefined}
          >
            {tool.icon}
            <div className="flex flex-col items-start min-w-0">
              <div className="flex items-center gap-2">
                <span style={{ color: 'var(--st-text)' }}>{tool.label}</span>
                {isProbing && <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--st-text-faint)' }} />}
                {!availabilityLoading && availability?.[tool.id]?.available === false && (
                  <span className="text-[10px] uppercase tracking-wider st-text-faint">Unavailable</span>
                )}
              </div>
              {(settings[tool.id]?.model || settings[tool.id]?.level || availability?.[tool.id]?.version || settingsLoading) && (
                <span
                  className="text-[11px] truncate max-w-[260px] st-text-faint"
                  title={subtitlePartsForTool(tool.id, {
                    model: settings[tool.id]?.model,
                    level: settings[tool.id]?.level,
                    version: availability?.[tool.id]?.version,
                  }).join(' • ') || (settingsLoading ? 'Detecting…' : '')}
                >
                  {subtitlePartsForTool(tool.id, {
                    model: settings[tool.id]?.model,
                    level: settings[tool.id]?.level,
                    version: availability?.[tool.id]?.version,
                  }).join(' • ') || (settingsLoading ? 'Detecting…' : '')}
                </span>
              )}
            </div>
          </button>
        ))}
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
  const [input, setInput] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [aiToolsStatus, setAiToolsStatus] = useState<AiToolsStatus | null>(null);
  const [aiToolsLoading, setAiToolsLoading] = useState(false);
  const [toolSettingsProbeLoading, setToolSettingsProbeLoading] = useState(true);
  const [toolSettingsTimelineLoading, setToolSettingsTimelineLoading] = useState(true);
  const [toolSettings, setToolSettings] = useState<Record<CLITool, ToolDisplaySettings>>({
    claude: {},
    codex: {}
  });
  const [escPending, setEscPending] = useState(false);
  const escTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSubmit = useCallback(() => {
    if (!input.trim()) return;
    if (isProcessing) return;

    onSend(input.trim());
    setInput('');
  }, [input, isProcessing, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

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
          }, 3000);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isRunning, escPending, onCancel]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const next = Math.max(46, Math.min(textareaRef.current.scrollHeight, 140));
      textareaRef.current.style.height = `${next}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!focusRequestId) return;
    textareaRef.current?.focus();
  }, [focusRequestId]);

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
      // ignore transient probe errors
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
      // ignore transient probe errors
    } finally {
      setToolSettingsTimelineLoading(false);
    }
  }, [session.id, applyTimelineEventToSettings]);

  useEffect(() => {
    // Probe once per workspace to populate model/level even before the first run.
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

  const selectedAvailable = aiToolsLoading ? true : (aiToolsStatus?.[selectedTool]?.available ?? true);
  const canSubmit = input.trim() && !isProcessing && selectedAvailable;
  const toolSettingsLoading = toolSettingsProbeLoading || toolSettingsTimelineLoading;

  const handleOpenSelector = useCallback(() => {
    void loadAvailability(true);
    void loadToolSettingsFromProbe();
    void loadToolSettingsFromTimeline();
  }, [loadAvailability, loadToolSettingsFromProbe, loadToolSettingsFromTimeline]);

  return (
    <div className="flex-shrink-0 border-t st-hairline st-surface px-3 py-2">
      <div
        className={`rounded-lg transition-all duration-150 ${isRunning ? 'opacity-60' : ''}`}
        style={{
          border: `1px solid ${isRunning ? 'var(--st-border)' : isFocused ? 'var(--st-accent)' : 'var(--st-border)'}`,
          backgroundColor: 'var(--st-editor)',
          boxShadow: isFocused && !isRunning
            ? '0 0 0 3px color-mix(in srgb, var(--st-accent) 20%, transparent)'
            : 'none',
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={isRunning ? 'Waiting for task to complete...' : placeholder}
          disabled={isRunning}
          className={`w-full px-3 pt-3 pb-2 bg-transparent text-[13px] focus:outline-none min-h-[46px] max-h-[160px] placeholder:text-[color:var(--st-text-faint)] placeholder:opacity-70 ${isRunning ? 'cursor-not-allowed' : ''}`}
          style={{
            color: 'var(--st-text)',
            caretColor: 'var(--st-accent)',
            lineHeight: '1.5',
            resize: 'none',
          }}
          rows={1}
        />

        {/* Bottom toolbar */}
        <div
          className="flex items-center justify-between px-2 py-1.5"
          style={{
            borderTop: '1px solid color-mix(in srgb, var(--st-border) 50%, transparent)',
          }}
        >
          <CLISelector
            selected={selectedTool}
            onChange={onToolChange}
            disabled={isProcessing}
            availability={aiToolsStatus}
            availabilityLoading={aiToolsLoading}
            settingsLoading={toolSettingsLoading}
            settings={toolSettings}
            onOpen={handleOpenSelector}
          />

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`p-1.5 rounded transition-all duration-150 st-focus-ring ${
                canSubmit ? 'st-hoverable' : 'cursor-not-allowed opacity-40'
              }`}
              style={{
                color: canSubmit ? 'var(--st-accent)' : 'var(--st-text-faint)',
              }}
              title={!selectedAvailable ? `${selectedTool} unavailable` : 'Send (Enter)'}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

InputBar.displayName = 'InputBar';

export default InputBar;
