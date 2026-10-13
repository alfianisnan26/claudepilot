import { Button, cn } from '@isnanme/ui';
import type { ChatRequest } from '@portal/contracts';
import { ShieldQuestion } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { ApprovalBlock } from './ApprovalBlock';
import { approvalControls } from './approvalReview';
import { AgentTag } from './shared';

type Decision = 'allow' | 'allow_session' | 'deny';

/**
 * The oldest open request, pinned above the composer. When more than one waits it shows the count;
 * answering the current one lets the next take its place.
 *
 * What is being allowed is shown whole, in a block that scrolls (the title above it is the one-line summary). Allow and Allow for
 * session are offered only when that text is there and whole, and pressable only once it has been read to the end; a request that is cut
 * at the portal's cap, or has no text, can only be denied, with one line saying why. The glance widget keeps the same rule
 * (`approvalControls`), and the portal refuses an Allow for such a request whoever sends it.
 */
export function ApprovalCard({
  request,
  waiting,
  onRespond,
  disabled,
  agentName,
  className,
  style,
}: {
  request: ChatRequest;
  waiting: number;
  onRespond: (requestId: string, decision: Decision) => void;
  disabled?: boolean;
  /** The asking sub-agent as people read it (its task's description), when known. */
  agentName?: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  // One body per request: what has been read belongs to that request's text.
  return (
    <ApprovalBody
      key={request.requestId}
      request={request}
      waiting={waiting}
      onRespond={onRespond}
      disabled={disabled}
      agentName={agentName}
      className={className}
      style={style}
    />
  );
}

/**
 * The same request while the on-screen keyboard is up (chat PRD, the dock): one 56 px bar that says one waits, and Review, which puts
 * the keyboard away so the whole card comes back. Nothing can be allowed from here.
 */
export function ApprovalBar({ request, waiting, onReview }: { request: ChatRequest; waiting: number; onReview: () => void }) {
  return (
    <div role="group" aria-label="Approval needed" data-approval="bar" className="flex h-14 shrink-0 items-center gap-2.5 rounded-full border border-line bg-surface pr-1.5 pl-4 shadow-lift">
      <ShieldQuestion className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-semibold">{waiting > 1 ? `${waiting} approvals` : 'Approval'}</span>
        <span className="text-ink-soft"> · {request.title}</span>
      </p>
      <Button size="sm" variant="secondary" onClick={onReview}>
        Review
      </Button>
    </div>
  );
}

function ApprovalBody({
  request,
  waiting,
  onRespond,
  disabled,
  agentName,
  className,
  style,
}: {
  request: ChatRequest;
  waiting: number;
  onRespond: (requestId: string, decision: Decision) => void;
  disabled?: boolean;
  agentName?: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  const [read, setRead] = useState(false);
  const controls = approvalControls(request, read);
  const agent = agentName ?? request.agentLabel;
  return (
    // Given less room than it wants (a short screen, the keyboard up), the card shrinks by its text block, never below about two lines of
    // it; the title and the buttons keep their size.
    <div role="group" aria-label="Approval needed" data-approval="card" className={cn('flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-lift', className)} style={style}>
      {/* Squeezed below its two lines (a phone on its side), the text is cut here rather than drawn over the buttons. */}
      <div className="flex min-h-0 gap-2.5 overflow-hidden">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 self-start text-muted" aria-hidden="true" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{request.title}</p>
            {agent && <AgentTag label={agent} />}
            {waiting > 1 && <span className="shrink-0 text-xs font-semibold text-muted">{waiting} waiting</span>}
          </div>
          {request.full ? (
            <ApprovalBlock text={request.full} onRead={setRead} className="min-h-12" />
          ) : request.detail ? (
            <p className="shrink-0 font-mono text-xs break-words whitespace-pre-wrap text-ink-soft">{request.detail}</p>
          ) : null}
          {controls.note && (
            <p role="status" className="shrink-0 text-xs font-medium text-ink-soft">
              {controls.note}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex shrink-0 flex-wrap gap-2">
        {controls.offered && (
          <>
            <Button size="sm" disabled={disabled || !controls.allow} onClick={() => onRespond(request.requestId, 'allow')}>
              Allow
            </Button>
            <Button size="sm" variant="secondary" disabled={disabled || !controls.allow} onClick={() => onRespond(request.requestId, 'allow_session')}>
              Allow for session
            </Button>
          </>
        )}
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onRespond(request.requestId, 'deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}
