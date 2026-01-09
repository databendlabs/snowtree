/**
 * Executor Types - Common types for CLI tool executors
 * Inspired by vibe-kanban's executor architecture
 */

import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

// ============================================================================
// Executor Types
// ============================================================================

export type ExecutorTool = 'claude' | 'codex';

export interface ExecutorSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  isResume?: boolean;
  agentSessionId?: string;
  model?: string;
  permissionMode?: string;
  // Optional cross-tool execution policies (passed through to executors that support them).
  sandbox?: string;
  askForApproval?: string;
  reasoningEffort?: string;
}

export interface ExecutorProcess {
  pty: IPty;
  panelId: string;
  sessionId: string;
  worktreePath: string;
  stdin?: NodeJS.WritableStream;
  stdout?: NodeJS.ReadableStream;
}

export interface ExecutorAvailability {
  available: boolean;
  error?: string;
  version?: string;
  path?: string;
}

// ============================================================================
// Event Types
// ============================================================================

export interface ExecutorOutputEvent {
  panelId: string;
  sessionId: string;
  type: 'json' | 'stdout' | 'stderr';
  data: unknown;
  timestamp: Date;
}

export interface ExecutorExitEvent {
  panelId: string;
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface ExecutorErrorEvent {
  panelId: string;
  sessionId: string;
  error: string;
}

export interface ExecutorSpawnedEvent {
  panelId: string;
  sessionId: string;
  fullCommand?: string;
}

// ============================================================================
// Protocol Types (Stream JSON / JSON-RPC)
// ============================================================================

export interface ProtocolMessage {
  type: string;
  [key: string]: unknown;
}

// Claude Stream JSON message types
export interface ClaudeSystemMessage {
  type: 'system';
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  apiKeySource?: string;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    id?: string;
    role: string;
    model?: string;
    content: ClaudeContentItem[];
    stop_reason?: string;
  };
  session_id?: string;
}

export interface ClaudeUserMessage {
  type: 'user';
  message: {
    role: string;
    content: ClaudeContentItem[];
  };
  session_id?: string;
}

export interface ClaudeToolUseMessage {
  type: 'tool_use';
  tool_name: string;
  input: Record<string, unknown>;
  session_id?: string;
}

export interface ClaudeToolResultMessage {
  type: 'tool_result';
  result: unknown;
  is_error?: boolean;
  session_id?: string;
}

export interface ClaudeStreamEventMessage {
  type: 'stream_event';
  event: ClaudeStreamEvent;
  session_id?: string;
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: unknown;
  error?: string;
  session_id?: string;
}

export type ClaudeMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeToolUseMessage
  | ClaudeToolResultMessage
  | ClaudeStreamEventMessage
  | ClaudeResultMessage;

// Claude Content Items
export type ClaudeContentItem =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

// Claude Stream Events
export type ClaudeStreamEvent =
  | { type: 'message_start'; message: ClaudeAssistantMessage['message'] }
  | { type: 'content_block_start'; index: number; content_block: ClaudeContentItem }
  | { type: 'content_block_delta'; index: number; delta: ClaudeContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: ClaudeUsage }
  | { type: 'message_stop' };

export type ClaudeContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string };

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ============================================================================
// JSON-RPC Types (for Codex)
// ============================================================================

export interface JsonRpcRequest {
  // Codex app-server uses a JSON-RPC-like protocol and does not require a `jsonrpc` header.
  jsonrpc?: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Codex-specific types
export interface CodexConversationParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
}

export interface CodexApprovalRequest {
  call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface CodexApprovalResponse {
  decision: 'approved' | 'denied' | 'abort';
}

// ============================================================================
// Normalized Log Entry Types (for UI display)
// ============================================================================

export type NormalizedEntryType =
  | 'system_message'
  | 'user_message'
  | 'assistant_message'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'user_question'
  | 'error_message'
  | 'user_feedback';

export interface NormalizedEntry {
  id: string;
  timestamp?: string;
  entryType: NormalizedEntryType;
  content: string;
  metadata?: Record<string, unknown>;
  // Tool-specific fields
  toolName?: string;
  toolStatus?: 'pending' | 'success' | 'failed';
  actionType?: ActionType;
}

export type ActionType =
  | { type: 'file_read'; path: string }
  | { type: 'file_edit'; path: string; changes?: FileChange[] }
  | { type: 'file_write'; path: string; content?: string }
  | { type: 'command_run'; command: string; result?: CommandResult }
  | { type: 'search'; query: string }
  | { type: 'web_fetch'; url: string }
  | { type: 'task_create'; description: string }
  | { type: 'todo_management'; operation: string }
  | { type: 'other'; description: string };

export interface FileChange {
  type: 'edit' | 'write';
  unified_diff?: string;
  content?: string;
}

export interface CommandResult {
  exit_code?: number;
  output?: string;
  success?: boolean;
}

// ============================================================================
// Executor Events
// ============================================================================

export interface ExecutorEvents {
  output: (event: ExecutorOutputEvent) => void;
  exit: (event: ExecutorExitEvent) => void;
  error: (event: ExecutorErrorEvent) => void;
  spawned: (event: ExecutorSpawnedEvent) => void;
  // Normalized entry events for UI
  entry: (entry: NormalizedEntry) => void;
  entryUpdate: (id: string, updates: Partial<NormalizedEntry>) => void;
}
