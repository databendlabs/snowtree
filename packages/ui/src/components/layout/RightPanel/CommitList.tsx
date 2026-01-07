import React from 'react';
import { colors } from './constants';
import { StackConnector } from './StackConnector';
import { CommitItem } from './CommitItem';
import type { CommitData } from './types';

export interface CommitListProps {
  commits: CommitData[];
  selectedCommitHash: string | null;
  isWorkingTreeSelected: boolean;
  onCommitSelect: (commit: CommitData) => void;
}

export const CommitList: React.FC<CommitListProps> = React.memo(
  ({ commits, selectedCommitHash, isWorkingTreeSelected, onCommitSelect }) => {
    const uncommitted = commits.find((c) => c.id === 0) || null;
    const baseCommit = commits.find((c) => c.id === -1) || null;
    const sessionCommits = commits.filter((c) => c.id > 0);
    const headHash = sessionCommits[0]?.after_commit_hash || null;
    const hasSessionCommits = sessionCommits.length > 0;

    if (commits.length === 0) {
      return (
        <div
          className="flex items-center justify-center py-6 text-xs"
          style={{ color: colors.text.muted }}
        >
          No commits
        </div>
      );
    }

    return (
      <div>
        {uncommitted && hasSessionCommits && (
          <div className="flex">
            <div className="w-5 flex flex-col items-center pt-3">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  backgroundColor: isWorkingTreeSelected
                    ? colors.accent
                    : colors.text.modified,
                  boxShadow: isWorkingTreeSelected
                    ? `0 0 0 3px color-mix(in srgb, ${colors.accent} 18%, transparent)`
                    : 'none',
                }}
              />
              {(hasSessionCommits || baseCommit) && (
                <StackConnector accent={isWorkingTreeSelected} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <CommitItem
                commit={uncommitted}
                isSelected={isWorkingTreeSelected}
                onClick={() => onCommitSelect(uncommitted)}
              />
            </div>
          </div>
        )}

        {sessionCommits.map((commit, idx) => {
          const isSelected = selectedCommitHash === commit.after_commit_hash;
          const isLastSession = idx === sessionCommits.length - 1;
          const isHead = headHash === commit.after_commit_hash;
          return (
            <div key={commit.after_commit_hash} className="flex">
              <div className="w-5 flex flex-col items-center pt-3">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: isSelected
                      ? colors.accent
                      : colors.text.muted,
                    boxShadow: isSelected
                      ? `0 0 0 3px color-mix(in srgb, ${colors.accent} 18%, transparent)`
                      : 'none',
                  }}
                />
                {(!isLastSession || baseCommit) && (
                  <StackConnector accent={isSelected} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <CommitItem
                  commit={commit}
                  isSelected={isSelected}
                  badge={isHead ? 'head' : undefined}
                  onClick={() => onCommitSelect(commit)}
                />
              </div>
            </div>
          );
        })}

        {baseCommit && (
          <div className="flex">
            <div className="w-5 flex flex-col items-center pt-3">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  backgroundColor: 'transparent',
                  border: `1px solid ${colors.border}`,
                }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <CommitItem
                commit={baseCommit}
                isSelected={selectedCommitHash === baseCommit.after_commit_hash}
                badge="base"
                onClick={() => onCommitSelect(baseCommit)}
              />
            </div>
          </div>
        )}
      </div>
    );
  }
);

CommitList.displayName = 'CommitList';
