import { spawn } from 'child_process';
import type { SnowTreeCommandDefinition, SnowTreeCommandName, SnowTreeCommandRequest, ChannelContext } from './types';
import type { SessionManager } from '../../features/session/SessionManager';
import type { Logger } from '../../infrastructure/logging';

export interface CommandInterpreterDecision {
  command: SnowTreeCommandName;
  args?: Record<string, string>;
}

/**
 * CommandInterpreter - Interprets natural language into SnowTree commands
 *
 * Uses Claude CLI when available, falls back to pattern matching.
 * Channel-agnostic - can be used by any channel adapter.
 */
export class CommandInterpreter {
  private claudePath: string | null = null;

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger,
    private commandDefinitions: SnowTreeCommandDefinition[]
  ) {
    this.detectClaudeCli();
  }

  private async detectClaudeCli(): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      execSync('which claude', { encoding: 'utf-8' });
      this.claudePath = 'claude';
    } catch {
      this.claudePath = null;
    }
  }

  async interpret(message: string, context: ChannelContext): Promise<SnowTreeCommandRequest> {
    const normalized = message.trim().replace(/^\//, '');
    let decision: CommandInterpreterDecision;

    // Try fallback first - it's fast and handles most common commands
    decision = this.fallbackInterpret(normalized, context);

    // Only use Claude CLI if fallback returns unknown and we have complex input
    if (decision.command === 'unknown' && this.claudePath && normalized.length > 3) {
      try {
        const contextStr = this.buildContextString(context);
        const systemPrompt = this.buildSystemPrompt(contextStr);
        const result = await this.runClaude(systemPrompt, normalized);
        const aiDecision = this.parseResponse(result);
        if (aiDecision.command !== 'unknown') {
          decision = aiDecision;
        }
      } catch (error) {
        // Claude CLI failed, stick with fallback result
        this.logger.warn('CommandInterpreter Claude CLI failed, using fallback');
      }
    }

    // Convert unknown to send_message if there's an active session
    if (decision.command === 'unknown' && context.activeSessionId) {
      return {
        name: 'send_message',
        args: { message: normalized },
        rawText: message
      };
    }

    return {
      name: decision.command,
      args: decision.args,
      rawText: message
    };
  }

  private buildContextString(context: ChannelContext): string {
    const project = context.activeProjectId
      ? this.sessionManager.db.getProject(context.activeProjectId)
      : null;
    const session = context.activeSessionId
      ? this.sessionManager.getSession(context.activeSessionId)
      : null;

    return `Active project: ${project?.name || 'none'}\nActive session: ${session?.name || 'none'}`;
  }

  private buildSystemPrompt(contextStr: string): string {
    const commandList = this.commandDefinitions
      .map(cmd => `- ${cmd.name}: ${cmd.description}${cmd.args ? ` Params: ${cmd.args}` : ''}`)
      .join('\n');

    return `You are a command interpreter for Snowtree.
Your job: choose the best command for the user's message. Default to send_message for general questions or tasks.

Available commands:
${commandList}

Current context:
${contextStr}

Return JSON only, no explanation:
{ "command": "command_name", "args": { ... } }

Rules:
- Always pick a command from the list.
- For general questions or tasks, use send_message with { message } even if there is no active session.
- If nothing fits, use unknown.`;
  }

  private async runClaude(systemPrompt: string, userMessage: string): Promise<string> {
    const env = {
      ...process.env,
      CLAUDE_SYSTEM_PROMPT: systemPrompt,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };

    try {
      return await this.runClaudeWithArgs(['--print', '--output-format', 'text', '-p', userMessage], env);
    } catch (error) {
      if (this.isUnknownOptionError(error)) {
        return await this.runClaudeWithArgs(['-p', userMessage], env);
      }
      throw error;
    }
  }

  private runClaudeWithArgs(args: string[], env: Record<string, string | undefined>): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        timeout: 60000, // 60 seconds
        env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else if (signal === 'SIGTERM' || code === 143) {
          // Timeout or killed - treat as fallback case
          reject(new Error('Claude CLI timeout'));
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  private isUnknownOptionError(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('unknown option');
  }

  private parseResponse(text: string): CommandInterpreterDecision {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          command: parsed.command || parsed.action || 'unknown',
          args: parsed.args || parsed.params
        };
      }
    } catch {
      // ignore parse errors
    }
    return { command: 'unknown' };
  }

  private fallbackInterpret(message: string, context: ChannelContext): CommandInterpreterDecision {
    const lower = message.toLowerCase();

    // Project commands
    if (lower.includes('project') && (lower.includes('list') || lower.includes('show') || lower.includes('all'))) {
      return { command: 'list_projects' };
    }
    if (lower.includes('open') || lower.includes('switch')) {
      const match = message.match(/(?:open|switch)\s+(?:to\s+)?(.+?)(?:\s+project)?$/i);
      if (match) {
        return { command: 'open_project', args: { name: match[1].trim() } };
      }
    }

    // Session commands
    if (lower.includes('session') && (lower.includes('list') || lower.includes('show'))) {
      return { command: 'list_sessions' };
    }
    if (lower.includes('select') || lower.includes('choose')) {
      const match = message.match(/(?:select|choose)\s+(\S+)/i);
      if (match) {
        return { command: 'select_session', args: { id: match[1] } };
      }
    }
    if (lower.includes('new') || lower.includes('create')) {
      const match = message.match(/(?:new|create)\s+(?:session\s+)?(.+)/i);
      if (match) {
        return { command: 'new_session', args: { prompt: match[1].trim() } };
      }
    }

    // Status
    if (lower.includes('status') || lower.includes('state') || lower.includes('current')) {
      return { command: 'status' };
    }

    // Switch executor
    if (lower.includes('switch') || lower.includes('use')) {
      const executors = ['claude', 'codex', 'gemini', 'kimi'];
      for (const exec of executors) {
        if (lower.includes(exec)) {
          return { command: 'switch_executor', args: { executor: exec } };
        }
      }
    }

    // Stop session
    if (lower.includes('stop') && (lower.includes('session') || lower.includes('agent'))) {
      return { command: 'stop_session' };
    }

    // Delete session
    if (lower.includes('delete') || lower.includes('remove')) {
      const match = message.match(/(?:delete|remove)\s+(?:session\s+)?(\S+)/i);
      if (match) {
        return { command: 'delete_session', args: { id: match[1] } };
      }
    }

    // Explicit send
    if (lower.startsWith('send ') || lower.startsWith('message ')) {
      const payload = message.replace(/^(send|message)\s+/i, '').trim();
      if (payload) {
        return { command: 'send_message', args: { message: payload } };
      }
    }

    // Help
    if (lower === 'help' || lower.includes('help me') || lower.includes('commands')) {
      return { command: 'help' };
    }

    // Default: if there's an active session, send as message
    if (context.activeSessionId) {
      return { command: 'send_message', args: { message } };
    }

    return { command: 'unknown' };
  }

  isAvailable(): boolean {
    return this.claudePath !== null;
  }
}
