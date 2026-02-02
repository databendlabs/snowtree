import { Bot, Context } from 'grammy';
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
} from '../channels';

const CHANNEL_TYPE = 'telegram';

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
  // Message Handling
  // ===========================================================================

  private async handleTextMessage(ctx: Context) {
    const text = ctx.message?.text || '';
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Get context for this chat
    const context = this.contextStore.get(CHANNEL_TYPE, chatId);

    // Initialize context with active project if not set
    if (!context.activeProjectId) {
      const activeProject = this.api.getActiveProject();
      if (activeProject) {
        this.contextStore.update(CHANNEL_TYPE, chatId, { activeProjectId: activeProject.id });
      }
    }

    // Handle /chatid command without authorization (for setup)
    const isChatIdRequest = text.toLowerCase().includes('chatid') || text.toLowerCase().includes('chat id');
    if (isChatIdRequest && !this.isAuthorized(chatId)) {
      await ctx.reply(`Your Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
      return;
    }

    // Check authorization for other commands
    if (!this.isAuthorized(chatId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    // Interpret the message
    const command = await this.interpreter.interpret(text, context);

    // Execute the command
    try {
      const response = await this.api.execute(command, context);

      // Persist context changes
      this.contextStore.update(CHANNEL_TYPE, chatId, context);

      // Send response
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
    if (event.kind !== 'chat.assistant') return;

    // Only send when streaming is complete (is_streaming === 0 or undefined)
    if (event.is_streaming) return;

    const content = (event.command || event.content || '').trim();
    if (!content) return;

    // Deduplicate - check if we already sent this exact content
    const last = this.lastAssistantBySession.get(sessionId);
    if (last === content) return;
    this.lastAssistantBySession.set(sessionId, content);

    // Find all chats watching this session
    const keys = this.contextStore.getKeysForSession(sessionId);
    for (const key of keys) {
      const parsed = this.contextStore.parseKey(key);
      if (parsed && parsed.channelType === CHANNEL_TYPE) {
        await this.sendMessage(parsed.chatId, content);
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
