import { cn } from '@isnanme/ui';
import { useMemo, useState } from 'react';
import { MONO } from './parts';

type Op = { t: ' ' | '+' | '-'; text: string };
type Row = Op | { t: 'gap'; n: number };

/** A line diff by longest common subsequence: for the few hundred lines of instructions a persona has. Null when the texts are too long to compare here. */
export function diffLines(before: string, after: string): Op[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > 2_000_000) return null;
  const w = y.length + 1;
  const table = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
  const ops: Op[] = a.slice(0, start).map((text) => ({ t: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ t: ' ', text: x[i++]! }), j++;
    // A replaced line shows what went before what came.
    else if (i < x.length && (j === y.length || table[(i + 1) * w + j]! >= table[i * w + j + 1]!)) ops.push({ t: '-', text: x[i++]! });
    else ops.push({ t: '+', text: y[j++]! });
  }
  for (const text of a.slice(endA)) ops.push({ t: ' ', text });
  return ops;
}

/** Changed lines with a little context; long unchanged stretches collapse into one row. */
function rowsOf(ops: Op[], context = 2): Row[] {
  const keep = ops.map((o) => o.t !== ' ');
  for (let i = 0; i < ops.length; i++) if (ops[i]!.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  const out: Row[] = [];
  let gap = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap) out.push({ t: 'gap', n: gap }), (gap = 0);
      out.push(o);
    } else gap++;
  });
  if (gap) out.push({ t: 'gap', n: gap });
  return out;
}

/** What changed between two texts, line by line (Persona PRD §14: the diff of instructions). */
export function LineDiff({ before, after, max = 40, className }: { before: string; after: string; max?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const ops = diffLines(before, after);
    return ops ? rowsOf(ops) : null;
  }, [before, after]);
  if (!rows) return <p className="text-[13px] text-muted">Too long to compare here.</p>;
  if (rows.every((r) => r.t === ' ' || r.t === 'gap')) return <p className="text-[13px] text-muted">No changes.</p>;
  const shown = all ? rows : rows.slice(0, max);
  return (
    <div className={cn('overflow-hidden rounded-xl border border-line', className)}>
      <pre className="overflow-x-auto py-1 text-[12px] leading-relaxed" style={{ fontFamily: MONO }}>
        {shown.map((r, i) =>
          r.t === 'gap' ? (
            <div key={i} className="px-3 text-muted select-none">
              … {r.n} unchanged {r.n === 1 ? 'line' : 'lines'}
            </div>
          ) : (
            <div key={i} className={cn('flex gap-2 px-3 whitespace-pre-wrap break-words', r.t === '+' && 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300', r.t === '-' && 'bg-danger-soft text-danger')}>
              <span aria-hidden className="w-3 shrink-0 select-none">
                {r.t === ' ' ? '' : r.t}
              </span>
              <span className="min-w-0 flex-1">{r.text || ' '}</span>
            </div>
          ),
        )}
      </pre>
      {rows.length > max && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-line px-3 py-1.5 text-left text-[12.5px] font-semibold text-muted hover:text-ink">
          {all ? 'Show less' : `Show all ${rows.length} rows`}
        </button>
      )}
    </div>
  );
}
