import { useState, useCallback, useEffect } from 'react';
import { Send } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';

export function GeneralTab() {
  const { isOpen, settings, updateSettings } = useSettingsStore();
  const [telegramStatus, setTelegramStatus] = useState<{ status: string; botUsername?: string; error?: string }>({ status: 'disconnected' });

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

  return (
    <div className="space-y-6">
      {/* Worktree Settings */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--st-text)' }}>
          Worktree
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
  );
}
