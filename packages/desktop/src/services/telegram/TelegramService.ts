import { Bot, Context, InlineKeyboard } from 'grammy';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { TelegramSettings, TelegramState } from './types';
import type { SessionManager } from '../../features/session/SessionManager';
import type { TaskQueue } from '../../features/queue/TaskQueue';
import type { WorktreeManager } from '../../features/worktree/WorktreeManager';
import type { ClaudeExecutor } from '../../executors/claude';
import type { CodexExecutor } from '../../executors/codex';
import type { GeminiExecutor } from '../../executors/gemini';
import type { KimiExecutor } from '../../executors/kimi';
import type { Logger } from '../../infrastructure/logging';
import type { ConfigManager } from '../../infrastructure/config/configManager';
import type { TimelineEvent } from '../../infrastructure/database/models';
import { initPanelManagerRegistry } from '../../features/panels/ai/panelManagerRegistry';
import {
  SnowTreeAPI,
  CommandInterpreter,
  ChannelContextStore,
  type SnowTreeCommandRequest,
  type SnowTreeCommandResponse,
  type ChannelAdapter,
  type ChannelState,
  type ChannelContext,
} from '../channels';

const CHANNEL_TYPE = 'telegram';

// Streaming config
const STREAM_CHUNK_SIZE = 200; // Send every N characters
const STREAM_DEBOUNCE_MS = 1500; // Or after N ms of no updates

interface StreamingState {
  content: string;
  sentLength: number;
  messageIds: number[];
  debounceTimer: NodeJS.Timeout | null;
}

interface TelegramServiceDeps {
  sessionManager: SessionManager;
  taskQueue: TaskQueue | null;
  worktreeManager: WorktreeManager;
  claudeExecutor: ClaudeExecutor;
  codexExecutor: CodexExecutor;
  geminiExecutor: GeminiExecutor;
  kimiExecutor: KimiExecutor;
  logger: Logger;
  configManager: ConfigManager;
}

/**
 * TelegramService - Telegram channel adapter for Snowtree
 *
 * Implements the ChannelAdapter interface using the channel-agnostic
 * SnowTreeAPI and CommandInterpreter.
 */
export class TelegramService extends EventEmitter implements ChannelAdapter {
  readonly channelType = CHANNEL_TYPE;

  private bot: Bot | null = null;
  private settings: TelegramSettings | null = null;
  private state: TelegramState = { status: 'disconnected' };
  private tempDir: string;

  // Channel-agnostic components
  private contextStore: ChannelContextStore;
  private interpreter: CommandInterpreter;
  private api: SnowTreeAPI;

  private lastAssistantBySession = new Map<string, string>();
  private streamingBySessionChat = new Map<string, StreamingState>();

  constructor(private deps: TelegramServiceDeps) {
    super();
    this.tempDir = path.join(process.env.HOME || '/tmp', '.snowtree', 'telegram-temp');
    this.ensureTempDir();

    // Initialize panel manager registry
    initPanelManagerRegistry({
      sessionManager: deps.sessionManager,
      claudeExecutor: deps.claudeExecutor,
      codexExecutor: deps.codexExecutor,
      geminiExecutor: deps.geminiExecutor,
      kimiExecutor: deps.kimiExecutor,
      logger: deps.logger,
      configManager: deps.configManager,
    });

    // Initialize channel-agnostic components
    this.contextStore = new ChannelContextStore();
    this.interpreter = new CommandInterpreter();
    this.api = new SnowTreeAPI({
      sessionManager: deps.sessionManager,
      taskQueue: deps.taskQueue,
      worktreeManager: deps.worktreeManager,
      logger: deps.logger,
    });

    // Listen for timeline events to push to Telegram
    this.deps.sessionManager.on('timeline:event', (data: { sessionId: string; event: TimelineEvent }) => {
      void this.handleTimelineEvent(data);
    });
  }

  private ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  // ===========================================================================
  // ChannelAdapter Implementation
  // ===========================================================================

