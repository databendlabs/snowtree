import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { WorkspaceHeader } from './WorkspaceHeader';
import { ConversationPanel } from './ConversationPanel';
import { InputBar } from './InputBar';
import { RightPanel } from './RightPanel/index';
import { DiffOverlay } from './DiffOverlay';
import { useLayoutData } from './useLayoutData';
import type { PendingMessage, FileChange } from './types';
import type { DiffTarget } from '../../types/diff';

const RIGHT_PANEL_WIDTH_KEY = 'snowtree-right-panel-width';
const DEFAULT_RIGHT_PANEL_WIDTH = 340;
const MIN_RIGHT_PANEL_WIDTH = 260;
const MAX_RIGHT_PANEL_WIDTH = 560;

const EmptyState: React.FC = () => (
  <div className="flex-1 flex flex-col items-center justify-center st-bg">
    <div className="flex flex-col items-center gap-4 text-center">
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center border st-hairline"
        style={{ backgroundColor: 'color-mix(in srgb, var(--st-editor) 55%, transparent)' }}
      >
        <svg className="w-6 h-6" style={{ color: 'var(--st-text-faint)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--st-text)' }}>No workspace selected</p>
        <p className="text-xs mt-1 st-text-faint">Select a workspace from the sidebar to get started</p>
      </div>
    </div>
  </div>
);

const LoadingState: React.FC<{ title: string; subtitle?: string; onRetry?: () => void }> = ({ title, subtitle, onRetry }) => (
  <div className="flex-1 flex flex-col items-center justify-center st-bg">
    <div className="flex flex-col items-center gap-4 text-center">
      <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--st-text-faint)' }} />
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--st-text)' }}>{title}</p>
        {subtitle && <p className="text-xs mt-1 st-text-faint">{subtitle}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 rounded-md text-xs border st-hairline-strong st-hoverable st-focus-ring"
          style={{ backgroundColor: 'color-mix(in srgb, var(--st-editor) 70%, transparent)', color: 'var(--st-text)' }}
        >
          Retry
        </button>
      )}
    </div>
  </div>
);

