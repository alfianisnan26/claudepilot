// The panel's new views rendered to markup (no browser), its chat client calls, and the bridge's new message and mode (PILOT-1111).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterChatStreamLine, ReporterTicket } from '@portal/contracts';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReporterApiError, createClient, type ReporterClient } from './api';
import { captureRequest, parseHostMessage } from './bridge';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { PanelContext, type PanelState } from './context';
import { Row } from './TicketsTab';

const fakeClient = {} as ReporterClient;
const panel = (over: Partial<PanelState> = {}) => ({ client: fakeClient, coarse: false, capture: null, post: () => undefined, notify: () => undefined, ...over }) as unknown as PanelState;
const inPanel = (el: ReactNode, over: Partial<PanelState> = {}) => renderToStaticMarkup(createElement(PanelContext.Provider, { value: panel(over) }, el));

const ticket = (captures: { screenshotUrl: string | null }[]): ReporterTicket =>
  ({
    key: 'KONF-7',
    summary: 'Hero text is cut off',
    status: 'open',
    priority: 'high',
    phase: 'open',
    target: { kind: 'ticket' },
    awaitingReporter: false,
    unread: 2,
    deployments: [],
    captures: captures.map((c, i) => ({ captureId: `c${i}`, index: i + 1, pageUrl: '', anchor: { path: '/' }, note: null, createdAt: '', ...c })),
  }) as unknown as ReporterTicket;

test('row: a ticket with a screenshot gets a fixed-size lazy thumbnail; one without gets a compact text row with no placeholder', () => {
  const withShot = inPanel(createElement('ul', null, createElement(Row, { t: ticket([{ screenshotUrl: '/reporter/v1/x' }]), path: '/', env: 'stg', onOpen: () => undefined })));
  assert.match(withShot, /data-row="thumb"/);
  assert.match(withShot, /size-12 shrink-0 rounded-lg/, 'the 48 px box is there before the image loads (no layout shift)');
  const noShot = inPanel(createElement('ul', null, createElement(Row, { t: ticket([]), path: '/', env: 'stg', onOpen: () => undefined })));
  assert.match(noShot, /data-row="text"/);
  assert.doesNotMatch(noShot, /size-12|skeleton|role="img"/, 'no grey placeholder');
  for (const html of [withShot, noShot]) {
    assert.match(html, /KONF-7/);
    assert.match(html, /line-clamp-2/, 'summary on two lines');
    assert.match(html, /aria-label="2 unread"/, 'the unread dot');
  }
});

test('composer: the send button is off while the field is empty, busy or disabled, and on with text', () => {
  const html = (value: string, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(Composer, { value, onChange: () => undefined, onSend: () => undefined, placeholder: 'Reply', label: 'Reply', coarse: false, ...extra }));
  const sendTag = (h: string) => /<button[^>]*aria-label="Send"[^>]*>/.exec(h)![0];
  assert.match(sendTag(html('')), /disabled/);
  assert.doesNotMatch(sendTag(html('hello')), /disabled/);
  assert.match(sendTag(html('hello', { busy: true })), /disabled/);
  assert.match(sendTag(html('hello', { disabled: true })), /disabled/);
  assert.match(html(''), /rows="1"/, 'starts as one line');
});

test('chat view: before the session is known it shows loading and the composer is off (nothing can be sent blind)', () => {
  const html = inPanel(createElement(ChatView, { open: { sessionId: 'lead1' }, onBack: () => undefined }));
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /skeleton/);
  assert.match(/<textarea[^>]*>/.exec(html)![0], /disabled/);
});

/* ---------- The chat client ---------- */

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  // Built at runtime: never a token-shaped literal in the repo.
  const token = ['cprt', 'x'.repeat(40)].join('_');
  return { calls, client: createClient({ token: () => token, onUnauthorized: () => undefined, fetchFn }), token };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'content-type': 'application/json' } });
const session = { id: 'lead1', title: 'Lead', state: 'idle', waiting: 0, waitingFor: null, lastSeq: 9, ticketKey: null, url: '' };

test('chat client: the newest page, an older page by cursor, what came after; the bearer token on every call', async () => {
  const r = recorder(() => json({ items: [], before: null, session }));
  await r.client.chatPage('lead1', { limit: 40 });
  await r.client.chatPage('lead1', { before: 31, limit: 40 });
  await r.client.chatPage('lead1', { after: 9 });
  assert.deepEqual(
    r.calls.map((c) => c.url),
    ['/reporter/v1/sessions/lead1/messages?limit=40', '/reporter/v1/sessions/lead1/messages?before=31&limit=40', '/reporter/v1/sessions/lead1/messages?after=9'],
  );
  for (const c of r.calls) assert.equal((c.init.headers as Record<string, string>).Authorization, `Bearer ${r.token}`);
  assert.equal(r.calls[0]!.init.credentials, 'omit');
});

