// WebMCP tools of the reporter panel (PILOT-1128, docs/prd/ui-reporter-webmcp.md): feature detection, registration, each tool's schema, and each
// tool's path through the SAME /reporter/v1 routes and bearer token as the Report form (a real ReporterClient over a recording fetch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_TOKEN_PREFIX, type ReporterEvidence, type ReporterStatus, type ReporterTicket } from '@portal/contracts';
import { createClient } from './api';
import type { Capture } from './context';
import { captureInput, fileReport } from './submit';
import {
  TOOL_NAMES,
  WEBMCP_TAG,
  composeDescription,
  keyOf,
  modelContextOf,
  registerTools,
  reporterTools,
  toolsAllowed,
  type ReporterToolDeps,
  type ToolAsk,
  type ToolSnapshot,
  type WebMcpTool,
} from './webmcp';
import { createShim } from './webmcpShim';

const HOST = 'https://stg.konfersi.com';
// Built at runtime: no token-shaped literal in the repo.
const TOKEN = `${REPORTER_TOKEN_PREFIX}${'t'.repeat(4)}${Date.now().toString(36)}`;
const build = {
  version: null,
  commit: 'abc1234',
  branch: 'stg',
  environment: 'stg',
  builtAt: null,
  repo: 'platform/konfersi-landing-page',
};

const status: ReporterStatus = {
  site: { origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', label: null, branch: 'stg' },
  enabled: true,
  bucketKey: 'KONF',
  bucketName: 'Konfersi',
  calloutsDefault: true,
  sdkVersion: '0.1.0+50dfa07',
};

function evidence(path = '/pricing'): ReporterEvidence {
  return {
    schema: 1,
    sdkVersion: '0.1.0',
    capturedAt: new Date().toISOString(),
    page: {
      url: `${HOST}${path}?secret=1`,
      origin: HOST,
      host: 'stg.konfersi.com',
      path,
      search: '',
      hash: '',
      title: 'Pricing',
      referrer: '',
      lang: 'en',
      route: null,
      historyLength: 1,
    },
    device: {
      userAgent: 'test',
      browser: { name: null, version: null },
      os: { name: null, version: null },
      mobile: false,
      touch: false,
      screen: { w: 1280, h: 800, dpr: 1, orientation: null },
      viewport: { w: 1280, h: 800 },
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null },
      timezone: null,
      locale: null,
    },
    state: {
      scroll: { x: 0, y: 0, maxY: 0 },
      visibility: 'visible',
      online: true,
      colorScheme: 'light',
      reducedMotion: false,
      focused: null,
      storageKeys: { local: [], session: [], cookies: [] },
      app: null,
    },
    build,
    anchor: {
      path,
      selector: 'main > h1',
      relative: null,
      rect: { x: 0, y: 0, w: 1280, h: 800 },
      viewport: { w: 1280, h: 800, dpr: 1 },
      mode: 'viewport',
    },
    dom: null,
    components: [],
    framework: null,
    console: [],
    network: [],
    performance: {
      navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null },
      vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null },
      longTasks: { count: 0, totalMs: 0 },
      memory: { usedJsHeapBytes: null, totalJsHeapBytes: null },
    },
    interactions: [],
    checks: { ran: true, findings: [] },
    errorSignatures: [],
  };
}

let n = 0;
const shot = (path?: string): Capture => ({
  captureId: `cap-${++n}`,
  requestId: `req-${n}`,
  screenshot: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  previewUrl: 'blob:preview',
  evidence: evidence(path),
});

