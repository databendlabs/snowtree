import type { TelegramCommandDefinition } from './types';

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  {
    name: 'get_chat_id',
    description: 'Return the current chat ID for authorization setup.'
  },
  {
    name: 'list_projects',
    description: 'List all available projects.'
  },
  {
    name: 'open_project',
    description: 'Select a project by name.',
    args: '{ name: string }'
  },
  {
    name: 'list_sessions',
    description: 'List sessions in the active project.'
  },
  {
    name: 'select_session',
    description: 'Select a session by ID prefix.',
    args: '{ id: string }'
  },
  {
    name: 'new_session',
    description: 'Create a new session with a prompt.',
    args: '{ prompt: string }'
  },
  {
    name: 'status',
    description: 'Show active project/session status.'
  },
  {
    name: 'send_message',
    description: 'Send a message to the active session.',
    args: '{ message: string }'
  },
  {
    name: 'help',
    description: 'Show usage hints.'
  },
  {
    name: 'unknown',
    description: 'Fallback when no command matches.'
  }
];
