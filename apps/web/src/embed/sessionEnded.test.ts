// Session ended (live bug 2026-10-31): a revoked token made every panel call the uniform 404 and the panel printed "Not found." on every tab.
// Now a refusal of the token signs the panel out to Connect with "Session ended. Connect again."; a real missing object stays a 404 in its view.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient, type ReporterClient } from './api';
import { Connect } from './Panel';

const json = (status: number) => new Response(JSON.stringify(status < 400 ? { data: {} } : { error: { code: 'NOT_FOUND', message: 'Not found.' } }), { status, headers: { 'content-type': 'application/json' } });
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(answer: (path: string) => number, token: string | null = ['cprt', 'z'.repeat(40)].join('_')) {
  const seen: string[] = [];
  let ended = 0;
  const fetchFn = (async (url: string) => {
    const path = url.split('?')[0]!;
    seen.push(path);
    return json(answer(path));
  }) as unknown as typeof fetch;
  const client = createClient({ token: () => token, onUnauthorized: () => ended++, fetchFn });
  return { client, seen, ended: () => ended };
}

test('a 404 on a token call, confirmed by /me, ends the session (once, however many calls failed)', async () => {
  const h = harness(() => 404);
  await Promise.allSettled([h.client.tickets({}), h.client.sessions(), h.client.ticket('KONF-1')]);
  await settle();
  await settle();
  assert.equal(h.ended(), 1);
  assert.equal(h.seen.filter((p) => p === '/reporter/v1/me').length, 1, 'one /me check, not one per failed call');
});

test('a 404 while /me answers is the object missing: the session stays, the view gets the 404', async () => {
  const h = harness((p) => (p === '/reporter/v1/me' ? 200 : 404));
  await assert.rejects(h.client.ticket('KONF-404'), (e: unknown) => (e as { status: number }).status === 404);
  await settle();
  await settle();
  assert.equal(h.ended(), 0);
});

test('/me refused, or any 401, ends the session at once; status and the connect claim never do', async () => {
  const me = harness(() => 404);
  await me.client.me().catch(() => undefined);
  assert.equal(me.ended(), 1);
  const unauth = harness(() => 401);
  await unauth.client.tickets({}).catch(() => undefined);
  assert.ok(unauth.ended() >= 1);
  const pub = harness(() => 404);
  await pub.client.status('KONF', 'https://stg.konfersi.com').catch(() => undefined);
  await pub.client.claimConnect('KONF', 'https://stg.konfersi.com', 'v'.repeat(43)).catch(() => undefined);
  await settle();
  assert.equal(pub.ended(), 0);
  const none = harness(() => 404, null);
  await none.client.tickets({}).catch(() => undefined);
  await settle();
  assert.equal(none.ended(), 0, 'no token, nothing to end');
});

test('Connect after a session ended says so in one line, and never prints "Not found."', () => {
  const html = renderToStaticMarkup(
    createElement(Connect, { client: {} as ReporterClient, bucket: 'KONF', origin: 'https://stg.konfersi.com', bucketName: 'Konfersi', onConnected: () => undefined, note: 'Session ended. Connect again.' }),
  );
  assert.match(html, /Session ended\. Connect again\./);
  assert.doesNotMatch(html, /Not found/);
  const fresh = renderToStaticMarkup(createElement(Connect, { client: {} as ReporterClient, bucket: 'KONF', origin: 'https://stg.konfersi.com', bucketName: 'Konfersi', onConnected: () => undefined }));
  assert.doesNotMatch(fresh, /Session ended/);
});
