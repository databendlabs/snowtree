/**
 * Simple file logger for infrastructure modules.
 * Writes to ~/.snowtree/logs/ without requiring ConfigManager dependency.
 * Use this for logging important state changes, command executions, and debug info
 * that should be preserved for troubleshooting but not shown in console.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { app } from 'electron';

class FileLogger {
  private static instance: FileLogger;
  private logDir: string;
  private logStream: fs.WriteStream | null = null;
  private currentLogFile: string = '';
  private currentDate: string = '';
  private readonly MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
  private readonly MAX_LOG_FILES = 10;
  private currentLogSize = 0;
  private initPromise: Promise<void> | null = null;

  private constructor() {
    const isDev = process.argv.includes('--snowtree-dev');
    const baseDir = process.env.SNOWTREE_DIR || path.join(homedir(), isDev ? '.snowtree_dev' : '.snowtree');
    this.logDir = path.join(baseDir, 'logs');
  }

  static getInstance(): FileLogger {
    if (!FileLogger.instance) {
      FileLogger.instance = new FileLogger();
    }
    return FileLogger.instance;
  }

  private getDateStr(): string {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 23);
  }

  private async ensureLogFile(): Promise<void> {
    const dateStr = this.getDateStr();

    // Check if we need to switch to a new day's file
    if (dateStr !== this.currentDate || !this.logStream) {
      this.currentDate = dateStr;

      // Close existing stream
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }

      // Ensure log directory exists
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      this.currentLogFile = path.join(this.logDir, `debug-${dateStr}.log`);

      // Get current file size if exists
      if (fs.existsSync(this.currentLogFile)) {
        this.currentLogSize = fs.statSync(this.currentLogFile).size;
      } else {
        this.currentLogSize = 0;
      }

      this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });

      // Clean up old log files
      this.cleanupOldLogs();
    }
  }

  private cleanupOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          mtime: fs.statSync(path.join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (files.length > this.MAX_LOG_FILES) {
        files.slice(this.MAX_LOG_FILES).forEach(f => {
          try {
            fs.unlinkSync(f.path);
          } catch {
            // Ignore deletion errors
          }
        });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private rotateIfNeeded(): void {
    if (this.currentLogSize >= this.MAX_LOG_SIZE && this.logStream) {
      this.logStream.end();
      this.logStream = null;

      // Rename current file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = path.join(this.logDir, `debug-${this.currentDate}-${timestamp}.log`);
      try {
        fs.renameSync(this.currentLogFile, rotatedFile);
      } catch {
        // Ignore rotation errors
      }

      this.currentLogSize = 0;
      this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
    }
  }

  private write(level: string, category: string, message: string, details?: Record<string, unknown>): void {
    // Use sync initialization to avoid race conditions
    if (!this.initPromise) {
      this.initPromise = this.ensureLogFile();
    }

    const timestamp = this.getTimestamp();
    const detailsStr = details ? ` ${JSON.stringify(details)}` : '';
    const logLine = `[${timestamp}] ${level} [${category}] ${message}${detailsStr}\n`;

    // Write asynchronously but don't block
    this.initPromise.then(() => {
      this.rotateIfNeeded();
      if (this.logStream && !this.logStream.destroyed) {
        this.logStream.write(logLine);
        this.currentLogSize += Buffer.byteLength(logLine);
      }
    }).catch(() => {
      // Silently fail - logging should never break the app
    });
  }

  /**
   * Log command execution
   */
  command(category: string, cmd: string, args: string[], details?: Record<string, unknown>): void {
    const cmdStr = `${cmd} ${args.join(' ')}`.substring(0, 500);
    this.write('CMD', category, cmdStr, details);
  }

  /**
   * Log command result
   */
  result(category: string, cmd: string, exitCode: number, duration?: number): void {
    const status = exitCode === 0 ? 'OK' : `FAIL(${exitCode})`;
    const durationStr = duration !== undefined ? ` duration=${(duration / 1000).toFixed(2)}s` : '';
    this.write('RES', category, `${cmd} -> ${status}${durationStr}`);
  }

  /**
   * Log state change
   */
  state(category: string, action: string, details?: Record<string, unknown>): void {
    this.write('STATE', category, action, details);
  }

  /**
   * Log info message
   */
  info(category: string, message: string, details?: Record<string, unknown>): void {
    this.write('INFO', category, message, details);
  }

  /**
   * Log error
   */
  error(category: string, message: string, err?: Error): void {
    const errDetails = err ? { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') } : undefined;
    this.write('ERROR', category, message, errDetails);
  }

  /**
   * Log debug info (PATH, config, etc.)
   */
  debug(category: string, message: string, details?: Record<string, unknown>): void {
    this.write('DEBUG', category, message, details);
  }

  /**
   * Close the logger
   */
  close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

export const fileLogger = FileLogger.getInstance();
