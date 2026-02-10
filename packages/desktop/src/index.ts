// Load ReadableStream polyfill before any other imports
import './polyfills/readablestream';

// Fix GTK 2/3 and GTK 4 conflict on Linux (Electron 36 issue)
// This MUST be done before importing electron
import { app } from 'electron';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
}
app.setName('snowtree');

// Now import the rest of electron
import { BrowserWindow, ipcMain, shell, nativeImage, Menu } from 'electron';
import * as path from 'path';
import { TaskQueue } from './features/queue';
import { SessionManager } from './features/session';
import { ConfigManager } from './infrastructure/config/configManager';
import { WorktreeManager, WorktreeNameGenerator } from './features/worktree';
import { GitDiffManager, GitStatusManager, GitStagingManager } from './features/git';
import { ExecutionTracker } from './features/queue';
import { Database as DatabaseService, initializeDatabaseService } from './infrastructure/database';
import { Logger } from './infrastructure/logging';
import { setSnowtreeDirectory } from './infrastructure/utils/snowtreeDirectory';
import { getCurrentWorktreeName } from './infrastructure/git/worktreeUtils';
import { registerIpcHandlers } from './infrastructure/ipc';
import { setupEventListeners } from './events';
import type { AppServices } from './infrastructure/ipc';
import { ClaudeExecutor } from './executors/claude';
import { CodexExecutor } from './executors/codex';
import { GeminiExecutor } from './executors/gemini';
import { KimiExecutor } from './executors/kimi';
import { GitExecutor } from './executors/git';
import { setupConsoleWrapper } from './infrastructure/logging/consoleWrapper';
import { panelManager } from './features/panels/PanelManager';
import { UpdateManager, type UpdateAvailableInfo } from './features/updater/UpdateManager';
import { TelegramService } from './services/telegram';
import * as fs from 'fs';

// Handle EPIPE errors gracefully - they occur when writing to a closed pipe
// and are not critical errors that should crash the app
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    // Silently ignore EPIPE errors - they happen when child processes exit
    return;
  }
  // Re-throw other uncaught exceptions
  console.error('Uncaught Exception:', error);
});

export let mainWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;

/**
 * Create and show the About window
 */
function createAboutWindow() {
  // Don't create duplicate windows
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 10 }
    } : {})
  });

  const aboutHtmlPath = path.join(__dirname, 'windows/about.html');
  aboutWindow.loadFile(aboutHtmlPath);

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
}

/**
 * Set the application title based on development mode and worktree
 */
function setAppTitle() {
  if (isDevelopment) {
    const worktreeName = getCurrentWorktreeName(process.cwd());
    if (worktreeName) {
      const title = `snowtree [${worktreeName}]`;
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
      return title;
    }
  }
  
  // Default title
  const title = 'snowtree';
  if (mainWindow) {
    mainWindow.setTitle(title);
  }
  return title;
}
let taskQueue: TaskQueue | null = null;

// Service instances
let configManager: ConfigManager;
let logger: Logger;
let sessionManager: SessionManager;
let worktreeManager: WorktreeManager;
let gitExecutor: GitExecutor;
let claudeExecutor: ClaudeExecutor;
let codexExecutor: CodexExecutor;
let geminiExecutor: GeminiExecutor;
let kimiExecutor: KimiExecutor;
let gitDiffManager: GitDiffManager;
let gitStatusManager: GitStatusManager;
let gitStagingManager: GitStagingManager;
let executionTracker: ExecutionTracker;
let worktreeNameGenerator: WorktreeNameGenerator;
let databaseService: DatabaseService;
let updateManager: UpdateManager | null = null;
let telegramService: TelegramService;

// Store app start time for session duration tracking
let appStartTime: number;

// Store original console methods before overriding
// These must be captured immediately when the module loads
const originalLog: typeof console.log = console.log;
const originalError: typeof console.error = console.error;
const originalWarn: typeof console.warn = console.warn;
const originalInfo: typeof console.info = console.info;

