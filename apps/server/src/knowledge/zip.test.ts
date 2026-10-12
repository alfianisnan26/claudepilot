import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDirectory } from '../store/testTmp.js';
import { makeZip } from '../skills/testkit.js';
import { openZip, ZipError, zipChunks, type ZipLimits } from './zip.js';

const LIMITS: ZipLimits = { packedBytes: 10 * 1024 * 1024, unpackedBytes: 50 * 1024 * 1024, files: 1000, ratio: 100 };
const refused = (buf: Buffer, re: RegExp, limits = LIMITS) => assert.throws(() => openZip(buf, limits).forEach((f) => f.isDir || f.read()), (e: unknown) => e instanceof ZipError && re.test((e as Error).message));

test('a zip we write is a standard zip: our reader, unzip and Python all read it', () => {
  const entries = [
    { name: 'Notes/One.md', data: Buffer.from('# One\n'.repeat(500)), mtime: new Date('2026-10-12T10:00:00Z') },
    { name: 'Café – 日本語.md', data: Buffer.from('unicode name'), mtime: new Date('2026-10-12T10:00:00Z') },
    { name: 'img/pic.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), mtime: new Date('2026-10-12T10:00:00Z'), store: true },
    { name: 'empty.md', data: Buffer.alloc(0), mtime: new Date('2026-10-12T10:00:00Z') },
  ];
  const buf = Buffer.concat([...zipChunks(entries)]);
  const read = openZip(buf, LIMITS);
  assert.deepEqual(read.map((f) => f.name), entries.map((e) => e.name));
  read.forEach((f, i) => assert.deepEqual(f.read(), entries[i]!.data));
  const dir = tempDirectory('kg-zip-');
  const file = join(dir, 'out.zip');
  writeFileSync(file, buf);
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
  const py = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(sorted(z.namelist()))', file], { encoding: 'utf8' });
  assert.match(py, /Café – 日本語\.md/);
});

test('hostile archives: declared sizes, bombs, overlap, bad CRC, encrypted, zip64 marker, junk', () => {
  refused(makeZip([{ name: 'a.md', data: 'hello', declaredSize: 4 }]), /damaged|larger/);
  refused(makeZip([{ name: 'a.md', data: 'hello', crc: 1234 }]), /checksum/);
  refused(makeZip([{ name: 'a.md', data: 'hello', flags: 1 }]), /Encrypted/);
  refused(makeZip([{ name: 'a.md', data: 'x'.repeat(5_000_000) }]), /bomb/);
  refused(makeZip([{ name: 'a.md', data: 'one' }, { name: 'b.md', data: 'two' }], { overlap: true }), /overlapping/);
  refused(Buffer.from('not a zip at all, just some bytes that are long enough to pass the size check'), /isn’t a zip/);
  refused(Buffer.alloc(10), /isn’t a zip/);
});

test('limits: packed size, unpacked size, entry count', () => {
  const big = makeZip([{ name: 'a.md', data: 'y'.repeat(2000), method: 0 }]);
  assert.throws(() => openZip(big, { ...LIMITS, packedBytes: 100 }), /limit is/);
  assert.throws(() => openZip(big, { ...LIMITS, unpackedBytes: 1000 }), /unpacks to/);
  const many = makeZip(Array.from({ length: 20 }, (_, i) => ({ name: `n${i}.md`, data: 'x' })));
  assert.throws(() => openZip(many, { ...LIMITS, files: 5 }), /20 files; the limit is 5/);
  assert.equal(openZip(many, LIMITS).length, 20);
  // Entries the caller will skip don't count: a vault zipped with its .git folder is still a small vault.
  assert.equal(openZip(many, { ...LIMITS, files: 5 }, (n) => n !== 'n0.md').length, 20);
});

test('names: directory entries and symlink/special types are reported, not hidden', () => {
  const z = openZip(makeZip([{ name: 'dir', type: 'dir' }, { name: 'dir/a.md', data: 'a' }, { name: 'link', type: 'symlink', data: 'target' }, { name: 'dev', type: 'fifo', data: '' }]), LIMITS);
  assert.deepEqual(z.map((f) => [f.name, f.isDir, f.type]), [['dir/', true, 'file'], ['dir/a.md', false, 'file'], ['link', false, 'symlink'], ['dev', false, 'special']]);
});
