// The flow watchdog (T-1966, docs/prd/flow-watchdog.md): a deterministic loop INSIDE the portal, no model. Work in a program (merging a
// QA PASS, sending QA, dispatching the next ticket) is done by lead sessions that only act when messaged; when the session that used to wake
// them stops, nothing moves (2026-10-20/21: 4 tickets done in 24 h while in review went from 50 to 92). Every 5 minutes, per program, it
// counts five conditions and messages the lead that can clear each:
//   merge   in review, a QA PASS on the head, not merged for `flow.mergeAfterMin`   -> the merge-gate lead, the exact list (ids, keys, heads)
//   qa      in review, no verdict on the head, nobody on it for `flow.qaAfterMin`   -> a peer lead, round robin, never the author's: QA-ASK
//                                                                                        as one batch (D-93, T-1987): at most 8 per peer per
//                                                                                        message; a ticket already in a live batch is skipped
//   idle    a lead idle `flow.idleAfterMin` with open work in its unit, under cap   -> that lead, its next tickets (oldest high priority first)
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
  type TicketStatus,
  type Verb,
} from '@portal/contracts';
import type { ClockPort } from '../autotransfer/ports.js';
import type { NotifyBus } from '../notify/bus.js';
import type { AuditInput } from '../platform/audit.js';
import { evaluateVerdicts, type StoredVerdict } from '../tickets/verdicts.js';
import { crewRoot, lineage, parseLeadPeerGroups, resolveHead, parsePrograms, type FlowProgram, type SessionReader } from './programs.js';
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

    // (a) and (b): the tickets in review, judged on their head.
    const merge: { t: TicketItem; head: string }[] = [];
    const qa: { t: TicketItem; head: string | null }[] = [];
    const inReview = open.filter((x) => x.status === 'in_review');
    for (const x of inReview) {
      const verdicts = this.#d.tickets.verdicts(x.id);
      const head = headOf(verdicts, this.#d.tickets.checks(x.id));
      const qaRole = head ? evaluateVerdicts(verdicts, head, ['qa']).roles.qa : 'missing';
      if (qaRole === 'pass' && head) {
        const passAt = Math.max(...verdicts.filter((v) => v.role === 'qa' && v.verdict === 'pass' && v.commit === head).map((v) => ms(v.at)));
        if (now - passAt >= t.mergeAfterMs) merge.push({ t: x, head });
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
      const rows = merge.slice(0, FLOW_LIMITS.ticketsPerMessage).map((m) => `- ${ref(m.t)} QA PASS on ${m.head} (newest seen)`);
      await this.#tell(c, 'merge', gate, gateHead, gateResolved.why, merge.map((m) => m.t.id), [
        `${FLOW_PREFIX} ${plural(merge.length, 'ticket')} in review ${merge.length === 1 ? 'has' : 'have'} a QA PASS on the newest commit the portal has seen and ${merge.length === 1 ? 'is' : 'are'} not merged after ${t.mergeAfterMs / MIN} min (program ${p.name}). Check that commit is still the branch head, then merge or close each, or say on the ticket why not:`,
        ...rows,
        ...more(merge.length),
      ]);
    }

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
      counts: { merge: merge.length, qa: qa.length, idle, bypass, stall: stalled ? 1 : 0 },
      inReview: inReview.length,
      doneRecent,
      stallSince: stall ? iso(stall.since) : null,
    };
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
    counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0 },
    inReview: 0,
    doneRecent: 0,
    stallSince: null,
  };
}
