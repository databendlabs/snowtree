import { ipcMain } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerDialogHandlers } from './dialog';
import { registerGitHandlers } from './git';
import { registerPanelHandlers } from './panels';
import { registerTelegramHandlers } from './telegram';

export function registerIpcHandlers(services: AppServices): void {
  registerAppHandlers(ipcMain, services);
  registerSessionHandlers(ipcMain, services);
  registerProjectHandlers(ipcMain, services);
  registerDialogHandlers(ipcMain, services);
  registerGitHandlers(ipcMain, services);
  registerPanelHandlers(ipcMain);
  registerTelegramHandlers(ipcMain, services);
}

// Re-export types
export type { AppServices, IPCResponse } from './types'; 
