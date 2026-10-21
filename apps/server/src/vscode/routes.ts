// The VS Code extension's routes (docs/prd/vscode-extension.md, T-1974). Three groups, mounted by app.ts:
//
//   createVscodePublicRoutes   /api/vscode/{version,device,token}   no cookie, no token: the device code is the door; limited per address
//   createVscodeApproveRoutes  /api/vscode/{pending,approve}        the signed-in person (mounted behind requireSession and the Origin rule)
//   createVscodeBearerRoutes   /api/vscode/{me,agents,...}          `Authorization: Bearer` with a token the device flow issued, never a cookie
//
// A bearer request is a token actor capped at `operate` (the seam caps it): it can read what the person can see, send to a session and
// DENY a request, and nothing else; Allow is given in the portal (review R2). Every object goes through the seam (`can`, `visible`), and a
// refusal is the same 404 as a missing object. Sending and denying go through the chat controller's own door as the token
// (`portal-mcp:<id>`, labelled `VS Code · <client>`), like a Portal MCP tool, and honour the Portal MCP switches (on, session control).

import { randomUUID } from 'node:crypto';
import { AppError, success } from '@isnanme/core';
import {
  VSCODE_API_HEADER,
  VSCODE_API_VERSION,
  VSCODE_EVENTS_MAX,
  VSCODE_SEND_MAX,
  VSCODE_TOKEN_LABEL_PREFIX,
  VSCODE_TOKEN_LIFETIME,
  VSCODE_VERIFY_PATH,
  sessionCost,
  sessionRef,
  ticketBucketRef,
  workspaceRef,
  type Actor,
  type ChatEvent,
  type ChatRequest,
  type ChatSession,
  type ClaudeUsageReport,
  type GlanceSnapshot,
  type TicketPage,
  type TicketFilter,
  type TicketItem,
  type VscodeAgent,
  type VscodeApproval,
  type VscodeApproveRequest,
  type VscodeDeviceStart,
  type VscodeEvent,
  type VscodeEvents,
  type VscodeMe,
  type VscodePending,
  type VscodeSendRequest,
  type VscodeStatus,
  type VscodeTicket,
  type VscodeTokenPoll,
  type VscodeVersion,
  type VscodeWorkspace,
  type Workspace,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, actorOfPrincipal, actorString, can, visible } from '../authz/seam.js';
import { SLASH_ALLOWED, slashWord } from '../chat/slash.js';
import type { PortalToken } from '@portal/contracts';
import type { ClientTokenOrigin, VerifyResult } from '../portalmcp/tokens.js';
import { RateLimiter } from '../rateLimit.js';
import { DeviceFlow, type Issued } from './device.js';
import { declareVscodePolicies } from './authz.js';

/** What the routes need of the token store: the device flow issues through the same machinery as Access → MCP (one table, one revoke). */
export interface VscodeTokenStore {
  /** `by`: the person who approved (the token's creator in the MCP audit); `origin`: the client and its installation. */
  create(req: { label: string; scope: 'operate'; expiresIn: typeof VSCODE_TOKEN_LIFETIME; addAnother: true }, by: string, origin: ClientTokenOrigin): { token: PortalToken; secret: string };
  verify(secret: string, ip?: string): VerifyResult;
  revoke(id: string, reason?: string): boolean;
}

export interface VscodeDeps {
  tokens: VscodeTokenStore;
  chat: {
    list(filter?: { workspaceId?: string; parentId?: string }): ChatSession[];
    get(id: string): ChatSession | null;
    resolve(id: string): string;
    openRequests(id: string): ChatRequest[];
    history(id: string, after?: number): ChatEvent[];
    historyPage(id: string, before: number | null, limit: number): { events: ChatEvent[] };
    send(id: string, uuid: string, text: string, opts?: { actor?: string; actorLabel?: string }): Promise<void>;
    respond(id: string, requestId: string, decision: 'deny', opts?: { note?: string; actor?: string }): Promise<void>;
  };
  workspaces?: { list(): Promise<Workspace[]> };
  tickets?: { listPage(caller: { kind: 'token'; tokenId: string; label: string; scope: 'read' }, filter: TicketFilter, args: { limit?: unknown; keep?: (t: TicketItem) => boolean }): TicketPage };
  usage?: { report(): Promise<ClaudeUsageReport> };
  glance?: { snapshot(actor: Actor): GlanceSnapshot };
  /** A platform audit row (names, ids and numbers only: never a token, a code or message text). */
  audit?: (kind: string, detail: Record<string, unknown>, actor: string) => void;
  /** The address a request came from (the proxy rule of app.ts). */
  clientKey: (c: Context) => string;
  /** The portal's own origin as the person reaches it, for the verify link. */
  origin: (c: Context) => string;
  /** The Portal MCP switches (Access -> MCP): off refuses every bearer route; session control off refuses send and deny. */
  mcpSettings?: () => { enabled: boolean; sessionControl: boolean };
  /** The workspace-id rule of every /api route (QA-032): throws 422 for a hostile field in the body or query. */
  idCheck?: (c: Context) => Promise<void>;
  now?: () => number;
}

