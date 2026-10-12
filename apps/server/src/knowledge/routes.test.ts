import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { tempDirectory } from '../store/testTmp.js';
import { fixtureZip } from './fixtures.js';
import { createKnowledgeRoutes } from './routes.js';
import { KnowledgeService } from './service.js';
import { harness } from './testkit.js';

const h = await harness({ limits: { attachmentBytes: 1000, importPackedBytes: 200_000 } });
after(() => h.close());
const svc = new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), backupsDir: join(h.dir, 'backups'), limits: h.limits, now: () => h.clock.now });
const app = new Hono();
// The same error envelope the portal's app uses.
app.onError((e, c) => {
  const err = isAppError(e) ? e : null;
  if (!err) throw e;
  return c.json(err.toJSON(), err.status as ContentfulStatusCode);
});
app.route('/api/knowledge', createKnowledgeRoutes(svc));

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const isBuf = body instanceof Uint8Array;
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: isBuf ? headers : body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : isBuf ? (body as Uint8Array) : JSON.stringify(body),
  });
  return res;
};
const json = async (res: Response) => (await res.json()) as { data?: any; error?: { code: string; message: string; details?: any } };

test('vaults over HTTP: create, list, update, summary, delete', async () => {
  const created = await call('POST', '/vaults', { name: 'HTTP vault' });
  assert.equal(created.status, 201);
  const v = (await json(created)).data;
  assert.equal(v.name, 'HTTP vault');
  assert.equal((await json(await call('GET', '/vaults'))).data.length, 1);
  assert.equal((await json(await call('PATCH', `/vaults/${v.id}`, { agents: 'read' }))).data.agents, 'read');
  assert.equal((await call('GET', '/vaults/nope')).status, 404);
  assert.equal((await call('POST', '/vaults', { name: 'http vault' })).status, 409);
  assert.equal((await call('POST', '/vaults', { name: '' })).status, 422);
  const bad = await call('POST', '/vaults', undefined);
  assert.equal(bad.status, 400);
  assert.equal((await call('DELETE', `/vaults/${v.id}`, { name: 'wrong' })).status, 422);
  assert.equal((await call('DELETE', `/vaults/${v.id}`, { name: 'HTTP vault' })).status, 200);
  assert.equal((await json(await call('GET', '/vaults'))).data.length, 0);
});

