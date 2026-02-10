import { useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';

export function TerminalTab() {
  const { settings, updateSettings } = useSettingsStore();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    if (settings.terminalFontFamily) {
      el.style.setProperty('--st-font-mono', `'${settings.terminalFontFamily}', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`);
    } else {
      el.style.removeProperty('--st-font-mono');
    }
  }, [settings.terminalFontFamily]);

  return (
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
          Font Family
        </label>
        <input
          type="text"
          value={settings.terminalFontFamily}
          onChange={(e) => updateSettings({ terminalFontFamily: e.target.value })}
          placeholder="JetBrains Mono"
          className="px-3 py-1.5 rounded border text-sm w-48 st-focus-ring"
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
  );
}