type Vars = { Variables: { actor: Actor; vscodeToken: PortalToken } };

/** Every /api/vscode answer says which API this portal speaks, so an extension can warn on a mismatch from any response. */
const stamp = async (c: Context, next: () => Promise<void>) => {
  await next();
  c.header(VSCODE_API_HEADER, String(VSCODE_API_VERSION));
};

async function jsonBody<T>(c: Context): Promise<Partial<T>> {
  const v: unknown = await c.req.json().catch(() => null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  return v as Partial<T>;
}

/** The one flow per portal process (shared by the public and the approve routes). A token approved but never picked up is revoked. */
export function createVscodeFlow(tokens: Pick<VscodeTokenStore, 'revoke'>, now?: () => number): DeviceFlow {
  return new DeviceFlow(now, (issued) => void tokens.revoke(issued.tokenId, 'the sign-in code expired before VS Code picked the token up'));
}

/* ---------- Public ---------- */

export function createVscodePublicRoutes(flow: DeviceFlow, deps: Pick<VscodeDeps, 'clientKey' | 'origin' | 'idCheck'>): Hono {
  declareVscodePolicies();
  const r = new Hono();
  r.use('*', stamp);
  // Starts are rare (a person signs in); polls come every 5 s for at most 10 minutes. Both per address.
  const starts = new RateLimiter(10, 10 * 60_000);
  const polls = new RateLimiter(60, 60_000);

  r.get('/version', (c) => c.json(success<VscodeVersion>({ api: VSCODE_API_VERSION, minApi: 1, name: 'ClaudePilot' })));

  // Order (review M3): the address's limit first (no body read for a blocked one), then the id rule, then the count and the work.
  r.post('/device', async (c) => {
    const ip = deps.clientKey(c);
    if (starts.blocked(ip)) throw new AppError('RATE_LIMITED', 'Too many sign-ins from here. Wait a few minutes.');
    await deps.idCheck?.(c);
    starts.fail(ip);
    const body = (await c.req.json().catch(() => ({}))) as { client?: unknown; instance?: unknown } | null;
    const o = body && typeof body === 'object' ? body : {};
    const got = flow.start(o.client, ip, o.instance);
    if (!got) throw new AppError('RATE_LIMITED', 'Too many sign-ins are waiting. Try again in a few minutes.');
    const base = `${deps.origin(c)}${VSCODE_VERIFY_PATH}`;
    return c.json(
      success<VscodeDeviceStart>({
        deviceCode: got.deviceCode,
        userCode: got.userCode,
        verifyUrl: base,
        verifyUrlComplete: `${base}?code=${encodeURIComponent(got.userCode)}`,
        expiresIn: got.expiresIn,
        interval: got.interval,
      }),
    );
  });

  r.post('/token', async (c) => {
    const ip = deps.clientKey(c);
    if (polls.blocked(ip)) return c.json(success<VscodeTokenPoll>({ status: 'slow_down', interval: 10 }));
    await deps.idCheck?.(c);
    polls.fail(ip);
    const body = await jsonBody<{ deviceCode: string }>(c);
    const got = flow.poll(body.deviceCode);
    if (got.status !== 'approved') return c.json(success<VscodeTokenPoll>(got));
    // The token was made when the person approved (its creator is that person); this is the one answer that hands it over.
    const t = got.issued;
    return c.json(success<VscodeTokenPoll>({ status: 'ok', token: t.token, tokenId: t.tokenId, expiresAt: t.expiresAt, label: t.label }));
  });

  return r;
}

/* ---------- The signed-in person's ---------- */

export function createVscodeApproveRoutes(flow: DeviceFlow, deps: Pick<VscodeDeps, 'audit' | 'tokens' | 'clientKey'>): Hono {
  declareVscodePolicies();
  const r = new Hono();
  r.use('*', stamp);
  // A wrong code costs a signed-in person nothing, but a page script that loops on codes is stopped all the same.
  const tries = new RateLimiter(30, 10 * 60_000);
  const guard = (c: Context) => {
    const actor = actorOf(c);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const key = actor.kind === 'system' ? 'system' : actor.userId;
    if (tries.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many codes tried. Wait a few minutes.');
    return key;
  };
  const NO_CODE = () => new AppError('NOT_FOUND', 'That code is not waiting. Start the sign-in again in VS Code.');

  r.get('/pending', (c) => {
    const key = guard(c);
    const p = flow.pending(c.req.query('code') ?? '');
    if (!p) {
      tries.fail(key);
      throw NO_CODE();
    }
    // Where the person is, beside where the request came from: a code someone else started from elsewhere is told apart (review R4).
    const viewerIp = deps.clientKey(c);
    return c.json(success<VscodePending>({ ...p, viewerIp, sameAddress: p.ip !== null && p.ip === viewerIp }));
  });

  r.post('/approve', async (c) => {
    const key = guard(c);
    const body = await jsonBody<VscodeApproveRequest>(c);
    if (body.decision !== 'approve' && body.decision !== 'deny') throw new AppError('VALIDATION_FAILED', 'Approve or deny.');
    const code = typeof body.userCode === 'string' ? body.userCode : '';
    const p = flow.pending(code);
    const by = actorString(actorOf(c));
    if (!p) {
      tries.fail(key);
      throw NO_CODE();
    }
    if (body.decision === 'deny') {
      if (!flow.deny(code)) throw NO_CODE();
      deps.audit?.('vscode.denied', { client: p.client, ip: p.ip }, by);
      return c.json(success({ ok: true as const, decision: body.decision }));
    }
    // The token is made now, by the person (review m1), only for this installation (m2). If making it fails, the code stays pending and
    // the person can approve again (m5).
    const issued: Issued | null = flow.approve(code, ({ client, instance }) => {
      const { token, secret } = deps.tokens.create({ label: `${VSCODE_TOKEN_LABEL_PREFIX}${client}`, scope: 'operate', expiresIn: VSCODE_TOKEN_LIFETIME, addAnother: true }, by, { client: 'vscode', instance });
      return { token: secret, tokenId: token.id, expiresAt: token.expiresAt, label: token.label };
    });
    if (!issued) throw NO_CODE();
    deps.audit?.('vscode.approved', { client: p.client, ip: p.ip, tokenId: issued.tokenId }, by);
    return c.json(success({ ok: true as const, decision: body.decision }));
  });

  return r;
}

/* ---------- Bearer ---------- */

/** The token's secret from `Authorization: Bearer`, or null. */
const bearerOf = (c: Context): string | null => {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
};

/** Every bearer route (and nothing else) runs the token check. */
export const BEARER_PATHS = ['/me', '/logout', '/agents', '/tickets', '/workspaces', '/status', '/approvals', '/sessions/*'] as const;

const STATE_RANK: Record<string, number> = { waiting: 0, working: 1, starting: 2, idle: 3, interrupted: 4, ended: 5 };

export function agentOf(s: ChatSession): VscodeAgent {
  const cost = sessionCost(s);
  return {
    id: s.id,
    title: s.title,
    state: s.state,
    waiting: s.waiting,
    workspaceId: s.workspaceId,
    parentId: s.parentId,
    lead: s.lead === true,
    ticketId: s.ticketId,
    ticketKey: s.ticketKey ?? null,
    model: s.model,
    claudeName: s.claudeName,
    agent: s.agent ?? null,
    costUsd: Math.round(cost.usd * 10_000) / 10_000,
    costBasis: cost.basis,
    lastActivityAt: s.lastActivityAt,
    url: `/admin/sessions/${encodeURIComponent(s.id)}`,
  };
}

export function approvalOf(s: ChatSession, r: ChatRequest): VscodeApproval {
  return {
    sessionId: s.id,
    sessionTitle: s.title,
    workspaceId: s.workspaceId,
    requestId: r.requestId,
    kind: r.kind,
    toolName: r.toolName,
    title: r.title,
    full: r.full && r.full.trim() ? r.full : null,
    fullCut: r.fullCut === true,
    createdAt: r.createdAt,
    url: `/admin/sessions/${encodeURIComponent(s.id)}`,
  };
}

/** The transcript as the Chat view shows it: the main thread's messages, tool names, approvals, errors and results. */
const EVENT_TEXT_MAX = 20_000;
export function eventsOf(events: ChatEvent[]): VscodeEvent[] {
  const out: VscodeEvent[] = [];
  for (const e of events) {
    if ((e.parentToolUseId || e.agentLabel) && e.kind !== 'request' && e.kind !== 'resolved') continue; // sub-agents' lines stay in the portal
    const cut = (t: string | null | undefined) => (t == null ? null : t.length > EVENT_TEXT_MAX ? `${t.slice(0, EVENT_TEXT_MAX)}…` : t);
    switch (e.kind) {
      case 'user':
      case 'assistant':
      case 'error':
        out.push({ seq: e.seq, at: e.at, kind: e.kind, text: cut(e.text), toolName: null, requestId: null });
        break;
      case 'result':
        out.push({ seq: e.seq, at: e.at, kind: 'result', text: null, toolName: null, requestId: null });
        break;
      case 'tool_use':
        out.push({ seq: e.seq, at: e.at, kind: 'tool_use', text: null, toolName: e.toolName ?? null, requestId: null });
        break;
      case 'request':
        out.push({ seq: e.seq, at: e.at, kind: 'request', text: cut(e.request?.title ?? null), toolName: e.request?.toolName ?? null, requestId: e.request?.requestId ?? null });
        break;
      case 'resolved':
        out.push({ seq: e.seq, at: e.at, kind: 'resolved', text: e.outcome ?? null, toolName: null, requestId: e.requestId ?? null });
        break;
      default:
        break;
    }
  }
  return out;
}

export function createVscodeBearerRoutes(deps: VscodeDeps): Hono<Vars> {
  declareVscodePolicies();
  const r = new Hono<Vars>();
  r.use('*', stamp);
  // A busy extension polls a few routes every few seconds; a loop gone wrong is cut off per token.
  const perToken = new RateLimiter(600, 60_000);
  const UNAUTH = () => new AppError('UNAUTHORIZED', 'Sign in to the portal again from VS Code.');

  const auth = async (c: Context<Vars>, next: () => Promise<void>) => {
    // The id rule first: a hostile field is refused before any dependency is asked (QA-032).
    await deps.idCheck?.(c);
    // FR51: a bearer request carries no cookie. One that has both is refused, so a page can never ride a person's cookie in here.
    if (c.req.header('cookie')) throw new AppError('BAD_REQUEST', 'Send the token without a cookie.');
    const secret = bearerOf(c);
    if (!secret) throw UNAUTH();
    const v = deps.tokens.verify(secret, deps.clientKey(c));
    // Only a token the device flow issued (marked `client = 'vscode'`, review R1) opens these routes; a label proves nothing. Unknown,
    // revoked, expired and any other token get the same answer.
    if (!v.ok || v.token.client !== 'vscode') throw UNAUTH();
    // The Portal MCP switch: these are Portal MCP tokens, and off means off for them too.
    if (deps.mcpSettings && !deps.mcpSettings().enabled) throw new AppError('FORBIDDEN', 'The Portal MCP is off. Turn it on in Access, MCP.');
    if (perToken.blocked(v.token.id)) throw new AppError('RATE_LIMITED', 'Too many requests. Wait a minute.');
    perToken.fail(v.token.id);
    // The seam caps a token by its scope; the device flow issues `operate`, and nothing here is ever more than that.
    const p = v.principal;
    c.set('actor', actorOfPrincipal({ kind: 'user', tokenId: p.tokenId, scope: p.scope === 'admin' ? 'operate' : p.scope, workspaceId: null, sessionId: null }));
    c.set('vscodeToken', v.token);
    await next();
  };
  // Path by path, not `*`: this router is merged with the public and the cookie routes under one prefix, and Hono would run a `*`
  // middleware for every route under it.
  for (const p of BEARER_PATHS) r.use(p, auth);

  const actor = (c: Context<Vars>) => c.get('actor');
  /** Sending and denying change a session: the Portal MCP's session-control switch must be on, as for its session tools. */
  const control = () => {
    if (deps.mcpSettings && !deps.mcpSettings().sessionControl) throw new AppError('FORBIDDEN', 'Session control is off. Turn it on in Access, MCP.');
  };
  /** The token as an actor of the chat: `portal-mcp:<id>`, named by its label, so the transcript says who sent and Claude reads the portal's frame. */
  const as = (c: Context<Vars>) => ({ actor: `portal-mcp:${c.get('vscodeToken').id}`, actorLabel: c.get('vscodeToken').label });
  const NOT_FOUND = () => new AppError('NOT_FOUND', 'Not found.');
  /** A session the actor holds `verb` on, by any id it goes by; otherwise the same 404 as a missing one. */
  const session = (c: Context<Vars>, verb: 'view' | 'operate'): ChatSession => {
    let id: string;
    try {
      id = deps.chat.resolve(c.req.param('id') ?? '');
    } catch {
      throw NOT_FOUND();
    }
    const s = deps.chat.get(id);
    if (!s || !can(actor(c), verb, sessionRef(s.id)).allow) throw NOT_FOUND();
    return s;
  };
  const liveSessions = (c: Context<Vars>) =>
    visible(
      actor(c),
      'session',
      deps.chat.list().filter((s) => !s.archivedAt && s.state !== 'ended'),
      (s) => s.id,
    );

  r.get('/me', (c) => {
    const t = c.get('vscodeToken');
    return c.json(success<VscodeMe>({ tokenId: t.id, label: t.label, scope: t.scope, expiresAt: t.expiresAt, api: VSCODE_API_VERSION }));
  });

  // Signing out in VS Code revokes the token here, so a copy of it that leaked is dead too.
  r.post('/logout', (c) => {
    const t = c.get('vscodeToken');
    const revoked = deps.tokens.revoke(t.id, 'signed out in VS Code');
    deps.audit?.('vscode.signed_out', { tokenId: t.id }, `portal-mcp:${t.id}`);
    return c.json(success({ revoked }));
  });

  r.get('/agents', (c) => {
    const rows = liveSessions(c).sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || b.lastActivityAt.localeCompare(a.lastActivityAt));
    return c.json(success<VscodeAgent[]>(rows.map(agentOf)));
  });

  r.get('/workspaces', async (c) => {
    const all = deps.workspaces ? await deps.workspaces.list() : [];
    const rows = visible(actor(c), 'workspace', all, (w) => w.id);
    return c.json(
      success<VscodeWorkspace[]>(
        rows.map((w) => ({ id: w.id, name: w.label ?? w.name, target: w.target, status: w.status, url: '/admin/workspaces' })),
      ),
    );
  });

  r.get('/tickets', (c) => {
    if (!deps.tickets) return c.json(success<VscodeTicket[]>([]));
    const a = actor(c);
    const t = c.get('vscodeToken');
    const seen = new Map<string, boolean>();
    const inBucket = (b: string | undefined) => {
      if (!b) return true;
      if (!seen.has(b)) seen.set(b, can(a, 'view', ticketBucketRef(b)).allow);
      return seen.get(b)!;
    };
    const keep = (x: TicketItem) => inBucket(x.bucket) && visible(a, 'ticket', [x], (y) => y.id).length > 0;
    // The open queue, most urgent first: one page of 100 (what a tree can show; the portal has the rest).
    const page = deps.tickets.listPage({ kind: 'token', tokenId: t.id, label: t.label, scope: 'read' }, {}, { limit: 100, keep });
    return c.json(
      success<VscodeTicket[]>(
        page.items.map((x) => ({
          id: x.id,
          key: x.key ?? x.id,
          bucket: x.bucket ?? 'T',
          status: x.status,
          priority: x.priority,
          type: x.type,
          summary: x.summary,
          assigneeSessionId: x.assignee?.kind === 'session' ? x.assignee.sessionId : null,
          updatedAt: x.updatedAt,
          url: `/admin/tickets/${encodeURIComponent(x.key ?? x.id)}`,
        })),
      ),
    );
  });

  r.get('/approvals', (c) => {
    const a = actor(c);
    const out: VscodeApproval[] = [];
    for (const s of liveSessions(c)) {
      if (!s.waiting || !can(a, 'operate', sessionRef(s.id)).allow) continue; // to answer one is to operate the session
      for (const req of deps.chat.openRequests(s.id)) out.push(approvalOf(s, req));
    }
    out.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    return c.json(success(out));
  });

  r.get('/status', async (c) => {
    const a = actor(c);
    const sessions = liveSessions(c);
    let approvals = 0;
    for (const s of sessions) if (s.waiting && can(a, 'operate', sessionRef(s.id)).allow) approvals += s.waiting;
    let attention: number | null = null;
    try {
      attention = deps.glance ? deps.glance.snapshot(a).attention.count : null;
    } catch {
      attention = null; // unavailable is a state: never a guess
    }
    let claudes: VscodeStatus['claudes'] = [];
    let quota: VscodeStatus['quota'] = null;
    try {
      const report = deps.usage ? await deps.usage.report() : null;
      const mine = (report?.claudes ?? []).filter((u) => can(a, 'view', workspaceRef(u.workspaceId)).allow);
      claudes = mine.map((u) => ({ claudeId: u.claudeId, claudeName: u.claudeName, windows: u.windows.map((w) => ({ label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt })) }));
      // The active Claude: the one the most recently active live session runs on; else the first with a reading.
      const recent = [...sessions].sort((x, y) => y.lastActivityAt.localeCompare(x.lastActivityAt)).find((s) => s.claudeId && mine.some((u) => u.claudeId === s.claudeId));
      const active = mine.find((u) => u.claudeId === recent?.claudeId) ?? mine.find((u) => u.windows.some((w) => w.usedPct !== null)) ?? null;
      if (active) {
        // Its tightest window: the one most used (a window with no number never wins over one with a number).
        const tight = [...active.windows].sort((x, y) => (y.usedPct ?? -1) - (x.usedPct ?? -1))[0];
        quota = {
          claudeId: active.claudeId,
          claudeName: active.claudeName,
          label: tight?.label ?? 'Usage',
          usedPct: tight && !active.unavailable ? tight.usedPct : null,
          resetsAt: tight?.resetsAt ?? null,
        };
      }
    } catch {
      quota = null;
    }
    return c.json(success<VscodeStatus>({ quota, claudes, attention, approvals, at: new Date(deps.now?.() ?? Date.now()).toISOString() }));
  });

  r.get('/sessions/:id/events', (c) => {
    const s = session(c, 'view');
    const afterRaw = c.req.query('after');
    let events: ChatEvent[];
    if (afterRaw !== undefined && afterRaw !== '') {
      // Bounded: a view far behind gets the newest VSCODE_EVENTS_MAX, never the whole transcript.
      const after = Math.max(0, Math.trunc(Number(afterRaw)) || 0, s.lastSeq - VSCODE_EVENTS_MAX);
      events = deps.chat.history(s.id, after).slice(-VSCODE_EVENTS_MAX);
    } else events = deps.chat.historyPage(s.id, null, 100).events;
    return c.json(success<VscodeEvents>({ events: eventsOf(events), lastSeq: s.lastSeq, state: s.state, title: s.title }));
  });

  r.post('/sessions/:id/send', async (c) => {
    const s = session(c, 'operate');
    control();
    const body = await jsonBody<VscodeSendRequest>(c);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new AppError('VALIDATION_FAILED', 'Write a message.');
    if (text.length > VSCODE_SEND_MAX) throw new AppError('VALIDATION_FAILED', `At most ${VSCODE_SEND_MAX} characters.`);
    // As over the Portal MCP: only the slash commands a token may send; the rest is for the portal's own composer or the terminal.
    const first = slashWord(text);
    if (first && !SLASH_ALLOWED.has(first)) throw new AppError('FORBIDDEN', `${first.slice(0, 40)} is not sent from VS Code. Allowed: ${[...SLASH_ALLOWED].join(', ')}.`);
    const uuid = typeof body.uuid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.uuid) ? body.uuid : randomUUID();
    await deps.chat.send(s.id, uuid, text, as(c));
    deps.audit?.('vscode.sent', { tokenId: c.get('vscodeToken').id, sessionId: s.id, chars: text.length }, `portal-mcp:${c.get('vscodeToken').id}`);
    return c.json(success({ ok: true as const, uuid }));
  });

  r.post('/sessions/:id/respond', async (c) => {
    const s = session(c, 'operate');
    const body = await jsonBody<{ requestId: string; decision: string; note?: string }>(c);
    // Review R2 (decided): no Allow from VS Code in slice 1. The person allows in the portal, as over the Portal MCP without admin.
    if (body.decision === 'allow') throw new AppError('FORBIDDEN', 'Allow it in the portal. From VS Code a request can be denied.');
    if (typeof body.requestId !== 'string' || !body.requestId || body.decision !== 'deny') throw new AppError('VALIDATION_FAILED', 'Answer deny.');
    control();
    const open = deps.chat.openRequests(s.id).find((x) => x.requestId === body.requestId);
    if (!open) throw new AppError('CONFLICT', 'That request is no longer open.');
    const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined;
    await deps.chat.respond(s.id, body.requestId, 'deny', { note, actor: as(c).actor });
    deps.audit?.('vscode.answered', { tokenId: c.get('vscodeToken').id, sessionId: s.id, requestId: body.requestId, decision: 'deny' }, `portal-mcp:${c.get('vscodeToken').id}`);
    return c.json(success({ ok: true as const }));
  });

  return r;
}
