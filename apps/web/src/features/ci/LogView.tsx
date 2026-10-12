import { cn } from '@isnanme/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ciApi } from './api';

/** What the viewer keeps in memory: a flood is shown from its tail. */
const KEEP = 1_000_000;

/**
 * A step's log as plain text (PRD §15): read from the workspace while the step runs, from the portal's copy once the run is
 * over. It follows the end while you are at the end and leaves you where you are when you have scrolled up. Text only: the
 * server has already stripped escape sequences and redacted, and this renders it as a text node, never as markup.
 */
export function LogView({ runId, job, step, active, className }: { runId: string; job: string; step: number; active: boolean; className?: string }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'loading' | 'live' | 'done' | 'failed'>('loading');
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let offset = 0;
    let fails = 0;
    setText('');
    setCut(false);
    setState('loading');
    const next = async () => {
      try {
        const chunk = await ciApi.log(runId, job, step, offset);
        if (!alive) return;
        fails = 0;
        offset = chunk.next;
        if (chunk.text) {
          setText((t) => {
            const all = t + chunk.text;
            if (all.length <= KEEP) return all;
            setCut(true);
            return all.slice(all.length - KEEP);
          });
        }
        if (chunk.done) return setState('done');
        setState('live');
        timer = window.setTimeout(next, chunk.text ? 300 : active ? 1200 : 2500);
      } catch {
        if (!alive) return;
        fails++;
        setState(fails > 3 ? 'failed' : 'loading');
        if (fails <= 8) timer = window.setTimeout(next, 1500 * fails);
      }
    };
    void next();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, job, step, active]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className={className}>
      <pre
        ref={box}
        role="log"
        aria-label="Log"
        aria-busy={state === 'loading' || state === 'live'}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={cn(
          'max-h-[55vh] min-h-12 overflow-auto rounded-xl border border-line bg-surface-2/50 px-3 py-2.5 font-mono text-[12px] leading-[1.5] break-words whitespace-pre-wrap text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        )}
      >
        {cut && <span className="text-muted">…earlier output not shown{'\n'}</span>}
        {text}
        {state === 'done' && !text && <span className="text-muted">No output</span>}
        {state === 'loading' && !text && <span className="text-muted">…</span>}
        {state === 'failed' && <span className="text-danger">Could not load the log.</span>}
      </pre>
    </div>
  );
}
