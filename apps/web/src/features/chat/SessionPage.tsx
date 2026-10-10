import { Button, ConfirmDialog, Menu } from '@isnanme/ui';
import type { ChatRequest } from '@portal/contracts';
import { ArrowLeft, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApprovalCard } from './ApprovalCard';
import { Composer } from './Composer';
import { StateBadge } from './shared';
import { Transcript } from './Transcript';
import { useChatSession } from './useChatSocket';

/**
 * One session, full screen (like the shell): a header with the state and controls, the transcript,
 * the approvals dock, and the composer pinned to the bottom. It owns the dedicated chat socket for
 * as long as it's mounted.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const { connected, events, delta, session, send, respond, stop, end } = useChatSession(id);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    document.title = `${session?.title || 'Session'} · chat`;
    return () => void (document.title = 'portal');
  }, [session?.title]);

  // Open requests: a `request` with no later `resolved`, oldest first (events are seq-ordered).
  const openRequests = useMemo(() => {
    const resolved = new Set<string>();
    for (const e of events) if (e.kind === 'resolved' && e.requestId) resolved.add(e.requestId);
    const open: ChatRequest[] = [];
    for (const e of events) if (e.kind === 'request' && e.request && !resolved.has(e.request.requestId)) open.push(e.request);
    return open;
  }, [events]);
  const current = openRequests[0] ?? null;

  const state = session?.state ?? 'starting';
  const working = state === 'working';
  const ended = state === 'ended';

  return (
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:px-3">
        <Link
          to="/admin/sessions"
          aria-label="Back to sessions"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowLeft className="size-[18px]" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{session?.title || 'Untitled'}</p>
          <p className="truncate text-[11px] text-muted">
            <span className="font-mono">{session?.workspaceId ?? '…'}</span>
            {!connected && ' · reconnecting…'}
          </p>
        </div>
        {session && <StateBadge state={state} />}
        {working && (
          <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} onClick={stop}>
            <span className="hidden sm:inline">Stop</span>
          </Button>
        )}
        <Menu
          label="Session actions"
          items={[{ label: 'End session', icon: <Trash2 className="size-4" />, onSelect: () => setEnding(true), danger: true, disabled: ended }]}
        />
      </header>

      <Transcript events={events} delta={delta} className="min-h-0 flex-1" />

      <div className="shrink-0 border-t border-line bg-bg">
        <div className="mx-auto w-full max-w-[760px] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {current && <ApprovalCard request={current} waiting={openRequests.length} onRespond={respond} disabled={!connected} />}
          {ended ? (
            <p className="py-2 text-center text-[13px] text-muted">This session has ended.</p>
          ) : (
            <Composer onSend={send} connected={connected} working={working} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={ending}
        title="End this session?"
        description="The chat is closed and Claude Code stops working on it. The transcript stays for your records."
        confirmLabel="End session"
        onConfirm={() => {
          end();
          setEnding(false);
        }}
        onClose={() => setEnding(false)}
      />
    </div>
  );
}
