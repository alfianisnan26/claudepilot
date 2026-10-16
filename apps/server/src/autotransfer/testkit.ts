// Test helpers for auto transfer: a chat controller that can move a chat (the Move flow's observable effects: the chat keeps its id, its
// Claude changes, a "Moved to" row with the move's id), a usage snapshot from fixtures, a clock with manual timers, a settings map.
// Nothing here runs a workspace or contacts anyone.

import { AppError } from '@isnanme/core';
import type { ChatEvent, ChatSession, ChatSwitchOptions, ClaudeUsage, ClaudeUsageWindow } from '@portal/contracts';
import { unavailableFigure } from '@portal/contracts';
import { FakeChat, session } from '../notify/testkit.js';
import { recommendMove } from '../claudeusage/recommend.js';
import type { ClockPort, UsagePort } from './ports.js';

export const T0 = Date.parse('2026-10-12T12:00:00.000Z');
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

export function win(key: string, usedPct: number, resetsAt = at(180)): ClaudeUsageWindow {
  const label = key === 'session' ? 'Session' : key === 'week' ? 'Week' : key;
  return { key, label, usedPct, resetsAt, level: usedPct >= 100 ? 'exhausted' : usedPct >= 90 ? 'high' : usedPct >= 75 ? 'near' : 'ok' };
}

export function usage(id: string, name: string, windows: ClaudeUsageWindow[], over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    claudeId: id,
    claudeName: name,
    workspaceId: 'docker/api-dev',
    workspaceName: 'api-dev',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows,
    extra: null,
    checkedAt: at(-5),
    source: null,
    stale: false,
    workspaceRunning: true,
    problem: null,
    unavailable: null,
    limitReport: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: null,
    outlook: { status: unavailableFigure('no_reading'), window: null, etaAt: unavailableFigure('no_reading'), projectedPct: unavailableFigure('no_reading') },
    trend: null,
    ...over,
  };
}

