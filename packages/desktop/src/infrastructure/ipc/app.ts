import { shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppServices, IpcHandlerTarget } from './types';

export function registerAppHandlers(ipcMain: IpcHandlerTarget, services: AppServices): void {
  const { app } = services;
  const { claudeExecutor, codexExecutor, geminiExecutor } = services;

  let cachedAiToolStatus:
    | { fetchedAtMs: number; data: { claude: unknown; codex: unknown; gemini: unknown } }
    | null = null;
  let inFlightAiToolStatus: Promise<{ claude: unknown; codex: unknown; gemini: unknown }> | null = null;

  // Basic app info handlers
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('get-platform', () => {
    return process.platform;
  });

  ipcMain.handle('is-packaged', () => {
    return app.isPackaged;
  });

  // System utilities
  ipcMain.handle('openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external URL:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' };
    }
  });

  ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
    try {
      const result = await shell.openPath(targetPath);
      if (result) {
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open path' };
    }
  });

  // Welcome tracking handler (for compatibility)
  ipcMain.handle('track-welcome-dismissed', () => {
    // This handler exists for compatibility with other parts of the codebase
    // Our Discord popup logic handles this differently
    console.log('[App] Welcome dismissed (tracked for compatibility)');
    return { success: true };
  });

  // App opens tracking
  ipcMain.handle('app:record-open', (_event, welcomeHidden: boolean, discordShown: boolean = false) => {
    try {
      services.databaseService.recordAppOpen(welcomeHidden, discordShown);
      return { success: true };
    } catch (error) {
      console.error('Failed to record app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to record app open' };
    }
  });

  ipcMain.handle('app:get-last-open', () => {
    try {
      const lastOpen = services.databaseService.getLastAppOpen();
      return { success: true, data: lastOpen };
    } catch (error) {
      console.error('Failed to get last app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get last app open' };
    }
  });

  ipcMain.handle('app:update-discord-shown', () => {
    try {
      services.databaseService.updateLastAppOpenDiscordShown();
      return { success: true };
    } catch (error) {
      console.error('Failed to update discord shown:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update discord shown' };
    }
  });

  // User preferences handlers
  ipcMain.handle('preferences:get', (_event, key: string) => {
    try {
      const value = services.databaseService.getUserPreference(key);
      return { success: true, data: value };
    } catch (error) {
      console.error('Failed to get preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get preference' };
    }
  });

  ipcMain.handle('preferences:set', (_event, key: string, value: string) => {
    try {
      services.databaseService.setUserPreference(key, value);
      return { success: true };
    } catch (error) {
      console.error('Failed to set preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set preference' };
    }
  });

  ipcMain.handle('preferences:get-all', () => {
    try {
      const preferences = services.databaseService.getUserPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get all preferences:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get all preferences' };
    }
  });

  // AI tool availability probe (claude/codex/gemini)
  ipcMain.handle('ai-tools:get-status', async (_event, options?: { force?: boolean }) => {
    const force = options?.force === true;
    const ttlMs = 15_000;
    const now = Date.now();

    if (!force && cachedAiToolStatus && now - cachedAiToolStatus.fetchedAtMs < ttlMs) {
      return { success: true, data: { ...cachedAiToolStatus.data, fetchedAt: new Date(cachedAiToolStatus.fetchedAtMs).toISOString(), cached: true } };
    }

    if (!inFlightAiToolStatus) {
      inFlightAiToolStatus = (async () => {
        const [claude, codex, gemini] = await Promise.all([
          (async () => {
            if (force) claudeExecutor.clearAvailabilityCache();
            return claudeExecutor.getCachedAvailability();
          })(),
          (async () => {
            if (force) codexExecutor.clearAvailabilityCache();
            return codexExecutor.getCachedAvailability();
          })(),
          (async () => {
            if (force) geminiExecutor.clearAvailabilityCache();
            return geminiExecutor.getCachedAvailability();
          })()
        ]);
        return {
          claude: claude ?? { available: false, error: 'Claude executor unavailable' },
          codex: codex ?? { available: false, error: 'Codex executor unavailable' },
          gemini: gemini ?? { available: false, error: 'Gemini executor unavailable' }
        };
      })().finally(() => {
        inFlightAiToolStatus = null;
      });
    }

    try {
      const data = await inFlightAiToolStatus;
      cachedAiToolStatus = { fetchedAtMs: now, data };
      return { success: true, data: { ...data, fetchedAt: new Date(now).toISOString(), cached: false } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // AI tool config probe (model/level) from CLI-owned config files.
  // NOTE: This must NOT leak secrets (tokens, base URLs, etc.). Only return fields we display.
  ipcMain.handle('ai-tools:get-settings', async () => {
    try {
      const home = os.homedir();

      const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
      let claudeModel: string | undefined;
      const claudeSettingsExists = fs.existsSync(claudeSettingsPath);
      if (claudeSettingsExists) {
        try {
          const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
          const parsed = JSON.parse(raw) as { model?: unknown };
          if (typeof parsed.model === 'string') claudeModel = parsed.model;
        } catch {
          // ignore invalid JSON
        }
      }

      const codexConfigPath = path.join(home, '.codex', 'config.toml');
      let codexModel: string | undefined;
      let codexReasoningEffort: string | undefined;
      let codexSandbox: string | undefined;
      let codexAskForApproval: string | undefined;
      const codexConfigExists = fs.existsSync(codexConfigPath);
      if (codexConfigExists) {
        try {
          const raw = fs.readFileSync(codexConfigPath, 'utf8');
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            if (trimmed.startsWith('[')) break; // only parse root table keys

            const match = /^([A-Za-z0-9_\-.]+)\s*=\s*(.+)$/.exec(trimmed);
            if (!match) continue;
            const key = match[1].replace(/^\uFEFF/, '');
            let value = match[2].trim();
            const hash = value.indexOf(' #');
            if (hash >= 0) value = value.slice(0, hash).trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);

            if (key === 'model') codexModel = value;
            if (key === 'model_reasoning_effort') codexReasoningEffort = value;
            if (key === 'sandbox' || key === 'sandbox_mode') codexSandbox = value;
            if (key === 'ask_for_approval' || key === 'ask_for_approval_policy') codexAskForApproval = value;
          }
        } catch {
          // ignore parse issues
        }
      }

      const geminiSettingsPath = path.join(home, '.gemini', 'settings.json');
      let geminiModel: string | undefined;
      const geminiSettingsExists = fs.existsSync(geminiSettingsPath);
      if (geminiSettingsExists) {
        try {
          const raw = fs.readFileSync(geminiSettingsPath, 'utf8');
          const parsed = JSON.parse(raw) as { model?: unknown };
          if (typeof parsed.model === 'string') {
            geminiModel = parsed.model;
          } else if (
            parsed.model &&
            typeof parsed.model === 'object' &&
            'name' in parsed.model &&
            typeof (parsed.model as { name?: unknown }).name === 'string'
          ) {
            geminiModel = (parsed.model as { name: string }).name;
          }
        } catch {
          // ignore invalid JSON
        }
      }

      // Debug-only log for diagnosing detection issues; never include secrets.
      // This will appear in the main process log when the UI opens the CLI selector.
      console.log('[AI Tools] settings probe', {
        home,
        claudeSettingsExists,
        codexConfigExists,
        geminiSettingsExists,
        claudeModel,
        codexModel,
        codexReasoningEffort,
        codexSandbox,
        codexAskForApproval,
        geminiModel,
      });

      return {
        success: true,
        data: {
          claude: {
            model: claudeModel,
          },
          codex: {
            model: codexModel,
            reasoningEffort: codexReasoningEffort,
            sandbox: codexSandbox,
            askForApproval: codexAskForApproval,
          },
          gemini: {
            model: geminiModel,
          }
        }
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Auto-updater handlers
  ipcMain.handle('updater:download', async () => {
    if (services.updateManager) {
      try {
        await services.updateManager.downloadUpdate();
        return { success: true };
      } catch (error) {
        console.error('Failed to download update:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to download update' };
      }
    }
    return { success: false, error: 'UpdateManager not available' };
  });

  ipcMain.handle('updater:install', () => {
    if (services.updateManager) {
      try {
        services.updateManager.quitAndInstall();
        return { success: true };
      } catch (error) {
        console.error('Failed to install update:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to install update' };
      }
    }
    return { success: false, error: 'UpdateManager not available' };
  });
} 
