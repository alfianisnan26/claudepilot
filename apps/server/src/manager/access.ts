// T-968 (review 2026-10-18): how the General Manager's process gets its portal tools, and how it heals after a sign-out. Pure wiring, kept
// out of index.ts and app.ts so a test reaches it (manager/access.test.ts).
// - managerAccess: the person's `cpmt_` token goes into the manager's process ONLY while the person is signed in somewhere (a sign-out
//   revokes it, Q3; a later wake of the process must not mint it again). claude.ai's own connectors stay out of that process.
// - managerHealer: at a sign-in, a manager whose token is gone is restarted at its turn's end, so its new process gets a fresh token.

import type { ChatSession } from '@portal/contracts';
import type { ChatAgentGrant, ChatManagerAccess } from '../chat/controller.js';
import { AGENT_MCP_CONFIG } from '../portalmcp/agents.js';

export interface ManagerAccessDeps {
  /** Whether the person is signed in on any device now (Portal.signedIn). */
  signedIn(userId: string): boolean;
  /** The portal's MCP URL as the workspace reaches it; null when there is none. */
  url(workspaceId: string): Promise<string | null | undefined>;
  tokens: {
    mint(req: { userId: string; sessionId: string }, opts?: { keepOthers?: boolean }): { tokenId: string; secret: string } | null;
    settle(sessionId: string, tokenId: string, started: boolean): void;
  };
  brief(): string;
}

export function managerAccess(d: ManagerAccessDeps): ChatManagerAccess {
  return {
    mint: async ({ workspaceId, sessionId, ownerId }): Promise<ChatAgentGrant | null> => {
      if (!d.signedIn(ownerId)) return null;
      const url = await d.url(workspaceId);
      if (!url) return null;
      const t = d.tokens.mint({ userId: ownerId, sessionId }, { keepOthers: true });
      if (!t) return null;
      return {
        env: { PILOT_MCP_TOKEN: t.secret, PILOT_MCP_URL: url, PILOT_SESSION_ID: sessionId, PILOT_WORKSPACE_ID: workspaceId, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        mcpConfig: AGENT_MCP_CONFIG,
        tokenId: t.tokenId,
      };
    },
    settle: (sessionId, tokenId, started) => d.tokens.settle(sessionId, tokenId, started),
    brief: d.brief,
  };
}

export interface ManagerHealerDeps {
  managerOf(ownerId: string): ChatSession | null;
  /** Whether the manager session holds a token that still works; undefined when Portal MCP is not wired (nothing to heal). */
  hasLive?: (sessionId: string) => boolean;
  restart(sessionId: string, opts: { why: 'mcp'; when: 'turn_end'; actor: string; from: 'auto' }): Promise<unknown>;
}

/** A manager that is live but holds no working token is restarted at its turn's end; one with a token, or none at all, is left alone. */
export function managerHealer(d: ManagerHealerDeps): (ownerId: string) => void {
  return (ownerId) => {
    const m = d.managerOf(ownerId);
    if (!m || m.state === 'ended' || !d.hasLive || d.hasLive(m.id)) return;
    void d.restart(m.id, { why: 'mcp', when: 'turn_end', actor: 'portal:manager', from: 'auto' }).catch(() => undefined);
  };
}
