import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { randomUUID } from 'crypto';
import { getShellPath } from '../../infrastructure/command/shellPath';
import { ShellDetector } from '../../infrastructure/command/shellDetector';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

export type TerminalSummary = {
  id: string;
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
};

interface TerminalSession extends TerminalSummary {
  pty: pty.IPty;
}

export class TerminalManager extends EventEmitter {
  private terminalSessions: Map<string, TerminalSession> = new Map();
  private terminalIdsBySession: Map<string, Set<string>> = new Map();
  private defaultTerminalBySession: Map<string, string> = new Map();
  private terminalCountBySession: Map<string, number> = new Map();

  constructor() {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    this.setMaxListeners(50);
  }

  async createTerminalSession(
    sessionId: string,
    worktreePath: string,
    options?: { terminalId?: string; title?: string; makeDefault?: boolean }
  ): Promise<TerminalSession> {
    const existingId = options?.terminalId;
    if (existingId) {
      const existing = this.terminalSessions.get(existingId);
      if (existing) return existing;
    }

    const terminalId = existingId ?? randomUUID();
    const title = options?.title ?? this.getNextTitle(sessionId);
    const createdAt = new Date().toISOString();

    // For Linux, use the current PATH to avoid slow shell detection
    const isLinux = process.platform === 'linux';
    const shellPath = isLinux ? (process.env.PATH || '') : getShellPath();

    // Get the user's default shell
    const shellInfo = ShellDetector.getDefaultShell();
    console.log(`Using shell: ${shellInfo.path} (${shellInfo.name})`);

    // Create a new PTY instance with proper terminal settings
    const ptyProcess = pty.spawn(shellInfo.path, shellInfo.args || [], {
      name: 'xterm-256color',  // Better terminal emulation
      cwd: worktreePath,
      cols: 80,
      rows: 24,
      env: {
        ...process.env,
        PATH: shellPath,
        WORKTREE_PATH: worktreePath,
        TERM: 'xterm-256color',  // Ensure TERM is set for color support
        COLORTERM: 'truecolor',  // Enable 24-bit color
        LANG: process.env.LANG || 'en_US.UTF-8',  // Set locale for proper character handling
      },
    });

    const terminalSession: TerminalSession = {
      id: terminalId,
      pty: ptyProcess,
      sessionId,
      cwd: worktreePath,
      title,
      createdAt,
    };

    // Store the session
    this.terminalSessions.set(terminalId, terminalSession);
    this.trackTerminal(sessionId, terminalId, options?.makeDefault === true);

    // Handle data from the PTY
    ptyProcess.onData((data: string) => {
      this.emit('terminal-output', { sessionId, terminalId, data, type: 'stdout' });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Terminal session ${terminalId} exited with code ${exitCode}, signal ${signal}`);
      this.handleTerminalExit(terminalId, sessionId, exitCode, signal);
    });

    // Don't send any initial input - let the user interact with the terminal
    // This prevents unnecessary terminal output and activity indicators
    return terminalSession;
  }

  sendCommand(terminalId: string, command: string): void {
    const session = this.terminalSessions.get(terminalId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send the command to the PTY
    session.pty.write(command + '\r');
  }

  sendInput(terminalId: string, data: string): void {
    const session = this.terminalSessions.get(terminalId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send raw input directly to the PTY without modification
    session.pty.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    const session = this.terminalSessions.get(terminalId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  async closeTerminalSession(terminalId: string, options?: { fast?: boolean }): Promise<void> {
    const session = this.terminalSessions.get(terminalId);
    if (session) {
      try {
        const pid = session.pty.pid;

        // Kill the process tree to ensure all child processes are terminated
        if (pid) {
          const success = await this.killProcessTree(pid, options);
          if (!success) {
            // Emit warning about zombie processes
            this.emit('zombie-processes-detected', {
              sessionId: session.sessionId,
              terminalId,
              message: 'Warning: Some child processes could not be terminated. Check system process list.'
            });
          }
        }

        // Also try to kill via pty interface as fallback
        try {
          session.pty.kill();
        } catch (error) {
          // PTY might already be dead
        }
      } catch (error) {
        console.warn(`Error killing terminal session ${terminalId}:`, error);
      }
      this.cleanupTerminal(terminalId, session.sessionId);
      this.emit('terminal-closed', { sessionId: session.sessionId, terminalId });
    }
  }

  hasSession(sessionId: string): boolean {
    return this.terminalIdsBySession.has(sessionId);
  }

  hasTerminal(terminalId: string): boolean {
    return this.terminalSessions.has(terminalId);
  }

  getTerminal(terminalId: string): TerminalSession | undefined {
    return this.terminalSessions.get(terminalId);
  }

  listTerminals(sessionId: string): TerminalSummary[] {
    const ids = this.terminalIdsBySession.get(sessionId);
    if (!ids) return [];
    const terminals: TerminalSummary[] = [];
    for (const id of ids) {
      const terminal = this.terminalSessions.get(id);
      if (terminal) {
        terminals.push({
          id: terminal.id,
          sessionId: terminal.sessionId,
          cwd: terminal.cwd,
          title: terminal.title,
          createdAt: terminal.createdAt,
        });
      }
    }
    return terminals;
  }

  getDefaultTerminalId(sessionId: string): string | null {
    const terminalId = this.defaultTerminalBySession.get(sessionId);
    if (terminalId && this.terminalSessions.has(terminalId)) return terminalId;
    const ids = this.terminalIdsBySession.get(sessionId);
    if (!ids || ids.size === 0) return null;
    const fallback = ids.values().next().value as string | undefined;
    if (fallback) {
      this.defaultTerminalBySession.set(sessionId, fallback);
      return fallback;
    }
    return null;
  }

  async closeTerminalsForSession(sessionId: string, options?: { fast?: boolean }): Promise<void> {
    const ids = this.terminalIdsBySession.get(sessionId);
    if (!ids || ids.size === 0) return;
    const closePromises = Array.from(ids).map((terminalId) => this.closeTerminalSession(terminalId, options));
    await Promise.all(closePromises);
    this.terminalIdsBySession.delete(sessionId);
    this.defaultTerminalBySession.delete(sessionId);
    this.terminalCountBySession.delete(sessionId);
  }

  async cleanup(options?: { fast?: boolean }): Promise<void> {
    // Close all terminal sessions
    const closePromises = [];
    for (const terminalId of this.terminalSessions.keys()) {
      closePromises.push(this.closeTerminalSession(terminalId, options));
    }
    await Promise.all(closePromises);
  }

  private getNextTitle(sessionId: string): string {
    const current = this.terminalCountBySession.get(sessionId) || 0;
    const next = current + 1;
    this.terminalCountBySession.set(sessionId, next);
    return `Terminal ${next}`;
  }

  private trackTerminal(sessionId: string, terminalId: string, makeDefault: boolean): void {
    const set = this.terminalIdsBySession.get(sessionId) ?? new Set<string>();
    set.add(terminalId);
    this.terminalIdsBySession.set(sessionId, set);
    if (makeDefault || !this.defaultTerminalBySession.has(sessionId)) {
      this.defaultTerminalBySession.set(sessionId, terminalId);
    }
  }

  private cleanupTerminal(terminalId: string, sessionId: string): void {
    if (!this.terminalSessions.has(terminalId)) return;
    this.terminalSessions.delete(terminalId);
    const set = this.terminalIdsBySession.get(sessionId);
    if (set) {
      set.delete(terminalId);
      if (set.size === 0) {
        this.terminalIdsBySession.delete(sessionId);
      }
    }
    if (this.defaultTerminalBySession.get(sessionId) === terminalId) {
      const next = set && set.size > 0 ? (set.values().next().value as string) : null;
      if (next) {
        this.defaultTerminalBySession.set(sessionId, next);
      } else {
        this.defaultTerminalBySession.delete(sessionId);
      }
    }
  }

  private handleTerminalExit(terminalId: string, sessionId: string, exitCode: number, signal?: number): void {
    if (!this.terminalSessions.has(terminalId)) return;
    this.cleanupTerminal(terminalId, sessionId);
    this.emit('terminal-exited', { sessionId, terminalId, exitCode, signal });
  }

  /**
   * Get all descendant PIDs of a parent process recursively
   * This is critical for ensuring all child processes are killed
   */
  private getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];
    const platform = os.platform();
    
    try {
      if (platform === 'win32') {
        // Windows: Use WMIC to get child processes
        const result = require('child_process').execSync(
          `wmic process where (ParentProcessId=${parentPid}) get ProcessId`,
          { encoding: 'utf8' }
        );
        
        const lines = result.split('\n').filter((line: string) => line.trim());
        for (let i = 1; i < lines.length; i++) { // Skip header
          const pid = parseInt(lines[i].trim());
          if (!isNaN(pid) && pid !== parentPid) {
            descendants.push(pid);
            // Recursively get children of this process
            descendants.push(...this.getAllDescendantPids(pid));
          }
        }
      } else {
        // Unix/Linux/macOS: Use ps command
        const result = require('child_process').execSync(
          `ps -o pid= --ppid ${parentPid} 2>/dev/null || true`,
          { encoding: 'utf8' }
        );
        
        const pids = result.split('\n')
          .map((line: string) => parseInt(line.trim()))
          .filter((pid: number) => !isNaN(pid) && pid !== parentPid);
        
        for (const pid of pids) {
          descendants.push(pid);
          // Recursively get children of this process
          descendants.push(...this.getAllDescendantPids(pid));
        }
      }
    } catch (error) {
      console.warn(`Error getting descendant PIDs for ${parentPid}:`, error);
    }
    
    // Remove duplicates
    return [...new Set(descendants)];
  }

  /**
   * Kill a process and all its descendants
   * Returns true if successful, false if zombie processes remain
   */
  private async killProcessTree(pid: number, options?: { fast?: boolean }): Promise<boolean> {
    const platform = os.platform();
    const execAsync = promisify(exec);
    const fast = options?.fast === true;
    
    // First, get all descendant PIDs before we start killing
    const descendantPids = this.getAllDescendantPids(pid);
    
    let success = true;
    
    try {
      if (platform === 'win32') {
        // On Windows, use taskkill to terminate the process tree
        try {
          await execAsync(`taskkill /F /T /PID ${pid}`);
        } catch (error) {
          console.warn(`Error killing Windows process tree: ${error}`);
          // Fallback: kill descendants individually
          for (const childPid of descendantPids) {
            try {
              await execAsync(`taskkill /F /PID ${childPid}`);
            } catch (e) {
              // Process might already be dead
            }
          }
        }
      } else {
        // On Unix-like systems (macOS, Linux)
        // First, try SIGTERM for graceful shutdown
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          console.warn('SIGTERM failed:', error);
        }
        
        // Kill the entire process group using negative PID
        // First, find the actual process group ID
        let pgid = pid;
        try {
          const pgidResult = await execAsync(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
          const foundPgid = parseInt(pgidResult.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
          }
        } catch (error) {
          // Use original PID as fallback
        }
        
        try {
          await execAsync(`kill -TERM -${pgid}`);
        } catch (error) {
          console.warn(`Error sending SIGTERM to process group: ${error}`);
        }
        
        // Give processes time to clean up gracefully (shorten for updater-driven restarts)
        await new Promise(resolve => setTimeout(resolve, fast ? 250 : 10000));
        
        // Now forcefully kill the main process
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          // Process might already be dead
        }
        
        // Kill the process group with SIGKILL
        try {
          await execAsync(`kill -9 -${pgid}`);
        } catch (error) {
          console.warn(`Error sending SIGKILL to process group: ${error}`);
        }
        
        // Kill all known descendants individually to be sure
        for (const childPid of descendantPids) {
          try {
            await execAsync(`kill -9 ${childPid}`);
          } catch (error) {
            // Process already terminated
          }
        }
        
        // Final cleanup attempt using pkill
        try {
          await execAsync(`pkill -9 -P ${pid}`);
        } catch (error) {
          // Ignore errors - processes might already be dead
        }
      }
      
      // Verify all processes are actually dead
      await new Promise(resolve => setTimeout(resolve, fast ? 100 : 500));
      const remainingPids = this.getAllDescendantPids(pid);
      
      if (remainingPids.length > 0) {
        console.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        success = false;
        
        // Emit error event so UI can show warning
        this.emit('zombie-processes-detected', {
          sessionId: null,
          pids: remainingPids,
          message: `Failed to terminate ${remainingPids.length} child processes. Please manually kill PIDs: ${remainingPids.join(', ')}`
        });
      }
    } catch (error) {
      console.error('Error in killProcessTree:', error);
      success = false;
    }
    
    return success;
  }
}
