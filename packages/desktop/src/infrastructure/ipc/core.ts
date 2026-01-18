import type { AppServices, IpcHandlerTarget } from './types';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerGitHandlers } from './git';
import { registerPanelHandlers } from './panels';
import { registerTerminalHandlers } from './terminal';

/**
 * Register IPC handlers that don't rely on Electron runtime primitives.
 * These can be reused by the headless HTTP server.
 */
export function registerCoreIpcHandlers(ipcMain: IpcHandlerTarget, services: AppServices): void {
  registerSessionHandlers(ipcMain, services);
  registerProjectHandlers(ipcMain, services);
  registerGitHandlers(ipcMain, services);
  registerPanelHandlers(ipcMain);
  registerTerminalHandlers(ipcMain, services);
}
