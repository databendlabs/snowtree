import { useMemo } from 'react';

export interface ImagePreviewProps {
  content: string;
  filePath: string;
  className?: string;
}

export function ImagePreview({ content, filePath, className }: ImagePreviewProps) {
  const isSvg = /\.svg$/i.test(filePath);

  const src = useMemo(() => {
    // If we assume the backend returns base64 for all images (including SVG),
    // we just need to detect mime type.
    if (content.startsWith('data:')) {
        return content;
    }

    const ext = filePath.split('.').pop()?.toLowerCase();
    let mime = 'image/png'; // default
    if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
    else if (ext === 'gif') mime = 'image/gif';
    else if (ext === 'webp') mime = 'image/webp';
    else if (ext === 'bmp') mime = 'image/bmp';
    else if (ext === 'ico') mime = 'image/x-icon';
    else if (ext === 'svg') mime = 'image/svg+xml';

    // If it's SVG and not base64 encoded (legacy backend or unexpected), it might be raw xml.
    // But our updated backend returns base64 for isImageFile matches.
    // We should be safe to prepend data uri scheme.
    return `data:${mime};base64,${content}`;
  }, [content, filePath]);

  return (
    <div className={`flex items-center justify-center p-4 min-h-[100px] bg-[var(--st-surface)] border-b border-[var(--st-border-variant)] ${className || ''}`}>
      <div className="relative border border-[var(--st-border-variant)] bg-[var(--st-bg)] rounded overflow-hidden" 
        style={{ 
          backgroundImage: 'conic-gradient(#80808033 90deg, transparent 90deg 180deg, #80808033 180deg 270deg, transparent 270deg)',
          backgroundSize: '20px 20px',
          backgroundPosition: 'center'
        }}>
        <img src={src} alt={filePath} className="max-w-full max-h-[600px] object-contain block" />
      </div>
    </div>
  );
}
