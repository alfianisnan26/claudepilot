// Test helpers for notifications and the platform: a fresh store, a fake chat controller, two fake users, a stand-in push service (a
// local HTTP server that holds a browser's P-256 key and decrypts what it gets) and a stand-in channel receiver. Nothing here contacts a
// third party.

import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError } from '@isnanme/core';
import type { ChatRequest, ChatServerMessage, ChatSession, NotifySubject, PushPayload, Verb } from '@portal/contracts';
import { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createBus } from './bus.js';
import { createEgress, type Egress } from './egress.js';
import { createNotify, type NotifyDeps } from './index.js';
import { decrypt } from './webpush.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
}

export async function freshStore(key = generateSecretKey()) {
  const dataDir = tempDirectory('n1-notify-');
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(key) });
  return { store, dataDir, key };
}

export function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    workspaceId: 'docker/api-dev',
    cwd: '/home/coder/project',
    title: 'URGENT approve CANARY-TITLE',
    state: 'waiting',
    origin: 'ui' as ChatSession['origin'],
    model: null,
    mode: 'default' as ChatSession['mode'],
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 1,
    waitingFor: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    lastActivityAt: '2026-10-12T00:00:00.000Z',
    endedReason: null,
    claudeId: 'c1',
    claudeName: 'Work',
    predecessorId: null,
    successorId: null,
    archivedAt: null,
    pinnedAt: null,
    ticketId: null,
    parentId: null,
    worktree: null,
    startedBy: 'ui',
    bypassCapable: false,
    claudeSessionId: 'cs1',
    previousClaudes: [],
    switching: null,
    ...over,
  };
}

export function request(requestId: string, toolName: string, full: string, over: Partial<ChatRequest> = {}): ChatRequest {
  return { requestId, kind: 'tool', toolName, agentLabel: null, title: 'Run a command', detail: full.slice(0, 200), full, fullCut: false, createdAt: '2026-10-12T00:00:00.000Z', ...over };
}

/** A chat controller with sessions and open requests held in maps; `respond` records and closes the request. */
export class FakeChat {
  readonly sessions = new Map<string, ChatSession>();
  readonly open = new Map<string, ChatRequest[]>();
  readonly answers: { id: string; requestId: string; decision: string; actor?: string }[] = [];
  readonly #cbs = new Set<(id: string, m: ChatServerMessage) => void>();
  respondDelay = 0;

  onEvent(cb: (id: string, m: ChatServerMessage) => void) {
    this.#cbs.add(cb);
    return () => void this.#cbs.delete(cb);
  }
  dispatch(id: string, m: ChatServerMessage) {
    for (const cb of this.#cbs) cb(id, m);
  }
  get(id: string) {
    return this.sessions.get(id) ?? null;
  }
  openRequests(id: string) {
    return this.open.get(id) ?? [];
  }
  async respond(id: string, requestId: string, decision: string, opts: { note?: string; actor?: string } = {}) {
    if (this.respondDelay) await sleep(this.respondDelay);
    const list = this.open.get(id) ?? [];
    if (!list.some((r) => r.requestId === requestId)) throw new AppError('CONFLICT', 'That request is no longer open.');
    this.open.set(
      id,
      list.filter((r) => r.requestId !== requestId),
    );
    this.answers.push({ id, requestId, decision, actor: opts.actor });
  }
  /** A session asks: stored as open and dispatched as a `request` event. */
  ask(s: ChatSession, r: ChatRequest) {
    this.sessions.set(s.id, s);
    this.open.set(s.id, [...(this.open.get(s.id) ?? []), r]);
    this.dispatch(s.id, { type: 'events', session: s.id, items: [{ seq: 1, at: r.createdAt, kind: 'request', request: r, requestId: r.requestId }] });
  }
}

/** Two (or more) fake users: each subject belongs to one user; `shares` gives a second user `view` and `operate`. */
export function fakeOwner(owners: Record<string, string>, opts: { shares?: Record<string, string[]>; disabled?: string[]; caller?: string; fallback?: string } = {}): PlatformOwner & { caller: string } {
  const own = (k: string) => owners[k] ?? opts.fallback;
  const key = (s: NotifySubject) => `${s.type}:${s.id}`;
  const o = {
    caller: opts.caller ?? 'u_a',
    actorOf() {
      return { actor: { kind: 'user' as const, userId: o.caller, loginSessionId: 'test', via: 'ui' as const }, userId: o.caller, admin: o.caller === 'u_a', label: `user:${o.caller}` };
    },
    ownersOf: (s: NotifySubject) => (own(key(s)) ? [own(key(s))!] : []),
    sharersOf: (s: NotifySubject) => opts.shares?.[key(s)] ?? [],
    can: (u: string, _v: Verb, s: NotifySubject) => !(opts.disabled ?? []).includes(u) && (own(key(s)) === u || (opts.shares?.[key(s)] ?? []).includes(u)),
    userEnabled: (u: string) => !(opts.disabled ?? []).includes(u),
    isAdmin: (u: string) => u === 'u_a',
  };
  return o as unknown as PlatformOwner & { caller: string };
}

/** A browser's push subscription: its key pair and auth secret stay here, so the stand-in can decrypt. */
export function fakeBrowser(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    open: (body: Buffer) => JSON.parse(decrypt(body, ecdh.getPrivateKey(), auth).toString()) as PushPayload,
  };
}

export interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** A local HTTP receiver: records each request and answers with `status()` (and optional headers). */
export async function standIn(answer: (r: Received, n: number) => { status: number; headers?: Record<string, string> } = () => ({ status: 201 })) {
  const got: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = { path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) };
      got.push(r);
      const a = answer(r, got.length);
      res.writeHead(a.status, a.headers ?? {});
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { got, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An egress for stand-ins: names resolve to 127.0.0.1, plain http and private addresses allowed (tests only). */
export const testEgress = (over: Parameters<typeof createEgress>[0] = {}): Egress =>
  createEgress({ allowHttp: true, allowPrivate: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], ...over });

/** The notifications module over a fake chat and two fake users, instant retries and real timers unless given. */
export async function harness(opts: Partial<NotifyDeps> & { owners?: Record<string, string>; ownerOpts?: Parameters<typeof fakeOwner>[1] } = {}) {
  const { store, dataDir } = await freshStore();
  const chat = new FakeChat();
  const owner = opts.owner ?? fakeOwner(opts.owners ?? {}, { fallback: 'u_a', ...opts.ownerOpts });
  const bus = createBus();
  const audit = new PlatformAudit(store);
  const published: number[] = [];
  const settingsValues = new Map<string, unknown>();
  const notify = createNotify({
    store,
    bus,
    owner,
    audit,
    chat,
    settings: { get: (k: string) => (settingsValues.has(k) ? settingsValues.get(k) : k === 'notify.actions.enabled' ? true : '') },
    uiUrl: 'https://pilot.example.test',
    pushContact: 'mailto:ops@example.test',
    selfOrigin: 'http://localhost:3232',
    publish: () => published.push(Date.now()),
    egress: opts.egress ?? testEgress(),
    sleep: opts.sleep ?? (async () => undefined),
    tools: false,
    ...opts,
  });
  return { store, dataDir, chat, owner: owner as ReturnType<typeof fakeOwner>, bus, audit, notify, published, settingsValues };
}
