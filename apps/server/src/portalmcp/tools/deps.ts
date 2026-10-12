import type { AccountPools } from '../../accounts/pools.js';
import type { AccountsService } from '../../accounts/service.js';
import type { ChatController } from '../../chat/controller.js';
import type { Reconciler } from '../../delivery/reconciler.js';
import type { McpSets } from '../../mcp/index.js';
import type { PoolService } from '../../pools/service.js';
import type { Store } from '../../store/store.js';
import type { Workspaces } from '../../workspaces/manager.js';
import type { PortalMcpModule } from '../module.js';

/** The portal services the built-in tools are thin adapters over (PRD §7: the same services as `/api/*`). */
export interface PortalToolDeps {
  store: Store;
  module: PortalMcpModule;
  workspaces: Workspaces;
  chat: ChatController;
  accounts: AccountsService;
  accountPools: AccountPools;
  poolService: PoolService;
  reconciler: Reconciler;
  /** MCP sets: the catalog, where agents and tokens propose servers (interface I3). */
  mcp?: McpSets;
}
