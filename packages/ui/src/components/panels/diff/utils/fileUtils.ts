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

/**
 * Check if a file is likely a binary file based on its extension
 */
export function isBinaryFile(filePath: string): boolean {
  return /\.(exe|bin|dll|so|dylib|a|o|obj|zip|tar|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|class|jar|war|ear|pyc|wasm|ttf|otf|woff|woff2|eot)$/i.test(filePath);
}

/**
 * Check if a file supports preview rendering.
 */
export function isPreviewableFile(filePath: string): boolean {
  return isMarkdownFile(filePath) || isImageFile(filePath);
}
