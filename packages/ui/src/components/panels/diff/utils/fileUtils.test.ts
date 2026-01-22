import { describe, it, expect } from 'vitest';
import { isImageFile, isMarkdownFile, isPreviewableFile, isBinaryFile } from './fileUtils';

describe('isMarkdownFile', () => {
  it('returns true for .md files', () => {
    expect(isMarkdownFile('README.md')).toBe(true);
    expect(isMarkdownFile('docs/guide.md')).toBe(true);
    expect(isMarkdownFile('/path/to/file.md')).toBe(true);
  });

  it('returns true for .mdx files', () => {
    expect(isMarkdownFile('component.mdx')).toBe(true);
    expect(isMarkdownFile('docs/page.mdx')).toBe(true);
  });

  it('returns true for .markdown files', () => {
    expect(isMarkdownFile('README.markdown')).toBe(true);
    expect(isMarkdownFile('docs/guide.markdown')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isMarkdownFile('README.MD')).toBe(true);
    expect(isMarkdownFile('file.Md')).toBe(true);
    expect(isMarkdownFile('file.MDX')).toBe(true);
    expect(isMarkdownFile('file.MARKDOWN')).toBe(true);
  });

  it('returns false for non-markdown files', () => {
    expect(isMarkdownFile('file.txt')).toBe(false);
    expect(isMarkdownFile('file.js')).toBe(false);
    expect(isMarkdownFile('file.ts')).toBe(false);
    expect(isMarkdownFile('file.html')).toBe(false);
    expect(isMarkdownFile('file.css')).toBe(false);
    expect(isMarkdownFile('file.json')).toBe(false);
  });

  it('returns false for files with md in the name but different extension', () => {
    expect(isMarkdownFile('markdown.txt')).toBe(false);
    expect(isMarkdownFile('readme.md.bak')).toBe(false);
    expect(isMarkdownFile('md-file.js')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMarkdownFile('')).toBe(false);
  });
});

describe('isImageFile', () => {
  it('returns true for common image extensions', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.svg')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('photo.bmp')).toBe(true);
    expect(isImageFile('photo.ico')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isImageFile('PHOTO.PNG')).toBe(true);
    expect(isImageFile('PHOTO.SvG')).toBe(true);
  });

  it('returns false for non-image files', () => {
    expect(isImageFile('README.md')).toBe(false);
    expect(isImageFile('file.txt')).toBe(false);
    expect(isImageFile('image.png.bak')).toBe(false);
  });
});

describe('isPreviewableFile', () => {
  it('returns true for markdown or image files', () => {
    expect(isPreviewableFile('README.md')).toBe(true);
    expect(isPreviewableFile('docs/page.mdx')).toBe(true);
    expect(isPreviewableFile('photo.png')).toBe(true);
  });

  it('returns false for non-previewable files', () => {
    expect(isPreviewableFile('file.ts')).toBe(false);
    expect(isPreviewableFile('notes.txt')).toBe(false);
  });
});

describe('isBinaryFile', () => {
  it('returns true for binary executables', () => {
    expect(isBinaryFile('app.exe')).toBe(true);
    expect(isBinaryFile('program.bin')).toBe(true);
    expect(isBinaryFile('library.dll')).toBe(true);
    expect(isBinaryFile('library.so')).toBe(true);
    expect(isBinaryFile('library.dylib')).toBe(true);
  });

  it('returns true for archives', () => {
    expect(isBinaryFile('archive.zip')).toBe(true);
    expect(isBinaryFile('archive.tar')).toBe(true);
    expect(isBinaryFile('archive.gz')).toBe(true);
    expect(isBinaryFile('archive.7z')).toBe(true);
    expect(isBinaryFile('archive.rar')).toBe(true);
  });

  it('returns true for compiled files', () => {
    expect(isBinaryFile('Main.class')).toBe(true);
    expect(isBinaryFile('app.jar')).toBe(true);
    expect(isBinaryFile('module.pyc')).toBe(true);
    expect(isBinaryFile('program.wasm')).toBe(true);
  });

  it('returns true for document files', () => {
    expect(isBinaryFile('document.pdf')).toBe(true);
    expect(isBinaryFile('document.doc')).toBe(true);
    expect(isBinaryFile('document.docx')).toBe(true);
    expect(isBinaryFile('spreadsheet.xls')).toBe(true);
    expect(isBinaryFile('spreadsheet.xlsx')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isBinaryFile('APP.EXE')).toBe(true);
    expect(isBinaryFile('Archive.ZIP')).toBe(true);
  });

  it('returns false for text files', () => {
    expect(isBinaryFile('file.txt')).toBe(false);
    expect(isBinaryFile('file.js')).toBe(false);
    expect(isBinaryFile('file.ts')).toBe(false);
    expect(isBinaryFile('README.md')).toBe(false);
  });

  it('returns false for image files', () => {
    expect(isBinaryFile('photo.png')).toBe(false);
    expect(isBinaryFile('photo.jpg')).toBe(false);
  });
});
