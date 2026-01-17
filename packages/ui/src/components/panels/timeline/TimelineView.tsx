import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Loader2, XCircle, Terminal, Edit3, File, Trash2, Circle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { API } from '../../../utils/api';
import { withTimeout } from '../../../utils/withTimeout';
import type { TimelineEvent, UserQuestionEvent } from '../../../types/timeline';
import type { Session } from '../../../types/session';
import { formatDistanceToNow, parseTimestamp } from '../../../utils/timestampUtils';
import { ThinkingMessage } from './ThinkingMessage';
import { ToolCallMessage, getToolIcon } from './ToolCallMessage';
import { UserQuestionDialog, type Question } from './UserQuestionDialog';
import { InlineDiffViewer } from './InlineDiffViewer';
import './MessageStyles.css';

const colors = {
  bg: 'var(--st-bg)',
  surface: 'var(--st-surface)',
  accent: 'var(--st-accent)',
  text: {
    primary: 'var(--st-text)',
    secondary: 'color-mix(in srgb, var(--st-text) 70%, transparent)',
    muted: 'color-mix(in srgb, var(--st-text) 50%, transparent)',
    faint: 'color-mix(in srgb, var(--st-text) 35%, transparent)',
  },
  status: {
    done: 'var(--st-text-muted)',
    running: 'var(--st-accent)', 
    error: 'var(--st-danger)',
  },
  userCard: {
    bg: 'color-mix(in srgb, var(--st-surface) 80%, var(--st-bg))',
    border: 'color-mix(in srgb, var(--st-border) 50%, transparent)',
  },
  command: {
    bg: 'color-mix(in srgb, var(--st-bg) 60%, transparent)',
    hover: 'color-mix(in srgb, var(--st-surface) 40%, transparent)',
  },
  border: 'var(--st-border)',
};

const Spinner: React.FC<{ className?: string }> = ({ className }) => {
  const outer = new Set([0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]);

  return (
    <svg viewBox="0 0 15 15" className={className} fill="currentColor" style={{ width: 14, height: 14, flexShrink: 0 }}>
      {Array.from({ length: 16 }, (_, i) => (
        <rect
          key={i}
          x={(i % 4) * 4}
          y={Math.floor(i / 4) * 4}
          width="3"
          height="3"
          rx="0.5"
          style={{
            animation: `${outer.has(i) ? 'spinner-dim' : 'spinner-bright'} 1.2s ease-in-out infinite`,
            animationDelay: `${(i % 4) * 0.1 + Math.floor(i / 4) * 0.1}s`,
          }}
        />
      ))}
    </svg>
  );
};

// Custom link component that opens external URLs in the system browser
const ExternalLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({ href, children, ...props }) => {
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (href && window.electron?.openExternal) {
      window.electron.openExternal(href).catch((error) => {
        console.error('Failed to open external URL:', error);
      });
    }
  }, [href]);

  return (
    <a href={href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
};

// Markdown components configuration
const markdownComponents: Components = {
  a: ExternalLink,
};

type CommandInfo = {
  kind: 'cli' | 'git' | 'worktree';
  command: string;
  status?: TimelineEvent['status'];
  durationMs?: number;
  exitCode?: number;
  tool?: string;
  meta?: Record<string, unknown>;
  cwd?: string;
};

type TimelineItem =
  | { type: 'userMessage'; seq: number; timestamp: string; content: string }
  | { type: 'agentResponse'; seq: number; timestamp: string; endTimestamp: string; status: 'running' | 'done' | 'error' | 'interrupted'; messages: Array<{ content: string; timestamp: string; isStreaming?: boolean }>; commands: CommandInfo[] }
  | { type: 'thinking'; seq: number; timestamp: string; content: string; isStreaming?: boolean; tool?: string | null; thinkingId?: string }
  | { type: 'toolCall'; seq: number; timestamp: string; toolName: string; toolInput?: string; toolResult?: string; isError?: boolean; exitCode?: number }
  | { type: 'userQuestion'; seq: number; timestamp: string; toolUseId: string; panelId?: string; questions: Question[]; status: 'pending' | 'answered'; answers?: Record<string, string | string[]> };

const getOperationId = (event: TimelineEvent) => {
  const id = event.meta?.operationId;
  return typeof id === 'string' ? id : null;
};

const isSingleLineCodexPhaseMarker = (text: string): boolean => {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.includes('\n')) return false;
  return t.length <= 120;
};

const getCommandKind = (eventKind: string): 'cli' | 'git' | 'worktree' => {
  switch (eventKind) {
    case 'cli.command': return 'cli';
    case 'worktree.command': return 'worktree';
    default: return 'git';
  }
};

const formatSeconds = (durationMs: number): string => {
  const ms = Number.isFinite(durationMs) ? durationMs : 0;
  const seconds = Math.max(0, ms) / 1000;
  return `${seconds.toFixed(1)}s`;
};

