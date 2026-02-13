/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Search,
  ListTodo,
  Edit3,
  FileInput,
  Globe,
  Wrench,
  CheckCircle2,
  XCircle,
  Clock,
  FolderSearch,
  ArrowRight,
  Trash2
} from 'lucide-react';
import { ClaudeIcon, CodexIcon, GeminiIcon, KimiIcon } from '../../icons/ProviderIcons';
import './ToolCallMessage.css';
import { InlineDiffViewer } from './InlineDiffViewer';

// Module-level hook for tool collapse - will be provided by TimelineView
let useToolCollapseHook: (() => { collapseAllTrigger: number } | null) | null = null;

export const setToolCollapseHook = (hook: () => { collapseAllTrigger: number } | null) => {
  useToolCollapseHook = hook;
};

export interface ToolCallMessageProps {
  toolName: string;
  toolInput?: string; // JSON string
  toolResult?: string;
  isError?: boolean;
  timestamp: string;
  exitCode?: number;
  sessionId?: string;
  worktreePath?: string;
  toolCallSeq?: number; // Sequence number for generating unique diffId
}

const parseToolInput = (toolInput?: string | Record<string, unknown>) => {
  if (!toolInput) return null;
  if (typeof toolInput !== 'string') return toolInput;
  try {
    return JSON.parse(toolInput) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const getToolIcon = (toolName: string, toolInput?: string | Record<string, unknown>) => {
  const normalized = toolName.toLowerCase();
  switch (normalized) {
    case 'read': return FileText;
    case 'bash':
    case 'commandexecution': {
      const input = parseToolInput(toolInput);

      // Check if this is a claude/codex/gemini/kimi command - use their provider icons
      const command = typeof input?.command === 'string' ? input.command.trim() : '';
      const firstWord = command.split(/\s+/)[0]?.toLowerCase() || '';
      if (firstWord === 'claude') {
        return ClaudeIcon;
      }
      if (firstWord === 'codex') {
        return CodexIcon;
      }
      if (firstWord === 'gemini') {
        return GeminiIcon;
      }
      if (firstWord === 'kimi') {
        return KimiIcon;
      }

      const actions = Array.isArray(input?.commandActions) ? input.commandActions as Array<Record<string, unknown>> : [];
      const actionTypes = new Set(
        actions
          .map((action) => typeof action.type === 'string' ? action.type.toLowerCase() : '')
          .filter(Boolean)
      );
      if (actionTypes.size > 0) {
        if (actionTypes.has('delete') || actionTypes.has('remove') || actionTypes.has('rm') || actionTypes.has('file_delete')) return Trash2;
        if (actionTypes.has('file_edit') || actionTypes.has('edit') || actionTypes.has('apply_patch') || actionTypes.has('patch') || actionTypes.has('update') || actionTypes.has('file_change')) return Edit3;
        if (actionTypes.has('file_write') || actionTypes.has('write') || actionTypes.has('create') || actionTypes.has('file_create') || actionTypes.has('add')) return FileInput;
        if (actionTypes.has('file_read') || actionTypes.has('read')) return FileText;
        if (actionTypes.has('search') || actionTypes.has('grep') || actionTypes.has('find') || actionTypes.has('glob')) return Search;
      }

      // For other commands, only check the first word to avoid false matches
      if (firstWord === 'rm' || firstWord === 'rmdir') return Trash2;

      return Terminal;
    }
    case 'grep': return Search;
    case 'glob': return FolderSearch;
    case 'todowrite': return ListTodo;
    case 'edit':
    case 'apply_patch':
    case 'applypatch':
    case 'filechange': return Edit3;
    case 'write': return FileInput;
    case 'webfetch':
    case 'websearch': return Globe;
    case 'exitplanmode': return ArrowRight;
    default: return Wrench;
  }
};

export function ToolCallMessage({
  toolName,
  toolInput,
  toolResult,
  isError,
  timestamp,
  exitCode,
  sessionId,
  worktreePath,
  toolCallSeq
}: ToolCallMessageProps) {
  const [expanded, setExpanded] = useState(false);

  // Listen to global tool collapse trigger (only react to triggers after mount)
  const toolCollapseContext = useToolCollapseHook?.();
  const initialToolCollapseTrigger = useRef(toolCollapseContext?.collapseAllTrigger ?? 0);
  useEffect(() => {
    if (toolCollapseContext && toolCollapseContext.collapseAllTrigger > initialToolCollapseTrigger.current) {
      setExpanded(false);
    }
  }, [toolCollapseContext?.collapseAllTrigger]);

  // Load params expanded state from localStorage
  const paramsStorageKey = `tool-params-expanded-${sessionId}-${toolCallSeq}`;
  const [paramsExpanded, setParamsExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(paramsStorageKey);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  // Save params expanded state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(paramsStorageKey, String(paramsExpanded));
    } catch {
      // Ignore localStorage errors
    }
  }, [paramsExpanded, paramsStorageKey]);

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  const parseInput = (): Record<string, unknown> | null => {
    if (!toolInput) return null;
    try {
      return typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    } catch {
      return null;
    }
  };

  // Render concise input summary (always visible)
  const renderInputSummary = () => {
    const input = parseInput();
    if (!input) return null;

    // Read tool: show file path with line range
    if (toolName === 'Read' && input.file_path) {
      const offset = input.offset as string | number | undefined;
      const limit = input.limit as string | number | undefined;
      return (
        <div className="tool-input-summary">
          <span className="summary-label">Read file:</span>{' '}
          <code className="summary-value">{String(input.file_path)}</code>
          {offset && (
            <span className="summary-meta">
              {' '}(Lines {String(offset)}-{String(Number(offset) + (Number(limit) || 2000))})
            </span>
          )}
        </div>
      );
    }

    // Bash tool: show command
    if (toolName === 'Bash' && input.command) {
      return (
        <div className="tool-input-summary">
          <span className="summary-label">$</span>{' '}
          <code className="summary-value">{String(input.command)}</code>
        </div>
      );
    }

    // Grep tool: show pattern
    if (toolName === 'Grep' && input.pattern) {
      const path = input.path as string | undefined;
      return (
        <div className="tool-input-summary">
          <span className="summary-label">Search:</span>{' '}
          <code className="summary-value">"{String(input.pattern)}"</code>
          {path && <span className="summary-meta"> in {String(path)}</span>}
        </div>
      );
    }

    // TodoWrite tool: show task summary
    if (toolName === 'TodoWrite' && input.todos) {
      const todos = input.todos as Array<{ status: string; content: string; activeForm?: string }>;
      const completedCount = todos.filter(t => t.status === 'completed').length;
      const pendingCount = todos.filter(t => t.status === 'pending').length;
      return (
        <div className="tool-input-summary">
          <span className="summary-label">Tasks:</span>{' '}
          <span className="summary-value">
            {completedCount}/{todos.length} completed
            {pendingCount > 0 && `, ${pendingCount} pending`}
          </span>
        </div>
      );
    }

    // Edit tool: show file path
    if (toolName === 'Edit') {
      const filePath = input.file_path as string | undefined;
      return (
        <div className="tool-input-summary">
          <span className="summary-label">Edit file:</span>{' '}
          <code className="summary-value">{String(filePath || 'unknown')}</code>
        </div>
      );
    }

    // Write tool: show file path
    if (toolName === 'Write' && input.file_path) {
      return (
        <div className="tool-input-summary">
          <span className="summary-label">Write file:</span>{' '}
          <code className="summary-value">{String(input.file_path)}</code>
        </div>
      );
    }

    // Default: show first key-value pair
    const firstKey = Object.keys(input)[0];
    if (firstKey) {
      return (
        <div className="tool-input-summary">
          <span className="summary-label">{firstKey}:</span>{' '}
          <code className="summary-value">{String(input[firstKey])}</code>
        </div>
      );
    }

    return null;
  };

  // Render detailed parameters (collapsible)
  const renderDetailedParams = () => {
    const input = parseInput();
    if (!input) return null;

    // For Edit tool with diff, show inline diff viewer
    if (toolName === 'Edit') {
      const oldString = input.old_string as string | undefined;
      const newString = input.new_string as string | undefined;
      const filePath = input.file_path as string | undefined;

      if (oldString && newString) {
        return (
          <InlineDiffViewer
            oldString={oldString}
            newString={newString}
            filePath={filePath}
            className="tool-diff-viewer"
            sessionId={sessionId}
            worktreePath={worktreePath}
            diffId={`tool-${toolCallSeq || 0}-${filePath || 'unknown'}`}
          />
        );
      }
    }

    // For TodoWrite, show task details
    if (toolName === 'TodoWrite' && input.todos) {
      const todos = input.todos as Array<{ status: string; content: string; activeForm?: string }>;
      const inProgressTasks = todos.filter(t => t.status === 'in_progress');

      if (inProgressTasks.length > 0) {
        return (
          <div className="todo-in-progress" style={{ marginTop: '8px', paddingLeft: '12px', borderLeft: '2px solid var(--st-accent)' }}>
            {inProgressTasks.map((task, idx) => (
              <div key={idx} style={{ fontSize: '0.9em', color: 'var(--st-text-secondary)', marginBottom: '4px' }}>
                <ArrowRight className="todo-progress-icon" size={12} />
                {task.activeForm || task.content}
              </div>
            ))}
          </div>
        );
      }
    }

    // Default: show all parameters as JSON
    return (
      <pre className="tool-params-json">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  };

  const getStatusIcon = () => {
    if (!toolResult) return Clock; // Pending
    if (isError) return XCircle; // Error
    return CheckCircle2; // Success
  };

  const getStatusClass = () => {
    if (!toolResult) return 'pending';
    if (isError) return 'error';
    return 'success';
  };

  const ToolIcon = getToolIcon(toolName, toolInput);
  const StatusIcon = getStatusIcon();

  return (
    <div className={`tool-call-message ${getStatusClass()}`}>
      <div
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <ToolIcon className="tool-icon" size={14} style={{ flexShrink: 0, marginRight: 8 }} />
        <span className="tool-name">{toolName}</span>
        <StatusIcon className={`tool-status ${getStatusClass()}`} size={12} style={{ flexShrink: 0, marginLeft: 8 }} />
        <span className="tool-timestamp">{formatTime(timestamp)}</span>
        {expanded ? (
          <ChevronDown className="expand-icon" size={12} />
        ) : (
          <ChevronRight className="expand-icon" size={12} />
        )}
      </div>

      {/* Input summary - always visible when expanded */}
      {expanded && toolInput && renderInputSummary()}

      {expanded && (
        <div className="tool-call-details">
          {/* Collapsible detailed parameters */}
          {toolInput && parseInput() && (
            <div className="tool-section">
              <div
                className="params-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setParamsExpanded(!paramsExpanded);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setParamsExpanded(!paramsExpanded);
                  }
                }}
              >
                {paramsExpanded ? (
                  <ChevronDown size={12} style={{ marginRight: 4 }} />
                ) : (
                  <ChevronRight size={12} style={{ marginRight: 4 }} />
                )}
                <span className="params-toggle-label">Parameter details</span>
              </div>
              {paramsExpanded && (
                <div className="params-content">
                  {renderDetailedParams()}
                </div>
              )}
            </div>
          )}

          {toolResult && (
            <div className="tool-section">
              <div className="section-label">Result:</div>
              <pre className={`tool-result ${isError ? 'error-output' : 'normal-output'}`}>
                {toolResult}
              </pre>
              {exitCode !== undefined && exitCode !== 0 && (
                <div className="exit-code-badge">
                  Exit code: {exitCode}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
