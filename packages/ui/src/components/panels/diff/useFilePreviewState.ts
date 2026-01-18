import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_PREVIEW_ENABLED = true;

export function useFilePreviewState(previewableFilePaths: string[], options?: { defaultPreview?: boolean }) {
  const [previewFiles, setPreviewFiles] = useState<Set<string>>(() => new Set());
  const autoEnabledRef = useRef<Set<string>>(new Set());
  const defaultPreview = options?.defaultPreview ?? DEFAULT_PREVIEW_ENABLED;

  useEffect(() => {
    if (!defaultPreview) return;
    if (!previewableFilePaths || previewableFilePaths.length === 0) return;

    setPreviewFiles((prev) => {
      let changed = false;
      let next = prev;
      for (const path of previewableFilePaths) {
        if (!path) continue;
        if (autoEnabledRef.current.has(path)) continue;
        autoEnabledRef.current.add(path);
        if (!next.has(path)) {
          if (!changed) next = new Set(prev);
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [defaultPreview, previewableFilePaths]);

  const togglePreview = useCallback((path: string) => {
    setPreviewFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return { previewFiles, togglePreview };
}
