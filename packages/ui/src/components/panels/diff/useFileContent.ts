import { useState, useEffect } from 'react';
import { API } from '../../../utils/api';

interface UseFileContentOptions {
  sessionId?: string;
  filePath?: string;
  worktreePath?: string;
  ref?: string;
  maxBytes?: number;
  enabled?: boolean;
}

interface UseFileContentResult {
  content: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * Hook to load file content from the file system.
 * Used by InlineDiffViewer for markdown/image preview.
 */
export function useFileContent({
  sessionId,
  filePath,
  ref = 'WORKTREE',
  maxBytes = 1024 * 1024,
  enabled = true,
}: UseFileContentOptions): UseFileContentResult {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled || !sessionId || !filePath) {
      setContent(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);

    API.sessions.getFileContent(sessionId, {
      filePath,
      ref,
      maxBytes,
    }).then((response) => {
      if (cancelled) return;
      if (response.success && response.data?.content) {
        setContent(response.data.content);
        setError(false);
      } else {
        setContent(null);
        setError(true);
      }
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setContent(null);
      setError(true);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, filePath, ref, maxBytes]);

  return { content, loading, error };
}
