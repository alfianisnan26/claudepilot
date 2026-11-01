// Test helpers for triggers: a fresh store, a fake chat controller and tickets service that record what they were asked, an owner adapter
// with users and workspace rights held in maps (two fake users for the cross-user matrix), a fake clock, and the module's parts wired as
// the platform wires them. Nothing here contacts a third party.

import { AppError, isAppError } from '@isnanme/core';
import type { ChatServerMessage, ChatSession, NotifyEvent, NotifySubject, Verb } from '@portal/contracts';
import { Hono } from 'hono';
import { createBus } from '../notify/bus.js';
import { freshStore, session } from '../notify/testkit.js';
import { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { Caller } from '../tickets/service.js';
import { mountReceiver } from './receiver.js';
import { createTriggerRoutes } from './routes.js';
import { TriggerRunner, type TriggerChat, type TriggerTickets } from './runner.js';
import { TriggerScheduler } from './scheduler.js';
import { TriggerService } from './service.js';
import { TriggerStore } from './store.js';

export { freshStore, session };

export class Clock {
  constructor(public ms = Date.parse('2026-10-12T02:00:00.000Z')) {}
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
  timers: { at: number; fn: () => void }[] = [];
  setTimer = (ms: number, fn: () => void) => {
    const t = { at: this.ms + ms, fn };
    this.timers.push(t);
    return () => void (this.timers = this.timers.filter((x) => x !== t));
  };
  runDue() {
    const due = this.timers.filter((t) => t.at <= this.ms);
    this.timers = this.timers.filter((t) => t.at > this.ms);
    for (const t of due) t.fn();
  }
}

/** A chat controller: sessions in a map; every call recorded. `fail` makes the next create throw that code. */
export class FakeTriggerChat implements TriggerChat {
  sessions = new Map<string, ChatSession>();
  calls: { op: string; args: unknown[] }[] = [];
  listeners = new Set<(id: string, m: ChatServerMessage) => void>();
  fail: string | null = null;
  n = 0;
  async create(req: Parameters<TriggerChat['create']>[0], opts: Parameters<TriggerChat['create']>[1]): Promise<ChatSession> {
    this.calls.push({ op: 'create', args: [req, opts] });
    if (this.fail) {
      const code = this.fail;
      this.fail = null;
      throw new AppError(code as never, 'refused');
    }
    const id = `ses_${++this.n}`;
    const s = session(id, { workspaceId: req.workspaceId, title: req.title, startedBy: opts.actor, state: 'working', bypassCapable: Object.hasOwn(opts, 'bypassOptIn'), worktree: req.worktree ? { branch: `pilot/${id}`, path: `/w/${id}`, repo: '/w' } as never : null });
    this.sessions.set(id, s);
    return s;
  }
  async send(...args: Parameters<TriggerChat['send']>) {
    this.calls.push({ op: 'send', args });
  }
  async control(...args: Parameters<TriggerChat['control']>) {
    this.calls.push({ op: 'control', args });
  }
  async interrupt(id: string) {
    this.calls.push({ op: 'interrupt', args: [id] });
  }
  async end(id: string, opts?: { children?: 'end' }) {
    this.calls.push({ op: 'end', args: [id, opts] });
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, state: 'ended', endedReason: 'closed by operator' });
  }
  get = (id: string) => this.sessions.get(id) ?? null;
  children = (id: string) => [...this.sessions.values()].filter((s) => s.parentId === id);
  onEvent(cb: (id: string, m: ChatServerMessage) => void) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  emit(id: string, m: ChatServerMessage) {
    for (const l of this.listeners) l(id, m);
  }
  /** A turn ended with this cost (the session's total so far). */
  result(id: string, costUsd: number, opts: { error?: boolean; agent?: boolean } = {}) {
    const s = this.sessions.get(id)!;
    this.sessions.set(id, { ...s, costUsd });
    this.emit(id, { type: 'events', sessionId: id, items: [{ seq: 1, at: '2026-10-12T02:00:00.000Z', kind: opts.error ? 'error' : 'result', ...(opts.agent ? { agentLabel: 'helper' } : {}) }] } as unknown as ChatServerMessage);
  }
  of(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
}

export class FakeTickets implements TriggerTickets {
  made: { caller: Caller; req: Record<string, unknown> }[] = [];
  started: { caller: Caller; id: string; req: Record<string, unknown> }[] = [];
  constructor(private readonly chat: FakeTriggerChat) {}
  create(caller: Caller, req: Parameters<TriggerTickets['create']>[1]) {
    this.made.push({ caller, req: req as Record<string, unknown> });
    return { id: `T-${this.made.length}` };
  }
  async startSession(caller: Caller, id: string, req: Parameters<TriggerTickets['startSession']>[2]) {
    this.started.push({ caller, id, req: req as Record<string, unknown> });
    const actor = caller.kind === 'trigger' ? `portal:trigger-${caller.triggerId}` : `ticket:${id}`;
    const s = await this.chat.create({ workspaceId: req.workspaceId, title: `${id}: x`, ...(req.worktree ? { worktree: {} } : {}) }, { actor });
    return { session: s };
  }
}

/**
 * Users and their rights: `workspaces[user]` lists what each may operate; a trigger belongs to whoever its row names. `caller` is who the
 * HTTP request is. `disabled` users may do nothing.
 */
