import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InMemoryIpcMain, collectRepositories, parseArgs, registerRepoListHandler } from '../serverUtils';

const envSnapshot = { ...process.env };
const tempDirs: string[] = [];

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    process.env[key] = value;
  }
};

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowtree-server-'));
  tempDirs.push(dir);
  return dir;
};

const createGitDir = (dir: string) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
};

const createGitFile = (dir: string) => {
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: .git');
};

afterEach(() => {
  resetEnv();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('serverUtils.parseArgs', () => {
  it('uses environment defaults when no args are provided', () => {
    process.env.SNOWTREE_SERVER_HOST = '127.0.0.1';
    process.env.SNOWTREE_SERVER_PORT = '9090';
    process.env.SNOWTREE_UI_DIST = '/tmp/ui-dist';
    process.env.SNOWTREE_REPO_ROOT = '/tmp/repos';

    const args = parseArgs([]);

    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(9090);
    expect(args.uiDir).toBe(path.resolve('/tmp/ui-dist'));
    expect(args.repoRoot).toBe(path.resolve('/tmp/repos'));
  });

  it('prefers CLI args over environment defaults', () => {
    process.env.SNOWTREE_SERVER_HOST = '0.0.0.0';
    process.env.SNOWTREE_SERVER_PORT = '8080';
    process.env.SNOWTREE_UI_DIST = '/tmp/ui-default';
    process.env.SNOWTREE_REPO_ROOT = '/tmp/repos-default';

    const args = parseArgs([
      '--host', '192.168.1.10',
      '--port=9099',
      '--ui-dist', '/tmp/ui-cli',
      '--snowtree-dir', '/tmp/snowtree',
      '--repo-root=/tmp/repos-cli',
    ]);

    expect(args.host).toBe('192.168.1.10');
    expect(args.port).toBe(9099);
    expect(args.uiDir).toBe(path.resolve('/tmp/ui-cli'));
    expect(args.snowtreeDir).toBe(path.resolve('/tmp/snowtree'));
    expect(args.repoRoot).toBe(path.resolve('/tmp/repos-cli'));
  });
});

describe('serverUtils.collectRepositories', () => {
  it('returns root and nested repos sorted by name', async () => {
    const root = createTempDir();
    createGitDir(root);

    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    createGitFile(alpha);
    createGitDir(beta);

    const repositories = await collectRepositories(root);

    const expected = [
      { name: path.basename(root), path: path.resolve(root) },
      { name: 'alpha', path: path.resolve(alpha) },
      { name: 'beta', path: path.resolve(beta) },
    ].sort((a, b) => a.name.localeCompare(b.name));

    expect(repositories).toEqual(expected);
  });

  it('skips root when it is not a git repository', async () => {
    const root = createTempDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    createGitDir(repo);

    const repositories = await collectRepositories(root);

    expect(repositories.map((entry) => entry.name)).toEqual(['repo']);
  });
});

describe('serverUtils.registerRepoListHandler', () => {
  it('returns repositories when repo root is valid', async () => {
    const root = createTempDir();
    createGitDir(root);
    const ipcMain = new InMemoryIpcMain();

    registerRepoListHandler(ipcMain, root);
    const result = await ipcMain.invoke('dialog:list-repositories');

    expect(result).toEqual({
      success: true,
      data: [{ name: path.basename(root), path: path.resolve(root) }],
    });
  });

  it('returns error when repo root is not a directory', async () => {
    const root = createTempDir();
    const filePath = path.join(root, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'noop');

    const ipcMain = new InMemoryIpcMain();
    registerRepoListHandler(ipcMain, filePath);
    const result = await ipcMain.invoke('dialog:list-repositories');

    expect(result).toEqual({
      success: false,
      error: `Repository root is not a directory: ${path.resolve(filePath)}`,
    });
  });
});

describe('serverUtils.InMemoryIpcMain', () => {
  it('throws when invoking an unknown channel', async () => {
    const ipcMain = new InMemoryIpcMain();
    await expect(ipcMain.invoke('missing:channel')).rejects.toThrow('No IPC handler registered for missing:channel');
  });
});
