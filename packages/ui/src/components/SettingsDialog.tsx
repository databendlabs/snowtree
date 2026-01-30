import { Settings, X } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { useEffect } from 'react';
import { ClaudeIcon, CodexIcon, GeminiIcon, KimiIcon } from './icons/ProviderIcons';

function getResolvedTheme(themeSetting: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (themeSetting !== 'system') return themeSetting;

  // Detect system theme
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export function SettingsDialog() {
  const { isOpen, closeSettings, settings, updateSettings, resetSettings } = useSettingsStore();
  const { setTheme } = useThemeStore();

  // Sync theme when settings change or system preference changes
  useEffect(() => {
    const resolvedTheme = getResolvedTheme(settings.theme);
    setTheme(resolvedTheme);

    // Listen for system theme changes when in system mode
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
    if (typeof document === 'undefined') return;

    // Apply to body and root elements to ensure it takes effect
    document.body.style.fontSize = `${settings.fontSize}px`;
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <div
        className="w-full max-w-3xl rounded-xl border shadow-2xl overflow-y-hidden overflow-x-visible flex flex-col max-h-[80vh]"
        style={{
          borderColor: 'color-mix(in srgb, var(--st-border) 70%, transparent)',
          backgroundColor: 'var(--st-surface)',
          color: 'var(--st-text)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 px-4 py-3 border-b flex-shrink-0"
          style={{ borderColor: 'color-mix(in srgb, var(--st-border) 70%, transparent)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Settings className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--st-accent)' }} />
            <div className="text-sm font-medium" style={{ color: 'var(--st-text)' }}>Settings</div>
          </div>
          <button
            type="button"
            onClick={closeSettings}
            className="p-1.5 rounded st-hoverable st-focus-ring"
            title="Close"
          >
            <X className="w-4 h-4" style={{ color: 'var(--st-text-faint)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-6 overflow-y-auto overflow-x-visible flex-1">
          {/* Theme & Appearance */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--st-text)' }}>
              Theme & Appearance
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Theme
                </label>
                <select
                  value={settings.theme}
                  onChange={(e) => updateSettings({ theme: e.target.value as 'light' | 'dark' | 'system' })}
                  className="px-3 py-1.5 rounded border text-sm st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Font Size
                </label>
                <input
                  type="number"
                  value={settings.fontSize}
                  onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value) || 15 })}
                  min="10"
                  max="24"
                  className="px-3 py-1.5 rounded border text-sm w-20 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                />
              </div>
            </div>
          </section>

          {/* AI Tool Settings */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--st-text)' }}>
              AI Providers
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClaudeIcon className="w-4 h-4 flex-shrink-0" />
                  <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                    Claude
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    enabledProviders: { ...settings.enabledProviders, claude: !settings.enabledProviders.claude }
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.enabledProviders.claude}
                  style={{
                    backgroundColor: settings.enabledProviders.claude ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.enabledProviders.claude ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CodexIcon className="w-4 h-4 flex-shrink-0" />
                  <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                    Codex
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    enabledProviders: { ...settings.enabledProviders, codex: !settings.enabledProviders.codex }
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.enabledProviders.codex}
                  style={{
                    backgroundColor: settings.enabledProviders.codex ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.enabledProviders.codex ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GeminiIcon className="w-4 h-4 flex-shrink-0" />
                  <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                    Gemini
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    enabledProviders: { ...settings.enabledProviders, gemini: !settings.enabledProviders.gemini }
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.enabledProviders.gemini}
                  style={{
                    backgroundColor: settings.enabledProviders.gemini ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.enabledProviders.gemini ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <KimiIcon className="w-4 h-4 flex-shrink-0" />
                  <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                    Kimi
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    enabledProviders: { ...settings.enabledProviders, kimi: !settings.enabledProviders.kimi }
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.enabledProviders.kimi}
                  style={{
                    backgroundColor: settings.enabledProviders.kimi ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.enabledProviders.kimi ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* Terminal Settings */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--st-text)' }}>
              Terminal Settings
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Font Size
                </label>
                <input
                  type="number"
                  value={settings.terminalFontSize}
                  onChange={(e) => updateSettings({ terminalFontSize: parseInt(e.target.value) || 13 })}
                  min="8"
                  max="24"
                  className="px-3 py-1.5 rounded border text-sm w-20 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Scrollback Lines
                </label>
                <input
                  type="number"
                  value={settings.terminalScrollback}
                  onChange={(e) => updateSettings({ terminalScrollback: parseInt(e.target.value) || 1000 })}
                  min="100"
                  max="10000"
                  step="100"
                  className="px-3 py-1.5 rounded border text-sm w-24 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                />
              </div>
            </div>
          </section>

          {/* Worktree Settings */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--st-text)' }}>
              Worktree Settings
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Auto-delete branch on worktree remove
                </label>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    autoDeleteBranchOnWorktreeRemove: !settings.autoDeleteBranchOnWorktreeRemove
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.autoDeleteBranchOnWorktreeRemove}
                  style={{
                    backgroundColor: settings.autoDeleteBranchOnWorktreeRemove ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.autoDeleteBranchOnWorktreeRemove ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 px-5 py-3 border-t flex-shrink-0"
          style={{ borderColor: 'color-mix(in srgb, var(--st-border) 70%, transparent)' }}
        >
          <button
            type="button"
            onClick={resetSettings}
            className="px-3 py-1.5 rounded text-sm st-hoverable st-focus-ring"
            style={{ color: 'var(--st-text-muted)' }}
          >
            Reset to Defaults
          </button>
          <button
            type="button"
            onClick={closeSettings}
            className="px-4 py-1.5 rounded text-sm font-medium st-focus-ring"
            style={{
              backgroundColor: 'var(--st-accent)',
              color: 'white',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
