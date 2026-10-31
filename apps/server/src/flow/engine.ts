// The flow watchdog (T-1966, docs/prd/flow-watchdog.md): a deterministic loop INSIDE the portal, no model. Work in a program (merging a
// QA PASS, sending QA, dispatching the next ticket) is done by lead sessions that only act when messaged; when the session that used to wake
// them stops, nothing moves (2026-10-20/21: 4 tickets done in 24 h while in review went from 50 to 92). Every 5 minutes, per program, it
// counts five conditions and messages the lead that can clear each:
//   merge   in review, a QA PASS on the head, not merged for `flow.mergeAfterMin`   -> the merge-gate lead, the exact list (ids, keys, heads)
//                                                                                        T-2014: the head is the PR head the merge gate
//                                                                                        recorded (ticket_merge_status), with a review PASS
//                                                                                        too when the ticket has review verdicts; a ticket
//                                                                                        recorded merged is skipped; without a record, the
//                                                                                        newest commit seen, labelled so
//   conflict, no_pr  the gate recorded a PR needing a rebase, or no PR (at once, T-2018) -> the ticket's unit lead: rebase it, or open the PR
//                    each record is first checked with the forge (FlowPrPort, when set): merged there is merged, closed unmerged is no_pr,
//                    an open PR is judged on its live head and is a conflict when the forge cannot merge it
//                                                                                        D-102: or the implementer's self-test line on the head
//                                                                                        (a comment, `Self-test: <run> on <sha> pass <N>`), with a
//                                                                                        review PASS too when HIGH (tag `risk-high`, or reviewed);
//                                                                                        a NORMAL self-test row goes to its unit lead (D-99)
//   qa      in review, no verdict on the head, nobody on it for `flow.qaAfterMin`   -> a peer lead, round robin, never the author's: QA-ASK
//                                                                                        as one batch (D-93, T-1987): at most 8 per peer per
//                                                                                        message; a ticket already in a live batch is skipped
//   idle    a lead idle `flow.idleAfterMin` with open work in its unit, under cap   -> that lead, its next tickets (oldest high priority first)
//                                                                                        open work: not dispatched, or its holder ended or idle;
//                                                                                        the cap counts workers that work, not ones merely live
//   idle_lanes  a lead's own builder workers idle `flow.laneIdleMin` while its unit has -> that lead: the idle lane ids and the next items
//               conflicts, no_pr or open work (T-2018)                                  (conflicts, then no_pr, then oldest high priority)
//   review  a HIGH ticket self-tested on the head, no review verdict that long         -> a peer lead (as qa, never the author's): REVIEW-ASK
//   bypass  a lead that was in Bypass is not now                                      -> reported only (audit and the card): see below
//   stall   nothing done in `flow.stallHours` while tickets wait in review           -> the owner, once, if it lasts `flow.notifyAfterHours`
//                                                                                        after the first nudge
// T-3198: a ticket held by a crew whose root is no lead of the program (it carries the program's tag, another program's lead holds it) is
// OUTSIDE: its merge, conflict, no_pr, QA and review alerts all go to that root's live head, never to the gate or a peer lead; when that
// root cannot be told (ended, held) the alert is dropped for the round. Unheld tickets and the stall, idle and card counts are unchanged.
// Every action is rate limited (one per lead per condition per `flow.repeatMin`) and audited (`flow.*`). A message goes through the chat
// controller's send path as `portal:flow`, priority `later` (queued behind a running turn, never injected mid-tool), only to a live session:
// a configured lead that ended is followed to its live successor or continuation, and one with none is skipped. The watchdog acts for the
// owner and checks `operate` on the session each time. It never answers an approval and never enters Bypass: the one safe path back into
// Bypass is the wake of a lead whose sleep kept it (the chat controller's own gates), which any message runs; anything else is reported.

import { randomUUID } from 'node:crypto';
import {
  FLOW_ACTOR,
  FLOW_LIMITS,
  FLOW_PREFIX,
  TICKET_PRIORITIES,
  type ChatSession,
  type FlowAction,
  type FlowActionKind,
  type FlowCondition,
  type FlowHold,
  type FlowProgramView,
  type FlowSnapshot,
  type NotifySubject,
  type TicketCheck,
  type TicketItem,
  type TicketMergeStatus,
  type TicketStatus,
  type Verb,
} from '@portal/contracts';
import type { ClockPort } from '../autotransfer/ports.js';
import type { NotifyBus } from '../notify/bus.js';
import type { AuditInput } from '../platform/audit.js';
import { evaluateVerdicts, type StoredVerdict } from '../tickets/verdicts.js';
import { crewRoot, isBuilderLaneName, lineage, parseLeadPeerGroups, resolveHead, parsePrograms, type FlowProgram, type SessionReader } from './programs.js';
import { flowOn, flowPaused, flowProgramsRaw, flowThresholds, type FlowSettingsReader, type FlowThresholds } from './settings.js';
import { trimState, type FlowState, type FlowStatePort } from './store.js';

export const FLOW_ROUND_MS = 5 * 60_000;
const MIN = 60_000;

