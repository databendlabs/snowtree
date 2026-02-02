import { create } from 'zustand';

const STORAGE_KEY = 'snowtree-settings';

export interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  allowedChatId: string;
}

export interface AppSettings {
  // Theme & Appearance
  theme: 'light' | 'dark' | 'system';
  fontSize: number;

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
  terminalScrollback: number;

  // Worktree
  autoDeleteBranchOnWorktreeRemove: boolean;

  // Telegram Remote Control
  telegram: TelegramSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontSize: 15,
  defaultToolType: 'claude',
  enabledProviders: {
    claude: true,
    codex: true,
    gemini: true,
    kimi: true,
  },
  terminalFontSize: 13,
  terminalScrollback: 1000,
  autoDeleteBranchOnWorktreeRemove: false,
  telegram: {
    enabled: false,
    botToken: '',
    allowedChatId: '',
  },
};

interface SettingsStore {
  settings: AppSettings;
  isOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>;
      const resolvedDefaultToolType =
        parsed.defaultToolType === 'codex'
        || parsed.defaultToolType === 'gemini'
        || parsed.defaultToolType === 'kimi'
        || parsed.defaultToolType === 'none'
        || parsed.defaultToolType === 'claude'
          ? parsed.defaultToolType
          : DEFAULT_SETTINGS.defaultToolType;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        defaultToolType: resolvedDefaultToolType,
        enabledProviders: {
          ...DEFAULT_SETTINGS.enabledProviders,
          ...(parsed.enabledProviders || {}),
        },
        telegram: {
          ...DEFAULT_SETTINGS.telegram,
          ...(parsed.telegram || {}),
        },
      };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }

  return DEFAULT_SETTINGS;
}

function saveSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: loadSettings(),
  isOpen: false,

  openSettings: () => set({ isOpen: true }),

  closeSettings: () => set({ isOpen: false }),

  updateSettings: (updates) => {
    const previousSettings = get().settings;
    const newSettings = { ...previousSettings, ...updates };
    saveSettings(newSettings);
    set({ settings: newSettings });

    if (previousSettings.defaultToolType !== newSettings.defaultToolType && typeof window !== 'undefined') {
      const preferences = window.electronAPI?.preferences;
      if (preferences?.set) {
        void preferences.set('defaultToolType', newSettings.defaultToolType);
      }
    }
  },

  resetSettings: () => {
    saveSettings(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });

    if (typeof window !== 'undefined') {
      const preferences = window.electronAPI?.preferences;
      if (preferences?.set) {
        void preferences.set('defaultToolType', DEFAULT_SETTINGS.defaultToolType);
      }
    }
  },
}));
