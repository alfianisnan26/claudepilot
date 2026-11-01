// Every module's declarations in one call (organizations slice 1, P4). The policy table is the union of each module's `authz.ts`; until now
// some modules declared when their routes were made, others when their service or their tools were (index.ts), so the table the app runs
// with depended on what had been constructed. `createApp` calls this once, so the central route check (authz/routeGuard.ts) and the tool
// dispatch (`requireToolPolicy`) always see the whole table, and the enumeration tests (authz/routeTable.test.ts) read the same one.
// Each call is idempotent (the same table declared twice is a no-op; a key declared twice differently throws at start-up).

import { declareAccountPolicies } from '../accounts/authz.js';
import { declareAppPortPolicies } from '../appports/authz.js';
import { declareApprovalPolicies } from '../approvals/authz.js';
import { declareAttentionPolicies } from '../attention/authz.js';
import { declareAutoTransferPolicies } from '../autotransfer/authz.js';
import { declareBrowserPolicies } from '../browser/authz.js';
import { declareChatManagerPolicies, declareChatPolicies } from '../chat/authz.js';
import { declareCiPolicies } from '../ci/authz.js';
import { declareClaudeUsagePolicies } from '../claudeusage/authz.js';
import { declareClaudeVersionPolicies } from '../claudeversion/authz.js';
import { declareCodespacesPolicies } from '../codespaces/authz.js';
import { declareConnectPolicies } from '../connect/authz.js';
import { declareInstallPolicies } from '../connect/install/routes.js';
import { declareFlowPolicies } from '../flow/authz.js';
import { declareGlancePolicies } from '../glance/authz.js';
import { declareIdentityPolicies } from '../identity/authz.js';
import { declareKeepGoingPolicies } from '../keepgoing/authz.js';
import { declareKnowledgePolicies } from '../knowledge/authz.js';
import { declareLabPolicies } from '../lab/authz.js';
import { declareMcpPolicies } from '../mcp/authz.js';
import { declareNotifyPolicies } from '../notify/authz.js';
import { declareOrgPolicies } from '../orgs/authz.js';
import { declarePersonaPolicies } from '../personas/authz.js';
import { declarePlatformDoorPolicies } from '../platform/authz.js';
import { declarePoolRoutePolicies, declarePoolToolPolicies, declareWorkspacePoolPolicies } from '../pools/authz.js';
import { declarePortalMcpPolicies } from '../portalmcp/authz.js';
import { declareRepoPolicies, declareWorkspaceReposPolicies } from '../repos/authz.js';
import { declareReporterPolicies } from '../reporter/authz.js';
import { declareSchedulesPolicies } from '../schedules/authz.js';
import { declareSecretRotationPolicies, declareWorkspaceSecretsPolicies } from '../secrets/authz.js';
import { declareSettingsPolicies } from '../settings/authz.js';
import { declareSkillPolicies } from '../skills/authz.js';
import { declareTicketPolicies } from '../tickets/authz.js';
import { declareTriggerPolicies } from '../triggers/authz.js';
import { declareUsageSpendPolicies } from '../usagespend/authz.js';
import { declareVscodePolicies } from '../vscode/authz.js';
import { declareWorkspacePolicies } from '../workspaces/authz.js';
import { declareToolTablePolicies } from './toolPolicies.js';

export function declareAllPolicies(): void {
  declareIdentityPolicies();
  declarePlatformDoorPolicies();
  declareAppPortPolicies();
  declareWorkspacePolicies();
  declareWorkspacePoolPolicies();
  declarePoolRoutePolicies();
  declarePoolToolPolicies();
  declareWorkspaceSecretsPolicies();
  declareSecretRotationPolicies();
  declareWorkspaceReposPolicies();
  declareRepoPolicies();
  declareBrowserPolicies();
  declareAccountPolicies();
  declareKnowledgePolicies();
  declarePersonaPolicies();
  declareSkillPolicies();
  declareMcpPolicies();
  declareClaudeUsagePolicies();
  declareUsageSpendPolicies();
  declareChatPolicies();
  declareChatManagerPolicies();
  declareTicketPolicies();
  declareCiPolicies();
  declareClaudeVersionPolicies();
  declareCodespacesPolicies();
  declareConnectPolicies();
  declareInstallPolicies();
  declareApprovalPolicies();
  declareAttentionPolicies();
  declareGlancePolicies();
  declareLabPolicies();
  declareSettingsPolicies();
  declareVscodePolicies();
  declarePortalMcpPolicies();
  declareReporterPolicies();
  declareOrgPolicies();
  declareNotifyPolicies();
  declareTriggerPolicies();
  declareSchedulesPolicies();
  declareFlowPolicies();
  declareKeepGoingPolicies();
  declareAutoTransferPolicies();
  declareToolTablePolicies();
}
