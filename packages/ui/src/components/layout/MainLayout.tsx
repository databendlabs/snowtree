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

  const [showDiffOverlay, setShowDiffOverlay] = useState(false);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedDiffTarget, setSelectedDiffTarget] = useState<DiffTarget | null>(null);
  const [diffFiles, setDiffFiles] = useState<FileChange[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [inputFocusRequestId, setInputFocusRequestId] = useState(0);
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
    if (session.toolType !== 'codex' && session.toolType !== 'claude') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const headBranch = branchName || 'main';
    const baseBranch = session.baseBranch || 'main';

    const pushPrompt = [
      'Push the current branch and update/create a GitHub PR based on committed changes (using `gh`).',
      '',
      `Base branch: ${baseBranch}`,
      `Expected head branch: ${headBranch}`,
      '',
      'Do (show the exact commands you run):',
      '1. Check status and get repo info:',
      '   - git status',
      '   - git branch --show-current',
      '   - git log -1 --oneline',
      '   - gh repo set-default --view  # Check if default repo is set and get <owner>/<repo>',
      '   - If no default repo is set: run `gh repo set-default` (interactive command) to let user select',
      '',
      '2. Check for PR template:',
      '   - Look for: .github/PULL_REQUEST_TEMPLATE.md, .github/pull_request_template.md, PULL_REQUEST_TEMPLATE.md, pull_request_template.md, docs/PULL_REQUEST_TEMPLATE.md',
      '   - If found, read it with: cat <template-path>',
      '   - Use the template structure for PR body',
      '',
      '3. Push branch:',
      '   - git push origin "$(git branch --show-current)"',
      '',
      '4. Create or update PR (ALWAYS use --repo <owner>/<repo> with gh commands):',
      '   - Check existing: gh pr view --repo <owner>/<repo> "$(git branch --show-current)" --json number,url,state',
      `   - If no PR exists: gh pr create --repo <owner>/<repo> --draft --base ${baseBranch} --head "$(git branch --show-current)" --title "<title>" --body "<body>"`,
      '   - If PR exists: gh pr edit --repo <owner>/<repo> "$(git branch --show-current)" --title "<title>" --body "<body>" (only if needed)',
      '',
      'Guidelines:',
      '- ALWAYS use --repo <owner>/<repo> with ALL gh commands (required for worktree compatibility)',
      '- ALWAYS use --draft flag when creating new PRs',
      '- Avoid commands that persist git config (e.g. `git push -u`, `git branch --set-upstream-to`, `git config ...`); in worktrees these may write outside the worktree directory and fail under restricted sandboxes',
      '- If you need SSH options for a single push, use `GIT_SSH_COMMAND=\"ssh -p 22\" git push origin \"$(git branch --show-current)\"` or `git -c core.sshCommand=\"ssh -p 22\" push origin \"$(git branch --show-current)\"` (do not persist config)',
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
    if (session.toolType !== 'codex' && session.toolType !== 'claude') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const baseBranch = session.baseBranch || 'main';

    const updatePrompt = [
      `Update the current branch with the latest changes from origin/${baseBranch}.`,
      '',
      'Do (show the exact commands you run):',
      '1. Check current state:',
      '   - git status  # Ensure working tree is clean',
      '   - git branch --show-current',
      '',
      '2. Fetch latest changes:',
      `   - git fetch origin ${baseBranch}`,
      '',
      '3. Rebase current branch:',
      `   - git rebase origin/${baseBranch}`,
      '',
      '4. If conflicts occur:',
      '   - List conflicted files: git status',
      '   - For each conflicted file:',
      '     a. Read the file content to see conflict markers',
      '     b. Analyze both sides (HEAD vs incoming)',
      '     c. Resolve by keeping the best code or merging both',
      '     d. Stage the resolved file: git add <file>',
      '   - Continue rebase: git rebase --continue',
      '   - Repeat until all conflicts are resolved',
      '',
      'Guidelines:',
      '- If working tree is dirty: stop and tell me to commit/stash changes first',
      '- If rebase has no conflicts: report success with summary',
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
    if (session.toolType !== 'codex' && session.toolType !== 'claude') return;

    handleCloseDiff();
    setInputFocusRequestId((prev) => prev + 1);

    const headBranch = branchName || 'HEAD';

    const syncPrompt = [
      `Sync local branch with the latest changes from the remote PR branch (origin/${headBranch}).`,
      '',
      'Do (show the exact commands you run):',
      '1. Check current state:',
      '   - git status  # Ensure working tree is clean',
      '   - git branch --show-current',
      '',
      '2. Fetch latest changes:',
      `   - git fetch origin ${headBranch}`,
      '',
      '3. Check divergence:',
      `   - git log --oneline HEAD..origin/${headBranch}  # Remote commits to pull`,
      `   - git log --oneline origin/${headBranch}..HEAD  # Local commits not pushed`,
      '',
      '4. Pull with rebase:',
      `   - git pull --rebase origin ${headBranch}`,
      '',
      '5. If conflicts occur:',
      '   - List conflicted files: git status',
      '   - For each conflicted file:',
      '     a. Read the file content to see conflict markers',
      '     b. Analyze both sides (local vs remote)',
      '     c. Resolve by keeping the best code or merging both',
      '     d. Stage the resolved file: git add <file>',
      '   - Continue rebase: git rebase --continue',
      '   - Repeat until all conflicts are resolved',
      '',
      'Guidelines:',
      '- If working tree is dirty: stop and tell me to commit/stash changes first',
      '- If pull has no conflicts: report success with summary',
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

  // Conversation-level keybinding: Tab only switches agent (Shift+Tab toggles plan/execute).
  // Prevent using Tab for focus traversal while a session conversation is active.
  useEffect(() => {
    if (!sessionId) return;

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
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

  const isCliAgent = displaySession.toolType === 'claude' || displaySession.toolType === 'codex';

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
              onSend={handleSendMessage}
              onCancel={cancelRequest}
              isProcessing={isProcessing}
              focusRequestId={inputFocusRequestId}
              initialExecutionMode={executionMode}
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
