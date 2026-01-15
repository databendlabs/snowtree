import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupEventListeners } from './events';
import type { NormalizedEntry } from './executors/types';
import type { AppServices } from './infrastructure/ipc';

class MockSessionManager extends EventEmitter {
  upsertStreamingAssistantTimeline = vi.fn();
  finalizeStreamingAssistantTimeline = vi.fn();
  addPanelConversationMessage = vi.fn();
  clearStreamingAssistantTimeline = vi.fn();
  updateSessionStatus = vi.fn();
  getSession = vi.fn(() => ({ id: 'session', status: 'waiting' }));
}

class MockGitStatusManager extends EventEmitter {
  refreshSessionGitStatus = vi.fn().mockResolvedValue(undefined);
}

class MockExecutor extends EventEmitter {}

const createAssistantEntry = (options: {
  id: string;
  panelId: string;
  sessionId: string;
  content: string;
  timestamp: string;
  streaming: boolean;
  tool?: string;
}): NormalizedEntry => ({
  id: options.id,
  entryType: 'assistant_message',
  content: options.content,
  timestamp: options.timestamp,
  metadata: {
    panelId: options.panelId,
    sessionId: options.sessionId,
    streaming: options.streaming,
    tool: options.tool,
  },
});

describe('setupEventListeners - assistant streaming retention', () => {
  let sessionManager: MockSessionManager;
  let gitStatusManager: MockGitStatusManager;
  let claudeExecutor: MockExecutor;
  let codexExecutor: MockExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    gitStatusManager = new MockGitStatusManager();
    claudeExecutor = new MockExecutor();
    codexExecutor = new MockExecutor();

    const services = {
      sessionManager,
      gitStatusManager,
      claudeExecutor,
      codexExecutor,
    } as unknown as AppServices;

    setupEventListeners(services, () => null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps streamed content when final Claude chunk is empty', () => {
    const panelId = 'panel-empty';
    const sessionId = 'session-empty';
    const streamedText = 'Full streamed assistant reply';
    const streamTimestamp = '2024-01-01T00:00:00.000Z';

    claudeExecutor.emit(
      'entry',
      createAssistantEntry({
        id: 'stream-1',
        panelId,
        sessionId,
        content: streamedText,
        timestamp: streamTimestamp,
        streaming: true,
        tool: 'claude',
      })
    );

    claudeExecutor.emit(
      'entry',
      createAssistantEntry({
        id: 'final-1',
        panelId,
        sessionId,
        content: '',
        timestamp: '2024-01-01T00:00:01.000Z',
        streaming: false,
        tool: 'claude',
      })
    );

    expect(sessionManager.finalizeStreamingAssistantTimeline).toHaveBeenCalledWith(
      panelId,
      sessionId,
      'claude',
      streamedText,
      streamTimestamp
    );
    expect(sessionManager.addPanelConversationMessage).toHaveBeenCalledWith(
      panelId,
      'assistant',
      streamedText,
      { recordTimeline: false }
    );
  });

  it('chooses buffered text when completion truncates the response', () => {
    const panelId = 'panel-short';
    const sessionId = 'session-short';
    const streamedText = 'Detailed thought out plan';

    claudeExecutor.emit(
      'entry',
      createAssistantEntry({
        id: 'stream-2',
        panelId,
        sessionId,
        content: streamedText,
        timestamp: '2024-02-01T12:00:00.000Z',
        streaming: true,
        tool: 'claude',
      })
    );

    claudeExecutor.emit(
      'entry',
      createAssistantEntry({
        id: 'final-2',
        panelId,
        sessionId,
        content: 'Detailed',
        timestamp: '2024-02-01T12:00:01.000Z',
        streaming: false,
        tool: 'claude',
      })
    );

    expect(sessionManager.finalizeStreamingAssistantTimeline).toHaveBeenCalledWith(
      panelId,
      sessionId,
      'claude',
      streamedText,
      '2024-02-01T12:00:00.000Z'
    );
    expect(sessionManager.addPanelConversationMessage).toHaveBeenCalledWith(
      panelId,
      'assistant',
      streamedText,
      { recordTimeline: false }
    );
  });
});
