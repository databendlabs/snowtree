/**
 * Telegram-specific types
 *
 * These are only for Telegram channel configuration.
 * Command types are now in ../channels/types.ts
 */

import type { ChannelConfig } from '../channels/types';

export interface TelegramSettings extends ChannelConfig {
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