function ticket(key: string, over: Partial<ReporterTicket> = {}): ReporterTicket {
  return {
    key,
    summary: `Summary of ${key}`,
    status: 'open',
    type: 'bug',
    priority: 'normal',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    url: `https://pilot.example/tickets/${key}`,
    captures: [],
    build: null,
    phase: 'open',
    fix: null,
    site: { bucketKey: 'KONF', origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', declaredMismatch: null },
    target: { kind: 'ticket' },
    fixCommits: [],
    deployments: [],
    unread: 0,
    awaitingReporter: false,
    repro: null,
    checkCounts: {} as ReporterTicket['checkCounts'],
    ...over,
  };
}

/** A real ReporterClient over a fetch that records every call and answers like /reporter/v1. */
function harness(
  opts: {
    connected?: boolean;
    offered?: 'signed-in' | 'signed-out';
    shots?: Capture[];
    mine?: ReporterTicket[];
    answer?: boolean | null;
    coarse?: boolean;
    /** An auto-approve grant id the panel answers with (first ask only, unless noAuto). */
    grant?: string;
    /** The server refuses an auto-approved create with this code (LIMIT_REACHED, CONFIRMATION_REQUIRED). */
    refuseAuto?: string;
  } = {},
) {
  const calls: { method: string; url: string; auth: string | null; body: unknown; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const raw = init.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw instanceof Blob ? { blob: raw.type } : undefined;
    calls.push({ method: init.method ?? 'GET', url, auth: headers.Authorization ?? null, body, headers });
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    const path = url.split('?')[0]!;
    if (path === '/reporter/v1/tickets' && init.method === 'POST' && opts.refuseAuto && headers['x-reporter-agent-grant'])
      return new Response(
        JSON.stringify({ error: { code: opts.refuseAuto, message: 'Auto-approve allows 10 reports an hour. Ask the person.' } }),
        { status: 429 },
      );
    if (path === '/reporter/v1/tickets' && init.method === 'POST')
      return ok({ key: 'KONF-41', url: 'https://pilot.example/tickets/KONF-41' });
    if (path === '/reporter/v1/tickets') {
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      const items = (opts.mine ?? []).filter((t) => !q.get('q') || t.key === q.get('q'));
      return ok({ items, nextCursor: null, counts: { status: {}, priority: {}, type: {}, onPath: 0 } });
    }
    return ok({});
  }) as unknown as typeof fetch;
  const client = createClient({ token: () => (opts.connected === false ? null : TOKEN), onUnauthorized: () => undefined, fetchFn });
  const shots = opts.shots ?? [];
  const asks: ToolAsk[] = [];
  const events: string[] = [];
  const snapshot = (): ToolSnapshot => ({
    connected: opts.connected !== false,
    client,
    bucket: 'KONF',
    status,
    page: { url: `${HOST}/pricing?code=abc`, title: 'Pricing' },
    build,
    sdkVersion: '0.1.0+50dfa07',
    actorLabel: 'Alfian',
    shots,
    review: null,
    coarse: !!opts.coarse,
  });
  const deps: ReporterToolDeps = {
    snapshot,
    capture: async (mode) => {
      const c = shot();
      c.evidence.anchor.mode = mode;
      shots.push(c);
      return c;
    },
    approve: async (a) => {
      asks.push(a);
      if (opts.grant && !a.noAuto) return { kind: 'auto', grantId: opts.grant };
      return (opts.answer ?? true) ? { kind: 'person' } : { kind: 'denied' };
    },
    autoRefused: () => events.push('auto refused'),
    filed: (key) => events.push(`filed ${key}`),
    used: (ids) => events.push(`used ${ids.join(',')}`),
  };
  // `offered`: the tool set registered (by default what the panel's state says); signed in, then signed out, keeps the larger set.
  const offered = opts.offered ? opts.offered === 'signed-in' : opts.connected !== false;
  const tools = new Map(reporterTools(deps, { connected: offered }).map((t) => [t.name, t]));
  const run = async (name: string, input?: Record<string, unknown>) => {
    const t = tools.get(name);
    assert.ok(t, `tool ${name} is offered`);
    // The spec serializes what execute returns to a JSON string: it must survive that.
    return JSON.parse(JSON.stringify(await t.execute(input, { signal: new AbortController().signal }))) as Record<string, unknown>;
  };
  return { calls, asks, events, run, tools, shots };
}

/* ---------- detection and registration ---------- */

