// T-375 (the owner, 2026-10-15: "aku pengen tau juga informasi bar quota, dan model yang sedang digunakan, buat lebih compact tapi clean dan
// tidak bloated"): what a row of the Sessions list shows, apart from React so every rule is tested (rowMeta.test.ts). A row is two lines:
// the title with its marks and time, then one muted line of facts in priority order (LINE_TWO_ORDER: what does not fit is dropped whole).
// A third line only when it carries something: the open request. A label that is the
// same on every row says nothing, so the workspace shows only when the rows span several, and a persona's avatar only when they have
// several personas. Every number has a source: the quota bar is the Claude's 5-hour window from the claude-usage readings (the same
// snapshot as the top bar's chip), "unavailable" when the reading is missing, old or past its reset; never a guess.
import {
  reasonText,
  sessionCost,
  workspaceLabel,
  type ChatSession,
  type ClaudeUsage,
  type ListGroupBy,
  type ListRow,
  type PersonaIdentity,
} from '@portal/contracts';
import { agoText, leftText, localTime } from '../usage/claude/format';
import { roleOf } from './crewLimits';
import { modelShortName } from './modelName';

/** Percent used of the 5-hour window at and above which the bar turns amber, then red (the ticket's tones: below 70 neutral). */
export const QUOTA_TONE_AT = { warn: 70, critical: 90 } as const;

export type QuotaTone = 'neutral' | 'warn' | 'critical';

/**
 * The mini quota bar. `plan`: a measured percent of the 5-hour window. `unavailable`: a grey bar, no number (no reading, an old one, a window
 * past its reset, not signed in). `no_limits`: a pool or an API key, nothing to run out of, so no bar. `title` says it all in words.
 */
export type QuotaMeter =
  | { kind: 'plan'; usedPct: number; tone: QuotaTone; title: string }
  | { kind: 'unavailable'; title: string }
  | { kind: 'no_limits'; title: string };

export const quotaTone = (usedPct: number): QuotaTone =>
  usedPct >= QUOTA_TONE_AT.critical ? 'critical' : usedPct >= QUOTA_TONE_AT.warn ? 'warn' : 'neutral';

/** A window's reading at `nowMs`: null when it has no number or its reset passed (the number belongs to an old period). */
function windowNow(c: ClaudeUsage, key: string, nowMs: number): { usedPct: number; resetsAt: string | null } | null {
  const w = c.windows.find((x) => x.key === key);
  if (!w || w.usedPct === null || w.level === 'reset' || w.level === 'unknown') return null;
  if (w.resetsAt && Date.parse(w.resetsAt) <= nowMs) return null;
  return { usedPct: w.usedPct, resetsAt: w.resetsAt };
}

const pct = (v: number) => `${Math.round(v)} %`;
const resets = (iso: string | null, nowMs: number) => (iso ? `, resets ${localTime(iso, nowMs)} (in ${leftText(iso, nowMs)})` : '');

/**
 * The Claude's quota bar for a row, from its claude-usage row (`usage`, null while the snapshot loads or when the portal does not list the
 * Claude). The 5-hour window leads; the title adds the week, the reset times and the reading's age.
 */
export function quotaMeter(claudeName: string, usage: ClaudeUsage | null | undefined, nowMs: number): QuotaMeter {
  const who = `Quota, ${claudeName}`;
  const unavailable = (why: string): QuotaMeter => ({
    kind: 'unavailable',
    title: `${who}: unavailable (${why.replace(/\.$/, '').toLowerCase()})`,
  });
  if (!usage) return unavailable('Not read yet.');
  if (usage.runsOn === 'pool' || usage.runsOn === 'key')
    return { kind: 'no_limits', title: `${who}: no plan limits (a pool or an API key)` };
  if (usage.runsOn === 'none') return unavailable('Not signed in.');
  const age = usage.checkedAt ? `read ${agoText(usage.checkedAt, nowMs)}` : '';
  // A chat answered with Claude Code's limit message: measured, the Claude is used up until then (T-255).
  const report = usage.limitReport && Date.parse(usage.limitReport.until) > nowMs ? usage.limitReport : null;
  if (report)
    return {
      kind: 'plan',
      usedPct: 100,
      tone: 'critical',
      title: `${who}: used up (${report.label}), back ${localTime(report.until, nowMs)}`,
    };
  if (usage.unavailable) return unavailable(reasonText(usage.unavailable));
  if (usage.stale) return unavailable(`The reading is old${age ? `, ${age}` : ''}.`);
  const session = windowNow(usage, 'session', nowMs);
  if (!session) return unavailable(reasonText('no_number'));
  const week = windowNow(usage, 'week', nowMs);
  const parts = [`5-hour ${pct(session.usedPct)} used${resets(session.resetsAt, nowMs)}`];
  if (week) parts.push(`week ${pct(week.usedPct)} used${resets(week.resetsAt, nowMs)}`);
  if (age) parts.push(age);
  return { kind: 'plan', usedPct: session.usedPct, tone: quotaTone(session.usedPct), title: `${who}: ${parts.join('; ')}` };
}

