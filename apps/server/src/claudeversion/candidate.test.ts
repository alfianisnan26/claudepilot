// The candidate: the registry's newest version, read, never guessed (docs/prd/claude-version-pinning.md FR13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateOf, readRegistry, REGISTRY_URL } from './candidate.js';

const reply = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch;
const NOW = new Date('2026-10-12T06:00:00.000Z');

test('the registry answer is read as channels; only exact versions are kept', async () => {
  const r = await readRegistry(reply(JSON.stringify({ stable: '2.1.287', next: '2.1.296', latest: '2.1.296', weird: '^2', 'bad tag!': '2.1.1' })));
  assert.deepEqual(r, { ok: true, channels: { stable: '2.1.287', next: '2.1.296', latest: '2.1.296' } });
  assert.equal(REGISTRY_URL, 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags');
});

test('it asks for the dist-tags only, with a timeout, and refuses redirects', async () => {
  let seen: { url: string; init: RequestInit | undefined } | null = null;
  await readRegistry((async (url: string, init?: RequestInit) => ((seen = { url, init }), new Response('{"latest":"2.1.296"}'))) as unknown as typeof fetch);
  assert.equal(seen!.url, REGISTRY_URL);
  assert.equal(seen!.init?.redirect, 'error');
  assert.ok(seen!.init?.signal instanceof AbortSignal);
});

test('anything else is unavailable, with why: an error status, a network failure, a timeout, junk, a huge answer, no latest', async () => {
  assert.deepEqual(await readRegistry(reply('{}', 503)), { ok: false, reason: 'The npm registry answered 503.' });
  const offline = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch;
  assert.deepEqual(await readRegistry(offline), { ok: false, reason: 'Could not reach the npm registry (ENOTFOUND).' });
  const slow = (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  assert.deepEqual(await readRegistry(slow), { ok: false, reason: 'Could not reach the npm registry (timed out).' });
  assert.match((await readRegistry(reply('<html>'))as { reason: string }).reason, /Could not reach/);
  assert.deepEqual(await readRegistry(reply('[1,2]')), { ok: false, reason: 'The npm registry’s answer was not a list of channels.' });
  assert.deepEqual(await readRegistry(reply(JSON.stringify({ stable: '2.1.287' }))), { ok: false, reason: 'The npm registry named no latest version.' });
  assert.match((await readRegistry(reply(`{"latest":"2.1.296","pad":"${'x'.repeat(70_000)}"}`)) as { reason: string }).reason, /larger than expected/);
});

test('the candidate against what is installed', async () => {
  const ok = { ok: true as const, channels: { latest: '2.1.300', stable: '2.1.287' } };
  assert.deepEqual(candidateOf(ok, '2.1.296', NOW), { status: 'newer', version: '2.1.300', channels: ok.channels, checkedAt: NOW.toISOString(), reason: null });
  assert.equal(candidateOf(ok, '2.1.300', NOW).status, 'same');
  assert.equal(candidateOf(ok, '2.1.310', NOW).status, 'older');
  assert.equal(candidateOf(ok, null, NOW).status, 'unknown', 'nothing installed to compare with');
  const down = candidateOf({ ok: false, reason: 'Could not reach the npm registry (ENOTFOUND).' }, '2.1.296', NOW);
  assert.deepEqual([down.status, down.version, down.channels, down.reason], ['unavailable', null, {}, 'Could not reach the npm registry (ENOTFOUND).']);
});
