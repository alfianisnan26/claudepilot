// GET /bridge (PILOT-1144, D3, D4): the in-cluster cp-bridge dials out to here. Everything is checked BEFORE the upgrade, and every refusal is
// the authz seam's plain 404 (the same body as an unknown path): a caller learns nothing about which part was wrong.
//
//   Upgrade: websocket, no Origin (not a browser), Sec-WebSocket-Protocol offering `pilot.tunnel.v1`,
//   X-Pilot-Cluster: <cluster>, Authorization: Bearer <token>  (SHA-256 checked against BRIDGE_CLUSTERS).
//
// Then the request goes to the cluster's BridgeDO without the Authorization header: the object gets the cluster, its node id and its public
// key in internal headers it can trust (a Durable Object is only reachable through this Worker), and runs the Connect handshake itself.

import { AppError } from '@isnanme/core';
import { CONNECT_SUBPROTOCOL, type ApiErrorBody } from '@portal/contracts';
import type { Env } from '../env.js';
import { locate } from '../locate.js';
import { bridgeAuthorize } from './registry.js';

/** Headers the Worker sets for the BridgeDO; whatever a caller sent under these names is never passed on. */
export const BRIDGE_INTERNAL = { cluster: 'x-cp-bridge-cluster', node: 'x-cp-bridge-node', key: 'x-cp-bridge-key' } as const;
export const BRIDGE_CLUSTER_HEADER = 'x-pilot-cluster';

export const notFound = (): Response => Response.json(new AppError('NOT_FOUND', 'Not found.').toJSON() satisfies ApiErrorBody, { status: 404 });

const offersSubprotocol = (header: string | null): boolean => (header ?? '').split(',').some((p) => p.trim() === CONNECT_SUBPROTOCOL);

/** Why a request is refused, for the log only (no header value, never the token). */
function shapeProblem(req: Request): string | null {
  if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return 'not an upgrade';
  if (req.headers.has('origin')) return 'origin header';
  if (!offersSubprotocol(req.headers.get('sec-websocket-protocol'))) return 'no subprotocol';
  return null;
}

export async function bridgeUpgrade(req: Request, env: Env): Promise<Response> {
  const cluster = req.headers.get(BRIDGE_CLUSTER_HEADER) ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer [\x21-\x7e]+$/.test(auth) ? auth.slice(7) : '';
  // The token is hashed and compared on every path, so a refusal for the shape costs the same as one for the token.
  const entry = await bridgeAuthorize(env.BRIDGE_CLUSTERS, cluster, token);
  const problem = shapeProblem(req) ?? (entry ? null : 'unknown cluster or token');
  if (problem || !entry) {
    console.warn(`bridge: refused before the upgrade (${problem})`);
    return notFound();
  }
  const headers = new Headers({
    upgrade: 'websocket',
    'sec-websocket-protocol': CONNECT_SUBPROTOCOL,
    [BRIDGE_INTERNAL.cluster]: cluster,
    [BRIDGE_INTERNAL.node]: entry.node,
    [BRIDGE_INTERNAL.key]: entry.publicKey,
  });
  return locate(env.BRIDGE, cluster).fetch(new Request(new URL('/bridge', req.url), { method: 'GET', headers }));
}
