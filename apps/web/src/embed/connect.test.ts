// The panel's half of connect (PILOT-1111): a unique popup per attempt, a verifier that never leaves the panel, Esc closes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connectCode, connectPair, connectWindowName, createClient } from './api';
import { closesPanel } from './model';

test('connectPair: the nonce is base64url(SHA-256(verifier)), what the server checks a claim against', async () => {
  const a = await connectPair();
  const b = await connectPair();
  assert.ok(a && b);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.nonce, createHash('sha256').update(a.verifier).digest('base64url'));
  assert.notEqual(a.verifier, b.verifier);
});

test('connectWindowName: every attempt opens its own window (a fixed name navigated the window an earlier attempt left open)', async () => {
  const a = (await connectPair())!;
  const b = (await connectPair())!;
  assert.notEqual(connectWindowName(a.nonce), connectWindowName(b.nonce));
  assert.match(connectWindowName(a.nonce), /^pilot-reporter-connect-[A-Za-z0-9]{1,16}$/);
});

test('connectCode: four characters, the same rule as the popup page', () => {
  assert.equal(connectCode('a-b_cdEF'), 'ABCD');
  const server = readFileSync(new URL('../../../server/src/reporter/pages.ts', import.meta.url), 'utf8');
  assert.ok(server.includes(".replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()"), 'the server derives the code the same way');
});

test('claimConnect posts the verifier same-origin, without cookies or a token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { pending: true } }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createClient({ token: () => null, onUnauthorized: () => undefined, fetchFn });
  assert.deepEqual(await c.claimConnect('KONF', 'https://stg.example', 'v'.repeat(43)), { pending: true });
  assert.equal(calls[0]!.url, '/reporter/v1/connect/claim');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { bucket: 'KONF', origin: 'https://stg.example', verifier: 'v'.repeat(43) });
});

test('closesPanel: Esc closes, unless a control used it or an IME is composing', () => {
  assert.equal(closesPanel({ key: 'Escape', defaultPrevented: false, isComposing: false }), true);
  assert.equal(closesPanel({ key: 'Escape', defaultPrevented: true, isComposing: false }), false);
  assert.equal(closesPanel({ key: 'Escape', defaultPrevented: false, isComposing: true }), false);
  assert.equal(closesPanel({ key: 'Enter', defaultPrevented: false, isComposing: false }), false);
});

test('the panel draws no close button of its own: the SDK frame has the one close', () => {
  const panel = readFileSync(new URL('./Panel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /icon="x"/);
  assert.doesNotMatch(panel, /label="Close"/);
  assert.match(panel, /closesPanel\(e\)\) post\(\{ type: 'pilot-reporter:close' \}\)/, 'Esc still closes');
  assert.match(panel, /<LogoMark/, 'the pilot mark on the Connect screen');
  assert.doesNotMatch(panel, /'pilot-reporter-connect'/, 'no fixed popup name');
});
