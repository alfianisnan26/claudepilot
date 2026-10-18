// T-948 FIX3b: the server entry (index.ts) must hand sign-outs to cutOnRevoke; appports/limits.test.ts proves what cutOnRevoke does.
// index.ts starts the whole portal at import, so this reads its source, as other wiring checks do (chat/leadRules.test.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** index.ts without comments, so a commented-out call does not count. */
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('index.ts wires sign-outs through cutOnRevoke with the portal, its socket guard and the app ports, and nothing overrides it', () => {
  const calls = source.match(/\bcutOnRevoke\(\s*portal\s*,\s*sockets\s*,\s*appPorts\s*\)/g) ?? [];
  assert.equal(calls.length, 1, 'one cutOnRevoke(portal, sockets, appPorts) call in index.ts');
  assert.match(source, /import\s*\{\s*cutOnRevoke\s*\}\s*from\s*'\.\/revoke\.js'/);
  assert.doesNotMatch(source, /\bportal\.onRevoked\s*=/, 'a later assignment would replace the hookup');
  assert.match(source, /const sockets = new SocketGuard\(/, 'sockets is the SocketGuard');
  assert.match(source, /const appPorts = new AppPorts\(/, 'appPorts is the AppPorts');
});
