/**
 * Logging utility for CLI tool communication (Claude Code, Codex, etc.)
 * Logs command execution and results to file for debugging.
 * Console output is only shown in dev mode (--snowtree-dev).
 */

import { fileLogger } from './fileLogger';

export type CliTool = 'Claude' | 'Codex' | 'CLI';

interface CliRequest {
  tool: CliTool;
  panelId: string;
  worktreePath: string;
  command: string;
  args: string[];
}

function short(id: string | undefined): string {
  if (!id) return '-';
  return id.substring(0, 8);
}

export class CliLogger {
  private static instance: CliLogger;
  private requestTimes: Map<string, number> = new Map();
  private consoleEnabled: boolean =
    process.argv.includes('--snowtree-dev') || process.env.SNOWTREE_CLI_LOG === '1';

  static getInstance(): CliLogger {
    if (!CliLogger.instance) {
      CliLogger.instance = new CliLogger();
    }
    return CliLogger.instance;
  }

  setEnabled(enabled: boolean): void {
    this.consoleEnabled = enabled;
  }

  /**
   * Log CLI command start
   */
  request(req: CliRequest): void {
    this.requestTimes.set(req.panelId, Date.now());

    const cmdStr = `${req.command} ${req.args.join(' ')}`.substring(0, 200);

    // Always log to file
    fileLogger.command(req.tool, cmdStr, [], {
      panelId: short(req.panelId),
      worktree: req.worktreePath
    });

    // Console output only in dev mode
    if (this.consoleEnabled) {
      console.log(`[CLI] ${req.tool} START panel=${short(req.panelId)} cmd=${cmdStr.substring(0, 80)}`);
    }
  }

  /**
   * Log CLI process completion
   */
  complete(tool: CliTool, panelId: string, exitCode: number): void {
    const startTime = this.requestTimes.get(panelId);
    const duration = startTime ? Date.now() - startTime : 0;
    this.requestTimes.delete(panelId);

    // Always log to file
    fileLogger.result(tool, 'CLI process', exitCode, duration);

    // Console output only in dev mode or on failure
    if (this.consoleEnabled || exitCode !== 0) {
      const status = exitCode === 0 ? 'OK' : `FAIL(${exitCode})`;
      const durationStr = (duration / 1000).toFixed(2);
      console.log(`[CLI] ${tool} END panel=${short(panelId)} status=${status} duration=${durationStr}s`);
    }
  }

  /**
   * Log error (always logged)
   */
  error(tool: CliTool, panelId: string, message: string, err?: Error): void {
    fileLogger.error(tool, `panel=${short(panelId)} ${message}`, err);

    // Errors always go to console
    console.error(`[CLI] ${tool} ERROR panel=${short(panelId)} ${message}${err ? `: ${err.message}` : ''}`);
  }

  /**
   * Log info message
   */
  info(tool: CliTool, panelId: string, message: string): void {
    fileLogger.info(tool, `panel=${short(panelId)} ${message}`);

    if (this.consoleEnabled) {
      console.log(`[CLI] ${tool} INFO panel=${short(panelId)} ${message}`);
    }
  }

  // Compatibility methods - these just log to file, no console output
  response(_res: unknown): void {}
  state(_tool: CliTool, _panelId: string, _from: string, _to: string): void {}
  event(_evt: unknown): void {}
  debug(_tool: CliTool, _panelId: string, _message: string): void {}
}

export const cliLogger = CliLogger.getInstance();
