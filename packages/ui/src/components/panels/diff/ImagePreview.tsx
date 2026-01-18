import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { buildImageDataUri } from './utils/imageData';

export interface ImagePreviewProps {
  content: string;
  filePath: string;
  className?: string;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const SCALE_STEP = 0.2;

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

export function ImagePreview({ content, filePath, className }: ImagePreviewProps) {
  const src = useMemo(() => {
    return buildImageDataUri(content, filePath);
  }, [content, filePath]);

  const [scale, setScale] = useState(1);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setScale(1);
    setBaseSize(null);
  }, [src]);

  const handleLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setBaseSize({ width: rect.width, height: rect.height });
  };

  const zoomIn = () => setScale((prev) => clampScale(prev + SCALE_STEP));
  const zoomOut = () => setScale((prev) => clampScale(prev - SCALE_STEP));
  const resetZoom = () => setScale(1);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
    setScale((prev) => clampScale(prev + delta));
  };

  const displaySize = baseSize
    ? {
        width: Math.max(1, Math.round(baseSize.width * scale)),
        height: Math.max(1, Math.round(baseSize.height * scale)),
      }
    : undefined;
  const canZoomIn = scale < MAX_SCALE - 0.001;
  const canZoomOut = scale > MIN_SCALE + 0.001;
  const canReset = Math.abs(scale - 1) > 0.001;

  if (!src) {
    return (
      <div className={`flex items-center justify-center p-4 min-h-[100px] bg-[var(--st-surface)] border-b border-[var(--st-border-variant)] ${className || ''}`}>
        <div className="text-xs text-[var(--st-text-faint)]">Image preview unavailable</div>
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-center p-4 min-h-[100px] bg-[var(--st-surface)] border-b border-[var(--st-border-variant)] ${className || ''}`}>
      <div className="relative border border-[var(--st-border-variant)] bg-[var(--st-bg)] rounded overflow-hidden" 
        style={{ 
          backgroundImage: 'conic-gradient(#80808033 90deg, transparent 90deg 180deg, #80808033 180deg 270deg, transparent 270deg)',
          backgroundSize: '20px 20px',
          backgroundPosition: 'center'
        }}>
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--st-border-variant)] bg-[var(--st-surface)]/90 px-1.5 py-1 text-[10px] text-[var(--st-text-faint)] backdrop-blur">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--st-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={zoomOut}
            disabled={!canZoomOut}
            title="Zoom out"
          >
            <Minus size={12} />
          </button>
          <span className="min-w-[42px] text-center">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--st-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={zoomIn}
            disabled={!canZoomIn}
            title="Zoom in"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--st-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={resetZoom}
            disabled={!canReset}
            title="Reset zoom"
          >
            <RotateCcw size={12} />
          </button>
        </div>
        <div
          className="flex max-h-[600px] max-w-full items-center justify-center overflow-auto p-2"
          onWheel={handleWheel}
        >
          <img
            ref={imgRef}
            src={src}
            alt={filePath}
            onLoad={handleLoad}
            style={displaySize}
            className="block max-w-full max-h-[600px] object-contain"
          />
        </div>
      </div>
    </div>
  );
}