/** A Bypass audit record of a session (the chat controller's trail, newest first). */
export interface FlowBypassRecord {
  sessionId: string;
  kind: string;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

/** What the watchdog uses of the chat controller. */
export interface FlowChatPort extends SessionReader {
  list(filter: { parentId?: string; ticketId?: string }): ChatSession[];
  send(id: string, uuid: string, text: string, opts: { priority: 'later'; actor: string; actorLabel: string }): Promise<void>;
  /** The newest Bypass record (`bypass.entered` or `bypass.left`) of a session, or null. */
  lastBypass(id: string): FlowBypassRecord | null;
  /** How many workers it may run at once (its own limit clamped to the global cap); null: no limit. */
  maxWorkers(s: ChatSession): number | null;
  /** A person stopped it and nothing has run it since (the controller's crew hold). */
  stoppedByPerson(id: string): boolean;
}

/** Keep going's pause switch, read only: the pauses that stand (program null: all) and the program on a chat's own Keep going policy. */
export interface FlowKeepGoingPort {
  pauses(): { program: string | null }[];
  programOf(sessionId: string): string | null;
}

/** What it reads of the tickets module, as the portal itself. */
export interface FlowTicketPort {
  list(tag: string, statuses: TicketStatus[]): TicketItem[];
  verdicts(id: string): StoredVerdict[];
  checks(id: string): TicketCheck[];
  /** T-1987 (D-93): the batch branch the ticket is in, named after its newest verdict, and when; null: none. Absent: no batches read. */
  batchOf?(id: string): { branch: string; at: string } | null;
  /** T-2014: the merge gate's latest record per repo (`ticket_merge_status`), newest first. Absent: none read (the old heuristic). */
  mergeStatus?(id: string): TicketMergeStatus[];
  /** D-102: the ticket's comments, oldest first. Absent: no self-test read (a QA PASS only, as before). */
  comments?(id: string): { at: string; body: string }[];
}

export interface FlowOwnerPort {
  ownersOf(subject: NotifySubject): string[];
  can(userId: string, verb: Verb, subject: NotifySubject): boolean;
}

export interface FlowDeps {
  chat: FlowChatPort;
  tickets: FlowTicketPort;
  owner: FlowOwnerPort;
  clock: ClockPort;
  store: FlowStatePort;
  settings: FlowSettingsReader | null;
  /** `tickets.leadPeerGroups`, read each round. */
  leadGroups: () => unknown;
  bus: Pick<NotifyBus, 'emit'> | null;
  audit: { record(e: AuditInput): void } | null;
  /** Keep going's pause; null: no Keep going in this portal. */
  keepGoing?: FlowKeepGoingPort | null;
  /** After each round: the live topic the card reloads on. */
  publish?: () => void;
  /** The forge's word on a recorded pull request; absent: the gate's records are taken as they stand. */
  prs?: FlowPrPort;
}

/** A pull request as the forge says it is now: a gate record goes stale when a PR is merged, closed, pushed to or conflicts outside it. */
export interface FlowPrView {
  state: 'open' | 'closed';
  merged: boolean;
  /** Its head now, a full sha; null: not read. */
  head: string | null;
  /** False: the forge cannot merge it (a conflict); null: not known. */
  mergeable: boolean | null;
}

export interface FlowPrPort {
  /** null: unknown (unreadable, gone, or a repo it does not serve): the record stands. */
  pr(repo: string, n: number): Promise<FlowPrView | null>;
}

/** At most this many forge reads per program per round; the rest stand as recorded until the next round. */
export const FLOW_PR_READS = 60;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const ended = (s: ChatSession) => s.state === 'ended' || !!s.archivedAt;
const rank = (p: string) => {
  const i = (TICKET_PRIORITIES as readonly string[]).indexOf(p);
  return i < 0 ? TICKET_PRIORITIES.length : i;
};
const ref = (t: TicketItem) => (t.key && t.key !== t.id ? `${t.id} (${t.key})` : t.id);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The commit that stands for a ticket's head. The portal does not know a branch's head, so it takes the NEWEST commit it has heard of for
 * the ticket: a CI check's or a verdict's (a verdict wins a tie). A check's short sha is widened to the verdict commit it begins, else it
 * stays short and no verdict matches it (stale: a branch that moved after a PASS is not passing).
 */
export function headOf(verdicts: readonly StoredVerdict[], checks: readonly TicketCheck[]): string | null {
  let best: { sha: string; at: number } | null = null;
  const consider = (sha: string, at: number) => {
    if (!Number.isFinite(at)) return;
    if (!best || at >= best.at) best = { sha: sha.toLowerCase(), at };
  };
  for (const c of checks) if (c.commit) consider(c.commit, ms(c.updatedAt));
  for (const v of verdicts) consider(v.commit, ms(v.at));
  const b = best as { sha: string; at: number } | null;
  if (!b) return null;
  if (b.sha.length === 40) return b.sha;
  return verdicts.find((v) => v.commit.startsWith(b.sha))?.commit ?? b.sha;
}

/**
 * D-102: the tags of a HIGH ticket (security, permissions, money, migrations, infra): self-test plus one blind review by another unit.
 * T-2250: the tag rule refuses a colon, so tickets carry `risk-high` (or `risk_high`); `risk:high` is still read for any older row.
 */
export const RISK_HIGH_TAGS: readonly string[] = ['risk-high', 'risk_high', 'risk:high'];
export const isHighRisk = (tags: readonly string[]): boolean => tags.some((t) => RISK_HIGH_TAGS.includes(t.toLowerCase()));
/** D-102: the implementer's self-test line, the merge gate's own form: `Self-test: <job | command> on <sha> pass <N>[ stg same failures: <ids>]`. */
const SELF_TEST = /^Self-test: \S.*? on ([0-9a-f]{12,40}) pass [1-9][0-9]*(?: stg same failures: .*\S.*)?$/;
const sameCommit = (a: string, b: string) => a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a));

/**
 * One comment line as the self-test check reads it: Markdown emphasis and code marks (`*`, backticks) dropped, trimmed. Shared with the lab
 * metrics (lab/flowMetricsData.ts `selfTestLineOf`, T-2360), so both count the same lines.
 */