test('chat client: send posts the uuid, text and image as JSON', async () => {
  const r = recorder(() => json({ uuid: 'u' }, 201));
  await r.client.chatSend('lead1', { uuid: 'u', text: 'hi', image: { mediaType: 'image/png', dataBase64: 'AAAA' } });
  assert.equal(r.calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(r.calls[0]!.init.body)), { uuid: 'u', text: 'hi', image: { mediaType: 'image/png', dataBase64: 'AAAA' } });
});

test('chat client: a session outside the bucket is refused (404) and the view can tell', async () => {
  const r = recorder(() => json({ code: 'NOT_FOUND', message: 'Not found.' }, 404));
  await assert.rejects(r.client.chatPage('stranger', {}), (e: unknown) => e instanceof ReporterApiError && e.status === 404 && e.code === 'NOT_FOUND');
  const s = recorder(() => new Response('', { status: 404 }));
  await assert.rejects(
    s.client.chatStream('stranger', 0, () => undefined, new AbortController().signal),
    (e: unknown) => (e as ReporterApiError).status === 404,
  );
});

test('chat client: the live stream hands over each NDJSON line, split across chunks, in order (live append)', async () => {
  const lines: ReporterChatStreamLine[] = [
    { type: 'hello', session: session as never },
    { type: 'update', items: [{ seq: 10, at: '', kind: 'assistant', text: 'Looking', from: null, tool: null, images: [] }], session: session as never },
    { type: 'ping' },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, 25)));
      c.enqueue(enc.encode(text.slice(25)));
      c.close();
    },
  });
  const r = recorder(() => new Response(body, { status: 200 }));
  const got: ReporterChatStreamLine[] = [];
  await r.client.chatStream('lead1', 9, (l) => got.push(l), new AbortController().signal);
  assert.equal(r.calls[0]!.url, '/reporter/v1/sessions/lead1/stream?after=9');
  assert.deepEqual(got.map((l) => l.type), ['hello', 'update', 'ping']);
});

/* ---------- The bridge ---------- */

const device = {
  userAgent: 'UA',
  browser: { name: 'Safari', version: '18' },
  os: { name: 'iOS', version: '18' },
  mobile: true,
  touch: true,
  screen: { w: 390, h: 844, dpr: 3, orientation: 'portrait-primary' },
  viewport: { w: 390, h: 760 },
  hardwareConcurrency: 6,
  deviceMemoryGb: null,
  connection: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, saveData: false },
  timezone: 'Asia/Jakarta',
  locale: 'id-ID',
};
const page = { url: 'https://stg.konfersi.com/', origin: 'https://stg.konfersi.com', host: 'stg.konfersi.com', path: '/', search: '', hash: '', title: 'Home', referrer: '', lang: 'id', route: null, historyLength: 1 };
const build = { version: null, commit: null, branch: null, environment: null, builtAt: null, repo: null };
const counts = { console: 3, consoleErrors: 1, network: 10, networkFailed: 0, interactions: 4 };

test('bridge: pilot-reporter:context is taken when it fits its shape, refused when it does not', () => {
  const ok = parseHostMessage({ type: 'pilot-reporter:context', page, device, build, counts });
  assert.equal(ok?.type, 'pilot-reporter:context');
  assert.equal(parseHostMessage({ type: 'pilot-reporter:context', page, device, build, counts: { ...counts, console: -1 } }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:context', page, device: { ...device, screen: 'big' }, build, counts }), null);
  assert.equal(parseHostMessage({ type: 'pilot-reporter:context', page: { url: 1 }, device, build, counts }), null);
});

test('bridge: the viewport mode is accepted on capture-started and sent on capture-request', () => {
  assert.equal(parseHostMessage({ type: 'pilot-reporter:capture-started', requestId: 'r1', mode: 'viewport' })?.type, 'pilot-reporter:capture-started');
  assert.equal(parseHostMessage({ type: 'pilot-reporter:capture-started', requestId: 'r1', mode: 'tab' }), null);
  assert.deepEqual(captureRequest('r2', 'viewport', false), { type: 'pilot-reporter:capture-request', requestId: 'r2', mode: 'viewport', precise: false });
});
