/**
 * Channel API Types
 *
 * Abstract interface for remote control channels (Telegram, Slack, Discord, etc.)
 * All channel-specific implementations should use these types.
 */

// ============================================================================
// Command Types (Channel-agnostic)
// ============================================================================

export type SnowTreeCommandName =
  | 'get_chat_id'
  | 'list_projects'
  | 'open_project'
  | 'list_sessions'
  | 'select_session'
  | 'new_session'
  | 'status'
  | 'send_message'
  | 'switch_executor'
  | 'stop_session'
  | 'delete_session'
  | 'help'
  | 'unknown';

export interface SnowTreeCommandDefinition {
  name: SnowTreeCommandName;
  description: string;
  args?: string;
}

export interface SnowTreeCommandRequest {
  name: SnowTreeCommandName;
  args?: Record<string, string>;
  attachments?: string[];
  rawText?: string;
}

export interface SnowTreeCommandResponse {
  message?: string;
  parseMode?: 'Markdown' | 'HTML';
  showTyping?: boolean;
  error?: string;
}

// ============================================================================
// Context Types
// ============================================================================

export interface ChannelContext {
  activeProjectId: number | null;
  activeSessionId: string | null;
}

// ============================================================================
// Channel Interface
// ============================================================================

export interface ChannelAdapter {
  /** Unique identifier for this channel type */
  readonly channelType: string;

  /** Start the channel connection */
  start(config: ChannelConfig): Promise<void>;

  /** Stop the channel connection */
  stop(): Promise<void>;

  /** Send a message to a specific chat/channel */
  sendMessage(chatId: string | number, text: string, options?: MessageOptions): Promise<void>;

  /** Get current connection state */
  getState(): ChannelState;

  /** Check if a user is authorized */
  isAuthorized(userId: string | number): boolean;
}

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface ChannelState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageOptions {
  parseMode?: 'Markdown' | 'HTML';
  replyToMessageId?: string | number;
}

// ============================================================================
// Message Handler Types
// ============================================================================

export interface IncomingMessage {
  channelType: string;
  chatId: string | number;
  userId: string | number;
  text: string;
  attachments?: MessageAttachment[];
  replyToMessageId?: string | number;
  metadata?: Record<string, unknown>;
}

export interface MessageAttachment {
  type: 'image' | 'document' | 'audio' | 'video';
  localPath: string;
  originalName?: string;
  mimeType?: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<SnowTreeCommandResponse>;
