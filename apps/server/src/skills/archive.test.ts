import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArchiveError, cleanPath, readFolder, readZip } from './archive.js';
import { makeZip } from './testkit.js';

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ArchiveError, `expected an ArchiveError, got ${String(e)}`);
    return e.message;
  }
  assert.fail('expected it to throw');
};

test('reads stored and deflated entries with their modes, symlinks and special files', () => {
  const zip = makeZip([
    { name: 'a/SKILL.md', data: '---\nname: a\n---\nhi\n' },
    { name: 'a/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755, method: 0 },
    { name: 'a/link', data: 'run.sh', type: 'symlink' },
    { name: 'a/pipe', type: 'fifo' },
    { name: 'a/sub', type: 'dir' },
    { name: '__MACOSX/a/._SKILL.md', data: 'junk' },
    { name: 'a/.DS_Store', data: 'junk' },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((e) => [e.path, e.type, e.mode.toString(8)]),
    [
      ['a/SKILL.md', 'file', '644'],
      ['a/run.sh', 'file', '755'],
      ['a/link', 'symlink', '644'],
      ['a/pipe', 'special', '644'],
    ],
  );
  assert.equal(entries[1]!.data.toString(), '#!/bin/sh\necho hi\n');
  assert.equal(entries[2]!.data.toString(), 'run.sh');
});

test('refuses paths that leave the folder, absolute paths, backslashes and control characters', () => {
  assert.match(message(() => readZip(makeZip([{ name: '../evil', data: 'x' }]))), /leaves its folder/);
  assert.match(message(() => readZip(makeZip([{ name: 'a/../../evil', data: 'x' }]))), /leaves its folder/);
  assert.match(message(() => readZip(makeZip([{ name: '/etc/passwd', data: 'x' }]))), /absolute/);
  assert.match(message(() => readZip(makeZip([{ name: 'C:/x', data: 'x' }]))), /absolute/);
  assert.match(message(() => readZip(makeZip([{ name: 'a\\b', data: 'x' }]))), /backslashes/);
  assert.match(message(() => readZip(makeZip([{ name: 'a/\u0001b', data: 'x' }]))), /control character/);
  assert.equal(cleanPath('./a/b/'), 'a/b');
  assert.equal(cleanPath('cafe\u0301/x'), 'caf\u00e9/x');
});

test('caps files, size and compression ratio before inflating, and holds inflation to the declared size', () => {
  const limits = { bytes: 1000, files: 2, ratio: 100 };
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }, { name: 'c', data: 'x' }]), limits)), /3 files; the limit is 2/);
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'x'.repeat(2000) }]), limits)), /unpacks to/);
  // 2 MB of zeros deflates to about 2 KB: more than 100:1.
  assert.match(message(() => readZip(makeZip([{ name: 'bomb', data: Buffer.alloc(2 * 1024 * 1024) }]))), /zip bomb/);
  // A header that claims less than the data inflates to can't make it inflate more.
  assert.match(message(() => readZip(makeZip([{ name: 'liar', data: 'y'.repeat(5000), declaredSize: 10 }]))), /damaged or larger/);
  // Overlapping entries (the same data counted many times) are refused.
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'z'.repeat(100) }, { name: 'b', data: 'z'.repeat(100) }], { overlap: true }))), /overlapping/);
});

test('refuses damaged, encrypted, unknown-method, duplicate and non-zip input', () => {
  assert.match(message(() => readZip(Buffer.from('not a zip at all, sorry'))), /isn’t a zip/);
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'hello', crc: 1 }]))), /checksum/);
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'hello', flags: 1 }]))), /Encrypted/);
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: 'hello', method: 12 }]))), /compression method/);
  assert.match(message(() => readZip(makeZip([{ name: 'a', data: '1' }, { name: './a', data: '2' }]))), /twice/);
});

test('folders from a browser: limits, paths and no permissions', () => {
  const entries = readFolder([
    { path: 'skill/SKILL.md', data: Buffer.from('x') },
    { path: 'skill/run.sh', data: Buffer.from('#!/bin/sh\n') },
    { path: 'skill/.DS_Store', data: Buffer.from('junk') },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.path, e.mode]),
    [
      ['skill/SKILL.md', 0o644],
      ['skill/run.sh', 0o644],
    ],
  );
  assert.match(message(() => readFolder([{ path: '../x', data: Buffer.from('x') }])), /leaves its folder/);
  assert.match(message(() => readFolder([{ path: 'a', data: Buffer.alloc(11) }], { bytes: 10, files: 5, ratio: 100 })), /limit/);
});
