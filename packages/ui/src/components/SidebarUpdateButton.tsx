import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { MarkdownPreview } from './panels/diff/MarkdownPreview';

type SidebarUpdateButtonProps = {
  version: string;
  releaseNotes: string;
  isDownloading: boolean;
  isDownloaded: boolean;
  isInstalling: boolean;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
};

export function SidebarUpdateButton({
  version,
  releaseNotes,
  isDownloading,
  isDownloaded,
  isInstalling,
  onDownload,
  onInstall,
}: SidebarUpdateButtonProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const tooltipContent = releaseNotes.trim();

  const handleClick = useCallback(() => {
    if (isDownloaded) {
      void onInstall();
    } else {
      void onDownload();
    }
  }, [isDownloaded, onDownload, onInstall]);

  const handleMouseEnter = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (!tooltipContent) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setIsHovered(true);
    setTooltipPos({ top: rect.top - 8, left: rect.left });
  }, [tooltipContent]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    setTooltipPos(null);
  }, []);

  const isDisabled = isDownloaded ? isInstalling : isDownloading;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        disabled={isDisabled}
        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors st-hoverable st-focus-ring disabled:opacity-50"
        style={{ color: 'var(--st-accent)' }}
      >
        {isDownloaded ? (
          isInstalling ? <RotateCw className="w-3 h-3 animate-spin" /> : null
        ) : isDownloading ? (
          <RotateCw className="w-3 h-3 animate-spin" />
        ) : (
          <Download className="w-3 h-3" />
        )}
        {isDownloaded
          ? (version ? `Restart v${version}` : 'Restart')
          : (version ? `Update v${version}` : 'Update')}
      </button>
      {isHovered && tooltipPos && tooltipContent && (
        <div
          className="fixed z-50 px-2.5 py-2 rounded shadow-lg max-w-sm text-[11px]"
          style={{
            top: tooltipPos.top,
            left: tooltipPos.left,
            transform: 'translateY(-100%)',
            backgroundColor: 'var(--st-surface)',
            color: 'var(--st-text)',
            border: '1px solid var(--st-border-variant)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          <div className="text-[10px] font-mono uppercase tracking-wide mb-1" style={{ color: 'var(--st-text-faint)' }}>
            {version ? `Changelog v${version}` : 'Changelog'}
          </div>
          <MarkdownPreview content={tooltipContent} />
        </div>
      )}
    </>
  );
}
