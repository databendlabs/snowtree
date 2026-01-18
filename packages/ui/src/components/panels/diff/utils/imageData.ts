const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

const SVG_XML_RE = /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i;

function getFileExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
}

export function getImageMimeType(filePath: string): string {
  const ext = getFileExtension(filePath);
  return IMAGE_MIME_TYPES[ext] || 'image/png';
}

function looksLikeSvgXml(content: string): boolean {
  return SVG_XML_RE.test(content);
}

export function buildImageDataUri(content: string, filePath: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) return trimmed;

  const mime = getImageMimeType(filePath);
  if (mime === 'image/svg+xml' && looksLikeSvgXml(trimmed)) {
    return `data:${mime};utf8,${encodeURIComponent(trimmed)}`;
  }

  const base64 = trimmed.replace(/\s+/g, '');
  return `data:${mime};base64,${base64}`;
}
