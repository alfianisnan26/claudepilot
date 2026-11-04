// The error a call over the tunnel fails with (PILOT-1169: moved here from apps/server/src/connect/seams.ts, which re-exports it, so
// `instanceof ConnectError` holds for the portal, the agent and the Cloudflare Worker alike).
import type { ConnectStreamError } from '@portal/contracts';

/** What a call over the tunnel fails with when there is no tunnel or the agent refused. */
export class ConnectError extends Error {
  constructor(
    readonly code: 'agent_offline' | 'target_removed' | ConnectStreamError,
    message: string,
  ) {
    super(message);
  }
}
