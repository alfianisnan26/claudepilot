import {
  CLAUDE_VERSION_API,
  type ClaudeApplyRequest,
  type ClaudeCanaryRequest,
  type ClaudeCanaryRun,
  type ClaudeOperation,
  type ClaudeUpgradePlan,
  type ClaudeVersionOverview,
  type ClaudeWorkspaceVersion,
} from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

/** Claude Code version pinning and the canary (claude-version-pinning PRD). The workspace id is `<target>/<name>`. */
export const versionApi = {
  overview: () => poolRequest<ClaudeVersionOverview>('GET', CLAUDE_VERSION_API.overview),
  runs: (limit = 10) => poolRequest<ClaudeCanaryRun[]>('GET', `${CLAUDE_VERSION_API.canary}?limit=${limit}`),
  run: (id: number) => poolRequest<ClaudeCanaryRun>('GET', CLAUDE_VERSION_API.canaryRun(id)),
  startCanary: (body: ClaudeCanaryRequest) => poolRequest<ClaudeCanaryRun>('POST', CLAUDE_VERSION_API.canary, body),
  refreshCandidate: () => poolRequest<unknown>('POST', CLAUDE_VERSION_API.candidate),
  workspace: (id: string) => poolRequest<ClaudeWorkspaceVersion>('GET', CLAUDE_VERSION_API.workspace(id)),
  plan: (id: string, version: string) => poolRequest<ClaudeUpgradePlan>('GET', `${CLAUDE_VERSION_API.plan(id)}?version=${encodeURIComponent(version)}`),
  apply: (id: string, body: ClaudeApplyRequest) => poolRequest<ClaudeOperation>('POST', CLAUDE_VERSION_API.apply(id), body),
  rollback: (id: string) => poolRequest<ClaudeOperation>('POST', CLAUDE_VERSION_API.rollback(id), { confirm: true }),
};
