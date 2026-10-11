import { Button, cn } from '@isnanme/ui';
import type { ChatRequest } from '@portal/contracts';
import { ShieldQuestion } from 'lucide-react';
import { AgentTag } from './shared';

type Decision = 'allow' | 'allow_session' | 'deny';

/** Does the detail read like a command or a path, so it should be shown monospaced? */
const looksTechnical = (kind: ChatRequest['kind'], detail: string) => kind === 'tool' || /[/$]|\s--?\w/.test(detail);

/**
 * The oldest open request, pinned above the composer. When more than one waits it shows the count;
 * answering the current one lets the next take its place.
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
  const detail = request.detail ?? '';
  const agent = agentName ?? request.agentLabel;
  return (
    <div role="group" aria-label="Approval needed" className="glass-card rounded-[24px] border-amber-500/40! p-4">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{request.title}</p>
            {agent && <AgentTag label={agent} />}
            {waiting > 1 && <span className="shrink-0 text-[11.5px] font-semibold text-muted">{waiting} waiting</span>}
          </div>
          {detail && (
            <p
              className={cn(
                'mt-1 break-words whitespace-pre-wrap text-ink-soft',
                looksTechnical(request.kind, detail) ? 'font-mono text-[12px]' : 'text-[13px]',
              )}
            >
              {detail}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={() => onRespond(request.requestId, 'allow')}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onRespond(request.requestId, 'allow_session')}>
          Allow for session
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onRespond(request.requestId, 'deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}
