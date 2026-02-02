import { spawn } from 'child_process';
import type { TelegramContext } from './types';
import type { SessionManager } from '../../features/session/SessionManager';
import type { Logger } from '../../infrastructure/logging';

export interface AgentAction {
  action: 'open_project' | 'list_projects' | 'list_sessions' | 'select_session' | 'new_session' | 'status' | 'send_message' | 'unknown';
  params?: Record<string, string>;
  response?: string;
}

const SYSTEM_PROMPT = `You are a Telegram bot assistant for Snowtree, a code review tool.
Your job is to interpret user messages and determine what action to take.

Available actions:
- open_project: Open a project by name. Params: { name: string }
- list_projects: List all available projects
- list_sessions: List sessions in current project
- select_session: Select a session by ID prefix. Params: { id: string }
- new_session: Create new session with prompt. Params: { prompt: string }
- status: Show current status
- send_message: Send a message to the active session. Params: { message: string }
- unknown: Cannot determine action

Current context:
{{CONTEXT}}

Respond with JSON only, no explanation:
{ "action": "action_name", "params": { ... } }

Examples:
- "open databend project" -> { "action": "open_project", "params": { "name": "databend" } }
- "list projects" -> { "action": "list_projects" }
- "show sessions" -> { "action": "list_sessions" }
- "select abc123" -> { "action": "select_session", "params": { "id": "abc123" } }
- "new session fix login bug" -> { "action": "new_session", "params": { "prompt": "fix login bug" } }
- "current status" -> { "action": "status" }
- "help me check this file" -> { "action": "send_message", "params": { "message": "help me check this file" } }
- If user sends a coding question or task and there's an active session, use send_message.`;

export class TelegramAgent {
  private claudePath: string | null = null;

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
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

  async processMessage(message: string, context: TelegramContext): Promise<AgentAction> {
    if (!this.claudePath) {
      return this.fallbackProcess(message, context);
    }

    try {
      const contextStr = this.buildContextString(context);
      const systemPrompt = SYSTEM_PROMPT.replace('{{CONTEXT}}', contextStr);

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

  private runClaude(systemPrompt: string, userMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'text',
        '--system', systemPrompt,
        userMessage
      ];

      const proc = spawn('claude', args, {
        timeout: 30000,
        env: { ...process.env }
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

  private parseResponse(text: string): AgentAction {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          action: parsed.action || 'unknown',
          params: parsed.params
        };
      }
    } catch {
      // ignore parse errors
    }
    return { action: 'unknown' };
  }

  private fallbackProcess(message: string, context: TelegramContext): AgentAction {
    const lower = message.toLowerCase();

    // Project commands
    if (lower.includes('project') && (lower.includes('list') || lower.includes('show') || lower.includes('all'))) {
      return { action: 'list_projects' };
    }
    if (lower.includes('open') || lower.includes('switch')) {
      const match = message.match(/(?:open|switch)\s+(?:to\s+)?(.+?)(?:\s+project)?$/i);
      if (match) {
        return { action: 'open_project', params: { name: match[1].trim() } };
      }
    }

    // Session commands
    if (lower.includes('session') && (lower.includes('list') || lower.includes('show'))) {
      return { action: 'list_sessions' };
    }
    if (lower.includes('select') || lower.includes('choose')) {
      const match = message.match(/(?:select|choose)\s+(\S+)/i);
      if (match) {
        return { action: 'select_session', params: { id: match[1] } };
      }
    }
    if (lower.includes('new') || lower.includes('create')) {
      const match = message.match(/(?:new|create)\s+(?:session\s+)?(.+)/i);
      if (match) {
        return { action: 'new_session', params: { prompt: match[1].trim() } };
      }
    }

    // Status
    if (lower.includes('status') || lower.includes('state') || lower.includes('current')) {
      return { action: 'status' };
    }

    // Default: if there's an active session, send as message
    if (context.activeSessionId) {
      return { action: 'send_message', params: { message } };
    }

    return { action: 'unknown' };
  }

  isAvailable(): boolean {
    return this.claudePath !== null;
  }
}