/** A clock whose timers run only when the test advances it. */
export function fakeClock(start = T0): ClockPort & { advance(min: number): void; set(ms: number): void; pending(): number } {
  let now = start;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    timer(ms, fn) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    advance(min) {
      now += min * 60_000;
      const due = timers.filter((t) => t.live && t.at <= now);
      timers = timers.filter((t) => t.live && t.at > now);
      for (const t of due) t.fn();
    },
    set(ms) {
      now = ms;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

/** The Move flow's observable effects, recorded. */
export class MoveChat extends FakeChat {
  readonly events = new Map<string, ChatEvent[]>();
  readonly moves: { id: string; to: string; handoff: string | undefined; model?: string }[] = [];
  /** Model changes in place, in order. */
  readonly models: { id: string; model: string }[] = [];
  /** What the engine said to a chat (the steer, the continuation), in order. */
  readonly sent: { id: string; text: string; priority: string; actor: string }[] = [];
  /** `send` fails this many times (a CONFLICT), then works; `sendTries` counts every call (T-781 S5). */
  sendFails = 0;
  sendTries = 0;
  async send(id: string, text: string, opts: { priority: 'next' | 'later'; actor: string; actorLabel?: string }): Promise<void> {
    const s = this.get(id);
    this.sendTries++;
    if (this.sendFails > 0) {
      this.sendFails--;
      throw new AppError('CONFLICT', 'The session is restarting.');
    }
    if (!s || s.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    this.sent.push({ id, text, priority: opts.priority, actor: opts.actor });
  }
  readonly names = new Map<string, string>([
    ['work', 'Work'],
    ['home', 'Home'],
    ['spare', 'Spare'],
  ]);
  dropped = { approvals: 0, queued: 0, agents: 0 };
  handoffOk = true;
  fail: string | null = null;
  /** The error code a failing move throws (SERVICE_UNAVAILABLE when unset). */
  failCode: string | null = null;
  /** When set, a failing move fails this many times and then succeeds. */
  failTimes: number | null = null;
  #n = 0;

  list(filter: { workspaceId?: string } = {}) {
    return [...this.sessions.values()].filter((s) => !filter.workspaceId || s.workspaceId === filter.workspaceId);
  }
  history(id: string, after = 0) {
    return (this.events.get(id) ?? []).filter((e) => e.seq > after);
  }
  async switchOptions(id: string): Promise<ChatSwitchOptions> {
    const s = this.get(id)!;
    return {
      sessionId: id,
      via: 'own',
      options: [...this.names.entries()].filter(([c]) => c !== s.claudeId).map(([c, name]) => ({ claude: { id: c, name, workspaceId: s.workspaceId } as never, ok: true, reason: null, fix: null })),
      folder: s.cwd,
      worktree: null,
      handoff: { ok: this.handoffOk, reason: this.handoffOk ? null : 'An approval is waiting.' },
      working: s.state === 'working',
      dropped: this.dropped,
    };
  }
  /** What each Claude's list_models said (T-109); absent: not known. */
  readonly families = new Map<string, string[]>();
  modelFamilies(claudeId: string): string[] | null {
    return this.families.get(claudeId) ?? null;
  }
  /** The model that applies after a move asked for one (T-109): the Move flow may go further down the chain. Unset: what was asked. */
  appliedModel: string | null = null;
  async switchClaude(id: string, to: string, opts: { handoff?: 'ask' | 'skip'; model?: string }): Promise<ChatSession> {
    this.moves.push({ id, to, handoff: opts.handoff, ...(opts.model ? { model: opts.model } : {}) });
    if (this.fail) {
      const msg = this.fail;
      // `failTimes`: the move fails that many times, then works (T-781).
      if (this.failTimes !== null && --this.failTimes <= 0) {
        this.fail = null;
        this.failTimes = null;
      }
      throw new AppError((this.failCode ?? 'SERVICE_UNAVAILABLE') as 'SERVICE_UNAVAILABLE', msg);
    }
    const s = this.get(id)!;
    const name = this.names.get(to)!;
    const handoffId = `h-${++this.#n}`;
    const seq = s.lastSeq + 1;
    const ev: ChatEvent = { seq, at: new Date().toISOString(), kind: 'system', text: `Moved to ${name}`, transfer: { fromClaude: s.claudeName ?? 'Claude', toClaude: name, sourceSessionId: id, path: '/tmp/x', messages: 1, truncated: false, handoffId } };
    this.events.set(id, [...(this.events.get(id) ?? []), ev]);
    const model = opts.model ? (this.appliedModel ?? opts.model) : s.model;
    const moved = { ...s, claudeId: to, claudeName: name, lastSeq: seq, model };
    this.sessions.set(id, moved);
    this.dispatch(id, { type: 'session', session: moved });
    return moved;
  }
  async setModel(id: string, model: string): Promise<void> {
    this.models.push({ id, model });
    if (this.fail) throw new AppError('SERVICE_UNAVAILABLE', this.fail);
    const s = this.get(id)!;
    const changed = { ...s, model };
    this.sessions.set(id, changed);
    this.dispatch(id, { type: 'session', session: changed });
  }
  /** A person moves the chat with the normal dialog (an Undo). */
  personMoves(id: string, to: string) {
    const s = this.get(id)!;
    const moved = { ...s, claudeId: to, claudeName: this.names.get(to)! };
    this.sessions.set(id, moved);
    this.dispatch(id, { type: 'session', session: moved });
  }
  /** Chats whose running turn the engine stopped (T-781, the hard move). */
  readonly interrupted: string[] = [];
  async interrupt(id: string): Promise<void> {
    this.interrupted.push(id);
    const s = this.get(id);
    if (s) this.sessions.set(id, { ...s, state: 'idle' });
  }
  /** The chat is deleted from the portal (a `removed` message). */
  removes(id: string) {
    this.sessions.delete(id);
    this.dispatch(id, { type: 'removed', session: id });
  }
  /** The chat's stored events, as the history gives them (`at` is the fake clock's time). */
  stored(id: string, items: { at: string; kind?: ChatEvent['kind']; text?: string }[]) {
    const evs = items.map((e, i) => ({ seq: i + 1, kind: e.kind ?? 'assistant', text: e.text ?? 'x', at: e.at }) as ChatEvent);
    this.events.set(id, evs);
    const s = this.get(id)!;
    this.sessions.set(id, { ...s, lastSeq: evs.length });
  }
  /** The chat ends (T-781: the engine forgets what it kept for it). */
  ends(id: string) {
    const ended = { ...this.get(id)!, state: 'ended' as const };
    this.sessions.set(id, ended);
    this.dispatch(id, { type: 'session', session: ended });
  }
  /** A main-thread turn ends: the `result` row, then the chat at `idle`. */
  turnEnds(id: string) {
    const s = this.get(id)!;
    const seq = s.lastSeq + 1;
    const idle = { ...s, state: 'idle' as const, lastSeq: seq };
    this.sessions.set(id, idle);
    this.dispatch(id, { type: 'events', session: id, items: [{ seq, at: new Date().toISOString(), kind: 'result' }] });
    this.dispatch(id, { type: 'session', session: idle });
  }
}

export function chatSession(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return session(id, { state: 'idle', title: 'CANARY-TITLE secret', claudeId: 'work', claudeName: 'Work', model: 'claude-sonnet-4-5', waiting: 0, ...over });
}

/** The usage monitor over fixtures (read as given; `calls` counts reads). */
export function fakeUsage(claudes: () => ClaudeUsage[]): UsagePort & { calls: number; reading(): void } {
  const listeners = new Set<() => void>();
  const u = {
    calls: 0,
    async report() {
      u.calls++;
      return { claudes: claudes() };
    },
    recommend: recommendMove,
    onReading(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** The monitor took a new reading. */
    reading() {
      for (const fn of listeners) fn();
    },
  };
  return u;
}

export function settingsMap(values: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(values));
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
}