export const selfTestText = (raw: string): string => raw.replace(/[*`]/g, '').trim();

/** When the newest comment with a self-test line on `head` was written (Markdown emphasis and code marks ignored), or null: none. */
export function selfTestAt(comments: readonly { at: string; body: string }[], head: string): number | null {
  let at: number | null = null;
  const h = head.toLowerCase();
  for (const c of comments)
    for (const raw of c.body.split('\n')) {
      const m = SELF_TEST.exec(selfTestText(raw));
      if (m && sameCommit(m[1]!, h) && Number.isFinite(ms(c.at))) at = Math.max(at ?? 0, ms(c.at));
    }
  return at;
}

interface Ctx {
  p: FlowProgram;
  st: FlowState;
  t: FlowThresholds;
  now: number;
  ownerId: string | null;
  told: boolean;
  /** What holds the whole program (nothing is sent, reported or notified), or null. */
  hold: FlowHold | null;
  /** Keep going's pauses as read at the start of the round. */
  kgPaused: (program: string | null) => boolean;
  /** Forge reads spent this round. */
  prReads: number;
  /** T-2016: the bucket key of each ticket of the program read this round (the card shows keys). */
  keyOf: Map<string, string>;
}

/** T-2023: one conflict or no_pr alert as told: the ticket, the repo and PR, the head and the state the record names. */
const itemKey = (cond: 'conflict' | 'no_pr', it: { t: TicketItem; pr: TicketMergeStatus }) =>
  `${cond}:${it.t.id}:${it.pr.repo}#${it.pr.pr ?? ''}@${it.pr.prHead ?? ''}`;

export class FlowEngine {
  readonly #d: FlowDeps;
  #timer: (() => void) | null = null;
  #running: Promise<number> | null = null;

  constructor(deps: FlowDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#timer) return;
    const tick = () => {
      this.#timer = this.#d.clock.timer(FLOW_ROUND_MS, tick);
      void this.round();
    };
    this.#timer = this.#d.clock.timer(FLOW_ROUND_MS, tick);
  }

  stop(): void {
    this.#timer?.();
    this.#timer = null;
  }

  /** What the card shows: the last round's counts per program and the newest actions. */
  snapshot(): FlowSnapshot {
    const st = this.#d.store.load();
    return { enabled: flowOn(this.#d.settings), lastRunAt: st.lastRunAt, programs: st.view, actions: st.actions.slice(0, FLOW_LIMITS.actions) };
  }

  /** One round (the timer calls it; tests too). Rounds never overlap. Skipped while off or while the portal may not write (frozen, locked). */
  round(): Promise<number> {
    if (this.#running) return this.#running;
    this.#running = this.#round().finally(() => (this.#running = null));
    return this.#running;
  }

  async #round(): Promise<number> {
    if (!flowOn(this.#d.settings) || !this.#d.store.writable) return 0;
    const now = this.#d.clock.now();
    const st = trimState(this.#d.store.load(), now);
    const t = flowThresholds(this.#d.settings);
    const groups = parseLeadPeerGroups(this.#d.leadGroups());
    const ownerId = this.#d.owner.ownersOf({ type: 'portal', id: 'flow' })[0] ?? null;
    const view: FlowProgramView[] = [];
    let done = 0;
    let kgPauses: { program: string | null }[] = [];
    try {
      kgPauses = this.#d.keepGoing?.pauses() ?? [];
    } catch {
      // unreadable: no pause read (the Flow pause still holds)
    }
    const kgPaused = (program: string | null) => kgPauses.some((x) => x.program === null || (program !== null && x.program === program));
    const flowHeld = flowPaused(this.#d.settings);
    for (const p of parsePrograms(flowProgramsRaw(this.#d.settings))) {
      if (!p.enabled) {
        delete st.stall[p.name];
        view.push(emptyView(p, false, true));
        continue;
      }
      try {
        const hold: FlowHold | null = flowHeld.has('*') || flowHeld.has(p.name) ? 'flow' : kgPaused(p.name) ? 'keepgoing' : null;
        view.push(await this.#program({ p, st, t, now, ownerId, told: false, hold, kgPaused, prReads: 0, keyOf: new Map() }, groups));
        done++;
      } catch (e) {
        console.error(`[flow] the program ${p.name} could not be looked at: ${(e as Error).message}`);
        view.push(emptyView(p, true, false));
      }
    }
    st.lastRunAt = iso(now);
    st.view = view;
    this.#d.store.save(st);
    try {
      this.#d.publish?.();
    } catch {
      // a card that is told nothing reads it at its next load
    }
    return done;
  }

  async #program(c: Ctx, groups: string[][]): Promise<FlowProgramView> {
    const { p, t, now } = c;
    const chat = this.#d.chat;
    const open = this.#d.tickets.list(p.tag, ['open', 'in_progress', 'blocked', 'in_review']);
    const doneRecent = this.#d.tickets.list(p.tag, ['done']).filter((x) => now - ms(x.closedAt) <= t.stallMs).length;
    for (const x of open) if (x.key) c.keyOf.set(x.id, x.key);
    const rootOf = new Map<string, string | null>();
    const root = (sessionId: string) => {
      if (!rootOf.has(sessionId)) rootOf.set(sessionId, crewRoot(chat, sessionId));
      return rootOf.get(sessionId)!;
    };
    const holder = (x: TicketItem) => (x.assignee?.kind === 'session' ? x.assignee.sessionId : null);

    // The leads: the configured group, else the first group whose leads (any id they went by) hold a ticket of the program.
    const lines = new Map<string, Set<string>>();
    const lineOf = (id: string) => {
      if (!lines.has(id)) lines.set(id, lineage(chat, id));
      return lines.get(id)!;
    };
    let leads: string[] = [];
    if (p.group !== null) leads = groups[p.group - 1] ?? [];
    else {
      const roots = new Set(open.map(holder).filter((h): h is string => !!h).map(root).filter((r): r is string => !!r));
      leads = groups.find((g) => g.some((id) => [...lineOf(id)].some((x) => roots.has(x)))) ?? groups[0] ?? [];
    }
    const leadOf = (x: TicketItem): string | null => {
      const h = holder(x);
      const r = h ? root(h) : null;
      return r ? (leads.find((l) => lineOf(l).has(r)) ?? null) : null;
    };
    const resolved = new Map(leads.map((l) => [l, resolveHead(chat, l)] as const));
    const heads = new Map([...resolved].map(([l, r]) => [l, r.head] as const));
    // A merge gate must be a lead of the group (checked on save); one that no longer is (the group changed) falls back to the first lead.
    const gate = (p.mergeGate && leads.includes(p.mergeGate) ? p.mergeGate : null) ?? leads[0] ?? null;
    const gateResolved = gate ? (resolved.get(gate) ?? resolveHead(chat, gate)) : { head: null, why: 'ended' as const };
    const gateHead = gateResolved.head;
    // T-3198: a ticket held by a session whose crew root is no lead of this program (it carries the program's tag, but another program's
    // lead holds it) is OUTSIDE. Every alert about it goes to that root, the one session that can act on it, never to the gate or a peer
    // lead: undefined: not outside (unheld, or a lead's); null: outside, but its root cannot be followed (the alert is dropped).
    const outsideRoot = (x: TicketItem): string | null | undefined => {
      const h = holder(x);
      return h && !leadOf(x) ? root(h) : undefined;
    };
    // The live head of any session told: a lead's as resolved above, the gate's, or an outside root's (resolved once a round).
    const resolveOf = (l: string) => {
      if (l === gate) return gateResolved;
      if (!resolved.has(l)) resolved.set(l, resolveHead(chat, l));
      return resolved.get(l)!;
    };
    // A lead that may hear from the watchdog now: it runs, no person stopped it, and Keep going is not paused for it.
    const reachable = (l: string) => {
      const h = heads.get(l);
      return !!h && !this.#heldWhy(c, h);
    };

    // (a) and (b): the tickets in review, judged on their head. T-2014: the head is the PR head the merge gate recorded when it recorded one
    // (the newest record of a repo not merged); a ticket merged in every repo it was recorded in is skipped; conflict and no_pr go to the
    // unit lead. Without a record, the newest commit the portal has seen, as before, and the row says so.
    const merge: { t: TicketItem; head: string; pr: TicketMergeStatus | null; basis: string }[] = [];
    const qa: { t: TicketItem; head: string | null; ask: 'qa' | 'review' }[] = [];
    const conflict: { t: TicketItem; pr: TicketMergeStatus }[] = [];
    const noPr: { t: TicketItem; pr: TicketMergeStatus }[] = [];
    const inReview = open.filter((x) => x.status === 'in_review');
    for (const x of inReview) {
      const recorded = await this.#livePrs(c, this.#mergeStatus(x.id));
      const pending = recorded.filter((m) => m.state !== 'merged').sort((a, b) => ms(b.at) - ms(a.at));
      if (recorded.length && !pending.length) continue;
      // T-2016: every repo is judged: a conflict or a missing PR in one repo is its own row, never hidden behind a newer ready record of
      // another repo. T-2018: at once, the round they are seen (the rate limit still holds): 15 PRs sat in conflict while builders idled.
      const blocked = pending.filter((m) => m.state === 'conflict' || m.state === 'no_pr');
      if (blocked.length) {
        for (const m of blocked) (m.state === 'conflict' ? conflict : noPr).push({ t: x, pr: m });
        continue;
      }
      const pr = pending[0] ?? null;
      const verdicts = this.#d.tickets.verdicts(x.id);
      const head = pr?.prHead ?? headOf(verdicts, this.#d.tickets.checks(x.id));
      // With a recorded PR, the merge gate's own rule: a review PASS on that head as well when the ticket was reviewed at all.
      const need: ('qa' | 'review')[] = pr && verdicts.some((v) => v.role === 'review') ? ['qa', 'review'] : ['qa'];
      const ev = head ? evaluateVerdicts(verdicts, head, need) : null;
      const qaRole = ev ? ev.roles.qa : 'missing';
      const passAtOf = (roles: readonly ('qa' | 'review')[]) =>
        Math.max(...roles.map((r) => Math.max(...verdicts.filter((v) => v.role === r && v.verdict === 'pass' && v.commit === head).map((v) => ms(v.at)))));
      const busy = (afterMs: number) => chat.list({ ticketId: x.id }).some((s) => !ended(s) && (s.state === 'working' || s.state === 'starting' || now - ms(s.lastActivityAt) < afterMs));
      // D-102: the implementer's self-test on the head is a merge basis of its own; a HIGH ticket (tagged, or reviewed at all) needs a
      // review PASS on that head as well, asked of another unit's lead below. QA only runs regression then: it is never asked per ticket.
      const selfTest = head ? this.#selfTest(x.id, head) : null;
      const high = isHighRisk(x.tags) || verdicts.some((v) => v.role === 'review');
      const review = head && high ? evaluateVerdicts(verdicts, head, ['review']) : null;
      if (ev?.pass && head) {
        const passAt = passAtOf(need);
        if (now - passAt >= t.mergeAfterMs) merge.push({ t: x, head, pr, basis: 'QA PASS' });
      } else if (selfTest !== null && head) {
        if (!high || review?.pass) {
          const passAt = Math.max(selfTest, high ? passAtOf(['review']) : 0);
          if (now - passAt >= t.mergeAfterMs) merge.push({ t: x, head, pr, basis: high ? 'self-test + review PASS' : 'self-test' });
        } else if (review && review.roles.review !== 'fail' && now - selfTest >= t.mergeAfterMs && !busy(t.mergeAfterMs)) qa.push({ t: x, head, ask: 'review' });
      } else if (qaRole === 'missing' || qaRole === 'stale') {
        if (now - ms(x.updatedAt) < t.qaAfterMs) continue;
        if (busy(t.qaAfterMs)) continue;
        // T-1987 (D-93): a ticket a QA lane already took into a batch (named after its newest verdict, recently) waits for that batch.
        const batch = this.#d.tickets.batchOf?.(x.id) ?? null;
        if (batch && now - ms(batch.at) < FLOW_LIMITS.batchLiveMin * MIN) continue;
        qa.push({ t: x, head, ask: 'qa' });
      }
    }

    // (e) first: a nudge sent this round counts as the stall's first.
    const stalled = inReview.length > 0 && doneRecent === 0;
    if (!stalled) delete c.st.stall[p.name];
    else c.st.stall[p.name] ??= { since: now, nudgedAt: null, notifiedAt: null };

    // D-99: a NORMAL row merged on its self-test goes to its own unit lead; QA-passed and HIGH rows to the merge gate, as before.
    // T-3198: an outside row (any basis) goes to its holder's crew root, never to the gate; one whose root cannot be followed is dropped.
    const mergeTo = new Map<string | null, typeof merge>();
    const outsideTo = new Set<string>();
    for (const m of merge) {
      const out = outsideRoot(m.t);
      if (out === null) continue;
      if (out !== undefined) outsideTo.add(out);
      const to = out ?? (m.basis === 'self-test' ? (leadOf(m.t) ?? gate) : gate);
      mergeTo.set(to, [...(mergeTo.get(to) ?? []), m]);
    }
    for (const [to, list] of mergeTo) {
      // Recorded PR heads first: those are the gate's own facts; the heuristic rows after, labelled.
      const sorted = [...list].sort((a, b) => Number(!a.pr) - Number(!b.pr));
      const rows = sorted
        .slice(0, FLOW_LIMITS.ticketsPerMessage)
        .map((m) => (m.pr ? `- ${ref(m.t)} ${m.pr.repo}#${m.pr.pr} ${m.basis} on the PR head ${m.head} (${m.pr.state})` : `- ${ref(m.t)} ${m.basis} on ${m.head} (newest seen, no PR status)`));
      const n = list.length;
      const r = to ? resolveOf(to) : { head: null, why: 'ended' as const };
      const own = !!to && outsideTo.has(to);
      await this.#tell(
        c,
        'merge',
        to,
        r.head,
        r.why,
        sorted.map((m) => m.t.id),
        [
          `${FLOW_PREFIX} ${plural(n, 'ticket')} in review ${n === 1 ? 'has' : 'have'} a merge basis (a QA PASS, or the D-102 self-test, with a review PASS when HIGH) and ${n === 1 ? 'is' : 'are'} not merged after ${t.mergeAfterMs / MIN} min (program ${p.name}). ${own ? `Your crew holds ${n === 1 ? 'it' : 'them'} and no lead of the program does, so you merge ${n === 1 ? 'it' : 'them'} and record ${n === 1 ? 'it' : 'each'} (a fast-forward merge with no PR: state merged with pr_head alone). ` : ''}A row with a PR is judged on the PR head you recorded (ticket_merge_status); a row marked (newest seen, no PR status) is the newest commit the portal has seen: check it is the PR head and record the PR. Merge or close each, or record why not with ticket_merge_status:`,
          ...rows,
          ...more(n),
        ],
        own ? OWN_NOTE.merge : undefined,
      );
    }

    // T-2023: an alert already told on this record (same ticket, repo, PR, head and state, no newer record) waits while someone has
    // answered on the ticket since: the same stale alert every window cost a lead a turn each time. A new record, a moved head or a
    // silent ticket is told again (the rate limit still holds).
    const answered = (cond: 'conflict' | 'no_pr', it: { t: TicketItem; pr: TicketMergeStatus }) => {
      const toldAt = c.st.items[itemKey(cond, it)];
      if (typeof toldAt !== 'number' || ms(it.pr.at) > toldAt) return false;
      try {
        return (this.#d.tickets.comments?.(it.t.id) ?? []).some((x) => ms(x.at) > toldAt);
      } catch {
        return false;
      }
    };
    const conflictTold = conflict.filter((it) => !answered('conflict', it));
    const noPrTold = noPr.filter((it) => !answered('no_pr', it));

    // T-2014: conflict and no_pr, each to the ticket's unit lead (the lead whose unit holds it); a ticket with no unit lead is reported.
    // T-3198: an outside ticket's go to its holder's crew root; one whose root cannot be followed is dropped (never the gate).
    const toUnits = async (cond: 'conflict' | 'no_pr', list: { t: TicketItem; pr: TicketMergeStatus }[]) => {
      const byLead = new Map<string, { t: TicketItem; pr: TicketMergeStatus }[]>();
      const orphans: string[] = [];
      for (const it of list) {
        const out = outsideRoot(it.t);
        if (out === null) continue;
        const l = out ?? leadOf(it.t);
        if (l) byLead.set(l, [...(byLead.get(l) ?? []), it]);
        else orphans.push(it.t.id);
      }
      for (const [l, items] of byLead) {
        const n = items.length;
        const r = resolveOf(l);
        const sent = await this.#tell(c, cond, l, r.head, r.why, [...new Set(items.map((i) => i.t.id))], [
          cond === 'conflict'
            ? `${FLOW_PREFIX} the merge gate recorded a conflict on ${plural(n, 'pull request')} of your unit (program ${p.name}). Send ${n === 1 ? 'it' : 'each'} back to its builder for a rebase onto the base branch; QA then verifies the new head:`
            : `${FLOW_PREFIX} the merge gate recorded no pull request for ${plural(n, 'ticket')} of your unit in review (program ${p.name}). Open the PR for each (or have its builder open it), or say on the ticket why not:`,
          ...items.slice(0, FLOW_LIMITS.ticketsPerMessage).map((i) => `- ${ref(i.t)} ${i.pr.repo}${i.pr.pr ? `#${i.pr.pr}` : ''}${i.pr.prHead ? ` head ${i.pr.prHead}` : ''}`),
          ...more(n),
          'Answered already (contained in another PR, superseded, rebased)? Say so on the ticket, or record it with ticket_merge_status: an alert on the same record waits once the ticket is answered.',
        ]);
        if (sent) for (const i of items.slice(0, FLOW_LIMITS.ticketsPerMessage)) c.st.items[itemKey(cond, i)] = c.now;
      }
      if (orphans.length && !c.hold && !this.#limited(c, cond, `program-${p.name}`)) {
        c.st.sent[`${cond}:program-${p.name}`] = c.now;
        this.#act(c, cond, 'skipped', null, [...new Set(orphans)], 'No unit lead of the program holds these: nobody was told.');
      }
    };
    if (conflictTold.length) await toUnits('conflict', conflictTold);
    if (noPrTold.length) await toUnits('no_pr', noPrTold);

    if (qa.length) {
      // Round robin over the peer leads that run, never the author's own (the lead whose unit holds the ticket).
      const live = leads.filter(reachable);
      const byLead = new Map<string, (typeof qa)[number][]>();
      // T-3198: an outside ticket's ask goes to its holder's crew root (one batch per message; the rest wait), never to a peer lead.
      const byOwn = new Map<string, (typeof qa)[number][]>();
      let rr = c.st.rr[p.name] ?? 0;
      const unplaced: string[] = [];
      for (const q of qa) {
        const out = outsideRoot(q.t);
        if (out !== undefined) {
          if (out && (byOwn.get(out)?.length ?? 0) < FLOW_LIMITS.qaBatchPerPeer) byOwn.set(out, [...(byOwn.get(out) ?? []), q]);
          continue;
        }
        const author = leadOf(q.t);
        const authorRoot = holder(q.t) ? root(holder(q.t)!) : null;
        const peers = live.filter((l) => l !== author && !(authorRoot && lineOf(l).has(authorRoot)) && (byLead.has(l) || !this.#limited(c, 'qa', l)));
        if (!peers.length) {
          unplaced.push(q.t.id);
          continue;
        }
        // One batch per peer per message (D-93): a peer that has its batch is full; what no peer has room for waits for the next window.
        const ok = peers.filter((l) => (byLead.get(l)?.length ?? 0) < FLOW_LIMITS.qaBatchPerPeer);
        if (!ok.length) continue;
        const to = ok[rr % ok.length]!;
        rr++;
        byLead.set(to, [...(byLead.get(to) ?? []), q]);
      }
      c.st.rr[p.name] = rr;
      const row = (q: { t: TicketItem; head: string | null }) => `- ${ref(q.t)} head ${q.head ?? 'unknown'}${holder(q.t) ? ` held by ${holder(q.t)}` : ''}`;
      for (const [l, list] of byLead) {
        const asks = list.filter((q) => q.ask === 'qa');
        const reviews = list.filter((q) => q.ask === 'review');
        await this.#tell(c, 'qa', l, heads.get(l) ?? null, null, list.map((q) => q.t.id), [
          ...(asks.length
            ? [
                `${FLOW_PREFIX} QA-ASK batch: take these as one qa/batch branch, one job run, a verdict per ticket (D-93). Program ${p.name}: ${plural(asks.length, 'ticket')} in review ${asks.length === 1 ? 'has' : 'have'} no verdict on the head and nobody working on ${asks.length === 1 ? 'it' : 'them'} for ${t.qaAfterMs / MIN} min. Send a QA lane that is not the author; it records each ticket's verdict on that ticket's head (ticket_verdict_batch, the job run as evidence):`,
                ...asks.map(row),
              ]
            : []),
          ...(reviews.length
            ? [
                `${FLOW_PREFIX} REVIEW-ASK (D-102): ${plural(reviews.length, 'HIGH ticket')} of another unit ${reviews.length === 1 ? 'has' : 'have'} the implementer's self-test on the head and no review verdict for ${t.mergeAfterMs / MIN} min (program ${p.name}). Have your reviewer worker read each PR blind (no CI run) and record a review verdict on that head (ticket_verdict, role review):`,
                ...reviews.map(row),
              ]
            : []),
        ]);
      }
      for (const [l, list] of byOwn) {
        const asks = list.filter((q) => q.ask === 'qa');
        const reviews = list.filter((q) => q.ask === 'review');
        const r = resolveOf(l);
        await this.#tell(
          c,
          'qa',
          l,
          r.head,
          r.why,
          list.map((q) => q.t.id),
          [
            ...(asks.length
              ? [
                  `${FLOW_PREFIX} QA-ASK for tickets your crew holds (program ${p.name}; no lead of the program holds them, so they are yours to move): ${plural(asks.length, 'ticket')} in review ${asks.length === 1 ? 'has' : 'have'} no verdict on the head and nobody working on ${asks.length === 1 ? 'it' : 'them'} for ${t.qaAfterMs / MIN} min. Have a QA lane that is not the author verify them as one batch (D-93) and record each verdict on its head (ticket_verdict_batch), or say on the ticket why not:`,
                  ...asks.map(row),
                ]
              : []),
            ...(reviews.length
              ? [
                  `${FLOW_PREFIX} REVIEW-ASK (D-102) for tickets your crew holds (program ${p.name}): ${plural(reviews.length, 'HIGH ticket')} ${reviews.length === 1 ? 'has' : 'have'} the implementer's self-test on the head and no review verdict for ${t.mergeAfterMs / MIN} min. Have a blind reviewer outside your own lineage read each PR (no CI run) and record a review verdict on that head (ticket_verdict, role review):`,
                  ...reviews.map(row),
                ]
              : []),
          ],
          OWN_NOTE.qa,
        );
      }
      if (unplaced.length && !c.hold && !this.#limited(c, 'qa', `program-${p.name}`)) {
        c.st.sent[`qa:program-${p.name}`] = c.now;
        this.#act(c, 'qa', 'skipped', null, unplaced, 'No peer lead that is not the author runs and may be told: nobody was asked to verify these.');
      }
    }

    // (c) idle leads with open work in their unit and room under their cap.
    let idle = 0;
    const unitOpen = open.filter((x) => x.status === 'open' || x.status === 'in_progress');
    const working = (s: ChatSession) => s.state === 'working' || s.state === 'starting' || !!s.busySince || (s.agentsRunning ?? 0) > 0 || s.waiting > 0;
    const doing = (id: string | null) => {
      const s = id ? chat.get(id) : null;
      return !!s && !ended(s) && (working(s) || now - ms(s.lastActivityAt) < t.idleAfterMs);
    };
    for (const l of leads) {
      const h = heads.get(l);
      if (!h || h.state !== 'idle' || h.waiting > 0 || h.busySince || (h.agentsRunning ?? 0) > 0) continue;
      const idleMs = now - ms(h.lastActivityAt);
      if (!(idleMs >= t.idleAfterMs)) continue;
      // Work nobody does: a ticket not dispatched, or one whose holder ended or sat idle that long (a live worker counts only while it works).
      const unit = unitOpen.filter((x) => leadOf(x) === l && (x.status === 'open' || !doing(holder(x))));
      if (!unit.length) continue;
      const live = chat.list({ parentId: h.id }).filter((s) => s.parentId === h.id && !ended(s));
      const workers = live.filter(working).length;
      const cap = chat.maxWorkers(h);
      if (cap !== null && workers >= cap) continue;
      idle++;
      const next = [...unit].sort((a, b) => rank(a.priority) - rank(b.priority) || ms(a.createdAt) - ms(b.createdAt) || a.number - b.number);
      await this.#tell(c, 'idle', l, h, null, next.slice(0, 5).map((x) => x.id), [
        `${FLOW_PREFIX} you have been idle ${Math.floor(idleMs / MIN)} min while your unit holds ${plural(unit.length, 'open ticket')} and has ${workers} of ${cap ?? 'unlimited'} workers working (${live.length} live) (program ${p.name}). Your next tickets, oldest high priority first:`,
        ...next.slice(0, 5).map((x) => `- ${ref(x)} ${x.priority} ${x.status}`),
        'Dispatch them, or say on each ticket why not.',
      ]);
    }

    // T-2018 idle lanes: a lead that may be told (reachable: live, not stopped by a person, Keep going not paused for it) whose own builder
    // workers (direct children of any id it went by, a builder role name) sit idle past `flow.laneIdleMin` while its unit has a conflict, a
    // missing PR or open work. The lead dispatches; the watchdog only names the free lanes and the next items. QA and review lanes are not
    // counted here (they take QA-ASK batches).
    let idleLanes = 0;
    for (const l of leads) {
      if (!reachable(l)) continue;
      const h = heads.get(l)!;
      const seen = new Set<string>();
      const lanes: ChatSession[] = [];
      for (const id of new Set([h.id, ...lineOf(l)]))
        for (const s of chat.list({ parentId: id })) {
          if (s.parentId !== id || seen.has(s.id)) continue;
          seen.add(s.id);
          if (ended(s) || s.process === 'gone' || s.state !== 'idle' || s.waiting > 0 || s.busySince || (s.agentsRunning ?? 0) > 0) continue;
          if (!isBuilderLaneName(s.agent) || !(now - ms(s.lastActivityAt) >= t.laneIdleMs)) continue;
          lanes.push(s);
        }
      if (!lanes.length) continue;
      const mine = <T extends { t: TicketItem }>(xs: T[]) => xs.filter((i) => leadOf(i.t) === l);
      const conf = mine(conflictTold);
      const nop = mine(noPrTold);
      const work = unitOpen
        .filter((x) => leadOf(x) === l)
        .sort((a, b) => rank(a.priority) - rank(b.priority) || ms(a.createdAt) - ms(b.createdAt) || a.number - b.number);
      if (!conf.length && !nop.length && !work.length) continue;
      idleLanes += lanes.length;
      lanes.sort((a, b) => ms(a.lastActivityAt) - ms(b.lastActivityAt) || a.id.localeCompare(b.id));
      const pr = (m: TicketMergeStatus) => `${m.repo}${m.pr ? `#${m.pr}` : ''}`;
      // An agent name is printed only in the shape of a role word: anything else is left out of the message.
      const named = (s: ChatSession) => (s.agent && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(s.agent.toLowerCase()) ? ` ${s.agent.toLowerCase()}` : '');
      const rows = [
        ...conf.map((i) => ({ id: i.t.id, line: `- ${ref(i.t)} conflict ${pr(i.pr)}: rebase onto the base branch` })),
        ...nop.map((i) => ({ id: i.t.id, line: `- ${ref(i.t)} no PR ${pr(i.pr)}: open the PR` })),
        ...work.slice(0, 5).map((x) => ({ id: x.id, line: `- ${ref(x)} ${x.priority} ${x.status}` })),
      ];
      const n = rows.length;
      await this.#tell(c, 'idle_lanes', l, h, null, rows.map((r) => r.id), [
        `${FLOW_PREFIX} ${plural(lanes.length, 'builder lane')} of yours ${lanes.length === 1 ? 'has' : 'have'} been idle ${t.laneIdleMs / MIN} min or more while your unit has work (program ${p.name}):`,
        ...lanes.slice(0, FLOW_LIMITS.ticketsPerMessage).map((s) => `- ${s.id}${named(s)} idle ${Math.floor((now - ms(s.lastActivityAt)) / MIN)} min`),
        'Give them the next items, conflicts first:',
        ...rows.slice(0, FLOW_LIMITS.ticketsPerMessage).map((r) => r.line),
        ...more(n),
        'Send each to an idle lane, or say on the ticket why not.',
      ]);
    }

    // (d) Bypass lost: reported only. A head asleep or gone whose own newest record says its sleep kept Bypass is not lost: its wake puts it
    // back through every gate (the policy, the capability, the person's own entry), and that wake is the only path the portal may take.
    let bypass = 0;
    for (const l of leads) {
      const h = heads.get(l) ?? null;
      const rec = newest([...lineOf(l)].map((id) => chat.lastBypass(id)));
      if (!rec || h?.mode === 'bypassPermissions') continue;
      if (rec.kind === 'bypass.left' && rec.actor === 'ui') continue; // a person turned it off
      if (rec.kind !== 'bypass.left' && rec.kind !== 'bypass.entered') continue;
      if (h && h.process !== 'live' && rec.kind === 'bypass.left' && rec.detail.kept === true && rec.sessionId === h.id) continue;
      bypass++;
      if (c.hold || this.#limited(c, 'bypass', l)) continue;
      c.st.sent[`bypass:${l}`] = now;
      this.#act(
        c,
        'bypass',
        'reported',
        h?.id ?? null,
        [],
        h
          ? 'This lead was in Bypass and is not now. The portal never enters Bypass for it: a person enters it again in the chat.'
          : 'This lead was in Bypass and has ended with no live continuation. Nothing was sent.',
      );
    }

    // (e) the owner, once per stall, when it lasts past the first nudge (or its start, when nothing could be nudged).
    const stall = c.st.stall[p.name];
    if (stall) {
      if (c.told && stall.nudgedAt === null) stall.nudgedAt = now;
      const base = stall.nudgedAt ?? stall.since;
      if (!c.hold && stall.notifiedAt === null && now - base >= t.notifyAfterMs) {
        stall.notifiedAt = now;
        this.#notifyOwner(c, inReview.length, stall.nudgedAt !== null);
      }
    }

    return {
      name: p.name,
      tag: p.tag,
      enabled: true,
      ok: true,
      paused: c.hold,
      mergeGate: gate,
      mergeGateLive: gateHead?.id ?? null,
      leads,
      counts: { merge: merge.length, qa: qa.length, idle, bypass, stall: stalled ? 1 : 0, conflict: conflict.length, no_pr: noPr.length, idle_lanes: idleLanes },
      inReview: inReview.length,
      doneRecent,
      stallSince: stall ? iso(stall.since) : null,
    };
  }

  /** T-2014: the merge gate's records of a ticket; none when the port has none or cannot be read (the old heuristic then). */
  #mergeStatus(id: string): TicketMergeStatus[] {
    try {
      return this.#d.tickets.mergeStatus?.(id) ?? [];
    } catch {
      return [];
    }
  }

  /** The gate's records, each corrected by the forge's word now: merged there is merged; closed unmerged has no PR; an open one is judged
   *  on its live head, and is a conflict when the forge cannot merge it. A record the forge does not answer for stands. */
  async #livePrs(c: Ctx, recorded: TicketMergeStatus[]): Promise<TicketMergeStatus[]> {
    const prs = this.#d.prs;
    if (!prs) return recorded;
    const out: TicketMergeStatus[] = [];
    for (const m of recorded) {
      if (m.state === 'merged' || m.pr === null || c.prReads >= FLOW_PR_READS) {
        out.push(m);
        continue;
      }
      c.prReads++;
      let v: FlowPrView | null = null;
      try {
        v = await prs.pr(m.repo, m.pr);
      } catch {
        v = null;
      }
      if (!v) out.push(m);
      else if (v.merged) out.push({ ...m, state: 'merged' });
      else if (v.state === 'closed') out.push({ ...m, state: 'no_pr', prHead: null });
      else {
        // T-2023: a recorded conflict speaks only for the head it named. Mergeable now: ready. Pushed to since (a rebase) and the forge has
        // not judged the new head yet: waiting, never the old conflict again.
        const moved = !!v.head && !!m.prHead && v.head !== m.prHead.toLowerCase();
        const state = v.mergeable === false ? 'conflict' : m.state === 'conflict' && v.mergeable ? 'ready' : m.state === 'conflict' && moved ? 'waiting' : m.state;
        out.push({ ...m, prHead: v.head ?? m.prHead, state });
      }
    }
    return out;
  }

  #selfTest(id: string, head: string): number | null {
    try {
      return selfTestAt(this.#d.tickets.comments?.(id) ?? [], head);
    } catch {
      return null;
    }
  }

  #limited(c: Ctx, cond: FlowCondition, lead: string): boolean {
    const last = c.st.sent[`${cond}:${lead}`];
    return typeof last === 'number' && c.now - last < c.t.repeatMs;
  }

  /**
   * Why a live head may not be told. Its process is gone or it is interrupted: a send would relaunch it, and the watchdog never relaunches
   * a session (Keep going or a person brings it back; an asleep one is only woken, as crew reports do). A person stopped it (on record, so
   * it holds across a portal restart). Keep going is paused for it (its own policy's program, or all).
   */
  #heldWhy(c: Ctx, h: ChatSession): string | null {
    if (h.process === 'gone' || h.state === 'interrupted')
      return 'This lead’s process is gone or interrupted: the watchdog never relaunches a session, nothing was sent.';
    try {
      if (this.#d.chat.stoppedByPerson(h.id)) return 'A person stopped this lead: nothing was sent.';
    } catch {
      return 'Whether a person stopped this lead could not be read: nothing was sent.';
    }
    let program: string | null = null;
    try {
      program = this.#d.keepGoing?.programOf(h.id) ?? null;
    } catch {
      program = null;
    }
    if (c.kgPaused(program)) return 'Keep going is paused for this lead: nothing was sent.';
    return null;
  }

  /**
   * One message to a lead's live session, rate limited per lead and condition. Never while the program is held (a pause), never to an
   * ended one (`head` null), one a person stopped or closed, or one Keep going's pause holds: each skip is recorded once per window. Only
   * when the owner may operate it. A refused send is recorded and waits for the next window.
   */
  async #tell(
    c: Ctx,
    cond: FlowCondition,
    lead: string | null,
    head: ChatSession | null,
    why: 'ended' | 'closed' | null,
    tickets: string[],
    lines: string[],
    note: string = NOTE[cond],
  ): Promise<boolean> {
    if (c.hold || !lead || this.#limited(c, cond, lead)) return false;
    c.st.sent[`${cond}:${lead}`] = c.now;
    if (!head || ended(head)) {
      this.#act(c, cond, 'skipped', null, tickets, why === 'closed' ? `A person closed the lead ${lead}: nothing was sent.` : `The lead ${lead} has no live session: nothing was sent.`);
      return false;
    }
    const held = this.#heldWhy(c, head);
    if (held) {
      this.#act(c, cond, 'skipped', head.id, tickets, held);
      return false;
    }
    const subject = { type: 'session' as const, id: head.id, workspaceId: head.workspaceId };
    if (!c.ownerId || !this.#d.owner.can(c.ownerId, 'operate', subject)) {
      this.#act(c, cond, 'skipped', head.id, tickets, 'The owner may not operate this session: nothing was sent.');
      return false;
    }
    try {
      await this.#d.chat.send(head.id, randomUUID(), lines.join('\n'), { priority: 'later', actor: FLOW_ACTOR, actorLabel: 'Flow watchdog' });
      c.told = true;
      this.#act(c, cond, 'told', head.id, tickets, note);
      return true;
    } catch (e) {
      this.#act(c, cond, 'failed', head.id, tickets, `The message was not taken (${String((e as Error).message ?? 'refused').slice(0, 80)}).`);
      return false;
    }
  }

  #notifyOwner(c: Ctx, inReview: number, nudged: boolean): void {
    const hours = Math.round(c.t.stallMs / (60 * MIN));
    const why = `Nothing done in ${hours} h while ${inReview} wait in review${nudged ? ', after the leads were told' : ' and no lead could be told'}`;
    const sent = c.ownerId
      ? this.#d.bus?.emit({
          kind: 'keepgoing_attention',
          subject: { type: 'portal', id: `flow-${c.p.name}` },
          facts: { what: 'flow_stalled', program: c.p.name, inReview, hours },
          audience: [c.ownerId],
        })
      : null;
    if (sent) this.#act(c, 'stall', 'notified', null, [], `${why}: the owner was notified.`);
    else this.#act(c, 'stall', 'failed', null, [], `${why}: the owner could not be notified.`);
  }

  #act(c: Ctx, condition: FlowCondition, kind: FlowActionKind, sessionId: string | null, tickets: string[], note: string): void {
    const named = tickets.slice(0, FLOW_LIMITS.ticketsPerMessage);
    // T-2016: the card shows bucket keys (KONF-12); a ticket whose key is not known this round shows its id.
    const keys = named.map((id) => c.keyOf.get(id) ?? id);
    const a: FlowAction = { at: iso(c.now), program: c.p.name, condition, kind, sessionId, tickets: named, keys, note };
    c.st.actions.unshift(a);
    c.st.actions.length = Math.min(c.st.actions.length, FLOW_LIMITS.kept);
    try {
      this.#d.audit?.record({
        severity: kind === 'notified' || kind === 'failed' || condition === 'bypass' ? 'medium' : 'info',
        kind: `flow.${kind}`,
        actor: FLOW_ACTOR,
        userId: c.ownerId,
        subject: sessionId ? `session:${sessionId}` : `flow:${c.p.name}`,
        detail: { program: c.p.name, condition, sessionId, tickets: a.tickets.slice(0, 10) },
      });
    } catch (e) {
      console.error(`[flow] an audit row could not be written: ${(e as Error).message}`);
    }
  }
}