/** How full the bar is drawn: 0 to 100 (a window over 100 % is drawn full; the number says the rest). */
export const barWidth = (usedPct: number): number => Math.max(0, Math.min(100, usedPct));

/** What the rows on screen have in common: how many workspaces and how many personas they span (lead headers and nested rows included). */
export interface ListFacts {
  workspaces: number;
  personas: number;
}

export function listFacts(rows: readonly ListRow[], personas: Readonly<Record<string, PersonaIdentity>> | null | undefined): ListFacts {
  const workspaces = new Set<string>();
  const people = new Set<string>();
  const walk = (list: readonly ListRow[]) => {
    for (const r of list) {
      if (r.earlier) continue;
      workspaces.add(r.session.workspaceId);
      const p = r.workspaceGone ? null : personas?.[r.session.workspaceId];
      if (p) people.add(p.poolId);
      walk(r.children);
    }
  };
  walk(rows);
  return { workspaces: workspaces.size, personas: people.size };
}

/**
 * The workspace label on a row: only when the rows span more than one workspace, and not under a workspace's own heading. The list asks it
 * per card (a group's rows), so a card whose rows share one workspace does not repeat it on each.
 */
export const workspaceShown = (facts: ListFacts, groupBy: ListGroupBy): boolean => facts.workspaces > 1 && groupBy !== 'workspace';

/** The persona's avatar as a row's icon: only when the rows have more than one persona (one avatar on every row tells nothing apart). */
export const avatarsShown = (facts: ListFacts): boolean => facts.personas > 1;

/** The role to show on line one, or null: none set, or the title already starts with it ("konfersi-web" titled "konfersi-web: …"). */
export function roleShown(s: Pick<ChatSession, 'agent' | 'title'>): string | null {
  const role = roleOf(s);
  if (!role) return null;
  return (s.title ?? '').trim().toLowerCase().startsWith(role.toLowerCase()) ? null : role;
}

/** The state as line two says it: a dot and a word. `busy` spins, `ask` is amber, `danger` red, `quiet` muted. */
export interface RowState {
  word: string;
  tone: 'busy' | 'ask' | 'danger' | 'quiet';
  /** Sub-agents and background tasks still running, said from 640 px ("Working · 2 agents"). */
  agents: number;
  /** Why it waits for a slot (the server's `slotWait` line, "Waiting for a slot · 4 of 4 running in …"); a tip says it. */
  why?: string;
}

/** The one-word label for a session waiting for a slot (T-425); the full "Waiting for a slot · …" line is its explanation. */
export const SLOT_WAIT_WORD = 'Queued';

const WORDS: Record<ChatSession['state'], string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you',
  interrupted: 'Interrupted',
  ended: 'Ended',
};

/** `safety`: the label when the portal ended it for safety or integrity (`endedForSafety`). */
export function rowState(
  s: Pick<ChatSession, 'state' | 'waiting' | 'switching' | 'agentsRunning' | 'slotWait'>,
  workspaceGone: boolean,
  safety: string | null,
): RowState {
  if (workspaceGone) return { word: 'Removed', tone: 'danger', agents: 0 };
  if (safety) return { word: safety, tone: 'danger', agents: 0 };
  if (s.switching) return { word: 'Moving', tone: 'busy', agents: 0 };
  if (s.waiting > 0 || s.state === 'waiting') return { word: s.waiting > 1 ? `${s.waiting} waiting` : 'Needs you', tone: 'ask', agents: 0 };
  // T-425: a start or wake waiting for a slot (T-417) says so, in one word; the session's own line has the full text.
  if (s.slotWait && s.state !== 'ended') return { word: SLOT_WAIT_WORD, tone: 'busy', agents: 0, why: s.slotWait };
  const tone = s.state === 'working' || s.state === 'starting' ? 'busy' : s.state === 'interrupted' ? 'ask' : 'quiet';
  return { word: WORDS[s.state], tone, agents: s.state === 'working' ? (s.agentsRunning ?? 0) : 0 };
}

