import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterAnchor, ReporterReview, ReporterTicket } from '@portal/contracts';
import { clearToken, createClient, fill, memoryStorage, parseConnectMessage, readToken, writeToken } from './api';
import { blocks, inlineTokens } from './markdown';
import {
  DEFAULT_PREFS,
  activeFilterCount,
  buildCallouts,
  buildQuery,
  groupByPage,
  hotkeyOf,
  parseHotkeys,
  parsePrefs,
  playlist,
  querySearch,
  samePageHref,
  splitStream,
  ticketsFor,
} from './model';

const HOST = 'https://stg.konfersi.com';
const anchor = (path: string, y = 0): ReporterAnchor => ({ path, selector: null, relative: null, rect: { x: 0, y, w: 10, h: 10 }, viewport: { w: 390, h: 844, dpr: 3 }, mode: 'crop' });

function ticket(key: string, over: Partial<ReporterTicket> = {}): ReporterTicket {
  const now = new Date().toISOString();
  return {
    key,
    summary: `${key} summary`,
    status: 'open',
    type: 'bug',
    priority: 'normal',
    createdAt: now,
    updatedAt: now,
    url: `https://pilot.example/tickets/${key}`,
    captures: [{ captureId: `${key}-c1`, index: 1, pageUrl: `${HOST}/pricing`, anchor: anchor('/pricing'), note: null, createdAt: now, screenshotUrl: null }],
    build: null,
    phase: 'open',
    fix: null,
    site: { bucketKey: 'KONF', origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', declaredMismatch: null },
    target: { kind: 'ticket' },
    fixCommits: [],
    deployments: [
      { environment: 'stg', status: 'deployed', currentCommit: 'b'.repeat(40), seenAt: now, fixCommit: 'a'.repeat(40), reason: null },
      { environment: 'uat', status: 'unknown', currentCommit: null, seenAt: null, fixCommit: null, reason: 'no-build-seen' },
    ],
    unread: 0,
    awaitingReporter: false,
    repro: null,
    checkCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    ...over,
  };
}

test('This page is the default scope, sorted by position top to bottom', () => {
  const q = buildQuery(DEFAULT_PREFS, '/pricing?plan=pro');
  assert.deepEqual(q, { status: 'open', sort: 'position', order: 'asc', limit: 100, path: '/pricing' });
  assert.equal(querySearch(q), '?status=open&sort=position&order=asc&limit=100&path=%2Fpricing');
});

test('All pages never sorts by position and sends the filters as lists', () => {
  const p = { ...DEFAULT_PREFS, scope: 'all' as const, sort: 'position' as const, priority: ['urgent' as const, 'high' as const], mine: true, q: ' nav ' };
  const q = buildQuery(p, '/pricing');
  assert.equal(q.sort, 'updated');
  assert.equal(q.order, 'desc');
  assert.equal(q.path, undefined);
  assert.match(querySearch(q), /priority=urgent%2Chigh/);
  assert.match(querySearch(q), /mine=true/);
  assert.match(querySearch(q), /q=nav/);
  assert.equal(activeFilterCount(p), 3);
});

test('remembered prefs survive odd storage values', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{nope'), DEFAULT_PREFS);
  const p = parsePrefs(JSON.stringify({ scope: 'grouped', status: 'drop table', sort: 'captures', order: 'up', priority: ['high', 3], q: 'kept?' }));
  assert.equal(p.scope, 'grouped');
  assert.equal(p.status, 'open');
  assert.equal(p.sort, 'captures');
  assert.equal(p.order, null);
  assert.deepEqual(p.priority, ['high']);
  assert.equal(p.q, '');
});

test('callouts: one per capture on this page, with THIS environment’s deployment and where it was reported', () => {
  const t = ticket('KONF-1', {
    captures: [
      { captureId: 'a', index: 1, pageUrl: '', anchor: anchor('/pricing'), note: null, createdAt: '', screenshotUrl: null },
      { captureId: 'b', index: 2, pageUrl: '', anchor: anchor('/about'), note: null, createdAt: '', screenshotUrl: null },
      { captureId: 'c', index: 3, pageUrl: '', anchor: anchor('/pricing/'), note: null, createdAt: '', screenshotUrl: null },
    ],
  });
  const onUat = buildCallouts([t], '/pricing', 'uat', null);
  assert.deepEqual(onUat.map((c) => [c.captureId, c.index, c.total]), [['a', 1, 3], ['c', 3, 3]]);
  assert.equal(onUat[0]!.deployment?.environment, 'uat');
  assert.equal(onUat[0]!.deployment?.status, 'unknown');
  assert.deepEqual(onUat[0]!.reportedOn, { origin: HOST, environment: 'stg' });
  assert.equal(buildCallouts([t], '/pricing', 'stg', null)[0]!.deployment?.status, 'deployed');
  assert.equal(buildCallouts([t], '/pricing', 'prod', null)[0]!.deployment, null);
});

test('won’t-do tickets and long-done ones get no callout; recent done ones keep theirs', () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const list = [ticket('KONF-1', { status: 'wont_do' }), ticket('KONF-2', { status: 'done', updatedAt: old }), ticket('KONF-3', { status: 'done', phase: 'deployed' })];
  assert.deepEqual(buildCallouts(list, '/pricing', 'stg', null).map((c) => c.key), ['KONF-3']);
});