const NOTE: Record<FlowCondition, string> = {
  merge: 'Told the merge-gate lead which tickets have a QA PASS and wait to be merged.',
  qa: 'Asked a peer lead to verify tickets nobody verifies (QA-ASK).',
  idle: 'Told an idle lead its next tickets.',
  bypass: 'Reported a lead out of Bypass.',
  stall: 'Told the owner the program has stalled.',
  conflict: 'Told a unit lead which pull requests need a rebase.',
  no_pr: 'Told a unit lead which tickets in review have no pull request.',
  idle_lanes: 'Told a lead which of its builder lanes are idle and what to give them.',
};

/** T-3198: the card's note when the session told is the crew root holding outside tickets, not the program's gate or a peer lead. */
const OWN_NOTE = {
  merge: 'Told the lead whose crew holds these tickets (no lead of the program does) that they wait to be merged.',
  qa: 'Asked the lead whose crew holds these tickets (no lead of the program does) to have them verified.',
} as const;

const more = (n: number) => (n > FLOW_LIMITS.ticketsPerMessage ? [`- and ${n - FLOW_LIMITS.ticketsPerMessage} more`] : []);

function newest(recs: (FlowBypassRecord | null)[]): FlowBypassRecord | null {
  let best: FlowBypassRecord | null = null;
  for (const r of recs) if (r && (!best || ms(r.at) > ms(best.at))) best = r;
  return best;
}

function emptyView(p: FlowProgram, enabled: boolean, ok: boolean): FlowProgramView {
  return {
    name: p.name,
    tag: p.tag,
    enabled,
    ok,
    paused: null,
    mergeGate: p.mergeGate,
    mergeGateLive: null,
    leads: [],
    counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0, conflict: 0, no_pr: 0, idle_lanes: 0 },
    inReview: 0,
    doneRecent: 0,
    stallSince: null,
  };
}
