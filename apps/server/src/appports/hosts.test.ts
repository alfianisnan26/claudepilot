// T-948 (docs/prd/app-ports.md §2, §5): the app host's name is parsed strictly, `next` is a path and never a URL, and the bridge into the
// workspace can only ever reach its loopback: the address is a literal, the port an integer in range, and Connect targets answer 501.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPortHost, isAppPortNext, parseAppPortHost } from '@portal/contracts';
import type { ExecSession, Runtime } from '../workspaces/runtime.js';
import { BRIDGE, NotOnThisTarget, bridgeCommand, createDialer } from './dial.js';
import { AppPortGrants } from './grants.js';
import { AppPortProxy } from './proxy.js';

const S = 'apps.test';

test('parseAppPortHost: only app-<slug>-<port>.<suffix>, port 1024-65535', () => {
  assert.deepEqual(parseAppPortHost('app-ws-1-8080.apps.test', S), { slug: 'ws-1', port: 8080 });
  assert.deepEqual(parseAppPortHost('APP-WS-1-8080.Apps.Test:3000', S), { slug: 'ws-1', port: 8080 });
  assert.deepEqual(parseAppPortHost('app-kohi-event-8765.apps.test', S), { slug: 'kohi-event', port: 8765 });
  for (const bad of [
    'app-ws-1-80.apps.test', // below 1024
    'app-ws-1-65536.apps.test', // above the range
    'app-ws-1-08080.apps.test', // leading zero
    'app-ws-1.apps.test', // no port
    'app--8080.apps.test', // no slug
    'app-ws-1-8080.evil.test', // another suffix
    'app-ws-1-8080.apps.test.evil.test', // the suffix in the middle
    'x.app-ws-1-8080.apps.test', // two labels
    'app-ws_1-8080.apps.test', // not a label
    'pilot.apps.test',
    'apps.test',
    '127.0.0.1:8080',
    '',
  ])
    assert.equal(parseAppPortHost(bad, S), null, bad);
  assert.equal(parseAppPortHost('app-ws-1-8080.apps.test', undefined), null, 'feature off');
});

test('appPortHost: the name lowercased; null for a name that is no label', () => {
  assert.equal(appPortHost('Tradingbot', 8765, S), 'app-tradingbot-8765.apps.test');
  assert.equal(appPortHost('my.ws', 8080, S), null);
  assert.equal(appPortHost('my_ws', 8080, S), null);
  assert.equal(appPortHost('ws', 80, S), null);
});

test('isAppPortNext: a path only; a scheme, // or a backslash is refused', () => {
  for (const ok of ['/', '/a', '/a/b?c=d#e', '/socket.io/?EIO=4', '/a/b:c']) assert.equal(isAppPortNext(ok), true, ok);
  for (const bad of [
    '',
    'a',
    'https://evil.test/',
    '//evil.test',
    '/\\evil.test',
    '\\\\evil.test',
    '/a//b',
    '/javascript:alert(1)',
    'javascript:alert(1)',
    '/a\tb',
    '/a\nb',
    '/中', // above 0x7e: raw, it can't go in a Location header (QA T-948 c10015)
    '/café',
    '/a\u007fb',
    `/${'a'.repeat(2048)}`,
  ])
    assert.equal(isAppPortNext(bad), false, JSON.stringify(bad));
});

test('the bridge reaches 127.0.0.1 only; its one argument is an integer port in range', () => {
  assert.match(BRIDGE, /connect\(Number\(process\.argv\[1\]\),'127\.0\.0\.1'\)/);
  assert.equal((BRIDGE.match(/connect\(/g) ?? []).length, 1);
  assert.deepEqual(bridgeCommand(8080), ['node', '-e', BRIDGE, '8080']);
  for (const bad of [80, 0, -1, 65536, 8080.5, Number.NaN, '10.0.0.1:8080' as unknown as number, '8080' as unknown as number])
    assert.throws(() => bridgeCommand(bad), RangeError, String(bad));
});

const runtime = (kind: string, source?: string) => ({ target: { id: 't', kind, ...(source ? { source } : {}) } }) as unknown as Runtime;
const fakeSession = (): ExecSession => ({ write() {}, close() {}, onData() {}, onExit() {} });

test('the dialer: Kubernetes, Docker and local get the bridge; a Connect target is NotOnThisTarget (501)', async () => {
  const calls: string[][] = [];
  for (const kind of ['kubernetes', 'docker', 'local']) {
    const dial = createDialer({ runtimeFor: () => runtime(kind), exec: async (_t, _n, command) => (calls.push(command), fakeSession()) });
    const s = await dial(`${kind}/ws-1`, 8765);
    s.destroy();
  }
  assert.deepEqual(
    calls.map((c) => c.at(-1)),
    ['8765', '8765', '8765'],
  );
  const enrolled = createDialer({
    runtimeFor: () => runtime('docker', 'enrolled'),
    exec: async () => assert.fail('no exec on a Connect target'),
  });
  await assert.rejects(enrolled('docker/ws-1', 8765), NotOnThisTarget);
  const none = createDialer({ runtimeFor: () => undefined, exec: async () => assert.fail('no exec') });
  await assert.rejects(none('gone/ws-1', 8765));
  const range = createDialer({ runtimeFor: () => runtime('docker'), exec: async () => assert.fail('no exec for a bad port') });
  await assert.rejects(range('docker/ws-1', 22), RangeError);
});

test('owns: the proxy takes app-* hosts under the suffix only, and nothing when the feature is off', () => {
  const deps = {
    grants: new AppPortGrants(),
    dial: async () => assert.fail('no dial'),
    sessionValid: () => true,
    deniedPorts: new Set<number>(),
  };
  const on = new AppPortProxy({ ...deps, suffix: S });
  assert.equal(on.owns('app-ws-1-8080.apps.test'), true);
  assert.equal(on.owns('app-ws-1-8080.apps.test:3000'), true);
  assert.equal(on.owns('app-x.apps.test'), true, 'malformed app host: the proxy 404s it, never the portal');
  assert.equal(on.owns('pilot.apps.test'), false);
  assert.equal(on.owns('app-ws-1-8080.evil.test'), false);
  assert.equal(on.owns(undefined), false);
  const off = new AppPortProxy({ ...deps, suffix: undefined });
  assert.equal(off.enabled, false);
  assert.equal(off.owns('app-ws-1-8080.apps.test'), false);
});
