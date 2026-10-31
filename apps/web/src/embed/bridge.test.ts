import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS, type ReporterEvidence, type ReporterHostMessage, type ReporterPanelMessage } from '@portal/contracts';
import { createPanelBridge, exactOrigin, parseHostMessage, type BridgeTarget, type BridgeWindow } from './bridge';

const HOST = 'https://stg.konfersi.com';

const build = { version: null, commit: 'abc1234', branch: 'stg', environment: 'stg', builtAt: null, repo: 'platform/konfersi-landing-page' };

function evidenceFixture(over: Partial<ReporterEvidence> = {}): ReporterEvidence {
  return {
    schema: 1,
    sdkVersion: '0.1.0',
    capturedAt: new Date().toISOString(),
    page: { url: `${HOST}/pricing`, origin: HOST, host: 'stg.konfersi.com', path: '/pricing', search: '', hash: '', title: 'Pricing', referrer: '', lang: 'en', route: null, historyLength: 1 },
    device: {
      userAgent: 'test',
      browser: { name: null, version: null },
      os: { name: null, version: null },
      mobile: true,
      touch: true,
      screen: { w: 390, h: 844, dpr: 3, orientation: null },
      viewport: { w: 390, h: 844 },
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null },
      timezone: null,
      locale: null,
    },
    state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: null },
    build,
    anchor: { path: '/pricing', selector: 'main > h1', relative: null, rect: { x: 10, y: 20, w: 100, h: 50 }, viewport: { w: 390, h: 844, dpr: 3 }, mode: 'crop' },
    dom: null,
    components: [],
    framework: null,
    console: [],
    network: [],
    performance: { navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null }, vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null }, longTasks: { count: 0, totalMs: 0 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
    interactions: [],
    checks: { ran: true, findings: [] },
    errorSignatures: [],
    ...over,
  };
}

/** A fake window: listeners plus a way to deliver a message as if `source` at `origin` sent it. */
function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const w: BridgeWindow & { deliver(data: unknown, origin: string, source: unknown): void; count(): number } = {
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
    deliver: (data, origin, source) => {
      for (const fn of listeners) fn({ data, origin, source } as MessageEvent);
    },
    count: () => listeners.size,
  };
  return w;
}

function fakeParent() {
  const sent: { msg: unknown; origin: string }[] = [];
  const p: BridgeTarget & { sent: typeof sent } = { sent, postMessage: (msg, origin) => void sent.push({ msg, origin }) };
  return p;
}

const hello: ReporterHostMessage = { type: 'pilot-reporter:hello', bridge: 1, sdkVersion: '0.1.0', page: { url: `${HOST}/`, title: 'Home' }, build };

test('the bridge takes messages from window.parent at the opened-for origin only', () => {
  const self = fakeWindow();
  const parent = fakeParent();
  const got: ReporterHostMessage[] = [];
  const b = createPanelBridge({ self, parent, origin: HOST, onMessage: (m) => got.push(m) });

  self.deliver(hello, HOST, parent);
  assert.equal(got.length, 1);

  // A foreign origin, even from the parent window: ignored.
  self.deliver(hello, 'https://evil.example', parent);
  // The right origin from another window (a popup, a sibling frame): ignored.
  self.deliver(hello, HOST, fakeParent());
  self.deliver(hello, HOST, null);
  assert.equal(got.length, 1);

  b.dispose();
  self.deliver(hello, HOST, parent);
  assert.equal(got.length, 1);
  assert.equal(self.count(), 0);
});

test('the bridge posts to the parent with the host origin as targetOrigin, never *', () => {
  const self = fakeWindow();
  const parent = fakeParent();
  const b = createPanelBridge({ self, parent, origin: HOST, onMessage: () => undefined });
  const msg: ReporterPanelMessage = { type: 'pilot-reporter:tray', count: 2 };
  b.post(msg);
  assert.deepEqual(parent.sent, [{ msg, origin: HOST }]);
});

test('an embed opened on its own (no parent) neither listens to nor posts anything useful', () => {
  const self = fakeWindow();
  const got: unknown[] = [];
  const b = createPanelBridge({ self, parent: null, origin: HOST, onMessage: (m) => got.push(m) });
  self.deliver(hello, HOST, null);
  b.post({ type: 'pilot-reporter:close' });
  assert.equal(got.length, 0);
});

