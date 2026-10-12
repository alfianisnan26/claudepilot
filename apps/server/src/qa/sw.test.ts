// QA regression (QA-023): the service worker shows the offline page when the server cannot be reached, and when a reverse proxy
// answers 502/503/504 for it (Caddy does while the portal restarts); every other answer, and every request that is not a page
// load, goes through untouched. The worker is run in a stub scope, as the browser would.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../../web/public/sw.js', import.meta.url)), 'utf8');
type Handler = (event: { request: { method: string; mode: string }; respondWith: (p: unknown) => void; waitUntil?: (p: unknown) => void }) => void;

function load(fetchImpl: () => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const OFFLINE_PAGE = new Response('offline');
  const caches = { open: async () => ({ addAll: async () => undefined }), keys: async () => [], delete: async () => true, match: async () => OFFLINE_PAGE };
  const self = { addEventListener: (type: string, h: Handler) => handlers.set(type, h), skipWaiting: async () => undefined, clients: { claim: async () => undefined } };
  new Function('self', 'caches', 'fetch', source)(self, caches, fetchImpl);
  const navigate = async (method = 'GET', mode = 'navigate') => {
    let answer: unknown = 'not handled';
    handlers.get('fetch')!({ request: { method, mode }, respondWith: (p) => (answer = p) });
    return answer instanceof Promise ? await answer : answer;
  };
  return { navigate, OFFLINE_PAGE };
}

test('a page load that gets no answer shows the offline page', async () => {
  const w = load(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(await w.navigate(), w.OFFLINE_PAGE);
});

test('a proxy saying the portal is down (502, 503, 504) shows the offline page', async () => {
  for (const status of [502, 503, 504]) {
    const w = load(async () => new Response('bad gateway', { status }));
    assert.equal(await w.navigate(), w.OFFLINE_PAGE, String(status));
  }
});

test('every other answer is the portal’s own, errors included', async () => {
  for (const status of [200, 301, 401, 403, 404, 500]) {
    const res = new Response('x', { status: status === 301 ? 200 : status });
    const w = load(async () => res);
    assert.equal(await w.navigate(), res, String(status));
  }
});

test('requests that are not page loads are left to the network', async () => {
  const w = load(() => Promise.reject(new Error('nope')));
  assert.equal(await w.navigate('POST', 'navigate'), 'not handled');
  assert.equal(await w.navigate('GET', 'cors'), 'not handled');
  assert.equal(await w.navigate('GET', 'same-origin'), 'not handled');
});
