import { Settings, X, Send } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { useEffect, useState, useCallback } from 'react';
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
  const [telegramStatus, setTelegramStatus] = useState<{ status: string; botUsername?: string; error?: string }>({ status: 'disconnected' });

  // Poll telegram status when dialog is open
  const fetchTelegramStatus = useCallback(async () => {
    if (!isOpen) return;
    try {
      const result = await window.electronAPI.telegram.getStatus();
      if (result.success && result.data) {
        setTelegramStatus(result.data);
      }
    } catch {
      // ignore
    }
  }, [isOpen]);

  useEffect(() => {
    fetchTelegramStatus();
    const interval = setInterval(fetchTelegramStatus, 2000);
    return () => clearInterval(interval);
  }, [fetchTelegramStatus]);

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

              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Default CLI for new sessions
                </label>
                <select
                  value={settings.defaultToolType}
                  onChange={(e) => updateSettings({
                    defaultToolType: e.target.value as typeof settings.defaultToolType
                  })}
                  className="px-3 py-1.5 rounded border text-sm w-40 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="gemini">Gemini</option>
                  <option value="kimi">Kimi</option>
                  <option value="none">None</option>
                </select>
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

          {/* Telegram Remote Control */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--st-text)' }}>
              <Send className="w-4 h-4" />
              Telegram Remote Control
              {telegramStatus.status === 'connected' && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--st-success)', color: 'white' }}>
                  @{telegramStatus.botUsername}
                </span>
              )}
              {telegramStatus.status === 'connecting' && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--st-warning)', color: 'white' }}>
                  Connecting...
                </span>
              )}
              {telegramStatus.status === 'error' && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--st-error)', color: 'white' }}>
                  Error
                </span>
              )}
            </h3>
            {telegramStatus.status === 'connected' && !settings.telegram.allowedChatId && (
              <div className="text-xs p-2 rounded" style={{ backgroundColor: 'var(--st-info-bg)', color: 'var(--st-info)' }}>
                Bot connected! Send <code className="px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--st-editor)' }}>chat id</code> to @{telegramStatus.botUsername} to get your Chat ID.
              </div>
            )}
            {telegramStatus.status === 'error' && telegramStatus.error && (
              <div className="text-xs p-2 rounded" style={{ backgroundColor: 'var(--st-error-bg)', color: 'var(--st-error)' }}>
                {telegramStatus.error}
              </div>
            )}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Enable
                </label>
                <button
                  type="button"
                  onClick={() => updateSettings({
                    telegram: { ...settings.telegram, enabled: !settings.telegram.enabled }
                  })}
                  className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
                  role="switch"
                  aria-checked={settings.telegram.enabled}
                  style={{
                    backgroundColor: settings.telegram.enabled ? 'var(--st-accent)' : 'var(--st-border)',
                    transition: 'background-color 0.2s'
                  }}
                >
                  <span
                    className="block h-4 w-4 bg-white rounded-full transition-transform"
                    style={{ transform: settings.telegram.enabled ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                  Bot Token
                </label>
                <input
                  type="password"
                  value={settings.telegram.botToken}
                  onChange={(e) => updateSettings({
                    telegram: { ...settings.telegram, botToken: e.target.value }
                  })}
                  placeholder="123456:ABC-DEF..."
                  className="px-3 py-1.5 rounded border text-sm w-64 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                    Your Chat ID
                  </label>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--st-text-faint)' }}>
                    Send chat id to your bot to get this
                  </p>
                </div>
                <input
                  type="text"
                  value={settings.telegram.allowedChatId}
                  onChange={(e) => updateSettings({
                    telegram: { ...settings.telegram, allowedChatId: e.target.value }
                  })}
                  placeholder="123456789"
                  className="px-3 py-1.5 rounded border text-sm w-40 st-focus-ring"
                  style={{
                    backgroundColor: 'var(--st-editor)',
                    borderColor: 'var(--st-border)',
                    color: 'var(--st-text)',
                  }}
                />
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
