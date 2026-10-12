import { cn } from '@isnanme/ui';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { readAll, scrollState } from './approvalReview';

/**
 * What a person is asked to allow, whole: plain monospace text that wraps (so a long run of spaces cannot push the end out of sight
 * sideways) and scrolls, at most a few lines high. `onRead` says whether all of it has been in view (it fits, or the person scrolled to
 * the end): the buttons that allow wait for that. Focusable, so the keyboard can scroll it.
 */
export function ApprovalBlock({ text, onRead, className }: { text: string; onRead: (all: boolean) => void; className?: string }) {
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
  return (
    <pre
      ref={ref}
      tabIndex={0}
      role="region"
      aria-label="What is being allowed"
      onScroll={report}
      className={cn(
        'max-h-40 overflow-y-auto rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-ink-soft wrap-anywhere overscroll-contain',
        className,
      )}
    >
      {text}
    </pre>
  );
}
