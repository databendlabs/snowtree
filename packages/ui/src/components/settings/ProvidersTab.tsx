import { useState } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useSettingsStore, type ProviderConfig } from '../../stores/settingsStore';
import { ClaudeIcon, CodexIcon, GeminiIcon, KimiIcon } from '../icons/ProviderIcons';

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

const providers = [
  { key: 'claude' as const, label: 'Claude', Icon: ClaudeIcon },
  { key: 'codex' as const, label: 'Codex', Icon: CodexIcon },
  { key: 'gemini' as const, label: 'Gemini', Icon: GeminiIcon },
  { key: 'kimi' as const, label: 'Kimi', Icon: KimiIcon },
];

export function ProvidersTab() {
  const { settings, updateSettings } = useSettingsStore();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {providers.map(({ key, label, Icon }) => (
        <div key={key}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="w-4 h-4 flex-shrink-0" />
              <label className="text-sm" style={{ color: 'var(--st-text-muted)' }}>
                {label}
              </label>
              <button
                type="button"
                onClick={() => setExpandedProvider(expandedProvider === key ? null : key)}
                className="p-0.5 rounded st-hoverable"
                title="Advanced configuration"
              >
                <ChevronRight
                  className="w-3 h-3 transition-transform"
                  style={{
                    color: 'var(--st-text-faint)',
                    transform: expandedProvider === key ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}
                />
              </button>
            </div>
            <button
              type="button"
              onClick={() => updateSettings({
                enabledProviders: { ...settings.enabledProviders, [key]: !settings.enabledProviders[key] }
              })}
              className="flex-shrink-0 w-10 h-5 cursor-pointer rounded-full p-0.5"
              role="switch"
              aria-checked={settings.enabledProviders[key]}
              style={{
                backgroundColor: settings.enabledProviders[key] ? 'var(--st-accent)' : 'var(--st-border)',
                transition: 'background-color 0.2s'
              }}
            >
              <span
                className="block h-4 w-4 bg-white rounded-full transition-transform"
                style={{ transform: settings.enabledProviders[key] ? 'translateX(1.25rem)' : 'translateX(0)' }}
              />
            </button>
          </div>
          {expandedProvider === key && (
            <ProviderAdvancedConfig
              provider={key}
              config={settings.providerConfigs[key]}
              onChange={(cfg) => updateSettings({
                providerConfigs: { ...settings.providerConfigs, [key]: cfg }
              })}
            />
          )}
        </div>
      ))}

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
  );
}
