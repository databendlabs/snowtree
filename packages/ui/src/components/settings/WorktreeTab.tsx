import { useSettingsStore } from '../../stores/settingsStore';

export function WorktreeTab() {
  const { settings, updateSettings } = useSettingsStore();

  return (
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
  );
}
