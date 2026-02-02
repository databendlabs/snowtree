import type { App, BrowserWindow } from 'electron';
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
import type { KimiExecutor } from '../../executors/kimi';
import type { GitExecutor } from '../../executors/git';
import type { Logger } from '../logging/logger';
import type { UpdateManager } from '../../features/updater/UpdateManager';
import type { TelegramService } from '../../services/telegram';

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
  kimiExecutor: KimiExecutor;
  gitDiffManager: GitDiffManager;
  gitStatusManager: GitStatusManager;
  gitStagingManager: GitStagingManager;
  executionTracker: ExecutionTracker;
  worktreeNameGenerator: WorktreeNameGenerator;
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  logger?: Logger;
  updateManager?: UpdateManager | null;
  telegramService?: TelegramService;
} 

export interface IPCResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}
