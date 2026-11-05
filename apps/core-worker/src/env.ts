import type { BridgeDO, ChatSessionDO, OrgDO, PlatformDO, WorkspaceDO } from './do/index.js';

/** The bindings of wrangler.jsonc. */
export interface Env {
  PLATFORM: DurableObjectNamespace<PlatformDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_SESSION: DurableObjectNamespace<ChatSessionDO>;
  BRIDGE: DurableObjectNamespace<BridgeDO>;
  /** Static assets: the SPA (apps/web's build, scripts/webAssets.mjs). */
  ASSETS: Fetcher;
  CP_VERSION: string;
  CP_COMMIT: string;
  /** Secret (never in wrangler.jsonc): the clusters that may dial /bridge, see bridge/registry.ts. Absent: every dial is refused. */
  BRIDGE_CLUSTERS?: string;
  /**
   * The images a workspace Deployment may run (PILOT-1187): comma-separated references, a plain var (not a secret). Empty or absent: a
   * create that names any image is refused (`kubeImageAllowOf`).
   */
  CP_KUBE_IMAGES?: string;
  /**
   * The /api proxy's one target (PILOT-1149), a plain var: `{"cluster":"<bridge cluster>","target":"http://<svc>.dev-rig-<x>.svc:<port>"}`.
   * Only a scratch portal in a dev-rig namespace parses (`apiProxyConfigOf`). Absent or invalid: every /api path is the plain 404.
   */
  CP_API_PROXY?: string;
}
