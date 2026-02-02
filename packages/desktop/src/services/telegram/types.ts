export interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  allowedChatId: string;
}

export type TelegramStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TelegramState {
  status: TelegramStatus;
  error?: string;
  botUsername?: string;
}

export interface TelegramContext {
  activeProjectId: number | null;
  activeSessionId: string | null;
}

export type TelegramCommandName =
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

export interface TelegramCommandDefinition {
  name: TelegramCommandName;
  description: string;
  args?: string;
}

export interface TelegramCommandRequest {
  name: TelegramCommandName;
  args?: Record<string, string>;
  rawText: string;
  attachments?: string[];
}

export interface TelegramCommandResponse {
  message?: string;
  parseMode?: 'Markdown' | 'HTML';
  showTyping?: boolean;
}
