import type { ReporterChatRuntime } from '@portal/contracts';
import { useEffect, useRef } from 'react';
import { runtimeRows } from './chatModel';
import { IconBtn } from './ui';

/**
 * The session's runtime as a small sheet over the chat (owner, 2026-10-31): status, model and effort, mode, the Claude it runs on by its
 * portal name, context, cost, and that Claude's plan windows. Every value is the portal's; "unavailable" where it has none. Live: the chat
 * stream's updates re-render it. Esc, the backdrop and Close dismiss it.
 */
export function RuntimeSheet({ runtime, status, onClose }: { runtime: ReporterChatRuntime | undefined; status: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const rows = runtimeRows(runtime, status);
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Session"
        tabIndex={-1}
        className="relative max-h-[80%] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] shadow-lg focus:outline-hidden"
      >
        <div className="flex min-h-11 items-center gap-1 pr-1 pl-4">
          <h2 className="flex-1 text-[15px] font-bold">Session</h2>
          <IconBtn icon="x" label="Close" onClick={onClose} />
        </div>
        <dl className="px-4 pb-3">
          {rows.map((r) => (
            <div key={r.label} className="flex gap-3 border-t border-line py-2 text-[13px]">
              <dt className="w-28 shrink-0 text-muted">{r.label}</dt>
              <dd className={`min-w-0 flex-1 break-words ${r.value === 'unavailable' ? 'text-muted' : r.tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
