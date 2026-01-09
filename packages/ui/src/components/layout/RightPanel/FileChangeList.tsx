import React from 'react';
import { colors } from './constants';
import { FileItem } from './FileItem';
import { WorkingFileRow } from './WorkingFileRow';
import type { FileChange } from '../types';
import type { TrackedFileEntry, WorkingTreeScope } from './types';

export interface FileChangeListProps {
  isWorkingTreeSelected: boolean;
  isLoading: boolean;
  error: string | null;
  workingTree: {
    staged: FileChange[];
    unstaged: FileChange[];
    untracked: FileChange[];
  } | null;
  commitFiles: FileChange[];
  trackedList: TrackedFileEntry[];
  untrackedList: TrackedFileEntry[];
  selectedFile: string | null;
  selectedFileScope: WorkingTreeScope | 'commit' | null;
  isDisabled: boolean;
  workingFilesForDiffOverlay: FileChange[];
  onRefresh: () => void;
  onStageFile: (filePath: string, stage: boolean) => void;
  onWorkingFileClick: (
    scope: WorkingTreeScope,
    file: FileChange,
    groupFiles: FileChange[]
  ) => void;
  onCommitFileClick: (file: FileChange) => void;
  hasSelection: boolean;
}

export const FileChangeList: React.FC<FileChangeListProps> = React.memo(
  ({
    isWorkingTreeSelected,
    isLoading,
    error,
    workingTree,
    commitFiles,
    trackedList,
    untrackedList,
    selectedFile,
    selectedFileScope,
    isDisabled,
    workingFilesForDiffOverlay,
    onRefresh,
    onStageFile,
    onWorkingFileClick,
    onCommitFileClick,
    hasSelection,
  }) => {
    // Only show loading spinner on initial load, not on refresh
    // This prevents flickering when data is being refreshed in the background
    const showLoading = isLoading && !hasSelection && (isWorkingTreeSelected ? !workingTree : commitFiles.length === 0);

    if (showLoading) {
      return (
        <div
          className="flex flex-col items-center justify-center py-8 gap-2"
          style={{ color: colors.text.muted }}
        >
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-xs">Loading...</span>
        </div>
      );
    }

    const isIgnorableError = error && (
      error.includes('ENOENT') ||
      error.includes('spawn git') ||
      error.includes('not a git repository')
    );

    if (error && !isIgnorableError) {
      return (
        <div className="flex flex-col items-center justify-center py-6 gap-2">
          <span className="text-xs" style={{ color: colors.text.deleted }}>
            {error}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs px-3 py-1 rounded transition-all duration-75 st-hoverable st-focus-ring"
            style={{
              backgroundColor: colors.bg.hover,
              color: colors.text.secondary,
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    if (isWorkingTreeSelected) {
      const isEmpty =
        !workingTree ||
        workingTree.staged.length +
          workingTree.unstaged.length +
          workingTree.untracked.length ===
          0;

      if (isEmpty) {
        return (
          <div
            className="flex items-center justify-center py-8 text-xs"
            style={{ color: colors.text.muted }}
          >
            {!hasSelection ? 'Select a commit' : 'Working tree clean'}
          </div>
        );
      }

      return (
        <div className="py-2">
          {trackedList.length > 0 && (
            <div className="mb-2">
              <div
                className="px-3 pb-1 text-[10px] font-semibold tracking-wider uppercase"
                style={{ color: colors.text.muted }}
              >
                Tracked
              </div>
              <div>
                {trackedList.map(({ file, stageState }) => (
                  <WorkingFileRow
                    key={`tracked:${file.path}`}
                    file={file}
                    stageState={stageState}
                    disabled={isDisabled}
                    onToggleStage={() =>
                      onStageFile(file.path, stageState !== 'checked')
                    }
                    onClick={() =>
                      onWorkingFileClick('all', file, workingFilesForDiffOverlay)
                    }
                    isSelected={
                      selectedFile === file.path && selectedFileScope === 'all'
                    }
                    testId={`right-panel-file-tracked-${file.path}`}
                  />
                ))}
              </div>
            </div>
          )}

          {untrackedList.length > 0 && (
            <div className="mb-2">
              <div
                className="px-3 pb-1 text-[10px] font-semibold tracking-wider uppercase"
                style={{ color: colors.text.muted }}
              >
                Untracked
              </div>
              <div>
                {untrackedList.map(({ file, stageState }) => (
                  <WorkingFileRow
                    key={`untracked:${file.path}`}
                    file={file}
                    stageState={stageState}
                    disabled={isDisabled}
                    onToggleStage={() =>
                      onStageFile(file.path, stageState !== 'checked')
                    }
                    onClick={() =>
                      onWorkingFileClick(
                        'untracked',
                        file,
                        workingFilesForDiffOverlay
                      )
                    }
                    isSelected={
                      selectedFile === file.path &&
                      selectedFileScope === 'untracked'
                    }
                    testId={`right-panel-file-untracked-${file.path}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (commitFiles.length === 0) {
      return (
        <div
          className="flex items-center justify-center py-8 text-xs"
          style={{ color: colors.text.muted }}
        >
          {!hasSelection ? 'Select a commit' : 'No changes'}
        </div>
      );
    }

    return (
      <div className="py-1">
        {commitFiles.map((file) => (
          <FileItem
            key={file.path}
            file={file}
            onClick={() => onCommitFileClick(file)}
            isSelected={
              selectedFile === file.path && selectedFileScope === 'commit'
            }
            testId={`right-panel-file-commit-${file.path}`}
          />
        ))}
      </div>
    );
  }
);

FileChangeList.displayName = 'FileChangeList';
