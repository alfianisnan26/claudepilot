// Usage spend (docs/prd/claude-usage.md §21 to §26): who spent what, budgets with alerts and spike detection. index.ts builds one, hands the chat
// controller its three hooks (`onUsage`, `onLaunch`, `sendGate`), registers the Portal MCP tools and gives app.ts the routes.

import { UsageSpend, type SpendOptions } from './service.js';

export { UsageSpend, USAGE_BUDGET } from './service.js';
export type { SpendOptions } from './service.js';
export { createUsageSpendRoutes } from './routes.js';
export { registerUsageSpendTools } from './portalTools.js';
export { SPEND_SETTING } from './settings.js';
export { OWNER_ACTOR, UI_OWNER } from './actor.js';
export type { SpendObject, Visibility, Who } from './actor.js';

export function createUsageSpend(options: SpendOptions): UsageSpend {
  return new UsageSpend(options);
}
