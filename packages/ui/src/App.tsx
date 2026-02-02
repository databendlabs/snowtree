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
  const { settings } = useSettingsStore();
  const { setTheme } = useThemeStore();

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

  // Apply font size
  useEffect(() => {
    // Apply to body and root elements to ensure it takes effect
    document.body.style.fontSize = `${settings.fontSize}px`;
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize]);

  // Manage Telegram bot based on settings
  useEffect(() => {
    if (settings.telegram.enabled && settings.telegram.botToken) {
      window.electronAPI.telegram.start(settings.telegram);
    } else {
      window.electronAPI.telegram.stop();
    }
  }, [settings.telegram.enabled, settings.telegram.botToken, settings.telegram.allowedChatId]);

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