const isDevelopment = app.commandLine.hasSwitch('snowtree-dev');

// Reset debug log files at startup in development mode
if (isDevelopment) {
  const frontendLogPath = path.join(process.cwd(), 'snowtree-frontend-debug.log');
  const backendLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');

  try {
    fs.writeFileSync(frontendLogPath, '');
    fs.writeFileSync(backendLogPath, '');
  } catch (error) {
    // Don't crash if we can't reset the log files
    console.error('Failed to reset debug log files:', error);
  }
}

// Set up console wrapper to reduce logging in production
setupConsoleWrapper();

// Parse command-line arguments for custom Snowtree directory
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  // Support both --snowtree-dir=/path and --snowtree-dir /path formats
  if (arg.startsWith('--snowtree-dir=')) {
    const dir = arg.substring('--snowtree-dir='.length);
    setSnowtreeDirectory(dir);
    console.log(`[Main] Using custom Snowtree directory: ${dir}`);
  } else if (arg === '--snowtree-dir' && i + 1 < args.length) {
    const dir = args[i + 1];
    setSnowtreeDirectory(dir);
    console.log(`[Main] Using custom Snowtree directory: ${dir}`);
    i++; // Skip the next argument since we've consumed it
  }
}

// Install Devtron in development
if (isDevelopment) {
  // Devtron can be installed manually in DevTools console with: require('devtron').install()
}