export const MainLayout: React.FC = React.memo(() => {
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const sessions = useSessionStore(state => state.sessions);

  const {
    session,
    aiPanel,
    branchName,
    selectedTool,
    isProcessing,
    isLoadingSession,
    loadError,
    reload,
    setSelectedTool,
    sendMessage,
    sendMessageToTool,
    cancelRequest
  } = useLayoutData(activeSessionId);

  const sessionFromStore = useMemo(() => {
    if (!activeSessionId) return null;
    return sessions.find(s => s.id === activeSessionId) || null;
  }, [activeSessionId, sessions]);

  const displaySession = useMemo(() => {
    if (session) return session;
    if (sessionFromStore) return sessionFromStore;
    if (!activeSessionId) return null;
    return {
      id: activeSessionId,
      name: 'Loading…',
      status: 'waiting' as const,
      createdAt: new Date().toISOString(),
    };
  }, [session, sessionFromStore, activeSessionId]);

  const [showDiffOverlay, setShowDiffOverlay] = useState(false);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedDiffTarget, setSelectedDiffTarget] = useState<DiffTarget | null>(null);
  const [diffFiles, setDiffFiles] = useState<FileChange[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [inputFocusRequestId, setInputFocusRequestId] = useState(0);
  const [commitReviewArmed, setCommitReviewArmed] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const stored = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
    if (stored) {
      const width = parseInt(stored, 10);
      if (!isNaN(width) && width >= MIN_RIGHT_PANEL_WIDTH && width <= MAX_RIGHT_PANEL_WIDTH) {
        return width;
      }
    }
    return DEFAULT_RIGHT_PANEL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, rightPanelWidth.toString());
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      const constrainedWidth = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, newWidth));
      setRightPanelWidth(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleFileClick = useCallback((filePath: string, target: DiffTarget, files?: FileChange[]) => {
    setSelectedDiffFile(filePath);
    setSelectedDiffTarget(target);
    if (files) {
      setDiffFiles(files);
    }
    setShowDiffOverlay(true);
  }, []);

  const handleCloseDiff = useCallback(() => {
    setShowDiffOverlay(false);
    setSelectedDiffFile(null);
    setSelectedDiffTarget(null);
    setDiffFiles([]);
    setCommitReviewArmed(false);
  }, []);

  // Always close diff overlay when switching workspaces to avoid stale commit ids.
  useEffect(() => {
    handleCloseDiff();
    setPendingMessage(null);
  }, [activeSessionId, handleCloseDiff]);

  const handleSendMessage = useCallback(async (message: string, images?: import('./types').ImageAttachment[]) => {
    setPendingMessage({
      content: message,
      timestamp: new Date().toISOString(),
      images
    });
    await sendMessage(message, images);
  }, [sendMessage]);

  const handleOpenCommitReview = useCallback(() => {
    if (!session || isProcessing) return;
    setCommitReviewArmed(true);
    setSelectedDiffTarget({ kind: 'working', scope: 'all' });
    setSelectedDiffFile(null);
    setDiffFiles([]);
    setShowDiffOverlay(true);
  }, [session, isProcessing]);

  const handleSendCommitRequest = useCallback(async () => {
    if (!session || isProcessing) return;
    if (session.toolType !== 'codex' && session.toolType !== 'claude') return;

    const toolForSession = selectedTool;

    const commitPrompt = [
      'Create a git commit from what is currently STAGED (index) in this session.',
      '',
      'Do (show the exact commands you run):',
      '- git status',
      '- git diff --cached --stat',
      '- git commit -m "<message>"',
      '',
      'Guidelines:',
      '- Use a clear, short commit message',
      '- Do NOT mention the CLI/AI tool or add any generated-by/co-author signatures',
      '- Do NOT stage additional files; only commit what is already staged',
      '- If nothing is staged: stop and ask me to stage hunks/files first',
      '- If a command fails: paste the exact error and ask me what to do next',
    ].join('\n');

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);
    setPendingMessage({
      content: commitPrompt,
      timestamp: new Date().toISOString()
    });

    await sendMessageToTool(toolForSession, commitPrompt, { skipCheckpointAutoCommit: true });
  }, [session, isProcessing, selectedTool, handleCloseDiff, sendMessageToTool]);

  const handleRequestPushPR = useCallback(async () => {
    if (!session || isProcessing) return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    if (session.toolType !== 'codex' && session.toolType !== 'claude') return;
    const toolForSession = selectedTool;

    const headBranch = branchName || 'main';
    const baseBranch = session.baseBranch || 'main';

    const pushPrompt = [
      'Push the current branch and update/create a GitHub PR based on committed changes (using `gh`).',
      '',
      `Base branch: ${baseBranch}`,
      `Expected head branch: ${headBranch}`,
      '',
      'Do (show the exact commands you run):',
      '- git status',
      '- git branch --show-current',
      '- git log -1 --oneline',
      '- git remote -v',
      '- git push -u origin "$(git branch --show-current)"',
      '- gh pr view --json number,url,headRefName --jq \'{number,url,headRefName}\'',
      `- If no PR exists: gh pr create --base ${baseBranch} --head "$(git branch --show-current)" --title "<title>" --body "<body>"`,
      '',
      'Guidelines:',
      '- Do NOT mention the CLI/AI tool or add any generated-by/co-author signatures',
      '- If there are staged/unstaged changes: stop and tell me to commit first (PR should be based on commits)',
      '- If the repo has a PR template, follow it; otherwise write a short summary + testing notes',
      '- If `gh pr view` fails with "none of the git remotes ... point to a known GitHub host":',
      '  - Determine the GitHub repo from the origin URL (e.g. github.com/<owner>/<repo>) and rerun with `--repo <owner>/<repo>`:',
      '    - gh pr view --repo "<owner>/<repo>" --json number,url,headRefName --jq \'{number,url,headRefName}\'',
      `    - If no PR exists: gh pr create --repo "<owner>/<repo>" --base ${baseBranch} --head "$(git branch --show-current)" --title "<title>" --body "<body>"`,
      '- If a command fails: paste the exact error and ask me what to do next',
    ].join('\n');

    setPendingMessage({
      content: pushPrompt,
      timestamp: new Date().toISOString()
    });

    await sendMessageToTool(toolForSession, pushPrompt, { skipCheckpointAutoCommit: true });
  }, [session, isProcessing, selectedTool, handleCloseDiff, sendMessageToTool, branchName]);

  const handleCommitClick = useCallback((target: DiffTarget, files: FileChange[]) => {
    setSelectedDiffTarget(target);
    setDiffFiles(files);
    setSelectedDiffFile(null);
    setShowDiffOverlay(true);
  }, []);

  // Clear pending message when processing completes
  useEffect(() => {
    if (!isProcessing && pendingMessage) {
      // Small delay to let the real message appear first
      const timer = setTimeout(() => setPendingMessage(null), 500);
      return () => clearTimeout(timer);
    }
  }, [isProcessing, pendingMessage]);

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex h-full st-bg">
        <EmptyState />
      </div>
    );
  }

  if (!displaySession) {
    return (
      <div className="flex-1 flex h-full st-bg">
        <LoadingState title="Loading workspace…" subtitle="Preparing view…" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden st-bg" data-testid="main-layout">
      <div className="flex-1 flex flex-col min-w-0 relative">
        <WorkspaceHeader
          session={displaySession}
          branchName={branchName}
        />

        {session ? (
          <>
            <div key={session.id} className="flex-1 flex flex-col min-h-0 overflow-hidden animate-st-panel-in">
              <ConversationPanel
                session={session}
                pendingMessage={pendingMessage}
              />
            </div>

            <InputBar
              session={session}
              panelId={aiPanel?.id || null}
              selectedTool={selectedTool}
              onToolChange={setSelectedTool}
              onSend={handleSendMessage}
              onCancel={cancelRequest}
              isProcessing={isProcessing}
              focusRequestId={inputFocusRequestId}
            />
          </>
        ) : (
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {isLoadingSession ? (
              <LoadingState title="Loading workspace…" subtitle="Fetching timeline, panels, and git status" />
            ) : (
              <LoadingState title="Failed to load workspace" subtitle={loadError || 'Unknown error'} onRetry={reload} />
            )}
          </div>
        )}

        <DiffOverlay
          isOpen={showDiffOverlay}
          filePath={selectedDiffFile}
          sessionId={displaySession.id}
          target={selectedDiffTarget}
          files={diffFiles}
          onClose={handleCloseDiff}
          banner={commitReviewArmed && selectedDiffTarget?.kind === 'working' && (selectedDiffTarget.scope || 'all') === 'all' ? {
            title: 'Review uncommitted diff',
            description: 'After review, send a commit request to the session CLI (all git commands will be shown in the timeline).',
            primaryLabel: 'Send commit request',
            onPrimary: handleSendCommitRequest,
            secondaryLabel: 'Cancel',
            onSecondary: handleCloseDiff,
            primaryDisabled: isProcessing
          } : undefined}
        />
      </div>

      <div
        className="group w-2 flex-shrink-0 cursor-col-resize relative"
        onMouseDown={handleResizeStart}
        data-testid="resize-handle"
      >
        <div
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors"
          style={{
            backgroundColor: isResizing
              ? 'color-mix(in srgb, var(--st-accent) 75%, transparent)'
              : 'color-mix(in srgb, var(--st-border) 65%, transparent)',
          }}
        />
        <div
          className="absolute inset-y-0 left-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, transparent, color-mix(in srgb, var(--st-accent) 18%, transparent), transparent)',
          }}
        />
      </div>

      <div
        className="flex-shrink-0 h-full"
        style={{ width: rightPanelWidth }}
        data-testid="right-panel"
      >
        <RightPanel
          key={displaySession.id}
          session={displaySession}
          onFileClick={handleFileClick}
          onCommitUncommittedChanges={(displaySession.toolType === 'claude' || displaySession.toolType === 'codex') ? handleOpenCommitReview : undefined}
          isCommitDisabled={isProcessing}
          onCommitClick={handleCommitClick}
          onPushPR={(displaySession.toolType === 'claude' || displaySession.toolType === 'codex') ? handleRequestPushPR : undefined}
          isPushPRDisabled={isProcessing}
        />
      </div>
    </div>
  );
});

MainLayout.displayName = 'MainLayout';

export default MainLayout;
