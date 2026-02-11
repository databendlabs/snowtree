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
  hunkCounts?: {
    totalByPath: Record<string, number>;
    stagedByPath: Record<string, number>;
  };
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
    hunkCounts,
    onRefresh,
    onStageFile,
    onWorkingFileClick,
    onCommitFileClick,
    hasSelection,
  }) => {
    // Only show the "Loading..." placeholder during the initial load.
    // After we've loaded the working tree once, background refreshes should not
    // replace the empty-state text (e.g. "Select a commit") with a spinner.
    const showLoading = isLoading && !workingTree && commitFiles.length === 0;

    if (showLoading) {
      return (
        <div
          className="flex flex-col items-start py-8 px-3 gap-2"
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
        <div className="flex flex-col items-start py-6 px-3 gap-2">
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
            className="flex items-start py-8 px-3 text-xs"
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
                {(
                  [
                    { label: 'Staged', key: 'staged', items: trackedList.filter((x) => x.stageState === 'checked') },
                    { label: 'Partially staged', key: 'partial', items: trackedList.filter((x) => x.stageState === 'indeterminate') },
                    { label: 'Unstaged', key: 'unstaged', items: trackedList.filter((x) => x.stageState === 'unchecked') },
                  ] as const
                )
                  .filter((g) => g.items.length > 0)
                  .map((group) => (
                    <div key={group.key} className="mb-1">
                      <div
                        className="px-3 pt-2 pb-1 text-[10px] font-medium flex items-center justify-between"
                        style={{ color: colors.text.muted }}
                      >
                        <span>{group.label}</span>
                        <span className="font-mono text-[10px]">{group.items.length}</span>
                      </div>
                      <div>
                        {group.items.map(({ file, stageState }) => (
                          <WorkingFileRow
                            key={`tracked:${group.key}:${file.path}`}
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
                            hunkText={(() => {
                              const total = hunkCounts?.totalByPath[file.path] || 0;
                              if (total <= 0) return undefined;
                              const staged = hunkCounts?.stagedByPath[file.path] || 0;
                              return `(${staged}/${total} hunks)`;
                            })()}
                            testId={`right-panel-file-tracked-${file.path}`}
                          />
                        ))}
                      </div>
                    </div>
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
                    hunkText={(() => {
                      const total = hunkCounts?.totalByPath[file.path] || 0;
                      if (total <= 0) return undefined;
                      const staged = hunkCounts?.stagedByPath[file.path] || 0;
                      return `(${staged}/${total} hunks)`;
                    })()}
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
          className="flex items-start py-8 px-3 text-xs"
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