test('detection: document.modelContext (the spec) first, navigator.modelContext (older Chrome) next, nothing otherwise', () => {
  const spec = { registerTool: () => Promise.resolve() };
  const legacy = { registerTool: () => ({ unregister: () => undefined }) };
  assert.equal(modelContextOf({ modelContext: spec }, { modelContext: legacy }), spec);
  assert.equal(modelContextOf({}, { modelContext: legacy }), legacy);
  // A browser without WebMCP: no tools, the panel stays the form it was.
  assert.equal(modelContextOf({}, {}), null);
  assert.equal(modelContextOf(null, undefined), null);
  assert.equal(modelContextOf({ modelContext: {} }, { modelContext: { registerTool: 'no' } }), null);
});

test('detection: the tools permissions policy says no (an iframe without allow="tools"): nothing is registered; no policy API means try', () => {
  assert.equal(toolsAllowed({ permissionsPolicy: { allowsFeature: (f: string) => f !== 'tools' } }), false);
  assert.equal(toolsAllowed({ featurePolicy: { allowsFeature: () => true } }), true);
  assert.equal(toolsAllowed({}), true);
});

test('registration: signed out only the context tool; signed in all six; aborting the signal unregisters them all', () => {
  const mc = createShim();
  const out = new AbortController();
  registerTools(mc, [...harness({ connected: false }).tools.values()], out.signal);
  assert.deepEqual(
    mc.list().map((t) => t.name),
    [TOOL_NAMES.context],
  );
  out.abort();
  assert.deepEqual(mc.list(), []);

  const { tools } = harness();
  const ctl = new AbortController();
  registerTools(mc, [...tools.values()], ctl.signal);
  assert.deepEqual(
    mc
      .list()
      .map((t) => t.name)
      .sort(),
    Object.values(TOOL_NAMES).sort(),
  );
  ctl.abort();
  assert.deepEqual(mc.list(), []);
});

test('registration: the older API (a handle with unregister(), no signal) is unregistered on abort; a refusal is quiet', async () => {
  const live = new Set<string>();
  const legacy = {
    registerTool: (t: WebMcpTool) => {
      if (t.name === TOOL_NAMES.list) throw new Error('refused');
      live.add(t.name);
      return { unregister: () => live.delete(t.name) };
    },
  };
  const ctl = new AbortController();
  registerTools(legacy, [...harness().tools.values()], ctl.signal);
  assert.equal(live.size, 5, 'the refused one is left out, the rest registered');
  ctl.abort();
  assert.equal(live.size, 0);
  // The spec's promise rejecting (a duplicate name) is swallowed, never an unhandled rejection.
  const mc = createShim();
  const tools = [...harness().tools.values()];
  registerTools(mc, tools, new AbortController().signal);
  registerTools(mc, tools, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mc.list().length, 6);
});

/* ---------- schemas ---------- */

test('schemas: spec-valid names, a description, an object schema that refuses extra fields, the right hints', () => {
  const { tools } = harness();
  const readOnly = [TOOL_NAMES.context, TOOL_NAMES.list];
  const consequential = [TOOL_NAMES.create, TOOL_NAMES.attach, TOOL_NAMES.comment];
  for (const t of tools.values()) {
    assert.match(t.name, /^[A-Za-z0-9_.-]{1,128}$/, t.name);
    assert.ok(t.description.length > 40, `${t.name} describes itself`);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.doesNotThrow(() => JSON.stringify(t.inputSchema));
    assert.equal(!!t.annotations?.readOnlyHint, readOnly.includes(t.name as never), `${t.name} readOnlyHint`);
    assert.equal(!!t.annotations?.consequentialHint, consequential.includes(t.name as never), `${t.name} consequentialHint`);
  }
  const create = tools.get(TOOL_NAMES.create)!.inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(create.required, ['summary']);
  assert.deepEqual(create.properties.type!.enum, ['bug', 'feature', 'task', 'question'], 'the types the form offers');
  assert.deepEqual(create.properties.priority!.enum, ['urgent', 'high', 'normal', 'low']);
  assert.deepEqual((tools.get(TOOL_NAMES.comment)!.inputSchema as { required: string[] }).required, ['key', 'body']);
});

/* ---------- each tool's path ---------- */

