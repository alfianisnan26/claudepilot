/**
 * The CodeMirror 6 view behind CodeViewer (T-148). Loaded lazily (CodeViewer.tsx): nothing of CodeMirror is in the main bundle.
 * The editor grows with its text and the sheet around it scrolls, so CodeMirror still draws only the lines in view (a 50,000-line file
 * opens at once); with wrap off, only the code scrolls sideways, never the page.
 */
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LanguageSupport } from '@codemirror/language';
import { useEffect, useRef } from 'react';
import type { CodeLanguage } from './language';
import { loadLanguage } from './languages';
import { viewerExtensions } from './setup';

export interface CodeMirrorViewProps {
  text: string;
  language: CodeLanguage;
  wrap: boolean;
}

const wrapping = (on: boolean) => (on ? EditorView.lineWrapping : []);

export default function CodeMirrorView({ text, language, wrap }: CodeMirrorViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapSlot = useRef(new Compartment());
  const langSlot = useRef(new Compartment());
  const wrapNow = useRef(wrap);
  wrapNow.current = wrap;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const v = new EditorView({
      parent,
      state: EditorState.create({ doc: text, extensions: [viewerExtensions(), wrapSlot.current.of(wrapping(wrapNow.current)), langSlot.current.of([])] }),
    });
    view.current = v;
    let live = true;
    loadLanguage(language).then(
      (lang) => {
        if (live && lang) v.dispatch({ effects: langSlot.current.reconfigure(new LanguageSupport(lang)) });
      },
      () => {}, // offline or a failed chunk: the text stays plain
    );
    return () => {
      live = false;
      v.destroy();
      view.current = null;
    };
  }, [text, language]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapSlot.current.reconfigure(wrapping(wrap)) });
  }, [wrap]);

  return <div ref={host} data-language={language} data-wrap={wrap ? 'on' : 'off'} className="code-viewer min-w-0" />;
}
