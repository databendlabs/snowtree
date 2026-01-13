import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderPlus, Plus, Trash2, Loader2 } from 'lucide-react';
import { API } from '../utils/api';
import { useErrorStore } from '../stores/errorStore';
import { useSessionStore } from '../stores/sessionStore';
import { formatDistanceToNow } from '../utils/timestampUtils';
import { StageBadge } from './layout/StageBadge';

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

export function Sidebar() {
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

  const loadProjects = useCallback(async () => {
    const res = await API.projects.getAll();
    if (res.success && Array.isArray(res.data)) {
      const list = res.data as Project[];
      setProjects(list);
      const active = list.find(p => p.active) || list[0];
      setActiveProjectId(active?.id ?? null);
    }
  }, []);

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

  const handleAddRepository = useCallback(async () => {
    try {
      const result = await API.dialog.openDirectory({
        title: 'Select Git Repository',
        buttonLabel: 'Open',
      });
      if (!result.success || !result.data) return;

      const folderPath = result.data;
      const folderName = folderPath.split('/').pop() || 'Repository';

      const createRes = await API.projects.create({ name: folderName, path: folderPath, active: true });
      if (!createRes.success) {
        showError({ title: 'Failed to Add Repository', error: createRes.error || 'Could not add repository' });
        return;
      }
      await loadProjects();
    } catch (error) {
      showError({ title: 'Failed to Add Repository', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [loadProjects, showError]);

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
    const leafName = worktree.path.split('/').filter(Boolean).pop() || worktree.path;
    setEditingWorktreePath(worktree.path);
    setEditingWorktreeSessionId(sessionId);
    setDraftWorktreeName(leafName);
  }, []);

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
      const nextPath = typeof (res.data as { path?: unknown } | undefined)?.path === 'string'
        ? (res.data as { path: string }).path
        : null;
      if (nextPath) {
        setWorktreesByProjectId((prev) => ({
          ...prev,
          [project.id]: (prev[project.id] || []).map((w) => w.path === worktree.path ? { ...w, path: nextPath } : w),
        }));
        setPendingSelectedWorktreePath((prev) => prev === worktree.path ? nextPath : prev);
      }
      cancelRenameWorktree();
      void loadWorktrees(project, { silent: true });
    } catch (error) {
      showError({ title: 'Failed to Rename Workspace', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }, [draftWorktreeName, cancelRenameWorktree, loadWorktrees, showError, activeSessionId, editingWorktreeSessionId]);

  return (
    <div
      className="flex-shrink-0 border-r st-hairline st-surface flex flex-col"
      style={{ width: 'clamp(260px, 22vw, 340px)' }}
    >
      <div
        className="border-b st-hairline"
        style={{ backgroundColor: 'color-mix(in srgb, var(--st-surface) 75%, transparent)' }}
      >
        <div
          className="px-3 py-2 flex items-center justify-between"
          // @ts-expect-error - webkit vendor prefix for electron drag region
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight truncate" style={{ color: 'var(--st-text)' }}>
              Workspaces
            </div>
          </div>
          <button
            type="button"
            onClick={handleAddRepository}
            className="st-icon-button st-focus-ring"
            title="Add repository"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <FolderPlus className="w-4 h-4" />
          </button>
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
                              const leafName = worktree.path.split('/').filter(Boolean).pop() || worktree.path;
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
                                              if (el) {
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
                                            className="flex flex-col min-w-0"
                                            data-testid="worktree-item"
                                            data-worktree-path={worktree.path}
                                          >
                                            <div className="flex items-center gap-2 min-w-0">
                                              <span
                                                data-testid="worktree-name"
                                                className="text-[12px] truncate"
                                                style={{ color: 'var(--st-text)' }}
                                                title={`${leafName} (double-click to rename)`}
                                              >
                                                {leafName}
                                              </span>
                                              {isRunning && (
                                                <Loader2
                                                  className="w-3 h-3 animate-spin flex-shrink-0"
                                                  style={{ color: 'var(--st-accent)' }}
                                                />
                                              )}
                                              {(() => {
                                                const session = sessionsByWorktreePath.get(worktree.path);
                                                return session?.workspaceStage ? (
                                                  <StageBadge stage={session.workspaceStage} />
                                                ) : null;
                                              })()}
                                            </div>
                                            {(worktree.createdAt || worktree.lastCommitAt) && (
                                              <span data-testid="worktree-relative-time" className="text-[11px] st-text-faint mt-0.5">
                                                {formatDistanceToNow(worktree.createdAt || worktree.lastCommitAt!)}
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </div>
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
    </div>
  );
}

export default Sidebar;
