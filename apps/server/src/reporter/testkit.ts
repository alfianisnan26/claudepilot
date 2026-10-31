// Test helpers for the UI reporter (not used by the portal): a fresh store with the tickets service, buckets KONF and OTHER, the reporter
// service, its widget routes on a Hono app as app.ts mounts them, a fake chat and a fake git. Fixtures that look like credentials are
// built at runtime, never written as literals.

import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { REPORTER_EVIDENCE_SCHEMA, type Actor, type ChatEvent, type ReporterEvidence } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { ticketsHarness, UI } from '../tickets/testkit.js';
import { createReporterOwnerRoutes, createReporterWidgetRoutes } from './routes.js';
import { ReporterService, type ReporterChat, type ReporterChatSession, type ReporterGit } from './service.js';

export const PORTAL = 'http://portal.test';
export const STG = 'https://stg.konfersi.com';
export const UAT = 'https://uat.konfersi.com';
export const REPO = 'platform/konfersi-landing-page';

export class FakeChat implements ReporterChat {
  sessions = new Map<string, ReporterChatSession>();
  sent: { id: string; text: string; opts: { actor: string; actorLabel: string; attachments?: unknown } }[] = [];
  fail: Error | null = null;
  add(id: string, state = 'idle', extra: Partial<ReporterChatSession> = {}) {
    this.sessions.set(id, { id, title: `Session ${id}`, state, workspaceId: 'docker/konf', ticketId: null, lastActivityAt: new Date().toISOString(), ...extra });
  }
  get(id: string) {
    return this.sessions.get(id) ?? null;
  }
  list(f: { workspaceId?: string; ticketId?: string } = {}) {
    return [...this.sessions.values()].filter((s) => (!f.workspaceId || s.workspaceId === f.workspaceId) && (!f.ticketId || s.ticketId === f.ticketId));
  }
  async send(id: string, _uuid: string, text: string, opts: { actor: string; actorLabel: string; attachments?: unknown }) {
    if (this.fail) throw this.fail;
    this.sent.push({ id, text, opts });
  }
  /** Stored transcripts per session (chat in the widget); `push` keeps the session's lastSeq in step. */
  events = new Map<string, ChatEvent[]>();
  blobs = new Map<string, { path: string; mediaType: string; size: number }>();
  push(id: string, ev: Omit<ChatEvent, 'seq' | 'at'> & { at?: string }) {
    const list = this.events.get(id) ?? [];
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    list.push({ at: new Date().toISOString(), ...ev, seq } as ChatEvent);
    this.events.set(id, list);
    const s = this.sessions.get(id);
    if (s) s.lastSeq = seq;
    return seq;
  }
  historyPage(id: string, before: number | null, limit: number) {
    const older = (this.events.get(id) ?? []).filter((e) => before === null || e.seq < before);
    const events = older.slice(-limit);
    const more = older.length > events.length;
    return { events, more, before: more ? events[0]!.seq : null };
  }
  history(id: string, after: number, limit = 400) {
    return (this.events.get(id) ?? []).filter((e) => e.seq > after).slice(-limit);
  }
  blobFile(_id: string, blobId: string) {
    return this.blobs.get(blobId) ?? null;
  }
}

/** Git as a table: ancestry answers per "fix>live" pair (true, false, or null = cannot tell), trailer commits per ref, known commits. */
export class FakeGit implements ReporterGit {
  ancestry = new Map<string, boolean | null>();
  trailers = new Map<string, string[]>();
  async isAncestor(_repo: string, a: string, b: string) {
    return this.ancestry.has(`${a}>${b}`) ? this.ancestry.get(`${a}>${b}`)! : null;
  }
  async trailerCommits(_repo: string, refs: string[]) {
    return refs.flatMap((r) => this.trailers.get(r) ?? []);
  }
  /** The commits the checkout has; null = no checkout to ask (commitExists answers null). */
  commits: Set<string> | null = null;
  async commitExists(_repo: string, commit: string) {
    return this.commits ? this.commits.has(commit) : null;
  }
}