test('get context: project, site, page without its query, the reporter, the shots held; signed out names nobody and holds nothing', async () => {
  const s = shot();
  const h = harness({ shots: [s] });
  const r = await h.run(TOOL_NAMES.context);
  assert.deepEqual(r.project, { bucket: 'KONF', name: 'Konfersi' });
  assert.deepEqual(r.site, { origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', branch: 'stg' });
  assert.deepEqual(r.page, { url: `${HOST}/pricing`, title: 'Pricing' });
  assert.equal(r.reporter, 'Alfian');
  assert.deepEqual(r.shots, [{ captureId: s.captureId, page: `${HOST}/pricing`, mode: 'viewport', marks: 0 }]);
  assert.equal(h.calls.length, 0, 'reads the panel, calls nothing');
  const out = await harness({ connected: false, shots: [shot()] }).run(TOOL_NAMES.context);
  assert.equal(out.connected, false);
  assert.equal(out.reporter, null);
  assert.deepEqual(out.shots, []);
});

test('create report: the form path (POST /reporter/v1/tickets with this panel token, then each shot uploaded), only after Allow', async () => {
  const a = shot('/pricing');
  const b = shot('/checkout');
  const h = harness({ shots: [a, b] });
  const r = await h.run(TOOL_NAMES.create, {
    summary: '  Price is cut off  ',
    description: 'The price wraps.',
    type: 'bug',
    priority: 'high',
    steps: ['Open /pricing', 'Resize to 390 px'],
    expected: 'One line',
    actual: 'Two lines',
  });
  assert.deepEqual(r, { ok: true, key: 'KONF-41', url: 'https://pilot.example/tickets/KONF-41', uploadFailed: [], autoApproved: false });
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0]!.action, 'File a report');
  assert.equal(h.asks[0]!.lines[0], 'Price is cut off');
  // The sheet shows what is sent, as plain text (no Markdown markers).
  assert.deepEqual(h.asks[0]!.lines.slice(3), [
    'The price wraps.',
    'Steps to reproduce:\n1. Open /pricing\n2. Resize to 390 px',
    'Expected: One line',
    'Actual: Two lines',
  ]);
  assert.ok(!h.asks[0]!.lines.join('\n').includes('**'), 'no raw Markdown in the sheet');
  assert.equal(h.asks[0]!.group, 'file');
  const create = h.calls[0]!;
  assert.deepEqual([create.method, create.url, create.auth], ['POST', '/reporter/v1/tickets', `Bearer ${TOKEN}`]);
  assert.deepEqual(create.body, {
    summary: 'Price is cut off',
    description:
      'The price wraps.\n\n**Steps to reproduce**\n\n1. Open /pricing\n2. Resize to 390 px\n\n**Expected**\n\nOne line\n\n**Actual**\n\nTwo lines',
    type: 'bug',
    priority: 'high',
    tags: [WEBMCP_TAG],
    build,
    sdkVersion: '0.1.0+50dfa07',
    target: { kind: 'ticket' },
    captures: [captureInput(a, null), captureInput(b, null)],
  });
  // Each shot: its screenshot, then its evidence, to the new ticket, named by captureId (what the form uploads).
  assert.deepEqual(
    h.calls.slice(1).map((c) => [c.url, c.headers['x-reporter-capture'], c.headers['x-reporter-kind'], c.auth === `Bearer ${TOKEN}`]),
    [
      ['/reporter/v1/tickets/KONF-41/attachments', a.captureId, 'screenshot', true],
      ['/reporter/v1/tickets/KONF-41/attachments', a.captureId, 'evidence', true],
      ['/reporter/v1/tickets/KONF-41/attachments', b.captureId, 'screenshot', true],
      ['/reporter/v1/tickets/KONF-41/attachments', b.captureId, 'evidence', true],
    ],
  );
  assert.deepEqual(h.events, ['filed KONF-41']);
});