const getCommandIcon = (_kind: 'cli' | 'git' | 'worktree', command: string, meta?: Record<string, unknown>) => {
  // Check for tool calls recorded as cli.command (meta.toolName exists)
  const toolName = typeof meta?.toolName === 'string' ? meta.toolName : null;
  if (toolName) {
    return getToolIcon(toolName, { command, commandActions: meta?.commandActions });
  }

  // Check for Edit tool (has oldString/newString in meta)
  if (meta?.oldString !== undefined || meta?.newString !== undefined) {
    return Edit3;
  }
  // Check for Write tool (has isNewFile in meta)
  if (meta?.isNewFile === true) {
    return File;
  }
  // Check for delete operation
  if (meta?.isDelete === true || command.includes('rm ')) {
    return Trash2;
  }
  // Default to terminal icon for CLI/git commands
  return Terminal;
};

const formatCommandDisplay = (command: string, meta?: Record<string, unknown>) => {
  const toolName = typeof meta?.toolName === 'string' ? meta.toolName.toLowerCase() : '';
  if (toolName === 'commandexecution') {
    const actions = Array.isArray(meta?.commandActions) ? meta?.commandActions as Array<Record<string, unknown>> : [];
    if (actions.length > 0) {
      const actionLabels = actions
        .map((action) => {
          const actionCommand = typeof action.command === 'string' ? action.command.trim() : '';
          if (actionCommand) return actionCommand;
          const type = typeof action.type === 'string' ? action.type.trim() : '';
          const path = typeof action.path === 'string' ? action.path.trim() : '';
          if (type && path) return `${type}: ${path}`;
          return type || path;
        })
        .filter(Boolean);
      if (actionLabels.length > 0) return actionLabels.join(' ; ');
    }
    const rawCommand = typeof meta?.command === 'string' ? meta.command.trim() : '';
    if (rawCommand) return rawCommand;
  }
  if (toolName === 'filechange') {
    const changes = Array.isArray(meta?.changes) ? meta?.changes as Array<Record<string, unknown>> : [];
    if (changes.length > 0) {
      const paths = changes
        .map((change) => typeof change.path === 'string' ? change.path : '')
        .filter(Boolean);
      if (paths.length > 0) {
        const preview = paths.slice(0, 3).join(', ');
        const suffix = paths.length > 3 ? ` (+${paths.length - 3} more)` : '';
        return `Apply patch: ${preview}${suffix}`;
      }
    }
  }
  return command;
};

const getAgentModelLabelFromCommands = (commands: CommandInfo[]): string | null => {
  const modelsByAgent = new Map<'Codex' | 'Claude', Set<string>>();
  for (const c of commands) {
    if (c.kind !== 'cli') continue;
    const rawTool = typeof c.tool === 'string' ? c.tool : '';
    const tool = rawTool.toLowerCase();
    const agent =
      tool.includes('codex') ? 'Codex'
        : tool.includes('claude') ? 'Claude'
          : null;
    if (!agent) continue;

    const meta = c.meta || {};
    const model = typeof (meta as { cliModel?: unknown }).cliModel === 'string'
      ? String((meta as { cliModel: string }).cliModel).trim()
      : '';
    const set = modelsByAgent.get(agent) || new Set<string>();
    if (model) set.add(model);
    modelsByAgent.set(agent, set);
  }

  if (modelsByAgent.size === 0) return null;
  if (modelsByAgent.size > 1) return 'Mixed';

  const [agent, models] = Array.from(modelsByAgent.entries())[0];
  const arr = Array.from(models.values());
  if (arr.length === 0) return agent;
  if (arr.length === 1) return `${agent} ${arr[0]}`;
  return `${agent} ${arr[0]} (+${arr.length - 1})`;
};

