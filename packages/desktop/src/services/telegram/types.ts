import { Context } from 'grammy';

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

export interface CommandHandler {
  name: string;
  description: string;
  handler: (ctx: Context, args: string) => Promise<void>;
}