test('create report: Deny sends nothing; no shot, a bad type, an empty title or bad steps are refused before asking', async () => {
  const denied = harness({ shots: [shot()], answer: false });
  const r = await denied.run(TOOL_NAMES.create, { summary: 'x' });
  assert.equal(r.code, 'DENIED');
  assert.equal(denied.calls.length, 0);
  assert.deepEqual(denied.events, []);

  const cases: [Record<string, unknown>, boolean, string][] = [
    [{ summary: 'x' }, false, 'NO_SCREENSHOT'],
    [{ summary: '   ' }, true, 'INVALID'],
    [{ summary: 'x', type: 'incident' }, true, 'INVALID'],
    [{ summary: 'x', priority: 'p0' }, true, 'INVALID'],
    [{ summary: 'x', steps: 'one' }, true, 'INVALID'],
    [{ summary: 'x', description: 'y'.repeat(8001) }, true, 'INVALID'],
    [{ summary: 7 }, true, 'INVALID'],
  ];
  for (const [input, withShot, code] of cases) {
    const h = harness({ shots: withShot ? [shot()] : [] });
    const out = await h.run(TOOL_NAMES.create, input);
    assert.equal(out.code, code, JSON.stringify(input));
    assert.equal(h.asks.length, 0, 'nothing asked');
    assert.equal(h.calls.length, 0, 'nothing sent');
  }
});

test('signed out after registering: every sending tool answers NOT_CONNECTED and calls nothing', async () => {
  // The token was revoked while the agent still held the signed-in tool list.
  const h = harness({ connected: false, offered: 'signed-in', shots: [shot()], mine: [ticket('KONF-12')] });
  for (const name of Object.values(TOOL_NAMES)) {
    if (name === TOOL_NAMES.context) continue;
    assert.equal(
      (await h.run(name, name === TOOL_NAMES.list ? {} : { summary: 'x', key: 'KONF-12', body: 'hi' })).code,
      'NOT_CONNECTED',
      name,
    );
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.asks.length, 0);
});

test('capture: joins the report being written; whole page refused on a phone; at most six shots', async () => {
  const h = harness();
  const r = await h.run(TOOL_NAMES.capture, { mode: 'full' });
  assert.equal(r.ok, true);
  assert.equal((r.shot as { mode: string }).mode, 'full');
  assert.equal(r.shots, 1);
  assert.equal((await harness({ coarse: true }).run(TOOL_NAMES.capture, { mode: 'full' })).code, 'INVALID');
  assert.equal((await harness({ shots: Array.from({ length: 6 }, () => shot()) }).run(TOOL_NAMES.capture)).code, 'LIMIT');
  assert.equal(h.calls.length, 0, 'a capture sends nothing');
});

test('list my reports: GET /reporter/v1/tickets with mine=true and the token; keys are the project keys, not T-n', async () => {
  const h = harness({ mine: [ticket('KONF-12', { awaitingReporter: true, unread: 2, phase: 'working' }), ticket('KONF-9')] });
  const r = await h.run(TOOL_NAMES.list, { status: 'all', limit: 5 });
  const call = h.calls[0]!;
  assert.equal(call.url.split('?')[0], '/reporter/v1/tickets');
  const q = new URLSearchParams(call.url.split('?')[1]);
  assert.deepEqual(
    [q.get('mine'), q.get('status'), q.get('limit'), q.get('sort'), call.auth],
    ['true', 'all', '5', 'updated', `Bearer ${TOKEN}`],
  );
  const reports = r.reports as { key: string; phase: string; awaitingYourReply: boolean; environment: string }[];
  assert.deepEqual(
    reports.map((t) => t.key),
    ['KONF-12', 'KONF-9'],
  );
  assert.deepEqual([reports[0]!.phase, reports[0]!.awaitingYourReply, reports[0]!.environment], ['working', true, 'stg']);
  assert.equal((await h.run(TOOL_NAMES.list, { limit: 500 })).code, 'INVALID');
});