// Build timeline items - groups everything between user messages into agent responses
const buildItems = (
  events: TimelineEvent[],
  sessionToolType?: Session['toolType'],
  sessionStatus?: Session['status']
): TimelineItem[] => {
  type FlatItem =
    | { type: 'user'; seq: number; timestamp: string; content: string }
    | { type: 'assistant'; seq: number; timestamp: string; content: string; isStreaming?: boolean }
    | { type: 'command'; seq: number; timestamp: string; kind: 'cli' | 'git' | 'worktree'; status?: TimelineEvent['status']; command: string; cwd?: string; durationMs?: number; exitCode?: number; tool?: string; meta?: Record<string, unknown> }
    | { type: 'thinking'; seq: number; timestamp: string; content: string; isStreaming?: boolean; tool?: string | null; thinkingId?: string }
    | { type: 'toolCall'; seq: number; timestamp: string; toolName: string; toolInput?: string; toolResult?: string; isError?: boolean; exitCode?: number }
    | { type: 'userQuestion'; seq: number; timestamp: string; toolUseId: string; panelId?: string; questions: Question[]; status: 'pending' | 'answered'; answers?: Record<string, string | string[]> };

  const flat: FlatItem[] = [];
  const byOperation: Record<string, TimelineEvent[]> = {};
  const toolUsePairs = new Map<string, { useEvent?: TimelineEvent; resultEvent?: TimelineEvent }>();
  // Track user_question events by tool_use_id to deduplicate (keep latest/answered status)
  const userQuestionByToolUseId = new Map<string, UserQuestionEvent>();

  // First pass: collect events
  for (const event of events) {
    const operationId = getOperationId(event);
    if (operationId) {
      (byOperation[operationId] ||= []).push(event);
      continue;
    }

    if (event.kind === 'chat.user') {
      flat.push({ type: 'user', seq: event.seq, timestamp: event.timestamp, content: event.command || '' });
    } else if (event.kind === 'chat.assistant') {
      flat.push({ type: 'assistant', seq: event.seq, timestamp: event.timestamp, content: event.command || '', isStreaming: Boolean(event.is_streaming) });
    } else if (event.kind === 'thinking') {
      const content = (event.content || '').trim();
      // Codex emits lots of single-line phase markers ("Searching", "Preparing", "Respond", etc.)
      // that are useful only as transient status. Hide them from the timeline for a cleaner UX.
      const isCodex = sessionToolType === 'codex' || event.tool === 'codex' || event.tool === 'Codex';
      if (isCodex && isSingleLineCodexPhaseMarker(content)) {
        continue;
      }
      flat.push({
        type: 'thinking',
        seq: event.seq,
        timestamp: event.timestamp,
        content: event.content || '',
        isStreaming: Boolean(event.is_streaming),
        tool: event.tool ?? null,
        thinkingId: typeof (event as TimelineEvent & { thinking_id?: unknown }).thinking_id === 'string'
          ? String((event as TimelineEvent & { thinking_id: string }).thinking_id)
          : undefined,
      });
    } else if (event.kind === 'tool_use') {
      // Pair tool_use with tool_result - use event.id as the pair key
      const toolUseId = String(event.id);
      const pair = toolUsePairs.get(toolUseId) || {};
      pair.useEvent = event;
      toolUsePairs.set(toolUseId, pair);
    } else if (event.kind === 'tool_result') {
      // Pair tool_result with tool_use - use tool_use_id if available
      const toolUseId = event.tool_use_id || String(event.id);
      const pair = toolUsePairs.get(toolUseId) || {};
      pair.resultEvent = event;
      toolUsePairs.set(toolUseId, pair);
    } else if (event.kind === 'user_question') {
      // Deduplicate user_question events by tool_use_id - prefer 'answered' status or latest
      const toolUseId = event.tool_use_id || '';
      const existing = userQuestionByToolUseId.get(toolUseId);
      if (!existing || event.status === 'answered' || event.seq > existing.seq) {
        userQuestionByToolUseId.set(toolUseId, event);
      }
    } else if (event.kind === 'cli.command' || event.kind === 'git.command' || event.kind === 'worktree.command') {
      flat.push({
        type: 'command',
        seq: event.seq,
        timestamp: event.timestamp,
        kind: getCommandKind(event.kind),
        status: event.status,
        command: event.command || '',
        cwd: event.cwd,
        durationMs: event.duration_ms,
        exitCode: event.exit_code,
        tool: event.tool,
        meta: event.meta
      });
    }
  }

  // Add deduplicated user_question events to flat array
  for (const event of userQuestionByToolUseId.values()) {
    try {
      const questions = event.questions ? JSON.parse(event.questions) : [];
      const answers = event.answers ? JSON.parse(event.answers) : undefined;
      flat.push({
        type: 'userQuestion',
        seq: event.seq,
        timestamp: event.timestamp,
        toolUseId: event.tool_use_id || '',
        panelId: event.panel_id,
        questions,
        status: event.status === 'answered' ? 'answered' : 'pending',
        answers
      });
    } catch {
      // Ignore malformed user_question events
    }
  }

  // Merge tool_use and tool_result pairs into toolCall items
  for (const pair of toolUsePairs.values()) {
    const { useEvent, resultEvent } = pair;
    if (!useEvent || useEvent.kind !== 'tool_use') continue; // Must have at least tool_use

    flat.push({
      type: 'toolCall',
      seq: useEvent.seq,
      timestamp: useEvent.timestamp,
      toolName: useEvent.tool_name,
      toolInput: useEvent.tool_input,
      toolResult: resultEvent?.kind === 'tool_result' ? resultEvent.content : undefined,
      isError: resultEvent?.kind === 'tool_result' ? Boolean(resultEvent.is_error) : false,
      exitCode: resultEvent?.kind === 'tool_result' ? resultEvent.exit_code : undefined
    });
  }

  // Process operation groups
  for (const group of Object.values(byOperation)) {
    group.sort((a, b) => a.seq - b.seq);
    const first = group[0];
    const last = group[group.length - 1];

    if (first.kind === 'chat.user') {
      flat.push({ type: 'user', seq: first.seq, timestamp: first.timestamp, content: first.command || '' });
    } else if (first.kind === 'chat.assistant') {
      flat.push({ type: 'assistant', seq: first.seq, timestamp: first.timestamp, content: first.command || '', isStreaming: Boolean(first.is_streaming) });
    } else if (first.kind === 'cli.command' || first.kind === 'git.command' || first.kind === 'worktree.command') {
      flat.push({
        type: 'command',
        seq: first.seq,
        timestamp: first.timestamp,
        kind: getCommandKind(first.kind),
        status: last.status,
        command: first.command || last.command || '',
        cwd: first.cwd || last.cwd,
        durationMs: last.duration_ms,
        exitCode: last.exit_code,
        tool: first.tool || last.tool,
        meta: { ...(first.meta || {}), ...(last.meta || {}) }
      });
    }
  }

  flat.sort((a, b) => a.seq - b.seq);

  // Second pass: group into user messages and agent responses
  const items: TimelineItem[] = [];
  let cursor = 0;

  while (cursor < flat.length) {
    const current = flat[cursor];

    // User message - standalone
    if (current.type === 'user') {
      items.push({
        type: 'userMessage',
        seq: current.seq,
        timestamp: current.timestamp,
        content: current.content
      });
      cursor++;
      continue;
    }

    // Thinking - standalone
    if (current.type === 'thinking') {
      items.push(current);
      cursor++;
      continue;
    }

    // Tool call - standalone
    if (current.type === 'toolCall') {
      items.push(current);
      cursor++;
      continue;
    }

    // User question - standalone
    if (current.type === 'userQuestion') {
      items.push(current);
      cursor++;
      continue;
    }

    // Collect all non-user items into an agent response
    const startSeq = current.seq;
    const startTimestamp = current.timestamp;
    const messages: Array<{ content: string; timestamp: string; isStreaming?: boolean }> = [];
    const commands: CommandInfo[] = [];
    let endTimestamp = current.timestamp;
    let hasRunning = false;
    let hasError = false;
    let hasInterrupted = false;

    while (cursor < flat.length && flat[cursor].type !== 'user' && flat[cursor].type !== 'thinking' && flat[cursor].type !== 'toolCall' && flat[cursor].type !== 'userQuestion') {
      const item = flat[cursor];
      endTimestamp = item.timestamp;

      if (item.type === 'assistant') {
        messages.push({ content: item.content, timestamp: item.timestamp, isStreaming: item.isStreaming });
      } else if (item.type === 'command') {
        const meta = item.meta || {};
        const termination = typeof meta.termination === 'string' ? meta.termination : undefined;
        if (termination === 'interrupted') hasInterrupted = true;

        commands.push({
          kind: item.kind,
          command: item.command,
          status: item.status,
          durationMs: item.durationMs,
          exitCode: item.exitCode,
          tool: item.tool,
          meta,
          cwd: item.cwd
        });
        if (item.status === 'started') hasRunning = true;
        if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) {
          if (termination !== 'interrupted') hasError = true;
        }
      }
      cursor++;
    }

    // Only add if there's content
    if (messages.length > 0 || commands.length > 0) {
      const status = (() => {
        if (hasRunning) return 'running';
        if (hasInterrupted) return 'interrupted';
        if (hasError) return 'error';
        return 'done';
      })();
      items.push({
        type: 'agentResponse',
        seq: startSeq,
        timestamp: startTimestamp,
        endTimestamp,
        status,
        messages,
        commands
      });
    }
  }

  // If the session is currently running, reflect that in the latest turn's agent response
  // even if it contains only completed commands and streaming continues as standalone items
  // (e.g. Codex incremental reasoning updates).
  if (sessionStatus === 'running' || sessionStatus === 'initializing') {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'agentResponse') {
        if (item.status !== 'error') {
          items[i] = { ...item, status: 'running' };
        }
        break;
      }
      if (item.type === 'userMessage') break;
    }
  }

  if (sessionStatus === 'stopped') {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'agentResponse') {
        if (item.status !== 'done') items[i] = { ...item, status: 'interrupted' };
        break;
      }
      if (item.type === 'userMessage') break;
    }
  }

  return items;
};

