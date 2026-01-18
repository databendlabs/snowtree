import { panelManager } from '../../features/panels/PanelManager';
import type { CreatePanelRequest, ToolPanel } from '@snowtree/core/types/panels';
import type { IpcHandlerTarget } from './types';

export function registerPanelHandlers(ipcMain: IpcHandlerTarget): void {
  ipcMain.handle('panels:create', async (_event, request: CreatePanelRequest) => {
    try {
      const panel = await panelManager.createPanel(request);
      return { success: true, data: panel };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create panel' };
    }
  });

  ipcMain.handle('panels:list', async (_event, sessionId: string) => {
    try {
      const panels = panelManager.getPanelsForSession(sessionId);
      return { success: true, data: panels };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list panels' };
    }
  });

  ipcMain.handle('panels:update', async (_event, panelId: string, updates: Partial<ToolPanel>) => {
    try {
      await panelManager.updatePanel(panelId, updates);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update panel' };
    }
  });
}