  async start(config: TelegramSettings): Promise<void> {
    if (!config.enabled || !config.botToken) {
      this.deps.logger.info('Telegram bot not enabled or no token');
      return;
    }

    if (this.bot) {
      await this.stop();
    }

    this.settings = config;
    this.state = { status: 'connecting' };
    this.emit('state-changed', this.state);

    try {
      this.bot = new Bot(config.botToken);

      // Register explicit slash commands (must be before message:text fallback)
      this.registerCommands(this.bot);

      // Fallback: plain text messages go through CommandInterpreter
      this.bot.on('message:text', async (ctx) => {
        await this.handleTextMessage(ctx);
      });

      this.bot.on('message:photo', async (ctx) => {
        if (!this.isAuthorized(ctx.chat?.id)) return;
        await this.handlePhoto(ctx);
      });

      this.bot.on('message:document', async (ctx) => {
        if (!this.isAuthorized(ctx.chat?.id)) return;
        await this.handleDocument(ctx);
      });

      this.bot.catch((err) => {
        this.deps.logger.error('Telegram bot error:', err);
        this.state = { status: 'error', error: err.message };
        this.emit('state-changed', this.state);
      });

      // Register commands with Telegram's BotFather menu
      try {
        await this.bot.api.setMyCommands([
          { command: 'status', description: 'Show active project/session status' },
          { command: 'projects', description: 'List all projects' },
          { command: 'sessions', description: 'List sessions in active project' },
          { command: 'open', description: 'Open a project: /open <name>' },
          { command: 'select', description: 'Select a session: /select <id>' },
          { command: 'new', description: 'Create a session: /new <prompt>' },
          { command: 'stop', description: 'Stop the active session' },
          { command: 'delete', description: 'Delete a session: /delete <id>' },
          { command: 'use', description: 'Switch executor: /use <claude|codex|gemini|kimi>' },
          { command: 'help', description: 'Show available commands' },
          { command: 'chatid', description: 'Show your chat ID (for setup)' },
        ]);
      } catch (err) {
        this.deps.logger.warn('Failed to register Telegram command menu:', err as Error);
      }

      await this.bot.start({
        onStart: (botInfo) => {
          this.deps.logger.info(`Telegram bot connected: @${botInfo.username}`);
          this.state = { status: 'connected', botUsername: botInfo.username };
          this.emit('state-changed', this.state);
        }
      });
    } catch (error) {
      this.deps.logger.error('Failed to start Telegram bot:', error as Error);
      this.state = { status: 'error', error: String(error) };
      this.emit('state-changed', this.state);
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this.state = { status: 'disconnected' };
    this.emit('state-changed', this.state);
  }

  async sendMessage(chatId: string | number, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      const maxLength = 4000;
      if (text.length <= maxLength) {
        await this.bot.api.sendMessage(chatId, text);
      } else {
        const chunks = this.splitMessage(text, maxLength);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, chunk);
        }
      }
    } catch (error) {
      this.deps.logger.error('Failed to send Telegram message:', error as Error);
    }
  }

  getState(): ChannelState {
    return this.state;
  }

  isAuthorized(userId: string | number | undefined): boolean {
    if (!userId || !this.settings?.allowedChatId) {
      return false;
    }
    return userId.toString() === this.settings.allowedChatId;
  }

  // ===========================================================================
  // Telegram-specific Methods
  // ===========================================================================

  async restart(settings: TelegramSettings): Promise<void> {
    await this.stop();
    await this.start(settings);
  }

  getAllowedChatId(): string | null {
    return this.settings?.allowedChatId || null;
  }

  // ===========================================================================
  // Slash Command Registration
  // ===========================================================================

  private registerCommands(bot: Bot): void {
    // /chatid - available without authorization (for setup)
    bot.command('chatid', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await ctx.reply(`Your Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
    });

    // /start - welcome message
    bot.command('start', async (ctx) => {
      await this.handleCommand(ctx, { name: 'help' });
    });

    // /help
    bot.command('help', async (ctx) => {
      await this.handleCommand(ctx, { name: 'help' });
    });

    // /status - with action buttons
    bot.command('status', async (ctx) => {
      await this.handleStatusCommand(ctx);
    });

    // /projects and /workspaces - with inline keyboard
    bot.command(['projects', 'workspaces'], async (ctx) => {
      await this.handleProjectsCommand(ctx);
    });

    // /open <name>
    bot.command('open', async (ctx) => {
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('Usage: /open <project name>');
        return;
      }
      await this.handleCommand(ctx, { name: 'open_project', args: { name } });
    });

    // /sessions - with inline keyboard
    bot.command('sessions', async (ctx) => {
      await this.handleSessionsCommand(ctx);
    });

    // /select <id>
    bot.command('select', async (ctx) => {
      const id = ctx.match?.trim();
      if (!id) {
        await ctx.reply('Usage: /select <session id>');
        return;
      }
      await this.handleCommand(ctx, { name: 'select_session', args: { id } });
    });

    // /new <prompt>
    bot.command('new', async (ctx) => {
      const prompt = ctx.match?.trim();
      if (!prompt) {
        await ctx.reply('Usage: /new <prompt for the session>');
        return;
      }
      await this.handleCommand(ctx, { name: 'new_session', args: { prompt } });
    });

    // /stop
    bot.command('stop', async (ctx) => {
      await this.handleCommand(ctx, { name: 'stop_session' });
    });

    // /delete <id>
    bot.command('delete', async (ctx) => {
      const id = ctx.match?.trim();
      if (!id) {
        await ctx.reply('Usage: /delete <session id>');
        return;
      }
      await this.handleCommand(ctx, { name: 'delete_session', args: { id } });
    });

    // /use <executor> - with inline keyboard when no arg
    bot.command('use', async (ctx) => {
      const executor = ctx.match?.trim()?.toLowerCase();
      if (!executor) {
        await this.handleUseCommand(ctx);
        return;
      }
      await this.handleCommand(ctx, { name: 'switch_executor', args: { executor } });
    });

    // Handle inline keyboard button presses
    this.registerCallbackHandlers(bot);
  }

  private registerCallbackHandlers(bot: Bot): void {
    bot.on('callback_query:data', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId || !this.isAuthorized(chatId)) {
        await ctx.answerCallbackQuery('Unauthorized.');
        return;
      }

      const data = ctx.callbackQuery.data;
      const context = this.contextStore.get(CHANNEL_TYPE, chatId);

      try {
        if (data.startsWith('open:')) {
          const projectId = parseInt(data.slice(5), 10);
          const projects = this.deps.sessionManager.db.getAllProjects();
          const project = projects.find(p => p.id === projectId);
          if (!project) {
            await ctx.answerCallbackQuery('Project not found.');
            return;
          }
          const response = await this.api.execute(
            { name: 'open_project', args: { name: project.name } },
            context
          );
          this.contextStore.update(CHANNEL_TYPE, chatId, context);
          await ctx.editMessageText(response.message || 'Done.', {
            parse_mode: response.parseMode,
          });
          await ctx.answerCallbackQuery(`Opened: ${project.name}`);

        } else if (data.startsWith('select:')) {
          const sessionId = data.slice(7);
          const response = await this.api.execute(
            { name: 'select_session', args: { id: sessionId } },
            context
          );
          this.contextStore.update(CHANNEL_TYPE, chatId, context);
          await ctx.editMessageText(response.message || 'Done.', {
            parse_mode: response.parseMode,
          });
          await ctx.answerCallbackQuery('Session selected');

        } else if (data.startsWith('use:')) {
          const executor = data.slice(4);
          const response = await this.api.execute(
            { name: 'switch_executor', args: { executor } },
            context
          );
          this.contextStore.update(CHANNEL_TYPE, chatId, context);
          await ctx.editMessageText(response.message || 'Done.', {
            parse_mode: response.parseMode,
          });
          await ctx.answerCallbackQuery(`Switched to ${executor}`);

        } else if (data === 'cmd:sessions') {
          this.contextStore.update(CHANNEL_TYPE, chatId, context);
          await ctx.answerCallbackQuery();
          await this.handleSessionsCommandEdit(ctx, context);

        } else if (data === 'cmd:stop') {
          const response = await this.api.execute({ name: 'stop_session' }, context);
          this.contextStore.update(CHANNEL_TYPE, chatId, context);
          await ctx.editMessageText(response.message || 'Done.', {
            parse_mode: response.parseMode,
          });
          await ctx.answerCallbackQuery('Session stopped');

        } else if (data === 'cmd:projects') {
          await ctx.answerCallbackQuery();
          await this.handleProjectsCommandEdit(ctx, context);

        } else {
          await ctx.answerCallbackQuery('Unknown action.');
        }
      } catch (error) {
        this.deps.logger.error('Callback query failed:', error as Error);
        await ctx.answerCallbackQuery('Failed to handle that action.');
      }
    });
  }

  // ===========================================================================
  // Interactive Command Handlers
  // ===========================================================================

  private async handleProjectsCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId || !this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const context = this.contextStore.get(CHANNEL_TYPE, chatId);
    const projects = this.deps.sessionManager.db.getAllProjects();
    if (projects.length === 0) {
      await ctx.reply('No projects found.');
      return;
    }

    const keyboard = new InlineKeyboard();
    projects.forEach((project, index) => {
      const label = context.activeProjectId === project.id
        ? `→ ${project.name}`
        : project.name;
      keyboard.text(label, `open:${project.id}`);
      if ((index + 1) % 2 === 0) keyboard.row();
    });

    await ctx.reply('📁 *Projects*\n\nSelect a project:', {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleProjectsCommandEdit(ctx: Context, context: ChannelContext): Promise<void> {
    const projects = this.deps.sessionManager.db.getAllProjects();
    if (projects.length === 0) {
      await ctx.editMessageText('No projects found.');
      return;
    }

    const keyboard = new InlineKeyboard();
    projects.forEach((project, index) => {
      const label = context.activeProjectId === project.id
        ? `→ ${project.name}`
        : project.name;
      keyboard.text(label, `open:${project.id}`);
      if ((index + 1) % 2 === 0) keyboard.row();
    });

    await ctx.editMessageText('📁 *Projects*\n\nSelect a project:', {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleSessionsCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId || !this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const context = this.contextStore.get(CHANNEL_TYPE, chatId);
    if (!context.activeProjectId) {
      const activeProject = this.api.getActiveProject();
      if (activeProject) {
        this.contextStore.update(CHANNEL_TYPE, chatId, { activeProjectId: activeProject.id });
        context.activeProjectId = activeProject.id;
      }
    }

    if (!context.activeProjectId) {
      await ctx.reply('No project selected. Use /projects first.');
      return;
    }

    const sessions = this.deps.sessionManager.getSessionsForProject(context.activeProjectId);
    if (sessions.length === 0) {
      await ctx.reply('No sessions. Use /new <prompt> to create one.');
      return;
    }

    const { msg, keyboard } = this.buildSessionList(sessions, context);

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleSessionsCommandEdit(ctx: Context, context: ChannelContext): Promise<void> {
    if (!context.activeProjectId) {
      await ctx.editMessageText('No project selected. Use /projects first.');
      return;
    }

    const sessions = this.deps.sessionManager.getSessionsForProject(context.activeProjectId);
    if (sessions.length === 0) {
      await ctx.editMessageText('No sessions. Use /new <prompt> to create one.');
      return;
    }

    const { msg, keyboard } = this.buildSessionList(sessions, context);

    await ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleStatusCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId || !this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const context = this.contextStore.get(CHANNEL_TYPE, chatId);
    if (!context.activeProjectId) {
      const activeProject = this.api.getActiveProject();
      if (activeProject) {
        this.contextStore.update(CHANNEL_TYPE, chatId, { activeProjectId: activeProject.id });
        context.activeProjectId = activeProject.id;
      }
    }

    const project = context.activeProjectId
      ? this.deps.sessionManager.db.getProject(context.activeProjectId)
      : null;
    const session = context.activeSessionId
      ? this.deps.sessionManager.getSession(context.activeSessionId)
      : null;

    let msg = '📊 *Status*\n\n';
    msg += `Project: ${project ? project.name : '_none_'}\n`;
    msg += `Session: ${session ? session.name : '_none_'}\n`;
    if (session) {
      msg += `Status: ${session.status}\n`;
      msg += `Executor: ${session.toolType || 'none'}\n`;
    }

    const keyboard = new InlineKeyboard();
    keyboard.text('📁 Projects', 'cmd:projects').text('📋 Sessions', 'cmd:sessions');
    if (session && (session.status === 'running' || session.status === 'waiting')) {
      keyboard.row().text('⏹ Stop', 'cmd:stop');
    }

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleUseCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId || !this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('Claude', 'use:claude').text('Codex', 'use:codex').row()
      .text('Gemini', 'use:gemini').text('Kimi', 'use:kimi');

    await ctx.reply('Select an executor:', { reply_markup: keyboard });
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'running': return '🟢';
      case 'waiting': case 'ready': return '🟡';
      case 'completed': case 'completed_unviewed': return '✅';
      case 'stopped': return '⏹';
      case 'error': case 'failed': return '❌';
      default: return '⚪';
    }
  }

  private buildSessionList(sessions: { id: string; name: string; status: string; updatedAt?: Date; lastActivity?: Date }[], context: ChannelContext): { msg: string; keyboard: InlineKeyboard } {
    const displayed = sessions.slice(0, 10);
    let msg = '📋 *Sessions*\n\n';
    displayed.forEach((session, index) => {
      const shortId = session.id.slice(0, 6);
      const marker = session.id === context.activeSessionId ? '→ ' : '  ';
      const statusIcon = this.getStatusIcon(session.status);
      const time = session.updatedAt || session.lastActivity;
      const timeStr = time ? ` · ${this.formatRelativeTime(time)}` : '';
      msg += `${marker}${index + 1}. ${statusIcon} ${session.name} \`${shortId}\`${timeStr}\n`;
    });

    if (sessions.length > 10) {
      msg += `\n_(showing 10 of ${sessions.length})_`;
    }

    const keyboard = new InlineKeyboard();
    displayed.forEach((session) => {
      const shortId = session.id.slice(0, 6);
      const statusIcon = this.getStatusIcon(session.status);
      keyboard.text(`${statusIcon} ${session.name} [${shortId}]`, `select:${session.id}`).row();
    });

    return { msg, keyboard };
  }

  private formatRelativeTime(date: Date): string {
    const now = Date.now();
    const ts = date instanceof Date ? date.getTime() : new Date(date).getTime();
    const diffMs = now - ts;
    if (diffMs < 0) return 'just now';

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  private async handleCommand(ctx: Context, command: SnowTreeCommandRequest): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    const context = this.contextStore.get(CHANNEL_TYPE, chatId);
    if (!context.activeProjectId) {
      const activeProject = this.api.getActiveProject();
      if (activeProject) {
        this.contextStore.update(CHANNEL_TYPE, chatId, { activeProjectId: activeProject.id });
      }
    }

    command.rawText = ctx.message?.text || '';

    try {
      const response = await this.api.execute(command, context);
      this.contextStore.update(CHANNEL_TYPE, chatId, context);
      await this.respond(ctx, response, command);
    } catch (error) {
      this.deps.logger.error('Telegram command failed:', error as Error);
      await ctx.reply('Failed to handle that request.');
    }
  }

  // ===========================================================================
  // Message Handling (fallback for plain text)
  // ===========================================================================

  private async handleTextMessage(ctx: Context) {
    const text = ctx.message?.text || '';
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Check authorization
    if (!this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    // Get context for this chat
    const context = this.contextStore.get(CHANNEL_TYPE, chatId);

    // Initialize context with active project if not set
    if (!context.activeProjectId) {
      const activeProject = this.api.getActiveProject();
      if (activeProject) {
        this.contextStore.update(CHANNEL_TYPE, chatId, { activeProjectId: activeProject.id });
      }
    }

    // Interpret the message (still supports natural language patterns)
    const command = await this.interpreter.interpret(text, context);

    // Execute the command
    try {
      const response = await this.api.execute(command, context);
      this.contextStore.update(CHANNEL_TYPE, chatId, context);
      await this.respond(ctx, response, command);
    } catch (error) {
      this.deps.logger.error('Telegram command failed:', error as Error);
      await ctx.reply('Failed to handle that request.');
    }
  }

  private async respond(ctx: Context, response: SnowTreeCommandResponse, command: SnowTreeCommandRequest) {
    if (response.showTyping) {
      await ctx.replyWithChatAction('typing');
    }

    if (response.message) {
      await ctx.reply(response.message, response.parseMode ? { parse_mode: response.parseMode } : undefined);
      return;
    }

    if (command.name === 'send_message') {
      await ctx.replyWithChatAction('typing');
    }
  }

  private async handlePhoto(ctx: Context) {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    if (!file.file_path) {
      await ctx.reply('Failed to get photo.');
      return;
    }

    const localPath = await this.downloadFile(file.file_path, `photo_${Date.now()}.jpg`);
    const caption = ctx.message?.caption || 'Analyze this image';
    await this.handleAttachmentMessage(ctx, caption, [localPath]);
  }

  private async handleDocument(ctx: Context) {
    const doc = ctx.message?.document;
    if (!doc) return;
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      await ctx.reply('Failed to get document.');
      return;
    }

    const localPath = await this.downloadFile(file.file_path, doc.file_name || `doc_${Date.now()}`);
    const caption = ctx.message?.caption || `File: ${doc.file_name}`;
    await this.handleAttachmentMessage(ctx, caption, [localPath]);
  }

  private async handleAttachmentMessage(ctx: Context, caption: string, attachments: string[]) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const context = this.contextStore.get(CHANNEL_TYPE, chatId);
    const command: SnowTreeCommandRequest = {
      name: 'send_message',
      args: { message: caption },
      rawText: caption,
      attachments
    };

    try {
      const response = await this.api.execute(command, context);
      this.contextStore.update(CHANNEL_TYPE, chatId, context);
      await this.respond(ctx, response, command);
    } catch (error) {
      this.deps.logger.error('Telegram attachment handling failed:', error as Error);
      await ctx.reply('Failed to handle that attachment.');
    }
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  private async handleTimelineEvent(data: { sessionId: string; event: TimelineEvent }) {
    if (!this.bot) return;
    const { sessionId, event } = data;

    // Find all chats watching this session
    const keys = this.contextStore.getKeysForSession(sessionId);
    if (keys.length === 0) return;

    // Format the event based on its kind
    const formatted = this.formatTimelineEvent(event);
    if (!formatted) return;

    for (const key of keys) {
      const parsed = this.contextStore.parseKey(key);
      if (parsed && parsed.channelType === CHANNEL_TYPE) {
        const chatId = parsed.chatId;

        if (event.kind === 'chat.assistant') {
          // Handle streaming for assistant messages
          const streamKey = `${sessionId}:${chatId}`;
          if (event.is_streaming) {
            await this.handleStreamingUpdate(streamKey, chatId, formatted);
          } else {
            await this.finalizeStreaming(streamKey, chatId, formatted);
          }
        } else {
          // Send other events immediately
          await this.sendMessage(chatId, formatted);
        }
      }
    }
  }

  private formatTimelineEvent(event: TimelineEvent): string | null {
    switch (event.kind) {
      case 'chat.assistant': {
        const content = (event.command || event.content || '').trim();
        return content || null;
      }

      case 'tool_use': {
        if (event.status === 'started') {
          const toolName = event.tool_name || 'unknown';
          let input = '';
          if (event.tool_input) {
            try {
              const parsed = JSON.parse(event.tool_input);
              // Format tool input concisely
              if (toolName === 'Read' && parsed.file_path) {
                input = `\n📄 ${parsed.file_path}`;
              } else if (toolName === 'Edit' && parsed.file_path) {
                input = `\n📝 ${parsed.file_path}`;
              } else if (toolName === 'Write' && parsed.file_path) {
                input = `\n📝 ${parsed.file_path}`;
              } else if (toolName === 'Bash' && parsed.command) {
                input = `\n\`${parsed.command}\``;
              } else if (toolName === 'Glob' && parsed.pattern) {
                input = `\n🔍 ${parsed.pattern}`;
              } else if (toolName === 'Grep' && parsed.pattern) {
                input = `\n🔍 ${parsed.pattern}`;
              } else {
                // Show first few keys for other tools
                const keys = Object.keys(parsed).slice(0, 2);
                if (keys.length > 0) {
                  input = '\n' + keys.map(k => `${k}: ${String(parsed[k]).slice(0, 50)}`).join(', ');
                }
              }
            } catch {
              // Not JSON, show raw (truncated)
              if (event.tool_input.length > 100) {
                input = `\n${event.tool_input.slice(0, 100)}...`;
              } else {
                input = `\n${event.tool_input}`;
              }
            }
          }
          return `🔧 *${toolName}*${input}`;
        }
        return null;
      }

      case 'tool_result': {
        // Only show errors or important results
        if (event.is_error) {
          const result = event.tool_result || 'Error';
          const truncated = result.length > 200 ? result.slice(0, 200) + '...' : result;
          return `❌ Tool error:\n${truncated}`;
        }
        return null;
      }

      case 'cli.command':
      case 'git.command': {
        if (event.status === 'started') {
          const cmd = event.command || '';
          const icon = event.kind === 'git.command' ? '🔀' : '💻';
          return `${icon} \`${cmd}\``;
        } else if (event.status === 'finished' && event.exit_code !== 0) {
          return `⚠️ Command exited with code ${event.exit_code}`;
        }
        return null;
      }

      case 'thinking': {
        // Skip thinking events - too verbose
        return null;
      }

      case 'user_question': {
        if (event.status === 'pending' && event.questions) {
          try {
            const questions = JSON.parse(event.questions);
            if (Array.isArray(questions) && questions.length > 0) {
              const q = questions[0];
              return `❓ *Question:* ${q.question || q.text || 'Agent needs input'}`;
            }
          } catch {
            return '❓ Agent is asking a question';
          }
        }
        return null;
      }

      default:
        return null;
    }
  }

  private async handleStreamingUpdate(streamKey: string, chatId: string | number, content: string) {
    let state = this.streamingBySessionChat.get(streamKey);

    if (!state) {
      state = {
        content: '',
        sentLength: 0,
        messageIds: [],
        debounceTimer: null,
      };
      this.streamingBySessionChat.set(streamKey, state);
    }

    // Clear existing debounce timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }

    state.content = content;

    // Check if we have enough new content to send
    const newContent = content.slice(state.sentLength);
    if (newContent.length >= STREAM_CHUNK_SIZE) {
      await this.sendStreamChunk(streamKey, chatId, state);
    } else {
      // Set debounce timer to send after delay
      state.debounceTimer = setTimeout(() => {
        void this.sendStreamChunk(streamKey, chatId, state!);
      }, STREAM_DEBOUNCE_MS);
    }
  }

  private async sendStreamChunk(streamKey: string, chatId: string | number, state: StreamingState) {
    if (!this.bot) return;

    const newContent = state.content.slice(state.sentLength);
    if (!newContent.trim()) return;

    try {
      // Find a good break point (newline or space)
      let sendLength = newContent.length;
      if (sendLength > STREAM_CHUNK_SIZE) {
        const lastNewline = newContent.lastIndexOf('\n', STREAM_CHUNK_SIZE);
        const lastSpace = newContent.lastIndexOf(' ', STREAM_CHUNK_SIZE);
        sendLength = Math.max(lastNewline, lastSpace, STREAM_CHUNK_SIZE);
      }

      const chunk = newContent.slice(0, sendLength).trim();
      if (chunk) {
        const msg = await this.bot.api.sendMessage(chatId, chunk);
        state.messageIds.push(msg.message_id);
        state.sentLength += sendLength;
      }
    } catch (error) {
      this.deps.logger.error('Failed to send stream chunk:', error as Error);
    }
  }

  private async finalizeStreaming(streamKey: string, chatId: string | number, finalContent: string) {
    const state = this.streamingBySessionChat.get(streamKey);

    // Clear debounce timer
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Send any remaining content
    if (state) {
      const remaining = finalContent.slice(state.sentLength).trim();
      if (remaining) {
        await this.sendMessage(chatId, remaining);
      }
      this.streamingBySessionChat.delete(streamKey);
    } else {
      // No streaming state - check deduplication and send full content
      const last = this.lastAssistantBySession.get(streamKey.split(':')[0]);
      if (last !== finalContent) {
        this.lastAssistantBySession.set(streamKey.split(':')[0], finalContent);
        await this.sendMessage(chatId, finalContent);
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async downloadFile(filePath: string, fileName: string): Promise<string> {
    const url = `https://api.telegram.org/file/bot${this.settings?.botToken}/${filePath}`;
    const localPath = path.join(this.tempDir, fileName);
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(localPath);
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(localPath); });
      }).on('error', (err) => { fs.unlink(localPath, () => {}); reject(err); });
    });
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) { chunks.push(remaining); break; }
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) splitIndex = maxLength;
      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }
    return chunks;
  }
}
