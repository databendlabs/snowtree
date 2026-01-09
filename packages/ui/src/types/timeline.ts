export type TimelineEventKind =
  | 'chat.user'
  | 'chat.assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'user_question'
  | 'cli.command'
  | 'git.command'
  | 'worktree.command';

export type TimelineEventStatus = 'started' | 'finished' | 'failed' | 'pending' | 'answered';

// Base event interface with common fields
// Note: All fields are optional to support different event types
export interface BaseTimelineEvent {
  id: number;
  session_id: string;
  seq: number;
  timestamp: string;
  panel_id?: string;
  // Common optional fields used by multiple event types
  status?: TimelineEventStatus;
  command?: string;
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  tool?: string;
  meta?: Record<string, unknown>;
}

// Chat events
export interface ChatUserEvent extends BaseTimelineEvent {
  kind: 'chat.user';
  meta?: Record<string, unknown>;
}

export interface ChatAssistantEvent extends BaseTimelineEvent {
  kind: 'chat.assistant';
  meta?: Record<string, unknown>;
}

// Thinking event
export interface ThinkingEvent extends BaseTimelineEvent {
  kind: 'thinking';
  content: string;
  is_streaming?: boolean;
  thinking_id?: string;  // Unique ID for streaming updates
}

// Tool use event
export interface ToolUseEvent extends BaseTimelineEvent {
  kind: 'tool_use';
  tool_name: string;
  tool_input?: string; // JSON string
  action_type?: string; // JSON string of ActionType
}

// Tool result event
export interface ToolResultEvent extends BaseTimelineEvent {
  kind: 'tool_result';
  tool_use_id?: string;
  tool_name?: string;
  content?: string;
  is_error?: boolean;
  exit_code?: number;
}

// User question event (for AskUserQuestion tool)
export interface UserQuestionEvent extends BaseTimelineEvent {
  kind: 'user_question';
  tool_use_id: string;
  questions: string; // JSON string
  status: 'pending' | 'answered';
  answers?: string; // JSON string
}

// Command events
export interface CommandEvent extends BaseTimelineEvent {
  kind: 'cli.command' | 'git.command' | 'worktree.command';
  status?: TimelineEventStatus;
  command?: string;
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  tool?: string;
  meta?: Record<string, unknown>;
}

// Union type for all timeline events
export type TimelineEvent =
  | ChatUserEvent
  | ChatAssistantEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | UserQuestionEvent
  | CommandEvent;
