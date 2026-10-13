import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { readAll, scrollState } from './approvalReview';
import { ReviewText } from './CodeBlock';
import { approvalLang } from './toolFormat';

/**
 * What a person is asked to allow, whole, in the tool rows' renderer (`CodeBlock.tsx`, chat PRD FR7): monospace text that wraps (so a long
 * run of spaces cannot push the end out of sight sideways), real line breaks, a command coloured as shell but never dimmed, escaped
 * disguising characters marked, and scrolls, at most a few lines high. `onRead` says whether all of it has been in view (it fits, or the
 * person scrolled to the end): the buttons that allow wait for that. Focusable, so the keyboard can scroll it.
 */
export function ApprovalBlock({ text, tool, onRead, className }: { text: string; tool?: string | null; onRead: (all: boolean) => void; className?: string }) {
  const lang = useMemo(() => approvalLang(tool, text), [tool, text]);
  const ref = useRef<HTMLPreElement>(null);
  const latest = useRef(onRead);
  useLayoutEffect(() => {
    latest.current = onRead;
  });
  const report = useCallback(() => {
    const el = ref.current;
    if (el) latest.current(readAll(scrollState(el)));
  }, []);
  // Measured before the first paint (and again whenever the text or the block's size changes), so Allow never shows pressable for a frame.
  useLayoutEffect(report, [text, report]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [report]);
  return <ReviewText ref={ref} text={text} lang={lang} onScroll={report} className={className} />;
}
