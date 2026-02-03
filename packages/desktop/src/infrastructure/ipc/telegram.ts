import type { IpcMain } from 'electron';
import type { AppServices, IPCResponse } from './types';
import type { TelegramSettings, TelegramState } from '../../services/telegram';

export function registerTelegramHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { telegramService } = services;

  ipcMain.handle('telegram:get-status', async (): Promise<IPCResponse<TelegramState>> => {
    if (!telegramService) {
      return { success: false, error: 'Telegram service not initialized' };
    }
    return { success: true, data: telegramService.getState() };
  });

  ipcMain.handle('telegram:start', async (_, settings: TelegramSettings): Promise<IPCResponse> => {
    if (!telegramService) {
      return { success: false, error: 'Telegram service not initialized' };
    }
    try {
      await telegramService.start(settings);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:stop', async (): Promise<IPCResponse> => {
    if (!telegramService) {
      return { success: false, error: 'Telegram service not initialized' };
    }
    try {
      await telegramService.stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:restart', async (_, settings: TelegramSettings): Promise<IPCResponse> => {
    if (!telegramService) {
      return { success: false, error: 'Telegram service not initialized' };
    }
    try {
      await telegramService.restart(settings);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:send-message', async (_, chatId: string, text: string): Promise<IPCResponse> => {
    if (!telegramService) {
      return { success: false, error: 'Telegram service not initialized' };
    }
    try {
      await telegramService.sendMessage(chatId, text);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
