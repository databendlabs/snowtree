import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Loader2, XCircle } from 'lucide-react';
import { API } from '../../../utils/api';
import { withTimeout } from '../../../utils/withTimeout';
import type { TimelineEvent } from '../../../types/timeline';
import { formatDistanceToNow, parseTimestamp } from '../../../utils/timestampUtils';

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
  | { type: 'agentResponse'; seq: number; timestamp: string; endTimestamp: string; status: 'running' | 'done' | 'error' | 'interrupted'; messages: Array<{ content: string; timestamp: string }>; commands: CommandInfo[] };

const getOperationId = (event: TimelineEvent) => {
  const id = event.meta?.operationId;
  return typeof id === 'string' ? id : null;
};

// Build timeline items - groups everything between user messages into agent responses
const buildItems = (events: TimelineEvent[]): TimelineItem[] => {
  type FlatItem =
    | { type: 'user'; seq: number; timestamp: string; content: string }
    | { type: 'assistant'; seq: number; timestamp: string; content: string }
    | { type: 'command'; seq: number; timestamp: string; kind: 'cli' | 'git' | 'worktree'; status?: TimelineEvent['status']; command: string; cwd?: string; durationMs?: number; exitCode?: number; tool?: string; meta?: Record<string, unknown> };

  const flat: FlatItem[] = [];
  const byOperation: Record<string, TimelineEvent[]> = {};

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
      flat.push({ type: 'assistant', seq: event.seq, timestamp: event.timestamp, content: event.command || '' });
    } else if (event.kind === 'cli.command' || event.kind === 'git.command' || event.kind === 'worktree.command') {
      flat.push({
        type: 'command',
        seq: event.seq,
        timestamp: event.timestamp,
        kind: event.kind === 'cli.command' ? 'cli' : event.kind === 'worktree.command' ? 'worktree' : 'git',
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

  // Process operation groups
  for (const group of Object.values(byOperation)) {
    group.sort((a, b) => a.seq - b.seq);
    const first = group[0];
    const last = group[group.length - 1];

    if (first.kind === 'chat.user') {
      flat.push({ type: 'user', seq: first.seq, timestamp: first.timestamp, content: first.command || '' });
    } else if (first.kind === 'chat.assistant') {
      flat.push({ type: 'assistant', seq: first.seq, timestamp: first.timestamp, content: first.command || '' });
    } else if (first.kind === 'cli.command' || first.kind === 'git.command' || first.kind === 'worktree.command') {
      flat.push({
        type: 'command',
        seq: first.seq,
        timestamp: first.timestamp,
        kind: first.kind === 'cli.command' ? 'cli' : first.kind === 'worktree.command' ? 'worktree' : 'git',
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

    // Collect all non-user items into an agent response
    const startSeq = current.seq;
    const startTimestamp = current.timestamp;
    const messages: Array<{ content: string; timestamp: string }> = [];
    const commands: CommandInfo[] = [];
    let endTimestamp = current.timestamp;
    let hasRunning = false;
    let hasError = false;

    while (cursor < flat.length && flat[cursor].type !== 'user') {
      const item = flat[cursor];
      endTimestamp = item.timestamp;

      if (item.type === 'assistant') {
        messages.push({ content: item.content, timestamp: item.timestamp });
      } else if (item.type === 'command') {
        commands.push({
          kind: item.kind,
          command: item.command,
          status: item.status,
          durationMs: item.durationMs,
          exitCode: item.exitCode,
          tool: item.tool,
          meta: item.meta,
          cwd: item.cwd
        });
        if (item.status === 'started') hasRunning = true;
        if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) hasError = true;
      }
      cursor++;
    }

    // Only add if there's content
    if (messages.length > 0 || commands.length > 0) {
      items.push({
        type: 'agentResponse',
        seq: startSeq,
        timestamp: startTimestamp,
        endTimestamp,
        status: hasRunning ? 'running' : hasError ? 'error' : 'done',
        messages,
        commands
      });
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

const ImageTag: React.FC<{ index: number }> = ({ index }) => (
  <span
    className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono mx-0.5"
    style={{
      backgroundColor: 'color-mix(in srgb, var(--st-accent) 15%, transparent)',
      border: '1px solid var(--st-accent)',
      color: 'var(--st-accent)',
    }}
  >
    [Image {index}]
  </span>
);

const UserMessage: React.FC<{ content: string; timestamp: string; images?: ImageAttachment[] }> = ({ content, timestamp, images }) => (
  <div
    className="rounded-lg px-4 py-3"
    style={{
      backgroundColor: colors.userCard.bg,
      borderLeft: '3px solid var(--st-accent, #61afef)',
    }}
  >
    <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
      {images && images.length > 0 && (
        <>
          {images.map((img, idx) => (
            <ImageTag key={img.id} index={idx + 1} />
          ))}
          {content && ' '}
        </>
      )}
      {content}
    </div>
    <div className="mt-2 text-[11px]" style={{ color: colors.text.faint }}>
      {formatDistanceToNow(parseTimestamp(timestamp))}
    </div>
  </div>
);

const AgentResponse: React.FC<{
  messages: Array<{ content: string; timestamp: string }>;
  commands: CommandInfo[];
  status: 'running' | 'done' | 'error' | 'interrupted';
  timestamp: string;
  endTimestamp: string;
}> = ({ messages, commands, status, timestamp: _timestamp, endTimestamp }) => {
  const [showCommands, setShowCommands] = useState(() => status === 'running');
  const userToggledRef = useRef(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'running') {
      if (!userToggledRef.current) setShowCommands(true);
    } else {
      if (!userToggledRef.current) setShowCommands(false);
    }
  }, [status]);

  const handleCopy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 900);
    } catch { /* ignore */ }
  }, []);

  const totalDuration = commands.reduce((sum, c) => sum + (c.durationMs || 0), 0);
  const runningCount = commands.filter(c => c.status === 'started').length;
  const failedCount = commands.filter(c => c.status === 'failed' || (typeof c.exitCode === 'number' && c.exitCode !== 0)).length;
  const doneCount = commands.length - runningCount - failedCount;

  return (
    <div className="space-y-2">
      {messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((msg, idx) => (
            <div key={idx} className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
              {msg.content}
            </div>
          ))}
        </div>
      )}

      {/* Commands section - clean collapsible panel */}
      {commands.length > 0 && (
        <div 
          className="rounded-lg overflow-hidden"
          style={{ 
            backgroundColor: colors.command.bg,
            border: status === 'running' ? `1px solid ${colors.status.running}33` : '1px solid transparent',
          }}
        >
          {/* Header */}
          <button
            type="button"
            onClick={() => {
              userToggledRef.current = true;
              setShowCommands(v => !v);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-xs hover:bg-white/[0.02] transition-colors"
            style={{ color: colors.text.muted }}
          >
            {showCommands ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span className="font-mono">{commands.length} command{commands.length > 1 ? 's' : ''}</span>
            <span className="opacity-30">·</span>
            {runningCount > 0 && (
              <>
                <Spinner />
                <span style={{ color: colors.status.running }}>{runningCount} running</span>
              </>
            )}
            {runningCount > 0 && doneCount > 0 && <span className="opacity-30">·</span>}
            {doneCount > 0 && (
              <span style={{ color: colors.status.done }}>{doneCount} done</span>
            )}
            {failedCount > 0 && (
              <>
                <span className="opacity-30">·</span>
                <span style={{ color: colors.status.error }}>{failedCount} failed</span>
              </>
            )}
            {totalDuration > 0 && status !== 'running' && (
              <>
                <span className="opacity-30">·</span>
                <span className="tabular-nums opacity-70">{Math.round(totalDuration)}ms</span>
              </>
            )}
          </button>

          {/* Collapsible command list */}
          {showCommands && (
            <div className="px-3 pb-3 space-y-2">
              {commands.map((c, idx) => {
                const display = String(c.command ?? '');
                const key = `${idx}-${display}`;
                const meta = c.meta || {};
                const stdout = typeof meta.stdout === 'string' ? meta.stdout : '';
                const stderr = typeof meta.stderr === 'string' ? meta.stderr : '';
                const commandCopy = typeof meta.commandCopy === 'string' ? meta.commandCopy : display;
                const showStdout = c.kind === 'cli' && stdout.length > 0;
                const showStderr = c.kind === 'cli' && stderr.length > 0;
                const cmdStatus = c.status;
                const isFailed = cmdStatus === 'failed' || (typeof c.exitCode === 'number' && c.exitCode !== 0);

                return (
                  <div key={key} className="group rounded-sm hover:bg-white/[0.03] transition-colors -mx-1 px-1 py-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <span className="flex-shrink-0 mt-0.5">
                          {cmdStatus === 'started' ? (
                            <Loader2 className="w-3 h-3 animate-spin" style={{ color: colors.status.running }} />
                          ) : isFailed ? (
                            <XCircle className="w-3 h-3" style={{ color: colors.status.error }} />
                          ) : (
                            <Check className="w-3 h-3" style={{ color: colors.status.done }} />
                          )}
                        </span>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-all flex-1 leading-relaxed" style={{ color: colors.text.secondary }}>
                          {display}
                        </pre>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopy(commandCopy, key)}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity flex-shrink-0"
                        title={copiedKey === key ? 'Copied' : 'Copy'}
                      >
                        {copiedKey === key ? <Check className="w-3 h-3" style={{ color: colors.status.done }} /> : <Copy className="w-3 h-3" style={{ color: colors.text.faint }} />}
                      </button>
                    </div>
                    {(showStdout || showStderr) && (
                      <div className="mt-1.5 ml-5 rounded text-xs font-mono overflow-hidden" style={{ backgroundColor: 'rgba(0,0,0,0.15)' }}>
                        {showStdout && <div className="px-2 py-1.5"><pre className="whitespace-pre-wrap break-all leading-relaxed" style={{ color: colors.text.muted }}>{stdout}</pre></div>}
                        {showStderr && <div className="px-2 py-1.5"><pre className="whitespace-pre-wrap break-all leading-relaxed" style={{ color: colors.status.error }}>{stderr}</pre></div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="text-xs" style={{ color: colors.text.faint }}>
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
  pendingMessage?: { content: string; timestamp: string; images?: ImageAttachment[] } | null;
}> = ({ sessionId, pendingMessage }) => {
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
  const [streamingAssistant, setStreamingAssistant] = useState<{ content: string; timestamp: string } | null>(null);

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
      if (event.kind === 'chat.assistant') {
        setStreamingAssistant(null);
      }
      if (idsRef.current.has(event.id)) return;
      idsRef.current.add(event.id);
      setEvents((prev) => {
        const next = [...prev, event];
        next.sort((a, b) => a.seq - b.seq);
        return next;
      });
    };

    const unsubscribe = window.electronAPI.events.onTimelineEvent(handler);
    return () => unsubscribe();
  }, [sessionId]);

  useEffect(() => {
    const unsub = window.electronAPI?.events?.onAssistantStream?.((data) => {
      if (!data || data.sessionId !== sessionId) return;
      const content = (data.content || '').trim();
      if (!content) return;
      setStreamingAssistant({ content, timestamp: new Date().toISOString() });
    });
    return () => { if (unsub) unsub(); };
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
  }, [events.length, pendingMessage?.content, streamingAssistant?.content, loading, scrollToBottom, isAtBottom]);

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

  const items = useMemo(() => buildItems(events), [events]);

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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto relative" onScroll={handleScroll}>
        <div ref={contentRef} className="px-4 py-4">
          <div className="mx-auto max-w-[800px] flex flex-col gap-6">
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

            {streamingAssistant && (
              <div className="space-y-2">
                <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
                  {streamingAssistant.content}
                </div>
                <div className="flex items-center gap-2 text-xs" style={{ color: colors.text.muted }}>
                  <Spinner />
                  <span>Thinking...</span>
                  <span className="opacity-40">·</span>
                  <span className="opacity-60">Press Esc to cancel</span>
                </div>
              </div>
            )}

            {visiblePendingMessage && (
              <div
                className="rounded-lg px-4 py-3"
                style={{
                  backgroundColor: colors.userCard.bg,
                  border: `1px solid ${colors.userCard.border}`,
                }}
              >
                <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: colors.text.primary }}>
                  {visiblePendingMessage.images && visiblePendingMessage.images.length > 0 && (
                    <>
                      {visiblePendingMessage.images.map((img, idx) => (
                        <ImageTag key={img.id} index={idx + 1} />
                      ))}
                      {visiblePendingMessage.content && ' '}
                    </>
                  )}
                  {visiblePendingMessage.content}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: colors.text.muted }}>
                  <Spinner />
                  <span>Sending...</span>
                  <span className="opacity-40">·</span>
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