test('the viewer’s own draft comments show as pending callouts', () => {
  const now = new Date().toISOString();
  const review: ReporterReview = {
    id: 'rv1',
    bucketKey: 'KONF',
    status: 'draft',
    title: 'Landing pass',
    createdAt: now,
    updatedAt: now,
    ticketKeys: [],
    comments: [
      { captureId: 'x', index: 1, pageUrl: '', anchor: anchor('/pricing'), note: null, createdAt: now, body: 'Button cut off\nmore', updatedAt: now, screenshotUrl: null },
      { captureId: 'y', index: 2, pageUrl: '', anchor: anchor('/about'), note: null, createdAt: now, body: 'Logo blurry', updatedAt: now, screenshotUrl: null },
    ],
  };
  const c = buildCallouts([], '/pricing', 'stg', review);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.pending, true);
  assert.equal(c[0]!.summary, 'Button cut off');
  assert.equal(c[0]!.total, 2);
  assert.equal(buildCallouts([], '/pricing', 'stg', { ...review, status: 'submitted' }).length, 0);
  assert.equal(ticketsFor(review, 'single'), 1);
  assert.equal(ticketsFor(review, 'per-page'), 2);
  assert.equal(ticketsFor(review, 'per-capture'), 2);
});

test('Play all walks every capture on the page top to bottom; grouping keeps first-seen order', () => {
  const a = ticket('KONF-1', { captures: [{ captureId: 'a1', index: 1, pageUrl: '', anchor: anchor('/pricing', 900), note: null, createdAt: '', screenshotUrl: null }] });
  const b = ticket('KONF-2', { captures: [{ captureId: 'b1', index: 1, pageUrl: '', anchor: anchor('/pricing', 100), note: null, createdAt: '', screenshotUrl: null }] });
  assert.deepEqual(playlist([a, b], '/pricing').map((p) => p.captureId), ['b1', 'a1']);
  const c = ticket('KONF-3', { captures: [{ captureId: 'c1', index: 1, pageUrl: '', anchor: anchor('/about'), note: null, createdAt: '', screenshotUrl: null }] });
  assert.deepEqual(groupByPage([a, c, b]).map((g) => [g.path, g.items.length]), [['/pricing', 2], ['/about', 1]]);
});

test('Open that page stays on the host origin', () => {
  assert.equal(samePageHref(HOST, '/about?x=1'), `${HOST}/about?x=1`);
  assert.equal(samePageHref(HOST, 'https://evil.example/x'), null);
  assert.equal(samePageHref(HOST, '//evil.example/x'), null);
  assert.equal(samePageHref(HOST, 'javascript:alert(1)'), null);
});

test('the events stream reads SSE framing and plain JSON lines, keeping a partial line for later', () => {
  const a = splitStream('data: {"kind":"phase","key":"KONF-1"}\n\n: keep-alive\nevent: change\n{"kind":"comment"}\ndata: {"kin');
  assert.deepEqual(a.events, [{ kind: 'phase', key: 'KONF-1' }, { kind: 'comment' }]);
  assert.equal(a.rest, 'data: {"kin');
  assert.deepEqual(splitStream(`${a.rest}d":"x"}\n`).events, [{ kind: 'x' }]);
});

