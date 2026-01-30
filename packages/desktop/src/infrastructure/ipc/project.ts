import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { randomUUID } from 'crypto';

type CreateProjectRequest = {
  name: string;
  path: string;
  active: boolean;
};

export function registerProjectHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { databaseService, sessionManager, worktreeManager, claudeExecutor, codexExecutor, geminiExecutor, kimiExecutor, gitExecutor, gitStatusManager } = services;

  ipcMain.handle('projects:get-all', async () => {
    try {
      const projects = databaseService.getAllProjects();
      return { success: true, data: projects };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get projects' };
    }
  });

  ipcMain.handle('projects:create', async (_event, projectData: CreateProjectRequest) => {
    try {
      const project = databaseService.createProject(projectData.name, projectData.path);
      if (projectData.active) {
        databaseService.setActiveProject(project.id);
        sessionManager.setActiveProject(project);
      }
      return { success: true, data: project };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create project' };
    }
  });

  ipcMain.handle('projects:delete', async (_event, projectId: number) => {
    try {
      const project = databaseService.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      // Delete all sessions under this project (including archived).
      // NOTE: Deleting a repo from Snowtree must NOT delete any git worktrees on disk.
      const sessions = databaseService.getAllSessionsIncludingArchived().filter((s) => s.project_id === projectId);
      for (const session of sessions) {
        try {
          // Stop any running panels (if still present)
          const panels = databaseService.getPanelsForSession(session.id);
          for (const panel of panels) {
            if (panel.type === 'claude') await claudeExecutor.kill(panel.id);
            if (panel.type === 'codex') await codexExecutor.kill(panel.id);
            if (panel.type === 'gemini') await geminiExecutor.kill(panel.id);
            if (panel.type === 'kimi') await kimiExecutor.kill(panel.id);
          }
        } catch {
          // ignore
        }

        try {
          sessionManager.deleteSessionPermanently(session.id);
        } catch {
          // ignore
        }
      }

      const deleted = databaseService.deleteProject(projectId);
      if (!deleted) return { success: false, error: 'Failed to delete project' };

      // Ensure there is an active project after deletion
      const remaining = databaseService.getAllProjects();
      const nextActive = remaining.find((p) => p.active) || remaining[0];
      if (nextActive) {
        databaseService.setActiveProject(nextActive.id);
        sessionManager.setActiveProject(nextActive);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete project' };
    }
  });

  ipcMain.handle('projects:get-worktrees', async (_event, projectId: number, sessionId?: string | null) => {
    try {
      const project = databaseService.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const worktrees = await worktreeManager.listWorktreesDetailed(project.path, sessionId ?? undefined);
      return { success: true, data: worktrees };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list worktrees' };
    }
  });

  ipcMain.handle('projects:remove-worktree', async (_event, projectId: number, worktreePath: string, sessionId?: string | null, autoDeleteBranch?: boolean) => {
    try {
      const project = databaseService.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const normalizedProjectPath = project.path.replace(/\/+$/, '');
      const normalizedWorktreePath = String(worktreePath || '').replace(/\/+$/, '');
      if (!normalizedWorktreePath) return { success: false, error: 'Worktree path is required' };
      if (normalizedWorktreePath === normalizedProjectPath) {
        return { success: false, error: 'Cannot remove main repository worktree' };
      }

      // Get the branch name before removing the worktree
      let branchName: string | null = null;
      if (autoDeleteBranch) {
        try {
          const { stdout: branchOut } = await gitExecutor.run({
            sessionId,
            cwd: normalizedWorktreePath,
            argv: ['git', 'branch', '--show-current'],
            kind: 'git.command',
            op: 'read',
            meta: { source: 'workspace', operation: 'worktree-branch-probe', worktreePath: normalizedWorktreePath },
          });
          branchName = branchOut.trim();
        } catch {
          // ignore - worktree might already be deleted or inaccessible
        }
      }

      await gitExecutor.run({
        sessionId,
        cwd: project.path,
        argv: ['git', 'worktree', 'remove', normalizedWorktreePath, '--force'],
        kind: 'worktree.command',
        op: 'write',
        meta: { source: 'workspace', operation: 'worktree-remove', worktreePath: normalizedWorktreePath },
        treatAsSuccessIfOutputIncludes: ['is not a working tree', 'does not exist', 'No such file or directory'],
      });

      // Delete the branch if requested and we got a branch name
      if (autoDeleteBranch && branchName) {
        try {
          await gitExecutor.run({
            sessionId,
            cwd: project.path,
            argv: ['git', 'branch', '-D', branchName],
            kind: 'git.command',
            op: 'write',
            meta: { source: 'workspace', operation: 'branch-delete', branch: branchName },
            treatAsSuccessIfOutputIncludes: ['not found'],
          });
        } catch {
          // ignore - branch might not exist or already deleted
        }
      }

      // Remove any sessions that were attached to this worktree.
      const sessions = databaseService.getAllSessionsIncludingArchived().filter(
        (s) => s.project_id === projectId && s.worktree_path?.replace(/\/+$/, '') === normalizedWorktreePath
      );
      for (const s of sessions) {
        try {
          const panels = databaseService.getPanelsForSession(s.id);
          for (const panel of panels) {
            if (panel.type === 'claude') await claudeExecutor.kill(panel.id);
            if (panel.type === 'codex') await codexExecutor.kill(panel.id);
            if (panel.type === 'gemini') await geminiExecutor.kill(panel.id);
            if (panel.type === 'kimi') await kimiExecutor.kill(panel.id);
          }
        } catch {
          // ignore
        }
        try {
          sessionManager.deleteSessionPermanently(s.id);
        } catch {
          // ignore
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove worktree' };
    }
  });

  ipcMain.handle('projects:rename-worktree', async (_event, projectId: number, worktreePath: string, nextName: string, sessionId?: string | null) => {
    try {
      const project = databaseService.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const normalizedProjectPath = project.path.replace(/\/+$/, '');
      const normalizedWorktreePath = String(worktreePath || '').replace(/\/+$/, '');
      if (!normalizedWorktreePath) return { success: false, error: 'Worktree path is required' };
      if (normalizedWorktreePath === normalizedProjectPath) {
        return { success: false, error: 'Cannot rename main repository worktree' };
      }

      const name = String(nextName || '').trim();
      if (!name) return { success: false, error: 'Name is required' };
      if (/[\\/]/.test(name)) return { success: false, error: 'Name cannot contain path separators' };

      // "Safe rename": rename the git branch (workspace identity) without moving the worktree folder.
      // Moving the worktree path can break agent resume tokens that are keyed by cwd.
      const { stdout: branchOut } = await gitExecutor.run({
        sessionId,
        cwd: normalizedWorktreePath,
        argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
        kind: 'git.command',
        op: 'read',
        meta: { source: 'workspace', operation: 'worktree-branch-probe', worktreePath: normalizedWorktreePath },
      });
      const currentBranch = branchOut.trim();
      if (!currentBranch || currentBranch === 'HEAD') {
        return { success: false, error: 'Cannot rename a detached worktree (no branch checked out)' };
      }
      if (currentBranch === name) {
        return { success: true, data: { path: normalizedWorktreePath } };
      }

      await gitExecutor.run({
        sessionId,
        cwd: normalizedWorktreePath,
        argv: ['git', 'branch', '-m', currentBranch, name],
        kind: 'git.command',
        op: 'write',
        meta: { source: 'workspace', operation: 'branch-rename', worktreePath: normalizedWorktreePath, from: currentBranch, to: name },
      });

      // Update any sessions attached to this worktree path so worktree recovery and display stay consistent.
      const sessions = databaseService.getAllSessionsIncludingArchived().filter(
        (s) => s.project_id === projectId && s.worktree_path?.replace(/\/+$/, '') === normalizedWorktreePath
      );
      for (const s of sessions) {
        try {
          sessionManager.updateSession(s.id, { worktreeName: name });
        } catch {
          // ignore
        }
      }

      return { success: true, data: { path: normalizedWorktreePath } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to rename worktree' };
    }
  });

  ipcMain.handle('sessions:open-worktree', async (_event, request: { projectId: number; worktreePath: string; branch?: string | null }) => {
    try {
      const projectId = Number(request?.projectId);
      const worktreePath = typeof request?.worktreePath === 'string' ? request.worktreePath : '';
      if (!projectId || !worktreePath) return { success: false, error: 'projectId and worktreePath are required' };

      const project = databaseService.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const normalizedProjectPath = project.path.replace(/\/+$/, '');
      const normalizedWorktreePath = worktreePath.replace(/\/+$/, '');
      const isMain = normalizedWorktreePath === normalizedProjectPath;

      // If this is the main repo worktree, attach (or create) a main repo session.
      if (isMain) {
        const existing = databaseService.getMainRepoSession(projectId);
        if (existing) {
          gitStatusManager.setActiveSession(existing.id);
          return { success: true, data: { id: existing.id } };
        }
        const mainSession = await sessionManager.getOrCreateMainRepoSession(projectId);
        sessionManager.emitSessionCreated(mainSession);
        gitStatusManager.setActiveSession(mainSession.id);
        return { success: true, data: { id: mainSession.id } };
      }

      // Reuse an existing session bound to this worktree if present.
      const existing = databaseService.getAllSessions(projectId).find(
        (s) => s.worktree_path?.replace(/\/+$/, '') === normalizedWorktreePath
      );
      if (existing) {
        gitStatusManager.setActiveSession(existing.id);
        return { success: true, data: { id: existing.id } };
      }

      // Detect base branch (repo default branch) for commit history comparison.
      const baseBranch = await (async (): Promise<string> => {
        try {
          const { stdout } = await gitExecutor.run({
            cwd: project.path,
            argv: ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'],
            op: 'read',
            meta: { source: 'ipc.project', operation: 'detect-base-branch' },
          });
          const name = stdout.trim().replace('refs/remotes/origin/', '').trim();
          if (name) return name;
        } catch {
          // ignore
        }

        for (const candidate of ['main', 'master']) {
          try {
            await gitExecutor.run({
              cwd: project.path,
              argv: ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
              op: 'read',
              meta: { source: 'ipc.project', operation: 'detect-base-branch', candidate },
            });
            return candidate;
          } catch {
            // ignore
          }
        }

        try {
          const { stdout } = await gitExecutor.run({
            cwd: project.path,
            argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            op: 'read',
            meta: { source: 'ipc.project', operation: 'detect-base-branch-local' },
          });
          const local = stdout.trim();
          if (local) return local;
        } catch {
          // ignore
        }

        return 'main';
      })();
      const leafName = normalizedWorktreePath.split('/').filter(Boolean).pop() || 'worktree';
      const sessionId = randomUUID();
      const session = sessionManager.createSessionWithId(
        sessionId,
        leafName,
        normalizedWorktreePath,
        '',
        leafName,
        project.default_permission_mode || 'ignore',
        projectId,
        false,
        true,
        undefined,
        'claude',
        undefined,
        baseBranch,
        project.commit_mode,
        undefined
      );
      sessionManager.emitSessionCreated(session);
      gitStatusManager.setActiveSession(session.id);
      return { success: true, data: { id: session.id } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open worktree' };
    }
  });
}