test('a hello of another bridge major is refused', () => {
  const self = fakeWindow();
  const parent = fakeParent();
  const got: unknown[] = [];
  createPanelBridge({ self, parent, origin: HOST, onMessage: (m) => got.push(m) });
  self.deliver({ ...hello, bridge: 2 }, HOST, parent);
  assert.equal(got.length, 0);
});

test('messages that do not fit their shape are dropped', () => {
  assert.equal(parseHostMessage(null), null);
  assert.equal(parseHostMessage('pilot-reporter:hello'), null);
  assert.equal(parseHostMessage({ type: 'other:hello' }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:unknown' }), null);
  assert.equal(parseHostMessage({ ...hello, build: { commit: 5 } }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:navigated', page: { url: 1 } }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:callout-clicked', key: '', captureId: 'c' }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:focus-missing', key: 'KONF-1', captureId: null, reason: 'gone' }), null);
  assert.ok(parseHostMessage({ type: 'pilot-reporter:focus-missing', key: 'KONF-1', captureId: null, reason: 'other-page' }));
  // Only the type survives for the bare messages (no stray fields carried along).
  assert.deepEqual(parseHostMessage({ type: 'pilot-reporter:panel-opened', extra: 'x' }), { type: 'pilot-reporter:panel-opened' });
});

test('a capture result needs a real buffer within the limit, a known image type and evidence of our schema', () => {
  const ok = { type: 'pilot-reporter:capture-result', requestId: 'r1', screenshot: new ArrayBuffer(8), mediaType: 'image/png', evidence: evidenceFixture() };
  assert.ok(parseHostMessage(ok));
  assert.equal(parseHostMessage({ ...ok, screenshot: 'data:image/png;base64,AAAA' }), null);
  assert.equal(parseHostMessage({ ...ok, screenshot: new ArrayBuffer(0) }), null);
  assert.equal(parseHostMessage({ ...ok, screenshot: new ArrayBuffer(REPORTER_LIMITS.screenshotBytes + 1) }), null);
  assert.equal(parseHostMessage({ ...ok, mediaType: 'image/svg+xml' }), null);
  assert.equal(parseHostMessage({ ...ok, evidence: { ...evidenceFixture(), schema: 2 } }), null);
  assert.equal(parseHostMessage({ ...ok, evidence: { ...evidenceFixture(), console: new Array(REPORTER_LIMITS.consoleEntries + 1).fill({}) } }), null);
  assert.equal(parseHostMessage({ ...ok, evidence: { ...evidenceFixture(), anchor: { ...evidenceFixture().anchor, mode: 'zoom' } } }), null);
});

test('the capture toolbar target on capture-result and capture-started: optional, and checked like every other field', () => {
  const ok = { type: 'pilot-reporter:capture-result', requestId: 'r1', screenshot: new ArrayBuffer(8), mediaType: 'image/png', evidence: evidenceFixture() };
  const started = { type: 'pilot-reporter:capture-started', requestId: 'r2', mode: 'crop' };
  for (const base of [ok, started]) {
    assert.ok(parseHostMessage(base), 'no target: still fine (older SDK)');
    for (const target of [{ kind: 'ticket' }, { kind: 'session', sessionId: 'lead_1' }, { kind: 'session', sessionId: '' }])
      assert.deepEqual((parseHostMessage({ ...base, target }) as { target?: unknown }).target, target, JSON.stringify(target));
    for (const target of [null, 'session', { kind: 'session' }, { kind: 'session', sessionId: 'a b' }, { kind: 'session', sessionId: 'x'.repeat(81) }, { kind: 'session', sessionId: 7 }, { kind: 'ticket', sessionId: 'x' }, { kind: 'urgent' }, { kind: 'session', sessionId: 'a', extra: 1 }])
      assert.equal(parseHostMessage({ ...base, target }), null, JSON.stringify(target));
  }
});

test('the opened-for origin must be an exact http(s) origin', () => {
  assert.equal(exactOrigin(HOST), HOST);
  assert.equal(exactOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(exactOrigin(`${HOST}/`), null);
  assert.equal(exactOrigin(`${HOST}/path`), null);
  assert.equal(exactOrigin('javascript:alert(1)'), null);
  assert.equal(exactOrigin('*'), null);
  assert.equal(exactOrigin(null), null);
});
