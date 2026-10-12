import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { CHAT_MAX_ZIP_ENTRIES } from '@portal/contracts';
import { blobDir, putBlob } from '../blobs.js';
import { recordFile } from './records.js';
import { blobFileFor } from './serve.js';
import { cleanup, storeWithSession } from './testkit.js';
import { planZip, zipStream } from './zip.js';

after(cleanup);

/** Reads a zip the way an unzip tool would: the central directory first, then each entry's data, checking sizes and CRCs. */
function readZip(zip: Buffer): { name: string; data: Buffer; method: number }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  const cdLength = zip.readUInt32LE(eocd + 12);
  const cdStart = zip.readUInt32LE(eocd + 16);
  assert.equal(cdStart + cdLength, eocd, 'the central directory ends where the end record starts');
  const out: { name: string; data: Buffer; method: number }[] = [];
  let pos = cdStart;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50);
    const flags = zip.readUInt16LE(pos + 8);
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const csize = zip.readUInt32LE(pos + 20);
    const usize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen);
    assert.ok(flags & 0x0800, 'names are UTF-8');
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const lNameLen = zip.readUInt16LE(local + 26);
    const lExtraLen = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, usize, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: crc`);
    // The data descriptor right after the data repeats them.
    assert.equal(zip.readUInt32LE(dataStart + csize), 0x08074b50);
    assert.equal(zip.readUInt32LE(dataStart + csize + 4), crc);
    out.push({ name, data: Buffer.from(data), method });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(pos, cdStart + cdLength);
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

test('zip: every file comes out byte for byte, text is deflated, packed types are stored, names are unique and safe', async () => {
  const s = await storeWithSession();
  const add = (name: string, mediaType: string, data: Buffer) => {
    const blobId = putBlob(s.store, data);
    recordFile(s.store, s.sessionId, 'download', { blobId, name, mediaType, size: data.length, preview: 'none' });
    return { name, file: blobFileFor(s.store, s.sessionId, blobId)! };
  };
  const text = Buffer.from('line of text\n'.repeat(5000));
  const photo = randomBytes(40_000);
  const empty = Buffer.alloc(0);
  const items = [
    add('report.md', 'text/markdown', text),
    add('photo.jpg', 'image/jpeg', photo),
    add('report.md', 'text/markdown', Buffer.from('another file with the same name')),
    add('../../etc/passwd', 'text/plain', Buffer.from('not a path')),
    add('Résumé – final.pdf', 'application/pdf', randomBytes(300)),
    add('empty.txt', 'text/plain', empty),
  ];
  // An empty file can't be linked through putBlob + recordFile the same way (size 0 is fine): check it is there.
  const zip = await collect(zipStream(items));
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['report.md', 'photo.jpg', 'report (2).md', 'passwd', 'Résumé – final.pdf', 'empty.txt'],
  );
  assert.ok(entries[0]!.data.equals(text));
  assert.equal(entries[0]!.method, 8, 'text is deflated');
  assert.ok(zip.length < text.length, 'and it shows');
  assert.ok(entries[1]!.data.equals(photo));
  assert.equal(entries[1]!.method, 0, 'a JPEG is stored');
  assert.equal(entries[4]!.method, 0, 'a PDF is stored');
  assert.equal(entries[5]!.data.length, 0);
  s.close();
});

test('zip: the caps — nothing to zip, too many entries, too many bytes — are refused with a reason before anything streams', async () => {
  const s = await storeWithSession();
  const blobId = putBlob(s.store, Buffer.from('x'));
  recordFile(s.store, s.sessionId, 'download', { blobId, name: 'x.txt', mediaType: 'text/plain', size: 1, preview: 'text' });
  const file = blobFileFor(s.store, s.sessionId, blobId)!;
  assert.throws(() => planZip([]), /no files/);
  assert.throws(() => planZip(Array.from({ length: CHAT_MAX_ZIP_ENTRIES + 1 }, () => ({ name: 'x.txt', file }))), /Too many files/);
  assert.equal(planZip(Array.from({ length: CHAT_MAX_ZIP_ENTRIES }, () => ({ name: 'x.txt', file }))).length, CHAT_MAX_ZIP_ENTRIES);
  assert.throws(() => planZip([{ name: 'big.bin', file: { ...file, size: 100_000_001 } }]), /over 100 MB/);
  assert.doesNotThrow(() => planZip([{ name: 'big.bin', file: { ...file, size: 100_000_000 } }]));
  void blobDir;
  s.close();
});
