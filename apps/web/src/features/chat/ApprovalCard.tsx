import { Button } from '@isnanme/ui';
import type { ChatRequest } from '@portal/contracts';
import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
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
}: {
  request: ChatRequest;
  waiting: number;
  onRespond: (requestId: string, decision: Decision) => void;
  disabled?: boolean;
  /** The asking sub-agent as people read it (its task's description), when known. */
  agentName?: string | null;
}) {
  // One body per request: what has been read belongs to that request's text.
  return <ApprovalBody key={request.requestId} request={request} waiting={waiting} onRespond={onRespond} disabled={disabled} agentName={agentName} />;
}

function ApprovalBody({ request, waiting, onRespond, disabled, agentName }: { request: ChatRequest; waiting: number; onRespond: (requestId: string, decision: Decision) => void; disabled?: boolean; agentName?: string | null }) {
  const [read, setRead] = useState(false);
  const controls = approvalControls(request, read);
  const agent = agentName ?? request.agentLabel;
  return (
    <div role="group" aria-label="Approval needed" className="rounded-2xl border border-line bg-surface p-4 shadow-lift">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{request.title}</p>
            {agent && <AgentTag label={agent} />}
            {waiting > 1 && <span className="shrink-0 text-xs font-semibold text-muted">{waiting} waiting</span>}
          </div>
          {request.full ? <ApprovalBlock text={request.full} onRead={setRead} /> : request.detail ? <p className="font-mono text-xs break-words whitespace-pre-wrap text-ink-soft">{request.detail}</p> : null}
          {controls.note && (
            <p role="status" className="text-xs font-medium text-ink-soft">
              {controls.note}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
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
