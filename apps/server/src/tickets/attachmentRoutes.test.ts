// The attachment routes (owner, 2026-10-17): upload as the raw body with a URI-encoded name, list, download with safe headers, delete.
// Only plain image types are served inline; everything else (SVG, HTML included) downloads, never sniffed, sandboxed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { createTicketRoutes } from './routes.js';
import { ticketsHarness, UI } from './testkit.js';

async function app() {
  const h = await ticketsHarness();
  const a = new Hono();
  a.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as 400) : c.json({ error: String(e) }, 500)));
  // Signed in, as every /api route is behind requireSession (T-1098: the ticket's bucket is checked for the caller).
  a.use(async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    await next();
  });
  a.route('/api/tickets', createTicketRoutes(h.tickets));
  return { h, a };
}

const upload = (a: Hono, id: string, name: string, type: string, body: Buffer | string) =>
  a.request(`/api/tickets/${id}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': type },
    body,
  });

test('upload, list, download (inline image, download for the rest, safe headers), delete', async () => {
  const { h, a } = await app();
  try {
    const t = h.tickets.create(UI, { summary: 'route' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const r1 = await upload(a, t.id, 'layar ponsel 390 · gelap.png', 'image/png', png);
    assert.equal(r1.status, 201);
    const img = ((await r1.json()) as { data: { id: number; name: string } }).data;
    assert.equal(img.name, 'layar ponsel 390 · gelap.png', 'a non-ASCII name survives the header');
    const r2 = await upload(a, t.id, 'evil.html', 'text/html', '<script>alert(1)</script>');
    const html = ((await r2.json()) as { data: { id: number } }).data;
    const r3 = await upload(a, t.id, 'config.json', 'application/json', '{"a":1}');
    assert.equal(r3.status, 201, 'a .json goes as octet-stream with its type in x-file-type');

    const list = ((await (await a.request(`/api/tickets/${t.id}/attachments`)).json()) as { data: { name: string }[] }).data;
    assert.deepEqual(list.map((x) => x.name), ['layar ponsel 390 · gelap.png', 'evil.html', 'config.json']);

    const g1 = await a.request(`/api/tickets/${t.id}/attachments/${img.id}`);
    assert.equal(g1.headers.get('content-type'), 'image/png');
    assert.match(g1.headers.get('content-disposition') ?? '', /^inline; filename=".*"; filename\*=UTF-8''layar%20ponsel/);
    assert.deepEqual(Buffer.from(await g1.arrayBuffer()), png);
    const g2 = await a.request(`/api/tickets/${t.id}/attachments/${html.id}`);
    assert.equal(g2.headers.get('content-type'), 'application/octet-stream', 'HTML is never served as HTML');
    assert.match(g2.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(g2.headers.get('x-content-type-options'), 'nosniff');
    assert.match(g2.headers.get('content-security-policy') ?? '', /sandbox/);
    const g3 = await a.request(`/api/tickets/${t.id}/attachments/${img.id}?download`);
    assert.match(g3.headers.get('content-disposition') ?? '', /^attachment;/, '?download forces a download for an image too');

    assert.equal((await a.request(`/api/tickets/${t.id}/attachments/${html.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await a.request(`/api/tickets/${t.id}/attachments/${html.id}`)).status, 404);
    assert.equal((await a.request(`/api/tickets/${t.id}/attachments/abc`)).status, 404);
    const big = await a.request(`/api/tickets/${t.id}/attachments`, { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024), 'x-file-name': 'big.bin' }, body: 'x' });
    assert.equal(big.status, 413, 'a declared size over the limit is refused before reading');
  } finally {
    h.done();
  }
});
