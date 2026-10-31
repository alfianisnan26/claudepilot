// The viewer, the report form and the Context view (owner feedback 2026-10-31).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterStatus } from '@portal/contracts';
import {
  REDACTION_RULES,
  afterFiled,
  carriesRows,
  clampView,
  contextGroups,
  contextText,
  elementLabel,
  fitScale,
  fitView,
  parseChoice,
  reportProblem,
  sendButton,
  suggestTitle,
  swipeCloses,
  toggleZoom,
  zoomAt,
} from './formModel';

const img = { w: 1170, h: 2532 };
const box = { w: 390, h: 700 };

test('viewer: fit to screen, zoom about a point, pan clamped, double-tap toggles 100%', () => {
  const fit = fitView(img, box);
  assert.equal(fit.scale, fitScale(img, box));
  assert.ok(fit.scale < 1);
  assert.ok(Math.abs(fit.x - (box.w - img.w * fit.scale) / 2) < 1e-9, 'centred on the narrow axis');
  const z = zoomAt(fit, 3, { x: 195, y: 350 }, img, box);
  assert.ok(z.scale > fit.scale);
  assert.ok(z.x <= 0 && z.x >= box.w - img.w * z.scale, 'pan stays inside the image');
  assert.equal(zoomAt(fit, 0.1, { x: 0, y: 0 }, img, box).scale, fit.scale, 'never below fit');
  assert.equal(zoomAt(fit, 1000, { x: 0, y: 0 }, img, box).scale, 4, 'never above 400%');
  const hundred = toggleZoom(fit, { x: 195, y: 350 }, img, box);
  assert.equal(hundred.scale, 1);
  assert.deepEqual(toggleZoom(hundred, { x: 0, y: 0 }, img, box), fit, 'and back to fit');
  assert.deepEqual(clampView({ scale: 1, x: 500, y: 500 }, img, box), { scale: 1, x: 0, y: 0 });
  assert.equal(swipeCloses(140, 10, true), true);
  assert.equal(swipeCloses(140, 10, false), false, 'zoomed in: a drag pans');
  assert.equal(swipeCloses(140, 120, true), false, 'sideways is not a swipe down');
});

test('title suggestion: the anchored element’s label on the page title, editable', () => {
  const anchor = { selector: 'main > #hero-cta', path: '/', relative: null, rect: { x: 0, y: 0, w: 1, h: 1 }, viewport: { w: 1, h: 1, dpr: 1 }, mode: 'crop' as const };
  assert.equal(elementLabel({ dom: { selector: '#x', path: '', snippet: '<button class="cta">Book a  demo</button>' }, anchor }), 'Book a demo');
  assert.equal(elementLabel({ dom: null, anchor }), 'hero cta');
  assert.equal(elementLabel({ dom: null, anchor: { ...anchor, selector: 'main h1' } }), '', 'a bare tag says nothing');
  assert.equal(elementLabel({ dom: null, anchor: { ...anchor, selector: 'div:nth-child(3)' } }), '');
  assert.equal(suggestTitle('Pricing | Konfersi', 'Book a demo'), 'Book a demo on Pricing | Konfersi');
  assert.equal(suggestTitle('', 'Book a demo'), 'Book a demo');
  assert.equal(suggestTitle('Pricing', ''), 'Pricing');
});

const targets = [
  { sessionId: 's1', label: 'Konfersi lead' },
  { sessionId: 's2', label: 'Design lead' },
];

test('destination switch and button stay in sync: Queue files a ticket, Ask lead now sends to the chosen target (urgent)', () => {
  assert.deepEqual(sendButton({ kind: 'ticket' }, targets), { label: 'File ticket', tone: 'primary' });
  assert.deepEqual(sendButton({ kind: 'session', sessionId: 's2' }, targets), { label: 'Send to Design lead', tone: 'urgent' });
  assert.equal(sendButton({ kind: 'session', sessionId: 'gone' }, targets).label, 'Send to session');
});

test('the question is required in Session mode only; a title always', () => {
  assert.equal(reportProblem({ kind: 'ticket' }, 'Title', ''), null);
  assert.equal(reportProblem({ kind: 'session', sessionId: 's1' }, 'Title', '  '), 'Write your question.');
  assert.equal(reportProblem({ kind: 'session', sessionId: 's1' }, 'Title', 'Why?'), null);
  assert.equal(reportProblem({ kind: 'ticket' }, ' ', ''), 'Write a title.');
});

test('after sending: a direct ask opens the chat with the ticket chip (and Retry on a delivery error); a ticket shows Filed', () => {
  const shot = new Blob(['x'], { type: 'image/png' });
  assert.deepEqual(afterFiled({ kind: 'ticket' }, { key: 'KONF-3' }, '', shot), { kind: 'filed', key: 'KONF-3' });
  const ok = afterFiled({ kind: 'session', sessionId: 's1' }, { key: 'KONF-4', sessionDelivery: { error: null } }, ' Why is it cut? ', shot);
  assert.equal(ok.kind, 'chat');
  if (ok.kind !== 'chat') return;
  assert.equal(ok.open.sessionId, 's1');
  assert.equal(ok.open.ticketKey, 'KONF-4');
  assert.equal(ok.open.failed, null);
  assert.equal(ok.open.retry.text, 'Why is it cut?');
  assert.equal(ok.open.retry.image, shot);
  const bad = afterFiled({ kind: 'session', sessionId: 's1' }, { key: 'KONF-5', sessionDelivery: { error: 'session ended' } }, 'q', null);
  assert.deepEqual(bad.kind === 'chat' && bad.open.failed, { reason: 'session ended' });
});

