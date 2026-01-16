import { useMemo, useState } from 'react';
import { Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react';
import './InlineDiffViewer.css';
import { MarkdownPreview } from '../diff/MarkdownPreview';
import { isMarkdownFile } from '../diff/utils/fileUtils';

export interface InlineDiffViewerProps {
  oldString: string;
  newString: string;
  filePath?: string;
  className?: string;
}

interface DiffLine {
  type: 'context' | 'delete' | 'insert';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Simple diff algorithm that generates line-by-line diff
 * Similar to how Claude Code CLI displays file edits
 */
function generateDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  // Use a simple LCS-based diff algorithm
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const match of lcs) {
    // Add deletions (lines in old but not in LCS)
    while (oldIdx < match.oldIndex) {
      result.push({
        type: 'delete',
        content: oldLines[oldIdx],
        oldLineNumber: oldLineNum++,
      });
      oldIdx++;
    }

    // Add insertions (lines in new but not in LCS)
    while (newIdx < match.newIndex) {
      result.push({
        type: 'insert',
        content: newLines[newIdx],
        newLineNumber: newLineNum++,
      });
      newIdx++;
    }

    // Add context line (matching line)
    result.push({
      type: 'context',
      content: oldLines[oldIdx],
      oldLineNumber: oldLineNum++,
      newLineNumber: newLineNum++,
    });
    oldIdx++;
    newIdx++;
  }

  // Add remaining deletions
  while (oldIdx < oldLines.length) {
    result.push({
      type: 'delete',
      content: oldLines[oldIdx],
      oldLineNumber: oldLineNum++,
    });
    oldIdx++;
  }

  // Add remaining insertions
  while (newIdx < newLines.length) {
    result.push({
      type: 'insert',
      content: newLines[newIdx],
      newLineNumber: newLineNum++,
    });
    newIdx++;
  }

  return result;
}

interface LCSMatch {
  oldIndex: number;
  newIndex: number;
}

/**
 * Compute Longest Common Subsequence for line-based diff
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Count added and removed lines
 */
function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'insert') added++;
    else if (line.type === 'delete') removed++;
  }
  return { added, removed };
}

export function InlineDiffViewer({
  oldString,
  newString,
  filePath,
  className,
}: InlineDiffViewerProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const isMarkdown = useMemo(() => isMarkdownFile(filePath || ''), [filePath]);

  const diffLines = useMemo(() => {
    return generateDiff(oldString, newString);
  }, [oldString, newString]);

  const { added, removed } = useMemo(() => countChanges(diffLines), [diffLines]);

  // Calculate the width needed for line numbers
  const maxLineNum = Math.max(
    ...diffLines.map(l => Math.max(l.oldLineNumber || 0, l.newLineNumber || 0))
  );
  const lineNumWidth = String(maxLineNum).length;

  return (
    <div className={`inline-diff-viewer ${className || ''}`}>
      {filePath && (
        <div className="diff-header" style={{ cursor: 'pointer' }} onClick={() => setIsExpanded(!isExpanded)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {isExpanded ? (
              <ChevronDown size={14} style={{ flexShrink: 0 }} />
            ) : (
              <ChevronRight size={14} style={{ flexShrink: 0 }} />
            )}
            <span className="diff-file-path">{filePath}</span>
          </div>
          <div className="diff-header-actions" onClick={(e) => e.stopPropagation()}>
            {isMarkdown && (
              <button
                type="button"
                className="diff-preview-btn"
                onClick={() => setShowPreview(!showPreview)}
                title={showPreview ? 'Show Diff' : 'Preview'}
              >
                {showPreview ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
            <span className="diff-stats">
              <span className="diff-stats-added">+{added}</span>
              <span className="diff-stats-removed">-{removed}</span>
            </span>
          </div>
        </div>
      )}
      <div className={`diff-content-wrapper ${isExpanded ? 'expanded' : 'collapsed'}`}>
        {showPreview && isMarkdown ? (
          <MarkdownPreview content={newString} className="inline-diff-preview" />
        ) : (
          <div className="diff-content">
            {diffLines.map((line, idx) => (
              <div key={idx} className={`diff-line diff-line-${line.type}`}>
                <span
                  className="diff-line-number"
                  style={{ minWidth: `${lineNumWidth + 1}ch` }}
                >
                  {line.type === 'delete'
                    ? line.oldLineNumber
                    : line.type === 'insert'
                    ? line.newLineNumber
                    : line.newLineNumber}
                </span>
                <span className="diff-line-sign">
                  {line.type === 'delete' ? '-' : line.type === 'insert' ? '+' : ' '}
                </span>
                <span className="diff-line-content">{line.content || ' '}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default InlineDiffViewer;
