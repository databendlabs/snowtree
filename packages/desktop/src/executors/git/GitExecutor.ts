import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { getShellPath } from '../../infrastructure/command/shellPath';
import { escapeShellArg } from '../../infrastructure/security/shellEscape';
import type { SessionManager } from '../../features/session/SessionManager';
import type { TimelineEvent } from '../../infrastructure/database/models';

export type GitCommandKind = 'git.command' | 'worktree.command';

export type GitOperationType = 'read' | 'write';

export type GitRunOptions = {
  sessionId?: string | null;
  cwd: string;
  argv: string[];
  timeoutMs?: number;
  kind?: GitCommandKind;
  op?: GitOperationType;
  recordTimeline?: boolean;
  treatAsSuccessIfOutputIncludes?: string[];
  throwOnError?: boolean;
  meta?: Record<string, unknown>;
  encoding?: BufferEncoding;
};

export type GitRunResult = {
  commandDisplay: string;
  commandCopy: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  operationId: string;
};

const isSimpleToken = (token: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(token);

const formatCommandForDisplay = (argv: string[]): string =>
  argv.map((t) => (isSimpleToken(t) ? t : escapeShellArg(t))).join(' ');

const formatCommandForCopy = (argv: string[]): string => argv.map(escapeShellArg).join(' ');

export class GitExecutor {
  constructor(private sessionManager: SessionManager) {}

  async run(options: GitRunOptions): Promise<GitRunResult> {
    const argv = options.argv || [];
    if (argv.length === 0) throw new Error('GitExecutor.run requires argv');

    const commandDisplay = formatCommandForDisplay(argv);
    const commandCopy = formatCommandForCopy(argv);
    const operationId = randomUUID();
    const startMs = Date.now();
    const kind: GitCommandKind = options.kind || 'git.command';
    // Default: only record git/worktree commands that mutate state (user-visible actions).
    // This keeps Conversations focused on explicit operations (e.g. create/rename/remove worktree),
    // and avoids spamming the timeline with background reads (status/diff/log for UI refresh).
    const recordTimeline = Boolean(options.sessionId) && (options.recordTimeline ?? options.op === 'write');
    const meta = {
      ...(options.meta || {}),
      operationId,
      argv,
      op: options.op,
      commandCopy,
      treatAsSuccessIfOutputIncludes: options.treatAsSuccessIfOutputIncludes,
    };

    let startEvent: TimelineEvent | null = null;
    if (recordTimeline && options.sessionId) {
      startEvent = this.sessionManager.addTimelineEvent({
        session_id: options.sessionId,
        kind,
        status: 'started',
        command: commandDisplay,
        cwd: options.cwd,
        meta,
      });
      void startEvent;
    }

    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
    const throwOnError = options.throwOnError ?? true;

    const env = {
      ...process.env,
      PATH: getShellPath(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    } as Record<string, string>;

    const cmd = argv[0];
    const args = argv.slice(1);

    return await new Promise<GitRunResult>((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);

      const finalize = (
        result: { stdout: string; stderr: string; exitCode: number; error?: string; treatedAsSuccess?: boolean; originalExitCode?: number },
        status: 'finished' | 'failed',
        shouldThrow: boolean
      ) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startMs;

        if (recordTimeline && options.sessionId) {
          this.sessionManager.addTimelineEvent({
            session_id: options.sessionId,
            kind,
            status,
            command: commandDisplay,
            cwd: options.cwd,
            duration_ms: durationMs,
            exit_code: result.exitCode,
            meta: {
              ...meta,
              stdout: result.stdout,
              stderr: result.stderr,
              error: result.error,
              treatedAsSuccess: result.treatedAsSuccess,
              originalExitCode: result.originalExitCode,
            },
          });
        }

        const out: GitRunResult = {
          commandDisplay,
          commandCopy,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs,
          operationId,
        };

        if (status === 'failed' && shouldThrow) {
          const err = new Error(result.error || `Command failed: ${commandDisplay}`);
          (err as Error & { result?: GitRunResult }).result = out;
          reject(err);
        } else {
          resolve(out);
        }
      };

      proc.stdout.on('data', (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
      proc.stderr.on('data', (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));

      proc.on('error', (e) => {
        finalize(
          {
            stdout: Buffer.concat(stdoutChunks).toString(options.encoding || 'utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: 1,
            error: e instanceof Error ? e.message : String(e),
          },
          'failed',
          throwOnError
        );
      });

      proc.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString(options.encoding || 'utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const exitCode = typeof code === 'number' ? code : 0;
        if (exitCode === 0) {
          finalize({ stdout, stderr, exitCode }, 'finished', throwOnError);
        } else {
          const treat = (options.treatAsSuccessIfOutputIncludes || []).some((snippet) =>
            (stderr || '').includes(snippet) || (stdout || '').includes(snippet)
          );
          if (treat) {
            finalize({ stdout, stderr, exitCode: 0, treatedAsSuccess: true, originalExitCode: exitCode }, 'finished', throwOnError);
          } else {
            finalize({ stdout, stderr, exitCode, error: stderr || stdout || `Exit code ${exitCode}` }, 'failed', throwOnError);
          }
        }
      });
    });
  }
}

export default GitExecutor;
