/**
 * KimiMessageParser - Parse Kimi CLI stream-json output into normalized entries
 */

import { v4 as uuidv4 } from 'uuid';
import type { NormalizedEntry, ActionType } from '../types';

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown> | null;
  };
  name?: string;
  arguments?: string | Record<string, unknown> | null;
};

type KimiMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
};

export class KimiMessageParser {
  parseMessage(message: KimiMessage): NormalizedEntry[] {
    const entries: NormalizedEntry[] = [];
    const timestamp = new Date().toISOString();
    const role = typeof message.role === 'string' ? message.role : 'assistant';

    if (role === 'user') {
      const content = this.extractText(message.content);
      if (content.trim()) {
        entries.push({
          id: uuidv4(),
          timestamp,
          entryType: 'user_message',
          content,
        });
      }
      return entries;
    }

    if (role === 'tool') {
      const content = this.extractText(message.content);
      const isError = this.isToolErrorContent(content);
      entries.push({
        id: uuidv4(),
        timestamp,
        entryType: 'tool_result',
        content,
        toolUseId: message.tool_call_id || undefined,
        toolStatus: isError ? 'failed' : 'success',
        metadata: {
          is_error: isError,
        },
      });
      return entries;
    }

    if (role === 'system') {
      const content = this.extractText(message.content);
      if (content.trim()) {
        entries.push({
          id: uuidv4(),
          timestamp,
          entryType: 'system_message',
          content,
        });
      }
      return entries;
    }

    // Default: assistant message with optional tool calls
    const assistantText = this.extractText(message.content);
    if (assistantText.trim()) {
      entries.push({
        id: uuidv4(),
        timestamp,
        entryType: 'assistant_message',
        content: assistantText,
        metadata: { streaming: false },
      });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const toolName =
        (call.function && typeof call.function.name === 'string')
          ? call.function.name
          : typeof call.name === 'string'
            ? call.name
            : 'unknown';

      const rawArgs = call.function?.arguments ?? call.arguments ?? null;
      const input = this.parseToolArguments(rawArgs);
      const display = this.formatToolInput(toolName, input);
      const actionType = this.inferActionType(toolName, input);

      entries.push({
        id: uuidv4(),
        timestamp,
        entryType: 'tool_use',
        content: display,
        toolName,
        toolUseId: call.id || undefined,
        toolStatus: 'pending',
        actionType,
        metadata: {
          input,
        },
      });
    }

    return entries;
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';

    if (Array.isArray(content)) {
      const parts = content.map((part) => this.extractPartText(part));
      return parts.filter(Boolean).join('');
    }

    if (typeof content === 'object') {
      const maybeText = (content as { text?: unknown }).text;
      if (typeof maybeText === 'string') return maybeText;
    }

    return '';
  }

  private extractPartText(part: unknown): string {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';

    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';

    if (type === 'text' && typeof record.text === 'string') {
      return record.text;
    }

    if (type === 'thinking' && typeof record.thinking === 'string') {
      return record.thinking;
    }

    if (type === 'think' && typeof record.think === 'string') {
      return record.think;
    }

    if (type === 'image_url') return '[image]';
    if (type === 'audio_url') return '[audio]';
    if (type === 'video_url') return '[video]';

    if (typeof record.text === 'string') return record.text;
    return '';
  }

  private parseToolArguments(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'object') return args as Record<string, unknown>;
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        return typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { raw: args };
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  private formatToolInput(toolName: string, input: Record<string, unknown>): string {
    const name = toolName.toLowerCase();

    if (name.includes('shell') || name.includes('command')) {
      const command = typeof input.command === 'string'
        ? input.command
        : typeof input.cmd === 'string'
          ? input.cmd
          : '';
      return command || JSON.stringify(input);
    }

    if (name.includes('read') || name.includes('list') || name.includes('glob') || name.includes('grep')) {
      const path = input.file_path || input.path || input.pattern || input.directory;
      return `${toolName}: ${path ?? ''}`.trim();
    }

    if (name.includes('write') || name.includes('edit') || name.includes('replace')) {
      const path = input.file_path || input.path || input.file;
      return `${toolName}: ${path ?? ''}`.trim();
    }

    if (name.includes('fetch') && typeof input.url === 'string') {
      return `Fetching: ${input.url}`;
    }

    if (name.includes('search') && typeof input.query === 'string') {
      return `Searching: ${input.query}`;
    }

    const keys = Object.keys(input).slice(0, 3);
    const summary = keys.map((key) => {
      const value = input[key];
      if (typeof value === 'object' && value !== null) {
        const jsonStr = JSON.stringify(value);
        return `${key}=${jsonStr.substring(0, 50)}${jsonStr.length > 50 ? '...' : ''}`;
      }
      return `${key}=${String(value).substring(0, 50)}`;
    }).join(', ');

    return `${toolName}: ${summary}`;
  }

  private inferActionType(toolName: string, input: Record<string, unknown>): ActionType {
    const name = toolName.toLowerCase();

    if (name.includes('read') || name.includes('list') || name.includes('glob') || name.includes('grep')) {
      return {
        type: 'file_read',
        path: String(input.file_path || input.path || input.pattern || input.directory || ''),
      };
    }

    if (name.includes('write')) {
      return {
        type: 'file_write',
        path: String(input.file_path || input.path || input.file || ''),
      };
    }

    if (name.includes('edit') || name.includes('replace')) {
      return {
        type: 'file_edit',
        path: String(input.file_path || input.path || input.file || ''),
      };
    }

    if (name.includes('shell') || name.includes('command')) {
      return {
        type: 'command_run',
        command: String(input.command || input.cmd || ''),
      };
    }

    if ((name.includes('fetch') || name.includes('web')) && typeof input.url === 'string') {
      return {
        type: 'web_fetch',
        url: String(input.url || ''),
      };
    }

    if ((name.includes('search') || name.includes('web')) && typeof input.query === 'string') {
      return {
        type: 'search',
        query: String(input.query || ''),
      };
    }

    if (name.includes('todo')) {
      return {
        type: 'todo_management',
        operation: toolName,
      };
    }

    if (name.includes('task')) {
      return {
        type: 'task_create',
        description: String(input.description || input.task || toolName),
      };
    }

    return {
      type: 'other',
      description: toolName,
    };
  }

  private isToolErrorContent(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (/^<system>\s*error:/i.test(trimmed)) return true;
    if (/^error:/i.test(trimmed)) return true;
    if (/\berror\b/i.test(trimmed) && trimmed.includes('<system>')) return true;
    return false;
  }
}

export default KimiMessageParser;
