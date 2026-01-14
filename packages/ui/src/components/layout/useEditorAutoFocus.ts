import { useEffect } from 'react';
import type React from 'react';

interface UseEditorAutoFocusOptions {
  focusRequestId: number | undefined;
  acceptedImageTypes: readonly string[];
  emitSelectionChange: () => void;
  insertTextAtCursor: (text: string) => void;
  pasteFromNavigatorClipboard: () => Promise<void>;
  addImageAttachment: (file: File) => Promise<void>;
}

export function useEditorAutoFocus(
  editorRef: React.RefObject<HTMLDivElement | null>,
  {
    focusRequestId,
    acceptedImageTypes,
    emitSelectionChange,
    insertTextAtCursor,
    pasteFromNavigatorClipboard,
    addImageAttachment
  }: UseEditorAutoFocusOptions
): void {
  useEffect(() => {
    if (!focusRequestId) return;
    editorRef.current?.focus();
  }, [focusRequestId, editorRef]);

  useEffect(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  useEffect(() => {
    const focusEditor = () => {
      const editor = editorRef.current;
      if (!editor) return null;
      editor.focus();
      return editor;
    };

    const handleGlobalKeyPress = (e: KeyboardEvent) => {
      if (document.activeElement === editorRef.current) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const editor = focusEditor();
        if (!editor) return;
        try {
          const selection = window.getSelection();
          if (!selection) return;
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges();
          selection.addRange(range);
          emitSelectionChange();
        } catch {
          // best-effort
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        if (!focusEditor()) return;
        setTimeout(async () => {
          await pasteFromNavigatorClipboard();
        }, 0);
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const editor = focusEditor();
        if (!editor) return;

        setTimeout(() => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) {
            return;
          }

          const range = selection.getRangeAt(0);
          if (!editor.contains(range.startContainer)) {
            return;
          }

          if (!range.collapsed) {
            range.deleteContents();
          } else if (e.key === 'Backspace') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startOffset > 0 && startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              textNode.deleteData(startOffset - 1, 1);
              range.setStart(textNode, startOffset - 1);
              range.collapse(true);
            }
          } else if (e.key === 'Delete') {
            const startContainer = range.startContainer;
            const startOffset = range.startOffset;

            if (startContainer.nodeType === Node.TEXT_NODE) {
              const textNode = startContainer as Text;
              if (startOffset < textNode.length) {
                textNode.deleteData(startOffset, 1);
              }
            }
          }

          selection.removeAllRanges();
          selection.addRange(range);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }, 0);
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const skipKeys = [
        'Escape', 'Tab', 'Enter',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
      ];
      if (skipKeys.includes(e.key)) return;

      e.preventDefault();
      if (!focusEditor()) return;
      setTimeout(() => {
        insertTextAtCursor(e.key);
      }, 0);
    };

    const handleGlobalPasteCapture = (e: ClipboardEvent) => {
      if (document.activeElement === editorRef.current) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      e.preventDefault();
      const editor = focusEditor();
      if (!editor) return;

      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      setTimeout(async () => {
        const items = Array.from(clipboardData.items);
        const imageItems = items.filter((item) => acceptedImageTypes.includes(item.type));

        if (imageItems.length > 0) {
          for (const item of imageItems) {
            const file = item.getAsFile();
            if (file) await addImageAttachment(file);
          }
        }

        if (clipboardData.types.includes('text/plain')) {
          const text = clipboardData.getData('text/plain');
          if (text) insertTextAtCursor(text);
        }
      }, 0);
    };

    document.addEventListener('keydown', handleGlobalKeyPress, { capture: true });
    document.addEventListener('paste', handleGlobalPasteCapture, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyPress, { capture: true });
      document.removeEventListener('paste', handleGlobalPasteCapture, { capture: true });
    };
  }, [
    editorRef,
    acceptedImageTypes,
    emitSelectionChange,
    insertTextAtCursor,
    pasteFromNavigatorClipboard,
    addImageAttachment
  ]);
}
