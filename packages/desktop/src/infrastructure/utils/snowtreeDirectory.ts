import { homedir } from 'os';
import { join } from 'path';
import { app } from 'electron';

let customSnowtreeDir: string | undefined;

/**
 * Sets a custom Snowtree directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
export function setSnowtreeDirectory(dir: string): void {
  customSnowtreeDir = dir;
}

/**
 * Gets the Snowtree directory path. Returns the custom directory if set,
 * otherwise falls back to the environment variable SNOWTREE_DIR,
 * and finally defaults to ~/.snowtree
 */
export function getSnowtreeDirectory(): string {
  if (customSnowtreeDir) return customSnowtreeDir;

  const envDir = process.env.SNOWTREE_DIR;
  if (envDir) return envDir;

  const isDevelopment = Boolean(
    (app as { commandLine?: { hasSwitch?: (name: string) => boolean } } | undefined)
      ?.commandLine
      ?.hasSwitch
      ?.('snowtree-dev')
  );

  if (isDevelopment) {
    return join(homedir(), '.snowtree_dev');
  }

  return join(homedir(), '.snowtree');
}

/**
 * Gets a subdirectory path within the Snowtree directory
 */
export function getSnowtreeSubdirectory(...subPaths: string[]): string {
  return join(getSnowtreeDirectory(), ...subPaths);
}
