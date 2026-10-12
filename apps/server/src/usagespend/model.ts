// Usage spend: the plain rows the pure parts work on (docs/prd/claude-usage.md §21). The store turns the portal's tables into these.

import type { ChatSessionState, ChatUsageTotals } from '@portal/contracts';

/** One `chat_usage` row: what one model used in one finished turn (the turn's sub-agents included). The first row of a turn carries its request. */
export interface UsageRow {
  atMs: number;
  sessionId: string;
  workspaceId: string;
  /** The Claude the turn ran on. A turn recorded without one (before Claudes existed) is already under its workspace's Default Claude. */
  claudeId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** 1 on a turn's first row, else 0: the sum is the number of finished turns. */
  requests: number;
  agents: number;
}

/** What is known of a session now: its live row, else what was kept from its last request (it was deleted). */
export interface SessionInfo {
  sessionId: string;
  workspaceId: string;
  claudeId: string;
  parentId: string | null;
  ticketId: string | null;
  title: string;
  state: ChatSessionState | null;
  /** False once the session is deleted. */
  exists: boolean;
}

/** The persona a session's workspace had assigned when its process started; `personaId` null: none was. */
export interface PersonaRecord {
  atMs: number;
  personaId: string | null;
  name: string | null;
  revision: number | null;
}

export const zeroTotals = (): ChatUsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 });

export function addRow(into: ChatUsageTotals, r: Pick<UsageRow, 'costUsd' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'requests' | 'agents'>): void {
  into.costUsd += r.costUsd;
  into.input += r.input;
  into.output += r.output;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.requests += r.requests;
  into.agents += r.agents;
}

export function addTotals(into: ChatUsageTotals, t: ChatUsageTotals): void {
  addRow(into, t);
}

/** The one place a dollar sum is cleaned of floating-point dust: a millionth of a dollar. */
export const roundUsd = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Most dollars first, then most requests, then the label (so equal rows keep a fixed order). */
export const byCostDesc = <T extends { total: ChatUsageTotals; label: string }>(a: T, b: T): number =>
  b.total.costUsd - a.total.costUsd || b.total.requests - a.total.requests || a.label.localeCompare(b.label);
