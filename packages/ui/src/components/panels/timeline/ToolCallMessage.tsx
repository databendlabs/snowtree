/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
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
import './ToolCallMessage.css';
import { InlineDiffViewer } from './InlineDiffViewer';

export interface ToolCallMessageProps {
  toolName: string;
  toolInput?: string; // JSON string
  toolResult?: string;
  isError?: boolean;
  timestamp: string;
  exitCode?: number;
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
    default: return Wrench;
  }
};

export function ToolCallMessage({
  toolName,
  toolInput,
  toolResult,
  isError,
  timestamp,
  exitCode
}: ToolCallMessageProps) {
  const [expanded, setExpanded] = useState(false);

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

  const renderToolInput = () => {
    const input = parseInput();
    if (!input) return null;

    // Special formatting for common tools
    if (toolName === 'Read' && input.file_path) {
      const offset = input.offset as string | number | undefined;
      const limit = input.limit as string | number | undefined;
      return (
        <div className="tool-params">
          <span className="param-label">File:</span>{' '}
          <code className="param-value">{String(input.file_path)}</code>
          {offset && (
            <span className="param-meta">
              {' '}(Lines {String(offset)}-
              {String(Number(offset) + (Number(limit) || 2000))})
            </span>
          )}
        </div>
      );
    }

    if (toolName === 'Bash' && input.command) {
      return (
        <div className="tool-params">
          <span className="param-label">$</span>{' '}
          <code className="param-value">{String(input.command)}</code>
        </div>
      );
    }

    if (toolName === 'Grep' && input.pattern) {
      const path = input.path as string | undefined;
      const glob = input.glob as string | undefined;
      return (
        <div className="tool-params">
          <div>
            <span className="param-label">Pattern:</span>{' '}
            <code className="param-value">"{String(input.pattern)}"</code>
          </div>
          {path && (
            <div>
              <span className="param-label">Path:</span>{' '}
              <code className="param-value">{String(path)}</code>
            </div>
          )}
          {glob && (
            <div>
              <span className="param-label">Glob:</span>{' '}
              <code className="param-value">{String(glob)}</code>
            </div>
          )}
        </div>
      );
    }

    if (toolName === 'TodoWrite' && input.todos) {
      const todos = input.todos as Array<{ status: string; content: string; activeForm?: string }>;
      const completedCount = todos.filter(t => t.status === 'completed').length;
      const inProgressTasks = todos.filter(t => t.status === 'in_progress');
      const pendingCount = todos.filter(t => t.status === 'pending').length;

      return (
        <div className="tool-params">
          <div className="param-header">
            <span className="param-label">Tasks:</span>{' '}
            <span className="param-value">
              {completedCount}/{todos.length} completed
              {pendingCount > 0 && `, ${pendingCount} pending`}
            </span>
          </div>
          {inProgressTasks.length > 0 && (
            <div className="todo-in-progress" style={{ marginTop: '8px', paddingLeft: '12px', borderLeft: '2px solid var(--st-accent)' }}>
              {inProgressTasks.map((task, idx) => (
                <div key={idx} style={{ fontSize: '0.9em', color: 'var(--st-text-secondary)', marginBottom: '4px' }}>
                  <ArrowRight className="todo-progress-icon" size={12} />
                  {task.activeForm || task.content}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (toolName === 'Edit') {
      const oldString = input.old_string as string | undefined;
      const newString = input.new_string as string | undefined;
      const filePath = input.file_path as string | undefined;

      // Show diff view if both old and new strings are available
      if (oldString && newString) {
        return (
          <div className="tool-params">
            <div className="param-header">
              <span className="param-label">File:</span>{' '}
              <code className="param-value">{String(filePath || 'unknown')}</code>
            </div>
            <InlineDiffViewer
              oldString={oldString}
              newString={newString}
              filePath={filePath}
              className="tool-diff-viewer"
            />
          </div>
        );
      }

      // Fallback: show old string only (for backwards compatibility)
      return (
        <div className="tool-params">
          <div>
            <span className="param-label">File:</span>{' '}
            <code className="param-value">{String(filePath || 'unknown')}</code>
          </div>
          {oldString && (
            <div className="param-detail">
              <span className="param-label">Old:</span>{' '}
              <code className="param-value-small">
                {String(oldString).substring(0, 100)}
                {String(oldString).length > 100 ? '...' : ''}
              </code>
            </div>
          )}
        </div>
      );
    }

    // Default: JSON display
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

      {expanded && (
        <div className="tool-call-details">
          {toolInput && (
            <div className="tool-section">
              <div className="section-label">Parameters:</div>
              {renderToolInput()}
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
