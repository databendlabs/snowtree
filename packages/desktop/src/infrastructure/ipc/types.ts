import type { App, BrowserWindow, IpcMain } from 'electron';
import type { TaskQueue } from '../../features/queue/TaskQueue';
import type { SessionManager } from '../../features/session/SessionManager';
import type { ConfigManager } from '../config/configManager';
import type { WorktreeManager } from '../../features/worktree/WorktreeManager';
import type { WorktreeNameGenerator } from '../../features/worktree/NameGenerator';
import type { GitDiffManager } from '../../features/git/DiffManager';
import type { GitStatusManager } from '../../features/git/StatusManager';
import type { GitStagingManager } from '../../features/git/StagingManager';
import type { ExecutionTracker } from '../../features/queue/ExecutionTracker';
import type { DatabaseService } from '../database/database';
import type { ClaudeExecutor } from '../../executors/claude';
import type { CodexExecutor } from '../../executors/codex';
import type { GeminiExecutor } from '../../executors/gemini';
import type { GitExecutor } from '../../executors/git';
import type { Logger } from '../logging/logger';
import type { UpdateManager } from '../../features/updater/UpdateManager';

export interface AppServices {
  app: App;
  configManager: ConfigManager;
  databaseService: DatabaseService;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  gitExecutor: GitExecutor;
  claudeExecutor: ClaudeExecutor;
  codexExecutor: CodexExecutor;
  geminiExecutor: GeminiExecutor;
  gitDiffManager: GitDiffManager;
  gitStatusManager: GitStatusManager;
  gitStagingManager: GitStagingManager;
  executionTracker: ExecutionTracker;
  worktreeNameGenerator: WorktreeNameGenerator;
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  logger?: Logger;
  updateManager?: UpdateManager | null;
} 

export interface IPCResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export type IpcHandlerTarget = Pick<IpcMain, 'handle'>;
