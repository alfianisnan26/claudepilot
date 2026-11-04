import type { BridgeDO, ChatSessionDO, OrgDO, PlatformDO, WorkspaceDO } from './do/index.js';

/** The bindings of wrangler.jsonc. */
export interface Env {
  PLATFORM: DurableObjectNamespace<PlatformDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_SESSION: DurableObjectNamespace<ChatSessionDO>;
  BRIDGE: DurableObjectNamespace<BridgeDO>;
  /** Static assets: empty until phase 2 serves the SPA. */
  ASSETS: Fetcher;
  CP_VERSION: string;
  CP_COMMIT: string;
}
