import { useMemo } from 'react';
import { buildImageDataUri } from './utils/imageData';

export interface ImagePreviewProps {
  content: string;
  filePath: string;
  className?: string;
}

export function ImagePreview({ content, filePath, className }: ImagePreviewProps) {
  const src = useMemo(() => {
    return buildImageDataUri(content, filePath);
  }, [content, filePath]);

  if (!src) {
    return (
      <div className={`flex items-center justify-center p-4 min-h-[100px] bg-[var(--st-surface)] border-b border-[var(--st-border-variant)] ${className || ''}`}>
        <div className="text-xs text-[var(--st-text-faint)]">Image preview unavailable</div>
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-center p-4 min-h-[100px] bg-[var(--st-surface)] border-b border-[var(--st-border-variant)] ${className || ''}`}>
      <div
        className="border border-[var(--st-border-variant)] bg-[var(--st-bg)] rounded overflow-hidden"
        style={{
          backgroundImage: 'conic-gradient(#80808033 90deg, transparent 90deg 180deg, #80808033 180deg 270deg, transparent 270deg)',
          backgroundSize: '20px 20px',
          backgroundPosition: 'center'
        }}
      >
        <div
          className="flex max-h-[600px] max-w-full items-center justify-center overflow-auto p-2"
        >
          <img
            src={src}
            alt={filePath}
            className="block max-w-full max-h-[600px] object-contain"
          />
        </div>
      </div>
    </div>
  );
}
