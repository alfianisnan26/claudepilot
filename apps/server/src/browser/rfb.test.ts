import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ENCODINGS, RfbClientFilter, RfbClientHandshake, RfbViolation, UpstreamReader, type RfbRole } from './rfb.js';

/** The messages a viewer can send, as bytes. */
const setPixelFormat = () => Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 7)]);
const setEncodings = (list: number[]) => {
  const b = Buffer.alloc(4 + 4 * list.length);
  b[0] = 2;
  b.writeUInt16BE(list.length, 2);
  list.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
};
const updateRequest = (incremental = 1) => Buffer.from([3, incremental, 0, 0, 0, 0, 5, 0, 3, 32]);
const keyEvent = () => Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x41]);
const pointerEvent = () => Buffer.from([5, 1, 0, 10, 0, 20]);
const cutText = (text: string) => Buffer.concat([Buffer.from([6, 0, 0, 0]), (() => { const l = Buffer.alloc(4); l.writeUInt32BE(text.length); return l; })(), Buffer.from(text)]);

function filter(role: RfbRole = 'viewer', priv = false) {
  const state = { role: () => state.r, private: () => state.p, r: role, p: priv };
  return { f: new RfbClientFilter(state), state };
}

test('a viewer’s keys and pointer are dropped; what it may send passes untouched', () => {
  const { f } = filter('viewer');
  const r = f.push(Buffer.concat([setPixelFormat(), setEncodings([0, 7, 16]), updateRequest(), keyEvent(), pointerEvent(), updateRequest(0)]));
  assert.equal(r.forward.length, 4);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.forward[0], setPixelFormat());
  assert.deepEqual(r.forward[1], setEncodings([0, 7, 16]));
  assert.equal(f.stats.keys, 1);
  assert.equal(f.stats.pointers, 1);
});

test('a controller’s keys and pointer go through; ClientCutText never does, for anyone', () => {
  for (const role of ['viewer', 'controller'] as const) {
    const { f } = filter(role);
    const r = f.push(Buffer.concat([keyEvent(), pointerEvent(), cutText('a secret on the clipboard'), updateRequest()]));
    const expected = role === 'controller' ? [keyEvent(), pointerEvent(), updateRequest()] : [updateRequest()];
    assert.deepEqual(r.forward, expected, role);
  }
});

test('messages split at any byte are put back together, and the cut text is skipped exactly', () => {
  const { f } = filter('controller');
  const stream = Buffer.concat([keyEvent(), cutText('x'.repeat(5000)), pointerEvent(), setEncodings([0, 1, 5]), updateRequest()]);
  const out: Buffer[] = [];
  for (let i = 0; i < stream.length; i += 3) out.push(...f.push(stream.subarray(i, i + 3)).forward);
  assert.deepEqual(out, [keyEvent(), pointerEvent(), setEncodings([0, 1, 5]), updateRequest()]);
});

test('SetEncodings: at most 64 entries, and only encodings noVNC draws (nothing that unlocks other messages)', () => {
  const { f } = filter('viewer');
  assert.throws(() => f.push(setEncodings(Array.from({ length: MAX_ENCODINGS + 1 }, (_, i) => i))), RfbViolation);
  const { f: g } = filter('controller');
  // Raw, Tight, QEMU extended key (-258), ExtendedDesktopSize (-308), fence (-312), continuous updates (-313), Tight quality 5, xvp (-309).
  const r = g.push(setEncodings([0, 7, -258, -308, -312, -313, -27, -309, 16]));
  assert.deepEqual(r.forward[0], setEncodings([0, 7, -27, 16]));
  assert.deepEqual(g.lastEncodings, setEncodings([0, 7, -27, 16]));
});

test('anything else closes the socket: QEMU, fence, resize, oversized, unknown types', () => {
  for (const type of [248, 250, 251, 255, 1, 7, 99]) assert.throws(() => filter('controller').f.push(Buffer.from([type, 0, 0, 0, 0, 0, 0, 0])), RfbViolation, `type ${type}`);
  const huge = Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from([0x7f, 0xff, 0xff, 0xff])]);
  assert.throws(() => filter('controller').f.push(huge), RfbViolation);
});

