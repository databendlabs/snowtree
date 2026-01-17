import { useEffect, useImperativeHandle, forwardRef } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { ImagePill } from './extensions/ImagePill';
import { TerminalShortcuts } from './extensions/TerminalShortcuts';
import { InputHistory } from './extensions/InputHistory';
import { PasteImage } from './extensions/PasteImage';
import { BlockCaret } from './extensions/BlockCaret';
import type { ImageAttachment } from './types';

export interface InputBarEditorProps {
  placeholder?: string;
  isRunning?: boolean;
  onUpdate?: (text: string) => void;
  onSubmit?: () => void;
  inputHistory: React.MutableRefObject<string[]>;
  onFocus?: () => void;
  onBlur?: () => void;
  onImagePaste?: (file: File) => void | Promise<void>;
}

export interface InputBarEditorHandle {
  editor: Editor | null;
  focus: () => void;
  getText: () => string;
  getJSON: () => any;
  setContent: (content: any) => void;
  clear: () => void;
  insertText: (text: string) => void;
  insertImagePill: (image: ImageAttachment, index: number) => void;
}

/**
 * InputBarEditor component
 * Wraps Tiptap editor with custom extensions for terminal shortcuts,
 * input history, and image pills
 */
export const InputBarEditor = forwardRef<InputBarEditorHandle, InputBarEditorProps>(
  (
    {
      placeholder = 'Ask Snowtree to edit...',
      isRunning = false,
      onUpdate,
      onSubmit,
      inputHistory,
      onFocus,
      onBlur,
      onImagePaste,
    },
    ref
  ) => {
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Disable default history (we use our own)
          history: false,
          // Disable default keyboard shortcuts that might interfere
          gapcursor: false,
          dropcursor: false,
          // Keep only essential marks
          bold: false,
          italic: false,
          code: false,
          strike: false,
          // Keep document structure simple
          heading: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          listItem: false,
          bulletList: false,
          orderedList: false,
        }),
        Placeholder.configure({
          placeholder,
        }),
        ImagePill,
        BlockCaret,
        TerminalShortcuts,
        InputHistory.configure({
          getHistory: () => inputHistory.current,
        }),
        PasteImage.configure({
          onImagePaste,
        }),
      ],
      editorProps: {
        attributes: {
          class: 'tiptap-editor',
          'data-testid': 'input-editor',
          style: `
            outline: none;
            min-height: 20px;
            max-height: 144px;
            overflow-y: auto;
            color: ${isRunning ? 'var(--st-text-faint)' : 'var(--st-text)'};
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: var(--st-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace);
            font-size: var(--st-font-base, 13px);
            font-weight: 400;
          `,
        },
      },
      editable: !isRunning,
      autofocus: 'end',
      content: '',
      onUpdate: ({ editor }) => {
        if (onUpdate) {
          onUpdate(editor.getText());
        }
      },
      onFocus,
      onBlur,
    });

    // Expose editor methods via ref
    useImperativeHandle(ref, () => ({
      editor,
      focus: () => editor?.commands.focus(),
      getText: () => {
        if (!editor) return '';
        // Custom getText that includes ImagePill nodes as [img1], [img2], etc.
        let text = '';
        editor.state.doc.descendants((node) => {
          if (node.isText) {
            text += node.text;
          } else if (node.type.name === 'imagePill') {
            const index = node.attrs.index || 1;
            text += `[img${index}]`;
          } else if (node.type.name === 'paragraph' || node.type.name === 'hardBreak') {
            // Only add newline if we have content and this isn't the first paragraph
            if (text.length > 0 && !text.endsWith('\n')) {
              text += '\n';
            }
          }
          return true;
        });
        return text;
      },
      getJSON: () => editor?.getJSON() || null,
      setContent: (content: any) => editor?.commands.setContent(content),
      clear: () => editor?.commands.clearContent(),
      insertText: (text: string) => {
        editor?.commands.insertContent(text);
      },
      insertImagePill: (image: ImageAttachment, index: number) => {
        editor?.commands.insertImagePill({
          id: image.id,
          index,
          filename: image.filename,
        });
      },
    }));

    // Handle Enter key for submission
    useEffect(() => {
      if (!editor) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey && !isRunning) {
          event.preventDefault();
          if (onSubmit) {
            onSubmit();
          }
        }
      };

      const editorElement = editor.view.dom;
      editorElement.addEventListener('keydown', handleKeyDown);

      return () => {
        editorElement.removeEventListener('keydown', handleKeyDown);
      };
    }, [editor, onSubmit, isRunning]);

    useEffect(() => {
      if (!editor) return;

      const handleCopy = () => {
        requestAnimationFrame(() => {
          editor.commands.focus('end');
        });
      };

      const editorElement = editor.view.dom;
      editorElement.addEventListener('copy', handleCopy);

      return () => {
        editorElement.removeEventListener('copy', handleCopy);
      };
    }, [editor]);

    // Update editability when running state changes
    useEffect(() => {
      if (editor) {
        editor.setEditable(!isRunning);
      }
    }, [editor, isRunning]);

    return <EditorContent editor={editor} />;
  }
);

InputBarEditor.displayName = 'InputBarEditor';