export function triggerOwner(store: TriggerStore, opts: { workspaces: Record<string, string[]>; caller?: string; disabled?: string[] }): PlatformOwner & { caller: string; workspaces: Record<string, string[]>; disabled: string[] } {
  const o = {
    caller: opts.caller ?? 'u_a',
    workspaces: opts.workspaces,
    disabled: opts.disabled ?? [],
    actorOf() {
      return { actor: { kind: 'user' as const, userId: o.caller, loginSessionId: 'test', via: 'ui' as const }, userId: o.caller, admin: o.caller === 'u_a', label: `user:${o.caller}` };
    },
    ownersOf(s: NotifySubject) {
      if (s.type === 'trigger') return [store.row(s.id)?.owner_id].filter((x): x is string => !!x);
      return [];
    },
    sharersOf: () => [],
    can(u: string, _v: Verb, s: NotifySubject) {
      if (o.disabled.includes(u)) return false;
      if (s.type === 'trigger') return store.row(s.id)?.owner_id === u;
      if (s.type === 'workspace') return (o.workspaces[u] ?? []).includes(s.id);
      return false;
    },
    userEnabled: (u: string) => !o.disabled.includes(u),
    isAdmin: (u: string) => u === 'u_a',
  };
  return o as unknown as PlatformOwner & typeof o;
}

export const WS = 'docker/api-dev';

/** The module's parts, wired like index.ts does, over a fresh store and fakes. */
export async function triggerHarness(opts: { masterOn?: boolean; workspace?: 'ok' | 'gone' | 'stopped'; caps?: { total: number; owner: number } } = {}) {
  const { store: db, dataDir } = await freshStore();
  const clock = new Clock();
  const store = new TriggerStore(db, clock.now);
  const chat = new FakeTriggerChat();
  const tickets = new FakeTickets(chat);
  const owner = triggerOwner(store, { workspaces: { u_a: [WS], u_b: ['docker/b-ws'] } });
  const bus = createBus(clock.now);
  const events: NotifyEvent[] = [];
  bus.on('*', (e) => void events.push(e));
  const audit = new PlatformAudit(db, clock.now);
  const state = { masterOn: opts.masterOn ?? true, workspace: opts.workspace ?? ('ok' as 'ok' | 'gone' | 'stopped'), published: 0, caps: opts.caps ?? { total: 3, owner: 2 }, reauth: true };
  const settings = { enabled: () => state.masterOn, maxParallelTotal: () => state.caps.total, maxParallelPerOwner: () => state.caps.owner, timezone: () => 'Asia/Jakarta' };
  const runner = new TriggerRunner({ store, chat, tickets, owner, audit, bus, settings, workspaceState: async () => state.workspace, publish: () => void state.published++, now: clock.now, setTimer: clock.setTimer });
  runner.start();
  const service = new TriggerService({ store, timezone: settings.timezone, now: clock.now });
  const scheduler = new TriggerScheduler({ store, runner, masterOn: settings.enabled, now: clock.now });
  const hooks = new Hono();
  mountReceiver(hooks, { store, runner, clientAddress: (c) => c.req.header('x-test-addr') ?? '10.0.0.1', now: clock.now });
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('token' as never, 'signin-1' as never); (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' });
    await next();
  });
  app.route('/api/triggers', createTriggerRoutes({ owner, service, runner, audit, reauthFresh: () => state.reauth, publish: () => void state.published++, now: clock.now }));
  app.route('/hooks', hooks);
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', (e as Error).message);
    return c.json(err.toJSON(), err.status as never);
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json as { ok: boolean; data: unknown; error?: { code: string; message: string } }, text, headers: res.headers };
  };
  return { db, dataDir, clock, store, chat, tickets, owner, bus, events, audit, state, settings, runner, service, scheduler, app, api };
}

/** A minimal valid input for each source. */
export const inputs = {
  cron: (over: Record<string, unknown> = {}) => ({ name: 'deps', source: 'cron', cron: { expr: '0 9 * * 1-5', tz: 'Asia/Jakarta', catchUp: 'skip' }, action: { type: 'session', workspaceId: WS, claudeId: null, cwd: null, worktree: true, permissionMode: 'default', template: 'Check the dependencies at {{time}}.', ticket: null }, ...over }),
  webhook: (provider: 'github' | 'gitea' | 'gitlab' = 'github', over: Record<string, unknown> = {}) => ({
    name: 'reviewer',
    source: 'webhook',
    webhook: { provider, host: provider === 'github' ? null : `${provider}.example.com`, events: ['pull_request', 'push'], actions: [], repos: [], branches: [], labels: [], gitlabAuth: 'signing' },
    action: { type: 'session', workspaceId: WS, claudeId: null, cwd: null, worktree: true, permissionMode: 'default', template: 'Review {{repo}}#{{number}}: {{untrusted.title}}', ticket: null },
    ...over,
  }),
  ci: (over: Record<string, unknown> = {}) => ({ name: 'ci-fix', source: 'ci_failed', ciFailed: { workspaceId: null, repo: null, pipeline: null, branches: [], cooldownMin: 30, maxPerBranchPerDay: 3 }, action: { type: 'ticket_session', workspaceId: WS, claudeId: null, cwd: null, worktree: true, permissionMode: 'default', template: 'Fix {{pipeline}} on {{branch}}: {{untrusted.logTail}}', ticket: { type: 'bug', priority: 'high', tags: [], assignTo: 'queue' } }, ...over }),
};
