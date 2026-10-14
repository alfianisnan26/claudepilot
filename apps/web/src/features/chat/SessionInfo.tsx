import { Button, Dialog } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { GitBranch, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { RunChip } from '@/features/ci/RunChip';
import type { usePersonaOf } from '@/features/personas/identities';
import { PersonaAvatar } from '@/features/personas/PersonaAvatar';
import { BumpedChip, TicketChip, useBumpedTickets } from '@/features/tickets/TicketChip';
import { KeepGoingSection } from './KeepGoing';

/**
 * Session info: what the session header used to spell out under the title (persona, workspace, Claude, ticket, CI runs, worktree
 * branch), behind a tap on the title or ⋯ → Info, so the floating header keeps to back, title, state and ⋯ (chat PRD §12.3).
 */
export function SessionInfoDialog({
  open,
  onClose,
  session,
  persona,
  gone,
  connected,
  onRename,
}: {
  open: boolean;
  onClose: () => void;
  session: ChatSession | null | undefined;
  persona: ReturnType<typeof usePersonaOf>;
  /** Its workspace was removed. */
  gone: boolean;
  connected: boolean;
  onRename: () => void;
}) {
  // Tickets pushed into this session (tickets PRD FR31): beside its own ticket, each with how it was bumped.
  const bumped = useBumpedTickets(session?.id, open);
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Session">
      {session && (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[15px] font-semibold [overflow-wrap:anywhere] text-ink">{session.title || 'Untitled'}</p>
            <Button size="sm" variant="secondary" onClick={onRename} aria-label="Rename">
              <Pencil className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13.5px]">
            {persona && (
              <Row label="Persona">
                <PersonaAvatar name={persona.name} avatar={persona.avatar} size="xs" showName className="inline-flex max-w-full font-semibold text-ink-soft" />
              </Row>
            )}
            <Row label="Workspace">
              <span className="font-mono [overflow-wrap:anywhere]">{session.workspaceId}</span>
              {gone && <span className="text-danger"> · removed</span>}
            </Row>
            {session.claudeName && (
              <Row label="Claude">
                {session.claudeName}
                {session.endedReason === 'transferred' && <span className="text-muted"> · left behind</span>}
              </Row>
            )}
            {(session.ticketId || bumped.length > 0) && (
              <Row label={bumped.length + (session.ticketId && !bumped.some((b) => b.ticketId === session.ticketId) ? 1 : 0) > 1 ? 'Tickets' : 'Ticket'}>
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {session.ticketId && !bumped.some((b) => b.ticketId === session.ticketId) && <TicketChip ticketId={session.ticketId} compact />}
                  {bumped.map((b) => (
                    <BumpedChip key={b.ticketId} bump={b} />
                  ))}
                </span>
              </Row>
            )}
            {session.worktree && (
              <>
                <Row label="Branch">
                  <span className="inline-flex max-w-full items-center gap-1 font-mono" title={session.worktree.path}>
                    <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="[overflow-wrap:anywhere]">{session.worktree.branch}</span>
                  </span>
                </Row>
                <RunChip sessionId={session.id} compact className="col-span-2" />
              </>
            )}
            {!connected && <Row label="Link">Reconnecting…</Row>}
          </dl>
          <KeepGoingSection session={session} />
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink-soft">{children}</dd>
    </>
  );
}