test('Private: other viewers’ update requests are dropped (the display then sends them nothing); the controller’s are not', () => {
  const viewer = filter('viewer', true);
  assert.equal(viewer.f.push(updateRequest()).forward.length, 0);
  assert.equal(viewer.f.push(setPixelFormat()).forward.length, 1, 'other messages still pass');
  viewer.state.p = false;
  assert.equal(viewer.f.push(updateRequest()).forward.length, 1, 'at hand-back requests flow again');
  const controller = filter('controller', true);
  assert.equal(controller.f.push(updateRequest()).forward.length, 1);
});

test('the role is read for every message: a viewer who takes control starts sending input at once, and stops when it ends', () => {
  const { f, state } = filter('viewer');
  assert.equal(f.push(keyEvent()).forward.length, 0);
  state.r = 'controller';
  assert.equal(f.push(keyEvent()).forward.length, 1);
  state.r = 'viewer';
  assert.equal(f.push(pointerEvent()).forward.length, 0);
});

test('the browser-facing handshake: RFB 3.8, security None, ClientInit ignored, ServerInit from the display', () => {
  const sent: Buffer[] = [];
  const serverInit = Buffer.concat([Buffer.alloc(24), Buffer.from('desktop')]);
  serverInit.writeUInt32BE(7, 20);
  const h = new RfbClientHandshake((b) => sent.push(b), () => serverInit);
  h.start();
  assert.equal(sent[0]!.toString(), 'RFB 003.008\n');
  assert.equal(h.push(Buffer.from('RFB 003.008\n')), null);
  assert.deepEqual(sent[1], Buffer.from([1, 1]), 'security types: None only');
  assert.equal(h.push(Buffer.from([1])), null);
  assert.deepEqual(sent[2], Buffer.alloc(4), 'SecurityResult OK');
  // ClientInit (shared = 0) arrives with the first message after it, in one chunk.
  const rest = h.push(Buffer.concat([Buffer.from([0]), keyEvent()]));
  assert.deepEqual(rest, keyEvent());
  assert.deepEqual(sent[3], serverInit);
  assert.equal(h.done, true);
});

test('the handshake refuses what it did not offer', () => {
  const mk = () => {
    const h = new RfbClientHandshake(() => undefined, () => Buffer.alloc(24));
    h.start();
    return h;
  };
  assert.throws(() => mk().push(Buffer.from('RFB 004.000\n')), RfbViolation);
  assert.throws(() => mk().push(Buffer.from('GET / HTTP/1.1\r\n')), RfbViolation);
  const h = mk();
  h.push(Buffer.from('RFB 003.007\n'));
  assert.throws(() => h.push(Buffer.from([2])), RfbViolation, 'VNC authentication was not offered');
});

test('the display’s side: the OK line, ServerInit however it arrives, and the data after it', () => {
  const init = Buffer.concat([Buffer.alloc(24), Buffer.from('cpb@host')]);
  init.writeUInt32BE(8, 20);
  const r = new UpstreamReader();
  const data: Buffer[] = [];
  r.onData = (d) => data.push(d);
  const all = Buffer.concat([Buffer.from('CPB-VNC-OK\n'), init, Buffer.from('FRAME')]);
  for (let i = 0; i < all.length; i += 7) r.push(all.subarray(i, i + 7));
  assert.deepEqual(r.serverInit, init);
  assert.equal(Buffer.concat(data).toString(), 'FRAME');
  r.push(Buffer.from('MORE'));
  assert.equal(Buffer.concat(data).toString(), 'FRAMEMORE');
});

test('the display’s side: an error line is passed on, and noise is refused', () => {
  const a = new UpstreamReader();
  const errors: string[] = [];
  a.onError = (m) => errors.push(m);
  a.push(Buffer.from('CPB-VNC-ERR the display refused the password\n'));
  assert.deepEqual(errors, ['the display refused the password']);
  const b = new UpstreamReader();
  b.onError = (m) => errors.push(m);
  b.push(Buffer.from('HELLO\n'));
  assert.equal(errors.length, 2);
  const c = new UpstreamReader();
  c.onError = (m) => errors.push(m);
  c.push(Buffer.alloc(600, 0x41));
  assert.equal(errors.length, 3);
});
