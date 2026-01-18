import type { ToolPanel } from '@snowtree/core/types/panels';
import type { DatabaseService } from '../../infrastructure/database/database';
import { panelManager as defaultPanelManager } from '../panels/PanelManager';

type TerminalOutputType = 'stdout' | 'stderr' | 'system' | 'json' | 'error';

export class TerminalPanelCoordinator {
  private panelIdBySession = new Map<string, string>();

  constructor(
    private db: DatabaseService,
    private panels = defaultPanelManager
  ) {}

  getPanel(sessionId: string): ToolPanel | null {
    const cachedId = this.panelIdBySession.get(sessionId);
    if (cachedId) {
      const cached = this.panels.getPanel(cachedId);
      if (cached) return cached;
      this.panelIdBySession.delete(sessionId);
    }

    const panels = this.panels.getPanelsForSession(sessionId);
    const terminalPanel = panels.find(panel => panel.type === 'terminal') || null;
    if (terminalPanel) {
      this.panelIdBySession.set(sessionId, terminalPanel.id);
    }
    return terminalPanel;
  }

  async ensurePanel(sessionId: string, worktreePath?: string): Promise<ToolPanel> {
    const existing = this.getPanel(sessionId);
    if (existing) return existing;

    const panel = await this.panels.createPanel({
      sessionId,
      type: 'terminal',
      title: 'Terminal',
      initialState: {
        isInitialized: false,
        cwd: worktreePath
      }
    }, { activate: false });

    this.panelIdBySession.set(sessionId, panel.id);
    return panel;
  }

  recordOutput(sessionId: string, type: TerminalOutputType, data: string): { panelId?: string; outputId?: number } {
    const terminalPanel = this.getPanel(sessionId);
    if (!terminalPanel) {
      this.db.addSessionOutput(sessionId, type, data);
      return {};
    }

    try {
      const outputId = this.db.addPanelOutput(terminalPanel.id, type, data);
      return { panelId: terminalPanel.id, outputId };
    } catch {
      this.panelIdBySession.delete(sessionId);
      this.db.addSessionOutput(sessionId, type, data);
      return {};
    }
  }

  clearSession(sessionId: string): void {
    this.panelIdBySession.delete(sessionId);
  }
}
