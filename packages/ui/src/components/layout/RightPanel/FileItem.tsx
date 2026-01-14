import React, { useState } from 'react';
import { colors } from './constants';
import { getTypeInfo } from './utils';
import type { FileItemProps } from './types';

export const FileItem: React.FC<FileItemProps> = React.memo(
  ({ file, onClick, isSelected, hideStats, hunkText, testId }) => {
    const [isHovered, setIsHovered] = useState(false);
    const typeInfo = getTypeInfo(file.type);
    const bg = isSelected
      ? colors.bg.selected
      : isHovered
        ? colors.bg.hover
        : 'transparent';

    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="w-full flex items-center justify-start gap-2 px-3 py-1.5 text-xs transition-colors duration-75"
        style={{
          backgroundColor: bg,
          borderLeft: isSelected
            ? `2px solid ${colors.accent}`
            : '2px solid transparent',
        }}
      >
        <span
          className="font-mono text-[10px] font-semibold px-1 rounded flex-shrink-0"
          style={{ color: typeInfo.color, backgroundColor: typeInfo.bg }}
        >
          {typeInfo.label}
        </span>
        <span
          className="truncate min-w-0 flex-1 text-left"
          style={{
            color:
              isSelected || isHovered
                ? colors.text.primary
                : colors.text.secondary,
          }}
        >
          {file.path}
        </span>
        {!hideStats && (
          <div className="flex items-center gap-1.5 text-[10px] flex-shrink-0 font-mono">
            {file.additions > 0 && (
              <span style={{ color: colors.text.added }}>+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span style={{ color: colors.text.deleted }}>-{file.deletions}</span>
            )}
            {hunkText && (
              <span
                className="whitespace-nowrap"
                style={{ color: colors.text.muted }}
                title="Hunks"
              >
                {hunkText}
              </span>
            )}
          </div>
        )}
      </button>
    );
  }
);

FileItem.displayName = 'FileItem';
