import { spawn } from 'child_process';
import type { TelegramCommandDefinition, TelegramCommandName, TelegramContext } from './types';
import type { SessionManager } from '../../features/session/SessionManager';
import type { Logger } from '../../infrastructure/logging';

export interface TelegramAgentDecision {
  command: TelegramCommandName;
  args?: Record<string, string>;
}

export class TelegramAgent {
  private claudePath: string | null = null;

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger,
    private commandDefinitions: TelegramCommandDefinition[]
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

  async processMessage(message: string, context: TelegramContext): Promise<TelegramAgentDecision> {
    if (!this.claudePath) {
      return this.fallbackProcess(message, context);
    }

    try {
      const contextStr = this.buildContextString(context);
      const systemPrompt = this.buildSystemPrompt(contextStr);

      const result = await this.runClaude(systemPrompt, message);
      return this.parseResponse(result);
    } catch (error) {
      this.logger.error('TelegramAgent error:', error as Error);
      return this.fallbackProcess(message, context);
    }
  }

  private buildContextString(context: TelegramContext): string {
    const project = context.activeProjectId
      ? this.sessionManager.db.getProject(context.activeProjectId)
      : null;
    const session = context.activeSessionId
      ? this.sessionManager.getSession(context.activeSessionId)
      : null;

    return `Active project: ${project?.name || 'none'}\nActive session: ${session?.name || 'none'}`;
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
        timeout: 30000,
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

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
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

  private buildSystemPrompt(contextStr: string): string {
    const commandList = this.commandDefinitions
      .map(cmd => `- ${cmd.name}: ${cmd.description}${cmd.args ? ` Params: ${cmd.args}` : ''}`)
      .join('\n');

    return `You are a Telegram bot assistant for Snowtree.
Your job: choose the best command for the user's message. Default to send_message for general questions or tasks.

Available commands:
${commandList}

Current context:
${contextStr}

Return JSON only, no explanation:
{ \"command\": \"command_name\", \"args\": { ... } }

Rules:
- Always pick a command from the list.
- Use get_chat_id when the user asks for their chat id.
- For general questions or tasks, use send_message with { message } even if there is no active session.
- If nothing fits, use unknown.`;
  }

  private parseResponse(text: string): TelegramAgentDecision {
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

  private fallbackProcess(message: string, context: TelegramContext): TelegramAgentDecision {
    const normalized = message.trim().replace(/^\//, '');
    const lower = normalized.toLowerCase();

    if (lower.includes('chat id') || lower.includes('chatid')) {
      return { command: 'get_chat_id' };
    }

    // Project commands
    if (lower.includes('project') && (lower.includes('list') || lower.includes('show') || lower.includes('all'))) {
      return { command: 'list_projects' };
    }
    if (lower.includes('open') || lower.includes('switch')) {
      const match = normalized.match(/(?:open|switch)\s+(?:to\s+)?(.+?)(?:\s+project)?$/i);
      if (match) {
        return { command: 'open_project', args: { name: match[1].trim() } };
      }
    }

    // Session commands
    if (lower.includes('session') && (lower.includes('list') || lower.includes('show'))) {
      return { command: 'list_sessions' };
    }
    if (lower.includes('select') || lower.includes('choose')) {
      const match = normalized.match(/(?:select|choose)\s+(\S+)/i);
      if (match) {
        return { command: 'select_session', args: { id: match[1] } };
      }
    }
    if (lower.includes('new') || lower.includes('create')) {
      const match = normalized.match(/(?:new|create)\s+(?:session\s+)?(.+)/i);
      if (match) {
        return { command: 'new_session', args: { prompt: match[1].trim() } };
      }
    }

    // Status
    if (lower.includes('status') || lower.includes('state') || lower.includes('current')) {
      return { command: 'status' };
    }

    if (lower.startsWith('send ') || lower.startsWith('message ')) {
      const payload = normalized.replace(/^(send|message)\s+/i, '').trim();
      if (payload) {
        return { command: 'send_message', args: { message: payload } };
      }
    }

    // Default: if there's an active session, send as message
    if (context.activeSessionId) {
      return { command: 'send_message', args: { message: normalized } };
    }

    return { command: 'unknown' };
  }

  isAvailable(): boolean {
    return this.claudePath !== null;
  }
}
