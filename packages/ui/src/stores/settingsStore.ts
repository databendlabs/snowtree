import { create } from 'zustand';

const STORAGE_KEY = 'snowtree-settings';

export interface AppSettings {
  // Theme & Appearance
  theme: 'light' | 'dark' | 'system';
  fontSize: number;

  // AI Tool Settings
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
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontSize: 15,
  enabledProviders: {
    claude: true,
    codex: true,
    gemini: true,
    kimi: true,
  },
  terminalFontSize: 13,
  terminalScrollback: 1000,
  autoDeleteBranchOnWorktreeRemove: false,
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
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        enabledProviders: {
          ...DEFAULT_SETTINGS.enabledProviders,
          ...(parsed.enabledProviders || {}),
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
    const newSettings = { ...get().settings, ...updates };
    saveSettings(newSettings);
    set({ settings: newSettings });
  },

  resetSettings: () => {
    saveSettings(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },
}));
