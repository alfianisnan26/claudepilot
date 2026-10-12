import { Badge, Button, Spinner } from '@isnanme/ui';
import type { McpServerAuth } from '@portal/contracts';
import { LogOut, RefreshCw } from 'lucide-react';
import { AUTH_STATE } from './labels';
import { WithReason } from './WithReason';

/**
 * Where an OAuth server's sign-in stands in a workspace (MCP set PRD §13.3), as Claude Code reports it, with the one
 * action that fits: Sign in when it needs one or failed, a check when nothing is known yet, Sign out when connected.
 * Nothing can be done while the workspace is stopped (Claude Code runs inside it) or when the portal refused the person
 * (`blocked`, its reason): the action is then off, with the reason. It takes the place of the "Delivered" badge on the
 * server's line (any of these states means it was delivered), so it renders inline, as a fragment.
 */
export function AuthChip({
  auth,
  running,
  checking,
  blocked,
  onSignIn,
  onCheck,
  onSignOut,
}: {
  auth: McpServerAuth;
  running: boolean;
  checking: boolean;
  /** The portal's reason when it refused this person (403); null while nothing says so. */
  blocked: string | null;
  onSignIn: () => void;
  onCheck: () => void;
  onSignOut: () => void;
}) {
  const s = AUTH_STATE[auth.state];
  const why = blocked ?? (running ? undefined : 'Start the workspace first');
  return (
    <>
      <Badge tone={s.tone}>{s.label}</Badge>
      {(auth.state === 'needs_sign_in' || auth.state === 'failed') && (
        <WithReason reason={why}>
          <Button size="sm" variant="secondary" onClick={onSignIn} disabled={!!why}>
            Sign in
          </Button>
        </WithReason>
      )}
      {auth.state === 'unknown' && (
        <WithReason reason={why}>
          <Button size="icon" variant="ghost" aria-label="Check sign-in" title={why ?? 'Check sign-in'} onClick={onCheck} disabled={!!why || checking} className="size-8">
            {checking ? <Spinner className="size-3" /> : <RefreshCw className="size-4" />}
          </Button>
        </WithReason>
      )}
      {auth.state === 'connected' && (
        <WithReason reason={why}>
          <Button size="icon" variant="ghost" aria-label="Sign out" title={why ?? 'Sign out'} onClick={onSignOut} disabled={!!why} className="size-8">
            <LogOut className="size-4" />
          </Button>
        </WithReason>
      )}
    </>
  );
}

/** Why a sign-in failed, or why nothing is known: one short line from Claude Code, shown plain under the server's line. */
export const authDetail = (auth: McpServerAuth): string | null => (auth.state === 'connected' ? null : auth.detail);