export async function reporterHarness(opts: { now?: () => Date } = {}) {
  const h = await ticketsHarness({ now: opts.now });
  // KONF may be seeded already; OTHER is ours.
  for (const [key, name] of [['KONF', 'Konfersi'], ['OTHER', 'Other']] as const) if (!h.tickets.bucketOwner(key)) h.tickets.createBucket(UI, { key, name });
  const chat = new FakeChat();
  const git = new FakeGit();
  const service = new ReporterService({ store: h.store, tickets: h.tickets, chat, git, now: opts.now, sdkVersion: () => '1.0.0' });
  service.updateConfig(
    'KONF',
    {
      enabled: true,
      sites: [
        { origin: STG, environment: 'stg', repo: REPO, label: 'Landing stg', branch: 'stg' },
        { origin: UAT, environment: 'uat', repo: REPO, label: null, branch: 'uat' },
      ],
    },
    'test',
  );
  let signedIn = true;
  const app = new Hono();
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as 400) : c.json({ error: String(e) }, 500)));
  app.route(
    '/reporter/v1',
    createReporterWidgetRoutes(service, {
      webDist: null,
      vendorDirs: [new URL('./vendor/', import.meta.url).pathname],
      portalOrigin: () => PORTAL,
      signedIn: () => (signedIn ? (ownerActor() as Actor & { userId: string }) : null),
      userLabel: () => 'Owner',
      clientKey: () => '127.0.0.1',
      ...(opts.now ? { now: () => opts.now!().getTime() } : {}),
    }) as never,
  );
  const portalTokens = new Map<string, { actor: Actor; label: string }>();
  app.route(
    '/api/reporter',
    createReporterOwnerRoutes(service, {
      guard: async (c, next) => {
        (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
        await next();
      },
      portalToken: (s) => portalTokens.get(s) ?? null,
    }) as never,
  );
  const mint = (origin = STG, bucket = 'KONF') => service.mint(bucket, origin, ownerActor() as Actor & { userId: string }, 'Owner');
  const call = (path: string, init: Omit<RequestInit, 'headers'> & { token?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: 'portal.test', ...(init.headers ?? {}) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    return app.request(`${PORTAL}${path}`, { ...init, headers });
  };
  const postJson = (path: string, token: string, body: unknown) => call(path, { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const done = () => {
    service.stop();
    h.done();
  };
  return { ...h, service, chat, git, app, mint, call, postJson, done, portalTokens, setSignedIn: (v: boolean) => (signedIn = v) };
}

let n = 0;
export const captureId = () => `cap-${String(++n).padStart(8, '0')}-test`;

export const anchor = (path = '/pricing', y = 100, selector: string | null = '#hero') => ({
  path,
  selector,
  relative: { x: 0, y: 0, w: 1, h: 1 },
  rect: { x: 10, y, w: 200, h: 80 },
  viewport: { w: 390, h: 844, dpr: 3 },
  mode: 'crop' as const,
});

export const capture = (path = '/pricing', y = 100, selector: string | null = '#hero', origin = STG) => ({ captureId: captureId(), pageUrl: `${origin}${path}?ref=abc`, anchor: anchor(path, y, selector), note: null });

export const build = (commit = 'a'.repeat(40)) => ({ version: '1.2.3', commit, branch: 'stg', environment: 'stg', builtAt: null, repo: REPO });

/** A whole evidence bundle; `over` replaces top-level parts. */
export function evidence(over: Partial<Record<keyof ReporterEvidence, unknown>> = {}): Record<string, unknown> {
  // Times as the SDK stamps them: epoch milliseconds from the real clock (small numbers here hid PILOT-1111's 422).
  const t = Date.now() - 5000;
  return {
    schema: REPORTER_EVIDENCE_SCHEMA,
    sdkVersion: '1.0.0',
    capturedAt: new Date().toISOString(),
    page: { url: `${STG}/pricing?ref=abc`, origin: STG, host: 'stg.konfersi.com', path: '/pricing', search: '?ref=abc', hash: '', title: 'Pricing', referrer: '', lang: 'id', route: '/pricing', historyLength: 2 },
    device: {
      userAgent: 'Mozilla/5.0 (iPhone)',
      browser: { name: 'Safari', version: '18' },
      os: { name: 'iOS', version: '18.1' },
      mobile: true,
      touch: true,
      screen: { w: 390, h: 844, dpr: 3, orientation: 'portrait-primary' },
      viewport: { w: 390, h: 844 },
      hardwareConcurrency: 6,
      deviceMemoryGb: null,
      connection: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, saveData: false },
      timezone: 'Asia/Jakarta',
      locale: 'id-ID',
    },
    state: { scroll: { x: 0, y: 0, maxY: 2000 }, visibility: 'visible', online: true, colorScheme: 'dark', reducedMotion: false, focused: null, storageKeys: { local: ['theme'], session: [], cookies: [] }, app: null },
    build: build(),
    anchor: anchor(),
    dom: { selector: '#hero', path: 'html > body > main > #hero', snippet: '<section id="hero">' },
    components: [{ name: 'Hero', depth: 3 }],
    framework: 'react',
    console: [{ ts: t + 1, level: 'error', text: 'TypeError: x is undefined' }],
    network: [{ ts: Math.round(performance.timeOrigin + performance.now()), method: 'GET', url: `${STG}/api/plans?id=1`, status: 500, durationMs: 120, initiator: 'fetch', sizeBytes: 10 }],
    performance: { navigation: { ttfbMs: 100, domContentLoadedMs: 500, loadMs: 900, type: 'navigate' }, vitals: { lcpMs: 1800, cls: 0.01, inpMs: 80, fcpMs: 700 }, longTasks: { count: 1, totalMs: 60 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
    interactions: [
      { ts: t, kind: 'navigate', selector: null, label: null, detail: '/' },
      { ts: t + 2, kind: 'click', selector: 'a[href="/pricing"]', label: 'Pricing' },
      { ts: t + 3, kind: 'input', selector: '#email', label: 'Email', value: 'someone@example.com' },
    ],
    checks: { ran: true, findings: [{ source: 'target-size', rule: 'target-44', severity: 'serious', message: 'Button is 32x32', selector: '#buy', help: null }] },
    errorSignatures: ['TypeError: x is undefined @ app.js:hero'],
    ...over,
  };
}

export const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
