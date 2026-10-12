// T-MUX: JSON lines and the host records over plain Node streams and over a mux stream.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { CONNECT_LIMITS } from '@portal/contracts';
import { LineEnded, LineMalformed, LineTimeout, LineTooLong, encodeLine, readJsonLines, readLine, writeLine } from './lines.js';
import { RECORD, RecordError, RecordParser, chunkRecords, encodeRecord, jsonRecord, parseResult, readRecords, writeRecord } from './records.js';

describe('readLine', () => {
  test('reads a line and leaves what follows in the stream', async () => {
    const s = new PassThrough();
    s.write('{"v":1}\nraw bytes after');
    assert.equal(await readLine(s, 100), '{"v":1}');
    assert.equal(s.read().toString(), 'raw bytes after');
  });

  test('a line that arrives in pieces, and two lines read one after the other', async () => {
    const s = new PassThrough();
    const first = readLine(s, 100);
    s.write('hel');
    await new Promise((r) => setImmediate(r));
    s.write('lo\nsecond\n');
    assert.equal(await first, 'hello');
    assert.equal(await readLine(s, 100), 'second');
  });

  test('null at the end of the stream; an error when it ends inside a line or is too long', async () => {
    const a = new PassThrough();
    a.end();
    assert.equal(await readLine(a, 10), null);
    const b = new PassThrough();
    b.end('no newline');
    await assert.rejects(readLine(b, 100), LineEnded);
    const c = new PassThrough();
    c.write('x'.repeat(50));
    await assert.rejects(readLine(c, 10), LineTooLong);
    const d = new PassThrough();
    d.write(`${'x'.repeat(20)}\n`);
    await assert.rejects(readLine(d, 10), LineTooLong, 'a newline past the cap is still too long');
  });

  test('a timeout and an abort give up without consuming the stream', async () => {
    const s = new PassThrough();
    await assert.rejects(readLine(s, 10, { timeoutMs: 20 }), LineTimeout);
    const ac = new AbortController();
    const p = readLine(s, 10, { signal: ac.signal });
    ac.abort(new Error('stop'));
    await assert.rejects(p, /stop/);
    s.write('later\n');
    assert.equal(await readLine(s, 10), 'later');
  });

  test('a destroyed stream rejects', async () => {
    const s = new PassThrough();
    const p = readLine(s, 10);
    s.destroy();
    await assert.rejects(p, LineEnded);
  });
});

describe('lines', () => {
  test('encodeLine ends with a newline and refuses a line over the cap', () => {
    assert.equal(encodeLine({ a: 1 }).toString(), '{"a":1}\n');
    assert.throws(() => encodeLine({ a: 'x'.repeat(100) }, 50), LineTooLong);
  });

  test('writeLine writes and resolves', async () => {
    const s = new PassThrough();
    await writeLine(s, { ok: true });
    assert.equal(s.read().toString(), '{"ok":true}\n');
  });

  test('readJsonLines yields parsed objects, skips empty lines, and fails on junk or an oversize line', async () => {
    const ok = new PassThrough();
    ok.end('{"t":"status"}\n\n{"t":"log"}\n');
    const seen: unknown[] = [];
    for await (const m of readJsonLines(ok, 1_000)) seen.push(m);
    assert.deepEqual(seen, [{ t: 'status' }, { t: 'log' }]);

    const junk = new PassThrough();
    junk.end('{"t":\n');
    await assert.rejects(async () => { for await (const _ of readJsonLines(junk, 1_000)); }, LineMalformed);

    const big = new PassThrough();
    big.end(`${'x'.repeat(CONNECT_LIMITS.maxControlLine + 1)}\n`);
    await assert.rejects(async () => { for await (const _ of readJsonLines(big, CONNECT_LIMITS.maxControlLine)); }, LineTooLong);

    const cut = new PassThrough();
    cut.end('{"t":"x"}');
    await assert.rejects(async () => { for await (const _ of readJsonLines(cut, 1_000)); }, LineEnded);
  });

  test('a line split over many chunks still parses', async () => {
    const s = new PassThrough();
    const text = `${JSON.stringify({ t: 'status', pad: 'y'.repeat(5_000) })}\n`;
    for (let at = 0; at < text.length; at += 7) s.write(text.slice(at, at + 7));
    s.end();
    const out: unknown[] = [];
    for await (const m of readJsonLines(s, 100_000)) out.push(m);
    assert.equal(out.length, 1);
  });
});

describe('host records', () => {
  test('encode, and parse across every cut of the bytes', () => {
    const bytes = Buffer.concat([
      encodeRecord(RECORD.data, 'stdin'),
      jsonRecord(RECORD.resize, { cols: 80, rows: 24 }),
      encodeRecord(RECORD.eof),
      ...chunkRecords(RECORD.data, Buffer.alloc(150_000, 5)),
      jsonRecord(RECORD.result, { code: 0 }),
    ]);
    const whole = new RecordParser().push(bytes);
    assert.deepEqual(whole.map((r) => [r.kind, r.payload.length]), [[1, 5], [3, 21], [4, 0], [1, 65_536], [1, 65_536], [1, 18_928], [5, 10]]);
    for (const cut of [1, 3, 5, 6, 64, 1_000, 70_000]) {
      const p = new RecordParser();
      const got: { kind: number; len: number }[] = [];
      for (let at = 0; at < bytes.length; at += cut) for (const r of p.push(bytes.subarray(at, at + cut))) got.push({ kind: r.kind, len: r.payload.length });
      assert.deepEqual(got, whole.map((r) => ({ kind: r.kind, len: r.payload.length })), `cut ${cut}`);
    }
    assert.deepEqual(parseResult(whole.at(-1)!.payload), { code: 0 });
  });

  test('an unknown kind, an oversize record, and a payload over the limit are errors', () => {
    assert.throws(() => new RecordParser().push(Buffer.from([9, 0, 0, 0, 0])), RecordError);
    const big = Buffer.alloc(5);
    big[0] = RECORD.data;
    big.writeUInt32BE(65_537, 1);
    assert.throws(() => new RecordParser().push(big), /over the limit/);
    assert.throws(() => encodeRecord(RECORD.data, Buffer.alloc(65_537)), RecordError);
    assert.throws(() => parseResult(Buffer.from('nope')), RecordError);
  });

  test('readRecords over a stream, and a stream that ends inside a record', async () => {
    const s = new PassThrough();
    s.write(encodeRecord(RECORD.data, 'abc'));
    s.end(encodeRecord(RECORD.eof));
    const kinds: number[] = [];
    for await (const r of readRecords(s)) kinds.push(r.kind);
    assert.deepEqual(kinds, [1, 4]);
    const cut = new PassThrough();
    cut.end(encodeRecord(RECORD.data, 'abc').subarray(0, 6));
    await assert.rejects(async () => { for await (const _ of readRecords(cut)); }, RecordError);
  });

  test('writeRecord waits for drain when the stream is full', async () => {
    const s = new PassThrough({ highWaterMark: 10 });
    let done = false;
    const w = writeRecord(s, RECORD.data, Buffer.alloc(1_000)).then(() => (done = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(done, false, 'not resolved while the stream is full');
    s.resume();
    await w;
    assert.equal(done, true);
  });
});
