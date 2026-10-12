// T-MUX: the frame codec against the contract's vectors, and the decoder over every way a byte stream can be cut.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONNECT_TEST_VECTORS } from '@portal/contracts';
import { FRAME_FLAG, FRAME_TYPE, FrameDecoder, ProtocolError, dataFrame, encodeHeader, finFrame, goAwayFrame, pingFrame, rstFrame, windowUpdateFrame } from './frame.js';

const v = CONNECT_TEST_VECTORS.frames;

describe('frame vectors', () => {
  test('the headers are the contract’s bytes', () => {
    assert.equal(encodeHeader({ type: FRAME_TYPE.data, flags: FRAME_FLAG.syn, streamId: 1, length: 5 }).toString('hex'), v.dataSynStream1Len5);
    assert.equal(windowUpdateFrame(3, 0, 262_144).toString('hex'), v.windowUpdateStream3Plus262144);
    assert.equal(pingFrame(false, 0x01020304).toString('hex'), v.pingSynValue01020304);
    assert.equal(finFrame(2).toString('hex'), v.dataFinStream2Len0);
    assert.equal(goAwayFrame(0).toString('hex'), v.goAwayNormal);
    assert.equal(rstFrame(7).toString('hex'), '000100080000000700000000');
  });

  test('a data frame is its header and its payload in one buffer', () => {
    const f = dataFrame(1, FRAME_FLAG.syn, Buffer.from('hello'));
    assert.equal(f.toString('hex'), `${v.dataSynStream1Len5}${Buffer.from('hello').toString('hex')}`);
    assert.equal(dataFrame(1, 0, [Buffer.from('he'), Buffer.from('llo')]).subarray(12).toString(), 'hello');
  });
});

describe('frame decoder', () => {
  const stream = Buffer.concat([
    dataFrame(1, FRAME_FLAG.syn, Buffer.from('one')),
    windowUpdateFrame(1, 0, 4096),
    dataFrame(3, FRAME_FLAG.syn | FRAME_FLAG.fin, Buffer.alloc(0)),
    pingFrame(false, 9),
    dataFrame(1, 0, Buffer.alloc(65_536, 7)),
    goAwayFrame(0),
  ]);
  const summary = (frames: ReturnType<FrameDecoder['push']>) => frames.map((f) => `${f.type}/${f.flags}/${f.streamId}/${f.length}/${f.payload.length}`);
  const whole = summary(new FrameDecoder().push(stream));

  test('decodes a sequence in one chunk', () => {
    assert.deepEqual(whole, ['0/1/1/3/3', '1/0/1/4096/0', '0/5/3/0/0', '2/1/0/9/0', '0/0/1/65536/65536', '3/0/0/0/0']);
  });

  test('gives the same frames however the bytes are cut', () => {
    for (const cut of [1, 2, 5, 11, 12, 13, 14, 100, 1000, 65_537]) {
      const d = new FrameDecoder();
      const got: ReturnType<FrameDecoder['push']> = [];
      for (let at = 0; at < stream.length; at += cut) got.push(...d.push(stream.subarray(at, at + cut)));
      assert.deepEqual(summary(got), whole, `cut every ${cut} bytes`);
      assert.equal(d.buffered, 0);
    }
  });

  test('the payload is kept intact across chunks', () => {
    const d = new FrameDecoder();
    const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const bytes = dataFrame(5, 0, payload);
    const out = [...d.push(bytes.subarray(0, 700)), ...d.push(bytes.subarray(700, 2500)), ...d.push(bytes.subarray(2500))];
    assert.equal(out.length, 1);
    assert.ok(out[0]!.payload.equals(payload));
  });

  test('violations throw a ProtocolError, and the decoder stays dead', () => {
    const wrongVersion = Buffer.from(encodeHeader({ type: 0, flags: 0, streamId: 1, length: 0 }));
    wrongVersion[0] = 2;
    assert.throws(() => new FrameDecoder().push(wrongVersion), ProtocolError);
    assert.throws(() => new FrameDecoder().push(encodeHeader({ type: 4, flags: 0, streamId: 1, length: 0 })), /unknown frame type 4/);
    assert.throws(() => new FrameDecoder().push(encodeHeader({ type: 0, flags: 0, streamId: 1, length: 65_537 })), /65537 bytes/);
    const d = new FrameDecoder();
    assert.throws(() => d.push(encodeHeader({ type: 9, flags: 0, streamId: 1, length: 0 })));
    assert.throws(() => d.push(goAwayFrame(0)), /stopped/);
  });

  test('a window update may carry any delta, a data frame may not exceed the limit', () => {
    assert.equal(new FrameDecoder().push(windowUpdateFrame(1, 0, 0xffff_ffff))[0]!.length, 0xffff_ffff);
    assert.equal(new FrameDecoder(100).push(dataFrame(1, 0, Buffer.alloc(100))).length, 1);
    assert.throws(() => new FrameDecoder(100).push(dataFrame(1, 0, Buffer.alloc(101)).subarray(0, 12)), ProtocolError);
  });
});