test('notes over HTTP: the path is a query parameter; conflicts carry the current text; bad paths are 422', async () => {
  const v = (await json(await call('POST', '/vaults', { name: 'Notes' }))).data;
  const note = (path: string) => `/vaults/${v.id}/note?path=${encodeURIComponent(path)}`;
  const put = await call('PUT', note('Folder/My note #1.md'), { content: 'hello' });
  assert.equal(put.status, 422, 'a # in a name is refused');
  const ok = await call('PUT', note('Folder/Mý note.md'), { content: 'hello [[B]]', create: true });
  assert.equal(ok.status, 200);
  const r1 = (await json(ok)).data;
  assert.equal(r1.created, true);
  const got = (await json(await call('GET', note('Folder/Mý note.md')))).data;
  assert.deepEqual([got.content, got.version, got.name, got.folder, got.readOnly], ['hello [[B]]', r1.version, 'Mý note', 'Folder', false]);
  // Stale version: 409 with the current version and text, nothing written.
  const stale = await call('PUT', note('Folder/Mý note.md'), { content: 'mine', baseVersion: 'ffffffffffffffff' });
  assert.equal(stale.status, 409);
  const sj = await json(stale);
  assert.deepEqual([sj.error!.code, sj.error!.details.reason, sj.error!.details.currentVersion, sj.error!.details.content], ['CONFLICT', 'CONFLICT', r1.version, 'hello [[B]]']);
  assert.equal((await call('PUT', note('Folder/Mý note.md'), { content: 'mine' })).status, 409);
  assert.equal((await call('PUT', note('Folder/Mý note.md'), { content: 'x', create: true })).status, 409);
  assert.equal((await call('PUT', note('Folder/Mý note.md'), { content: 123 })).status, 422);
  // Hostile paths.
  for (const p of ['../../etc/passwd.md', '/etc/passwd.md', '..%2f..%2fx.md', 'a\\b.md', '.obsidian/app.md', 'a/./b.md', 'no-ext', 'CON.md']) {
    const res = await app.request(`/api/knowledge/vaults/${v.id}/note?path=${p.includes('%') ? p : encodeURIComponent(p)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x', create: true }) });
    assert.equal(res.status, 422, p);
  }
  assert.equal((await call('GET', note('missing.md'))).status, 404);
  assert.equal((await call('GET', `/vaults/${v.id}/note`)).status, 422);
  // Append, rename with link rewrite, history, restore, delete.
  await call('PUT', note('B.md'), { content: 'b', create: true });
  assert.equal((await call('POST', `/vaults/${v.id}/note/append`, { path: 'B.md', text: 'more' })).status, 200);
  const ren = (await json(await call('POST', `/vaults/${v.id}/note/rename`, { from: 'B.md', to: 'Sub/B2.md' }))).data;
  assert.deepEqual([ren.path, ren.rewritten], ['Sub/B2.md', ['Folder/Mý note.md']]);
  assert.equal((await json(await call('GET', note('Folder/Mý note.md')))).data.content, 'hello [[B2]]');
  const hist = (await json(await call('GET', `/vaults/${v.id}/note/history?path=${encodeURIComponent('Sub/B2.md')}`))).data;
  assert.ok(hist.entries.length >= 2);
  const first = hist.entries.at(-1);
  const ver = (await json(await call('GET', `/vaults/${v.id}/note/version?path=${encodeURIComponent('Sub/B2.md')}&id=${first.id}`))).data;
  assert.equal(typeof ver.entry.id, 'number');
  assert.equal((await call('DELETE', note('Sub/B2.md'))).status, 200);
  assert.equal((await call('GET', note('Sub/B2.md'))).status, 404);
  const deleted = (await json(await call('GET', `/vaults/${v.id}/deleted`))).data;
  assert.deepEqual(deleted.map((d: { path: string }) => d.path), ['Sub/B2.md']);
  const del = (await json(await call('GET', `/vaults/${v.id}/note/history?path=${encodeURIComponent('Sub/B2.md')}`))).data.entries;
  const restorable = del.find((e: { hasContent: boolean }) => e.hasContent);
  const back = await call('POST', `/vaults/${v.id}/note/restore`, { path: 'Sub/B2.md', version: restorable.id });
  assert.equal(back.status, 200);
  assert.equal((await json(await call('GET', note('Sub/B2.md')))).data.content.startsWith('b'), true);
  // Search, quick, tags, tree, daily, activity, rescan.
  assert.equal((await json(await call('GET', `/vaults/${v.id}/search?q=hello`))).data.hits[0].path, 'Folder/Mý note.md');
  assert.equal((await json(await call('GET', `/vaults/${v.id}/quick?q=b2`))).data[0].path, 'Sub/B2.md');
  assert.deepEqual((await json(await call('GET', `/vaults/${v.id}/tree?folder=`))).data.entries.map((e: { path: string }) => e.path), ['Folder', 'Sub']);
  assert.equal((await json(await call('POST', `/vaults/${v.id}/daily`, { text: 'logged' }))).data.created, true);
  assert.equal((await json(await call('GET', `/vaults/${v.id}/daily`))).data.exists, true);
  assert.ok((await json(await call('GET', `/vaults/${v.id}/activity`))).data.length > 3);
  assert.equal((await call('POST', `/vaults/${v.id}/rescan`)).status, 200);
});

test('attachments: type by extension only, size caps, safe headers, ranges', async () => {
  const v = (await json(await call('POST', '/vaults', { name: 'Files' }))).data;
  const file = (p: string) => `/vaults/${v.id}/file?path=${encodeURIComponent(p)}`;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  assert.equal((await call('PUT', file('img/a.png'), png)).status, 201);
  const res = await call('GET', file('img/a.png'));
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(res.headers.get('content-disposition') ?? '', /^inline/);
  const part = await call('GET', file('img/a.png'), undefined, { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/12');
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), png.slice(2, 6));
  assert.equal((await call('GET', file('img/a.png'), undefined, { range: 'bytes=99-100' })).status, 416);
  // SVG is allowed but never shown by navigating to it (it downloads; an <img> still draws it); scripts and executables are refused.
  assert.equal((await call('PUT', file('img/v.svg'), new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 201);
  const svg = await call('GET', file('img/v.svg'));
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox; default-src 'none'/);
  assert.equal((await call('PUT', file('data.csv'), new TextEncoder().encode('a,b\n1,2'))).status, 201);
  assert.match((await call('GET', file('data.csv'))).headers.get('content-disposition') ?? '', /^attachment/);
  for (const name of ['page.html', 'x.js', 'run.sh', 'a.exe', 'noext', 'x.svgz']) assert.equal((await call('PUT', file(name), new Uint8Array([1]))).status, 415, name);
  assert.equal((await call('PUT', file('Note.md'), new Uint8Array([1]))).status, 422);
  assert.equal((await call('PUT', file('img/a.png'), png)).status, 409, 'an existing name is not overwritten');
  assert.equal((await call('PUT', file('big.png'), new Uint8Array(1001))).status, 413);
  assert.equal((await call('GET', file('x.html'))).status, 415);
  assert.equal((await call('GET', file('missing.png'))).status, 404);
  assert.equal((await call('GET', file('../../etc/passwd.png'))).status, 422);
  // A note can't be fetched as a file.
  await call('PUT', `/vaults/${v.id}/note?path=Note.md`, { content: 'x', create: true });
  assert.equal((await call('GET', file('Note.md'))).status, 415);
});

test('import and export over HTTP: caps on the body, reports, a streamed zip that unzip accepts', async () => {
  const zip = fixtureZip({ wrapper: 'Brain' });
  const small = new Uint8Array(zip);
  const imp = await call('POST', '/vaults/import?filename=Brain.zip', small, { 'content-type': 'application/zip' });
  assert.equal(imp.status, 201);
  const rep = (await json(imp)).data;
  assert.equal(rep.vaultName, 'Brain');
  assert.ok(rep.notes > 15);
  assert.ok(rep.skipped.some((s: { reason: string }) => s.reason === 'hidden'));
  const huge = await call('POST', '/vaults/import', new Uint8Array(200_001), { 'content-type': 'application/zip' });
  assert.equal(huge.status, 413);
  assert.equal((await call('POST', '/vaults/import', new Uint8Array([1, 2, 3, 4]), { 'content-type': 'application/zip' })).status, 422);
  assert.equal((await call('POST', '/vaults/import?policy=wild', small, { 'content-type': 'application/zip' })).status, 422);
  // Unsafe archive: refused whole.
  const evil = (await import('../skills/testkit.js')).makeZip([{ name: '../x.md', data: 'x' }]);
  assert.equal((await call('POST', '/vaults/import', new Uint8Array(evil), { 'content-type': 'application/zip' })).status, 422);
  const before = (await json(await call('GET', '/vaults'))).data.length;
  const exp = await call('GET', `/vaults/${rep.vaultId}/export`);
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get('content-type'), 'application/zip');
  assert.match(exp.headers.get('content-disposition') ?? '', /^attachment; filename="Brain\.zip"/);
  const bytes = Buffer.from(await exp.arrayBuffer());
  const file = join(tempDirectory('kg-export-'), 'out.zip');
  writeFileSync(file, bytes);
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
  assert.equal((await json(await call('GET', '/vaults'))).data.length, before);
});

test('graph over HTTP: the three lenses, the query words, refused input, and gzip when the client accepts it', async () => {
  const v = (await json(await call('POST', '/vaults', { name: 'Graph vault' }))).data;
  const put = (path: string, content: string) => call('PUT', `/vaults/${v.id}/note?path=${encodeURIComponent(path)}`, { content, create: true });
  await put('Hub.md', Array.from({ length: 60 }, (_, i) => `[[Leaf ${i}]]`).join(' ') + ' #hub');
  for (let i = 0; i < 60; i++) await put(`Leaf ${i}.md`, `back to [[Hub]] ${'padding to make the answer worth compressing '.repeat(2)}`);
  const docs = await call('GET', `/graph?lens=docs&vault=${v.id}&tags=1`);
  assert.equal(docs.status, 200);
  const g = (await json(docs)).data;
  assert.equal(g.lens, 'docs');
  assert.equal(g.nodes.filter((n: { kind: string }) => n.kind === 'note').length, 61);
  assert.equal(g.nodes.filter((n: { kind: string }) => n.kind === 'tag').length, 1);
  assert.equal(g.edges.length, 61, '60 links and the tag');
  // A local graph, a folder filter that matches nothing, a small cap.
  const around = (await json(await call('GET', `/graph?lens=docs&vault=${v.id}&around=${encodeURIComponent(`note:${v.id}:Leaf 3.md`)}&depth=1`))).data;
  assert.deepEqual(around.nodes.map((n: { label: string }) => n.label).sort(), ['Hub', 'Leaf 3']);
  assert.equal((await json(await call('GET', `/graph?lens=docs&vault=${v.id}&folder=Nope`))).data.nodes.length, 0);
  const capped = (await json(await call('GET', `/graph?lens=docs&vault=${v.id}&cap=50`))).data;
  assert.equal(capped.truncated, true);
  assert.ok(capped.nodes.length <= 50);
  assert.match(capped.message, /of 61, most linked/);
  // The other lenses answer too (nothing has happened yet in this database).
  for (const lens of ['context', 'agentic']) {
    const r = await call('GET', `/graph?lens=${lens}`);
    assert.equal(r.status, 200, lens);
    assert.equal((await json(r)).data.lens, lens);
  }
  // Compressed when asked: a few hundred kilobytes of JSON travel as a few dozen.
  const plain = await call('GET', `/graph?lens=docs&vault=${v.id}`, undefined, { 'accept-encoding': 'identity' });
  assert.equal(plain.headers.get('content-encoding'), null);
  const plainBytes = Buffer.from(await plain.arrayBuffer()).length;
  const gz = await call('GET', `/graph?lens=docs&vault=${v.id}`, undefined, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  const packed = Buffer.from(await gz.arrayBuffer());
  assert.ok(packed.length < plainBytes / 2, `${packed.length} of ${plainBytes}`);
  assert.equal((JSON.parse(gunzipSync(packed).toString('utf8')) as { data: { nodes: unknown[] } }).data.nodes.length, 61, 'it decompresses to the same answer');
  // Refused: lenses and words that aren't the ones there are, a vault that isn't there, a time that isn't one.
  for (const bad of ['lens=nope', `lens=docs&vault=${v.id}&kinds=bogus`, 'lens=context&access=sideways', 'lens=context&since=weeks', 'lens=agentic&since=0d']) assert.equal((await call('GET', `/graph?${bad}`)).status, 422, bad);
  assert.equal((await call('GET', '/graph?lens=docs&vault=missing')).status, 404);
  assert.equal((await call('GET', `/graph?lens=docs&vault=${v.id}&around=${encodeURIComponent('note:other:Hub.md')}`)).status, 404);
});
