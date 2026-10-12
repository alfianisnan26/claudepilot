import type { Workspace, WorkspaceUsage } from './workspace.js';

/** What the live socket carries. One socket per tab; pages subscribe to the topics they show. */
export type LiveTopic = 'workspaces' | 'usage' | 'accounts' | 'system' | 'pools' | 'tickets' | 'ci' | 'claudeusage';

export const LIVE_TOPICS: readonly LiveTopic[] = ['workspaces', 'usage', 'accounts', 'system', 'pools', 'tickets', 'ci', 'claudeusage'];

/** `GET /api/live` upgrades to the live WebSocket (same session cookie as the API). */
export const LIVE_PATH = '/api/live';

/** Browser → portal: every topic this tab wants now (replaces the previous set). */
export interface LiveSubscribe {
  type: 'subscribe';
  topics: LiveTopic[];
}

/**
 * Portal → browser. `workspaces` and `usage` carry the data itself, sent when it changes; `accounts`,
 * `system` and `pools` (multi-assignment pools and their assignments) mean "changed, load it again".
 */
export type LiveMessage =
  | { type: 'workspaces'; data: Workspace[] }
  | { type: 'usage'; data: WorkspaceUsage[] }
  | { type: 'accounts' }
  | { type: 'system' }
  | { type: 'pools' }
  /** A ticket was made or changed (tickets PRD FR24): load the list again. */
  | { type: 'tickets' }
  /** A CI run or remote changed (local-git-ci PRD): load the runs again. */
  | { type: 'ci' }
  /** A Claude's plan usage was read, or an alert fired (claude-usage PRD): load the snapshot again. */
  | { type: 'claudeusage' };
