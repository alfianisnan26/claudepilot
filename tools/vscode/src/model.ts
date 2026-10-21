// What the views show, as plain data: the Agents tree, the Tickets groups, the status bar's text and an approval's review text. Pure (no
// `vscode` import), so the tests check them directly. Every string from the portal that an agent or a workspace wrote (titles, summaries,
// request text) is shown as PLAIN TEXT by the views: tree labels, plain tooltips and notification text are never Markdown or HTML.

import type { VscodeAgent, VscodeApproval, VscodeStatus, VscodeTicket } from '../../../packages/contracts/src/vscode.js';

/* ---------- Agents ---------- */

export interface AgentNode {
  agent: VscodeAgent;
  children: AgentNode[];
}

/**
 * Leads at the top, each with its workers under it (any depth). A worker whose parent is not in the list (ended, or not visible) is shown at
 * the top, so nothing is hidden. Order follows the portal's (waiting first, then the newest activity).
 */
export function agentTree(agents: readonly VscodeAgent[]): AgentNode[] {
  const nodes = new Map(agents.map((a) => [a.id, { agent: a, children: [] as AgentNode[] }]));
  // The links made so far: a new one that would close a loop (a parent chain that comes back) is not made, so a loop is cut once.
  const up = new Map<string, string>();
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    for (let cur: string | undefined = from; cur && !seen.has(cur); cur = up.get(cur)) {
      if (cur === target) return true;
      seen.add(cur);
    }
    return false;
  };
  const roots: AgentNode[] = [];
  for (const a of agents) {
    const node = nodes.get(a.id)!;
    const parent = a.parentId && a.parentId !== a.id ? nodes.get(a.parentId) : undefined;
    if (parent && !reaches(parent.agent.id, a.id)) {
      parent.children.push(node);
      up.set(a.id, parent.agent.id);
    } else roots.push(node);
  }
  return roots.filter((n) => !up.has(n.agent.id));
}

/** One line under the title: ticket, state, model and cost. */
export function agentDescription(a: VscodeAgent): string {
  const parts: string[] = [];
  const ticket = a.ticketKey ?? a.ticketId;
  if (ticket) parts.push(ticket);
  parts.push(a.waiting > 0 ? `${a.state} (${a.waiting})` : a.state);
  if (a.model) parts.push(shortModel(a.model));
  parts.push(a.costBasis === 'unavailable' ? `$${a.costUsd.toFixed(2)}+` : `$${a.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

/** `claude-opus-5-5` → `opus-5-5`: the family and version are what tell models apart in a narrow tree. */
export const shortModel = (m: string): string => m.replace(/^claude-/, '').replace(/\[.*\]$/, '');

/** A codicon per state. */
export const STATE_ICON: Record<VscodeAgent['state'], string> = {
  waiting: 'bell-dot',
  working: 'sync~spin',
  starting: 'loading~spin',
  idle: 'circle-outline',
  interrupted: 'debug-pause',
  ended: 'circle-slash',
};

/* ---------- Tickets ---------- */

export const TICKET_STATUS_ORDER = ['in_progress', 'in_review', 'blocked', 'open', 'done', 'wont_do'] as const;
export const TICKET_STATUS_LABEL: Record<VscodeTicket['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  done: 'Done',
  wont_do: 'Won’t do',
};

export interface TicketGroup {
  bucket: string;
  count: number;
  statuses: { status: VscodeTicket['status']; tickets: VscodeTicket[] }[];
}

/** By bucket (alphabetical), then by status (work in flight first), keeping the portal's order (most urgent first) inside each. */
export function ticketGroups(tickets: readonly VscodeTicket[]): TicketGroup[] {
  const byBucket = new Map<string, VscodeTicket[]>();
  for (const t of tickets) byBucket.set(t.bucket, [...(byBucket.get(t.bucket) ?? []), t]);
  return [...byBucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, list]) => ({
      bucket,
      count: list.length,
      statuses: TICKET_STATUS_ORDER.map((status) => ({ status, tickets: list.filter((t) => t.status === status) })).filter((g) => g.tickets.length > 0),
    }));
}

/* ---------- Status bar ---------- */

export interface StatusView {
  text: string;
  tooltip: string;
  /** Show it as a warning (a window at 80 % or more, or something waits on you). */
  warn: boolean;
}

/** `$(dashboard) 61%  $(bell-dot) 3`. A missing number is "unavailable", never 0 %. */
export function statusView(s: VscodeStatus | null, o: { signedIn: boolean; error?: string | null } = { signedIn: true }): StatusView {
  if (!o.signedIn) return { text: '$(account) ClaudePilot', tooltip: 'Sign in to the portal', warn: false };
  if (!s) return { text: '$(dashboard) …', tooltip: o.error ?? 'Loading', warn: false };
  const pct = s.quota?.usedPct;
  const quota = pct === null || pct === undefined ? '$(dashboard) —' : `$(dashboard) ${Math.round(pct)}%`;
  const waits = s.attention ?? s.approvals;
  const text = waits > 0 ? `${quota}  $(bell-dot) ${waits}` : quota;
  const lines: string[] = [];
  if (s.quota) lines.push(`${s.quota.claudeName}: ${s.quota.label} ${pct === null || pct === undefined ? 'unavailable' : `${Math.round(pct)}%`}${s.quota.resetsAt ? `, resets ${new Date(s.quota.resetsAt).toLocaleString()}` : ''}`);
  else lines.push('Usage unavailable');
  for (const c of s.claudes) {
    if (c.claudeId === s.quota?.claudeId) continue;
    const w = c.windows.map((x) => `${x.label} ${x.usedPct === null ? '—' : `${Math.round(x.usedPct)}%`}`).join(', ');
    lines.push(`${c.claudeName}: ${w || 'unavailable'}`);
  }
  lines.push(s.attention === null ? `Needs you: unavailable (${s.approvals} approvals)` : `Needs you: ${s.attention} (${s.approvals} approvals)`);
  if (o.error) lines.push(o.error);
  return { text, tooltip: lines.join('\n'), warn: (pct ?? 0) >= 80 || waits > 0 };
}

/* ---------- Approvals ---------- */

/** One line for the notification: who asks and what, cut short (the WHOLE text is shown before anything can be allowed). */
export function approvalHeadline(a: VscodeApproval): string {
  const who = oneLine(a.sessionTitle, 60);
  const what = oneLine(a.title, 80);
  return `${who}: ${what}${a.toolName ? ` (${oneLine(a.toolName, 40)})` : ''}`;
}

/** The review document: what asks, then the whole text exactly as it will run. */
export function approvalDocument(a: VscodeApproval): string {
  const head = [
    `Agent:     ${oneLine(a.sessionTitle, 200)}`,
    `Workspace: ${a.workspaceId}`,
    `Asks:      ${oneLine(a.title, 200)}${a.toolName ? ` (${a.toolName})` : ''}`,
    `Asked at:  ${a.createdAt}`,
    a.allowable ? 'This is the whole request. Allow or deny it in the dialog.' : `${a.note ?? 'It can’t be allowed.'} It can only be denied.`,
    '',
    '----- request -----',
  ];
  return `${head.join('\n')}\n${a.full ?? '(nothing to show)'}\n`;
}

/** Control characters and line breaks folded to spaces, then cut: for one-line places (labels, notifications). */
export function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