const formatTimeHHMM = (timestamp: string) => {
  try {
    const d = parseTimestamp(timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
};

interface ImageAttachment {
  id: string;
  filename: string;
  mime: string;
  dataUrl: string;
}

const ImagePillInline: React.FC<{ index: number }> = ({ index }) => (
  <span
    style={{
      display: 'inline-block',
      padding: '2px 6px',
      margin: '0 2px',
      borderRadius: '4px',
      fontFamily: 'monospace',
      fontSize: '13px',
      backgroundColor: 'color-mix(in srgb, var(--st-accent) 15%, transparent)',
      color: 'var(--st-accent)',
    }}
  >
    [img{index}]
  </span>
);

// Render text content with [img1], [img2], etc. tags as styled pills
const renderTextWithImagePills = (text: string): React.ReactNode => {
  if (!text.includes('[img')) {
    return text;
  }
  const parts = text.split(/(\[img\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[img(\d+)\]/);
    if (match) {
      const imgIndex = parseInt(match[1], 10);
      return <ImagePillInline key={i} index={imgIndex} />;
    }
    return part;
  });
};

const UserMessage: React.FC<{ content: string; timestamp: string; images?: ImageAttachment[] }> = ({ content, timestamp }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = content.split('\n');
  const MAX_LINES = 5;
  const shouldCollapse = lines.length > MAX_LINES;
  const displayContent = shouldCollapse && !isExpanded
    ? lines.slice(0, MAX_LINES).join('\n')
    : content;

  return (
    <div className="user-message-container">
      <div className="user-message-content">
        <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
          {renderTextWithImagePills(displayContent)}
        </div>
        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-2 text-xs flex items-center gap-1 transition-colors hover:opacity-80"
            style={{ color: colors.text.muted }}
          >
            {isExpanded ? (
              <>
                <ChevronDown size={14} />
                <span>Show less</span>
              </>
            ) : (
              <>
                <ChevronRight size={14} />
                <span>Show more ({lines.length - MAX_LINES} more lines)</span>
              </>
            )}
          </button>
        )}
        <div className="message-timestamp">
          {formatDistanceToNow(parseTimestamp(timestamp))}
        </div>
      </div>
    </div>
  );
};

