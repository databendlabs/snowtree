import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface BlockCaretState {
  isFocused: boolean;
  isComposing: boolean;
}

const BlockCaretPluginKey = new PluginKey<BlockCaretState>('blockCaret');

type TextSearchDirection = 'forward' | 'backward';

const findTextNode = (node: Node, direction: TextSearchDirection): Text | null => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const children = Array.from(node.childNodes);
  if (direction === 'forward') {
    for (const child of children) {
      const found = findTextNode(child, direction);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (let i = children.length - 1; i >= 0; i -= 1) {
    const found = findTextNode(children[i], direction);
    if (found) {
      return found;
    }
  }

  return null;
};

const findNextTextNode = (node: Node, root: Node): Text | null => {
  let current: Node | null = node;

  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) {
      return null;
    }

    const siblings = Array.from(parent.childNodes) as Node[];
    const startIndex = siblings.indexOf(current);
    for (let i = startIndex + 1; i < siblings.length; i += 1) {
      const found = findTextNode(siblings[i], 'forward');
      if (found) {
        return found;
      }
    }

    current = parent;
  }

  return null;
};

const createRangeFromTextNode = (textNode: Text, startOffset: number): Range | null => {
  const length = textNode.textContent?.length ?? 0;
  if (length === 0 || startOffset < 0 || startOffset >= length) {
    return null;
  }

  const range = document.createRange();
  range.setStart(textNode, startOffset);
  range.setEnd(textNode, startOffset + 1);
  return range;
};

const getNextCharRange = (node: Node, offset: number, root: Node): Range | null => {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const length = textNode.textContent?.length ?? 0;
    if (offset < length) {
      return createRangeFromTextNode(textNode, offset);
    }

    const nextText = findNextTextNode(textNode, root);
    return nextText ? createRangeFromTextNode(nextText, 0) : null;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    const nextText = findNextTextNode(node, root);
    return nextText ? createRangeFromTextNode(nextText, 0) : null;
  }

  const element = node as Element;
  for (let i = offset; i < element.childNodes.length; i += 1) {
    const found = findTextNode(element.childNodes[i], 'forward');
    if (found) {
      return createRangeFromTextNode(found, 0);
    }
  }

  const nextText = findNextTextNode(element, root);
  return nextText ? createRangeFromTextNode(nextText, 0) : null;
};

const measureCaretWidth = (
  view: { dom: HTMLElement; domAtPos: (pos: number) => { node: Node; offset: number } },
  pos: number
) => {
  const domAtPos = view.domAtPos(pos);
  const range = getNextCharRange(domAtPos.node, domAtPos.offset, view.dom);
  if (!range) {
    return null;
  }

  const rect = range.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || rect.width <= 0) {
    return null;
  }

  return rect.width;
};

/**
 * BlockCaret extension for Tiptap
 * Renders a block-style caret using a decoration widget.
 */
export const BlockCaret = Extension.create({
  name: 'blockCaret',

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockCaretState>({
        key: BlockCaretPluginKey,
        state: {
          init: () => ({ isFocused: true, isComposing: false }),
          apply: (tr, value) => {
            const meta = tr.getMeta(BlockCaretPluginKey) as Partial<BlockCaretState> | undefined;
            if (meta) {
              return { ...value, ...meta };
            }
            return value;
          },
        },
        props: {
          decorations: state => {
            const pluginState = BlockCaretPluginKey.getState(state);
            // Always show caret when not composing (like terminal behavior)
            if (pluginState?.isComposing) {
              return null;
            }

            const { from, to } = state.selection;
            if (from !== to) {
              return null;
            }

            const caret = Decoration.widget(
              from,
              (view, getPos) => {
                const node = document.createElement('span');
                node.className = 'st-block-caret';
                node.setAttribute('aria-hidden', 'true');
                const pos = getPos?.();
                if (typeof pos === 'number') {
                  const width = measureCaretWidth(view, pos);
                  if (width) {
                    node.style.setProperty('--st-block-caret-width', `${width}px`);
                  }
                }
                return node;
              },
              { side: 1 }
            );

            return DecorationSet.create(state.doc, [caret]);
          },
          handleDOMEvents: {
            focus: view => {
              if (BlockCaretPluginKey.getState(view.state)?.isFocused) {
                return false;
              }
              view.dispatch(view.state.tr.setMeta(BlockCaretPluginKey, { isFocused: true }));
              return false;
            },
            blur: view => {
              if (!BlockCaretPluginKey.getState(view.state)?.isFocused) {
                return false;
              }
              view.dispatch(view.state.tr.setMeta(BlockCaretPluginKey, { isFocused: false }));
              return false;
            },
            compositionstart: view => {
              view.dispatch(view.state.tr.setMeta(BlockCaretPluginKey, { isComposing: true }));
              return false;
            },
            compositionend: view => {
              view.dispatch(view.state.tr.setMeta(BlockCaretPluginKey, { isComposing: false }));
              return false;
            },
          },
        },
      }),
    ];
  },
});
