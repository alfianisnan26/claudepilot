import { registerAccountTools } from './accounts.js';
import { registerBuiltinTools } from './builtin.js';
import { registerCatalogTools } from './catalog.js';
import type { PortalToolDeps } from './deps.js';
import { registerMonitorTools } from './monitor.js';
import { registerPoolTools } from './pools.js';
import { registerPortalTools } from './portal.js';
import { registerSessionTools } from './sessions.js';
import { registerWorkspaceTools } from './workspaces.js';

export type { PortalToolDeps } from './deps.js';

/**
 * The built-in tools (portal-mcp PRD §13): thin adapters over the portal's own services. Other areas add
 * theirs from their own `portalTools.ts` through `registerPortalTool` (portalmcp/registry.ts, interface I2).
 * Call once from index.ts, after the services exist.
 */
export function registerBuiltInPortalTools(deps: PortalToolDeps): void {
  registerPortalTools(deps);
  registerWorkspaceTools(deps);
  registerSessionTools(deps);
  registerPoolTools(deps);
  registerAccountTools(deps);
  registerMonitorTools(deps);
  registerCatalogTools(deps);
  registerBuiltinTools(deps);
}