test('the remembered destination: only a ticket or a session id comes back', () => {
  assert.deepEqual(parseChoice(JSON.stringify({ kind: 'session', sessionId: 's1' })), { kind: 'session', sessionId: 's1' });
  assert.deepEqual(parseChoice(JSON.stringify({ kind: 'ticket', extra: 1 })), { kind: 'ticket' });
  assert.equal(parseChoice('{nope'), null);
  assert.equal(parseChoice(JSON.stringify({ kind: 'session' })), null);
  assert.equal(parseChoice(null), null);
});

const status: ReporterStatus = {
  site: { origin: 'https://stg.konfersi.com', environment: 'stg', repo: 'platform/landing', label: null, branch: 'stg' },
  enabled: true,
  bucketKey: 'KONF',
  bucketName: 'Konfersi',
  calloutsDefault: true,
  sdkVersion: '0.2.0',
} as ReporterStatus;

test('context: every group has a source or says unknown; a declared repo that differs is a warning; IP and family from /me', () => {
  const groups = contextGroups({
    status,
    page: { url: 'https://stg.konfersi.com/pricing?x=1', title: 'Pricing' },
    device: null,
    build: { version: null, commit: 'a'.repeat(40), branch: 'stg', environment: 'prod', builtAt: null, repo: 'platform/landing' },
    me: { bucketKey: 'KONF', origin: 'https://stg.konfersi.com', actorLabel: 'Owner', expiresAt: '2026-11-01T00:00:00Z', clientIp: '203.0.113.7', clientIpFamily: 4 },
    actorLabel: 'Owner',
    sdkVersion: '0.2.0',
    portalRelease: null,
  });
  assert.deepEqual(groups.map((g) => g.title), ['Site', 'Page', 'Build', 'Client', 'Network', 'Session']);
  const row = (g: string, l: string) => groups.find((x) => x.title === g)!.rows.find((r) => r.label === l)!;
  assert.equal(row('Site', 'Domain').value, 'stg.konfersi.com');
  assert.equal(row('Site', 'Declared').warn, true, 'the page said prod on a stg site');
  assert.equal(row('Page', 'Path').value, '/pricing?x=1');
  assert.equal(row('Build', 'Commit').value, 'aaaaaaa');
  assert.equal(row('Build', 'Commit').copy, 'a'.repeat(40), 'copy gives the whole commit');
  assert.equal(row('Build', 'Version').value, 'unknown', 'never guessed');
  assert.match(groups.find((g) => g.title === 'Client')!.rows[0]!.value, /^unknown/);
  assert.equal(row('Network', 'IP').value, '203.0.113.7');
  assert.equal(row('Network', 'Family').value, 'IPv4');
  assert.equal(row('Session', 'Portal').value, 'unknown');
  // Behind the cluster's load balancer the portal sees a pod address: labelled, never shown as the client's public IP; the release from /me.
  const inside = contextGroups({ status, page: null, device: null, build: null, me: { bucketKey: 'KONF', origin: 'https://stg.konfersi.com', actorLabel: 'Owner', expiresAt: '2026-11-01T00:00:00Z', clientIp: '10.42.1.7', clientIpFamily: 4, portalRelease: '2026.10.31-5' }, actorLabel: 'Owner', sdkVersion: '0.2.0', portalRelease: '2026.10.31-5' });
  const ipRow = inside.find((g) => g.title === 'Network')!.rows.find((r) => r.label === 'IP')!;
  assert.equal(ipRow.value, '10.42.1.7 (internal: behind the cluster proxy)');
  assert.equal(ipRow.copy, '10.42.1.7', 'copy gives the bare address');
  assert.equal(inside.find((g) => g.title === 'Session')!.rows.find((r) => r.label === 'Portal')!.value, '2026.10.31-5');
  assert.match(contextText(groups), /Commit: a{40}/);
});

test('what a ticket carries: live counts when the SDK sends them, unknown before; the redaction rules', () => {
  assert.equal(carriesRows(null)[0]!.value, 'unknown');
  const rows = carriesRows({ console: 12, consoleErrors: 2, network: 40, networkFailed: 1, interactions: 7 });
  assert.equal(rows[0]!.value, '12 entries · 2 errors');
  assert.equal(rows[1]!.value, '40 requests · 1 failed');
  assert.equal(rows[2]!.value, '7');
  assert.ok(REDACTION_RULES.some((r) => /IP/.test(r)) && REDACTION_RULES.some((r) => /bodies/.test(r)));
});