const AgentResponse: React.FC<{
  messages: Array<{ content: string; timestamp: string; isStreaming?: boolean }>;
  commands: CommandInfo[];
  status: 'running' | 'done' | 'error' | 'interrupted';
  timestamp: string;
  endTimestamp: string;
}> = ({ messages, commands, status, timestamp: _timestamp, endTimestamp }) => {
  const [showCommands, setShowCommands] = useState(true);
  const userToggledRef = useRef(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedOutputs, setExpandedOutputs] = useState<Set<string>>(new Set());
  const agentLabel = useMemo(() => getAgentModelLabelFromCommands(commands), [commands]);

  const handleCopy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 900);
    } catch { /* ignore */ }
  }, []);

  const totalDuration = commands.reduce((sum, c) => sum + (c.durationMs || 0), 0);
  const runningCount = commands.filter(c => c.status === 'started').length;
  const interruptedCount = commands.filter(c => {
    const meta = c.meta || {};
    return typeof meta.termination === 'string' && meta.termination === 'interrupted';
  }).length;
  const failedCount = commands.filter(c => {
    const meta = c.meta || {};
    const interrupted = typeof meta.termination === 'string' && meta.termination === 'interrupted';
    if (interrupted) return false;
    return c.status === 'failed' || (typeof c.exitCode === 'number' && c.exitCode !== 0);
  }).length;
  const doneCount = commands.length - runningCount - failedCount - interruptedCount;
  const lastMessageIsStreaming = messages.length > 0 && Boolean(messages[messages.length - 1]?.isStreaming);

  return (
    <div className="agent-response-container">
      {/* Commands section */}
      {commands.length > 0 && (
        <div className="commands-section">
          {/* Header */}
          <div
            className="commands-header"
            onClick={() => {
              userToggledRef.current = true;
              setShowCommands(v => !v);
            }}
          >
            <ChevronRight className={`commands-expand-icon ${showCommands ? 'expanded' : ''}`} size={14} />
            <div className="commands-stats">
              {agentLabel && (
                <span className="commands-stat-item">
                  <span className="commands-stat-value" style={{ color: colors.accent }}>
                    {agentLabel}
                  </span>
                </span>
              )}
              <span className="commands-stat-item">
                <span className="commands-stat-value">{commands.length}</span>
                <span> command{commands.length > 1 ? 's' : ''}</span>
              </span>
              {doneCount > 0 && (
                <span className="commands-stat-item status-done">
                  <span className="commands-stat-value">{doneCount}</span>
                  <span> done</span>
                </span>
              )}
              {runningCount > 0 && (
                <span className="commands-stat-item status-running">
                  <Spinner />
                  <span className="commands-stat-value">{runningCount}</span>
                  <span> running</span>
                </span>
              )}
              {interruptedCount > 0 && (
                <span className="commands-stat-item status-interrupted">
                  <span className="commands-stat-value">{interruptedCount}</span>
                  <span> interrupted</span>
                </span>
              )}
              {failedCount > 0 && (
                <span className="commands-stat-item status-error">
                  <span className="commands-stat-value">{failedCount}</span>
                  <span> failed</span>
                </span>
              )}
              {totalDuration > 0 && status !== 'running' && (
                <span className="commands-duration">
                  {formatSeconds(totalDuration)}
                </span>
              )}
            </div>
          </div>

          {/* Collapsible command list */}
          {showCommands && (
            <div className="commands-body">
              {commands.map((c, idx) => {
                const display = formatCommandDisplay(String(c.command ?? ''), c.meta);
                const key = `${idx}-${display}`;
                const meta = c.meta || {};
                const stdout = typeof meta.stdout === 'string' ? meta.stdout : '';
                const stderr = typeof meta.stderr === 'string' ? meta.stderr : '';
                const commandCopy = typeof meta.commandCopy === 'string' ? meta.commandCopy : display;
                const showStdout = stdout.length > 0;
                const showStderr = stderr.length > 0;
                const cmdStatus = c.status;
                const metaTermination = typeof meta.termination === 'string' ? meta.termination : undefined;
                const isInterrupted = metaTermination === 'interrupted';
                const isFailed = !isInterrupted && (cmdStatus === 'failed' || (typeof c.exitCode === 'number' && c.exitCode !== 0));

                // Check for diff data (Edit, Write, Bash rm, Codex tools)
                const oldString = typeof meta.oldString === 'string' ? meta.oldString : undefined;
                const newString = typeof meta.newString === 'string' ? meta.newString : undefined;
                const filePath = typeof meta.filePath === 'string' ? meta.filePath : undefined;
                const isDelete = meta.isDelete === true;
                const isNewFile = meta.isNewFile === true;
                const diffFiles = meta.diffFiles as Array<{
                  filePath: string;
                  oldString: string;
                  newString: string;
                  isDelete?: boolean;
                  isNewFile?: boolean;
                }> | undefined;

                // Single file diff (Edit, Write, Bash rm single file)
                const hasSingleDiff = oldString !== undefined || newString !== undefined;
                // Multiple file diffs (e.g., rm file1 file2)
                const hasMultipleDiffs = Array.isArray(diffFiles) && diffFiles.length > 0;

                const CommandIcon = getCommandIcon(c.kind, display, meta);
                const hasOutput = showStdout || showStderr;
                const isOutputExpanded = expandedOutputs.has(key);

                const toggleOutput = () => {
                  setExpandedOutputs(prev => {
                    const next = new Set(prev);
                    if (next.has(key)) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    return next;
                  });
                };

                return (
                  <div key={key}>
                    <div className="command-item">
                      <span className="command-status-icon">
                        {cmdStatus === 'started' ? (
                          <Loader2 className="status-running" style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                        ) : isInterrupted ? (
                          <XCircle className="status-interrupted" style={{ width: 14, height: 14 }} />
                        ) : isFailed ? (
                          <XCircle className="status-error" style={{ width: 14, height: 14 }} />
                        ) : (
                          <Check className="status-done" style={{ width: 14, height: 14 }} />
                        )}
                      </span>
                      <CommandIcon className="command-type-icon" style={{ width: 13, height: 13, marginRight: 8, flexShrink: 0, opacity: 0.6 }} />
                      <span className="command-text">{display}</span>
                      <div className="command-actions">
                        {hasOutput && (
                          <button
                            onClick={toggleOutput}
                            className="text-xs px-2 py-0.5 rounded flex items-center gap-1 transition-colors hover:opacity-80"
                            style={{
                              backgroundColor: isOutputExpanded ? colors.command.hover : colors.command.bg,
                              border: `1px solid ${colors.border}`,
                              color: colors.text.secondary,
                              marginRight: 6
                            }}
                            title={isOutputExpanded ? 'Hide output' : 'Show output'}
                          >
                            {isOutputExpanded ? (
                              <>
                                <ChevronDown style={{ width: 11, height: 11 }} />
                                <span>Hide</span>
                              </>
                            ) : (
                              <>
                                <ChevronRight style={{ width: 11, height: 11 }} />
                                <span>Output</span>
                              </>
                            )}
                          </button>
                        )}
                        <button
                          className="command-copy-btn"
                          onClick={() => handleCopy(commandCopy, key)}
                          title={copiedKey === key ? 'Copied' : 'Copy'}
                        >
                          {copiedKey === key ? (
                            <Check style={{ width: 12, height: 12 }} className="status-done" />
                          ) : (
                            <Copy style={{ width: 12, height: 12 }} />
                          )}
                        </button>
                      </div>
                    </div>
                    {hasSingleDiff && (
                      <div className="command-diff">
                        {(isDelete || isNewFile) && (
                          <div className="diff-label">
                            {isDelete ? 'Deleted' : 'New file'}
                          </div>
                        )}
                        <InlineDiffViewer
                          oldString={oldString ?? ''}
                          newString={newString ?? ''}
                          filePath={filePath}
                        />
                      </div>
                    )}
                    {hasMultipleDiffs && diffFiles.map((df, i) => (
                      <div key={df.filePath || i} className="command-diff">
                        {(df.isDelete || df.isNewFile) && (
                          <div className="diff-label">
                            {df.isDelete ? 'Deleted' : 'New file'}
                          </div>
                        )}
                        <InlineDiffViewer
                          oldString={df.oldString}
                          newString={df.newString}
                          filePath={df.filePath}
                        />
                      </div>
                    ))}
                    {isOutputExpanded && showStdout && (
                      <pre className="command-output stdout">{stdout}</pre>
                    )}
                    {isOutputExpanded && showStderr && (
                      <pre className="command-output stderr">{stderr}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((msg, idx) => (
            <div key={idx} className="markdown-content text-sm leading-relaxed" style={{ color: colors.text.primary }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {msg.content}
              </ReactMarkdown>
            </div>
          ))}
        </div>
      )}

      {lastMessageIsStreaming && (
        <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: colors.text.muted }}>
          <Spinner />
          <span>Responding...</span>
        </div>
      )}

      <div className="message-timestamp">
        {formatDistanceToNow(parseTimestamp(endTimestamp))}
      </div>
    </div>
  );
};

// Time separator - subtle and elegant
const TimeSeparator: React.FC<{ time: string }> = ({ time }) => (
  <div className="flex items-center gap-4 py-2">
    <div className="flex-1 h-px opacity-20" style={{ backgroundColor: colors.border }} />
    <span className="text-[10px] font-mono opacity-40" style={{ color: colors.text.muted }}>{time}</span>
    <div className="flex-1 h-px opacity-20" style={{ backgroundColor: colors.border }} />
  </div>
);

export const TimelineView: React.FC<{
  sessionId: string;
  session: Session;
  pendingMessage?: { content: string; timestamp: string; images?: ImageAttachment[] } | null;
}> = ({ sessionId, session, pendingMessage }) => {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const idsRef = useRef(new Set<number>());
  const requestIdRef = useRef(0);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(new Set());

  const isAtBottom = useCallback((container: HTMLDivElement) => {
    const thresholdPx = 240;
    return container.scrollHeight - container.scrollTop - container.clientHeight < thresholdPx;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    wasAtBottomRef.current = true;
    setShowLatest(false);
    setHasNew(false);
    const container = scrollRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } else {
      endRef.current?.scrollIntoView({ behavior });
    }
  }, []);

  const loadTimeline = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await withTimeout(API.sessions.getTimeline(sessionId), 12_000, 'Load timeline');
      if (requestId !== requestIdRef.current) return;
      if (res.success && Array.isArray(res.data)) {
        const loaded = res.data as TimelineEvent[];
        idsRef.current = new Set(loaded.map(e => e.id));
        setEvents(loaded);
      } else if (!res.success) {
        setError(res.error || 'Failed to load timeline');
      }
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load timeline');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    setEvents([]);
    idsRef.current = new Set();
    requestIdRef.current++;
    loadTimeline();
  }, [loadTimeline]);

  useEffect(() => {
    const handler = (data: { sessionId: string; event: unknown }) => {
      if (data.sessionId !== sessionId) return;
      const event = data.event as TimelineEvent | undefined;
      if (!event) return;
      const already = idsRef.current.has(event.id);
      idsRef.current.add(event.id);
      setEvents((prev) => {
        if (!already) {
          const next = [...prev, event];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        }
        const idx = prev.findIndex((e) => e.id === event.id);
        if (idx === -1) {
          const next = [...prev, event];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        }
        const next = [...prev];
        next[idx] = event;
        return next;
      });
    };

    const unsubscribe = window.electronAPI.events.onTimelineEvent(handler);
    return () => unsubscribe();
  }, [sessionId]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const closeEnough = isAtBottom(container);
    if (closeEnough) {
      wasAtBottomRef.current = true;
    }

    if (!wasAtBottomRef.current) return;
    const behavior: ScrollBehavior = loading ? 'auto' : 'smooth';
    requestAnimationFrame(() => scrollToBottom(behavior));
  }, [events.length, pendingMessage?.content, loading, scrollToBottom, isAtBottom]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const container = scrollRef.current;
      if (!container) return;
      if (!wasAtBottomRef.current) return;
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom = isAtBottom(container);
    wasAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowLatest(false);
      setHasNew(false);
    }
  }, [isAtBottom]);

  useEffect(() => {
    if (wasAtBottomRef.current) return;
    if (!events.length && !pendingMessage) return;
    setShowLatest(true);
    setHasNew(true);
  }, [events.length, pendingMessage]);

  const items = useMemo(() => {
    return buildItems(events, session.toolType, session.status);
  }, [events, session.toolType, session.status]);

  // Group items by time for separators
  const itemsWithSeparators = useMemo(() => {
    const result: Array<{ type: 'separator'; time: string } | TimelineItem> = [];
    let lastTime = '';

    for (const item of items) {
      const time = formatTimeHHMM(item.timestamp);
      if (time && time !== lastTime) {
        result.push({ type: 'separator', time });
        lastTime = time;
      }
      result.push(item);
    }
    return result;
  }, [items]);

  const visiblePendingMessage = useMemo(() => {
    if (!pendingMessage?.content) return null;
    const pendingText = pendingMessage.content.trim();
    if (!pendingText) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'userMessage') continue;
      if ((item.content || '').trim() === pendingText) {
        return null;
      }
      break;
    }
    return pendingMessage;
  }, [pendingMessage, items]);

  // Extract pending user question from timeline - to render outside scrollbox
  // Filter out questions that user has temporarily dismissed with ESC
  const pendingQuestion = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'userQuestion' && item.status === 'pending') {
        // Skip if user dismissed this question
        if (dismissedQuestionIds.has(item.toolUseId)) {
          continue;
        }
        return item;
      }
    }
    return null;
  }, [items, dismissedQuestionIds]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto relative" onScroll={handleScroll}>
        <div ref={contentRef} className="px-6 py-4">
          <div className="flex flex-col gap-6">
            {error && (
              <div className="rounded px-3 py-2" style={{ backgroundColor: 'rgba(224, 108, 117, 0.1)', border: `1px solid ${colors.status.error}33` }}>
                <div className="text-[12px] font-medium mb-1" style={{ color: colors.status.error }}>Failed to load timeline</div>
                <div className="text-[11px] mb-2" style={{ color: colors.text.muted }}>{error}</div>
                <button
                  type="button"
                  onClick={() => loadTimeline()}
                  className="text-[11px] px-2 py-1 rounded transition-all hover:bg-white/5"
                  style={{ border: `1px solid ${colors.border}`, color: colors.text.secondary }}
                >
                  Retry
                </button>
              </div>
            )}

            {itemsWithSeparators.map((item, idx) => {
              if ('type' in item && item.type === 'separator') {
                return <TimeSeparator key={`sep-${item.time}-${idx}`} time={item.time} />;
              }

              const timelineItem = item as TimelineItem;

              if (timelineItem.type === 'userMessage') {
                return (
                  <UserMessage
                    key={`user-${timelineItem.seq}`}
                    content={timelineItem.content}
                    timestamp={timelineItem.timestamp}
                  />
                );
              }

              if (timelineItem.type === 'thinking') {
                return (
                  <ThinkingMessage
                    key={`thinking-${timelineItem.thinkingId || timelineItem.seq}`}
                    content={timelineItem.content}
                    timestamp={timelineItem.timestamp}
                    isStreaming={timelineItem.isStreaming}
                  />
                );
              }

              if (timelineItem.type === 'toolCall') {
                return (
                  <ToolCallMessage
                    key={`tool-${timelineItem.seq}`}
                    toolName={timelineItem.toolName}
                    toolInput={timelineItem.toolInput}
                    toolResult={timelineItem.toolResult}
                    isError={timelineItem.isError}
                    timestamp={timelineItem.timestamp}
                    exitCode={timelineItem.exitCode}
                  />
                );
              }

              if (timelineItem.type === 'userQuestion') {
                if (timelineItem.status === 'pending') {
                  // Skip pending questions - they are rendered outside scrollbox
                  return null;
                } else {
                  // Answered question - display as historical record
                  return (
                    <div
                      key={`question-answered-${timelineItem.seq}`}
                      className="rounded-lg px-4 py-3 my-2"
                      style={{
                        backgroundColor: colors.userCard.bg,
                        border: `1px solid ${colors.userCard.border}`,
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <Check className="question-answered-icon" size={12} />
                        <span style={{ color: colors.text.primary, fontWeight: 500 }}>
                          Question Answered
                        </span>
                        <span style={{ color: colors.text.muted, fontSize: '0.85em' }}>
                          {new Date(timelineItem.timestamp).toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false,
                          })}
                        </span>
                      </div>
                      {Object.entries(timelineItem.answers || {}).map(([qIdx, answer]) => (
                        <div key={qIdx} style={{ color: colors.text.secondary, fontSize: '0.9em', marginLeft: '1.5rem' }}>
                          Question {Number(qIdx) + 1}: {Array.isArray(answer) ? answer.join(', ') : answer}
                        </div>
                      ))}
                    </div>
                  );
                }
              }

              return (
                <AgentResponse
                  key={`agent-${timelineItem.seq}`}
                  messages={timelineItem.messages}
                  commands={timelineItem.commands}
                  status={timelineItem.status}
                  timestamp={timelineItem.timestamp}
                  endTimestamp={timelineItem.endTimestamp}
                />
              );
            })}

            {visiblePendingMessage && (
              <div
                className="rounded-lg px-4 py-3"
                style={{
                  backgroundColor: colors.userCard.bg,
                  border: `1px solid ${colors.userCard.border}`,
                }}
              >
                <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
                  {renderTextWithImagePills(visiblePendingMessage.content)}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: colors.text.muted }}>
                  <Spinner />
                  <span>Sending...</span>
                  <Circle className="opacity-40" size={4} />
                  <span className="opacity-60">Press Esc to cancel</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: colors.text.muted }} />
          </div>
        )}

        {showLatest && (
          <div className="sticky bottom-3 flex justify-end pointer-events-none">
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              className="pointer-events-auto mr-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition-all hover:bg-white/10"
              style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}`, color: colors.text.secondary }}
              title="Scroll to latest"
            >
              <ChevronDown className="w-3 h-3" />
              <span>Latest</span>
              {hasNew && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: colors.status.running }} />}
            </button>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Pending user question - rendered outside scrollbox for direct keyboard access */}
      {pendingQuestion && (
        <div className="flex-shrink-0 px-6">
          <div>
            <UserQuestionDialog
              questions={pendingQuestion.questions}
              onSubmit={(answers) => {
                const panelId = pendingQuestion.panelId;
                if (!panelId) {
                  console.error('Failed to answer question: panelId not found in pending question');
                  return;
                }
                const panelType = session.toolType === 'codex' ? 'codex' : 'claude';
                window.electronAPI.panels
                  .answerQuestion(panelId, panelType, answers)
                  .catch((error: unknown) => {
                    console.error('Failed to answer question:', error);
                  });
              }}
              onCancel={() => {
                if (pendingQuestion) {
                  setDismissedQuestionIds(prev => new Set(prev).add(pendingQuestion.toolUseId));
                }
              }}
            />
          </div>
        </div>
      )}

      {!loading && !error && items.length === 0 && !pendingMessage && (
        <div className="flex items-center justify-center py-10 text-[12px]" style={{ color: colors.text.muted }}>
          <XCircle className="w-4 h-4 mr-2" />
          No messages yet
        </div>
      )}
    </div>
  );
};

export default TimelineView;
