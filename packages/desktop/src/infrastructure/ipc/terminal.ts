import type { AppServices, IpcHandlerTarget } from './types';

export function registerTerminalHandlers(ipcMain: IpcHandlerTarget, services: AppServices): void {
  const { sessionManager } = services;

  ipcMain.handle('terminals:create', async (_event, sessionId: string, options?: { title?: string }) => {
    try {
      const terminal = await sessionManager.createTerminalSessionForPanel(sessionId, {
        title: options?.title,
      });
      return { success: true, data: terminal };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create terminal' };
    }
  });

  ipcMain.handle('terminals:list', async (_event, sessionId: string) => {
    try {
      const terminals = sessionManager.listTerminalSessions(sessionId);
      return { success: true, data: terminals };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list terminals' };
    }
  });

  ipcMain.handle('terminals:input', async (_event, terminalId: string, data: string) => {
    try {
      sessionManager.sendTerminalInputToTerminal(terminalId, data);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send terminal input' };
    }
  });

  ipcMain.handle('terminals:resize', async (_event, terminalId: string, cols: number, rows: number) => {
    try {
      sessionManager.resizeTerminalById(terminalId, cols, rows);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resize terminal' };
    }
  });

  ipcMain.handle('terminals:close', async (_event, terminalId: string) => {
    try {
      await sessionManager.closeTerminalById(terminalId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to close terminal' };
    }
  });
}
