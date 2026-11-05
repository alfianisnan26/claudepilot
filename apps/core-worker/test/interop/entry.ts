// PILOT-1170, PILOT-1171: the Worker as apps/server/src/connect/tunnel/bridgeWorker.test.ts starts it (wrangler's unstable_startWorker,
// `entrypoint`): the real Worker and its Durable Objects, plus test-only routes that call BridgeDO's kube RPCs over the live link (they
// have no route in src yet): `POST /__interop/kube` (the GET of kube()) and `POST /__interop/kube/<rpc>` for the REST client (kubeList,
// kubeMetrics, kubeCreate, kubeScale, kubeDelete). Never deployed: wrangler.jsonc's `main` is src/index.ts, and nothing in src imports this.

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

const RPC = ['kubeList', 'kubeMetrics', 'kubeCreate', 'kubeScale', 'kubeDelete'] as const;
type Rpc = (typeof RPC)[number];

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (pathname === '/__interop/kube' && req.method === 'POST') {
      const b = (await req.json()) as InteropKube;
      const answer = await locate(env.BRIDGE, b.cluster).kube({
        path: b.path,
        bearer: b.bearer,
        ...(b.namespace ? { namespace: b.namespace } : {}),
      });
      return Response.json(answer);
    }
    const rpc = pathname.startsWith('/__interop/kube/') ? pathname.slice('/__interop/kube/'.length) : '';
    if ((RPC as readonly string[]).includes(rpc) && req.method === 'POST') {
      const { cluster, ...args } = (await req.json()) as { cluster: string } & Record<string, unknown>;
      const bridge = locate(env.BRIDGE, cluster) as unknown as Record<Rpc, (a: unknown) => Promise<unknown>>;
      return Response.json(await bridge[rpc as Rpc](args));
    }
    return worker.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
