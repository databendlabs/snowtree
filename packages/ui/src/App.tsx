import { Sidebar } from './components/Sidebar';
import { MainLayout } from './components/layout';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useWorkspaceStageSync } from './hooks/useWorkspaceStageSync';
import { ErrorDialog } from './components/ErrorDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { useErrorStore } from './stores/errorStore';
import { useSettingsStore } from './stores/settingsStore';
import { useThemeStore } from './stores/themeStore';
import { useEffect } from 'react';

function getResolvedTheme(themeSetting: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (themeSetting !== 'system') return themeSetting;

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export default function App() {
  useIPCEvents();
  useWorkspaceStageSync();
  const { currentError, clearError } = useErrorStore();
  const { settings, isLoaded, loadSettings } = useSettingsStore();
  const { setTheme } = useThemeStore();

  // Load settings from file on mount
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Initialize theme and font size on mount
  useEffect(() => {
    // Apply theme
    const resolvedTheme = getResolvedTheme(settings.theme);
    setTheme(resolvedTheme);

    // Listen for system theme changes
    if (settings.theme === 'system' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        setTheme(e.matches ? 'dark' : 'light');
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [settings.theme, setTheme]);

  // Apply font size and font family
  useEffect(() => {
    document.body.style.fontSize = `${settings.fontSize}px`;
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize]);

  useEffect(() => {
    const el = document.documentElement;
    if (settings.fontFamily) {
      el.style.setProperty('--st-font-sans', `'${settings.fontFamily}', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
    } else {
      el.style.removeProperty('--st-font-sans');
    }
  }, [settings.fontFamily]);

  useEffect(() => {
    const el = document.documentElement;
    if (settings.terminalFontFamily) {
      el.style.setProperty('--st-font-mono', `'${settings.terminalFontFamily}', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`);
    } else {
      el.style.removeProperty('--st-font-mono');
    }
  }, [settings.terminalFontFamily]);

  // Manage Telegram bot based on settings (only after settings loaded)
  useEffect(() => {
    if (!isLoaded) return;
    if (settings.telegram.enabled && settings.telegram.botToken) {
      window.electronAPI.telegram.start(settings.telegram);
    } else {
      window.electronAPI.telegram.stop();
    }
  }, [isLoaded, settings.telegram.enabled, settings.telegram.botToken, settings.telegram.allowedChatId]);

  return (
    <div
      className="h-screen w-screen flex overflow-hidden relative"
      style={{
        paddingTop: 'var(--st-titlebar-gap)',
        backgroundColor: 'var(--st-bg)',
        color: 'var(--st-text)'
      }}
    >
      {/* Drag region for macOS hiddenInset titlebar */}
      <div
        className="absolute top-0 left-0 right-0 z-50"
        style={{
          height: 'var(--st-titlebar-gap)',
          // @ts-expect-error - webkit vendor prefix
          WebkitAppRegion: 'drag',
        }}
      />
      <Sidebar />
      <MainLayout />

      {currentError && (
        <ErrorDialog
          isOpen={true}
          onClose={clearError}
          title={currentError.title}
          error={currentError.error}
          details={currentError.details}
          command={currentError.command}
        />
      )}

      <SettingsDialog />
    </div>
  );
}
