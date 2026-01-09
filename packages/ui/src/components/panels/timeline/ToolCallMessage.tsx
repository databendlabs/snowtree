import { useState } from 'react';
import './ToolCallMessage.css';

export interface ToolCallMessageProps {
  toolName: string;
  toolInput?: string; // JSON string
  toolResult?: string;
  isError?: boolean;
  timestamp: string;
  exitCode?: number;
}

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
          <span className="param-label">📄 File:</span>{' '}
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

    if (toolName === 'Edit') {
      const oldString = input.old_string as string | undefined;
      return (
        <div className="tool-params">
          <div>
            <span className="param-label">📝 File:</span>{' '}
            <code className="param-value">{String(input.file_path || 'unknown')}</code>
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
    if (!toolResult) return '⏳'; // Pending
    if (isError) return '✗'; // Error
    return '✓'; // Success
  };

  const getStatusClass = () => {
    if (!toolResult) return 'pending';
    if (isError) return 'error';
    return 'success';
  };

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
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{toolName}</span>
        <span className={`tool-status ${getStatusClass()}`} title={getStatusClass()}>
          {getStatusIcon()}
        </span>
        <span className="tool-timestamp">{formatTime(timestamp)}</span>
        <span className="expand-icon">{expanded ? '▼' : '▶'}</span>
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
