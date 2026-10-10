import type { Workspace, WorkspaceUsage } from './workspace.js';

/** What the live socket carries. One socket per tab; pages subscribe to the topics they show. */
export type LiveTopic = 'workspaces' | 'usage' | 'accounts' | 'system';

export const LIVE_TOPICS: readonly LiveTopic[] = ['workspaces', 'usage', 'accounts', 'system'];

/** `GET /api/live` upgrades to the live WebSocket (same session cookie as the API). */
export const LIVE_PATH = '/api/live';

/** Browser → portal: every topic this tab wants now (replaces the previous set). */
export interface LiveSubscribe {
  type: 'subscribe';
  topics: LiveTopic[];
}

/**
 * Portal → browser. `workspaces` and `usage` carry the data itself, sent when it changes; `accounts`
 * and `system` mean "changed, load it again".
 */
export type LiveMessage =
  | { type: 'workspaces'; data: Workspace[] }
  | { type: 'usage'; data: WorkspaceUsage[] }
  | { type: 'accounts' }
  | { type: 'system' };
