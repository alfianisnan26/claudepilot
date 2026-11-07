// The ticket card's status pill as a control (PILOT-1200): its markup (closed, saving, the menu), the optimistic change with its rollback,
// and the client call. Rendered to markup (no browser), as the panel's other view tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_STATUSES, type ReporterTicket } from '@portal/contracts';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient, ReporterApiError, type ReporterClient } from './api';
import { PanelContext, type PanelState } from './context';
import { StatusMenu, StatusOptions, changeStatus, optimisticTicket } from './StatusMenu';
import { Row } from './TicketsTab';

const ticket = (over: Partial<ReporterTicket> = {}): ReporterTicket =>
  ({
    key: 'MEMOR-157',
    summary: 'Landing Page adjust',
    status: 'in_review',
    priority: 'normal',
    phase: 'review',
    target: { kind: 'ticket' },
    awaitingReporter: false,
    unread: 0,
    deployments: [],
    captures: [],
    ...over,
  }) as unknown as ReporterTicket;

test('status pill: the same pill (phase label and colour) as a button that opens a menu; disabled and busy while saving', () => {
  const html = renderToStaticMarkup(createElement(StatusMenu, { ticket: ticket(), saving: false, onPick: () => undefined }));
  const tag = /<button[^>]*data-status-pill[^>]*>/.exec(html)![0];
  assert.match(tag, /aria-haspopup="menu"/);
  assert.match(tag, /aria-expanded="false"/);
  assert.match(tag, /aria-label="Status: In review\. Change status"/);
  assert.match(tag, /bg-gold-soft text-gold/, 'the review colour, as before');
  assert.match(tag, /rounded-full/);
  assert.doesNotMatch(tag, / disabled=""/);
  assert.match(html, />Review</, 'the pill still says the phase');
  assert.doesNotMatch(html, /role="menu"/, 'closed until asked');

  const saving = /<button[^>]*data-status-pill[^>]*>/.exec(
    renderToStaticMarkup(createElement(StatusMenu, { ticket: ticket(), saving: true, onPick: () => undefined })),
  )![0];
  assert.match(saving, / disabled=""/);
  assert.match(saving, /aria-busy="true"/);
});

test('status menu: every status with its portal label, the current one checked, items keyboard-reachable buttons', () => {
  const html = renderToStaticMarkup(
    createElement('p', null, createElement(StatusOptions, { current: 'in_review', onPick: () => undefined })),
  );
  assert.match(html, /role="menu" aria-label="Change status"/);
  const items = [...html.matchAll(/<button[^>]*role="menuitemradio"[^>]*aria-checked="(true|false)"[^>]*>(.*?)<\/button>/g)];
  assert.equal(items.length, TICKET_STATUSES.length);
  assert.deepEqual(
    items.map((m) => />([^<>]+)<\/span>$/.exec(m[2]!)![1]),
    ['Open', 'In progress', 'Blocked', 'In review', 'Done', 'Won’t do'],
  );
  assert.deepEqual(
    items.map((m) => m[1]),
    ['false', 'false', 'false', 'true', 'false', 'false'],
  );
  assert.doesNotMatch(html, /<div/, 'nothing a <p> can not hold');
});

test('status list rows keep a read-only pill', () => {
  const panel = {
    client: {} as ReporterClient,
    coarse: false,
    capture: null,
    post: () => undefined,
    notify: () => undefined,
  } as unknown as PanelState;
  const inPanel = (el: ReactNode) => renderToStaticMarkup(createElement(PanelContext.Provider, { value: panel }, el));
  const html = inPanel(createElement('ul', null, createElement(Row, { t: ticket(), path: '/', env: 'stg', onOpen: () => undefined })));
  assert.match(html, /Review/);
  assert.doesNotMatch(html, /data-status-pill|role="menu"/);
});

test('status change: shown at once, then the server’s card; a refusal puts the card back and says why', async () => {
  const shown: ReporterTicket[] = [];
  const t = ticket({ status: 'open', phase: 'open' });
  const ok = await changeStatus(
    t,
    'in_progress',
    async (s) => ticket({ status: s, phase: 'working', updatedAt: 'server' } as Partial<ReporterTicket>),
    (v) => shown.push(v),
  );
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(
    shown.map((v) => [v.status, v.phase]),
    [
      ['in_progress', 'working'],
      ['in_progress', 'working'],
    ],
  );
  assert.equal((shown[1] as unknown as { updatedAt: string }).updatedAt, 'server', 'the server’s view wins');

  shown.length = 0;
  const bad = await changeStatus(
    t,
    'done',
    async () => {
      throw new ReporterApiError('FORBIDDEN', 'KONF-7 is read only for you.', 403);
    },
    (v) => shown.push(v),
  );
  assert.deepEqual(bad, { ok: false, error: 'KONF-7 is read only for you.' });
  assert.deepEqual(
    shown.map((v) => v.status),
    ['done', 'open'],
    'optimistic, then rolled back',
  );
  assert.equal(shown[1], t, 'the card exactly as it was');
});

test('status change: the optimistic phase follows the server’s rules for a status alone; a deployed fix stays deployed when done', () => {
  const t = ticket({ status: 'in_review', phase: 'review' });
  assert.equal(optimisticTicket(t, 'open').phase, 'open');
  assert.equal(optimisticTicket(t, 'blocked').phase, 'open');
  assert.equal(optimisticTicket(t, 'in_progress').phase, 'working');
  assert.equal(optimisticTicket(t, 'done').phase, 'fixed');
  assert.equal(optimisticTicket(t, 'wont_do').phase, 'wont-do');
  assert.equal(optimisticTicket(ticket({ status: 'done', phase: 'deployed' }), 'done').phase, 'deployed');
});

test('client: setStatus is a PATCH of the ticket with the status only, with the bearer token', async () => {
  const tok = ['cprt', 'test'].join('_');
  const calls: { url: string; init: RequestInit }[] = [];
  const c = createClient({
    token: () => tok,
    onUnauthorized: () => undefined,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: ticket({ status: 'done', phase: 'fixed' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  const v = await c.setStatus('MEMOR-157', 'done');
  assert.equal(v.status, 'done');
  assert.equal(calls[0]!.url, '/reporter/v1/tickets/MEMOR-157');
  assert.equal(calls[0]!.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { status: 'done' });
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${tok}`);
});
