/**
 * Executors Module - CLI tool executors for Snowtree
 *
 * This module provides a clean architecture for managing CLI tool processes,
 * inspired by vibe-kanban's executor pattern.
 *
 * Directory Structure:
 * - types.ts        - Common types and interfaces
 * - base/           - Abstract base classes
 *   - AbstractExecutor.ts - Base executor class
 * - claude/         - Claude Code executor
 *   - ClaudeExecutor.ts - Main executor
 *   - ClaudeMessageParser.ts - Stream-json message parser
 * - codex/          - OpenAI Codex executor
 *   - CodexExecutor.ts - Main executor (JSON-RPC)
 *   - CodexMessageParser.ts - Event notification parser
 * - gemini/         - Gemini CLI executor
 * - kimi/           - Kimi CLI executor
 *   - GeminiExecutor.ts - Main executor (stream-json)
 *   - GeminiMessageParser.ts - Event parser
 */

// Types
export * from './types';

// Base classes
export { AbstractExecutor } from './base';

// Claude executor
export { ClaudeExecutor, ClaudeMessageParser } from './claude';

// Codex executor
export { CodexExecutor, CodexMessageParser } from './codex';

// Gemini executor
export { GeminiExecutor, GeminiMessageParser } from './gemini';

// Kimi executor
export { KimiExecutor, KimiMessageParser } from './kimi';

// Git executor (Snowtree-run git operations)
export { GitExecutor } from './git';

// Factory function
import { ClaudeExecutor } from './claude';
import { CodexExecutor } from './codex';
import { GeminiExecutor } from './gemini';
import { KimiExecutor } from './kimi';
import type { ExecutorTool } from './types';
import type { Logger } from '../infrastructure/logging/logger';
import type { ConfigManager } from '../infrastructure/config/configManager';
import type { SessionManager } from '../features/session/SessionManager';

export function createExecutor(
  tool: ExecutorTool,
  sessionManager: SessionManager,
  logger?: Logger,
  configManager?: ConfigManager
) {
  switch (tool) {
    case 'claude':
      return new ClaudeExecutor(sessionManager, logger, configManager);
    case 'codex':
      return new CodexExecutor(sessionManager, logger, configManager);
    case 'gemini':
      return new GeminiExecutor(sessionManager, logger, configManager);
    case 'kimi':
      return new KimiExecutor(sessionManager, logger, configManager);
    default:
      throw new Error(`Unknown executor tool: ${tool}`);
  }
}
