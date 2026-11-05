// PILOT-1189: the boot banner never holds the server code, and a generated code goes to a file only the portal's user can read, removed
// when the code changes. Codes are made here at runtime.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { CODE_ALPHABET, formatCode, normalizeCode } from '@portal/contracts';
import { bootBanner, codeFilePath, codeLine, removeCodeFile, writeCodeFile } from './bootBanner.js';
import { generateCode, Portal } from './portal.js';
import { tempDirectory } from './store/testTmp.js';

/** Every 6 characters of `code` in a row: none of them may be in a line. */
const windows = (code: string) => Array.from({ length: code.length - 5 }, (_, i) => code.slice(i, i + 6));

test('the banner says where the code comes from and how strong it is, never the code or any part of it', () => {
  const strong = generateCode();
  const weak = `2A${CODE_ALPHABET.slice(5, 11)}`;
  const lines = [
    [codeLine('env', strong, null), 'server code: from PORTAL_SERVER_CODE, strong'],
    [codeLine('env', weak, null), 'server code: from PORTAL_SERVER_CODE, weak (below 128 bits)'],
    [codeLine('generated', strong, '/data/server-code'), 'server code: generated, strong; it is in /data/server-code (this user only)'],
    [codeLine('generated', strong, null), 'server code: generated, strong'],
  ] as const;
  for (const [got, want] of lines) assert.equal(got, want);
  for (const code of [strong, weak])
    for (const source of ['env', 'generated', 'custom'] as const) {
      const banner = bootBanner({ dev: false, where: 'http://localhost:3000', source, code, file: '/data/server-code' });
      assert.ok(!banner.includes(code) && !banner.includes(formatCode(code)), `${source}: not the code`);
      const flat = banner.replace(/-/g, '');
      for (const w of windows(code)) assert.ok(!flat.includes(w), `${source}: not "${w.length} characters of it"`);
      assert.match(banner, /portal production server on http:\/\/localhost:3000/);
    }
});

test('the code file: written mode 0600 (also over an older, wider file), in the shown form; removed, and removing nothing is fine', () => {
  const dir = tempDirectory('cp-boot-banner-');
  const path = codeFilePath(dir);
  writeFileSync(path, 'old\n');
  chmodSync(path, 0o644);
  const code = generateCode();
  assert.equal(writeCodeFile(dir, code), path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), `${formatCode(code)}\n`);
  assert.equal(normalizeCode(readFileSync(path, 'utf8').trim()), code, 'typed as shown, it is the code');
  removeCodeFile(dir);
  assert.ok(!existsSync(path));
  removeCodeFile(dir); // no file: no error
});

test('Portal.onCodeChanged: called after a rotation (generated or custom); a refused one changes nothing and does not call it', () => {
  const p = new Portal(generateCode(), 60_000);
  let calls = 0;
  p.onCodeChanged = () => calls++;
  p.rotate('keep');
  p.rotate('keep', generateCode());
  assert.equal(calls, 2);
  assert.throws(() => p.rotate('keep', 'not a code!'));
  p.requireStrongCode = true;
  assert.throws(() => p.rotate('keep', `2A${CODE_ALPHABET.slice(5, 11)}`), /too weak/);
  assert.equal(calls, 2, 'a refused code is no change');
});