const resolveIconPath = (): string => {
  const appPath = app.getAppPath();
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--snowtree-dev');
  const candidates = [
    ...(isDev ? [path.join(process.cwd(), 'packages/desktop/assets/icon.png')] : []),
    path.join(appPath, 'assets/icon.png'),
    path.join(appPath, 'main/assets/icon.png'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
};

async function createWindow() {
  const initialTitle = setAppTitle();
  const isTest = process.env.NODE_ENV === 'test';
  const iconPath = resolveIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: initialTitle,
    show: !isTest,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 10 }
    } : {})
  });

  // Increase max listeners to prevent warning when many panels are active
  // Each panel can register multiple event listeners
  mainWindow.webContents.setMaxListeners(100);

  mainWindow.webContents.on('did-finish-load', () => {
    try {
      console.log('[Main] Renderer loaded:', mainWindow?.webContents.getURL());
    } catch {
      console.log('[Main] Renderer loaded');
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error('[Main] Renderer failed to load:', { errorCode, errorDescription, validatedURL });
  });

  // Set main window reference for services that need to emit events

  if (isDevelopment) {
    console.log('[Main] Loading dev URL: http://localhost:4521');
    await mainWindow.loadURL('http://localhost:4521');
    mainWindow.webContents.openDevTools();
  } else {
    const appPath = app.getAppPath();
    const candidates = [
      // Current monorepo layout (packaged by electron-builder "files")
      path.join(appPath, 'packages/ui/dist/index.html'),
      // Legacy layout (kept for compatibility)
      path.join(appPath, 'frontend/dist/index.html'),
      // Edge-case fallbacks when __dirname is not under appPath as expected
      path.join(__dirname, '../../../../packages/ui/dist/index.html'),
      path.join(__dirname, '../../../../frontend/dist/index.html'),
    ];

    let loaded = false;
    for (const candidate of candidates) {
      console.log('Loading index.html from:', candidate);
      try {
        await mainWindow.loadFile(candidate);
        loaded = true;
        break;
      } catch (error) {
        console.error('Failed to load index.html:', error);
        console.error('App path:', appPath);
        console.error('__dirname:', __dirname);
      }
    }

    if (!loaded) {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>snowtree</title></head>
<body style="font-family: -apple-system, system-ui; padding: 24px;">
<h2>snowtree failed to load UI</h2>
<p>Could not find <code>index.html</code>. Checked:</p>
<pre>${candidates.map((p) => `- ${p}`).join('\n')}</pre>
</body></html>`;
      await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    }
  }

  // Ensure the app title is applied after load (covers dev reloads)
  setAppTitle();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log any console messages from the renderer
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Skip messages that are already prefixed to avoid circular logging
    if (message.includes('[Main Process]') || message.includes('[Renderer]')) {
      return;
    }
    // Also skip Electron security warnings and other system messages
    if (message.includes('Electron Security Warning') || sourceId.includes('electron/js2c')) {
      return;
    }
    
    // In development, log ALL console messages to help with debugging
    if (isDevelopment) {
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const levelName = levelNames[level] || 'unknown';
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [FRONTEND ${levelName.toUpperCase()}] ${message}`;
      
      // Always log to main console
      
      // Also write to debug log file for Claude Code to read
      const debugLogPath = path.join(process.cwd(), 'snowtree-frontend-debug.log');
      const logLine = `${logMessage} (${path.basename(sourceId)}:${line})\n`;
      
      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('Failed to write to debug log:', error);
      }
    } else {
      // In production, only log errors and warnings from renderer
      if (level >= 2) { // 2 = warning, 3 = error
      }
    }
  });

  // Override console methods to forward to renderer and logger
  console.log = (...args: unknown[]) => {
    // Format the message
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    // Write to logger if available
    if (logger) {
      logger.info(message);
    } else {
      originalLog.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND LOG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalLog('[Main] Failed to write to backend debug log:', error);
      }
    }

    // Forward to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'log', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalLog('[Main] Failed to send log to renderer:', e);
      }
    }
  };

  console.error = (...args: unknown[]) => {
    // Prevent infinite recursion by checking if we're already in an error handler
    if ((console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError) {
      return originalError.apply(console, args);
    }
    
    (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = true;
    
    try {
      // If logger is not initialized or we're in the logger itself, use original console
      if (!logger) {
        originalError.apply(console, args);
        return;
      }

      const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
          if (arg instanceof Error) {
            return `Error: ${arg.message}\nStack: ${arg.stack}`;
          }
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            // Handle circular structure
            return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
          }
        }
        return String(arg);
      }).join(' ');

      // Extract Error object if present
      const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

      // Use logger but with recursion protection
      logger.error(message, errorObj);

      // In development, also write to backend debug log file
      if (isDevelopment) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [BACKEND ERROR] ${message}`;
        const debugLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');
        const logLine = `${logMessage}\n`;

        try {
          fs.appendFileSync(debugLogPath, logLine);
        } catch (error) {
          // Don't crash if we can't write to the log file
          originalError('[Main] Failed to write to backend debug log:', error);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('main-log', 'error', message);
        } catch (e) {
          // If sending to renderer fails, use original console to avoid recursion
          originalError('[Main] Failed to send error to renderer:', e);
        }
      }
    } catch (e) {
      // If anything fails in the error handler, fall back to original
      originalError.apply(console, args);
    } finally {
      (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = false;
    }
  };

  console.warn = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    // Extract Error object if present for warnings too
    const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

    if (logger) {
      logger.warn(message, errorObj);
    } else {
      originalWarn.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND WARNING] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalWarn('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'warn', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalWarn('[Main] Failed to send warning to renderer:', e);
      }
    }
  };

  console.info = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    if (logger) {
      logger.info(message);
    } else {
      originalInfo.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND INFO] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalInfo('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'info', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalInfo('[Main] Failed to send info to renderer:', e);
      }
    }
  };

  console.debug = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND DEBUG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'snowtree-backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'debug', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        console.error('[Main] Failed to send debug to renderer:', e);
      }
    }
  };

  // Log any renderer errors
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process crashed:', details);
  });

  // Handle window focus/blur/minimize for smart git status polling and update checks
  mainWindow.on('focus', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/focused
    }
    // Check for updates when window gains focus (throttled in UpdateManager)
    if (updateManager) {
      updateManager.checkForUpdates();
    }
  });

  mainWindow.on('blur', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/blurred
    }
  });

  mainWindow.on('minimize', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/minimized
    }
  });

  mainWindow.on('restore', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/restored
    }
  });
}

async function initializeServices() {
  configManager = new ConfigManager();
  await configManager.initialize();

  // Initialize auto-updater in production so IPC handlers can use it.
  // (UI triggers download/install via IPC, so updateManager must exist before handlers register.)
  if (!isDevelopment) {
    updateManager = new UpdateManager();
    await updateManager.initialize();
    console.log('[Main] UpdateManager initialized');
  }

  // Initialize logger early so it can capture all logs
  logger = new Logger(configManager);
  console.log('[Main] Logger initialized');

  // Use the same database path as the original backend
  const dbPath = configManager.getDatabasePath();
  databaseService = initializeDatabaseService(dbPath);
  databaseService.initialize();

  // Initialize panel manager after database is ready
  panelManager.initialize();

  sessionManager = new SessionManager(databaseService);
  sessionManager.initializeFromDatabase();
  sessionManager.cleanupOrphanedSessions();

  gitExecutor = new GitExecutor(sessionManager);
  worktreeManager = new WorktreeManager(gitExecutor);

  // Initialize the active project's worktree directory if one exists
  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    await worktreeManager.initializeProject(activeProject.path);
  }

  // Initialize executors
  claudeExecutor = new ClaudeExecutor(sessionManager, logger, configManager);
  codexExecutor = new CodexExecutor(sessionManager, logger, configManager);
  geminiExecutor = new GeminiExecutor(sessionManager, logger, configManager);
  kimiExecutor = new KimiExecutor(sessionManager, logger, configManager);

  gitDiffManager = new GitDiffManager(gitExecutor, logger);
  gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, gitExecutor, logger);
  gitStagingManager = new GitStagingManager(gitExecutor, gitStatusManager);
  executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  worktreeNameGenerator = new WorktreeNameGenerator(configManager);

  taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeExecutor,
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
    getMainWindow: () => mainWindow,
    gitExecutor
  });

  // Initialize Telegram service
  telegramService = new TelegramService({
    sessionManager,
    taskQueue,
    worktreeManager,
    claudeExecutor,
    codexExecutor,
    geminiExecutor,
    kimiExecutor,
    logger,
    configManager,
  });

  const services: AppServices = {
    app,
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    gitExecutor,
    claudeExecutor,
    codexExecutor,
    geminiExecutor,
    kimiExecutor,
    gitDiffManager,
    gitStatusManager,
    gitStagingManager,
    executionTracker,
    worktreeNameGenerator,
    taskQueue,
    getMainWindow: () => mainWindow,
    logger,
    updateManager,
    telegramService,
  };

  // Initialize IPC handlers first so managers (like ClaudePanelManager) are ready
  registerIpcHandlers(services);
  // Then set up event listeners that may rely on initialized managers
  setupEventListeners(services, () => mainWindow);

  // Register shell:openExternal handler
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external URL:', error);
      return { success: false, error: String(error) };
    }
  });

  // Register console logging IPC handler for development
  if (isDevelopment) {
    ipcMain.handle('console:log', (event, logData) => {
      const { level, args, timestamp, source } = logData;
      const message = args.join(' ');
      const logLine = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
      
      // Write to debug log file
      const debugLogPath = path.join(process.cwd(), 'snowtree-frontend-debug.log');
      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        console.error('Failed to write console log to debug file:', error);
      }
      
      // Also log to main console with prefix
      console.log(`[Frontend ${level}] ${message}`);
    });
  }
  
  // Start git status polling
  gitStatusManager.startPolling();
}

app.whenReady().then(async () => {
  // Record app start time
  appStartTime = Date.now();

  // Ensure a consistent app name in dev (otherwise macOS may show "Electron")
  app.setName('snowtree');
  process.title = 'snowtree';
  try {
    (app as unknown as { name: string }).name = 'snowtree';
  } catch {
    // ignore
  }

  // Set Dock icon on macOS (dev + runtime). Packaged apps also have icons via electron-builder,
  // but this ensures the correct icon while running via `electron .`.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = resolveIconPath();
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {
      // ignore
    }
  }

  // Setup application menu
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          {
            label: 'About snowtree',
            click: () => createAboutWindow()
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  console.log('[Main] App is ready, initializing services...');
  await initializeServices();
  console.log('[Main] Services initialized, creating window...');
  await createWindow();
  console.log('[Main] Window created successfully');

  // Forward update events to renderer (production only; updateManager is created in initializeServices).
  if (updateManager) {
    updateManager.on('update-available', (info: UpdateAvailableInfo) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', info);
        console.log(`[Main] Update available: ${info.version}`);
      }
    });

    updateManager.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded');
        console.log('[Main] Update downloaded');
      }
    });
  }

  // Refresh git status for all sessions after window is ready
  // This ensures the sidebar shows up-to-date git status for all workspaces
  setTimeout(() => {
    console.log('[Main] Refreshing git status for all sessions...');
    gitStatusManager.refreshAllSessions().catch((error) => {
      console.error('[Main] Failed to refresh git status on startup:', error);
    });
  }, 500); // Small delay to ensure renderer is ready to receive events

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      console.log('[Main] Activating app, creating new window...');
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  const isInstallingUpdate =
    Boolean(updateManager && typeof updateManager.isInstallingUpdate === 'function' && updateManager.isInstallingUpdate());

  if (isInstallingUpdate) {
    // When installing an update we must exit quickly; long grace periods can make "Restart" feel unresponsive.
    if (sessionManager) {
      try {
        await sessionManager.cleanup({ fast: true });
      } catch {
        // best-effort
      }
    }
    if (gitStatusManager) {
      gitStatusManager.stopPolling();
    }
    if (updateManager) {
      updateManager.cleanup();
    }
    if (claudeExecutor) {
      try {
        await claudeExecutor.cleanup();
      } catch {
        // best-effort
      }
    }
    if (codexExecutor) {
      try {
        await codexExecutor.cleanup();
      } catch {
        // best-effort
      }
    }
    if (geminiExecutor) {
      try {
        await geminiExecutor.cleanup();
      } catch {
        // best-effort
      }
    }
    if (kimiExecutor) {
      try {
        await kimiExecutor.cleanup();
      } catch {
        // best-effort
      }
    }
    if (taskQueue) {
      try {
        await taskQueue.close();
      } catch {
        // best-effort
      }
    }
    if (logger) {
      logger.close();
    }
    return;
  }

  // Cleanup all sessions and terminate child processes
  if (sessionManager) {
    console.log('[Main] Cleaning up sessions and terminating child processes...');
    await sessionManager.cleanup();
    console.log('[Main] Session cleanup complete');
  }

  // Stop git status polling
  if (gitStatusManager) {
    console.log('[Main] Stopping git status polling...');
    gitStatusManager.stopPolling();
    console.log('[Main] Git status polling stopped');
  }

  // Cleanup update manager
  if (updateManager) {
    console.log('[Main] Cleaning up update manager...');
    updateManager.cleanup();
    console.log('[Main] Update manager cleanup complete');
  }

  // Shutdown executors and all CLI processes
  if (claudeExecutor) {
    console.log('[Main] Shutting down Claude executor...');
    await claudeExecutor.cleanup();
    console.log('[Main] Claude executor shutdown complete');
  }
  if (codexExecutor) {
    console.log('[Main] Shutting down Codex executor...');
    await codexExecutor.cleanup();
    console.log('[Main] Codex executor shutdown complete');
  }
  if (geminiExecutor) {
    console.log('[Main] Shutting down Gemini executor...');
    await geminiExecutor.cleanup();
    console.log('[Main] Gemini executor shutdown complete');
  }
  if (kimiExecutor) {
    console.log('[Main] Shutting down Kimi executor...');
    await kimiExecutor.cleanup();
    console.log('[Main] Kimi executor shutdown complete');
  }

  // Close task queue
  if (taskQueue) {
    await taskQueue.close();
  }

  // Close logger to ensure all logs are flushed
  if (logger) {
    logger.close();
  }
});

// Export getter function for mainWindow
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