test('hotkeys need a modifier and are stored only in a known form', () => {
  assert.equal(hotkeyOf({ key: 'r', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }), 'Alt+Shift+R');
  assert.equal(hotkeyOf({ key: 'r', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }), null);
  assert.equal(hotkeyOf({ key: 'Shift', altKey: false, shiftKey: true, ctrlKey: false, metaKey: false }), null);
  assert.equal(parseHotkeys(JSON.stringify({ report: 'Ctrl+K', crop: 'x' })).report, 'Ctrl+K');
  assert.equal(parseHotkeys(JSON.stringify({ report: 'Ctrl+K', crop: 'x' })).crop, 'Alt+Shift+C');
  assert.equal(parseHotkeys('{').panel, 'Alt+Shift+P');
});

test('the token is kept per bucket and origin, dropped when expired', () => {
  const kv = memoryStorage();
  const later = new Date(Date.now() + 3600_000).toISOString();
  const tok = ['cprt', 'x'.repeat(8)].join('_');
  writeToken(kv, HOST, { token: tok, expiresAt: later, actorLabel: 'Owner', bucketKey: 'KONF' });
  assert.equal(readToken(kv, 'KONF', HOST)?.token, tok);
  assert.equal(readToken(kv, 'KONF', 'https://other.example'), null);
  assert.equal(readToken(kv, 'KONF', HOST, Date.now() + 7200_000), null);
  assert.equal(readToken(kv, 'KONF', HOST), null, 'the expired token was removed');
  writeToken(kv, HOST, { token: tok, expiresAt: later, actorLabel: 'Owner', bucketKey: 'KONF' });
  clearToken(kv, 'KONF', HOST);
  assert.equal(readToken(kv, 'KONF', HOST), null);
});

test('the connect answer must carry our nonce, our bucket and a reporter token', () => {
  const tok = ['cprt', 'y'.repeat(10)].join('_');
  const msg = { type: 'pilot-reporter:connected', nonce: 'n1', token: tok, expiresAt: new Date().toISOString(), bucketKey: 'KONF', actorLabel: 'Owner' };
  assert.ok(parseConnectMessage(msg, 'n1', 'KONF'));
  assert.equal(parseConnectMessage(msg, 'n2', 'KONF'), null);
  assert.equal(parseConnectMessage(msg, 'n1', 'CP'), null);
  assert.equal(parseConnectMessage({ ...msg, token: ['ptk', 'z'.repeat(10)].join('_') }, 'n1', 'KONF'), null);
  assert.equal(parseConnectMessage({ ...msg, expiresAt: 'soon' }, 'n1', 'KONF'), null);
});

test('the client sends the bearer token, no cookies, unwraps { data } and signs out on 401', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let unauthorized = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const responses = [reply(200, { data: { key: 'KONF-9', url: '/t/KONF-9' } }), reply(401, { error: { code: 'UNAUTHORIZED', message: 'no' } })];
  const tok = ['cprt', 'q'.repeat(8)].join('_');
  const client = createClient({
    token: () => tok,
    onUnauthorized: () => unauthorized++,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift()!;
    }) as unknown as typeof fetch,
  });
  const r = await client.ticket('KONF-9');
  assert.equal((r as unknown as { key: string }).key, 'KONF-9');
  assert.equal(calls[0]!.url, '/reporter/v1/tickets/KONF-9');
  assert.equal(calls[0]!.init.credentials, 'omit');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${tok}`);
  await assert.rejects(client.me(), (e: { status: number }) => e.status === 401);
  assert.equal(unauthorized, 1);
  assert.equal(fill('/a/:id/b/:captureId', { id: 'x y', captureId: 'c/1' }), '/a/x%20y/b/c%2F1');
});

test('the Markdown subset keeps text as text and only http(s) links', () => {
  assert.deepEqual(inlineTokens('see [docs](https://x.example/a) and `<b>`'), [
    { t: 'text', v: 'see ' },
    { t: 'link', v: 'docs', href: 'https://x.example/a' },
    { t: 'text', v: ' and ' },
    { t: 'code', v: '<b>' },
  ]);
  assert.deepEqual(inlineTokens('[x](javascript:alert(1))')[0], { t: 'text', v: 'x' });
  assert.deepEqual(blocks('# Title\n\n- one\n- two\n\n```\ncode\n```\ntext <script>'), [
    { t: 'h', v: 'Title' },
    { t: 'ul', items: ['one', 'two'] },
    { t: 'pre', v: 'code' },
    { t: 'p', v: 'text <script>' },
  ]);
});
