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
//   qa      in review, no verdict on the head, nobody on it for `flow.qaAfterMin`   -> a peer lead, round robin, never the author's: QA-ASK
//                                                                                        as one batch (D-93, T-1987): at most 8 per peer per
//                                                                                        message; a ticket already in a live batch is skipped
//   idle    a lead idle `flow.idleAfterMin` with open work in its unit, under cap   -> that lead, its next tickets (oldest high priority first)
//   idle_lanes  a lead's unit has conflicts, no_pr or open work while its builders idle -> that lead: the idle lane ids, the stale workers to
//               `flow.laneIdleMin`, its workers idle `flow.staleLaneMin` hold its cap,     end, "no builder alive", and the next items
//               or it has conflicts/no_pr and no live builder (T-2018)                   (conflicts, then no_pr, then oldest high priority)
//   bypass  a lead that was in Bypass is not now                                      -> reported only (audit and the card): see below
//   stall   nothing done in `flow.stallHours` while tickets wait in review           -> the owner, once, if it lasts `flow.notifyAfterHours`
//                                                                                        after the first nudge
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
}

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
}

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
        view.push(await this.#program({ p, st, t, now, ownerId, told: false, hold, kgPaused }, groups));
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
    // A lead that may hear from the watchdog now: it runs, no person stopped it, and Keep going is not paused for it.
    const reachable = (l: string) => {
      const h = heads.get(l);
      return !!h && !this.#heldWhy(c, h);
    };

    // (a) and (b): the tickets in review, judged on their head. T-2014: the head is the PR head the merge gate recorded when it recorded one
    // (the newest record of a repo not merged); a ticket merged in every repo it was recorded in is skipped; conflict and no_pr go to the
    // unit lead. Without a record, the newest commit the portal has seen, as before, and the row says so.
    const merge: { t: TicketItem; head: string; pr: TicketMergeStatus | null }[] = [];
    const qa: { t: TicketItem; head: string | null }[] = [];
    const conflict: { t: TicketItem; pr: TicketMergeStatus }[] = [];
    const noPr: { t: TicketItem; pr: TicketMergeStatus }[] = [];
    const inReview = open.filter((x) => x.status === 'in_review');
    for (const x of inReview) {
      const recorded = this.#mergeStatus(x.id);
      const pending = recorded.filter((m) => m.state !== 'merged').sort((a, b) => ms(b.at) - ms(a.at));
      if (recorded.length && !pending.length) continue;
      const pr = pending[0] ?? null;
      if (pr && (pr.state === 'conflict' || pr.state === 'no_pr')) {
        // T-2018: at once, the round they are seen (the rate limit still holds): 15 PRs sat in conflict while builders idled.
        (pr.state === 'conflict' ? conflict : noPr).push({ t: x, pr });
        continue;
      }
      const verdicts = this.#d.tickets.verdicts(x.id);
      const head = pr?.prHead ?? headOf(verdicts, this.#d.tickets.checks(x.id));
      // With a recorded PR, the merge gate's own rule: a review PASS on that head as well when the ticket was reviewed at all.
      const need: ('qa' | 'review')[] = pr && verdicts.some((v) => v.role === 'review') ? ['qa', 'review'] : ['qa'];
      const ev = head ? evaluateVerdicts(verdicts, head, need) : null;
      const qaRole = ev ? ev.roles.qa : 'missing';
      if (ev?.pass && head) {
        const passAt = Math.max(...need.map((r) => Math.max(...verdicts.filter((v) => v.role === r && v.verdict === 'pass' && v.commit === head).map((v) => ms(v.at)))));
        if (now - passAt >= t.mergeAfterMs) merge.push({ t: x, head, pr });
      } else if (qaRole === 'missing' || qaRole === 'stale') {
        if (now - ms(x.updatedAt) < t.qaAfterMs) continue;
        const working = chat.list({ ticketId: x.id }).some((s) => !ended(s) && (s.state === 'working' || s.state === 'starting' || now - ms(s.lastActivityAt) < t.qaAfterMs));
        if (working) continue;
        // T-1987 (D-93): a ticket a QA lane already took into a batch (named after its newest verdict, recently) waits for that batch.
        const batch = this.#d.tickets.batchOf?.(x.id) ?? null;
        if (batch && now - ms(batch.at) < FLOW_LIMITS.batchLiveMin * MIN) continue;
        qa.push({ t: x, head });
      }
    }

    // (e) first: a nudge sent this round counts as the stall's first.
    const stalled = inReview.length > 0 && doneRecent === 0;
    if (!stalled) delete c.st.stall[p.name];
    else c.st.stall[p.name] ??= { since: now, nudgedAt: null, notifiedAt: null };

    if (merge.length) {
      // Recorded PR heads first: those are the gate's own facts; the heuristic rows after, labelled.
      const sorted = [...merge].sort((a, b) => Number(!a.pr) - Number(!b.pr));
      const rows = sorted
        .slice(0, FLOW_LIMITS.ticketsPerMessage)
        .map((m) => (m.pr ? `- ${ref(m.t)} ${m.pr.repo}#${m.pr.pr} QA PASS on the PR head ${m.head} (${m.pr.state})` : `- ${ref(m.t)} QA PASS on ${m.head} (newest seen, no PR status)`));
      await this.#tell(c, 'merge', gate, gateHead, gateResolved.why, sorted.map((m) => m.t.id), [
        `${FLOW_PREFIX} ${plural(merge.length, 'ticket')} in review ${merge.length === 1 ? 'has' : 'have'} a QA PASS and ${merge.length === 1 ? 'is' : 'are'} not merged after ${t.mergeAfterMs / MIN} min (program ${p.name}). A row with a PR is judged on the PR head you recorded (ticket_merge_status); a row marked (newest seen, no PR status) is the newest commit the portal has seen: check it is the PR head and record the PR. Merge or close each, or record why not with ticket_merge_status:`,
        ...rows,
        ...more(merge.length),
      ]);
    }

    // T-2014: conflict and no_pr, each to the ticket's unit lead (the lead whose unit holds it); a ticket with no unit lead is reported.
    const toUnits = async (cond: 'conflict' | 'no_pr', list: { t: TicketItem; pr: TicketMergeStatus }[]) => {
      const byLead = new Map<string, { t: TicketItem; pr: TicketMergeStatus }[]>();
      const orphans: string[] = [];
      for (const it of list) {
        const l = leadOf(it.t);
        if (l) byLead.set(l, [...(byLead.get(l) ?? []), it]);
        else orphans.push(it.t.id);
      }
      for (const [l, items] of byLead) {
        const n = items.length;
        await this.#tell(c, cond, l, heads.get(l) ?? null, resolved.get(l)?.why ?? null, items.map((i) => i.t.id), [
          cond === 'conflict'
            ? `${FLOW_PREFIX} the merge gate recorded a conflict on ${plural(n, 'pull request')} of your unit (program ${p.name}). Send ${n === 1 ? 'it' : 'each'} back to its builder for a rebase onto the base branch; QA then verifies the new head:`
            : `${FLOW_PREFIX} the merge gate recorded no pull request for ${plural(n, 'ticket')} of your unit in review (program ${p.name}). Open the PR for each (or have its builder open it), or say on the ticket why not:`,
          ...items.slice(0, FLOW_LIMITS.ticketsPerMessage).map((i) => `- ${ref(i.t)} ${i.pr.repo}${i.pr.pr ? `#${i.pr.pr}` : ''}${i.pr.prHead ? ` head ${i.pr.prHead}` : ''}`),
          ...more(n),
        ]);
      }
      if (orphans.length && !c.hold && !this.#limited(c, cond, `program-${p.name}`)) {
        c.st.sent[`${cond}:program-${p.name}`] = c.now;
        this.#act(c, cond, 'skipped', null, orphans, 'No unit lead of the program holds these: nobody was told.');
      }
    };
    if (conflict.length) await toUnits('conflict', conflict);
    if (noPr.length) await toUnits('no_pr', noPr);

    if (qa.length) {
      // Round robin over the peer leads that run, never the author's own (the lead whose unit holds the ticket).
      const live = leads.filter(reachable);
      const byLead = new Map<string, { t: TicketItem; head: string | null }[]>();
      let rr = c.st.rr[p.name] ?? 0;
      const unplaced: string[] = [];
      for (const q of qa) {
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
      for (const [l, list] of byLead)
        await this.#tell(c, 'qa', l, heads.get(l) ?? null, null, list.map((q) => q.t.id), [
          `${FLOW_PREFIX} QA-ASK batch: take these as one qa/batch branch, one job run, a verdict per ticket (D-93). Program ${p.name}: ${plural(list.length, 'ticket')} in review ${list.length === 1 ? 'has' : 'have'} no verdict on the head and nobody working on ${list.length === 1 ? 'it' : 'them'} for ${t.qaAfterMs / MIN} min. Send a QA lane that is not the author; it records each ticket's verdict on that ticket's head (ticket_verdict_batch, the job run as evidence):`,
          ...list.map((q) => `- ${ref(q.t)} head ${q.head ?? 'unknown'}${holder(q.t) ? ` held by ${holder(q.t)}` : ''}`),
        ]);
      if (unplaced.length && !c.hold && !this.#limited(c, 'qa', `program-${p.name}`)) {
        c.st.sent[`qa:program-${p.name}`] = c.now;
        this.#act(c, 'qa', 'skipped', null, unplaced, 'No peer lead that is not the author runs and may be told: nobody was asked to verify these.');
      }
    }

    // (c) idle leads with open work in their unit and room under their cap.
    let idle = 0;
    const unitOpen = open.filter((x) => x.status === 'open' || x.status === 'in_progress');
    for (const l of leads) {
      const h = heads.get(l);
      if (!h || h.state !== 'idle' || h.waiting > 0 || h.busySince || (h.agentsRunning ?? 0) > 0) continue;
      const idleMs = now - ms(h.lastActivityAt);
      if (!(idleMs >= t.idleAfterMs)) continue;
      const unit = unitOpen.filter((x) => leadOf(x) === l);
      if (!unit.length) continue;
      const workers = chat.list({ parentId: h.id }).filter((s) => s.parentId === h.id && !ended(s)).length;
      const cap = chat.maxWorkers(h);
      if (cap !== null && workers >= cap) continue;
      idle++;
      const next = [...unit].sort((a, b) => rank(a.priority) - rank(b.priority) || ms(a.createdAt) - ms(b.createdAt) || a.number - b.number);
      await this.#tell(c, 'idle', l, h, null, next.slice(0, 5).map((x) => x.id), [
        `${FLOW_PREFIX} you have been idle ${Math.floor(idleMs / MIN)} min while your unit holds ${plural(unit.length, 'open ticket')} and runs ${workers} of ${cap ?? 'unlimited'} workers (program ${p.name}). Your next tickets, oldest high priority first:`,
        ...next.slice(0, 5).map((x) => `- ${ref(x)} ${x.priority} ${x.status}`),
        'Dispatch them, or say on each ticket why not.',
      ]);
    }

    // T-2018 idle lanes: a lead that may be told (reachable: live, not stopped by a person, Keep going not paused for it) whose unit has a
    // conflict, a missing PR or open work, and that has (1) builder workers (direct children of any id it went by, a builder role name) idle
    // past `flow.laneIdleMin`, (2) direct workers of any role idle past `flow.staleLaneMin` (they hold its worker cap: end them to free a
    // slot), or (3) conflicts or missing PRs and no live builder at all (spawn one). The lead acts; the watchdog only names the lanes and the
    // next items, and never ends or starts a session itself. QA and review lanes are never counted as idle builders (they take QA-ASK batches).
    let idleLanes = 0;
    const idleFor = (s: ChatSession) => now - ms(s.lastActivityAt);
    const quiet = (s: ChatSession) => s.state !== 'working' && s.state !== 'starting' && s.waiting === 0 && !s.busySince && (s.agentsRunning ?? 0) === 0;
    // An agent name is printed only in the shape of one (a role word): anything else is left out of the message.
    const named = (s: ChatSession) => (s.agent && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(s.agent.toLowerCase()) ? ` ${s.agent.toLowerCase()}` : '');
    for (const l of leads) {
      if (!reachable(l)) continue;
      const h = heads.get(l)!;
      const seen = new Set<string>();
      const workers: ChatSession[] = [];
      for (const id of new Set([h.id, ...lineOf(l)]))
        for (const s of chat.list({ parentId: id })) {
          if (s.parentId !== id || seen.has(s.id) || ended(s)) continue;
          seen.add(s.id);
          workers.push(s);
        }
      const builders = workers.filter((s) => s.process !== 'gone' && isBuilderLaneName(s.agent));
      const lanes = builders.filter((s) => s.state === 'idle' && quiet(s) && idleFor(s) >= t.laneIdleMs);
      const stale = workers.filter((s) => quiet(s) && idleFor(s) >= t.staleLaneMs);
      const mine = <T extends { t: TicketItem }>(xs: T[]) => xs.filter((i) => leadOf(i.t) === l);
      const conf = mine(conflict);
      const nop = mine(noPr);
      const work = unitOpen
        .filter((x) => leadOf(x) === l)
        .sort((a, b) => rank(a.priority) - rank(b.priority) || ms(a.createdAt) - ms(b.createdAt) || a.number - b.number);
      if (!conf.length && !nop.length && !work.length) continue;
      const noBuilder = !builders.length && conf.length + nop.length > 0;
      if (!lanes.length && !stale.length && !noBuilder) continue;
      idleLanes += new Set([...lanes, ...stale].map((s) => s.id)).size;
      const oldest = (a: ChatSession, b: ChatSession) => ms(a.lastActivityAt) - ms(b.lastActivityAt) || a.id.localeCompare(b.id);
      lanes.sort(oldest);
      stale.sort(oldest);
      const pr = (m: TicketMergeStatus) => `${m.repo}${m.pr ? `#${m.pr}` : ''}`;
      const rows = [
        ...conf.map((i) => ({ id: i.t.id, line: `- ${ref(i.t)} conflict ${pr(i.pr)}: rebase onto the base branch` })),
        ...nop.map((i) => ({ id: i.t.id, line: `- ${ref(i.t)} no PR ${pr(i.pr)}: open the PR` })),
        ...work.slice(0, 5).map((x) => ({ id: x.id, line: `- ${ref(x)} ${x.priority} ${x.status}` })),
      ];
      const n = rows.length;
      const cap = FLOW_LIMITS.ticketsPerMessage;
      await this.#tell(c, 'idle_lanes', l, h, null, rows.map((r) => r.id), [
        `${FLOW_PREFIX} your unit has work and lanes that do not move it (program ${p.name}).`,
        ...(lanes.length
          ? [`${plural(lanes.length, 'builder lane')} idle ${t.laneIdleMs / MIN} min or more:`, ...lanes.slice(0, cap).map((s) => `- ${s.id}${named(s)} idle ${Math.floor(idleFor(s) / MIN)} min`)]
          : []),
        ...(noBuilder ? ['No builder alive: spawn one for the conflicts and missing PRs below.'] : []),
        ...(stale.length
          ? [
              `End these to free slots (${plural(stale.length, 'worker')} idle ${t.staleLaneMs / MIN} min or more hold your worker cap; the watchdog never ends a session):`,
              ...stale.slice(0, cap).map((s) => `- ${s.id}${named(s)} idle ${Math.floor(idleFor(s) / MIN)} min`),
            ]
          : []),
        'The next items, conflicts first:',
        ...rows.slice(0, cap).map((r) => r.line),
        ...more(n),
        lanes.length ? 'Send each to an idle lane, or say on the ticket why not.' : 'Start a builder for each, or say on the ticket why not.',
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
  ): Promise<void> {
    if (c.hold || !lead || this.#limited(c, cond, lead)) return;
    c.st.sent[`${cond}:${lead}`] = c.now;
    if (!head || ended(head))
      return this.#act(c, cond, 'skipped', null, tickets, why === 'closed' ? `A person closed the lead ${lead}: nothing was sent.` : `The lead ${lead} has no live session: nothing was sent.`);
    const held = this.#heldWhy(c, head);
    if (held) return this.#act(c, cond, 'skipped', head.id, tickets, held);
    const subject = { type: 'session' as const, id: head.id, workspaceId: head.workspaceId };
    if (!c.ownerId || !this.#d.owner.can(c.ownerId, 'operate', subject))
      return this.#act(c, cond, 'skipped', head.id, tickets, 'The owner may not operate this session: nothing was sent.');
    try {
      await this.#d.chat.send(head.id, randomUUID(), lines.join('\n'), { priority: 'later', actor: FLOW_ACTOR, actorLabel: 'Flow watchdog' });
      c.told = true;
      this.#act(c, cond, 'told', head.id, tickets, NOTE[cond]);
    } catch (e) {
      this.#act(c, cond, 'failed', head.id, tickets, `The message was not taken (${String((e as Error).message ?? 'refused').slice(0, 80)}).`);
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
    const a: FlowAction = { at: iso(c.now), program: c.p.name, condition, kind, sessionId, tickets: tickets.slice(0, FLOW_LIMITS.ticketsPerMessage), note };
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
  idle_lanes: 'Told a lead which of its lanes are idle or stale, or that no builder is alive, and what its unit waits on.',
};

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
