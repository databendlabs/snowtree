import * as path from 'path';
import * as fs from 'fs';
import type { IpcMainInvokeEvent } from 'electron';
import type { IPCResponse, IpcHandlerTarget } from '../infrastructure/ipc/types';

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown> | unknown;

export class InMemoryIpcMain implements IpcHandlerTarget {
  private readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No IPC handler registered for ${channel}`);
    }
    return handler({} as IpcMainInvokeEvent, ...args);
  }

  getRegisteredChannels(): string[] {
    return Array.from(this.handlers.keys());
  }
}

async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const gitPath = path.join(dir, '.git');
    const stats = await fs.promises.stat(gitPath);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

export async function collectRepositories(repoRoot: string): Promise<Array<{ name: string; path: string }>> {
  const normalizedRoot = path.resolve(repoRoot);
  const repositories: Array<{ name: string; path: string }> = [];

  if (await isGitRepository(normalizedRoot)) {
    repositories.push({
      name: path.basename(normalizedRoot),
      path: normalizedRoot
    });
  }

  const entries = await fs.promises.readdir(normalizedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(normalizedRoot, entry.name);
    if (await isGitRepository(fullPath)) {
      repositories.push({
        name: entry.name,
        path: fullPath
      });
    }
  }

  repositories.sort((a, b) => a.name.localeCompare(b.name));
  return repositories;
}

export function registerRepoListHandler(ipcMain: IpcHandlerTarget, repoRoot: string): void {
  const resolved = path.resolve(repoRoot);
  ipcMain.handle('dialog:list-repositories', async () => {
    try {
      const stats = await fs.promises.stat(resolved);
      if (!stats.isDirectory()) {
        return { success: false, error: `Repository root is not a directory: ${resolved}` } satisfies IPCResponse;
      }
      const repositories = await collectRepositories(resolved);
      return { success: true, data: repositories } satisfies IPCResponse<Array<{ name: string; path: string }>>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message } satisfies IPCResponse;
    }
  });
}

export type ParsedArgs = {
  host: string;
  port: number;
  uiDir: string;
  snowtreeDir?: string;
  repoRoot?: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const defaults: ParsedArgs = {
    host: process.env.SNOWTREE_SERVER_HOST || '0.0.0.0',
    port: Number(process.env.SNOWTREE_SERVER_PORT || 8080),
    uiDir: process.env.SNOWTREE_UI_DIST
      ? path.resolve(process.env.SNOWTREE_UI_DIST)
      : path.resolve(process.cwd(), 'packages/ui/dist'),
    repoRoot: process.env.SNOWTREE_REPO_ROOT ? path.resolve(process.env.SNOWTREE_REPO_ROOT) : undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      defaults.host = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--host=')) {
      defaults.host = arg.slice('--host='.length);
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      defaults.port = Number(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--port=')) {
      defaults.port = Number(arg.slice('--port='.length));
      continue;
    }
    if (arg === '--ui-dist' && argv[i + 1]) {
      defaults.uiDir = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--ui-dist=')) {
      defaults.uiDir = path.resolve(arg.slice('--ui-dist='.length));
      continue;
    }
    if (arg === '--snowtree-dir' && argv[i + 1]) {
      defaults.snowtreeDir = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--snowtree-dir=')) {
      defaults.snowtreeDir = path.resolve(arg.slice('--snowtree-dir='.length));
      continue;
    }
    if (arg === '--repo-root' && argv[i + 1]) {
      defaults.repoRoot = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--repo-root=')) {
      defaults.repoRoot = path.resolve(arg.slice('--repo-root='.length));
      continue;
    }
  }

  return defaults;
}