export interface RowMetaInput {
  session: ChatSession;
  groupBy: ListGroupBy;
  /** {@link workspaceShown} for the rows on screen. */
  showWorkspace: boolean;
  /** The Claude's claude-usage row; null while the snapshot loads or when the Claude is not listed. */
  usage: ClaudeUsage | null | undefined;
  nowMs: number;
  /** The lead a worker sits under (its row or header is right above); a worker on the same Claude does not repeat it (T-294, T-375). */
  lead?: Pick<ChatSession, 'claudeId' | 'claudeName'> | null;
}

/** The same Claude: by id when both have one, else by name. */
const sameClaude = (a: Pick<ChatSession, 'claudeId' | 'claudeName'>, b: Pick<ChatSession, 'claudeId' | 'claudeName'>) =>
  a.claudeId && b.claudeId ? a.claudeId === b.claudeId : !!a.claudeName && a.claudeName === b.claudeName;

/** Line two's facts (and line three's). Null where there is nothing to say; never a made-up value. */
export interface RowMeta {
  model: { label: string; title: string } | null;
  /** `name` is null under a Claude's own heading (the heading says it); the bar stays. Null for a worker on its lead's Claude. */
  claude: { name: string | null; meter: QuotaMeter } | null;
  cost: { usd: number; estimate: boolean } | null;
  workspace: { label: string; title: string } | null;
  branch: { label: string; title: string } | null;
  ticket: string | null;
  waitingFor: string | null;
}

export function rowMeta({ session: s, groupBy, showWorkspace, usage, nowMs, lead }: RowMetaInput): RowMeta {
  const label = modelShortName(s.model);
  const model = label ? { label, title: `Model: ${s.model}${s.effort ? `, effort ${s.effort}` : ''}` } : null;
  const claudeName = s.claudeName ?? usage?.claudeName ?? null;
  const claude =
    (s.claudeId || claudeName) && !(lead && sameClaude(s, lead))
      ? { name: groupBy === 'claude' ? null : claudeName, meter: quotaMeter(claudeName ?? 'this Claude', usage, nowMs) }
      : null;
  const c = sessionCost(s);
  return {
    model,
    claude,
    cost: c.usd > 0 ? { usd: c.usd, estimate: c.basis === 'estimate' } : null,
    workspace: showWorkspace ? { label: workspaceLabel(s.workspaceId), title: s.workspaceId } : null,
    branch: s.worktree && groupBy !== 'worktree' ? { label: s.worktree.branch, title: s.worktree.path } : null,
    ticket: s.ticketId && groupBy !== 'ticket' ? s.ticketId : null,
    waitingFor: s.waiting > 0 || s.state === 'waiting' ? s.waitingFor : null,
  };
}

/**
 * Line two's items, in priority order, which is also the order they read in (T-375, the ux check of c84657f: at 390 px the line cut the cost
 * mid-number, the Claude's name to "De" with no ellipsis, and dropped the lead's cost). The line is one line high and wraps: an item that does
 * not fit whole goes to the hidden second line with everything after it, so a lower-priority item is dropped whole and a number is never
 * cut. A name that must shorten (the Claude, the workspace, the branch) is capped and ends in an ellipsis, its full text in the tip.
 *   state · quota (bar and percent) · cost · model · workspace · Claude's name · branch · ticket
 * The workspace shows only when the card's rows span several workspaces (it then tells rows apart, more than the Claude's name, which the
 * bar's tip also says).
 */
export const LINE_TWO_ORDER = ['state', 'quota', 'cost', 'model', 'workspace', 'claude', 'branch', 'ticket'] as const;
export type LineTwoItem = (typeof LINE_TWO_ORDER)[number];

/** The items line two carries for these facts, in {@link LINE_TWO_ORDER}; the quota item only when there is a bar (not a pool or a key). */
export function lineTwo(m: Pick<RowMeta, 'model' | 'claude' | 'cost' | 'workspace' | 'branch' | 'ticket'>): LineTwoItem[] {
  const has: Record<LineTwoItem, boolean> = {
    state: true,
    quota: !!m.claude && m.claude.meter.kind !== 'no_limits',
    cost: !!m.cost,
    model: !!m.model,
    workspace: !!m.workspace,
    claude: !!m.claude?.name,
    branch: !!m.branch,
    ticket: !!m.ticket,
  };
  return LINE_TWO_ORDER.filter((k) => has[k]);
}

/**
 * Line three, or null: only the open request (amber). The branch and ticket close line two at every width (cut on the right when it is
 * full), so a row that does not wait on you stays two lines (T-378's density check: at most 80 px at 390).
 */
export function thirdLine(m: Pick<RowMeta, 'waitingFor'>): 'waiting' | null {
  return m.waitingFor ? 'waiting' : null;
}