test('comment: only on a report of mine in this bucket, after Allow, through POST /reporter/v1/tickets/:key/comments', async () => {
  const h = harness({ mine: [ticket('KONF-12')] });
  const r = await h.run(TOOL_NAMES.comment, { key: 'konf-12', body: ' Still broken on iOS. ' });
  assert.deepEqual(r, { ok: true, key: 'KONF-12', autoApproved: false });
  assert.deepEqual(h.asks[0], { action: 'Comment on KONF-12', group: 'comment', lines: ['Still broken on iOS.'] });
  const post = h.calls.at(-1)!;
  assert.deepEqual(
    [post.method, post.url, post.body, post.auth],
    ['POST', '/reporter/v1/tickets/KONF-12/comments', { body: 'Still broken on iOS.' }, `Bearer ${TOKEN}`],
  );

  // A portal id, another bucket's key, or a ticket that is not mine: refused, nothing posted, nobody asked.
  for (const key of ['T-12', 'PILOT-12', 'KONF-99']) {
    const x = harness({ mine: [ticket('KONF-12')] });
    const out = await x.run(TOOL_NAMES.comment, { key, body: 'hi' });
    assert.ok(out.code === 'INVALID' || out.code === 'NOT_FOUND', key);
    assert.equal(x.asks.length, 0, key);
    assert.ok(!x.calls.some((c) => c.method === 'POST'), key);
  }
  const denied = harness({ mine: [ticket('KONF-12')], answer: false });
  assert.equal((await denied.run(TOOL_NAMES.comment, { key: 'KONF-12', body: 'hi' })).code, 'DENIED');
  assert.ok(!denied.calls.some((c) => c.method === 'POST'));
});

test('attach screenshots: the "Add to it" path (captures, then files) to an open report of mine, after Allow', async () => {
  const a = shot();
  const b = shot();
  const h = harness({ shots: [a, b], mine: [ticket('KONF-12')] });
  const r = await h.run(TOOL_NAMES.attach, { key: 'KONF-12', captureIds: [b.captureId] });
  assert.deepEqual(r, { ok: true, key: 'KONF-12', added: 1, uploadFailed: [], autoApproved: false });
  const posts = h.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts[0]!.url, '/reporter/v1/tickets/KONF-12/captures');
  assert.deepEqual(posts[0]!.body, { captures: [captureInput(b, null)] });
  assert.deepEqual(
    posts.slice(1).map((c) => [c.url, c.headers['x-reporter-capture'], c.headers['x-reporter-kind']]),
    [
      ['/reporter/v1/tickets/KONF-12/attachments', b.captureId, 'screenshot'],
      ['/reporter/v1/tickets/KONF-12/attachments', b.captureId, 'evidence'],
    ],
  );
  assert.deepEqual(h.events, [`used ${b.captureId}`]);
  const notMine = harness({ shots: [shot()], mine: [] });
  assert.equal((await notMine.run(TOOL_NAMES.attach, { key: 'KONF-12' })).code, 'NOT_FOUND');
  assert.ok(!notMine.calls.some((c) => c.method === 'POST'));
});

/* ---------- the form, unchanged ---------- */

