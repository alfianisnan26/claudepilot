// A dead identity and a new command (T6, docs/prd/targets-connect.md §10.5): after a revoke, a removed target or a portal that no longer knows
// the node, the PRD's remedy is "a new command re-enrolls". The machine still holds the old identity, though, and before this every kind kept
// it: `enroll` said "already enrolled" and the agent slept an hour on its fatal rejection, so the new command never connected (seen on a real
// cluster: the installer waited 60 s and failed). Now an identity the portal has declared dead gives way to the token the person just ran:
//  - `enroll` (Docker, Container, Host: the installer's run) asks the portal about the identity it has; only a dead one is replaced;
//  - a running agent with a token in its environment (Kubernetes: the Secret; Swarm: the service) enrolls with it on such a rejection.
// Anything else (the identity works, the node is connected elsewhere, the portal can't be reached) keeps the identity: a healthy node is never
// thrown away by a re-run.
import { connectTunnelUrl, type ConnectAgentHello, type ConnectRejectCode } from '@portal/contracts';
import { dialTunnel, TunnelRejected } from '../tunnel/index.js';
import type { Identity } from './identity.js';
import { transportAgent, type NetConfig } from './net.js';

/** The rejections that mean the portal will never take this identity again. (`upgrade_required` and `portal_mismatch` are fatal too, but a new key changes nothing there.) */
export const DEAD_IDENTITY: readonly ConnectRejectCode[] = ['revoked', 'unknown_node', 'target_removed'];

export const isDeadIdentity = (code: string): boolean => (DEAD_IDENTITY as readonly string[]).includes(code);

/** One handshake with the identity: `alive` (welcome, or another connection holds it), `dead` (with the portal's code), or `unknown` (anything else). */
export async function probeIdentity(opts: { identity: Identity; url?: string | null; hello: () => ConnectAgentHello; net: NetConfig; handshakeMs?: number }): Promise<{ state: 'alive' | 'unknown' } | { state: 'dead'; code: ConnectRejectCode }> {
  const tunnel = connectTunnelUrl(opts.url ?? opts.identity.portalUrl);
  try {
    const d = await dialTunnel({
      url: tunnel,
      nodeId: opts.identity.node,
      privateKey: opts.identity.privateKey,
      hello: opts.hello,
      ws: { agent: transportAgent(new URL(tunnel), opts.net), headers: opts.net.headers ?? {} },
      handshakeMs: opts.handshakeMs ?? 10_000,
    });
    d.session.close(1000, 'probe');
    return { state: 'alive' };
  } catch (e) {
    if (e instanceof TunnelRejected) {
      if (isDeadIdentity(e.code)) return { state: 'dead', code: e.code };
      if (e.code === 'already_connected') return { state: 'alive' };
    }
    return { state: 'unknown' };
  }
}
