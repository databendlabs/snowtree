import type { TelegramCommandRequest, TelegramContext, TelegramCommandName } from './types';
import type { TelegramAgentDecision } from './TelegramAgent';
import { TelegramAgent } from './TelegramAgent';

export class TelegramCommandRouter {
  constructor(private agent: TelegramAgent) {}

  async routeText(text: string, context: TelegramContext): Promise<TelegramCommandRequest> {
    const rawText = text.trim();
    const normalized = this.normalizeText(rawText);
    const agentInput = normalized || rawText;

    let decision: TelegramAgentDecision;
    try {
      decision = await this.agent.processMessage(agentInput, context);
    } catch {
      decision = { command: 'unknown' };
    }

    const command = decision.command as TelegramCommandName;
    const args = decision.args || {};

    if (command === 'unknown') {
      return {
        name: 'send_message',
        args: { message: agentInput },
        rawText: rawText
      };
    }

    if (command === 'send_message') {
      const message = args.message || agentInput;
      return {
        name: 'send_message',
        args: { message },
        rawText
      };
    }

    if (command === 'help') {
      const lower = agentInput.toLowerCase();
      if (!lower.includes('help') && !lower.includes('command') && !lower.includes('usage') && !lower.includes('帮助') && !lower.includes('指令')) {
        return {
          name: 'send_message',
          args: { message: agentInput },
          rawText
        };
      }
    }

    return {
      name: command,
      args,
      rawText
    };
  }

  private normalizeText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      return trimmed.slice(1).trim();
    }
    return trimmed;
  }
}