test('the form path: fileReport sends what the Report form always sent (no tag of its own), then uploads with progress', async () => {
  const a = shot();
  const h = harness();
  const client = createClient({
    token: () => TOKEN,
    onUnauthorized: () => undefined,
    fetchFn: (async (url: string, init: RequestInit) => {
      h.calls.push({
        method: init.method ?? 'GET',
        url,
        auth: null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        headers: {},
      });
      return new Response(JSON.stringify({ data: { key: 'KONF-7', url: 'u' } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const steps: string[] = [];
  const req = {
    summary: 'T',
    description: '',
    type: 'bug' as const,
    priority: 'normal' as const,
    tags: [],
    build,
    sdkVersion: '0.1.0',
    target: { kind: 'ticket' as const },
  };
  const { res, failed } = await fileReport(client, req, [a], (d, t) => steps.push(`${d}/${t}`));
  assert.equal(res.key, 'KONF-7');
  assert.deepEqual(failed, []);
  assert.deepEqual(h.calls[0]!.body, { ...req, captures: [captureInput(a, null)] });
  assert.deepEqual(steps, ['0/2', '1/2', '2/2']);
});

test('helpers: the description is composed in order and skips what is empty; a key belongs to this bucket', () => {
  assert.equal(composeDescription({}), '');
  assert.equal(composeDescription({ steps: [' a ', '', 'b\nc'] }), '**Steps to reproduce**\n\n1. a\n2. b c');
  assert.equal(keyOf(' konf-3 ', 'KONF'), 'KONF-3');
  assert.equal(keyOf('KONF-0', 'KONF'), null);
  assert.equal(keyOf('T-3', 'KONF'), null);
  assert.equal(keyOf('KONFX-3', 'KONF'), null);
});

/* ---------- auto-approve (PILOT-1128) ---------- */

test('auto-approve: a grant answers without the sheet and the call names it (x-reporter-agent-grant); asked in the sheet, no header', async () => {
  const h = harness({ shots: [shot()], grant: 'rag_1', mine: [ticket('KONF-12')] });
  const r = await h.run(TOOL_NAMES.create, { summary: 'Auto' });
  assert.equal(r.autoApproved, true);
  const create = h.calls.find((c) => c.method === 'POST' && c.url === '/reporter/v1/tickets')!;
  assert.equal(create.headers['x-reporter-agent-grant'], 'rag_1');
  // The uploads that follow are the person's own file uploads: they carry no grant.
  assert.ok(h.calls.filter((c) => /attachments/.test(c.url)).every((c) => !c.headers['x-reporter-agent-grant']));
  const c = await h.run(TOOL_NAMES.comment, { key: 'KONF-12', body: 'hi' });
  assert.equal(c.autoApproved, true);
  assert.equal(h.calls.at(-1)!.headers['x-reporter-agent-grant'], 'rag_1');

  const asked = harness({ shots: [shot()] });
  await asked.run(TOOL_NAMES.create, { summary: 'Asked' });
  assert.ok(asked.calls.every((x) => !x.headers['x-reporter-agent-grant']));
});

for (const code of ['LIMIT_REACHED', 'CONFIRMATION_REQUIRED'])
  test(`auto-approve: the server refuses the grant (${code}): the person is asked with the reason, then it goes as theirs`, async () => {
    const h = harness({ shots: [shot()], grant: 'rag_1', refuseAuto: code });
    const r = await h.run(TOOL_NAMES.create, { summary: 'Over the cap' });
    assert.equal(r.ok, true);
    assert.equal(r.autoApproved, false);
    assert.equal(h.asks.length, 2);
    assert.equal(h.asks[1]!.noAuto, true);
    assert.match(h.asks[1]!.note ?? '', /^Auto-approve did not apply: Auto-approve allows 10 reports an hour/);
    const creates = h.calls.filter((c) => c.method === 'POST' && c.url === '/reporter/v1/tickets');
    assert.deepEqual(
      creates.map((c) => c.headers['x-reporter-agent-grant'] ?? null),
      ['rag_1', null],
    );
    assert.ok(h.events.includes('auto refused'), 'the panel reloads its grants');
  });

test('auto-approve: refused and then denied by the person: nothing filed', async () => {
  const h = harness({ shots: [shot()], grant: 'rag_1', refuseAuto: 'LIMIT_REACHED', answer: false });
  const r = await h.run(TOOL_NAMES.create, { summary: 'x' });
  assert.equal(r.code, 'DENIED');
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url === '/reporter/v1/tickets' && !c.headers['x-reporter-agent-grant']).length,
    0,
  );
  assert.deepEqual(h.events, ['auto refused']);
});

test('dev shim: the spec rules it keeps (names, duplicates, an aborted signal) and call() answers a JSON string', async () => {
  const mc = createShim();
  const tool = (name: string): WebMcpTool => ({
    name,
    description: 'd',
    inputSchema: { type: 'object' },
    execute: async (i) => ({ echo: i }),
  });
  await assert.rejects(Promise.resolve(mc.registerTool(tool('bad name'))));
  await mc.registerTool(tool('ok'));
  await assert.rejects(Promise.resolve(mc.registerTool(tool('ok'))));
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(Promise.resolve(mc.registerTool(tool('late'), { signal: gone.signal })));
  assert.equal(await mc.call('ok', { a: 1 }), '{"echo":{"a":1}}');
});
