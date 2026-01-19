import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { WorkspaceHeader } from './WorkspaceHeader';
import { ConversationPanel } from './ConversationPanel';
import { InputBar } from './InputBar';
import { RightPanel } from './RightPanel/index';
import { TerminalDock } from './TerminalDock';
import { DiffOverlay } from './DiffOverlay';
import { useLayoutData } from './useLayoutData';
import type { PendingMessage, FileChange } from './types';
import type { DiffTarget } from '../../types/diff';
import { isTerminalEventTarget } from './terminalUtils';

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
  const sessionTodos = useSessionStore(state => state.sessionTodos);

  const {
    session,
    aiPanel,
    terminalPanel,
    branchName,
    remoteName,
    selectedTool,
    isProcessing,
    isLoadingSession,
    loadError,
    executionMode,
    reload,
    toggleExecutionMode,
    cycleSelectedTool,
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

  const activeTodos = useMemo(() => {
    if (!activeSessionId) return [];
    return sessionTodos[activeSessionId] || [];
  }, [activeSessionId, sessionTodos]);

  const [showDiffOverlay, setShowDiffOverlay] = useState(false);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedDiffTarget, setSelectedDiffTarget] = useState<DiffTarget | null>(null);
  const [diffFiles, setDiffFiles] = useState<FileChange[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [inputFocusRequestId, setInputFocusRequestId] = useState(0);
  const mainColumnRef = useRef<HTMLDivElement | null>(null);
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
  const sessionId = session?.id ?? null;

  // Initialize git cache when session changes
  useEffect(() => {
    if (!sessionId || !session?.ownerRepo) {
      // Only init if session exists but cache is empty
      if (sessionId && session && !session.ownerRepo) {
        window.electronAPI.sessions.initGitCache(sessionId).catch((error: unknown) => {
          console.warn('[MainLayout] Failed to init git cache:', error);
        });
      }
    }
  }, [sessionId, session?.ownerRepo]);

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
  }, []);

  // Always close diff overlay when switching workspaces to avoid stale commit ids.
  useEffect(() => {
    handleCloseDiff();
    setPendingMessage(null);
  }, [activeSessionId, handleCloseDiff]);

  const handleSendMessage = useCallback(async (message: string, images?: import('./types').ImageAttachment[], planMode?: boolean) => {
    setPendingMessage({
      content: message,
      timestamp: new Date().toISOString(),
      images
    });
    await sendMessage(message, images, planMode);
  }, [sendMessage]);

  // Commit staged changes - AI executes git commit directly
  const handleOpenCommitReview = useCallback(async () => {
    if (!session || isProcessing) return;

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
      '- Use `git diff --cached --stat` as the authoritative check for staged content; if empty, nothing is staged',
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

  // Push and create/update PR - AI executes git push and gh pr directly
  const handleRequestPushPR = useCallback(async () => {
    if (!session || isProcessing) return;
    if (session.toolType !== 'codex' && session.toolType !== 'claude' && session.toolType !== 'gemini') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const headBranch = branchName || 'main';
    const baseBranch = session.baseBranch || 'main';

    // Build repo context from session cache
    const ownerRepo = session.ownerRepo || 'UNKNOWN';
    const isFork = session.isFork || false;
    const originOwnerRepo = session.originOwnerRepo;
    const originOwner = originOwnerRepo ? originOwnerRepo.split('/')[0] : null;

    // Compute pr_ref and pr_head based on fork workflow
    const prRef = isFork && originOwner ? `${originOwner}:${headBranch}` : headBranch;
    const prHead = isFork && originOwner ? `${originOwner}:${headBranch}` : headBranch;

    const pushPrompt = [
      'Push the current branch and update/create a GitHub PR based on committed changes (using `gh`).',
      '',
      `Base branch: ${baseBranch}`,
      `Current branch: ${headBranch}`,
      `Repository: ${ownerRepo}`,
      `Fork workflow: ${isFork ? 'yes' : 'no'}`,
      ...(isFork ? [`Origin repository: ${originOwnerRepo}`] : []),
      '',
      'Do (show the exact commands you run):',
      '1. Check status:',
      '   - git status',
      '   - git log -1 --oneline',
      '',
      '2. Check for PR template:',
      '   - Only look for: .github/PULL_REQUEST_TEMPLATE.md',
      '   - If found, read it with: cat .github/PULL_REQUEST_TEMPLATE.md',
      '   - Use the template structure for PR body',
      '',
      '3. Push branch:',
      '   - git push origin <branch>',
      '   - If push fails, show the exact error and ask me what to do next',
      '',
      '4. Create or update PR:',
      `   - Check existing: gh pr view --repo ${ownerRepo} ${prRef} --json number,url,state`,
      `   - If no PR exists: gh pr create --repo ${ownerRepo} --draft --base ${baseBranch} --head ${prHead} --title "<title>" --body "<body>"`,
      `   - If PR exists: gh pr edit --repo ${ownerRepo} ${prRef} --title "<title>" --body "<body>" (only if needed)`,
      '',
      'Guidelines:',
      '- ALWAYS use --draft flag when creating new PRs',
      '- Avoid commands that persist git config (e.g. `git push -u`, `git branch --set-upstream-to`, `git config ...`); in worktrees these may write outside the worktree directory and fail under restricted sandboxes',
      '- If you need SSH options for a single push, use `GIT_SSH_COMMAND=\"ssh -p 22\" git push origin <branch>` or `git -c core.sshCommand=\"ssh -p 22\" push origin <branch>` (do not persist config)',
      '- Do NOT mention the CLI/AI tool or add any generated-by/co-author signatures',
      '- If there are staged/unstaged changes: stop and tell me to commit first',
      '- If PR template exists: follow its structure exactly',
      '- If no template: write a clear summary with: What changed, Why, Testing notes',
      '- If a command fails: paste the exact error and ask me what to do next',
    ].join('\n');

    setPendingMessage({
      content: pushPrompt,
      timestamp: new Date().toISOString()
    });

    await sendMessageToTool(selectedTool, pushPrompt, { skipCheckpointAutoCommit: true });
  }, [session, isProcessing, selectedTool, handleCloseDiff, sendMessageToTool, branchName]);

  // Update branch - AI executes git rebase on main
  const handleUpdateBranch = useCallback(async () => {
    if (!session || isProcessing) return;
    if (session.toolType !== 'codex' && session.toolType !== 'claude' && session.toolType !== 'gemini') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const baseBranch = session.baseBranch || 'main';

    // Determine remote from session cache
    const isFork = session.isFork || false;
    const remoteName = isFork ? 'upstream' : 'origin';

    const updatePrompt = [
      `Update the current branch with the latest changes from the upstream base branch.`,
      '',
      `Base branch: ${baseBranch}`,
      `Remote: ${remoteName}`,
      `Fork workflow: ${isFork ? 'yes' : 'no'}`,
      '',
      'Do (show the exact commands you run):',
      '1. Check current state:',
      '   - git status  # Ensure working tree is clean',
      '',
      '2. Fetch and rebase:',
      `   - git fetch ${remoteName} ${baseBranch}`,
      `   - git rebase ${remoteName}/${baseBranch}`,
      '',
      '3. If conflicts occur:',
      '   - List conflicted files: git status',
      '   - For each conflicted file:',
      '     a. Read the file content to see conflict markers (<<<<<<< ======= >>>>>>>)',
      '     b. Analyze both sides (HEAD vs incoming)',
      '     c. Resolve by keeping the best code or merging both',
      '     d. git add <file>  # Stage the resolved file',
      '   - git rebase --continue',
      '   - Repeat until all conflicts are resolved',
      '',
      'Guidelines:',
      '- If working tree is dirty: stop and tell me to commit/stash changes first',
      '- If rebase succeeds: report success',
      '- If conflicts occur: analyze and resolve them intelligently',
      '- Preserve functionality from both sides when possible',
      '- If a command fails: paste the exact error and ask me what to do next',
    ].join('\n');

    setPendingMessage({
      content: updatePrompt,
      timestamp: new Date().toISOString()
    });

    await sendMessageToTool(selectedTool, updatePrompt, { skipCheckpointAutoCommit: true });
  }, [session, isProcessing, selectedTool, handleCloseDiff, sendMessageToTool]);

  // Sync PR changes - AI fetches and rebases remote PR updates
  const handleSyncPR = useCallback(async () => {
    if (!session || isProcessing) return;
    if (session.toolType !== 'codex' && session.toolType !== 'claude' && session.toolType !== 'gemini') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const headBranch = branchName || 'HEAD';

    const syncPrompt = [
      `Sync local branch with the latest changes from the remote PR branch (origin/${headBranch}).`,
      '',
      `Current branch: ${headBranch}`,
      '',
      'Do (show the exact commands you run):',
      '1. Check current state:',
      '   - git status  # Ensure working tree is clean',
      '',
      '2. Fetch and check divergence:',
      `   - git fetch origin ${headBranch}`,
      `   - git log --oneline HEAD..origin/${headBranch}  # Remote commits to pull`,
      `   - git log --oneline origin/${headBranch}..HEAD  # Local commits not pushed`,
      '',
      '3. Pull with rebase:',
      `   - git pull --rebase origin ${headBranch}`,
      '',
      '4. If conflicts occur:',
      '   - git status  # List conflicted files',
      '   - For each conflicted file:',
      '     a. Read the file content to see conflict markers (<<<<<<< ======= >>>>>>>)',
      '     b. Analyze both sides (local vs remote)',
      '     c. Resolve by keeping the best code or merging both',
      '     d. git add <file>  # Stage the resolved file',
      '   - git rebase --continue',
      '   - Repeat until all conflicts are resolved',
      '',
      'Guidelines:',
      '- If working tree is dirty: stop and tell me to commit/stash changes first',
      '- If pull succeeds: report success',
      '- If local has unpushed commits and remote has new commits: warn about divergence',
      '- If conflicts occur: analyze and resolve them intelligently',
      '- Preserve functionality from both sides when possible',
      '- If a command fails: paste the exact error and ask me what to do next',
    ].join('\n');

    setPendingMessage({
      content: syncPrompt,
      timestamp: new Date().toISOString()
    });

    await sendMessageToTool(selectedTool, syncPrompt, { skipCheckpointAutoCommit: true });
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

  const focusInputAfterHotkey = useCallback(() => {
    setInputFocusRequestId((prev) => prev + 1);
  }, [setInputFocusRequestId]);

  const handleConversationClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('button, a, input, textarea, select, label, [contenteditable=\"true\"], [role=\"button\"], [role=\"link\"], [role=\"checkbox\"], [role=\"textbox\"]')) {
      return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString()) return;

    focusInputAfterHotkey();
  }, [focusInputAfterHotkey]);

  // Conversation-level keybinding: Tab only switches agent (Shift+Tab toggles plan/execute).
  // Prevent using Tab for focus traversal while a session conversation is active.
  useEffect(() => {
    if (!sessionId) return;

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (isTerminalEventTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.shiftKey) {
        toggleExecutionMode();
        focusInputAfterHotkey();
        return;
      }

      cycleSelectedTool();
      focusInputAfterHotkey();
    };

    window.addEventListener('keydown', handleTabKey, { capture: true });
    return () => window.removeEventListener('keydown', handleTabKey, { capture: true });
  }, [sessionId, toggleExecutionMode, cycleSelectedTool, focusInputAfterHotkey]);

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

  const isCliAgent = displaySession.toolType === 'claude' || displaySession.toolType === 'codex' || displaySession.toolType === 'gemini';

  return (
    <div className="flex-1 flex h-full overflow-hidden st-bg" data-testid="main-layout">
      <div className="flex-1 flex flex-col min-w-0 relative" ref={mainColumnRef}>
        <WorkspaceHeader
          session={displaySession}
          branchName={branchName}
          remoteName={remoteName}
        />

        {session ? (
          <>
            <div
              key={session.id}
              className="flex-1 flex flex-col min-h-0 overflow-hidden animate-st-panel-in"
              onClick={handleConversationClick}
            >
              <ConversationPanel
                session={session}
                pendingMessage={pendingMessage}
              />
            </div>

            <InputBar
              session={session}
              panelId={aiPanel?.id || null}
              selectedTool={selectedTool}
              onSend={handleSendMessage}
              onCancel={cancelRequest}
              isProcessing={isProcessing}
              focusRequestId={inputFocusRequestId}
              initialExecutionMode={executionMode}
            />

            {terminalPanel && (
              <TerminalDock
                sessionId={session.id}
                panelId={terminalPanel.id}
                worktreePath={session.worktreePath}
                containerRef={mainColumnRef}
              />
            )}
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
          todos={activeTodos}
          onFileClick={handleFileClick}
          onCommitUncommittedChanges={isCliAgent ? handleOpenCommitReview : undefined}
          isCommitDisabled={isProcessing}
          onCommitClick={handleCommitClick}
          onPushPR={isCliAgent ? handleRequestPushPR : undefined}
          isPushPRDisabled={isProcessing}
          onUpdateBranch={isCliAgent ? handleUpdateBranch : undefined}
          isUpdateBranchDisabled={isProcessing}
          onSyncPR={isCliAgent ? handleSyncPR : undefined}
          isSyncPRDisabled={isProcessing}
        />
      </div>
    </div>
  );
});

MainLayout.displayName = 'MainLayout';

export default MainLayout;
