import { chromium, FullConfig } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

async function globalSetup(config: FullConfig) {
  console.log('[Global Setup] Verifying E2E test setup...');

  // Keep E2E runs isolated from the developer's real ~/.snowtree_dev state.
  process.env.SNOWTREE_DIR = process.env.SNOWTREE_DIR || path.join(process.cwd(), '.snowtree_e2e');

  console.log('[Global Setup] Creating test repository...');
  const setupScript = path.join(process.cwd(), 'scripts/setup-e2e-repo.mjs');
  execSync(`node ${setupScript}`, { stdio: 'inherit' });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Inject minimal mock electronAPI for global setup verification
  await page.addInitScript(() => {
    (window as any).electronAPI = {
      projects: {
        async getAll() {
          return { success: true, data: [{ id: 1, name: 'Test', path: '/test', active: true }] };
        },
      },
      sessions: {
        async getAll() { return { success: true, data: [] }; },
      },
      settings: {
        async load() { return { success: true, data: null }; },
        async save() { return { success: true }; },
      },
      telegram: {
        async start() { return { success: true }; },
        async stop() { return { success: true }; },
      },
      events: {
        onSessionsLoaded: () => () => {},
        onSessionCreated: () => () => {},
        onSessionUpdated: () => () => {},
        onSessionDeleted: () => () => {},
        onGitStatusUpdated: () => () => {},
        onGitStatusLoading: () => () => {},
        onUpdateAvailable: () => () => {},
        onUpdateDownloaded: () => () => {},
        onTimelineEvent: () => () => {},
        onAssistantStream: () => () => {},
        onTerminalOutput: () => () => {},
        onTerminalExit: () => () => {},
        onAgentCompleted: () => () => {},
        onSessionTodosUpdate: () => () => {},
        onTelegramStateChanged: () => () => {},
      },
    };
  });

  console.log('[Global Setup] Waiting for app to load...');
  await page.goto('http://localhost:4521');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('text=/Workspaces|Failed to Load Workspaces/i', { timeout: 15000 });

  await page.waitForTimeout(2000);
  await browser.close();

  console.log('[Global Setup] Setup complete!');
}

export default globalSetup;
