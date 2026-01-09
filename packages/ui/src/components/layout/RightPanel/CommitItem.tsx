import React, { useState, useCallback } from 'react';
import { GitCommit, Copy } from 'lucide-react';
import { colors } from './constants';
import { formatCommitTime } from './utils';
import type { CommitItemProps } from './types';

export const CommitItem: React.FC<CommitItemProps> = React.memo(
  ({ commit, isSelected, badge, onClick }) => {
    const [isHovered, setIsHovered] = useState(false);
    const isUncommitted = commit.id === 0;
    const isBase = commit.id === -1;
    const shortHash = isUncommitted ? '' : commit.after_commit_hash.substring(0, 7);

    const handleCopyHash = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (commit.after_commit_hash) {
          await navigator.clipboard.writeText(commit.after_commit_hash).catch(() => {});
        }
      },
      [commit.after_commit_hash]
    );

    const bg = isSelected
      ? colors.bg.selected
      : isHovered && !isBase
        ? colors.bg.hover
        : 'transparent';

    return (
      <div
        className="w-full flex items-stretch gap-2 px-3 py-2 text-xs text-left transition-colors duration-75 select-none"
        style={{
          backgroundColor: bg,
          borderLeft: isSelected
            ? `2px solid ${colors.accent}`
            : '2px solid transparent',
        }}
        onMouseEnter={() => !isBase && setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex-1 min-w-0 flex items-start gap-2 outline-none focus:ring-1 focus:ring-blue-500/40 rounded"
          style={{ cursor: isBase ? 'default' : 'pointer' }}
          aria-label={`Select commit ${isUncommitted ? 'uncommitted changes' : shortHash}`}
        >
          <div
            className="mt-0.5"
            style={{
              color: isUncommitted ? colors.text.modified : colors.text.muted,
            }}
          >
            <GitCommit className="w-3.5 h-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span
                className="flex-1 min-w-0 truncate font-medium"
                style={{
                  color: isUncommitted
                    ? colors.text.modified
                    : isSelected || isHovered
                      ? colors.text.primary
                      : colors.text.secondary,
                }}
              >
                {isUncommitted ? '' : commit.commit_message}
              </span>
              {badge && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded lowercase"
                  style={{
                    backgroundColor: colors.bg.hover,
                    color: colors.text.muted,
                  }}
                  title={badge}
                >
                  {badge.toLowerCase()}
                </span>
              )}
            </div>
            <div
              className="flex items-center gap-2 mt-1 text-[10px]"
              style={{ color: colors.text.muted }}
            >
              {shortHash && <span className="font-mono">{shortHash}</span>}
              <span className="font-mono">{formatCommitTime(commit.timestamp)}</span>
              {!isBase && (
                <>
                  <span style={{ color: colors.text.added }}>
                    +{commit.stats_additions}
                  </span>
                  <span style={{ color: colors.text.deleted }}>
                    -{commit.stats_deletions}
                  </span>
                </>
              )}
            </div>
          </div>
        </button>
        {shortHash && (
          <button
            type="button"
            onClick={handleCopyHash}
            className="flex-shrink-0 self-start p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring"
            title="Copy commit hash"
          >
            <Copy className="w-3.5 h-3.5" style={{ color: colors.text.muted }} />
          </button>
        )}
      </div>
    );
  }
);

CommitItem.displayName = 'CommitItem';
