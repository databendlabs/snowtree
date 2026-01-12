import React, { useState, useCallback } from 'react';
import { GitCommit, Copy } from 'lucide-react';
import { colors } from './constants';
import { formatCommitHoverTitle, formatCommitTime } from './utils';
import type { CommitItemProps } from './types';

export const CommitItem: React.FC<CommitItemProps> = React.memo(
  ({ commit, isSelected, badge, onClick, isClickable }) => {
    const [isHovered, setIsHovered] = useState(false);
    const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
    const isUncommitted = commit.id === 0;
    const isBase = commit.id === -1;
    const shortHash = isUncommitted ? '' : commit.after_commit_hash.substring(0, 7);
    const hoverTitle = formatCommitHoverTitle(commit);

    // Base commits are clickable if isClickable is true, otherwise not hoverable
    const canHover = !isBase || isClickable;
    const cursorStyle = isBase ? (isClickable ? 'pointer' : 'default') : 'pointer';

    const handleMouseEnter = useCallback((e: React.MouseEvent) => {
      if (!canHover) return;
      setIsHovered(true);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTooltipPos({ top: rect.bottom + 4, left: rect.left });
    }, [canHover]);

    const handleMouseLeave = useCallback(() => {
      setIsHovered(false);
      setTooltipPos(null);
    }, []);

    const handleCopyHash = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (commit.after_commit_hash) {
          await navigator.clipboard.writeText(commit.after_commit_hash).catch(() => {});
        }
      },
      [commit.after_commit_hash]
    );

    const bg = (() => {
      if (isSelected) return colors.bg.selected;
      if (isHovered && canHover) return colors.bg.hover;
      return 'transparent';
    })();

    return (
      <div
        className="w-full flex items-stretch gap-2 px-3 py-2 text-xs text-left transition-colors duration-75 select-none"
        style={{
          backgroundColor: bg,
          borderLeft: isSelected
            ? `2px solid ${colors.accent}`
            : '2px solid transparent',
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex-1 min-w-0 flex items-start gap-2 outline-none focus:ring-1 focus:ring-blue-500/40 rounded"
          style={{ cursor: cursorStyle }}
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
                className="flex-1 min-w-0 truncate font-medium text-left"
                style={{
                  color: (() => {
                    if (isUncommitted) return colors.text.modified;
                    if (isSelected || isHovered) return colors.text.primary;
                    return colors.text.secondary;
                  })(),
                }}
              >
                {isUncommitted ? 'Uncommitted Changes' : commit.commit_message}
              </span>
              {badge && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded lowercase"
                  style={{
                    backgroundColor: colors.bg.hover,
                    color: colors.text.muted,
                  }}
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
        {shortHash && !isBase && (
          <button
            type="button"
            onClick={handleCopyHash}
            className="flex-shrink-0 self-start p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring"
          >
            <Copy className="w-3.5 h-3.5" style={{ color: colors.text.muted }} />
          </button>
        )}
        {isHovered && tooltipPos && hoverTitle && (
          <div
            className="fixed z-50 px-2 py-1 text-[11px] rounded shadow-lg whitespace-pre-wrap max-w-xs"
            style={{
              top: tooltipPos.top,
              left: tooltipPos.left,
              backgroundColor: colors.bg.secondary,
              color: colors.text.primary,
              border: `1px solid ${colors.border}`,
            }}
          >
            {hoverTitle}
          </div>
        )}
      </div>
    );
  }
);

CommitItem.displayName = 'CommitItem';
