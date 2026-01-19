import React, { useCallback, useState } from 'react';
import { Check, X, Loader2, Clock, Circle, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import type { CICheck, CheckStatus, CheckConclusion } from '../types';

interface CIStatusDetailsProps {
  checks: CICheck[];
  onCheckClick?: (check: CICheck) => void;
}

function getCheckIcon(
  status: CheckStatus,
  conclusion: CheckConclusion
): { icon: React.ElementType; color: string; animate?: boolean } {
  if (status === 'in_progress') {
    return { icon: Loader2, color: 'var(--st-accent)', animate: true };
  }
  if (status === 'queued') {
    return { icon: Clock, color: 'var(--st-text-muted)' };
  }

  // Completed - check conclusion
  switch (conclusion) {
    case 'success':
      return { icon: Check, color: 'var(--st-success)' };
    case 'failure':
    case 'timed_out':
    case 'cancelled':
      return { icon: X, color: 'var(--st-danger)' };
    case 'skipped':
    case 'neutral':
    default:
      return { icon: Circle, color: 'var(--st-text-muted)' };
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function getStatusLabel(status: CheckStatus, conclusion: CheckConclusion): string {
  if (status === 'in_progress') return 'running';
  if (status === 'queued') return 'pending';
  return conclusion || 'completed';
}

function getCheckCategory(status: CheckStatus, conclusion: CheckConclusion): 'failed' | 'pending' | 'success' {
  if (status === 'completed') {
    if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') {
      return 'failed';
    }
    return 'success';
  }
  return 'pending';
}

function sortChecks(checks: CICheck[]): CICheck[] {
  return [...checks].sort((a, b) => {
    const categoryA = getCheckCategory(a.status, a.conclusion);
    const categoryB = getCheckCategory(b.status, b.conclusion);

    const categoryOrder = { failed: 0, pending: 1, success: 2 };
    return categoryOrder[categoryA] - categoryOrder[categoryB];
  });
}

interface CheckGroupProps {
  title: string;
  checks: CICheck[];
  onCheckClick?: (check: CICheck) => void;
  collapsed: boolean;
  onToggle: () => void;
}

const CheckGroup: React.FC<CheckGroupProps> = ({ title, checks, onCheckClick, collapsed, onToggle }) => {
  const handleCheckClick = useCallback(
    (check: CICheck) => {
      if (onCheckClick && check.detailsUrl) {
        onCheckClick(check);
      }
    },
    [onCheckClick]
  );

  if (checks.length === 0) return null;

  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold st-hoverable transition-all duration-75"
        style={{
          borderBottom: '1px solid var(--st-border-variant)',
          color: 'var(--st-text-muted)',
        }}
      >
        <ChevronIcon className="w-3 h-3 flex-shrink-0" strokeWidth={2.5} />
        <span>{title} ({checks.length})</span>
      </button>
      {!collapsed && checks.map((check) => {
        const { icon: Icon, color, animate } = getCheckIcon(
          check.status,
          check.conclusion
        );
        const hasLink = Boolean(check.detailsUrl);
        const timeStr = formatRelativeTime(check.completedAt || check.startedAt);
        const statusLabel = getStatusLabel(check.status, check.conclusion);

        return (
          <button
            key={check.id}
            type="button"
            onClick={() => handleCheckClick(check)}
            disabled={!hasLink}
            className={`w-full flex items-center justify-between px-2 py-1.5 text-[10px] transition-all duration-75 ${
              hasLink ? 'st-hoverable cursor-pointer' : 'cursor-default'
            }`}
            style={{
              borderBottom: '1px solid var(--st-border-variant)',
            }}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Icon
                className={`w-3 h-3 flex-shrink-0 ${animate ? 'animate-spin' : ''}`}
                style={{ color }}
                strokeWidth={2.5}
              />
              <span
                className="truncate"
                style={{ color: 'var(--st-text)' }}
                title={check.workflow ? `${check.workflow} / ${check.name}` : check.name}
              >
                {check.workflow ? `${check.workflow} / ${check.name}` : check.name}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-2">
              <span style={{ color: 'var(--st-text-muted)' }}>{statusLabel}</span>
              {timeStr && (
                <span style={{ color: 'var(--st-text-faint)' }}>{timeStr}</span>
              )}
              {hasLink && (
                <ExternalLink
                  className="w-3 h-3"
                  style={{ color: 'var(--st-text-faint)' }}
                />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
};

export const CIStatusDetails: React.FC<CIStatusDetailsProps> = ({
  checks,
  onCheckClick,
}) => {
  const [successCollapsed, setSuccessCollapsed] = useState(true);

  if (checks.length === 0) {
    return (
      <div
        className="text-[10px] px-2 py-1.5"
        style={{ color: 'var(--st-text-muted)' }}
      >
        No checks
      </div>
    );
  }

  const sortedChecks = sortChecks(checks);
  const failedChecks = sortedChecks.filter(c => getCheckCategory(c.status, c.conclusion) === 'failed');
  const pendingChecks = sortedChecks.filter(c => getCheckCategory(c.status, c.conclusion) === 'pending');
  const successChecks = sortedChecks.filter(c => getCheckCategory(c.status, c.conclusion) === 'success');

  return (
    <div
      className="rounded overflow-hidden"
      style={{
        backgroundColor: 'var(--st-hover)',
        border: '1px solid var(--st-border-variant)',
      }}
    >
      <CheckGroup
        title="Failed"
        checks={failedChecks}
        onCheckClick={onCheckClick}
        collapsed={false}
        onToggle={() => {}}
      />
      <CheckGroup
        title="Pending"
        checks={pendingChecks}
        onCheckClick={onCheckClick}
        collapsed={false}
        onToggle={() => {}}
      />
      <CheckGroup
        title="Success"
        checks={successChecks}
        onCheckClick={onCheckClick}
        collapsed={successCollapsed}
        onToggle={() => setSuccessCollapsed(!successCollapsed)}
      />
    </div>
  );
};
