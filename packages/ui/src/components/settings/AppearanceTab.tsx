import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { useEffect } from 'react';

function getResolvedTheme(themeSetting: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (themeSetting !== 'system') return themeSetting;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export function AppearanceTab() {
  const { settings, updateSettings } = useSettingsStore();
  const { setTheme } = useThemeStore();

  useEffect(() => {
    const resolvedTheme = getResolvedTheme(settings.theme);
    setTheme(resolvedTheme);

    if (settings.theme === 'system' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        setTheme(e.matches ? 'dark' : 'light');
      };
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [settings.theme, setTheme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.fontSize = `${settings.fontSize}px`;
    document.documentElement.style.fontSize = `${settings.fontSize}px`;
  }, [settings.fontSize]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    if (settings.fontFamily) {
      el.style.setProperty('--st-font-sans', `'${settings.fontFamily}', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
    } else {
      el.style.removeProperty('--st-font-sans');
    }
  }, [settings.fontFamily]);

  return (
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

      <div className="flex items-center justify-between">
        <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
          Font Family
        </label>
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => updateSettings({ fontFamily: e.target.value })}
          placeholder="Inter"
          className="px-3 py-1.5 rounded border text-sm w-48 st-focus-ring"
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
