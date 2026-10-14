/**
 * The CodeMirror 6 setup of the read-only code viewer (T-148): what it is (read-only, line numbers, soft wrap), how it looks (the portal's
 * tokens, the same colours as a tool row's CodeBlock) and what it guarantees (the text drawn is the text given, in order; no HTML of the
 * file is interpreted; disguising characters stay visible and marked). Only the lazy viewer chunk imports this file.
 * The token to theme mapping is written down in docs/design/code-viewer.md.
 */
import { EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, highlightSpecialChars, lineNumbers, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { MONO } from './font';

/**
 * Characters that disguise text (controls, bidi overrides and isolates, zero widths, the BOM, variation selectors), drawn as a marked
 * placeholder and never applied. The same set as the chat's `visibly` (chat/shellTokens.ts), tab and line breaks left out.
 */
export const SPECIAL_CHARS = new RegExp(
  `[${(
    [
      [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
      [0x180b, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
      [0xffa0, 0xffa0],
    ] as const
  )
    .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)
    .join('')}]`,
  'u',
);

/** An escape the portal already wrote into the text (`⟦U+202E⟧`, chat/shellTokens.ts ESCAPE): marked, the text itself unchanged. */
export const ESCAPE_MARK = /⟦U\+[0-9A-F]{4,6}⟧/g;

/** The code point of a placeholder, as the portal writes it: `U+202E`. */
export const codePointLabel = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

const escapeMarks = new MatchDecorator({ regexp: ESCAPE_MARK, decoration: Decoration.mark({ class: 'cm-cp-escape' }) });
const escapePlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet;
    constructor(view: EditorView) {
      this.marks = escapeMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.marks = escapeMarks.updateDeco(u, this.marks);
    }
  },
  { decorations: (v) => v.marks },
);

/** Token colours: the kinds of chat/CodeBlock.tsx (comment muted italic, string emerald, keyword violet, number and variable cyan, flag blue). */
export const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.processingInstruction], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.attributeValue, t.inserted], color: 'var(--code-string)' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self, t.tagName], color: 'var(--code-keyword)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.special(t.variableName), t.escape], color: 'var(--code-number)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName), t.labelName, t.link, t.url], color: 'var(--code-flag)' },
  { tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation], color: 'var(--code-type)' },
  { tag: [t.deleted, t.invalid], color: 'var(--danger)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--ink-soft)' },
  { tag: t.heading, fontWeight: '600', color: 'var(--ink)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, textDecoration: 'underline' },
]);

/** The look: the portal's CSS variables only, so light and dark follow the app's theme live (no CodeMirror default chrome left). */
const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '8px 0', caretColor: 'transparent', WebkitUserSelect: 'text', userSelect: 'text' },
  // A wrapped line hangs under its own start (2ch in), so a continuation reads as one; long words break anywhere (A3).
  '&.cm-lineWrapping .cm-line, .cm-lineWrapping .cm-line': { paddingLeft: 'calc(2ch + 8px)', textIndent: '-2ch' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', borderRight: '1px solid var(--line)', fontFamily: MONO },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '3ch', fontVariantNumeric: 'tabular-nums' },
  '.cm-specialChar, .cm-cp-escape': { color: 'var(--danger)', backgroundColor: 'var(--danger-soft)', borderRadius: '3px', fontWeight: '600' },
  '::selection, .cm-content ::selection': { backgroundColor: 'color-mix(in oklab, var(--accent) 30%, transparent)' },
});

/** Everything the viewer needs except the language and the wrap (those are compartments of the view). */
export function viewerExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // Read-only by every path: no transaction from the user (a paste, a drop, a key) changes the document.
    EditorState.changeFilter.of((tr) => !tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('move')),
    // Keyboard users can still focus the text to scroll it and select with the keys.
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-readonly': 'true', 'aria-label': 'File content' }),
    EditorState.tabSize.of(4),
    lineNumbers(),
    highlightSpecialChars({
      specialChars: SPECIAL_CHARS,
      render: (code) => {
        const el = document.createElement('span');
        el.className = 'cm-specialChar';
        el.textContent = `⟦${codePointLabel(code)}⟧`;
        el.title = codePointLabel(code);
        return el;
      },
    }),
    escapePlugin,
    syntaxHighlighting(highlightStyle),
    theme,
  ];
}
