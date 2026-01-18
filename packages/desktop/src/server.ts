import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { App, BrowserWindow } from 'electron';
import type { AppServices, IPCResponse } from './infrastructure/ipc/types';
import { registerCoreIpcHandlers } from './infrastructure/ipc/core';
import { registerAppHandlers } from './infrastructure/ipc/app';
import { ConfigManager } from './infrastructure/config/configManager';
import { initializeDatabaseService } from './infrastructure/database';
import type { Database as DatabaseService } from './infrastructure/database';
import { Logger } from './infrastructure/logging';
import { setSnowtreeDirectory } from './infrastructure/utils/snowtreeDirectory';
import { SessionManager } from './features/session';
import { WorktreeManager, WorktreeNameGenerator } from './features/worktree';
import { GitDiffManager, GitStatusManager, GitStagingManager } from './features/git';
import { TaskQueue, ExecutionTracker } from './features/queue';
import { ClaudeExecutor } from './executors/claude';
import { CodexExecutor } from './executors/codex';
import { GeminiExecutor } from './executors/gemini';
import { GitExecutor } from './executors/git';
import { panelManager } from './features/panels/PanelManager';
import { setupEventListeners } from './events';
import { setMainWindowGetter } from './features/queue/ScriptExecutionTracker';
import { InMemoryIpcMain, registerRepoListHandler, parseArgs } from './server/serverUtils';

type InitializedServices = {
  services: AppServices;
  gitStatusManager: GitStatusManager;
  sessionManager: SessionManager;
  taskQueue: TaskQueue | null;
};

async function initializeServices(): Promise<InitializedServices> {
  const configManager = new ConfigManager();
  await configManager.initialize();

  const logger = new Logger(configManager);
  const dbPath = configManager.getDatabasePath();
  const databaseService: DatabaseService = initializeDatabaseService(dbPath);
  databaseService.initialize();

  panelManager.initialize();

  const sessionManager = new SessionManager(databaseService);
  sessionManager.initializeFromDatabase();

  const gitExecutor = new GitExecutor(sessionManager);
  const worktreeManager = new WorktreeManager(gitExecutor);

  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    await worktreeManager.initializeProject(activeProject.path);
  }

  const claudeExecutor = new ClaudeExecutor(sessionManager, logger, configManager);
  const codexExecutor = new CodexExecutor(sessionManager, logger, configManager);
  const geminiExecutor = new GeminiExecutor(sessionManager, logger, configManager);
  const gitDiffManager = new GitDiffManager(gitExecutor, logger);
  const gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, gitExecutor, logger);
  const gitStagingManager = new GitStagingManager(gitExecutor, gitStatusManager);
  const executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  const worktreeNameGenerator = new WorktreeNameGenerator(configManager);

  const fakeApp = {
    getVersion: () => 'snowtree-server',
    isPackaged: true,
    name: 'snowtree'
  } as unknown as App;

  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: () => undefined
    }
  } as unknown as BrowserWindow;

  const services: AppServices = {
    app: fakeApp,
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    gitExecutor,
    claudeExecutor,
    codexExecutor,
    geminiExecutor,
    gitDiffManager,
    gitStatusManager,
    gitStagingManager,
    executionTracker,
    worktreeNameGenerator,
    taskQueue: null,
    getMainWindow: () => fakeWindow,
    logger,
    updateManager: null
  };

  const taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeExecutor,
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
    getMainWindow: () => null
  });

  services.taskQueue = taskQueue;

  return { services, gitStatusManager, sessionManager, taskQueue };
}

type ServerEvent = {
  channel: string;
  payload: unknown;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.snowtreeDir) {
    setSnowtreeDirectory(args.snowtreeDir);
    console.log(`[server] Using Snowtree directory: ${args.snowtreeDir}`);
  }

  if (!fs.existsSync(args.uiDir)) {
    console.warn(`[server] UI build directory "${args.uiDir}" does not exist. Run "pnpm --filter @snowtree/ui build".`);
  }

  const { services, gitStatusManager } = await initializeServices();
  const eventEmitter = new EventEmitter();

  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        const payload = args.length <= 1 ? args[0] : args;
        eventEmitter.emit('snowtree:event', { channel, payload } satisfies ServerEvent);
      },
      postMessage: () => undefined,
      openDevTools: () => undefined,
      closeDevTools: () => undefined,
      isDevToolsOpened: () => false,
      sendInputEvent: () => undefined
    }
  } as unknown as BrowserWindow;

  // Expose fake window to services so existing listeners reuse the same emitter.
  (services as { getMainWindow: () => BrowserWindow | null }).getMainWindow = () => fakeWindow;
  setMainWindowGetter(() => fakeWindow);

  const ipcMain = new InMemoryIpcMain();
  registerCoreIpcHandlers(ipcMain, services);
  registerAppHandlers(ipcMain, services);
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    console.log(`[server] shell:openExternal requested: ${url}`);
    return { success: true };
  });
  if (args.repoRoot) {
    console.log(`[server] Repository root: ${args.repoRoot}`);
    registerRepoListHandler(ipcMain, args.repoRoot);
  }

  setupEventListeners(services, () => fakeWindow);
  gitStatusManager.startPolling();

  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: true });

  fastify.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/ipc/:channel', async (request, reply) => {
    const { channel } = request.params;
    const args = Array.isArray(request.body?.args) ? request.body!.args : [];
    try {
      const result = await ipcMain.invoke(channel, ...args);
      reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.status(500).send({ success: false, error: message } satisfies IPCResponse);
    }
  });

  fastify.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache'
    });
    reply.raw.write('\n');

    const sendEvent = (event: ServerEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    eventEmitter.on('snowtree:event', sendEvent);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      eventEmitter.off('snowtree:event', sendEvent);
    });
  });

  // Health endpoint
  fastify.get('/api/health', async () => ({ ok: true }));

  await fastify.register(fastifyStatic, {
    root: args.uiDir,
    prefix: '/',
    index: ['index.html']
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      const indexPath = path.join(args.uiDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        reply.type('text/html').send(fs.readFileSync(indexPath, 'utf8'));
      } else {
        reply.status(404).send('UI not built');
      }
      return;
    }
    reply.status(404).send({ error: 'Not Found' });
  });

  const shutdown = async () => {
    console.log('[server] Shutting down Snowtree server...');
    try {
      gitStatusManager.stopPolling();
      await services.sessionManager.cleanup({ fast: true });
      await fastify.close();
    } catch (error) {
      console.error('[server] Error during shutdown', error);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await fastify.listen({ port: args.port, host: args.host });
    console.log(`[server] Snowtree server listening on http://${args.host}:${args.port}`);
    console.log(`[server] Serving UI from ${args.uiDir}`);
    console.log(`[server] Registered IPC channels: ${ipcMain.getRegisteredChannels().join(', ')}`);
  } catch (error) {
    console.error('[server] Failed to start server', error);
    process.exit(1);
  }
}

void main();
