import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderPlus, Plus, Trash2, Loader2, Download, RotateCw, Sun, Moon } from 'lucide-react';
import { API } from '../utils/api';
import { useErrorStore } from '../stores/errorStore';
import { useSessionStore } from '../stores/sessionStore';
import { formatDistanceToNow } from '../utils/timestampUtils';
import { StageBadge } from './layout/StageBadge';
import { useThemeStore } from '../stores/themeStore';

type Project = {
  id: number;
  name: string;
  path: string;
  active?: boolean;
};

type Worktree = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
  hasChanges: boolean;
  createdAt: string | null;
  lastCommitAt: string | null;
  additions: number;
  deletions: number;
  filesChanged: number;
};

const applyBaseCommitSuffix = (name: string, baseCommit?: string): string => {
  const trimmed = (baseCommit || '').trim();
  if (!trimmed) return name;
  const shortHash = trimmed.slice(0, 7);
  if (!shortHash) return name;
  const lastDash = name.lastIndexOf('-');
  if (lastDash <= 0 || lastDash === name.length - 1) return name;
  return `${name.slice(0, lastDash + 1)}${shortHash}`;
};

type RepositoryEntry = {
  name: string;
  path: string;
};

type SidebarProps = {
  isHidden?: boolean;
};

export function Sidebar({ isHidden = false }: SidebarProps) {
  const { showError } = useErrorStore();
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<number>>(() => new Set());
  const [worktreesByProjectId, setWorktreesByProjectId] = useState<Record<number, Worktree[]>>({});
  const [worktreesLoading, setWorktreesLoading] = useState<Set<number>>(() => new Set());
  const [pendingSelectedWorktreePath, setPendingSelectedWorktreePath] = useState<string | null>(null);
  const [editingWorktreePath, setEditingWorktreePath] = useState<string | null>(null);
  const [editingWorktreeSessionId, setEditingWorktreeSessionId] = useState<string | null>(null);
  const [draftWorktreeName, setDraftWorktreeName] = useState<string>('');
  const refreshTimersRef = useRef<Record<number, number | null>>({});
  const hasInitializedRenameInputRef = useRef(false);
  const { theme, toggleTheme } = useThemeStore();
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateError, setUpdateError] = useState<string>('');
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [repoPickerLoading, setRepoPickerLoading] = useState(false);
  const [repoPickerOptions, setRepoPickerOptions] = useState<RepositoryEntry[]>([]);
  const [repoPickerMessage, setRepoPickerMessage] = useState<string>('');
  const [repoPickerWidth, setRepoPickerWidth] = useState<number | null>(null);
  const repoPickerRef = useRef<HTMLDivElement | null>(null);
  const repoPickerButtonRef = useRef<HTMLButtonElement | null>(null);

  const sidebarPollingTimerRef = useRef<number | null>(null);
  const worktreePollInFlightRef = useRef<Set<number>>(new Set());

  const hasRunningSession = useMemo(
    () => sessions.some((session) => session.status === 'running' || session.status === 'initializing'),
    [sessions]
  );

  const getWorktreeDisplayName = useCallback((worktree: Worktree): string => {
    const branch = typeof worktree.branch === 'string' ? worktree.branch.trim() : '';
    if (branch) return branch;
    return worktree.path.split('/').filter(Boolean).pop() || worktree.path;
  }, []);

  const deriveRepositoryName = useCallback((folderPath: string): string => {
    const segments = folderPath.split(/[\/\\]/).filter(Boolean);
    return segments[segments.length - 1] || 'Repository';
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await API.projects.getAll();
    if (res.success && Array.isArray(res.data)) {
      const list = res.data as Project[];
      setProjects(list);
      const active = list.find(p => p.active) || list[0];
      setActiveProjectId(active?.id ?? null);
    }
  }, []);

  const createProjectFromPath = useCallback(async (folderPath: string, folderName?: string) => {
    const name = (folderName || deriveRepositoryName(folderPath)).trim() || 'Repository';
    const createRes = await API.projects.create({ name, path: folderPath, active: true });
    if (!createRes.success) {
      showError({ title: 'Failed to Add Repository', error: createRes.error || 'Could not add repository' });
      return false;
    }
    await loadProjects();
    return true;
  }, [deriveRepositoryName, loadProjects, showError]);

  const handleAddRepositoryManual = useCallback(async () => {
    try {
      const result = await API.dialog.openDirectory({
        title: 'Select Git Repository',
        buttonLabel: 'Open',
      });
      if (!result.success || !result.data) return;
      await createProjectFromPath(result.data);
    } catch (error) {
      showError({ title: 'Failed to Add Repository', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [createProjectFromPath, showError]);

  const handleSelectRepository = useCallback(async (repo: RepositoryEntry) => {
    setRepoPickerOpen(false);
    await createProjectFromPath(repo.path, repo.name);
  }, [createProjectFromPath]);

  const loadWorktrees = useCallback(async (project: Project, opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) {
      setWorktreesLoading((prev) => new Set(prev).add(project.id));
    }
    try {
      const res = await API.projects.getWorktrees(project.id, activeSessionId);
      if (res.success && Array.isArray(res.data)) {
        const nextRaw = (res.data as Worktree[]).filter((w) => !w.isMain);
        setWorktreesByProjectId((prev) => {
          const prevList = prev[project.id] || [];
          const prevIndex = new Map(prevList.map((w, idx) => [w.path, idx]));

          const sortedNext = [...nextRaw].sort((a, b) => {
            const ai = prevIndex.get(a.path);
            const bi = prevIndex.get(b.path);
            if (ai !== undefined || bi !== undefined) {
              return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
            }
            // New worktrees: prefer recency (creation), but don't reorder existing ones.
            const at = a.createdAt ? new Date(a.createdAt).getTime() : a.lastCommitAt ? new Date(a.lastCommitAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : b.lastCommitAt ? new Date(b.lastCommitAt).getTime() : 0;
            return bt - at || a.path.localeCompare(b.path);
          });

          if (prevList.length === 0) {
            return { ...prev, [project.id]: sortedNext };
          }

          const byPath = new Map(sortedNext.map((w) => [w.path, w]));
          const merged: Worktree[] = [];
          for (const w of sortedNext) {
            if (!prevIndex.has(w.path)) merged.push(w);
          }
          for (const w of prevList) {
            const refreshed = byPath.get(w.path);
            if (refreshed) merged.push(refreshed);
          }

          return { ...prev, [project.id]: merged };
        });
        return nextRaw;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (!silent) {
        setWorktreesLoading((prev) => {
          const next = new Set(prev);
          next.delete(project.id);
          return next;
        });
      }
    }
  }, [activeSessionId]);

  useEffect(() => {
    loadProjects().catch(() => undefined);
  }, [loadProjects]);

  useEffect(() => {
    if (!repoPickerOpen) return;

    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (repoPickerRef.current?.contains(target)) return;
      if (repoPickerButtonRef.current?.contains(target)) return;
      setRepoPickerOpen(false);
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRepoPickerOpen(false);
    };

    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
    };
  }, [repoPickerOpen]);

  useEffect(() => {
    if (!repoPickerOpen) return;
    if (!repoPickerButtonRef.current || typeof window === 'undefined') return;

    const updateWidth = () => {
      if (!repoPickerButtonRef.current) return;
      const rect = repoPickerButtonRef.current.getBoundingClientRect();
      const viewportMax = window.innerWidth - 16;
      const maxFromLeft = rect.right - 12;
      const nextWidth = Math.min(288, viewportMax, maxFromLeft);
      setRepoPickerWidth(nextWidth > 0 ? nextWidth : null);
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [repoPickerOpen]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      if (!window.electronAPI?.invoke) return;
      try {
        const version = await window.electronAPI.invoke('get-app-version');
        if (!mounted) return;
        if (typeof version === 'string') setAppVersion(version);
      } catch {
        // ignore
      }
    })();

    const events = window.electronAPI?.events;
    if (
      !events ||
      typeof events.onUpdateAvailable !== 'function' ||
      typeof events.onUpdateDownloaded !== 'function'
    ) {
      return () => {
        mounted = false;
      };
    }

    const unsubscribes = [
      events.onUpdateAvailable((version) => {
        setUpdateAvailable(true);
        setUpdateVersion(version);
        setUpdateDownloaded(false);
        setUpdateInstalling(false);
        setUpdateError('');
      }),
      events.onUpdateDownloaded(() => {
        setUpdateDownloading(false);
        setUpdateDownloaded(true);
        setUpdateInstalling(false);
      }),
    ];

    return () => {
      mounted = false;
      unsubscribes.forEach((u) => u());
    };
  }, []);

  const handleDownloadUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater) return;
    setUpdateDownloading(true);
    setUpdateError('');
    try {
      const res = await window.electronAPI.updater.download();
      if (!res?.success) {
        setUpdateDownloading(false);
        setUpdateError(res?.error || 'Failed to download update');
      }
    } catch (e) {
      setUpdateDownloading(false);
      setUpdateError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater) return;
    try {
      setUpdateInstalling(true);
      setUpdateError('');
      const res = await window.electronAPI.updater.install();
      if (!res?.success) {
        setUpdateInstalling(false);
        setUpdateError(res?.error || 'Failed to install update');
      }
    } catch (e) {
      setUpdateInstalling(false);
      setUpdateError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleOpenReleases = useCallback(async () => {
    const tag = appVersion ? `v${appVersion.replace(/^v/, '')}` : '';
    const url = tag
      ? `https://github.com/bohutang/snowtree/releases/tag/${tag}`
      : 'https://github.com/bohutang/snowtree/releases';
    try {
      await window.electronAPI?.invoke?.('shell:openExternal', url);
    } catch {
      // ignore
    }
  }, [appVersion]);

  const handleOpenDatabend = useCallback(async () => {
    try {
      await window.electronAPI?.invoke?.('shell:openExternal', 'https://github.com/databendlabs/databend');
    } catch {
      // ignore
    }
  }, []);

  const handleAddRepository = useCallback(async () => {
    try {
      if (repoPickerOpen) {
        setRepoPickerOpen(false);
        return;
      }
      setRepoPickerOpen(true);
      setRepoPickerLoading(true);
      setRepoPickerMessage('');
      const repoList = await API.dialog.listRepositories();
      if (repoList === null) {
        setRepoPickerOptions([]);
        setRepoPickerMessage('Repository root not configured. Use manual path entry.');
      } else {
        setRepoPickerOptions(repoList);
        if (repoList.length == 0) {
          setRepoPickerMessage('No repositories found. Use manual path entry.');
        }
      }
    } catch (error) {
      setRepoPickerOptions([]);
      setRepoPickerMessage('Failed to load repositories. Use manual path entry.');
      showError({ title: 'Failed to Load Repositories', error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setRepoPickerLoading(false);
    }
  }, [repoPickerOpen, showError]);

  const handleNewWorkspace = useCallback(async (projectId: number) => {
    try {
      const response = await API.sessions.create({ projectId, prompt: '', toolType: 'claude' });
      if (!response.success || !response.data?.id) {
        showError({ title: 'Failed to Create Workspace', error: response.error || 'Could not create workspace' });
        return;
      }
      setActiveSession(response.data.id);
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        const baselineCount = (worktreesByProjectId[projectId] || []).length;
        const clearTimer = () => {
          const t = refreshTimersRef.current[projectId];
          if (t) window.clearTimeout(t);
          refreshTimersRef.current[projectId] = null;
        };

        clearTimer();

        const poll = async (tries: number) => {
          const fetched = await loadWorktrees(project, { silent: true });
          if (fetched && fetched.length > baselineCount) {
            clearTimer();
            return;
          }
          if (tries >= 8) {
            clearTimer();
            return;
          }
          const delay = Math.min(2400, 260 * Math.pow(1.45, tries));
          refreshTimersRef.current[projectId] = window.setTimeout(() => void poll(tries + 1), delay);
        };

        refreshTimersRef.current[projectId] = window.setTimeout(() => void poll(0), 280);
      }
    } catch (error) {
      showError({ title: 'Failed to Create Workspace', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [setActiveSession, showError, projects, loadWorktrees, worktreesByProjectId]);

  const handleSelectWorktree = useCallback(async (project: Project, worktree: Worktree): Promise<string | null> => {
    try {
      setPendingSelectedWorktreePath(worktree.path);
      const res = await API.sessions.openWorktree({ projectId: project.id, worktreePath: worktree.path, branch: worktree.branch });
      if (!res.success || !res.data?.id) {
        showError({ title: 'Failed to Open Workspace', error: res.error || 'Could not open worktree' });
        return null;
      }
      setActiveSession(res.data.id);
      return res.data.id;
    } catch (error) {
      showError({ title: 'Failed to Open Workspace', error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  }, [setActiveSession, showError]);

  const toggleProjectCollapsed = useCallback((projectId: number) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const handleDeleteWorktree = useCallback(async (project: Project, worktree: Worktree) => {
    try {
      setWorktreesByProjectId((prev) => ({
        ...prev,
        [project.id]: (prev[project.id] || []).filter((w) => w.path !== worktree.path),
      }));
      const res = await API.projects.removeWorktree(project.id, worktree.path, activeSessionId);
      if (!res.success) {
        showError({ title: 'Failed to Delete Workspace', error: res.error || 'Could not delete worktree' });
        void loadWorktrees(project, { silent: true });
        return;
      }
      void loadWorktrees(project, { silent: true });
    } catch (error) {
      showError({ title: 'Failed to Delete Workspace', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [showError, loadWorktrees, activeSessionId]);

  const handleDeleteProject = useCallback(async (project: Project) => {
    const res = await API.projects.delete(project.id);
    if (!res.success) {
      showError({ title: 'Failed to Delete Repository', error: res.error || 'Could not delete repository' });
      return;
    }
    await loadProjects();
    if (activeProjectId === project.id) {
      setActiveSession(null);
    }
  }, [activeProjectId, loadProjects, setActiveSession, showError]);

  const handleSelectProject = useCallback((projectId: number) => {
    setActiveProjectId(projectId);
  }, []);

  useEffect(() => {
    // Load real git worktrees for all repos (best-effort).
    void Promise.all(projects.map((p) => loadWorktrees(p)));
  }, [projects, loadWorktrees]);

  // Periodically refresh worktree stats in the sidebar so badges/counters update without clicking.
  useEffect(() => {
    if (sidebarPollingTimerRef.current) {
      window.clearInterval(sidebarPollingTimerRef.current);
      sidebarPollingTimerRef.current = null;
    }
    if (projects.length === 0) return;

    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      const targets = projects.filter((p) => !collapsedProjects.has(p.id));
      for (const project of targets) {
        if (worktreePollInFlightRef.current.has(project.id)) continue;
        worktreePollInFlightRef.current.add(project.id);
        void loadWorktrees(project, { silent: true }).finally(() => {
          worktreePollInFlightRef.current.delete(project.id);
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    sidebarPollingTimerRef.current = window.setInterval(() => { void poll(); }, 5_000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (sidebarPollingTimerRef.current) {
        window.clearInterval(sidebarPollingTimerRef.current);
        sidebarPollingTimerRef.current = null;
      }
    };
  }, [projects, collapsedProjects, loadWorktrees]);

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeSessionId) || null, [sessions, activeSessionId]);
  const activeWorktreePath = activeSession?.worktreePath || null;

  const sessionsByWorktreePath = useMemo(() => {
    const map = new Map<string, typeof sessions[number]>();
    for (const s of sessions) {
      if (s.worktreePath) map.set(s.worktreePath, s);
    }
    return map;
  }, [sessions]);

  const runningWorktreePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const s of sessions) {
      if ((s.status === 'running' || s.status === 'initializing') && s.worktreePath) {
        paths.add(s.worktreePath);
      }
    }
    return paths;
  }, [sessions]);

  useEffect(() => {
    if (!pendingSelectedWorktreePath) return;
    if (!activeWorktreePath) return;
    if (activeWorktreePath === pendingSelectedWorktreePath) {
      setPendingSelectedWorktreePath(null);
    }
  }, [pendingSelectedWorktreePath, activeWorktreePath]);

  useEffect(() => {
    return () => {
      for (const key of Object.keys(refreshTimersRef.current)) {
        const t = refreshTimersRef.current[Number(key)];
        if (t) window.clearTimeout(t);
      }
      refreshTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.events?.onSessionCreated) return;

    const unsubscribe = window.electronAPI.events.onSessionCreated((session) => {
      const project = projects.find((p) => p.id === session.projectId);
      if (project) {
        void loadWorktrees(project, { silent: true });
      }
    });

    return unsubscribe;
  }, [projects, loadWorktrees]);

  useEffect(() => {
    if (!window.electronAPI?.events?.onGitStatusUpdated) return;

    const unsubscribe = window.electronAPI.events.onGitStatusUpdated((data) => {
      const { sessionId, gitStatus } = data;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session?.worktreePath) return;

      setWorktreesByProjectId((prev) => {
        const updated: Record<number, Worktree[]> = {};
        for (const [projectIdStr, worktrees] of Object.entries(prev)) {
          const projectId = Number(projectIdStr);
          updated[projectId] = worktrees.map((w) => {
            if (w.path === session.worktreePath) {
              const hasChanges = gitStatus.hasUncommittedChanges || gitStatus.hasUntrackedFiles || false;
              return {
                ...w,
                hasChanges,
                additions: gitStatus.additions ?? 0,
                deletions: gitStatus.deletions ?? 0,
                filesChanged: gitStatus.filesChanged ?? 0,
              };
            }
            return w;
          });
        }
        return updated;
      });
    });

    return unsubscribe;
  }, [sessions]);

  const beginRenameWorktree = useCallback((worktree: Worktree, sessionId: string | null) => {
    const displayName = getWorktreeDisplayName(worktree);
    hasInitializedRenameInputRef.current = false;
    setEditingWorktreePath(worktree.path);
    setEditingWorktreeSessionId(sessionId);
    setDraftWorktreeName(displayName);
  }, [getWorktreeDisplayName]);

  const cancelRenameWorktree = useCallback(() => {
    setEditingWorktreePath(null);
    setEditingWorktreeSessionId(null);
    setDraftWorktreeName('');
  }, []);

  const commitRenameWorktree = useCallback(async (project: Project, worktree: Worktree) => {
    const nextName = draftWorktreeName.trim();
    if (!nextName) {
      cancelRenameWorktree();
      return;
    }
    try {
      const res = await API.projects.renameWorktree(project.id, worktree.path, nextName, editingWorktreeSessionId || activeSessionId);
      if (!res.success) {
        showError({ title: 'Failed to Rename Workspace', error: res.error || 'Could not rename worktree' });
        return;
      }
      // Optimistically update the branch/name so the UI reflects the rename immediately.
      setWorktreesByProjectId((prev) => ({
        ...prev,
        [project.id]: (prev[project.id] || []).map((w) => w.path === worktree.path ? { ...w, branch: nextName } : w),
      }));
      cancelRenameWorktree();
      void loadWorktrees(project, { silent: true });
    } catch (error) {
      showError({ title: 'Failed to Rename Workspace', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [draftWorktreeName, cancelRenameWorktree, loadWorktrees, showError, activeSessionId, editingWorktreeSessionId]);

  const sidebarStyle = isHidden
    ? {
        width: 0,
        minWidth: 0,
        maxWidth: 0,
        opacity: 0,
        pointerEvents: 'none' as const,
        borderRight: 'none',
        overflow: 'hidden',
        transition: 'width var(--st-duration) var(--st-ease), opacity var(--st-duration) var(--st-ease)',
      }
    : {
        width: 'clamp(260px, 22vw, 340px)',
        transition: 'width var(--st-duration) var(--st-ease), opacity var(--st-duration) var(--st-ease)',
      };

  return (
    <div
      className="flex-shrink-0 border-r st-hairline st-surface flex flex-col"
      style={sidebarStyle}
    >
      <div
        className="border-b st-hairline"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--st-surface) 75%, transparent)',
          // @ts-expect-error - webkit vendor prefix for electron drag region
          WebkitAppRegion: 'drag',
        }}
      >
        <div
          className="py-2 flex items-center justify-between"
          style={{ paddingLeft: 'calc(70px + 0.75rem)', paddingRight: '0.75rem' }}
        >
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight truncate" style={{ color: 'var(--st-text)' }}>
              Workspaces
            </div>
          </div>
          <div className="relative">
            <button
              ref={repoPickerButtonRef}
              type="button"
              onClick={handleAddRepository}
              className="st-icon-button st-focus-ring"
              title="Add repository"
              // @ts-expect-error - webkit vendor prefix
              style={{ color: 'var(--st-text-muted)', WebkitAppRegion: 'no-drag' }}
            >
              <FolderPlus className="w-4 h-4" />
            </button>
            {repoPickerOpen && (
              <div
                ref={repoPickerRef}
                className="absolute right-0 top-full mt-2 w-72 rounded-lg border st-hairline st-surface shadow-xl z-50 overflow-hidden"
                style={{
                  ['WebkitAppRegion' as never]: 'no-drag',
                  width: repoPickerWidth ? `${repoPickerWidth}px` : undefined,
                  maxWidth: 'min(90vw, 18rem)',
                }}
              >
                <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide st-text-faint">Repositories</div>
                {hasRunningSession && (
                  <div className="px-3 pb-2 text-[11px] st-text-faint">Press Esc to stop.</div>
                )}
                {repoPickerLoading ? (
                  <div className="px-3 py-2 flex items-center gap-2 text-xs st-text-faint">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading repositories...
                  </div>
                ) : repoPickerOptions.length > 0 ? (
                  <div className="max-h-64 overflow-y-auto">
                    {repoPickerOptions.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        onClick={() => void handleSelectRepository(repo)}
                        className="w-full text-left px-3 py-2 st-hoverable"
                      >
                        <div className="text-sm font-medium truncate">{repo.name || deriveRepositoryName(repo.path)}</div>
                        <div className="text-[11px] st-text-faint truncate">{repo.path}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs st-text-faint">{repoPickerMessage || 'No repositories available.'}</div>
                )}
                <div className="border-t st-hairline mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRepoPickerOpen(false);
                      void handleAddRepositoryManual();
                    }}
                    className="w-full text-left px-3 py-2 text-xs st-hoverable st-text-muted"
                  >
                    Enter path manually
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {projects.length === 0 ? (
          <div className="px-2 py-3 text-xs st-text-faint">No repositories yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const isCollapsed = collapsedProjects.has(project.id);
              const worktreesForProject = worktreesByProjectId[project.id] || [];
              const isLoadingWorktrees = worktreesLoading.has(project.id);
              return (
                <div
                  key={project.id}
                  className={`st-tree-card ${isActive ? 'st-tree-card-active' : ''}`}
                >
                  <div className="p-1">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectProject(project.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectProject(project.id);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-2 rounded-md st-hoverable st-focus-ring"
                      title={project.path}
                      style={{ backgroundColor: 'transparent' }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleProjectCollapsed(project.id);
                        }}
                        className="st-icon-button st-focus-ring flex-shrink-0"
                        title={isCollapsed ? 'Expand' : 'Collapse'}
                        style={{ width: 28, height: 28, color: 'var(--st-text-faint)' }}
                      >
                        <ChevronDown className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--st-text)' }}>
                          {project.name}
                        </div>
                        <div className="text-[11px] truncate st-text-faint">{project.path}</div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleNewWorkspace(project.id);
                          }}
                          className="st-icon-button st-focus-ring"
                          title="New workspace"
                          style={{ width: 28, height: 28, color: 'var(--st-text-muted)' }}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteProject(project);
                          }}
                          className="st-icon-button st-focus-ring"
                          title="Delete repository"
                          style={{ width: 28, height: 28, color: 'var(--st-text-faint)' }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {!isCollapsed && (
                    <div className="st-tree-separator st-tree-indent">
                      <div className="pl-9 pr-2 pb-2 pt-2">
                        {isLoadingWorktrees && worktreesForProject.length === 0 ? (
                          <div className="px-2 py-2 text-xs st-text-faint">Loading…</div>
                        ) : worktreesForProject.length === 0 ? (
                          <div className="px-2 py-2 text-xs st-text-faint">No worktrees.</div>
                        ) : (
                          <div className="flex flex-col gap-[2px]">
                            {worktreesForProject.map((worktree) => {
                              const selected = Boolean(
                                (activeWorktreePath && activeWorktreePath === worktree.path) ||
                                (pendingSelectedWorktreePath && pendingSelectedWorktreePath === worktree.path)
                              );
                              const session = sessionsByWorktreePath.get(worktree.path);
                              const displayName = applyBaseCommitSuffix(
                                getWorktreeDisplayName(worktree),
                                session?.baseCommit
                              );
                              const isEditing = editingWorktreePath === worktree.path;
                              const isRunning = runningWorktreePaths.has(worktree.path);
                              return (
                                <div
                                  key={worktree.path}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => void handleSelectWorktree(project, worktree)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      void handleSelectWorktree(project, worktree);
                                    }
                                  }}
                                  onDoubleClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void (async () => {
                                      const id = await handleSelectWorktree(project, worktree);
                                      if (!id) return;
                                      beginRenameWorktree(worktree, id);
                                    })();
                                  }}
                                  className={`group flex items-center gap-2 rounded-md px-2 py-2 st-hoverable st-focus-ring ${
                                    selected ? 'st-selected' : ''
                                  }`}
                                  style={{ backgroundColor: selected ? 'color-mix(in srgb, var(--st-selected) 70%, transparent)' : 'transparent' }}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="min-w-0">
                                        {isEditing ? (
                                          <input
                                            ref={(el) => {
                                              if (el && !hasInitializedRenameInputRef.current) {
                                                hasInitializedRenameInputRef.current = true;
                                                requestAnimationFrame(() => {
                                                  el.focus();
                                                  el.select();
                                                });
                                              }
                                            }}
                                            value={draftWorktreeName}
                                            onChange={(e) => setDraftWorktreeName(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                void commitRenameWorktree(project, worktree);
                                              } else if (e.key === 'Escape') {
                                                e.preventDefault();
                                                cancelRenameWorktree();
                                              }
                                            }}
                                            onBlur={() => void commitRenameWorktree(project, worktree)}
                                            className="w-full text-[12px] font-medium rounded px-2 py-1 outline-none st-focus-ring"
                                            style={{
                                              backgroundColor: 'var(--st-editor)',
                                              color: 'var(--st-text)',
                                              border: '1px solid var(--st-border-variant)',
                                            }}
                                          />
                                        ) : (
                                          <div
                                            className="flex flex-col min-w-0 w-full"
                                            data-testid="worktree-item"
                                            data-worktree-path={worktree.path}
                                          >
                                            {/* Row 1: Name + Stage badge */}
                                            <div className="flex items-center gap-2 min-w-0">
                                              <span
                                                data-testid="worktree-name"
                                                className="text-[12px] truncate"
                                                style={{ color: 'var(--st-text)' }}
                                                title={`${displayName} (double-click to rename)`}
                                              >
                                                {displayName}
                                              </span>
                                              {isRunning && (
                                                <Loader2
                                                  className="w-3 h-3 animate-spin flex-shrink-0"
                                                  style={{ color: 'var(--st-accent)' }}
                                                />
                                              )}
                                              {session?.workspaceStage ? (
                                                <StageBadge stage={session.workspaceStage} />
                                              ) : null}
                                            </div>
                                            {/* Row 2: Time (left) + Diff stats (right) */}
                                            <div className="flex items-center justify-between mt-0.5">
                                              <span data-testid="worktree-relative-time" className="text-[11px] st-text-faint">
                                                {(worktree.createdAt || worktree.lastCommitAt)
                                                  ? formatDistanceToNow(worktree.createdAt || worktree.lastCommitAt!)
                                                  : ''}
                                              </span>
                                              <div className="flex items-center gap-1 text-[11px] font-mono flex-shrink-0">
                                                {(worktree.additions > 0 || worktree.deletions > 0) && (
                                                  <span className="flex items-center gap-0.5">
                                                    {worktree.additions > 0 && (
                                                      <span style={{ color: '#98c379' }}>+{worktree.additions}</span>
                                                    )}
                                                    {worktree.deletions > 0 && (
                                                      <span style={{ color: '#e06c75' }}> -{worktree.deletions}</span>
                                                    )}
                                                  </span>
                                                )}
                                                {worktree.hasChanges && worktree.additions === 0 && worktree.deletions === 0 && (
                                                  <span
                                                    className="w-1.5 h-1.5 rounded-full"
                                                    style={{ backgroundColor: 'var(--st-accent)' }}
                                                    title="Has changes"
                                                  />
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDeleteWorktree(project, worktree);
                                    }}
                                    className="st-icon-button st-focus-ring opacity-0 group-hover:opacity-100"
                                    style={{ color: 'var(--st-text-faint)' }}
                                    title="Delete workspace"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div
        className="border-t st-hairline px-3 py-2 flex flex-col gap-1.5"
        style={{ backgroundColor: 'color-mix(in srgb, var(--st-surface) 85%, transparent)' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenReleases}
            className="text-[11px] font-mono truncate st-hoverable st-focus-ring px-2 py-1 rounded"
            style={{ color: 'var(--st-text-muted)' }}
          >
            {appVersion ? `snowtree v${appVersion}` : 'snowtree'}
          </button>
          {updateAvailable && (
            <button
              type="button"
              onClick={updateDownloaded ? handleInstallUpdate : handleDownloadUpdate}
              disabled={updateDownloaded ? updateInstalling : updateDownloading}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors st-hoverable st-focus-ring disabled:opacity-50"
              style={{ color: 'var(--st-accent)' }}
            >
              {updateDownloaded ? (
                updateInstalling ? <RotateCw className="w-3 h-3 animate-spin" /> : null
              ) : updateDownloading ? (
                <RotateCw className="w-3 h-3 animate-spin" />
              ) : (
                <Download className="w-3 h-3" />
              )}
              {updateDownloaded
                ? (updateVersion ? `Restart v${updateVersion}` : 'Restart')
                : (updateVersion ? `Update v${updateVersion}` : 'Update')}
            </button>
          )}
          <button
            type="button"
            onClick={toggleTheme}
            className="ml-auto w-7 h-7 flex items-center justify-center rounded st-hoverable st-focus-ring"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{ color: 'var(--st-text-muted)' }}
          >
            {theme === 'light' ? (
              <Moon className="w-3.5 h-3.5" />
            ) : (
              <Sun className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={handleOpenDatabend}
          className="text-[10px] px-2 py-1 rounded transition-colors st-hoverable st-focus-ring flex items-center gap-1 whitespace-nowrap overflow-hidden"
          style={{ color: 'var(--st-text-muted)' }}
          title="Open Databend Labs on GitHub"
        >
          <span className="truncate text-left">
            Made by Databend Team · <span style={{ color: 'var(--st-text-faint)' }}>github.com/databendlabs/databend</span>
          </span>
        </button>
        {updateError && (
          <div className="text-[10px] leading-snug" style={{ color: 'var(--st-text-muted)' }}>
            {updateError}
          </div>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
