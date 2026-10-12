import { Badge, Spinner } from '@isnanme/ui';
import type { ClaudeCanaryRun } from '@portal/contracts';
import { ChevronRight } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import { checkLabel, checkWhat, STATUS_TONE } from './labels';

/**
 * One canary run, item by item: pass, fail or skipped with the one-line summary; the real output behind a chevron (as text, never
 * HTML: it came from a workspace). `accepted`/`onAccept` let the Upgrade dialog tick a failed item by name.
 */
export function CanaryResults({ run, accepted, onAccept }: { run: ClaudeCanaryRun; accepted?: string[]; onAccept?: (id: string, on: boolean) => void }) {
  if (run.status === 'running')
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-muted">
        <Spinner className="size-3.5" /> {run.note ?? 'Running…'}
      </p>
    );
  if (run.results.length === 0) return <p className="text-[13px] text-muted">{run.note ?? 'No results.'}</p>;
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line text-[13px]">
      {run.results.map((r) => {
        const s = STATUS_TONE[r.status];
        const what = checkWhat(r.id);
        return (
          <li key={r.id} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{checkLabel(r.id)}</span>
              {what && <InfoTip label={`About ${checkLabel(r.id)}`}>{what}</InfoTip>}
              {r.status === 'fail' && onAccept && (
                <label className="flex min-h-11 items-center gap-1.5 px-1 text-[12px] text-muted">
                  <input type="checkbox" className="size-4 accent-current" checked={!!accepted?.includes(r.id)} onChange={(e) => onAccept(r.id, e.target.checked)} />
                  Accept
                </label>
              )}
              <Badge tone={s.tone}>{s.label}</Badge>
            </div>
            <details className="group mt-1">
              <summary className="flex min-h-11 cursor-pointer list-none items-center items-start gap-1 text-ink-soft [&::-webkit-details-marker]:hidden">
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden />
                <span className="min-w-0 line-clamp-2 [overflow-wrap:anywhere]" title={r.summary}>{r.summary}</span>
              </summary>
              {r.detail && <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-2.5 font-mono text-[11.5px] text-ink-soft">{r.detail}</pre>}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
