import type { ReporterChatRuntime } from '@portal/contracts';
import { Sheet } from '../components/Sheet';
import { runtimeRows } from './chatModel';
import { IconBtn } from './ui';

/**
 * The session's runtime as a small sheet over the chat (owner, 2026-10-31): status, model and effort, mode, the Claude it runs on by its
 * portal name, context, cost, and that Claude's plan windows. Every value is the portal's; "unavailable" where it has none. Live: the chat
 * stream's updates re-render it. Esc, the backdrop and Close dismiss it (the shared kit-free Sheet, docs/coord/UI-STANDARD.md §5).
 */
export function RuntimeSheet({ runtime, status, onClose }: { runtime: ReporterChatRuntime | undefined; status: string; onClose: () => void }) {
  const rows = runtimeRows(runtime, status);
  return (
    <Sheet
      title="Session"
      variant="bottom"
      onClose={onClose}
      className="anim-sheet max-h-[80%] border-t border-line"
      bodyClassName="px-4 pb-3"
      head={
        <div className="flex min-h-11 shrink-0 items-center gap-1 pr-1 pl-4">
          <h2 className="flex-1 text-[15px] font-bold">Session</h2>
          <IconBtn icon="x" label="Close" onClick={onClose} />
        </div>
      }
    >
      <dl>
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3 border-t border-line py-2 text-[13px]">
            <dt className="w-28 shrink-0 text-muted">{r.label}</dt>
            <dd className={`min-w-0 flex-1 break-words ${r.value === 'unavailable' ? 'text-muted' : r.tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
