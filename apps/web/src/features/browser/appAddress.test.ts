import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAppTarget, parseAppAddress } from './appAddress';

// T-948: the App address bar takes a loopback port and a path, and refuses everything else inline.
const ok = (s: string) => {
  const r = parseAppAddress(s);
  assert.ok(r.ok, `${s} should parse`);
  return r.ok ? r.target : never();
};
const never = (): never => {
  throw new Error('unreachable');
};
const refused = (s: string) => assert.equal(parseAppAddress(s).ok, false, `${s} should be refused`);

test('localhost, 127.0.0.1 and a bare port parse to a port and a path', () => {
  assert.deepEqual(ok('localhost:8765'), { port: 8765, path: '/' });
  assert.deepEqual(ok('  localhost:8765/dash?x=1#top '), { port: 8765, path: '/dash?x=1#top' });
  assert.deepEqual(ok('127.0.0.1:8765/x?y'), { port: 8765, path: '/x?y' });
  assert.deepEqual(ok('8765'), { port: 8765, path: '/' });
  assert.deepEqual(ok('http://localhost:3000/a'), { port: 3000, path: '/a' });
  assert.deepEqual(ok('LOCALHOST:3000?q=1'), { port: 3000, path: '/?q=1' });
});

test('another host, another scheme, no port, a bad port or a bad path is refused', () => {
  for (const s of [
    'http://evil.com',
    'evil.com:8765',
    'localhost.evil.com:8765',
    'localhost@evil.com:8765',
    'https://localhost:8765',
    'file:///etc/passwd',
    'file:',
    'javascript:alert(1)',
    'data:text/html,x',
    'localhost',
    'localhost:',
    '',
    '   ',
    '0.0.0.0:8765',
    '[::1]:8765',
  ])
    refused(s);
  for (const s of ['localhost:80', '80', '1023', '65536', '99999', '999999999999', 'localhost:0']) refused(s);
  for (const s of ['localhost:8765//evil.com', 'localhost:8765/a\\b', 'localhost:8765/a\nb']) refused(s);
  assert.equal(ok('1024').port, 1024);
  assert.equal(ok('65535').port, 65535);
});

test('a target is shown without a trailing slash', () => {
  assert.equal(formatAppTarget({ port: 8765, path: '/' }), 'localhost:8765');
  assert.equal(formatAppTarget({ port: 8765, path: '/a?b' }), 'localhost:8765/a?b');
});
