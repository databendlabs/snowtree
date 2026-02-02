import type { SnowTreeCommandName, SnowTreeCommandRequest, ChannelContext } from './types';

export interface CommandInterpreterDecision {
  command: SnowTreeCommandName;
  args?: Record<string, string>;
}

/**
 * CommandInterpreter - Interprets user input into SnowTree commands
 *
 * Uses pattern matching for Snowtree control commands.
 * Unknown input is passed to the session executor as send_message.
 */
export class CommandInterpreter {
  async interpret(message: string, context: ChannelContext): Promise<SnowTreeCommandRequest> {
    const normalized = message.trim().replace(/^\//, '');
    const decision = this.parseCommand(normalized, context);

    return {
      name: decision.command,
      args: decision.args,
      rawText: message
    };
  }

  private parseCommand(message: string, context: ChannelContext): CommandInterpreterDecision {
    const lower = message.toLowerCase();

    // Chat ID (for setup)
    if (lower.includes('chat id') || lower.includes('chatid')) {
      return { command: 'get_chat_id' };
    }

    // Project commands
    if (lower.includes('project') && (lower.includes('list') || lower.includes('show') || lower.includes('all'))) {
      return { command: 'list_projects' };
    }
    if (lower.startsWith('open ') || lower.startsWith('switch to ')) {
      const match = message.match(/(?:open|switch to)\s+(.+?)(?:\s+project)?$/i);
      if (match) {
        return { command: 'open_project', args: { name: match[1].trim() } };
      }
    }

    // Session commands
    if (lower.includes('session') && (lower.includes('list') || lower.includes('show'))) {
      return { command: 'list_sessions' };
    }
    if (lower.startsWith('select ') || lower.startsWith('choose ')) {
      const match = message.match(/(?:select|choose)\s+(\S+)/i);
      if (match) {
        return { command: 'select_session', args: { id: match[1] } };
      }
    }
    if (lower.startsWith('new ') || lower.startsWith('create ')) {
      const match = message.match(/(?:new|create)\s+(?:session\s+)?(.+)/i);
      if (match) {
        return { command: 'new_session', args: { prompt: match[1].trim() } };
      }
    }

    // Status
    if (lower === 'status' || lower === 'state') {
      return { command: 'status' };
    }

    // Switch executor
    if (lower.includes('use ')) {
      const executors = ['claude', 'codex', 'gemini', 'kimi'];
      for (const exec of executors) {
        if (lower.includes(exec)) {
          return { command: 'switch_executor', args: { executor: exec } };
        }
      }
    }

    // Stop session
    if (lower === 'stop' || lower === 'stop session' || lower === 'stop agent') {
      return { command: 'stop_session' };
    }

    // Delete session
    if (lower.startsWith('delete ') || lower.startsWith('remove ')) {
      const match = message.match(/(?:delete|remove)\s+(?:session\s+)?(\S+)/i);
      if (match) {
        return { command: 'delete_session', args: { id: match[1] } };
      }
    }

    // Help
    if (lower === 'help' || lower === '?') {
      return { command: 'help' };
    }

    // Default: send to session executor
    return { command: 'send_message', args: { message } };
  }
}
