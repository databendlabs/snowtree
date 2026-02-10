import { create } from 'zustand';

export interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  allowedChatId: string;
}

export interface ProviderConfig {
  envVars: Record<string, string>;
  extraArgs: string;
}

export interface AppSettings {
  // Theme & Appearance
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  fontFamily: string;

  // AI Tool Settings
  defaultToolType: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
  enabledProviders: {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    kimi: boolean;
  };

  // Terminal
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;

  // Worktree
  autoDeleteBranchOnWorktreeRemove: boolean;

  // Telegram Remote Control
  telegram: TelegramSettings;

  // Per-provider custom configuration
  providerConfigs: {
    claude: ProviderConfig;
    codex: ProviderConfig;
    gemini: ProviderConfig;
    kimi: ProviderConfig;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontSize: 15,
  fontFamily: '',
  defaultToolType: 'claude',
  enabledProviders: {
    claude: true,
    codex: true,
    gemini: true,
    kimi: true,
  },
  terminalFontSize: 13,
  terminalFontFamily: '',
  terminalScrollback: 1000,
  autoDeleteBranchOnWorktreeRemove: false,
  telegram: {
    enabled: false,
    botToken: '',
    allowedChatId: '',
  },
  providerConfigs: {
    claude: { envVars: {}, extraArgs: '' },
    codex: { envVars: {}, extraArgs: '' },
    gemini: { envVars: {}, extraArgs: '' },
    kimi: { envVars: {}, extraArgs: '' },
  },
};

interface SettingsStore {
  settings: AppSettings;
  isOpen: boolean;
  isLoaded: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
  resetSettings: () => void;
  loadSettings: () => Promise<void>;
}

function mergeSettings(stored: Partial<AppSettings> | null): AppSettings {
  if (!stored) return DEFAULT_SETTINGS;

  const resolvedDefaultToolType =
    stored.defaultToolType === 'codex'
    || stored.defaultToolType === 'gemini'
    || stored.defaultToolType === 'kimi'
    || stored.defaultToolType === 'none'
    || stored.defaultToolType === 'claude'
      ? stored.defaultToolType
      : DEFAULT_SETTINGS.defaultToolType;

  const storedPC = stored.providerConfigs as Partial<AppSettings['providerConfigs']> | undefined;
  const mergedProviderConfigs = {
    claude: { ...DEFAULT_SETTINGS.providerConfigs.claude, ...storedPC?.claude },
    codex: { ...DEFAULT_SETTINGS.providerConfigs.codex, ...storedPC?.codex },
    gemini: { ...DEFAULT_SETTINGS.providerConfigs.gemini, ...storedPC?.gemini },
    kimi: { ...DEFAULT_SETTINGS.providerConfigs.kimi, ...storedPC?.kimi },
  };

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    defaultToolType: resolvedDefaultToolType,
    enabledProviders: {
      ...DEFAULT_SETTINGS.enabledProviders,
      ...(stored.enabledProviders || {}),
    },
    telegram: {
      ...DEFAULT_SETTINGS.telegram,
      ...(stored.telegram || {}),
    },
    providerConfigs: mergedProviderConfigs,
  };
}

async function saveSettingsToFile(settings: AppSettings): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    const api = window.electronAPI?.settings;
    if (api?.save) {
      await api.save(settings);
    }
  } catch (error) {
    console.error('Failed to save settings to file:', error);
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isOpen: false,
  isLoaded: false,

  loadSettings: async () => {
    if (typeof window === 'undefined') return;

    try {
      const api = window.electronAPI?.settings;
      if (api?.load) {
        const result = await api.load();
        if (result.success && result.data) {
          const merged = mergeSettings(result.data as Partial<AppSettings>);
          set({ settings: merged, isLoaded: true });
          return;
        }
      }
    } catch (error) {
      console.error('Failed to load settings from file:', error);
    }

    set({ isLoaded: true });
  },

  openSettings: () => set({ isOpen: true }),

  closeSettings: () => set({ isOpen: false }),

  updateSettings: (updates) => {
    const previousSettings = get().settings;
    const newSettings = { ...previousSettings, ...updates };
    void saveSettingsToFile(newSettings);
    set({ settings: newSettings });

    if (previousSettings.defaultToolType !== newSettings.defaultToolType && typeof window !== 'undefined') {
      const preferences = window.electronAPI?.preferences;
      if (preferences?.set) {
        void preferences.set('defaultToolType', newSettings.defaultToolType);
      }
    }
  },

  resetSettings: () => {
    void saveSettingsToFile(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });

    if (typeof window !== 'undefined') {
      const preferences = window.electronAPI?.preferences;
      if (preferences?.set) {
        void preferences.set('defaultToolType', DEFAULT_SETTINGS.defaultToolType);
      }
    }
  },
}));
