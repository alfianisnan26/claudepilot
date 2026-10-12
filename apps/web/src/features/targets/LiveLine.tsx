import { Button, Spinner } from '@isnanme/ui';
import { Check, TriangleAlert } from 'lucide-react';
import { timeAgo } from '@/lib/format';
import type { LiveLineState } from './useEnrollment';

/**
 * The one live line under the command. A polite live region: a screen reader hears "Connected" once, not every refresh.
 * Waiting is skeleton-sized (the line keeps its height in every state) so nothing shifts when it changes.
 */
export function LiveLine({ line, onNewCommand, onRetry }: { line: LiveLineState | null; onNewCommand: () => void; onRetry: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="live-line">
      {!line && (
        <span className="flex items-center gap-2 text-muted">
          <Spinner className="size-4" />
          Waiting for the agent to connect
        </span>
      )}
      {line?.state === 'waiting' && (
        <span className="flex items-center gap-2 text-ink-soft">
          <Spinner className="size-4" />
          {line.enrolled ? 'Enrolled, connecting' : 'Waiting for the agent to connect'}
        </span>
      )}
      {line?.state === 'connected' && (
        <span className="flex min-w-0 items-center gap-2 font-medium text-accent">
          <Check className="size-4 shrink-0" strokeWidth={3} aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Connected · {line.node.name}
            {line.node.agentVersion ? ` · v${line.node.agentVersion}` : ''}
            {line.node.lastSeenAt ? ` · seen ${timeAgo(line.node.lastSeenAt)}` : ''}
          </span>
        </span>
      )}
      {(line?.state === 'expired' || line?.state === 'revoked') && (
        <>
          <span className="flex items-center gap-2 text-danger">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {line.state === 'expired' ? 'Expired' : 'Revoked'}
          </span>
          <Button size="sm" variant="secondary" onClick={onNewCommand}>
            New command
          </Button>
        </>
      )}
      {line?.state === 'removed' && <span className="text-danger">This target was removed.</span>}
      {line?.state === 'error' && (
        <>
          <span className="flex min-w-0 items-center gap-2 text-danger">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">Can’t check: {line.message}</span>
          </span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
