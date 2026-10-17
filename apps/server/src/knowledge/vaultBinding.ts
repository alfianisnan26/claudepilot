// T-436: the three lines that tie the agent tokens to the vaults' workspace lists. index.ts calls this one function, so a test can
// prove the wiring (deleting the call, or any of its lines, turns `vaultBinding.test.ts` red).

import type { AgentAccess } from '../portalmcp/agents.js';
import type { KnowledgeService } from './service.js';

/**
 * A session's token is bound at mint to the vaults that name its workspace (`vaultsFor`); a change of a vault's list rebinds the live
 * tokens (`onAgentWorkspacesChange`); a rebind that throws shuts every live token out of the vaults (`onAgentWorkspacesFailClosed`).
 */
export function wireVaultBinding(
  agents: Pick<AgentAccess, 'rebindVaults' | 'closeVaults'> & { vaultsFor?: AgentAccess['vaultsFor'] },
  knowledge: Pick<KnowledgeService, 'vaultsForWorkspace' | 'onAgentWorkspacesChange' | 'onAgentWorkspacesFailClosed'>,
): void {
  agents.vaultsFor = (ws) => knowledge.vaultsForWorkspace(ws);
  knowledge.onAgentWorkspacesChange = () => void agents.rebindVaults();
  knowledge.onAgentWorkspacesFailClosed = () => void agents.closeVaults();
}
