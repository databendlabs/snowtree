import React, { useState, useCallback, useMemo } from 'react';
import { RefreshCw, ChevronDown, GitCommit, GitPullRequest, Check, ArrowUp, ArrowDown, RotateCw } from 'lucide-react';
import { useRightPanelData, type Commit } from '../useRightPanelData';
import type { FileChange, RightPanelProps } from '../types';
import type { DiffTarget } from '../../../types/diff';
import { colors } from './constants';
import { computeTrackedFiles, computeUntrackedFiles, countDiffHunksByPath, sumHunksByPath } from './utils';
import { CommitList } from './CommitList';
import { FileChangeList } from './FileChangeList';
import type { WorkingTreeScope } from './types';
import { CIStatusBadge, CIStatusDetails } from '../../../features/ci-status';
import { TodoList } from './TodoList';
import { useSessionStore } from '../../../stores/sessionStore';

export const RightPanel: React.FC<RightPanelProps> = React.memo(
  ({
    session,
    todos,
    onFileClick,
    onCommitUncommittedChanges,
    isCommitDisabled,
    onCommitClick,
    onPushPR,
    isPushPRDisabled,
    onUpdateBranch,
    isUpdateBranchDisabled,
    onSyncPR,
    isSyncPRDisabled,
  }) => {
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [selectedFileScope, setSelectedFileScope] = useState<
      WorkingTreeScope | 'commit' | null
    >(null);
    const [isCommitsExpanded, setIsCommitsExpanded] = useState(true);
    const [isChangesExpanded, setIsChangesExpanded] = useState(true);
    const [isPRExpanded, setIsPRExpanded] = useState(true);
    const [isCIExpanded, setIsCIExpanded] = useState(false);

    const updateSessionTodos = useSessionStore(state => state.updateSessionTodos);

    const handleClearTodos = useCallback(() => {
      updateSessionTodos(session.id, []);
    }, [session.id, updateSessionTodos]);

    const {
      commits,
      workingTree,
      workingTreeDiffs,
      remotePullRequest,
      branchSyncStatus,
      prSyncStatus,
      ciStatus,
      commitFiles,
      selection,
      isLoading,
      isMutating,
      error,
      selectWorkingTree,
      selectCommit,
      refresh,
      refreshBranchSync,
      stageAll,
      stageFile,
    } = useRightPanelData(session.id);

    const handleOpenRemotePullRequest = useCallback(async () => {
      if (!remotePullRequest?.url) return;
      try {
        await window.electronAPI?.invoke?.('shell:openExternal', remotePullRequest.url);
      } catch {
        // ignore
      }
    }, [remotePullRequest?.url]);

    const handleCICheckClick = useCallback(async (check: { detailsUrl: string | null }) => {
      if (!check.detailsUrl) return;
      try {
        await window.electronAPI?.invoke?.('shell:openExternal', check.detailsUrl);
      } catch {
        // ignore
      }
    }, []);

    const handleBaseCommitOpenGitHub = useCallback(async (commit: Commit) => {
      if (!commit.after_commit_hash || !session?.id) return;
      try {
        const result = await window.electronAPI?.sessions?.getCommitGithubUrl?.(
          session.id,
          { commitHash: commit.after_commit_hash }
        );
        if (result?.success && result.data?.url) {
          await window.electronAPI?.invoke?.('shell:openExternal', result.data.url);
        }
      } catch {
        // ignore
      }
    }, [session?.id]);

    const handleMarkPRReady = useCallback(async () => {
      if (!session?.id) return;
      try {
        console.log('[RightPanel] Marking PR as ready for session:', session.id);
        const result = await window.electronAPI?.sessions?.markPRReady?.(session.id);
        console.log('[RightPanel] Mark PR ready result:', result);
        if (result?.success) {
          console.log('[RightPanel] Successfully marked PR as ready, refreshing...');
          // Refresh to get updated PR status
          refresh();
        } else {
          console.error('[RightPanel] Failed to mark PR as ready:', result?.error);
        }
      } catch (error) {
        console.error('[RightPanel] Error marking PR as ready:', error);
      }
    }, [session?.id, refresh]);

    const isWorkingTreeSelected = selection?.kind === 'working';
    const selectedCommitHash =
      selection?.kind === 'commit' ? selection.hash : null;

    const trackedFiles = useMemo(
      () => computeTrackedFiles(workingTree),
      [workingTree]
    );
    const trackedList = useMemo(
      () => trackedFiles.filter((x) => !x.file.isNew),
      [trackedFiles]
    );
    const untrackedList = useMemo(
      () => computeUntrackedFiles(workingTree, trackedFiles),
      [workingTree, trackedFiles]
    );

    const workingFilesForDiffOverlay = useMemo(() => {
      const tracked = trackedList.map((x) => x.file);
      const untracked = untrackedList.map((x) => x.file);
      return [...tracked, ...untracked];
    }, [trackedList, untrackedList]);

    const totalHunksByPath = useMemo(
      () => countDiffHunksByPath(workingTreeDiffs.all),
      [workingTreeDiffs.all]
    );
    const stagedHunksByPath = useMemo(
      () => countDiffHunksByPath(workingTreeDiffs.staged),
      [workingTreeDiffs.staged]
    );
    const totalHunks = useMemo(() => sumHunksByPath(totalHunksByPath), [totalHunksByPath]);
    const stagedHunks = useMemo(
      () => Math.min(sumHunksByPath(stagedHunksByPath), totalHunks),
      [stagedHunksByPath, totalHunks]
    );

    const totalChanges = isWorkingTreeSelected
      ? (workingTree?.staged.length || 0) +
        (workingTree?.unstaged.length || 0) +
        (workingTree?.untracked.length || 0)
      : commitFiles.length;

    const selectedCommit = isWorkingTreeSelected
      ? commits.find((c) => c.id === 0)
      : selectedCommitHash
        ? commits.find(
            (c) => c.id !== 0 && c.after_commit_hash === selectedCommitHash
          )
        : null;

    const stagedFileCount = workingTree?.staged.length || 0;
    const canStageAll = Boolean(
      (workingTree?.unstaged.length || 0) + (workingTree?.untracked.length || 0)
    );
    const canUnstageAll = Boolean(workingTree?.staged.length || 0);

    // Check if there are any session commits (id > 0, not uncommitted or base)
    const hasSessionCommits = commits.some((c) => c.id > 0);

    // Check if working tree has uncommitted changes (must be clean for sync operations)
    const hasUncommittedChanges = Boolean(
      (workingTree?.staged.length || 0) +
        (workingTree?.unstaged.length || 0) +
        (workingTree?.untracked.length || 0)
    );

    const showHunkProgress = isWorkingTreeSelected && totalChanges > 0 && totalHunks > 0;
    const progressRatio = showHunkProgress && totalHunks > 0 ? stagedHunks / totalHunks : 0;

    const handleCommitSelect = useCallback(
      (commit: Commit) => {
        setSelectedFile(null);
        setSelectedFileScope(null);
        if (commit.id === 0) {
          selectWorkingTree();
          onCommitClick?.({ kind: 'working', scope: 'all' }, []);
        } else {
          selectCommit(commit.after_commit_hash);
          onCommitClick?.({ kind: 'commit', hash: commit.after_commit_hash }, []);
        }
      },
      [selectWorkingTree, selectCommit, onCommitClick]
    );

    const handleCommitFileClick = useCallback(
      (file: FileChange) => {
        setSelectedFile(file.path);
        setSelectedFileScope('commit');
        if (selectedCommitHash) {
          onFileClick(
            file.path,
            { kind: 'commit', hash: selectedCommitHash },
            commitFiles
          );
        }
      },
      [onFileClick, selectedCommitHash, commitFiles]
    );

    const handleWorkingFileClick = useCallback(
      (scope: WorkingTreeScope, file: FileChange, groupFiles: FileChange[]) => {
        setSelectedFile(file.path);
        setSelectedFileScope(scope);
        onFileClick(file.path, { kind: 'working', scope }, groupFiles);
      },
      [onFileClick]
    );

    const handleStageAll = useCallback(
      (stage: boolean) => {
        void stageAll(stage);
      },
      [stageAll]
    );

    const handleStageFile = useCallback(
      (filePath: string, stage: boolean) => {
        void stageFile(filePath, stage);
      },
      [stageFile]
    );

    const selectedTarget: DiffTarget | null = isWorkingTreeSelected
      ? { kind: 'working', scope: 'all' }
      : selectedCommitHash
        ? { kind: 'commit', hash: selectedCommitHash }
        : null;

    const isDisabled = isLoading || isMutating;

    return (
      <div
        className="h-full flex flex-col overflow-hidden"
        style={{
          backgroundColor: colors.bg.primary,
          borderLeft: `1px solid ${colors.border}`,
        }}
      >
        {/* 1. PR Section (flex-shrink-0, at top) */}
        <div
          className="flex-shrink-0"
          style={{
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div
            className="flex items-center justify-between px-3 py-2"
            style={{ backgroundColor: colors.bg.secondary }}
          >
            <button
              type="button"
              onClick={() => setIsPRExpanded(!isPRExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
              style={{ color: colors.text.secondary }}
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${isPRExpanded ? '' : '-rotate-90'}`}
                style={{ color: colors.text.muted }}
              />
              <span>Pull Request</span>
            </button>
            <button
              type="button"
              onClick={() => { refresh(); void refreshBranchSync(); }}
              disabled={isDisabled}
              className="p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
            >
              <RefreshCw
                className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`}
                style={{ color: colors.text.muted }}
              />
            </button>
          </div>

          <div
            className={`transition-all origin-top ${isPRExpanded ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0 h-0'}`}
            style={{ transitionDuration: '150ms' }}
          >
            <div className="px-3 pt-3 pb-3 space-y-2">
              {/* PR Info Card */}
              {remotePullRequest?.number && remotePullRequest.url ? (
                <div
                  className="rounded"
                  style={{
                    backgroundColor: colors.bg.hover,
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  <button
                    type="button"
                    onClick={handleOpenRemotePullRequest}
                    className="w-full text-left p-2 transition-all duration-75 st-hoverable st-focus-ring rounded-t"
                    data-testid="right-panel-open-remote-pr"
                  >
                    <div className="flex items-center gap-2">
                      <GitPullRequest
                        className="w-4 h-4"
                        style={{ color: remotePullRequest.state === 'draft' ? colors.text.muted : colors.accent }}
                      />
                      <span className="text-xs font-medium" style={{ color: colors.text.primary }}>
                        PR #{remotePullRequest.number}
                      </span>
                      {remotePullRequest.state === 'draft' && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                          style={{
                            backgroundColor: colors.bg.hover,
                            color: colors.text.muted,
                            border: `1px solid ${colors.border}`,
                          }}
                        >
                          draft
                        </span>
                      )}
                      {remotePullRequest.state === 'merged' && (
                        <span
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium"
                          style={{
                            backgroundColor: colors.text.added,
                            color: '#fff',
                          }}
                        >
                          <Check className="w-2.5 h-2.5" />
                          merged
                        </span>
                      )}
                      {ciStatus && (
                        <CIStatusBadge
                          status={ciStatus}
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsCIExpanded(!isCIExpanded);
                          }}
                          expanded={isCIExpanded}
                          as="span"
                        />
                      )}
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: colors.text.muted }}>
                      {prSyncStatus?.branch || 'branch'} → {session.baseBranch || 'main'}
                    </div>
                  </button>
                  {/* CI Status Details (expandable) */}
                  {isCIExpanded && ciStatus && (
                    <div className="px-2 pb-2">
                      <CIStatusDetails
                        checks={ciStatus.checks}
                        onCheckClick={handleCICheckClick}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="p-2 rounded text-xs"
                  style={{
                    backgroundColor: colors.bg.hover,
                    border: `1px solid ${colors.border}`,
                    color: colors.text.muted,
                  }}
                >
                  No pull request yet
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-1.5">
                {/* Mark as Ready (only show if draft, PR synced, and CI passed) */}
                {remotePullRequest && remotePullRequest.state === 'draft' && prSyncStatus?.localAhead === 0 && ciStatus?.rollupState === 'success' && (
                  <button
                    type="button"
                    onClick={handleMarkPRReady}
                    disabled={isDisabled}
                    className="w-full flex items-center justify-center px-2.5 py-2 rounded text-xs font-medium transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      backgroundColor: colors.accent,
                      color: '#fff',
                    }}
                    data-testid="right-panel-mark-pr-ready"
                  >
                    <Check className="w-3.5 h-3.5 mr-2" />
                    Mark as Ready for Review
                  </button>
                )}

                {/* Push & Create/Sync PR */}
                {onPushPR && (
                  <button
                    type="button"
                    onClick={onPushPR}
                    disabled={isPushPRDisabled || isDisabled || remotePullRequest?.state === 'merged' || !hasSessionCommits || (!!remotePullRequest && prSyncStatus?.localAhead === 0)}
                    className="w-full flex items-center justify-between px-2.5 py-2 rounded text-xs transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      backgroundColor: colors.bg.hover,
                      border: `1px solid ${colors.border}`,
                      color: (isPushPRDisabled || isDisabled || remotePullRequest?.state === 'merged' || !hasSessionCommits || (!!remotePullRequest && prSyncStatus?.localAhead === 0))
                        ? colors.text.muted
                        : colors.accent,
                    }}
                    data-testid="right-panel-sync-remote-pr"
                  >
                    <div className="flex items-center gap-2">
                      <ArrowUp className="w-3.5 h-3.5" />
                      <span>{remotePullRequest ? 'Push & Sync PR' : 'Push & Create PR'}</span>
                    </div>
                    {prSyncStatus && prSyncStatus.localAhead > 0 ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                        style={{
                          backgroundColor: colors.accent,
                          color: '#fff',
                        }}
                      >
                        ↑{prSyncStatus.localAhead}
                      </span>
                    ) : remotePullRequest && (
                      <span
                        className="text-[10px]"
                        style={{ color: colors.text.added }}
                      >
                        ✓ synced
                      </span>
                    )}
                  </button>
                )}

                {/* Sync PR Changes (fetch remote updates) */}
                {remotePullRequest && onSyncPR && (
                  <button
                    type="button"
                    onClick={onSyncPR}
                    disabled={isSyncPRDisabled || isDisabled || hasUncommittedChanges || remotePullRequest?.state === 'merged' || (prSyncStatus?.remoteAhead || 0) === 0}
                    className="w-full flex items-center justify-between px-2.5 py-2 rounded text-xs transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      backgroundColor: colors.bg.hover,
                      border: `1px solid ${colors.border}`,
                      color: (isSyncPRDisabled || isDisabled || hasUncommittedChanges || remotePullRequest?.state === 'merged' || (prSyncStatus?.remoteAhead || 0) === 0)
                        ? colors.text.muted
                        : colors.text.modified,
                    }}
                    data-testid="right-panel-fetch-pr-updates"
                  >
                    <div className="flex items-center gap-2">
                      <RotateCw className="w-3.5 h-3.5" />
                      <div className="text-left">
                        <span>Sync PR Changes</span>
                        {hasUncommittedChanges && (prSyncStatus?.remoteAhead || 0) > 0 && (
                          <div className="text-[9px] mt-0.5" style={{ color: colors.text.modified }}>
                            Commit changes first
                          </div>
                        )}
                      </div>
                    </div>
                    {(prSyncStatus?.remoteAhead || 0) > 0 ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                        style={{
                          backgroundColor: colors.text.modified,
                          color: '#fff',
                        }}
                      >
                        ↓{prSyncStatus?.remoteAhead}
                      </span>
                    ) : (
                      <span
                        className="text-[10px]"
                        style={{ color: colors.text.added }}
                      >
                        ✓ synced
                      </span>
                    )}
                  </button>
                )}

                {/* Update from Main - hidden when PR is merged */}
                {onUpdateBranch && remotePullRequest?.state !== 'merged' && (
                  <button
                    type="button"
                    onClick={onUpdateBranch}
                    disabled={isUpdateBranchDisabled || isDisabled || hasUncommittedChanges || (branchSyncStatus?.commitsBehindMain || 0) === 0}
                    className="w-full flex items-center justify-between px-2.5 py-2 rounded text-xs transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{
                      backgroundColor: colors.bg.hover,
                      border: `1px solid ${colors.border}`,
                      color: (isUpdateBranchDisabled || isDisabled || hasUncommittedChanges || (branchSyncStatus?.commitsBehindMain || 0) === 0)
                        ? colors.text.muted
                        : colors.text.modified,
                    }}
                    data-testid="right-panel-update-branch"
                  >
                    <div className="flex items-center gap-2">
                      <ArrowDown className="w-3.5 h-3.5" />
                      <div className="text-left">
                        <span>Update from {branchSyncStatus?.baseBranch || session.baseBranch || 'main'}</span>
                        {hasUncommittedChanges && (branchSyncStatus?.commitsBehindMain || 0) > 0 && (
                          <div className="text-[9px] mt-0.5" style={{ color: colors.text.modified }}>
                            Commit changes first
                          </div>
                        )}
                      </div>
                    </div>
                    {(branchSyncStatus?.commitsBehindMain || 0) > 0 ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                        style={{
                          backgroundColor: colors.text.modified,
                          color: '#fff',
                        }}
                      >
                        ↓{branchSyncStatus?.commitsBehindMain}
                      </span>
                    ) : (
                      <span
                        className="text-[10px]"
                        style={{ color: colors.text.added }}
                      >
                        ✓ latest
                      </span>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 2. Commits Section (flex-shrink-0) */}
        <div
          className="flex-shrink-0"
          style={{ borderBottom: `1px solid ${colors.border}` }}
        >
          <div
            className="flex items-center justify-between px-3 py-2"
            style={{ backgroundColor: colors.bg.secondary }}
          >
            <button
              type="button"
              onClick={() => setIsCommitsExpanded(!isCommitsExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
              style={{ color: colors.text.secondary }}
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${isCommitsExpanded ? '' : '-rotate-90'}`}
                style={{ color: colors.text.muted }}
              />
              <span>Commits</span>
            </button>
          </div>

          <div
            className={`transition-all origin-top ${isCommitsExpanded ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0 h-0'}`}
            style={{ transitionDuration: '150ms' }}
          >
            <div className="max-h-48 overflow-y-auto">
              <CommitList
                commits={commits}
                selectedCommitHash={selectedCommitHash}
                isWorkingTreeSelected={isWorkingTreeSelected}
                onCommitSelect={handleCommitSelect}
                onBaseCommitOpenGitHub={handleBaseCommitOpenGitHub}
              />
            </div>
          </div>
        </div>

        {/* 3. Changes Section (below Commits, scrolls within panel) */}
        <div className="flex flex-col min-h-0 flex-1">
          <div
            style={{
              backgroundColor: colors.bg.secondary,
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <div className="flex items-center justify-between px-3 py-2">
              <button
                type="button"
                onClick={() => setIsChangesExpanded(!isChangesExpanded)}
                className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
                style={{ color: colors.text.secondary }}
              >
                <ChevronDown
                  className={`w-3 h-3 transition-transform ${isChangesExpanded ? '' : '-rotate-90'}`}
                  style={{ color: colors.text.muted }}
                />
                <span>Changes</span>
                {totalChanges > 0 && (
                  <span
                    className="ml-1 px-1.5 py-0.5 text-[10px] rounded font-mono"
                    style={{
                      backgroundColor: colors.bg.hover,
                      color: colors.text.muted,
                    }}
                  >
                    {totalChanges}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-2">
                {isWorkingTreeSelected && totalChanges > 0 && (
                  <button
                    type="button"
                    onClick={() => onCommitUncommittedChanges?.()}
                    disabled={Boolean(isCommitDisabled) || stagedFileCount === 0}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                    style={{ color: colors.accent }}
                    data-testid="right-panel-commit"
                  >
                    <GitCommit className="w-3 h-3" />
                    Commit
                  </button>
                )}
                {selectedCommit && (
                  <span
                    className="text-[10px] font-mono truncate max-w-[100px]"
                    style={{
                      color:
                        selectedCommit.id === 0
                          ? colors.text.modified
                          : colors.accent,
                    }}
                    title={selectedCommit.commit_message}
                  >
                    {selectedCommit.id === 0
                      ? ''
                      : selectedCommit.after_commit_hash.substring(0, 7)}
                  </span>
                )}
              </div>
            </div>

            {isWorkingTreeSelected && totalChanges > 0 && (
              <div
                className="flex items-center justify-between px-3 pb-2 -mt-1 gap-2"
                {...(showHunkProgress && { 'data-testid': 'right-panel-review-summary' })}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex items-center gap-2">
                    {canStageAll ? (
                      <button
                        type="button"
                        data-testid="right-panel-stage-all"
                        disabled={isDisabled}
                        onClick={() => handleStageAll(true)}
                        className="px-2.5 py-1 rounded text-[10px] font-medium transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                        style={{
                          color: colors.text.primary,
                          backgroundColor: colors.bg.hover,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        Stage All
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="right-panel-unstage-all"
                        disabled={isDisabled || !canUnstageAll}
                        onClick={() => handleStageAll(false)}
                        className="px-2.5 py-1 rounded text-[10px] font-medium transition-all duration-75 st-hoverable st-focus-ring disabled:opacity-40"
                        style={{
                          color: colors.text.primary,
                          backgroundColor: colors.bg.hover,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        Unstage All
                      </button>
                    )}
                  </div>
                  {showHunkProgress && (
                    <>
                      <span className="text-[10px]" style={{ color: colors.text.muted }}>
                        Review:
                      </span>
                      <span className="text-[10px] font-mono" style={{ color: colors.text.secondary }}>
                        {stagedHunks}/{totalHunks} hunks
                      </span>
                      <div
                        className="h-1.5 w-24 rounded overflow-hidden flex-shrink-0"
                        style={{ backgroundColor: colors.bg.hover }}
                        aria-hidden="true"
                      >
                        <div
                          className="h-full"
                          style={{
                            width: `${Math.round(progressRatio * 100)}%`,
                            backgroundColor: colors.accent,
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div
            className={`flex-1 overflow-y-auto transition-all origin-top ${isChangesExpanded ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0 h-0'}`}
            style={{ transitionDuration: '150ms' }}
          >
            <FileChangeList
              isWorkingTreeSelected={isWorkingTreeSelected}
              isLoading={isLoading}
              error={error}
              workingTree={workingTree}
              commitFiles={commitFiles}
              trackedList={trackedList}
              untrackedList={untrackedList}
              selectedFile={selectedFile}
              selectedFileScope={selectedFileScope}
              isDisabled={isDisabled}
              workingFilesForDiffOverlay={workingFilesForDiffOverlay}
              hunkCounts={
                showHunkProgress
                  ? { totalByPath: totalHunksByPath, stagedByPath: stagedHunksByPath }
                  : undefined
              }
              onRefresh={refresh}
              onStageFile={handleStageFile}
              onWorkingFileClick={handleWorkingFileClick}
              onCommitFileClick={handleCommitFileClick}
              hasSelection={Boolean(selectedTarget)}
            />
          </div>
        </div>

        {/* 4. Tasks Section (at bottom) */}
        <div className="mt-auto">
          <TodoList todos={todos} onClear={handleClearTodos} />
        </div>
      </div>
    );
  }
);

RightPanel.displayName = 'RightPanel';

export default RightPanel;
