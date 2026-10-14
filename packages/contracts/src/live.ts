import type { LivePresence } from './notify.js';
import type { Workspace, WorkspaceUsage } from './workspace.js';

/** What the live socket carries. One socket per tab; pages subscribe to the topics they show. */
export type LiveTopic = 'workspaces' | 'usage' | 'accounts' | 'system' | 'pools' | 'tickets' | 'ci' | 'claudeusage' | 'repos' | 'glance' | 'claudeversion' | 'notify' | 'triggers' | 'autotransfer' | 'connect' | 'attention' | 'keepgoing';

export const LIVE_TOPICS: readonly LiveTopic[] = ['workspaces', 'usage', 'accounts', 'system', 'pools', 'tickets', 'ci', 'claudeusage', 'repos', 'glance', 'claudeversion', 'notify', 'triggers', 'autotransfer', 'connect', 'attention', 'keepgoing'];

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
  | { type: 'claudeusage' }
  /** A workspace's repositories were scanned and something changed, or one was made or removed (workspace-git PRD): load them again. */
  | { type: 'repos' }
  /** What a glance widget shows changed (a session's state, an approval, a worker, a ticket, a CI run; glance-widgets PRD): load the snapshot again. */
  | { type: 'glance' }
  /** A canary ran or finished, a warning changed, an upgrade or rollback moved on, or an image was built (claude-version-pinning PRD): load it again. */
  | { type: 'claudeversion' }
  /** A notification arrived, was read or was dealt with, or a destination changed (PWA PRD §11): load the Inbox and the setup again. */
  | { type: 'notify' }
  /** A trigger or one of its runs changed (triggers PRD): load them again. */
  | { type: 'triggers' }
  /** An automatic move happened, was suggested or undone, or its settings changed (auto-transfer PRD): load them again. */
  | { type: 'autotransfer' }
  /** A target, node or enrollment changed, or a node connected or dropped (Connect PRD FR58): load the registry again. */
  | { type: 'connect' }
  /** Something that waits for a person appeared or was resolved (Needs you, attention PRD): load the list again. */
  | { type: 'attention' }
  /** Keep going acted on a chat, or a watched chat's state changed (chat-sessions PRD §23, T-259): load the Autonomy card again. */
  | { type: 'keepgoing' };

/** Browser → portal on the live socket: a subscription, or this tab's presence (`LivePresence`, PWA PRD §11.2). */
export type LiveClientMessage = LiveSubscribe | LivePresence;
