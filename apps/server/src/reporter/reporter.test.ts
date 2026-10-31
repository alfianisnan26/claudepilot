// UI reporter, server side (docs/prd/ui-reporter-server.md): framing, connect, token scope, no CORS, evidence validation and redaction,
// screenshots, rate limits, sites, filing (quick path, reviews, direct to a session), the list and callouts, duplicates, and deployments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS, REPORTER_TOKEN_PREFIX } from '@portal/contracts';
import { UI } from '../tickets/testkit.js';
import { describeTicket } from './describe.js';
import { parseEvidence, redactText } from './validate.js';
import { PNG, PORTAL, REPO, STG, UAT, build, capture, evidence, reporterHarness } from './testkit.js';

type Json = { data?: any; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Json;

/* ---------- The embed page ---------- */

test('embed: framed only by an allowed origin of an enabled bucket; anything else cannot be framed', async () => {
  const h = await reporterHarness();
  try {
    const ok = await h.call(`/reporter/v1/embed?bucket=KONF&origin=${encodeURIComponent(STG)}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy') ?? '', new RegExp(`frame-ancestors ${STG.replace(/[.]/g, '\\.')}$`));
    assert.equal(ok.headers.get('x-frame-options'), null, 'no X-Frame-Options DENY on the allowed embed');
    assert.equal(ok.headers.get('access-control-allow-origin'), null);

    const refused = async (q: string, why: string) => {
      const r = await h.call(`/reporter/v1/embed?${q}`);
      assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, why);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', why);
      assert.doesNotMatch(await r.text(), /reporter panel/i, `${why}: nothing useful`);
    };
    await refused(`bucket=KONF&origin=${encodeURIComponent('https://evil.example')}`, 'an origin not on the list');
    await refused(`bucket=OTHER&origin=${encodeURIComponent(STG)}`, 'another bucket than the site’s');
    await refused(`bucket=KONF&origin=${encodeURIComponent(`${STG}/path`)}`, 'not an origin');
    h.service.updateConfig('KONF', { enabled: false }, 'test');
    await refused(`bucket=KONF&origin=${encodeURIComponent(STG)}`, 'a disabled bucket');
  } finally {
    h.done();
  }
});

test('status: the same answer for every refusal; the site and name only when allowed', async () => {
  const h = await reporterHarness();
  try {
    const ok = (await body(await h.call(`/reporter/v1/status?bucket=KONF&origin=${encodeURIComponent(STG)}`))).data;
    assert.equal(ok.enabled, true);
    assert.equal(ok.site.repo, REPO);
    assert.equal(ok.bucketName, 'Konfersi');
    const a = (await body(await h.call(`/reporter/v1/status?bucket=KONF&origin=${encodeURIComponent('https://evil.example')}`))).data;
    const b = (await body(await h.call(`/reporter/v1/status?bucket=NOPE&origin=${encodeURIComponent(STG)}`))).data;
    for (const x of [a, b]) {
      assert.equal(x.enabled, false);
      assert.equal(x.site, null);
      assert.equal(x.bucketName, '');
    }
  } finally {
    h.done();
  }
});

/* ---------- Connect ---------- */

test('connect: needs the cookie, refuses an origin not on the list, posts the token to the portal origin only, CSRF on approve', async () => {
  const h = await reporterHarness();
  try {
    const nonce = 'n'.repeat(24);
    const q = `bucket=KONF&origin=${encodeURIComponent(STG)}&nonce=${nonce}`;
    const page = await (await h.call(`/reporter/v1/connect?${q}`)).text();
    assert.match(page, /postMessage\(d,location\.origin\)/, 'the token goes to the portal’s own origin');
    assert.doesNotMatch(page, /postMessage\([^)]*['"]\*['"]/, 'never to any origin');
    const approve = (b: unknown, headers: Record<string, string> = { origin: PORTAL }) =>
      h.call('/reporter/v1/connect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });

    const ok = await approve({ bucket: 'KONF', origin: STG, nonce });
    assert.equal(ok.status, 200);
    const msg = (await body(ok)).data;
    assert.equal(msg.type, 'pilot-reporter:connected');
    assert.equal(msg.nonce, nonce);
    assert.ok(msg.token.startsWith(REPORTER_TOKEN_PREFIX));
    assert.ok(h.service.verify(msg.token), 'the minted token works');

    assert.equal((await approve({ bucket: 'KONF', origin: 'https://evil.example', nonce })).status, 404, 'an origin not on the list');
    assert.equal((await approve({ bucket: 'OTHER', origin: STG, nonce })).status, 404, 'a bucket the origin is not a site of');
    assert.equal((await approve({ bucket: 'KONF', origin: STG, nonce }, { origin: 'https://evil.example' })).status, 403, 'a cross-site approve');
    assert.equal((await approve({ bucket: 'KONF', origin: STG, nonce }, {})).status, 403, 'an approve without Origin');

    h.setSignedIn(false);
    assert.match(await (await h.call(`/reporter/v1/connect?${q}`)).text(), /Sign in first/);
    assert.equal((await approve({ bucket: 'KONF', origin: STG, nonce })).status, 401, 'no cookie, no token');
  } finally {
    h.done();
  }
});

/* ---------- Token scope ---------- */

test('token scope: other bucket, other origin, expired, revoked, origin removed, bucket off => the same 404; none => 401', async () => {
  let now = Date.now();
  const h = await reporterHarness({ now: () => new Date(now) });
  try {
    h.service.updateConfig('OTHER', { enabled: true, sites: [{ origin: 'https://other.example', environment: 'prod', repo: 'x/y', label: null, branch: null }] }, 'test');
    let t = h.mint().token;
    const me = (token: string, headers: Record<string, string> = {}) => h.call('/reporter/v1/me', { token, headers });
    assert.equal((await me(t)).status, 200);
    assert.equal((await h.call('/reporter/v1/me')).status, 401, 'no token');
    const missing = await body(await h.call('/reporter/v1/tickets/KONF-999', { token: t }));

    const same404 = async (r: Response, why: string) => {
      assert.equal(r.status, 404, why);
      assert.deepEqual(await body(r), missing, `${why}: the same body as a missing ticket`);
    };
    await same404(await me(`${REPORTER_TOKEN_PREFIX}${'x'.repeat(43)}`), 'an unknown token');
    await same404(await me(t, { 'x-reporter-bucket': 'OTHER' }), 'another bucket');
    await same404(await me(t, { 'x-reporter-origin': UAT }), 'another origin of the same bucket');
    // A ticket of another bucket is not found through this token either.
    const other = h.tickets.create(UI, { summary: 'theirs', bucket: 'OTHER' });
    await same404(await h.call(`/reporter/v1/tickets/${other.key}`, { token: t }), 'a ticket of another bucket');

    // A new connect by the same person on the same site replaces (revokes) the older token.
    const revoked = h.mint().token;
    await same404(await me(t), 'replaced by a newer connect');
    h.service.revoke(h.service.verify(revoked)!.id, 'test');
    await same404(await me(revoked), 'revoked');
    t = h.mint().token;

    h.service.updateConfig('KONF', { sites: [{ origin: UAT, environment: 'uat', repo: REPO, label: null, branch: null }] }, 'test');
    await same404(await me(t), 'its origin removed from the config');
    h.service.updateConfig('KONF', { sites: [{ origin: STG, environment: 'stg', repo: REPO, label: null, branch: null }] }, 'test');
    assert.equal((await me(t)).status, 200, 'back when the site is back');
    h.service.updateConfig('KONF', { enabled: false }, 'test');
    await same404(await me(t), 'the bucket switched off');
    h.service.updateConfig('KONF', { enabled: true }, 'test');

    now += REPORTER_LIMITS.tokenHours * 3600_000 + 1000;
    await same404(await me(t), 'expired');
  } finally {
    h.done();
  }
});

test('the panel API sets no CORS header, answers no preflight, and refuses a cross-site caller', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const r = await h.call('/reporter/v1/tickets', { token: t });
    assert.equal(r.status, 200);
    for (const [k] of r.headers) assert.ok(!k.startsWith('access-control-'), `no ${k}`);
    const pre = await h.call('/reporter/v1/tickets', { method: 'OPTIONS', headers: { origin: STG, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal((await h.call('/reporter/v1/tickets', { token: t, headers: { origin: STG } })).status, 404, 'a page of another origin');
    assert.equal((await h.call('/reporter/v1/tickets', { token: t, headers: { 'sec-fetch-site': 'cross-site' } })).status, 404);
    // The public script answers Chrome's private-network preflight; the panel API never does.
    const pna = await h.call('/reporter/v1/reporter.js', { method: 'OPTIONS', headers: { origin: STG, 'access-control-request-private-network': 'true' } });
    assert.equal(pna.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    h.done();
  }
});

/* ---------- Sites ---------- */

test('sites: an origin belongs to one bucket (409), and bad sites are refused', async () => {
  const h = await reporterHarness();
  try {
    assert.throws(() => h.service.updateConfig('OTHER', { sites: [{ origin: STG, environment: 'stg', repo: 'a/b', label: null, branch: null }] }, 't'), (e: any) => e.code === 'CONFLICT' && e.status === 409);
    const put = (sites: unknown) => h.call('/api/reporter/buckets/OTHER/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sites }) });
    assert.equal((await put([{ origin: STG, environment: 'stg', repo: 'a/b' }])).status, 409);
    for (const bad of [{ origin: 'https://*.konfersi.com', environment: 'stg', repo: 'a/b' }, { origin: 'https://x.example', environment: 'STAGING ENV', repo: 'a/b' }, { origin: 'https://x.example', environment: 'stg', repo: 'nope' }])
      assert.equal((await put([bad])).status, 422, JSON.stringify(bad));
    assert.equal((await put([{ origin: 'https://X.Example/', environment: 'prod', repo: 'a/b' }])).status, 200);
    assert.equal(h.service.config('OTHER').sites[0]!.origin, 'https://x.example');
  } finally {
    h.done();
  }
});

/* ---------- Evidence and screenshots ---------- */

test('evidence: a wrong schema, a list over its cap or a wrong shape is refused; values are masked and redacted', async () => {
  assert.throws(() => parseEvidence(Buffer.from(JSON.stringify(evidence({ schema: 2 })))), /schema/);
  assert.throws(() => parseEvidence(Buffer.from(JSON.stringify(evidence({ console: Array.from({ length: REPORTER_LIMITS.consoleEntries + 1 }, (_, i) => ({ ts: i, level: 'log', text: 'x' })) })))), /more than/);
  assert.throws(() => parseEvidence(Buffer.from('not json')), /JSON/);
  assert.throws(() => parseEvidence(Buffer.alloc(REPORTER_LIMITS.evidenceBytes + 1, 32)), /larger/);
  // Credential shapes built at runtime (never a literal in the repo).
  const jwt = ['eyJ' + 'h'.repeat(12), 'p'.repeat(20), 's'.repeat(20)].join('.');
  const gh = 'ghp_' + 'A1b2C3d4'.repeat(5);
  const portal = 'cpat_' + 'Z9y8X7w6'.repeat(4);
  const e = parseEvidence(
    Buffer.from(
      JSON.stringify(
        evidence({
          console: [{ ts: 1, level: 'error', text: `auth failed for ${jwt} with ${gh} and ${portal}` }],
          network: [{ ts: 1, method: 'post', url: `${STG}/api/login?token=${'q'.repeat(30)}&next=/`, status: 401, durationMs: 1, initiator: 'fetch', sizeBytes: null }],
          state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: { user: 'a', authToken: 'secretvalue123', nested: { note: `has ${gh}` } } },
        }),
      ),
    ),
  );
  const text = e.console[0]!.text;
  for (const s of [jwt, gh, portal]) assert.ok(!text.includes(s), 'a credential shape is redacted');
  assert.match(text, /\[redacted\]/);
  assert.ok(!e.network[0]!.url.includes('qqqq'), 'query values are redacted');
  assert.match(e.network[0]!.url, /token=\[redacted\]/);
  assert.equal(e.network[0]!.method, 'POST');
  assert.equal((e.state.app as any).authToken, '[redacted]');
  assert.ok(!JSON.stringify(e.state.app).includes(gh));
  assert.equal(e.interactions.find((i) => i.kind === 'input')!.value, '[masked]', 'an input value is never kept');
  assert.equal(redactText(`Bearer ${'k'.repeat(30)}`).includes('k'.repeat(30)), false);
  const cprt = REPORTER_TOKEN_PREFIX + 'R'.repeat(43);
  assert.equal(redactText(`token ${cprt}`).includes(cprt), false, 'the reporter’s own token shape is redacted');
});

test('screenshots: only PNG, JPEG or WebP by their magic bytes, within the size cap', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const c = capture();
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Hero cut off', description: 'The hero text is cut.', captures: [c], build: build(), sdkVersion: '1.0.0' }))).data;
    const up = (bytes: Buffer, kind = 'screenshot', type = 'image/png') =>
      h.call(`/reporter/v1/tickets/${made.key}/attachments`, { method: 'POST', token: t, headers: { 'content-type': type, 'x-reporter-capture': c.captureId, 'x-reporter-kind': kind }, body: bytes });
    assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'screenshot', 'image/png')).status, 422, 'an SVG named png');
    assert.equal((await up(Buffer.from('GIF89a' + 'x'.repeat(20)), 'screenshot', 'image/gif')).status, 422, 'a GIF');
    assert.equal((await up(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10)]), 'screenshot', 'image/png')).status, 422, 'a JPEG that says PNG');
    assert.equal((await up(Buffer.alloc(REPORTER_LIMITS.screenshotBytes + 1, 0x89), 'screenshot')).status, 413);
    assert.equal((await up(PNG())).status, 201);
    assert.equal((await up(PNG())).status, 409, 'once per capture');
    const shot = await h.call(`/reporter/v1/tickets/${made.key}/captures/${c.captureId}/screenshot`, { token: t });
    assert.equal(shot.headers.get('content-type'), 'image/png');
    assert.match(shot.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal((await up(Buffer.from(JSON.stringify(evidence({ schema: 9 }))), 'evidence', 'application/json')).status, 422, 'evidence of another schema');
    assert.equal((await up(Buffer.from(JSON.stringify(evidence())), 'evidence', 'application/json')).status, 201);
  } finally {
    h.done();
  }
});

/* ---------- Filing ---------- */

test('quick path: a ticket from the site record, a description agents can act on, repro attached, mismatch shown', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const c = capture('/pricing', 120);
    const declared = { ...build('b'.repeat(40)), repo: 'someone/else', environment: 'prod' };
    const r = await h.postJson('/reporter/v1/tickets', t, { summary: 'Hero cut off', description: 'The hero text is cut on my phone.', captures: [c], build: declared, sdkVersion: '1.0.0', tags: ['landing'] });
    assert.equal(r.status, 201);
    const made = (await body(r)).data;
    assert.equal(made.type, 'bug');
    assert.equal(made.site.repo, REPO, 'the site record decides the repo');
    assert.equal(made.site.environment, 'stg');
    assert.deepEqual(made.site.declaredMismatch, { repo: 'someone/else', environment: 'prod' });
    assert.equal(made.captures[0].pageUrl, `${STG}/pricing?ref=[redacted]`, 'query values redacted');
    await h.call(`/reporter/v1/tickets/${made.key}/attachments`, { method: 'POST', token: t, headers: { 'content-type': 'image/png', 'x-reporter-capture': c.captureId, 'x-reporter-kind': 'screenshot' }, body: PNG() });
    await h.call(`/reporter/v1/tickets/${made.key}/attachments`, { method: 'POST', token: t, headers: { 'content-type': 'application/json', 'x-reporter-capture': c.captureId, 'x-reporter-kind': 'evidence' }, body: Buffer.from(JSON.stringify(evidence())) });
    const d = h.tickets.get(UI, made.key).ticket;
    assert.ok(d.tags.includes('ui-report') && d.tags.includes('landing'));
    assert.equal(d.reporter.label, `Reporter: ${STG}`);
    assert.equal(d.reporter.kind, 'token');
    for (const s of ['The hero text is cut on my phone.', STG, 'stg.konfersi.com', '/pricing', 'b'.repeat(40), REPO, 'Safari', 'iOS', 'Console errors: 1', 'failed requests: 1', '1800 ms', 'Steps to reproduce', 'Warning: the page declared'])
      assert.ok(d.description.includes(s), `the description says ${s}`);
    assert.ok(!d.description.includes('someone@example.com'), 'never an input value');
    const files = h.tickets.attachments(UI, made.key).map((a) => a.name);
    assert.deepEqual(files.sort(), [`${c.captureId}.evidence.json`, `${c.captureId}.png`, 'repro.spec.ts'].sort());
    const view = (await body(await h.call(`/reporter/v1/tickets/${made.key}`, { token: t }))).data;
    assert.equal(view.checkCounts.serious, 1);
    assert.ok(view.repro.playwright.includes("viewport: { width: 390, height: 844 }"));
    assert.ok(view.repro.steps.some((s: string) => s.includes('Pricing')));
  } finally {
    h.done();
  }
});

test('rate limit: a token files at most ticketsPerHour tickets an hour', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    for (let i = 0; i < REPORTER_LIMITS.ticketsPerHour; i++)
      assert.equal((await h.postJson('/reporter/v1/tickets', t, { summary: `n${i}`, captures: [capture()], build: build(), sdkVersion: '1' })).status, 201);
    const r = await h.postJson('/reporter/v1/tickets', t, { summary: 'one more', captures: [capture()], build: build(), sdkVersion: '1' });
    assert.equal(r.status, 429);
  } finally {
    h.done();
  }
});

test('captures on another origin are refused', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const r = await h.postJson('/reporter/v1/tickets', t, { summary: 'x', captures: [capture('/a', 0, null, 'https://evil.example')], build: build(), sdkVersion: '1' });
    assert.equal(r.status, 422);
  } finally {
    h.done();
  }
});

/* ---------- Direct to a session ---------- */

test('direct to a session: an urgent ticket assigned to it, then the report in its chat with the screenshot; a failure keeps the ticket', async () => {
  const h = await reporterHarness();
  try {
    h.sessions.add({ id: 'lead1', workspaceId: 'docker/konf' });
    h.chat.add('lead1', 'idle');
    h.service.updateConfig('KONF', { sessionTargets: [{ sessionId: 'lead1', label: 'Konfersi lead' }] }, 't');
    const t = h.mint().token;
    assert.equal((await h.postJson('/reporter/v1/tickets', t, { summary: 'x', captures: [capture()], build: build(), sdkVersion: '1', target: { kind: 'session', sessionId: 'nope' } })).status, 422, 'not a target');
    const c = capture();
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Checkout broken', captures: [c], build: build(), sdkVersion: '1', target: { kind: 'session', sessionId: 'lead1' } }))).data;
    assert.equal(made.priority, 'urgent');
    assert.equal(made.target.kind, 'session');
    const d = h.tickets.get(UI, made.key).ticket;
    assert.ok(d.tags.includes('ui-urgent'));
    assert.deepEqual(d.assignee, { kind: 'session', sessionId: 'lead1' });
    assert.equal(h.chat.sent.length, 0, 'waits for the files');
    const up = (kind: string, b: Buffer, type: string) => h.call(`/reporter/v1/tickets/${made.key}/attachments`, { method: 'POST', token: t, headers: { 'content-type': type, 'x-reporter-capture': c.captureId, 'x-reporter-kind': kind }, body: b });
    await up('screenshot', PNG(), 'image/png');
    await up('evidence', Buffer.from(JSON.stringify(evidence())), 'application/json');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.chat.sent.length, 1);
    const m = h.chat.sent[0]!;
    assert.equal(m.id, 'lead1');
    assert.equal(m.opts.actor, `ticket:${d.id}`);
    assert.match(m.text, new RegExp(made.key));
    assert.match(m.text, /Reply on the ticket/);
    assert.equal((m.opts.attachments as any[]).length, 1);

    h.chat.fail = new Error('session is moving');
    const c2 = capture();
    const made2 = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Second', captures: [c2], build: build(), sdkVersion: '1', target: { kind: 'session', sessionId: 'lead1' } }))).data;
    await h.service.deliver(h.tickets.get(UI, made2.key).ticket.number);
    const v = (await body(await h.call(`/reporter/v1/tickets/${made2.key}`, { token: t }))).data;
    assert.equal(v.target.status, 'delivery-failed');
    assert.ok(h.tickets.get(UI, made2.key).events.some((e) => e.kind === 'comment' && /failed/.test(e.body ?? '')), 'the ticket says so');
  } finally {
    h.done();
  }
});

/* ---------- Reviews ---------- */

test('review: a private draft, comments across pages, submitted per page in one transaction; a failure creates nothing', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const rv = (await body(await h.postJson('/reporter/v1/reviews', t, { title: 'Landing pass', build: build(), sdkVersion: '1' }))).data;
    const add = (path: string, text: string) => h.postJson(`/reporter/v1/reviews/${rv.id}/comments`, t, { capture: capture(path), body: text });
    await add('/', 'Logo blurry');
    await add('/pricing', 'Price wraps');
    const last = (await body(await add('/pricing', 'Button small'))).data;
    assert.equal(last.comments.length, 3);
    // Reorder: the last comment first.
    const moved = (await body(await h.call(`/reporter/v1/reviews/${rv.id}/comments/${last.comments[2].captureId}`, { method: 'PATCH', token: t, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 1 }) }))).data;
    assert.deepEqual(moved.comments.map((c: any) => c.body), ['Button small', 'Logo blurry', 'Price wraps']);
    await h.call(`/reporter/v1/reviews/${rv.id}/attachments`, { method: 'POST', token: t, headers: { 'content-type': 'image/png', 'x-reporter-capture': moved.comments[0].captureId, 'x-reporter-kind': 'screenshot' }, body: PNG() });
    // Pending callouts on /pricing for the author.
    const callouts = (await body(await h.call('/reporter/v1/tickets?as=callouts&path=/pricing', { token: t }))).data.callouts;
    assert.equal(callouts.filter((c: any) => c.pending).length, 2);
    assert.equal(h.tickets.list(UI, { bucket: 'KONF' }).items.length, 0, 'a draft is not a ticket');

    // A failure in the middle of the submit creates nothing.
    const create = h.tickets.create.bind(h.tickets);
    let calls = 0;
    h.tickets.create = ((...a: Parameters<typeof create>) => {
      if (++calls === 2) throw new Error('boom');
      return create(...a);
    }) as typeof create;
    const failed = await h.postJson(`/reporter/v1/reviews/${rv.id}/submit`, t, { summary: 'Landing pass', description: 'Overall: rough.', mode: 'per-page' });
    assert.equal(failed.status, 500);
    h.tickets.create = create;
    assert.equal(h.service.listTickets(h.service.verify(t)!, { status: 'all' }, PORTAL).items.length, 0, 'nothing was created');
    assert.equal((await body(await h.call(`/reporter/v1/reviews/${rv.id}`, { token: t }))).data.status, 'draft');

    const ok = (await body(await h.postJson(`/reporter/v1/reviews/${rv.id}/submit`, t, { summary: 'Landing pass', description: 'Overall: rough.', mode: 'per-page' }))).data;
    assert.equal(ok.ticketKeys.length, 2, 'one ticket per page');
    const pricing = h.tickets.get(UI, ok.ticketKeys.find((k: string) => h.tickets.get(UI, k).ticket.summary.includes('/pricing'))).ticket;
    assert.ok(pricing.description.startsWith('Overall: rough.'), 'the overall comment on top');
    assert.ok(pricing.description.includes('Button small') && pricing.description.includes('Price wraps'));
    assert.equal(h.tickets.attachments(UI, pricing.id).filter((a) => a.mediaType === 'image/png').length, 1, 'the screenshot moved to its ticket');
    assert.equal((await h.call(`/reporter/v1/reviews/${rv.id}/comments/${last.comments[0].captureId}`, { method: 'DELETE', token: t })).status, 409, 'a submitted review is closed');

    // Another person's (or another bucket's) review does not exist for this token.
    const other = h.mint(UAT).token;
    assert.equal((await h.call(`/reporter/v1/reviews/${rv.id}`, { token: other })).status, 200, 'the same person from another site of the bucket sees it');
  } finally {
    h.done();
  }
});

/* ---------- The list, callouts and duplicates ---------- */

test('list: this page by position, same repo across environments only, counts; callouts per capture', async () => {
  const h = await reporterHarness();
  try {
    h.service.updateConfig('KONF', { sites: [{ origin: STG, environment: 'stg', repo: REPO, label: null, branch: null }, { origin: UAT, environment: 'uat', repo: REPO, label: null, branch: null }, { origin: 'https://docs.konfersi.com', environment: 'prod', repo: 'platform/docs', label: null, branch: null }] }, 't');
    const stg = h.mint().token;
    const uat = h.mint(UAT).token;
    const docs = h.mint('https://docs.konfersi.com').token;
    const file = (token: string, origin: string, summary: string, y: number, priority = 'normal') =>
      h.postJson('/reporter/v1/tickets', token, { summary, captures: [capture('/pricing', y, null, origin)], build: build(), sdkVersion: '1', priority });
    await file(stg, STG, 'low on page', 900);
    await file(uat, UAT, 'top on uat', 50, 'high');
    await file(docs, 'https://docs.konfersi.com', 'docs repo', 10);
    const list = (await body(await h.call('/reporter/v1/tickets?path=/pricing&sort=position', { token: stg }))).data;
    assert.deepEqual(list.items.map((t: any) => t.summary), ['top on uat', 'low on page'], 'top to bottom, the same repo from both environments, not the docs repo');
    assert.equal(list.items[0].site.environment, 'uat', 'reported on uat');
    assert.equal(list.counts.onPath, 2);
    const all = (await body(await h.call('/reporter/v1/tickets?status=all&priority=high', { token: stg }))).data;
    assert.deepEqual(all.items.map((t: any) => t.summary), ['top on uat']);
    assert.equal(all.counts.priority.normal, 2, 'counts before the priority filter');
    const callouts = (await body(await h.call('/reporter/v1/tickets?as=callouts&path=/pricing', { token: stg }))).data.callouts;
    assert.equal(callouts.length, 2);
    assert.equal(callouts[0].reportedOn.environment, 'uat');
    assert.equal(callouts[0].deployment.environment, 'stg', 'this environment’s state');
  } finally {
    h.done();
  }
});

test('duplicates: same area, same element, same error, open tickets of this repo only', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const c = capture('/pricing', 100, '#hero');
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Hero', captures: [c], build: build(), sdkVersion: '1' }))).data;
    await h.call(`/reporter/v1/tickets/${made.key}/attachments`, { method: 'POST', token: t, headers: { 'content-type': 'application/json', 'x-reporter-capture': c.captureId, 'x-reporter-kind': 'evidence' }, body: Buffer.from(JSON.stringify(evidence())) });
    const q = (over: object) => h.postJson('/reporter/v1/duplicates', t, { path: '/pricing', anchor: { ...c.anchor, selector: null }, errorSignatures: [], ...over });
    const area = (await body(await q({}))).data.candidates;
    assert.equal(area[0].key, made.key);
    assert.deepEqual(area[0].reasons, ['same-area']);
    const err = (await body(await q({ path: '/other', anchor: { ...c.anchor, path: '/other', rect: { x: 0, y: 5000, w: 1, h: 1 } }, errorSignatures: ['TypeError: x is undefined @ app.js:hero'] }))).data.candidates;
    assert.deepEqual(err[0].reasons, ['same-error']);
    const none = (await body(await q({ anchor: { ...c.anchor, selector: null, rect: { x: 0, y: 5000, w: 10, h: 10 } } }))).data.candidates;
    assert.equal(none.length, 0);
  } finally {
    h.done();
  }
});

/* ---------- Replies ---------- */

test('replies: the thread, a reply labelled with the person and origin, unread and awaiting badges', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Q', captures: [capture()], build: build(), sdkVersion: '1' }))).data;
    h.tickets.comment(UI, made.key, 'Which browser?');
    let v = (await body(await h.call(`/reporter/v1/tickets/${made.key}`, { token: t }))).data;
    assert.equal(v.unread, 1);
    assert.equal(v.awaitingReporter, true);
    const thread = (await body(await h.call(`/reporter/v1/tickets/${made.key}/comments`, { token: t }))).data;
    assert.equal(thread[0].body, 'Which browser?');
    v = (await body(await h.call(`/reporter/v1/tickets/${made.key}`, { token: t }))).data;
    assert.equal(v.unread, 0, 'opening the thread marks it read');
    const r = (await body(await h.postJson(`/reporter/v1/tickets/${made.key}/comments`, t, { body: 'Safari on iOS' }))).data;
    assert.equal(r.author, 'You');
    const ev = h.tickets.get(UI, made.key).events.filter((e) => e.kind === 'comment').at(-1)!;
    assert.equal(ev.actorLabel, `Owner (reporter, ${STG})`);
    v = (await body(await h.call(`/reporter/v1/tickets/${made.key}`, { token: t }))).data;
    assert.equal(v.awaitingReporter, false);
  } finally {
    h.done();
  }
});

/* ---------- Deployments ---------- */

test('deployments: deployed by ancestry, not deployed, unknown with the reason, two environments of one repo, never the page’s claim', async () => {
  const h = await reporterHarness();
  try {
    const stg = h.mint().token;
    const ctx = h.service.verify(stg)!;
    const made = (await body(await h.postJson('/reporter/v1/tickets', stg, { summary: 'Fix me', captures: [capture()], build: build(), sdkVersion: '1' }))).data;
    const n = h.tickets.get(UI, made.key).ticket.number;
    const states = () => Object.fromEntries(h.service.deploymentStates(n, 'KONF', REPO).map((s) => [s.environment, s]));
    assert.equal(states().stg!.reason, 'no-fix-commit');
    const fix = 'f'.repeat(40);
    const live1 = '1'.repeat(40);
    const live2 = '2'.repeat(40);
    h.service.addFixCommit(`T-${n}`, fix, 'close');
    await h.service.refreshTicket(n);
    assert.equal(states().stg!.reason, 'no-build-seen');

    // The widget on stg posts the page's build: recorded for the SITE (stg), even though the page claims prod; the checkout has live1, so it
    // is a verified observed build (no pipeline yet).
    h.git.commits = new Set([live1]);
    await h.postJson('/reporter/v1/observed-build', stg, { build: { ...build(live1), environment: 'prod', repo: 'other/repo' } });
    assert.equal(h.service.currentDeployment('KONF', REPO, 'stg')!.commit, live1);
    assert.equal(h.service.currentDeployment('KONF', REPO, 'stg')!.confidence, 'observed');
    assert.equal(h.service.currentDeployment('KONF', 'other/repo', 'prod'), null);

    // Ancestry cannot be checked yet: unknown, never a guess.
    await h.service.refreshTicket(n);
    assert.deepEqual([states().stg!.status, states().stg!.reason], ['unknown', 'ancestry-unchecked']);
    // Git says the fix is in live1 on stg; uat runs live2, which git says does not contain it.
    h.git.ancestry.set(`${fix}>${live1}`, true);
    h.git.ancestry.set(`${fix}>${live2}`, false);
    h.service.recordDeployment({ bucketKey: 'KONF', repo: REPO, environment: 'uat', commit: live2, source: 'pipeline', via: 'ci' });
    await h.service.refreshTicket(n);
    assert.equal(states().stg!.status, 'deployed');
    assert.equal(states().stg!.fixCommit, fix);
    assert.equal(states().uat!.status, 'not-deployed');
    // The panel on stg sees "deployed" only once the ticket is done; the description footer says it per environment.
    h.tickets.close(UI, made.key, { summary: 'fixed' });
    const v = h.service.ticket(ctx, made.key, PORTAL);
    assert.equal(v.phase, 'deployed');
    assert.equal(v.deployments.length, 2);
    assert.match(h.tickets.get(UI, made.key).ticket.description, /stg deployed \(fffffff\) \(observed by the widget, no pipeline yet\) · uat not deployed/);
    // A new live commit on uat that IS the fix: deployed without git.
    h.service.recordDeployment({ bucketKey: 'KONF', repo: REPO, environment: 'uat', commit: fix, source: 'pipeline', via: 'ci' });
    assert.equal(states().uat!.status, 'deployed');
    // A trailer git finds is a fix commit too.
    h.git.trailers.set(made.key, ['e'.repeat(40)]);
    await h.service.refreshTicket(n);
    assert.ok(h.service.ticket(ctx, made.key, PORTAL).fixCommits.includes('e'.repeat(40)));
  } finally {
    h.done();
  }
});

test('POST /api/reporter/deployments: a Portal MCP token on a bucket that serves the repo and environment', async () => {
  const h = await reporterHarness();
  try {
    const secret = 'cpat_' + 'T'.repeat(30);
    h.portalTokens.set(secret, { actor: { kind: 'token', userId: 'u_owner', tokenId: 'pt1', scope: 'operate' }, label: 'stg pipeline' });
    const post = (b: unknown, auth = `Bearer ${secret}`) => h.call('/api/reporter/deployments', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(b) });
    assert.equal((await post({ repo: REPO, environment: 'stg', commit: 'c'.repeat(40) }, '')).status, 401);
    assert.equal((await post({ repo: 'not/served', environment: 'stg', commit: 'c'.repeat(40) })).status, 404);
    const ok = await post({ repo: REPO, environment: 'stg', commit: 'c'.repeat(40), branch: 'stg' });
    assert.equal(ok.status, 201);
    assert.equal((await body(ok)).data.via, 'stg pipeline');
    assert.equal((await post({ repo: REPO, environment: 'stg', commit: 'not-a-sha' })).status, 422);
    const list = (await body(await h.call('/api/reporter/deployments?bucket=KONF'))).data;
    assert.equal(list[0].commit, 'c'.repeat(40));
  } finally {
    h.done();
  }
});

test('describe: the footer and every untrusted line render as text', () => {
  const text = describeTicket({
    text: 'Broken',
    site: { bucketKey: 'KONF', origin: STG, environment: 'stg', repo: REPO, declaredMismatch: null },
    build: build(),
    sdkVersion: '1',
    target: { kind: 'ticket' },
    captures: [{ captureId: 'c1', index: 1, pageUrl: `${STG}/x`, path: '/x`](javascript:alert(1))', note: '[click](javascript:alert(1))', evidence: null, screenshotAttachmentId: null, evidenceAttachmentId: null }],
    ticketId: 'T-1',
    deployments: [],
    fixCommits: [],
  });
  assert.ok(!text.includes('[click](javascript'), 'a note cannot become a link');
  assert.match(text, /<!-- reporter:deployments -->/);
});

test('events: a streamed line when the bucket changes; the stream ends when the token is revoked', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const res = await h.call('/reporter/v1/events', { token: t });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /ndjson/);
    const reader = res.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    assert.match(await next(), /"hello"/);
    await h.postJson('/reporter/v1/tickets', t, { summary: 'change', captures: [capture()], build: build(), sdkVersion: '1' });
    assert.match(await next(), /"changed"/);
    h.service.revoke(h.service.verify(t)!.id, 'test');
    const end = await reader.read();
    assert.equal(end.done, true, 'a revoked token ends its stream');
  } finally {
    h.done();
  }
});
