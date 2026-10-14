/**
 * The one read-only viewer for code and text files (T-148): CodeMirror 6 with line numbers, the portal's colours and soft wrap. The
 * CodeMirror chunk loads on the first file opened; until then (and if it cannot load, offline) the same text shows as plain wrapped text,
 * so a file is never blank. The text given is already redacted and escaped by the portal; the viewer only draws it.
 */
import { cn } from '@isnanme/ui';
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { MONO } from './font';
import type { CodeLanguage } from './language';

const CodeMirrorView = lazy(() => import('./CodeMirrorView'));

function Plain({ text, wrap }: { text: string; wrap: boolean }) {
  return (
    <pre className={cn('px-3 py-2 text-[12.5px] leading-relaxed', wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto whitespace-pre')} style={{ fontFamily: MONO, tabSize: 4 }}>
      {text}
    </pre>
  );
}

/** A chunk that failed to load leaves the plain text in place. */
class PlainOnError extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CodeViewer({ text, language, wrap = true, className }: { text: string; language: CodeLanguage; wrap?: boolean; className?: string }) {
  const plain = <Plain text={text} wrap={wrap} />;
  return (
    <div data-testid="code-viewer" className={cn('min-w-0 overflow-hidden rounded-xl border border-line bg-bg', className)}>
      <PlainOnError fallback={plain}>
        <Suspense fallback={plain}>
          <CodeMirrorView text={text} language={language} wrap={wrap} />
        </Suspense>
      </PlainOnError>
    </div>
  );
}
