import { Settings, X, Palette, Bot, TerminalSquare, Cog } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useState } from 'react';
import { AppearanceTab } from './settings/AppearanceTab';
import { ProvidersTab } from './settings/ProvidersTab';
import { TerminalTab } from './settings/TerminalTab';
import { GeneralTab } from './settings/GeneralTab';

const tabs = [
  { key: 'appearance', label: 'Appearance', Icon: Palette },
  { key: 'providers', label: 'AI Providers', Icon: Bot },
  { key: 'terminal', label: 'Terminal', Icon: TerminalSquare },
  { key: 'general', label: 'General', Icon: Cog },
] as const;

type TabKey = (typeof tabs)[number]['key'];

export function SettingsDialog() {
  const { isOpen, closeSettings, resetSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState<TabKey>('appearance');

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
        className="w-full max-w-3xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
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

        {/* Tabs */}
        <div
          className="flex gap-0 px-4 border-b flex-shrink-0"
          style={{ borderColor: 'color-mix(in srgb, var(--st-border) 70%, transparent)' }}
        >
          {tabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm transition-colors relative"
              style={{
                color: activeTab === key ? 'var(--st-accent)' : 'var(--st-text-muted)',
              }}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {activeTab === key && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t"
                  style={{ backgroundColor: 'var(--st-accent)' }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto overflow-x-visible flex-1">
          {activeTab === 'appearance' && <AppearanceTab />}
          {activeTab === 'providers' && <ProvidersTab />}
          {activeTab === 'terminal' && <TerminalTab />}
          {activeTab === 'general' && <GeneralTab />}
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
