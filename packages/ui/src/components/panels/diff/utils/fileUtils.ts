/**
 * Check if a file is a Markdown file based on its extension
 */
export function isMarkdownFile(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}

/**
 * Check if a file is an image file based on its extension
 */
export function isImageFile(filePath: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(filePath);
}
