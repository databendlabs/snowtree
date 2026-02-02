import { Bot, Context } from 'grammy';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { TelegramSettings, TelegramState, TelegramContext, CommandHandler } from './types';
import type { SessionManager } from '../../features/session/SessionManager';
import type { ClaudeExecutor } from '../../executors/claude';
import type { Logger } from '../../infrastructure/logging';
import { TelegramAgent } from './TelegramAgent';

export class TelegramService extends EventEmitter {
  private bot: Bot | null = null;
  private settings: TelegramSettings | null = null;
  private state: TelegramState = { status: 'disconnected' };
  private context: TelegramContext = { activeProjectId: null, activeSessionId: null };
  private commands: Map<string, CommandHandler> = new Map();
  private tempDir: string;
  private agent: TelegramAgent;

  constructor(
    private sessionManager: SessionManager,
    private claudeExecutor: ClaudeExecutor,
    private logger: Logger,
    private getMainWindow: () => Electron.BrowserWindow | null
  ) {
    super();
    this.tempDir = path.join(process.env.HOME || '/tmp', '.snowtree', 'telegram-temp');
    this.ensureTempDir();
    this.registerBuiltinCommands();
    this.agent = new TelegramAgent(sessionManager, logger);
  }

  private ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private registerBuiltinCommands() {
    this.registerCommand({
      name: 'chatid',
      description: 'Get your chat ID',
      handler: async (ctx) => {
        const chatId = ctx.chat?.id;
        await ctx.reply(`Your Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
      }
    });

    this.registerCommand({
      name: 'status',
      description: 'Show current status',
      handler: async (ctx) => {
        const project = this.context.activeProjectId
          ? this.sessionManager.db.getProject(this.context.activeProjectId)
          : null;
        const session = this.context.activeSessionId
          ? this.sessionManager.getSession(this.context.activeSessionId)
          : null;

        let status = '📊 *Status*\n\n';
        status += `Project: ${project ? project.name : '_none_'}\n`;
        status += `Session: ${session ? session.name : '_none_'}\n`;
        if (session) {
          status += `Status: ${session.status}\n`;
        }
        await ctx.reply(status, { parse_mode: 'Markdown' });
      }
    });

    this.registerCommand({
      name: 'projects',
      description: 'List all projects',
      handler: async (ctx) => {
        const projects = this.sessionManager.db.getAllProjects();
        if (projects.length === 0) {
          await ctx.reply('No projects found.');
          return;
        }
        let msg = '📁 *Projects*\n\n';
        projects.forEach((p, i) => {
          const marker = p.id === this.context.activeProjectId ? '→ ' : '  ';
          msg += `${marker}${i + 1}. ${p.name}\n`;
        });
        msg += '\nUse `/open <name>` to select';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
    });

    this.registerCommand({
      name: 'open',
      description: 'Open a project',
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply('Usage: `/open <name>`', { parse_mode: 'Markdown' });
          return;
        }
        const projects = this.sessionManager.db.getAllProjects();
        const project = projects.find(p =>
          p.name.toLowerCase() === args.toLowerCase() ||
          p.name.toLowerCase().includes(args.toLowerCase())
        );
        if (!project) {
          await ctx.reply(`Project "${args}" not found.`);
          return;
        }
        this.context.activeProjectId = project.id;
        this.context.activeSessionId = null;
        this.syncToUI('project:select', { projectId: project.id });
        await ctx.reply(`✅ Opened: *${project.name}*`, { parse_mode: 'Markdown' });
      }
    });

    this.registerCommand({
      name: 'sessions',
      description: 'List sessions',
      handler: async (ctx) => {
        if (!this.context.activeProjectId) {
          await ctx.reply('No project selected. Use `/open <name>` first.', { parse_mode: 'Markdown' });
          return;
        }
        const sessions = this.sessionManager.getSessionsForProject(this.context.activeProjectId);
        if (sessions.length === 0) {
          await ctx.reply('No sessions. Use `/new <prompt>` to create.', { parse_mode: 'Markdown' });
          return;
        }
        let msg = '📋 *Sessions*\n\n';
        sessions.slice(0, 10).forEach((s, i) => {
          const marker = s.id === this.context.activeSessionId ? '→ ' : '  ';
          const shortId = s.id.slice(0, 6);
          msg += `${marker}${i + 1}. [${shortId}] ${s.name} (${s.status})\n`;
        });
        if (sessions.length > 10) msg += `\n... and ${sessions.length - 10} more`;
        msg += '\n\nUse `/s <id>` to select';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
    });

    this.registerCommand({
      name: 's',
      description: 'Select session',
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply('Usage: `/s <id> [message]`', { parse_mode: 'Markdown' });
          return;
        }
        const parts = args.split(' ');
        const sessionIdPrefix = parts[0];
        const message = parts.slice(1).join(' ');
        const sessions = this.context.activeProjectId
          ? this.sessionManager.getSessionsForProject(this.context.activeProjectId)
          : [];
        const session = sessions.find(s => s.id.startsWith(sessionIdPrefix));
        if (!session) {
          await ctx.reply(`Session "${sessionIdPrefix}" not found.`);
          return;
        }
        this.context.activeSessionId = session.id;
        this.syncToUI('session:select', { sessionId: session.id });
        if (message) {
          await this.sendMessageToSession(ctx, message);
        } else {
          await ctx.reply(`✅ Selected: *${session.name}*`, { parse_mode: 'Markdown' });
        }
      }
    });

    this.registerCommand({
      name: 'new',
      description: 'Create new session',
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply('Usage: `/new <prompt>`', { parse_mode: 'Markdown' });
          return;
        }
        if (!this.context.activeProjectId) {
          await ctx.reply('No project selected. Use `/open <name>` first.', { parse_mode: 'Markdown' });
          return;
        }
        await ctx.reply('🚀 Creating new session...');
        this.syncToUI('telegram:create-session', {
          projectId: this.context.activeProjectId,
          prompt: args,
          chatId: ctx.chat?.id
        });
      }
    });
  }

  registerCommand(cmd: CommandHandler) {
    this.commands.set(cmd.name, cmd);
  }

  private isAuthorized(ctx: Context): boolean {
    if (!this.settings?.allowedChatId) return false;
    return ctx.chat?.id?.toString() === this.settings.allowedChatId;
  }

  private syncToUI(event: string, data: unknown) {
    const mainWindow = this.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(event, data);
    }
    this.emit(event, data);
  }

  async start(settings: TelegramSettings): Promise<void> {
    if (!settings.enabled || !settings.botToken) {
      this.logger.info('Telegram bot not enabled or no token');
      return;
    }
    // Stop existing bot if running
    if (this.bot) {
      await this.stop();
    }
    this.settings = settings;
    this.state = { status: 'connecting' };
    this.emit('state-changed', this.state);

    try {
      this.bot = new Bot(settings.botToken);

      for (const [name, cmd] of this.commands) {
        this.bot.command(name, async (ctx) => {
          // /chatid command doesn't require authorization (so user can get their chat ID)
          if (name !== 'chatid' && !this.isAuthorized(ctx)) {
            await ctx.reply('Unauthorized.');
            return;
          }
          const text = ctx.message?.text || '';
          const args = text.split(' ').slice(1).join(' ');
          await cmd.handler(ctx, args);
        });
      }

      this.bot.on('message:text', async (ctx) => {
        if (!this.isAuthorized(ctx)) return;
        if (ctx.message.text.startsWith('/')) return;
        await this.handleAgentMessage(ctx, ctx.message.text);
      });

      this.bot.on('message:photo', async (ctx) => {
        if (!this.isAuthorized(ctx)) return;
        await this.handlePhoto(ctx);
      });

      this.bot.on('message:document', async (ctx) => {
        if (!this.isAuthorized(ctx)) return;
        await this.handleDocument(ctx);
      });

      this.bot.catch((err) => {
        this.logger.error('Telegram bot error:', err);
        this.state = { status: 'error', error: err.message };
        this.emit('state-changed', this.state);
      });

      await this.bot.start({
        onStart: (botInfo) => {
          this.logger.info(`Telegram bot connected: @${botInfo.username}`);
          this.state = { status: 'connected', botUsername: botInfo.username };
          this.emit('state-changed', this.state);
        }
      });
    } catch (error) {
      this.logger.error('Failed to start Telegram bot:', error as Error);
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

  async restart(settings: TelegramSettings): Promise<void> {
    await this.stop();
    await this.start(settings);
  }

  getState(): TelegramState { return this.state; }
  getContext(): TelegramContext { return this.context; }
  setContext(ctx: Partial<TelegramContext>) { this.context = { ...this.context, ...ctx }; }

  private async sendMessageToSession(ctx: Context, message: string, attachments?: string[]) {
    if (!this.context.activeSessionId) {
      await ctx.reply('No session selected. Use `/s <id>` first.', { parse_mode: 'Markdown' });
      return;
    }
    this.syncToUI('telegram:send-message', {
      sessionId: this.context.activeSessionId,
      message,
      attachments,
      chatId: ctx.chat?.id
    });
    await ctx.replyWithChatAction('typing');
  }

  private async handleAgentMessage(ctx: Context, message: string) {
    const action = await this.agent.processMessage(message, this.context);
    this.logger.info(`Agent action: ${action.action} ${JSON.stringify(action.params || {})}`);

    switch (action.action) {
      case 'list_projects': {
        const projects = this.sessionManager.db.getAllProjects();
        if (projects.length === 0) {
          await ctx.reply('No projects found.');
          return;
        }
        let msg = '📁 *Projects*\n\n';
        projects.forEach((p, i) => {
          const marker = p.id === this.context.activeProjectId ? '→ ' : '  ';
          msg += `${marker}${i + 1}. ${p.name}\n`;
        });
        msg += '\nSay "open <name>" to select';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        break;
      }

      case 'open_project': {
        const name = action.params?.name;
        if (!name) {
          await ctx.reply('Please specify a project name.');
          return;
        }
        const projects = this.sessionManager.db.getAllProjects();
        const project = projects.find(p =>
          p.name.toLowerCase() === name.toLowerCase() ||
          p.name.toLowerCase().includes(name.toLowerCase())
        );
        if (!project) {
          await ctx.reply(`Project "${name}" not found.`);
          return;
        }
        this.context.activeProjectId = project.id;
        this.context.activeSessionId = null;
        this.syncToUI('project:select', { projectId: project.id });
        await ctx.reply(`✅ Opened: *${project.name}*`, { parse_mode: 'Markdown' });
        break;
      }

      case 'list_sessions': {
        if (!this.context.activeProjectId) {
          await ctx.reply('No project selected. Say "open <name>" first.');
          return;
        }
        const sessions = this.sessionManager.getSessionsForProject(this.context.activeProjectId);
        if (sessions.length === 0) {
          await ctx.reply('No sessions. Say "new <prompt>" to create.');
          return;
        }
        let msg = '📋 *Sessions*\n\n';
        sessions.slice(0, 10).forEach((s, i) => {
          const marker = s.id === this.context.activeSessionId ? '→ ' : '  ';
          const shortId = s.id.slice(0, 6);
          msg += `${marker}${i + 1}. [${shortId}] ${s.name} (${s.status})\n`;
        });
        if (sessions.length > 10) msg += `\n... and ${sessions.length - 10} more`;
        msg += '\n\nSay "select <id>" to select';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        break;
      }

      case 'select_session': {
        const id = action.params?.id;
        if (!id) {
          await ctx.reply('Please specify a session ID.');
          return;
        }
        const sessions = this.context.activeProjectId
          ? this.sessionManager.getSessionsForProject(this.context.activeProjectId)
          : [];
        const session = sessions.find(s => s.id.startsWith(id));
        if (!session) {
          await ctx.reply(`Session "${id}" not found.`);
          return;
        }
        this.context.activeSessionId = session.id;
        this.syncToUI('session:select', { sessionId: session.id });
        await ctx.reply(`✅ Selected: *${session.name}*`, { parse_mode: 'Markdown' });
        break;
      }

      case 'new_session': {
        const prompt = action.params?.prompt;
        if (!prompt) {
          await ctx.reply('Please provide a prompt for the new session.');
          return;
        }
        if (!this.context.activeProjectId) {
          await ctx.reply('No project selected. Say "open <name>" first.');
          return;
        }
        await ctx.reply('🚀 Creating new session...');
        this.syncToUI('telegram:create-session', {
          projectId: this.context.activeProjectId,
          prompt,
          chatId: ctx.chat?.id
        });
        break;
      }

      case 'status': {
        const project = this.context.activeProjectId
          ? this.sessionManager.db.getProject(this.context.activeProjectId)
          : null;
        const session = this.context.activeSessionId
          ? this.sessionManager.getSession(this.context.activeSessionId)
          : null;
        let status = '📊 *Status*\n\n';
        status += `Project: ${project ? project.name : '_none_'}\n`;
        status += `Session: ${session ? session.name : '_none_'}\n`;
        if (session) {
          status += `Status: ${session.status}\n`;
        }
        status += `\nAgent: ${this.agent.isAvailable() ? '✅ AI' : '⚡ Fallback'}`;
        await ctx.reply(status, { parse_mode: 'Markdown' });
        break;
      }

      case 'send_message': {
        const msg = action.params?.message || message;
        await this.sendMessageToSession(ctx, msg);
        break;
      }

      case 'unknown':
      default:
        await ctx.reply('I didn\'t understand that. Try:\n- list projects\n- open <name>\n- show sessions\n- select <id>\n- new <prompt>');
        break;
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
    await this.sendMessageToSession(ctx, caption, [localPath]);
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
    await this.sendMessageToSession(ctx, caption, [localPath]);
  }

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
      this.logger.error('Failed to send Telegram message:', error as Error);
    }
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

  getAllowedChatId(): string | null { return this.settings?.allowedChatId || null; }
}
