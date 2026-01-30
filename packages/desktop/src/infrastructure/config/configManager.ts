/**
 * ConfigManager stub for desktop package
 * This is a minimal implementation to satisfy type requirements
 */
import * as path from 'path';
import { getSnowtreeDirectory } from '../utils/snowtreeDirectory';

export interface AppConfig {
  claudeExecutablePath?: string;
  codexExecutablePath?: string;
  geminiExecutablePath?: string;
  kimiExecutablePath?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  verbose?: boolean;
  [key: string]: unknown;
}

export class ConfigManager {
  private config: AppConfig = {};

  async initialize(): Promise<void> {
    // Stub implementation - configuration is managed elsewhere
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getAnthropicApiKey(): string | undefined {
    return this.config.anthropicApiKey;
  }

  getDatabasePath(): string {
    const snowtreeDir = getSnowtreeDirectory();
    return path.join(snowtreeDir, 'sessions.db');
  }

  isVerbose(): boolean {
    return this.config.verbose || false;
  }

  getGitRepoPath(): string {
    return process.cwd();
  }
}
