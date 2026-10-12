import { BROWSER_RULE_TOOLS } from '@portal/contracts';

/** The tools a pool can set a rule for, as the editor lists them (devtools' network tools included). */
export const RULE_TOOLS: readonly string[] = [...BROWSER_RULE_TOOLS, 'list_network_requests', 'get_network_request'];
