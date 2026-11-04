// PILOT-1170: the Worker as apps/server/src/connect/tunnel/bridgeWorker.test.ts starts it (wrangler's unstable_startWorker, `entrypoint`):
// the real Worker and its Durable Objects, plus one test-only route that asks BridgeDO to GET through the live link's `kube` stream (its
// `kube` RPC has no route in src yet). Never deployed: wrangler.jsonc's `main` is src/index.ts, and nothing in src imports this file.

import type { Env } from '../../src/env.js';
import worker from '../../src/index.js';
import { locate } from '../../src/locate.js';

export { BridgeDO, ChatSessionDO, OrgDO, PlatformDO, WorkspaceDO } from '../../src/index.js';

interface InteropKube {
  cluster: string;
  path: string;
  namespace?: string;
  bearer: string;
}

export default {
  async fetch(req, env, ctx) {
    if (new URL(req.url).pathname === '/__interop/kube' && req.method === 'POST') {
      const b = (await req.json()) as InteropKube;
      const answer = await locate(env.BRIDGE, b.cluster).kube({
        path: b.path,
        bearer: b.bearer,
        ...(b.namespace ? { namespace: b.namespace } : {}),
      });
      return Response.json(answer);
    }
    return worker.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
