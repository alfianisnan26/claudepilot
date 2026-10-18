// FR19 (T-356): the portal's registry refuses a tool with no declared access policy, so every module that declares tool policies declares them
// BEFORE the tools are registered. Most modules declare in their route setup, which runs after registration at startup; this is the one place
// that declares them all first. Declaring twice with the same table is a no-op (the seam only refuses a different one). The attention and CI
// tools declare inside their own register function, and the chat tools in `registerChatAuthz` (index.ts calls it before this).
import { declareAutoTransferPolicies } from '../autotransfer/authz.js';
import { declareClaudeVersionPolicies } from '../claudeversion/authz.js';
import { declareCiPolicies } from '../ci/authz.js';
import { declareKeepGoingPolicies } from '../keepgoing/authz.js';
import { declareLabPolicies } from '../lab/authz.js';
import { declareNotifyPolicies } from '../notify/authz.js';
import { declareTicketPolicies } from '../tickets/authz.js';
import { declareTriggerPolicies } from '../triggers/authz.js';
import { declareWorkspacePolicies } from '../workspaces/authz.js';
import { declarePortalMcpPolicies } from './authz.js';

export function declareAllToolPolicies(): void {
  declarePortalMcpPolicies();
  declareCiPolicies();
  declareClaudeVersionPolicies();
  declareKeepGoingPolicies();
  declareAutoTransferPolicies();
  declareWorkspacePolicies();
  declareLabPolicies();
  declareNotifyPolicies();
  declareTicketPolicies();
  declareTriggerPolicies();
}
