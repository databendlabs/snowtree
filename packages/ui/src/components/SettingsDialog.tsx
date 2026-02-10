import { Settings, X, Send, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useSettingsStore, type ProviderConfig } from '../stores/settingsStore';
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

function isSensitiveKey(key: string): boolean {
  return /token|key|secret|password|credential/i.test(key);
}

function ProviderAdvancedConfig({
  provider,
  config,
  onChange,
}: {
  provider: string;
  config: ProviderConfig;
  onChange: (config: ProviderConfig) => void;
}) {
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');

  const placeholders: Record<string, string> = {
    claude: 'e.g. --settings ~/.claude/settings.json --model sonnet',
    codex: 'e.g. -c model="o3" -p my-profile',
    gemini: 'e.g. --model gemini-2.5-pro --sandbox',
    kimi: 'e.g. --config-file ~/.kimi/custom.toml --model k2',
  };

  const addEnvVar = () => {
    const key = newEnvKey.trim();
    if (!key) return;
    onChange({ ...config, envVars: { ...config.envVars, [key]: newEnvValue } });
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const removeEnvVar = (key: string) => {
    const next = { ...config.envVars };
    delete next[key];
    onChange({ ...config, envVars: next });
  };

  const updateEnvVar = (key: string, value: string) => {
    onChange({ ...config, envVars: { ...config.envVars, [key]: value } });
  };

  return (
    <div className="ml-6 mt-2 space-y-2 text-xs" style={{ color: 'var(--st-text-muted)' }}>
      <div className="space-y-1">
        <label className="text-xs" style={{ color: 'var(--st-text-faint)' }}>
          Extra CLI Arguments
        </label>
        <input
          type="text"
          value={config.extraArgs}
          onChange={(e) => onChange({ ...config, extraArgs: e.target.value })}
          placeholder={placeholders[provider] || 'e.g. --flag value'}
          className="w-full px-2 py-1 rounded border text-xs st-focus-ring"
          style={{
            backgroundColor: 'var(--st-editor)',
            borderColor: 'var(--st-border)',
            color: 'var(--st-text)',
          }}
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs" style={{ color: 'var(--st-text-faint)' }}>
          Environment Variables
        </label>
        {Object.entries(config.envVars).map(([key, value]) => (
          <div key={key} className="flex items-center gap-1">
            <input
              type="text"
              value={key}
              readOnly
              className="flex-1 px-2 py-1 rounded border text-xs"
              style={{
                backgroundColor: 'var(--st-editor)',
                borderColor: 'var(--st-border)',
                color: 'var(--st-text-muted)',
                opacity: 0.8,
              }}
            />
            <span style={{ color: 'var(--st-text-faint)' }}>=</span>
            <input
              type={isSensitiveKey(key) ? 'password' : 'text'}
              value={value}
              onChange={(e) => updateEnvVar(key, e.target.value)}
              className="flex-[2] px-2 py-1 rounded border text-xs st-focus-ring"
              style={{
                backgroundColor: 'var(--st-editor)',
                borderColor: 'var(--st-border)',
                color: 'var(--st-text)',
              }}
            />
            <button
              type="button"
              onClick={() => removeEnvVar(key)}
              className="p-0.5 rounded st-hoverable"
              title="Remove"
            >
              <Trash2 className="w-3 h-3" style={{ color: 'var(--st-text-faint)' }} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newEnvKey}
            onChange={(e) => setNewEnvKey(e.target.value)}
            placeholder="VAR_NAME"
            className="flex-1 px-2 py-1 rounded border text-xs st-focus-ring"
            style={{
              backgroundColor: 'var(--st-editor)',
              borderColor: 'var(--st-border)',
              color: 'var(--st-text)',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') addEnvVar(); }}
          />
          <span style={{ color: 'var(--st-text-faint)' }}>=</span>
          <input
            type={isSensitiveKey(newEnvKey) ? 'password' : 'text'}
            value={newEnvValue}
            onChange={(e) => setNewEnvValue(e.target.value)}
            placeholder="value"
            className="flex-[2] px-2 py-1 rounded border text-xs st-focus-ring"
            style={{
              backgroundColor: 'var(--st-editor)',
              borderColor: 'var(--st-border)',
              color: 'var(--st-text)',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') addEnvVar(); }}
          />
          <button
            type="button"
            onClick={addEnvVar}
            className="p-0.5 rounded st-hoverable"
            title="Add variable"
            disabled={!newEnvKey.trim()}
          >
            <Plus className="w-3 h-3" style={{ color: newEnvKey.trim() ? 'var(--st-accent)' : 'var(--st-text-faint)' }} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { isOpen, closeSettings, settings, updateSettings, resetSettings } = useSettingsStore();
  const { setTheme } = useThemeStore();
  const [telegramStatus, setTelegramStatus] = useState<{ status: string; botUsername?: string; error?: string }>({ status: 'disconnected' });
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

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
              {/* Claude */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ClaudeIcon className="w-4 h-4 flex-shrink-0" />
                    <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                      Claude
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedProvider(expandedProvider === 'claude' ? null : 'claude')}
                      className="p-0.5 rounded st-hoverable"
                      title="Advanced configuration"
                    >
                      <ChevronRight
                        className="w-3 h-3 transition-transform"
                        style={{
                          color: 'var(--st-text-faint)',
                          transform: expandedProvider === 'claude' ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      />
                    </button>
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
                {expandedProvider === 'claude' && (
                  <ProviderAdvancedConfig
                    provider="claude"
                    config={settings.providerConfigs.claude}
                    onChange={(cfg) => updateSettings({
                      providerConfigs: { ...settings.providerConfigs, claude: cfg }
                    })}
                  />
                )}
              </div>

              {/* Codex */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CodexIcon className="w-4 h-4 flex-shrink-0" />
                    <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                      Codex
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedProvider(expandedProvider === 'codex' ? null : 'codex')}
                      className="p-0.5 rounded st-hoverable"
                      title="Advanced configuration"
                    >
                      <ChevronRight
                        className="w-3 h-3 transition-transform"
                        style={{
                          color: 'var(--st-text-faint)',
                          transform: expandedProvider === 'codex' ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      />
                    </button>
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
                {expandedProvider === 'codex' && (
                  <ProviderAdvancedConfig
                    provider="codex"
                    config={settings.providerConfigs.codex}
                    onChange={(cfg) => updateSettings({
                      providerConfigs: { ...settings.providerConfigs, codex: cfg }
                    })}
                  />
                )}
              </div>

              {/* Gemini */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GeminiIcon className="w-4 h-4 flex-shrink-0" />
                    <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                      Gemini
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedProvider(expandedProvider === 'gemini' ? null : 'gemini')}
                      className="p-0.5 rounded st-hoverable"
                      title="Advanced configuration"
                    >
                      <ChevronRight
                        className="w-3 h-3 transition-transform"
                        style={{
                          color: 'var(--st-text-faint)',
                          transform: expandedProvider === 'gemini' ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      />
                    </button>
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
                {expandedProvider === 'gemini' && (
                  <ProviderAdvancedConfig
                    provider="gemini"
                    config={settings.providerConfigs.gemini}
                    onChange={(cfg) => updateSettings({
                      providerConfigs: { ...settings.providerConfigs, gemini: cfg }
                    })}
                  />
                )}
              </div>

              {/* Kimi */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KimiIcon className="w-4 h-4 flex-shrink-0" />
                    <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                      Kimi
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedProvider(expandedProvider === 'kimi' ? null : 'kimi')}
                      className="p-0.5 rounded st-hoverable"
                      title="Advanced configuration"
                    >
                      <ChevronRight
                        className="w-3 h-3 transition-transform"
                        style={{
                          color: 'var(--st-text-faint)',
                          transform: expandedProvider === 'kimi' ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      />
                    </button>
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
                {expandedProvider === 'kimi' && (
                  <ProviderAdvancedConfig
                    provider="kimi"
                    config={settings.providerConfigs.kimi}
                    onChange={(cfg) => updateSettings({
                      providerConfigs: { ...settings.providerConfigs, kimi: cfg }
                    })}
                  />
                )}
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
